/**
 * Transport manager (design 03 §2.2, desktop main process) unit tests.
 *
 * Pure-Node tests (no electron, no real SSH host): a FAKE ssh process drives
 * the phase machine through stdout/stderr/exit events, and a fake port probe
 * drives readiness. Covers: connecting → ready on transport-up, error +
 * requiresUserAction on auth failure, degraded/reconnect with bounded
 * jittered backoff, disconnect stops the process (SIGTERM → SIGKILL
 * escalation), the instances persistence round-trip (atomic write, kind
 * migration, duplicate-id dedup), the provider exec channel
 * (start/stop/is-active command shapes, serviceName whitelist, timeout,
 * serviceActive projection, auth-failure semantics), line-buffered stderr
 * redaction, per-child guards, the direct-endpoint provider mode, and the
 * endpoint identity verification (a port that merely accepts TCP is never
 * ready; a real dsh host.describe handshake is required — covered against
 * real loopback HTTP servers).
 */

import { test } from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SpawnOptions } from 'node:child_process'
import { attemptCommittedRegistryPush, computeRemovedInstanceIds, computeRetiredInstanceIds, createTransportManager, jitteredBackoffMs, RING_BUFFER_LIMIT } from './transport-manager.ts'
import type { TransportManagerOptions } from './transport-manager.ts'
import { MAX_TRANSPORT_INSTANCES } from './transport-provider.ts'
import type { TransportInstanceInput, TransportInstanceSpec, TransportProvider, TransportStatusProjection, TransportVerifyResult, SpawnedProcess } from './transport-provider.ts'
import { sshProvider, verifyDshEndpoint, probeClientGraphLive, probeGitWorktreeLive, redactSshStderr, SERVER_ALIVE_INTERVAL_SECONDS, SERVER_ALIVE_COUNT_MAX } from './ssh-provider.ts'

const silentLogger = { log() {}, warn() {}, error() {} }

/**
 * The status projection plus an optional transport-url field: the tests
 * assert the projection never carries a transport URL (design 05 §8 security
 * invariant).
 */
type StatusWithNoUrlLeak = TransportStatusProjection & { localUrl?: unknown }

/** A fake child_process handle: emits exit/error, records kill calls. */
class FakeChild extends EventEmitter implements SpawnedProcess {
  stdout: EventEmitter
  stderr: EventEmitter
  stdin: { write(chunk: string | Buffer): unknown; end(): unknown } | null
  killCalls: string[]
  exitCode: number | null
  signalCode: NodeJS.Signals | null

  constructor() {
    super()
    this.stdout = new EventEmitter()
    this.stderr = new EventEmitter()
    this.stdin = { write: () => true, end: () => {} }
    this.killCalls = []
    this.exitCode = null
    this.signalCode = null
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killCalls.push(signal)
    return true
  }

  /** Test helper: simulate the ssh process exiting (null code = signal death). */
  simulateExit(code: number | null = 0, signal: NodeJS.Signals | null = null) {
    this.exitCode = code
    this.signalCode = signal
    this.emit('exit', code, signal)
  }

  /** Test helper: emit a spawn error (e.g. the ssh binary is missing). */
  simulateSpawnError(error: Error) {
    this.emit('error', error)
  }

  /** Test helper: write one stderr line. */
  stderrWrite(text: string) {
    this.stderr.emit('data', Buffer.from(text))
  }
}

function makeManager(t: TestContext, overrides: { options?: TransportManagerOptions; instances?: TransportInstanceInput[]; random?: () => number; provider?: TransportProvider; verifyProbe?: (spec: TransportInstanceSpec, endpoint: { host: string; port: number }) => Promise<TransportVerifyResult>; allocatePort?: () => Promise<number> } = {}) {
  const spawnCalls: Array<{ command: string; args: readonly string[]; options: SpawnOptions; child: FakeChild }> = []
  const children: FakeChild[] = []
  const spawnTimes: number[] = []
  let probeOk = false
  const manager = createTransportManager({
    provider: overrides.provider ?? sshProvider,
    spawnFn: (command, args, options) => {
      const child = new FakeChild()
      spawnCalls.push({ command, args, options, child })
      children.push(child)
      spawnTimes.push(Date.now())
      return child
    },
    instancesFile: join(tempDir(t), 'ssh-instances.json'),
    logger: silentLogger,
    portProbe: async () => probeOk,
    // Fake the provider's own endpoint verification when it has one (the
    // real ssh provider would open a real HTTP connection to the fake
    // tunnel port); providers without verifyUp keep the skip path.
    verifyProbe: overrides.verifyProbe
      ?? ((overrides.provider === undefined || overrides.provider.verifyUp !== undefined)
        ? async () => ({ ok: true })
        : undefined),
    allocatePort: overrides.allocatePort ?? (async () => 43123),
    random: overrides.random,
    options: {
      readyTimeoutMs: 100,
      probeIntervalMs: 5,
      retryBaseMs: 10,
      retryMaxMs: 40,
      maxRetryAttempts: 3,
      disconnectGraceMs: 50,
      ...overrides.options,
    },
  })
  manager.saveInstances([
    { id: 's1', label: 'home-server', host: 'home.example.com', user: 'alice', remotePort: 2222 },
    ...(overrides.instances ?? []),
  ])
  return {
    manager,
    spawnCalls,
    children,
    spawnTimes,
    setProbe: (ok: boolean) => {
      probeOk = ok
    },
  }
}

function tempDir(t?: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ssh-manager-'))
  t?.after?.(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

test('registry delta preserves removals while same-id edits are not tombstones', () => {
  assert.deepEqual(
    computeRemovedInstanceIds(
      [{ id: 'alpha' }, { id: 'same' }, { id: 'removed' }],
      [{ id: 'same' }, { id: 'alpha' }, { id: 'added' }],
    ),
    ['removed'],
  )
  assert.deepEqual(computeRemovedInstanceIds([{ id: 'same' }], [{ id: 'same' }]), [])
  assert.deepEqual(
    computeRemovedInstanceIds([{ id: 'first' }, { id: 'second' }], []),
    ['first', 'second'],
  )
})

test('registry lifecycle retires deletion and transport identity edits, but not presentation/service/home edits', () => {
  const before: TransportInstanceSpec[] = [{
    id: 'same', label: 'old label', kind: 'ssh', host: 'old.example.com', user: 'alice',
    sshPort: 22, remotePort: 3080, serviceName: 'dsh-old', remoteDshHome: '~/.old',
  }]
  const nonIdentityEdit: TransportInstanceSpec[] = [{
    ...before[0], label: 'new label', serviceName: 'dsh-new', remoteDshHome: '~/.new',
  }]
  assert.deepEqual(computeRetiredInstanceIds(before, nonIdentityEdit), [])
  assert.deepEqual(computeRetiredInstanceIds(before, [{ ...before[0], host: 'new.example.com' }]), ['same'])
  assert.deepEqual(computeRetiredInstanceIds(before, [{ ...before[0], user: 'bob' }]), ['same'])
  assert.deepEqual(computeRetiredInstanceIds(before, [{ ...before[0], sshPort: 2222 }]), ['same'])
  assert.deepEqual(computeRetiredInstanceIds(before, [{ ...before[0], remotePort: 4080 }]), ['same'])
  assert.deepEqual(computeRetiredInstanceIds(before, []), ['same'])
})

test('a renderer send throw after registry commit is a loud delivery miss, never a save failure', () => {
  const hostile = new Proxy({}, {
    get() { throw new Error('formatter trap') },
    getPrototypeOf() { throw new Error('instanceof trap') },
  })
  assert.deepEqual(attemptCommittedRegistryPush(() => { throw new Error('window destroyed') }), {
    sent: false,
    error: 'window destroyed',
  })
  assert.deepEqual(attemptCommittedRegistryPush(() => { throw hostile }), {
    sent: false,
    error: 'unknown error',
  })
  let delivered = false
  assert.deepEqual(attemptCommittedRegistryPush(() => { delivered = true }), { sent: true })
  assert.equal(delivered, true)
})

async function waitFor(predicate: () => boolean, timeoutMs = 3000, what = 'condition') {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(5)
  }
  throw new Error(`timed out waiting for ${what}`)
}

test('instances persistence round-trips through the atomic-write file', () => {
  const dir = tempDir()
  const file = join(dir, 'ssh-instances.json')
  const manager = createTransportManager({ provider: sshProvider, instancesFile: file, logger: silentLogger })
  assert.deepEqual(manager.loadInstances(), [])
  const saved = manager.saveInstances([
    { id: 's1', label: 'home', host: 'home.example.com', user: 'alice', remotePort: 2222 },
    { id: 's2', label: 'lab', host: '10.0.0.5', remotePort: 22 },
  ])
  assert.equal(saved.length, 2)
  const onDisk = JSON.parse(readFileSync(file, 'utf8'))
  assert.deepEqual(onDisk, saved)
  const reopened = createTransportManager({ provider: sshProvider, instancesFile: file, logger: silentLogger })
  assert.deepEqual(reopened.loadInstances(), saved)
})

test('renderer lifecycle proofs are never accepted into or persisted with registry data', () => {
  const dir = tempDir()
  const file = join(dir, 'ssh-instances.json')
  const manager = createTransportManager({ provider: sshProvider, instancesFile: file, logger: silentLogger })
  const saved = manager.saveInstances([{
    id: 'proofless',
    label: 'proofless',
    host: 'host.example.com',
    remotePort: 3080,
    sourceFingerprint: 'a'.repeat(64),
  } as TransportInstanceInput & { sourceFingerprint: string }])
  assert.equal('sourceFingerprint' in saved[0], false)
  assert.equal(readFileSync(file, 'utf8').includes('sourceFingerprint'), false)
})

test('saveInstances drops invalid entries loudly and disconnects removed instances', t => {
  const { manager } = makeManager(t)
  manager.connect('s1')
  const saved = manager.saveInstances([{ id: 'other', label: 'x', host: 'h', remotePort: 22 }])
  assert.deepEqual(saved.map(entry => entry.id), ['other'])
  assert.equal(manager.status('s1'), null)
  assert.equal(manager.listInstances().length, 1)
  assert.throws(() => manager.saveInstances('nope' as unknown as TransportInstanceInput[]), /array/)
})

test('unique-id registry churn retires every runtime state instead of retaining an unbounded history', t => {
  const { manager } = makeManager(t)
  const base = manager.listInstances()[0]
  for (let index = 0; index < 128; index += 1) {
    const id = `churn-${index}`
    manager.saveInstances([base, { id, label: id, host: 'churn.example.com', remotePort: 22 }])
    assert.equal(manager.status(id)?.phase, 'idle', 'status materializes this incarnation')
    assert.equal(manager.appendLog(id, 'info', `old-${index}`), true)
    manager.saveInstances([base])
    assert.equal(manager.clearLogs(id), false, `retired state ${id} is no longer retained`)
    assert.equal(manager.appendLog(id, 'info', 'zombie'), false)
  }
})

test('same-id re-add starts with fresh status, service projection, and logs', async t => {
  const { manager, spawnCalls } = makeManager(t, { instances: [EXEC_INSTANCE] })
  const base = manager.listInstances().find(instance => instance.id === 's1')!
  const resultPromise = manager.exec('s2', 'start')
  spawnCalls[0].child.simulateExit(0)
  const result = await resultPromise
  assert.equal(result.ok, true)
  assert.equal(manager.status('s2')?.serviceActive, true)
  assert.ok(manager.logs('s2').length > 0)
  assert.equal(manager.appendLog('s2', 'error', 'old incarnation marker'), true)

  manager.saveInstances([base])
  manager.saveInstances([base, { ...EXEC_INSTANCE, label: 're-added' }])
  assert.deepEqual(manager.status('s2'), {
    kind: 'ssh',
    phase: 'idle',
    localPort: null,
    sshPort: null,
    remotePort: 3080,
    retryAttempt: 0,
    requiresUserAction: false,
    serviceActive: null,
    remoteDshHome: null,
    logSummary: '',
  })
  assert.deepEqual(manager.logs('s2'), [])
})

test('a late exec from a removed incarnation cannot write into a same-id re-add', async t => {
  const { manager, spawnCalls } = makeManager(t, { instances: [EXEC_INSTANCE] })
  const base = manager.listInstances().find(instance => instance.id === 's1')!
  const oldExec = manager.exec('s2', 'start')
  const oldChild = spawnCalls[0].child

  manager.saveInstances([base])
  assert.ok(oldChild.killCalls.includes('SIGTERM'), 'registry retirement terminates its exec child')
  manager.saveInstances([base, { ...EXEC_INSTANCE, label: 'new incarnation' }])
  assert.equal(manager.appendLog('s2', 'info', 'fresh incarnation marker'), false, 'state remains lazy before first projection')
  assert.equal(manager.status('s2')?.serviceActive, null)
  assert.equal(manager.appendLog('s2', 'info', 'fresh incarnation marker'), true)

  oldChild.simulateExit(0)
  assert.deepEqual(await oldExec, { ok: false, error: 'ssh instance changed while exec was in progress' })
  assert.equal(manager.status('s2')?.serviceActive, null, 'old setProjection is generation-fenced')
  assert.deepEqual(
    manager.logs('s2').map(entry => entry.message),
    ['fresh incarnation marker'],
    'old exec logs are generation-fenced',
  )
})

test('a same-id transport edit retires old exec ownership and the next exec uses a fresh spec', async t => {
  const { manager, spawnCalls } = makeManager(t, { instances: [EXEC_INSTANCE] })
  const base = manager.listInstances().find(instance => instance.id === 's1')!
  const oldExec = manager.exec('s2', 'start')
  const oldChild = spawnCalls[0].child

  manager.saveInstances([
    base,
    { ...EXEC_INSTANCE, host: 'replacement.example.com', user: 'carol' },
  ])
  assert.ok(oldChild.killCalls.includes('SIGTERM'), 'same-id ownership edit terminates the old exec child')
  assert.equal(manager.status('s2')?.serviceActive, null, 'edited instance gets a fresh projection state')
  assert.deepEqual(manager.logs('s2'), [], 'edited instance does not inherit the previous incarnation logs')

  await waitFor(() => oldChild.killCalls.includes('SIGKILL'), 3000, 'transport edit escalates an ignoring exec child')
  oldChild.simulateExit(0)
  assert.deepEqual(await oldExec, { ok: false, error: 'ssh instance changed while exec was in progress' })
  assert.equal(manager.status('s2')?.serviceActive, null, 'late old result cannot project onto the edited host')
  assert.deepEqual(manager.logs('s2'), [], 'late old result cannot log onto the edited host')

  const freshExec = manager.exec('s2', 'start')
  assert.equal(spawnCalls.length, 2)
  assert.deepEqual(spawnCalls[1].args, ['carol@replacement.example.com', 'systemctl', 'start', 'dsh-chamber'])
  spawnCalls[1].child.simulateExit(0)
  assert.equal((await freshExec).ok, true)
  assert.equal(manager.status('s2')?.serviceActive, true)
})

test('service/home edit revokes exec ownership without restarting the live tunnel', async t => {
  const { manager, spawnCalls, setProbe } = makeManager(t, { instances: [EXEC_INSTANCE] })
  setProbe(true)
  manager.connect('s2')
  await waitFor(() => manager.status('s2')?.phase === 'ready')
  const tunnelChild = spawnCalls[0].child
  const localPort = manager.status('s2')?.localPort
  const oldExec = manager.exec('s2', 'start')
  const oldExecChild = spawnCalls[1].child
  const base = manager.listInstances().find(instance => instance.id === 's1')!

  manager.saveInstances([
    base,
    { ...EXEC_INSTANCE, serviceName: 'dsh-replacement', remoteDshHome: '~/.dsh-next' },
  ])
  assert.ok(oldExecChild.killCalls.includes('SIGTERM'), 'old operational exec is terminated')
  assert.equal(tunnelChild.killCalls.includes('SIGTERM'), false, 'unchanged endpoint keeps its live tunnel')
  assert.equal(manager.status('s2')?.phase, 'ready')
  assert.equal(manager.status('s2')?.localPort, localPort)
  assert.equal(manager.status('s2')?.serviceActive, null)

  await waitFor(() => oldExecChild.killCalls.includes('SIGKILL'), 3000, 'service/home edit escalates an ignoring exec child')
  oldExecChild.simulateExit(0)
  assert.deepEqual(await oldExec, { ok: false, error: 'ssh instance changed while exec was in progress' })
  assert.equal(manager.status('s2')?.serviceActive, null)

  const freshExec = manager.exec('s2', 'start')
  assert.deepEqual(spawnCalls[2].args, ['bob@lab.example.com', 'systemctl', 'start', 'dsh-replacement'])
  spawnCalls[2].child.simulateExit(0)
  assert.equal((await freshExec).ok, true)
  assert.equal(manager.status('s2')?.serviceActive, true)
})

test('saveInstances refuses an oversized registry before validation or persistence', () => {
  const file = join(tempDir(), 'ssh-instances.json')
  const manager = createTransportManager({ provider: sshProvider, instancesFile: file, logger: silentLogger })
  const entries = Array.from({ length: MAX_TRANSPORT_INSTANCES + 1 }, (_, index) => ({
    id: `host-${index}`,
    label: `host ${index}`,
    host: 'example.com',
    remotePort: 3080,
  }))
  assert.throws(() => manager.saveInstances(entries), /instance limit/)
  assert.equal(manager.listInstances().length, 0)
  assert.equal(existsSync(file), false)
})

test('connecting → ready on tunnel-up, with the documented ssh args and a localUrl only when ready', async t => {
  const { manager, spawnCalls, setProbe } = makeManager(t)
  setProbe(false)
  const connecting = manager.connect('s1')!
  assert.equal(connecting.phase, 'connecting')
  await waitFor(() => spawnCalls.length === 1)
  assert.equal(spawnCalls[0].command, 'ssh')
  assert.deepEqual(spawnCalls[0].args.slice(0, 5), ['-N', '-o', `ServerAliveInterval=${SERVER_ALIVE_INTERVAL_SECONDS}`, '-o', `ServerAliveCountMax=${SERVER_ALIVE_COUNT_MAX}`])
  assert.equal(spawnCalls[0].args[5], '-L')
  const forward = spawnCalls[0].args[6]
  assert.match(forward, /^\d+:127\.0\.0\.1:2222$/)
  const localPort = Number(forward.split(':')[0])
  assert.ok(Number.isInteger(localPort) && localPort >= 1 && localPort <= 65535)
  assert.equal(spawnCalls[0].args[7], 'alice@home.example.com')
  setProbe(true)
  await waitFor(() => manager.status('s1')!.phase === 'ready', 3000, 'ready')
  const status = manager.status('s1')! as StatusWithNoUrlLeak
  assert.equal(status.localPort, localPort)
  assert.equal(status.sshPort, null)
  assert.equal(status.remotePort, 2222)
  assert.equal(status.retryAttempt, 0)
  assert.equal(status.requiresUserAction, false)
  assert.equal(status.localUrl, undefined)
  assert.equal(manager.readyUrl('s1'), `http://127.0.0.1:${localPort}`)
  assert.equal(status.phase, 'ready')
})

test('a configured sshPort rides the tunnel and the systemd exec as `-p <port>`', async t => {
  const { manager, spawnCalls, setProbe } = makeManager(t, {
    instances: [{
      id: 's3', label: 'nonstandard', host: 'box.example.com', user: 'carol',
      sshPort: 2202, remotePort: 3080, serviceName: 'dsh-chamber',
    }],
  })
  setProbe(true)
  manager.connect('s3')
  await waitFor(() => manager.status('s3')!.phase === 'ready')
  assert.equal(spawnCalls.length, 1)
  const forward = spawnCalls[0].args[8]
  assert.deepEqual(spawnCalls[0].args, ['-N', '-o', `ServerAliveInterval=${SERVER_ALIVE_INTERVAL_SECONDS}`, '-o', `ServerAliveCountMax=${SERVER_ALIVE_COUNT_MAX}`, '-p', '2202', '-L', forward, 'carol@box.example.com'])
  assert.match(forward, /^\d+:127\.0\.0\.1:3080$/)
  assert.equal(manager.status('s3')!.sshPort, 2202)
  const resultPromise = manager.exec('s3', 'start')
  assert.equal(spawnCalls.length, 2)
  const execCall = spawnCalls[1]
  assert.deepEqual(execCall.args, ['-p', '2202', 'carol@box.example.com', 'systemctl', 'start', 'dsh-chamber'])
  execCall.child.simulateExit(0)
  const result = await resultPromise
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.status.serviceActive, true)
})

test('invalid sshPort values are dropped from the registry on save', () => {
  const dir = tempDir()
  const file = join(dir, 'ssh-instances.json')
  const manager = createTransportManager({ provider: sshProvider, instancesFile: file, logger: silentLogger })
  const saved = manager.saveInstances([
    { id: 'zero', label: 'x', host: 'h', sshPort: 0, remotePort: 3080 },
    { id: 'huge', label: 'y', host: 'h2', sshPort: 70000, remotePort: 3080 },
    { id: 'float', label: 'z', host: 'h3', sshPort: 22.5, remotePort: 3080 },
    { id: 'ok', label: 'w', host: 'h4', sshPort: 2202, remotePort: 3080 },
  ])
  assert.deepEqual(saved.map(entry => entry.id), ['ok'])
  assert.equal(saved[0].sshPort, 2202)
})

test('option-injection guards: id/host/user must match the whitelists (no leading -)', () => {
  const dir = tempDir()
  const file = join(dir, 'ssh-instances.json')
  const manager = createTransportManager({ provider: sshProvider, instancesFile: file, logger: silentLogger })
  const saved = manager.saveInstances([
    { id: 'bad id', label: 'x', host: 'h', remotePort: 3080 },
    { id: 'slash/id', label: 'x', host: 'h', remotePort: 3080 },
    { id: 'local', label: 'x', host: 'h', remotePort: 3080 },
    { id: 'dash-host', label: 'x', host: '-oProxyCommand=curl evil', remotePort: 3080 },
    { id: 'dash-user', label: 'x', host: 'h', user: '-o', remotePort: 3080 },
    { id: 'spaces', label: 'x', host: 'h two words', remotePort: 3080 },
    { id: 'good', label: 'x', host: '192.168.1.10', user: 'root', remotePort: 3080 },
  ])
  assert.deepEqual(saved.map(entry => entry.id), ['good'])
  assert.equal(saved[0].host, '192.168.1.10')
})

test('hyphenated hostnames and bracketed IPv6 literals are accepted', () => {
  const dir = tempDir()
  const file = join(dir, 'ssh-instances.json')
  const manager = createTransportManager({ provider: sshProvider, instancesFile: file, logger: silentLogger })
  const saved = manager.saveInstances([
    { id: 'hy', label: 'x', host: 'my-server.example.com', remotePort: 3080 },
    { id: 'v6', label: 'y', host: '[::1]', remotePort: 3080 },
    { id: 'v6zone', label: 'z', host: '[fe80::1%eth0]', remotePort: 3080 },
  ])
  assert.deepEqual(saved.map(entry => entry.id), ['hy', 'v6'])
})

test('ssh stderr lines with key/passphrase material are redacted from the ring buffer', async t => {
  const { manager, children, spawnCalls, setProbe } = makeManager(t)
  setProbe(false)
  manager.connect('s1')
  await waitFor(() => spawnCalls.length === 1)
  children[0].stderrWrite("Enter passphrase for key '/Users/x/.ssh/id_ed25519':\n")
  children[0].stderrWrite('Permission denied (publickey).\n')
  children[0].simulateExit(255)
  await waitFor(() => manager.status('s1')!.phase === 'error')
  const lines = manager.logs('s1')
  assert.ok(lines.some(entry => entry.message === '[ssh material redacted]'), 'passphrase line redacted')
  assert.ok(lines.every(entry => !entry.message.includes('.ssh/') && !entry.message.includes('id_ed25519')), 'no key path in logs')
  assert.ok(lines.some(entry => entry.message.includes('Permission denied')), 'non-sensitive stderr kept')
})

test('redactSshStderr covers key-path diagnostics without over-redacting banners', () => {
  const redacted = [
    'Enter passphrase for key \'/Users/x/.ssh/id_ed25519\':',
    'Load key "/etc/ssh/ssh_host_ed25519_key": invalid format',
    'Offering public key: /opt/deploy_keys/rsa',
    'Authentication refused: bad ownership or modes for directory /Users/x/.ssh',
    'debug1: Server host key: /etc/ssh/ssh_host_ed25519_key SHA256:abc',
    'debug1: identity file /Users/x/.ssh/id_ed25519 type 3',
  ]
  for (const line of redacted) assert.equal(redactSshStderr(line), '[ssh material redacted]', line)
  const kept = [
    'OpenSSH_9.8, OpenSSL 3.5.1',
    'debug1: Connecting to example.com [93.184.216.34] port 22.',
    'Warning: Permanently added \'example.com\' (ED25519) to the list of known hosts.',
    'debug1: Server host key: ssh-ed25519 SHA256:abcd',
  ]
  for (const line of kept) assert.notEqual(redactSshStderr(line), '[ssh material redacted]', line)
})

test('disconnect clears the stale localPort from the projection', async t => {
  const { manager, setProbe } = makeManager(t)
  setProbe(true)
  manager.connect('s1')
  await waitFor(() => manager.status('s1')!.phase === 'ready')
  assert.ok(manager.status('s1')!.localPort !== null)
  manager.disconnect('s1')
  assert.equal(manager.status('s1')!.phase, 'idle')
  assert.equal(manager.status('s1')!.localPort, null)
})

test('editing tunnel parameters of a live instance restarts its tunnel', async t => {
  const { manager, spawnCalls, setProbe } = makeManager(t, {
    instances: [{ id: 's4', label: 'editable', host: 'first.example.com', user: 'amy', remotePort: 3080 }],
  })
  setProbe(true)
  manager.connect('s4')
  await waitFor(() => manager.status('s4')!.phase === 'ready')
  assert.equal(spawnCalls.length, 1)
  const saved = manager.saveInstances([
    { id: 's4', label: 'editable', host: 'second.example.com', user: 'amy', remotePort: 3080 },
  ])
  assert.equal(saved[0].host, 'second.example.com')
  await waitFor(() => manager.status('s4')!.phase === 'ready', 3000, 'restarted ready')
  assert.equal(spawnCalls.length, 2, 'a fresh tunnel spawns under the new spec')
  assert.equal(spawnCalls[1].args[spawnCalls[1].args.length - 1], 'amy@second.example.com')
  assert.equal(manager.status('s4')!.phase, 'ready')
})

test('a delayed exit of the replaced tunnel never kills or degrades the fresh one', async t => {
  const { manager, children, spawnCalls, setProbe } = makeManager(t, {
    instances: [{ id: 's5', label: 'switch', host: 'old.example.com', remotePort: 3080 }],
  })
  setProbe(true)
  manager.connect('s5')
  await waitFor(() => manager.status('s5')!.phase === 'ready')
  manager.saveInstances([
    { id: 's5', label: 'switch', host: 'new.example.com', remotePort: 3080 },
  ])
  await waitFor(() => spawnCalls.length === 2, 3000, 'restart spawn')
  await waitFor(() => manager.status('s5')!.phase === 'ready', 3000, 'fresh tunnel ready')
  // The old child gets SIGTERMed by the restart and exits late, after the new
  // tunnel is already up: its exit must be ignored (no extra spawn, no kill
  // of the new child, phase stays ready).
  children[0].simulateExit(143)
  await sleep(80)
  assert.equal(spawnCalls.length, 2, 'no extra spawn from the stale exit')
  assert.equal(manager.status('s5')!.phase, 'ready')
  assert.equal(children[1].killCalls.length, 0, 'the fresh tunnel is never SIGTERMed')
})

test('editing sshPort of a live instance restarts the tunnel with the new -p', async t => {
  const { manager, spawnCalls, setProbe } = makeManager(t, {
    instances: [{ id: 's6', label: 'portswitch', host: 'box.example.com', user: 'carol', remotePort: 3080 }],
  })
  setProbe(true)
  manager.connect('s6')
  await waitFor(() => manager.status('s6')!.phase === 'ready')
  assert.equal(spawnCalls.length, 1)
  assert.ok(!spawnCalls[0].args.includes('-p'), 'first tunnel has no -p')
  manager.saveInstances([
    { id: 's6', label: 'portswitch', host: 'box.example.com', user: 'carol', sshPort: 2202, remotePort: 3080 },
  ])
  await waitFor(() => spawnCalls.length === 2, 3000, 'restart spawn')
  await waitFor(() => manager.status('s6')!.phase === 'ready', 3000, 'restarted ready')
  const restartArgs = spawnCalls[1].args
  assert.ok(restartArgs.includes('-p') && restartArgs.includes('2202'), 'restart carries the new -p')
  assert.equal(manager.status('s6')!.sshPort, 2202)
})

test('loadInstances fails loudly on corrupt files and drops invalid entries', () => {
  const dir = tempDir()
  const corrupt = join(dir, 'corrupt.json')
  writeFileSync(corrupt, '{not json')
  const corruptManager = createTransportManager({ provider: sshProvider, instancesFile: corrupt, logger: silentLogger })
  assert.throws(() => corruptManager.loadInstances(), /corrupt/)
  const mixed = join(dir, 'mixed.json')
  writeFileSync(mixed, JSON.stringify([
    { id: 'ok', label: 'fine', host: 'h.example.com', remotePort: 22 },
    { id: 'bad id', label: 'x', host: 'h', remotePort: 22 },
  ]))
  const mixedManager = createTransportManager({ provider: sshProvider, instancesFile: mixed, logger: silentLogger })
  const loaded = mixedManager.loadInstances()
  assert.deepEqual(loaded.map(entry => entry.id), ['ok'])
})

test('label/serviceName-only edits keep the live tunnel untouched', async t => {
  const { manager, spawnCalls, setProbe } = makeManager(t)
  setProbe(true)
  manager.connect('s1')
  await waitFor(() => manager.status('s1')!.phase === 'ready')
  assert.equal(spawnCalls.length, 1)
  manager.saveInstances([
    { id: 's1', label: 'renamed', host: 'home.example.com', user: 'alice', remotePort: 2222, serviceName: 'dsh' },
  ])
  await sleep(60)
  assert.equal(spawnCalls.length, 1, 'no restart for metadata-only edits')
  assert.equal(manager.status('s1')!.phase, 'ready')
})

test('auth failure → error with requiresUserAction, no auto-retry', async t => {
  const { manager, children, spawnCalls, setProbe } = makeManager(t)
  setProbe(false)
  manager.connect('s1')
  await waitFor(() => spawnCalls.length === 1)
  children[0].stderrWrite('Permission denied (publickey,password).\n')
  children[0].simulateExit(255)
  await waitFor(() => manager.status('s1')!.phase === 'error')
  const status = manager.status('s1')!
  assert.equal(status.requiresUserAction, true)
  await sleep(80)
  assert.equal(spawnCalls.length, 1, 'no auto-retry after a terminal auth failure')
})

test('spawn failure (ssh binary missing) → error with requiresUserAction', async t => {
  const { manager, spawnCalls } = makeManager(t)
  manager.connect('s1')
  await waitFor(() => spawnCalls.length === 1)
  spawnCalls[0].child.simulateSpawnError(new Error('spawn ssh ENOENT'))
  await waitFor(() => manager.status('s1')!.phase === 'error')
  assert.equal(manager.status('s1')!.requiresUserAction, true)
})

test('ready tunnel drop → degraded → reconnects with backoff → ready again', async t => {
  const { manager, children, spawnCalls, setProbe } = makeManager(t)
  setProbe(true)
  manager.connect('s1')
  await waitFor(() => manager.status('s1')!.phase === 'ready')
  setProbe(false)
  children[0].simulateExit(0)
  await waitFor(() => manager.status('s1')!.phase === 'degraded')
  assert.equal(manager.status('s1')!.retryAttempt, 1)
  setProbe(true)
  await waitFor(() => manager.status('s1')!.phase === 'ready', 3000, 'reconnected ready')
  assert.equal(spawnCalls.length, 2)
  assert.equal(manager.status('s1')!.retryAttempt, 0)
  assert.equal(manager.status('s1')!.requiresUserAction, false)
})

test('bounded retry: repeated pre-ready exits exhaust attempts and land on error', async t => {
  const maxRetryAttempts = 3
  const { manager, children, spawnCalls, setProbe } = makeManager(t, { options: { maxRetryAttempts } })
  setProbe(false)
  manager.connect('s1')
  await waitFor(() => spawnCalls.length === 1)
  for (let attempt = 0; attempt <= maxRetryAttempts; attempt += 1) {
    await waitFor(() => spawnCalls.length === attempt + 1, 3000, `spawn ${attempt + 1}`)
    children[attempt].simulateExit(1)
    if (attempt === maxRetryAttempts) {
      await waitFor(() => manager.status('s1')!.phase === 'error', 3000, 'error after the last retry')
    } else {
      await waitFor(() => manager.status('s1')!.phase === 'degraded', 3000, `degraded after attempt ${attempt + 1}`)
    }
  }
  const status = manager.status('s1')!
  assert.equal(status.retryAttempt, maxRetryAttempts)
  assert.equal(status.requiresUserAction, false)
  await sleep(80)
  assert.equal(spawnCalls.length, maxRetryAttempts + 1)
})

test('slow re-probe: burst exhaustion lands on error but keeps retrying and recovers on its own', async t => {
  const maxRetryAttempts = 3
  const { manager, children, spawnCalls, setProbe } = makeManager(t, {
    options: { maxRetryAttempts, slowRetryMs: 40 },
  })
  setProbe(false)
  manager.connect('s1')
  await waitFor(() => spawnCalls.length === 1)
  for (let attempt = 0; attempt <= maxRetryAttempts; attempt += 1) {
    await waitFor(() => spawnCalls.length === attempt + 1, 3000, `spawn ${attempt + 1}`)
    children[attempt].simulateExit(1)
    if (attempt === maxRetryAttempts) {
      await waitFor(() => manager.status('s1')!.phase === 'error', 3000, 'error after the last retry')
    } else {
      await waitFor(() => manager.status('s1')!.phase === 'degraded', 3000, `degraded after attempt ${attempt + 1}`)
    }
  }
  const status = manager.status('s1')!
  assert.equal(status.retryAttempt, maxRetryAttempts)
  assert.equal(status.requiresUserAction, false, 'burst exhaustion is not a user-action failure')
  assert.ok(status.logSummary.includes('retrying periodically'), 'the projection announces the slow re-probe')
  assert.ok(manager.logs('s1').some(entry => entry.message.includes('slow re-probe')), 'the slow re-probe is logged')
  // 静默期：快速突发已耗尽，错误态下不再立即重试（慢速重探尚未到点）。
  await sleep(15)
  assert.equal(spawnCalls.length, maxRetryAttempts + 1, 'no fast retries after error')
  // 慢速重探：底层条件修复后无需用户操作自动恢复。
  setProbe(true)
  await waitFor(() => manager.status('s1')!.phase === 'ready', 3000, 'the slow re-probe reconnects to ready')
  assert.ok(spawnCalls.length >= maxRetryAttempts + 2, 'the slow re-probe started a fresh transport')
  assert.equal(manager.status('s1')!.retryAttempt, 0, 'success resets the retry counter')
})

test('burst exhaustion via the ready-timeout path cleans up the live child and port', async t => {
  // maxRetryAttempts=1: the FIRST ready-timeout schedules the fast reconnect,
  // the SECOND (child still alive) exhausts the burst — the exhaustion branch
  // must stop the live tunnel and clear the stale port, then the slow re-probe
  // must still work from the cleaned state.
  const { manager, children, spawnCalls, setProbe } = makeManager(t, {
    options: { maxRetryAttempts: 1, slowRetryMs: 30 },
  })
  setProbe(false)
  manager.connect('s1')
  await waitFor(() => spawnCalls.length === 1)
  await waitFor(() => manager.status('s1')!.phase === 'degraded', 3000, 'first deadline → degraded')
  await waitFor(() => spawnCalls.length === 2, 3000, 'fast reconnect spawn')
  await waitFor(() => manager.status('s1')!.phase === 'error', 3000, 'error after burst exhaustion')
  assert.ok(children[1].killCalls.includes('SIGTERM'), 'the live child is SIGTERMed at exhaustion')
  assert.equal(manager.status('s1')!.localPort, null, 'no stale localPort in the error projection')
  // The slow re-probe still recovers from the cleaned state.
  setProbe(true)
  await waitFor(() => manager.status('s1')!.phase === 'ready', 3000, 'slow re-probe recovers after cleanup')
})

test('manual disconnect cancels the slow re-probe (no auto-reconnect while idle)', async t => {
  const maxRetryAttempts = 3
  const { manager, children, spawnCalls, setProbe } = makeManager(t, {
    options: { maxRetryAttempts, slowRetryMs: 20 },
  })
  setProbe(false)
  manager.connect('s1')
  await waitFor(() => spawnCalls.length === 1)
  for (let attempt = 0; attempt <= maxRetryAttempts; attempt += 1) {
    await waitFor(() => spawnCalls.length === attempt + 1, 3000, `spawn ${attempt + 1}`)
    children[attempt].simulateExit(1)
    if (attempt === maxRetryAttempts) {
      await waitFor(() => manager.status('s1')!.phase === 'error', 3000, 'error after the last retry')
    } else {
      await waitFor(() => manager.status('s1')!.phase === 'degraded', 3000, `degraded after attempt ${attempt + 1}`)
    }
  }
  manager.disconnect('s1')
  assert.equal(manager.status('s1')!.phase, 'idle')
  setProbe(true) // even if the condition clears, the manual disconnect must win
  await sleep(80) // well past several slowRetryMs
  assert.equal(spawnCalls.length, maxRetryAttempts + 1, 'disconnect cancels the slow re-probe forever')
})

test('a terminal failure never arms the slow re-probe', async t => {
  const { manager, children, spawnCalls, setProbe } = makeManager(t, {
    options: { slowRetryMs: 20 },
  })
  // probe=false keeps the ready loop iterating (re-checking authFailed each
  // turn); with probe=true the machine would race to ready before the auth
  // line lands (ready-loop auth re-checks are in-flight-only).
  setProbe(false)
  manager.connect('s1')
  await waitFor(() => spawnCalls.length === 1)
  children[0].stderrWrite('Permission denied (publickey).\n')
  await waitFor(() => manager.status('s1')!.phase === 'error', 3000, 'terminal auth error')
  assert.equal(manager.status('s1')!.requiresUserAction, true)
  await sleep(60) // well past slowRetryMs — no probe may fire for a terminal failure
  assert.equal(spawnCalls.length, 1, 'no auto-retry after a terminal failure')
})

test('an endpoint that accepts TCP but fails the identity verification is never ready', async t => {
  const { manager, spawnCalls, setProbe } = makeManager(t, {
    verifyProbe: async () => ({ ok: false, detail: 'the destination is not a dsh instance' }),
  })
  setProbe(true)
  manager.connect('s1')
  await waitFor(() => manager.status('s1')!.phase === 'error', 3000, 'error after verification failures')
  assert.equal(manager.readyUrl('s1'), null, 'a non-dsh endpoint never registers a transport')
  assert.equal(manager.status('s1')!.requiresUserAction, false)
  assert.equal(manager.status('s1')!.retryAttempt, 3)
  assert.ok(manager.logs('s1').some(entry => entry.message.includes('the destination is not a dsh instance')), 'the reason lands in the ring buffer')
  assert.ok(manager.status('s1')!.logSummary.includes('max retry attempts exceeded'), 'the projection carries the reason')
  await sleep(80)
  assert.equal(spawnCalls.length, 4, 'bounded: initial attempt + maxRetryAttempts reconnects')
})

test('a DETERMINISTIC verification failure (terminal) lands on error immediately, no reconnect', async t => {
  const { manager, spawnCalls, setProbe } = makeManager(t, {
    verifyProbe: async () => ({
      ok: false,
      detail: 'the destination answered HTTP 404 to the dsh identity probe — it does not appear to be a dsh instance',
      terminal: true,
    }),
  })
  setProbe(true)
  manager.connect('s1')
  await waitFor(() => manager.status('s1')!.phase === 'error', 3000, 'error on the FIRST terminal verification failure')
  assert.equal(manager.readyUrl('s1'), null, 'a deterministic non-dsh endpoint never registers a transport')
  assert.equal(manager.status('s1')!.requiresUserAction, true, 'the user must fix the destination (config/port/version)')
  assert.equal(manager.status('s1')!.retryAttempt, 0, 'no reconnect cycle started')
  await sleep(80)
  assert.equal(spawnCalls.length, 1, 'exactly one attempt: terminal verification failures are never retried')
  assert.ok(manager.logs('s1').some(entry => entry.message.includes('HTTP 404') && entry.message.includes('dsh identity probe')),
    'the concrete non-dsh reason lands in the ring buffer')
  assert.ok(manager.status('s1')!.logSummary.includes('HTTP 404'), 'the projection carries the deterministic reason')
})

test('a throwing identity verification is contained: warn, never ready, bounded retry', async t => {
  const { manager, setProbe } = makeManager(t, {
    verifyProbe: async () => { throw new Error('verify boom') },
  })
  setProbe(true)
  manager.connect('s1')
  await waitFor(() => manager.status('s1')!.phase === 'error', 3000, 'error after contained verification throws')
  assert.equal(manager.readyUrl('s1'), null)
})

test('a real dsh wire handshake through the tunnel destination is required for ready', async t => {
  const dir = tempDir(t)
  // A server that answers /api/host.describe like a real dsh host: the
  // client-request envelope is echoed as a valid server-response.
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/host.describe') {
      let body = ''
      req.on('data', chunk => { body += String(chunk) })
      req.on('end', () => {
        let envelope: { type?: unknown; rpcId?: unknown; method?: unknown } | null = null
        try { envelope = JSON.parse(body) } catch { envelope = null }
        if (envelope?.type === 'client-request' && envelope.method === 'host.describe' && typeof envelope.rpcId === 'string') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value: {} } }))
        } else {
          res.writeHead(400)
          res.end()
        }
      })
    } else {
      res.writeHead(404)
      res.end()
    }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  t.after(() => { server.close() })
  const manager = createTransportManager({
    provider: sshProvider,
    spawnFn: () => new FakeChild(),
    instancesFile: join(dir, 'ssh-instances.json'),
    logger: silentLogger,
    portProbe: async () => true,
    // The tunnel's allocated local port IS the dsh server above, so the
    // runtime's identity probe (real sshProvider.verifyUp) reaches it.
    allocatePort: async () => port,
    options: { readyTimeoutMs: 100, probeIntervalMs: 5, retryBaseMs: 10, retryMaxMs: 40, maxRetryAttempts: 3 },
  })
  manager.saveInstances([{ id: 's1', label: 'home', host: 'h.example.com', remotePort: 2222 }])
  manager.connect('s1')
  await waitFor(() => manager.status('s1')!.phase === 'ready', 3000, 'ready after the dsh handshake')
  assert.equal(manager.readyUrl('s1'), `http://127.0.0.1:${port}`)
  assert.ok(manager.logs('s1').some(entry => entry.message.includes('transport ready')), 'the handshake-gated ready is logged')
  manager.dispose()
})

test('a tunnel destination that is not a dsh instance never becomes ready', async t => {
  const dir = tempDir(t)
  const server = createServer((_req, res) => { res.writeHead(404); res.end() })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  t.after(() => { server.close() })
  const manager = createTransportManager({
    provider: sshProvider,
    spawnFn: () => new FakeChild(),
    instancesFile: join(dir, 'ssh-instances.json'),
    logger: silentLogger,
    portProbe: async () => true,
    allocatePort: async () => port,
    options: { readyTimeoutMs: 100, probeIntervalMs: 5, retryBaseMs: 10, retryMaxMs: 40, maxRetryAttempts: 3 },
  })
  manager.saveInstances([{ id: 's1', label: 'home', host: 'h.example.com', remotePort: 2222 }])
  manager.connect('s1')
  await waitFor(() => manager.status('s1')!.phase === 'error', 3000, 'error after verification failures')
  assert.equal(manager.readyUrl('s1'), null, 'a non-dsh service never presents as connected')
  assert.ok(manager.logs('s1').some(entry => entry.message.includes('HTTP 404') && entry.message.includes('dsh identity probe')),
    'the concrete non-dsh reason lands in the ring buffer')
  manager.dispose()
})

test('verifyDshEndpoint rejects a wrong-shaped 200 answer and times out on a silent endpoint', async t => {
  const wrong = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ hello: 'world' }))
  })
  await new Promise<void>(resolve => wrong.listen(0, '127.0.0.1', resolve))
  const wrongPort = (wrong.address() as AddressInfo).port
  t.after(() => { wrong.close() })
  const mismatched = await verifyDshEndpoint({ host: '127.0.0.1', port: wrongPort })
  assert.equal(mismatched.ok, false, 'a non-dsh 200 body is rejected')
  if (!mismatched.ok) {
    assert.match(mismatched.detail ?? '', /does not appear to be a dsh/)
    assert.equal(mismatched.terminal, true, 'a destination that ANSWERED is deterministic: retrying cannot change the answer')
  }
  const silent = createServer(() => { /* never answer */ })
  await new Promise<void>(resolve => silent.listen(0, '127.0.0.1', resolve))
  const silentPort = (silent.address() as AddressInfo).port
  t.after(() => { silent.close() })
  const timedOut = await verifyDshEndpoint({ host: '127.0.0.1', port: silentPort }, 50)
  assert.equal(timedOut.ok, false, 'a silent (non-HTTP-like) endpoint times out instead of hanging')
  if (!timedOut.ok) {
    assert.match(timedOut.detail ?? '', /did not answer/)
    assert.equal(timedOut.terminal, undefined, 'a silent endpoint is TRANSIENT: the bounded reconnect path applies')
  }
  const bloat = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ padding: 'x'.repeat(64 * 1024) }))
  })
  await new Promise<void>(resolve => bloat.listen(0, '127.0.0.1', resolve))
  const bloatPort = (bloat.address() as AddressInfo).port
  t.after(() => { bloat.close() })
  const oversized = await verifyDshEndpoint({ host: '127.0.0.1', port: bloatPort }, 5000, 1024)
  assert.equal(oversized.ok, false, 'an oversized answer is rejected instead of buffered unbounded')
  if (!oversized.ok) {
    assert.match(oversized.detail ?? '', /oversized/)
    assert.equal(oversized.terminal, true, 'an oversized answer is deterministic non-dsh evidence')
  }
})

test('verifyDshEndpoint flags an old-dsh destination (apiProxy SSE signature) for upgrade', async t => {
  // host.describe → 404 (an older dsh that does not register the method),
  // but GET /api/events.mux answers 200 text/event-stream — the apiProxy
  // SSE arm: positive dsh evidence, so the detail tells the user to
  // upgrade instead of claiming "not dsh". The SSE stream stays OPEN
  // (real old-dsh SSE arms never end): the probe must still release its
  // connection after reading the response head.
  const oldDsh = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/events.mux') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(': ping\n\n')
    } else {
      res.writeHead(404)
      res.end()
    }
  })
  await new Promise<void>(resolve => oldDsh.listen(0, '127.0.0.1', resolve))
  const oldDshPort = (oldDsh.address() as AddressInfo).port
  const stale = await verifyDshEndpoint({ host: '127.0.0.1', port: oldDshPort })
  assert.equal(stale.ok, false)
  if (!stale.ok) {
    assert.match(stale.detail ?? '', /upgrade the remote dsh/, 'old-dsh destinations get the upgrade hint')
    assert.equal(stale.terminal, true, 'an incompatible dsh version is deterministic: retrying cannot change it')
  }
  // The probe must have closed its SSE connection: server.close() then
  // completes instead of waiting on a leaked open stream.
  await new Promise<void>((resolve, reject) => {
    const guard = setTimeout(() => reject(new Error('probe connection leaked (server close hung)')), 500)
    oldDsh.close(() => { clearTimeout(guard); resolve() })
  })
})

test('verifyDshEndpoint flags a connection-plugin dsh (426 signature) for upgrade', async t => {
  // The connection plugin's documented 426 arm: positive dsh evidence even
  // though the host.describe handshake fails.
  const pluginDsh = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/events.mux') {
      res.writeHead(426, { connection: 'Upgrade', upgrade: 'websocket' })
      res.end()
    } else {
      res.writeHead(404)
      res.end()
    }
  })
  await new Promise<void>(resolve => pluginDsh.listen(0, '127.0.0.1', resolve))
  const pluginDshPort = (pluginDsh.address() as AddressInfo).port
  t.after(() => { pluginDsh.close() })
  const stale = await verifyDshEndpoint({ host: '127.0.0.1', port: pluginDshPort })
  assert.equal(stale.ok, false)
  if (!stale.ok) {
    assert.match(stale.detail ?? '', /upgrade the remote dsh/)
    assert.equal(stale.terminal, true, 'an incompatible dsh version is deterministic: retrying cannot change it')
  }
})

test('verifyDshEndpoint keeps the generic message when no dsh signature exists', async t => {
  // 404 on host.describe AND 404 on events.mux: indistinguishable from a
  // plain web server — honesty over guessing, the version claim must not
  // be made without positive dsh evidence.
  const plain = createServer((_req, res) => { res.writeHead(404); res.end() })
  await new Promise<void>(resolve => plain.listen(0, '127.0.0.1', resolve))
  const plainPort = (plain.address() as AddressInfo).port
  t.after(() => { plain.close() })
  const result = await verifyDshEndpoint({ host: '127.0.0.1', port: plainPort })
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.match(result.detail ?? '', /does not appear to be a dsh/)
    assert.ok(!(result.detail ?? '').includes('upgrade the remote dsh'), 'no positive dsh evidence → no version claim')
    assert.equal(result.terminal, true, 'an HTTP answer that is not a dsh handshake is deterministic: retrying cannot change it')
  }
})

test('probeClientGraphLive classifies the running instance: live / not-live / unknown', async t => {
  // ok:true server-response → the remote resolved clientGraph/graph: live.
  const live = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      const envelope = JSON.parse(body) as { rpcId?: unknown }
      res.end(JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value: { rev: 'x', entries: [] } } }))
    })
  })
  await new Promise<void>(resolve => live.listen(0, '127.0.0.1', resolve))
  const livePort = (live.address() as AddressInfo).port
  t.after(() => { live.close() })
  assert.equal(await probeClientGraphLive({ host: '127.0.0.1', port: livePort }), 'live')

  // ok:false server-response (the gateway answered but the method is not
  // resolvable — the running instance booted before the injection) →
  // not-live: injected but restart pending, never a guessed claim.
  const stale = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      const envelope = JSON.parse(body) as { rpcId?: unknown }
      res.end(JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: false, error: { code: 'method_not_found' } } }))
    })
  })
  await new Promise<void>(resolve => stale.listen(0, '127.0.0.1', resolve))
  const stalePort = (stale.address() as AddressInfo).port
  t.after(() => { stale.close() })
  assert.equal(await probeClientGraphLive({ host: '127.0.0.1', port: stalePort }), 'not-live')

  // A plain 404 is the dsh gateway's deterministic "no Remote namespace
  // claimed" answer (vendored gateway test) — on a ready instance that is
  // injected-but-not-loaded (restart pending), never an unclassifiable state.
  const missing = createServer((_req, res) => { res.writeHead(404); res.end() })
  await new Promise<void>(resolve => missing.listen(0, '127.0.0.1', resolve))
  const missingPort = (missing.address() as AddressInfo).port
  t.after(() => { missing.close() })
  assert.equal(await probeClientGraphLive({ host: '127.0.0.1', port: missingPort }), 'not-live')

  const wrong = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ hello: 'world' }))
  })
  await new Promise<void>(resolve => wrong.listen(0, '127.0.0.1', resolve))
  const wrongPort = (wrong.address() as AddressInfo).port
  t.after(() => { wrong.close() })
  assert.equal(await probeClientGraphLive({ host: '127.0.0.1', port: wrongPort }), 'unknown')

  const silent = createServer(() => { /* never answer */ })
  await new Promise<void>(resolve => silent.listen(0, '127.0.0.1', resolve))
  const silentPort = (silent.address() as AddressInfo).port
  t.after(() => { silent.close() })
  assert.equal(await probeClientGraphLive({ host: '127.0.0.1', port: silentPort }, 50), 'unknown', 'a silent endpoint times out instead of hanging')
})

test('probeGitWorktreeLive classifies the running instance: live / not-live / unknown', async t => {
  // A 200 server-response envelope with result.ok:true → the gateway
  // RESOLVED gitWorktree/previewCreate: the boot row is loaded. The empty
  // probe input fails the domain validation INSIDE result.ok:true (no git
  // work performed) — the envelope alone proves the row loaded.
  const live = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      const envelope = JSON.parse(body) as { rpcId?: unknown }
      res.end(JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value: { ok: false, error: { code: 'invalid-input' } } } }))
    })
  })
  await new Promise<void>(resolve => live.listen(0, '127.0.0.1', resolve))
  const livePort = (live.address() as AddressInfo).port
  t.after(() => { live.close() })
  assert.equal(await probeGitWorktreeLive({ host: '127.0.0.1', port: livePort }), 'live')

  // 404 = the gateway does not claim the gitWorktree namespace: the running
  // instance never loaded the git-worktree boot row (injected, restart
  // pending) — the exact case a host-graph-live probe misses.
  const notLoaded = createServer((_req, res) => { res.writeHead(404); res.end() })
  await new Promise<void>(resolve => notLoaded.listen(0, '127.0.0.1', resolve))
  const notLoadedPort = (notLoaded.address() as AddressInfo).port
  t.after(() => { notLoaded.close() })
  assert.equal(await probeGitWorktreeLive({ host: '127.0.0.1', port: notLoadedPort }), 'not-live')

  // A 200 error envelope (gateway answered but could not resolve) → not-live.
  const stale = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      const envelope = JSON.parse(body) as { rpcId?: unknown }
      res.end(JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: false, error: { code: 'internal' } } }))
    })
  })
  await new Promise<void>(resolve => stale.listen(0, '127.0.0.1', resolve))
  const stalePort = (stale.address() as AddressInfo).port
  t.after(() => { stale.close() })
  assert.equal(await probeGitWorktreeLive({ host: '127.0.0.1', port: stalePort }), 'not-live')

  // Non-404 non-200 / malformed body / silence → unknown (never a claim).
  const wrong = createServer((_req, res) => {
    res.writeHead(500)
    res.end()
  })
  await new Promise<void>(resolve => wrong.listen(0, '127.0.0.1', resolve))
  const wrongPort = (wrong.address() as AddressInfo).port
  t.after(() => { wrong.close() })
  assert.equal(await probeGitWorktreeLive({ host: '127.0.0.1', port: wrongPort }), 'unknown')

  const silent = createServer(() => { /* never answer */ })
  await new Promise<void>(resolve => silent.listen(0, '127.0.0.1', resolve))
  const silentPort = (silent.address() as AddressInfo).port
  t.after(() => { silent.close() })
  assert.equal(await probeGitWorktreeLive({ host: '127.0.0.1', port: silentPort }, 50), 'unknown', 'a silent endpoint times out instead of hanging')
})

test('jitteredBackoffMs keeps the half-open jitter bounds [0.5x, 1x)', () => {
  assert.equal(jitteredBackoffMs(100, () => 0), 50)
  assert.equal(jitteredBackoffMs(100, () => 1), 100)
  assert.equal(jitteredBackoffMs(100, () => 0.5), 75)
  for (let index = 0; index < 50; index += 1) {
    const value = jitteredBackoffMs(10_000, () => Math.random())
    assert.ok(value >= 5_000 && value <= 10_000, `jittered backoff ${value} inside [5000, 10000]`)
  }
})

test('reconnect backoff is the jittered delay (deterministic RNG), logged and applied', async t => {
  const maxRetryAttempts = 3
  const { manager, children, spawnCalls, setProbe } = makeManager(t, {
    options: { maxRetryAttempts },
    random: () => 0.5,
  })
  setProbe(false)
  manager.connect('s1')
  await waitFor(() => spawnCalls.length === 1)
  for (let attempt = 0; attempt < maxRetryAttempts; attempt += 1) {
    children[attempt].simulateExit(1)
    await waitFor(() => spawnCalls.length === attempt + 2, 3000, `retry spawn ${attempt + 2}`)
  }
  const expectedDelays = [7, 15, 30] // floor(10*2^n * 0.75), capped at 40
  for (let attempt = 1; attempt <= maxRetryAttempts; attempt += 1) {
    const line = `reconnect in ${expectedDelays[attempt - 1]}ms (attempt ${attempt}/${maxRetryAttempts})`
    assert.ok(manager.logs('s1').some(entry => entry.message.includes(line)), `log carries ${line}`)
  }
  children[maxRetryAttempts].simulateExit(1)
  await waitFor(() => manager.status('s1')!.phase === 'error', 3000, 'error after the last retry')
})

test('reconnect backoff lower bound (random → 0) is applied and logged', async t => {
  const maxRetryAttempts = 3
  const { manager, children, spawnCalls, setProbe } = makeManager(t, {
    options: { maxRetryAttempts },
    random: () => 0,
  })
  setProbe(false)
  manager.connect('s1')
  await waitFor(() => spawnCalls.length === 1)
  for (let attempt = 0; attempt < maxRetryAttempts; attempt += 1) {
    children[attempt].simulateExit(1)
    await waitFor(() => spawnCalls.length === attempt + 2, 3000, `retry spawn ${attempt + 2}`)
  }
  // floor(min(10*2^n, 40) * 0.5) = 5 / 10 / 20 — the half-open lower edge.
  for (const expected of [5, 10, 20]) {
    assert.ok(manager.logs('s1').some(entry => entry.message.includes(`reconnect in ${expected}ms`)), `log carries reconnect in ${expected}ms`)
  }
})

test('the jittered delay is applied to the reconnect timer, not only logged', async t => {
  const { manager, children, spawnCalls, spawnTimes, setProbe } = makeManager(t, {
    options: { retryBaseMs: 1000, retryMaxMs: 4000 },
    random: () => 0.5,
  })
  setProbe(true)
  manager.connect('s1')
  await waitFor(() => manager.status('s1')!.phase === 'ready')
  setProbe(false)
  const exitAt = Date.now()
  children[0].simulateExit(0)
  await waitFor(() => spawnCalls.length === 2, 3000, 'jittered reconnect spawn')
  const gap = spawnTimes[1] - exitAt
  // jittered 750ms vs raw 1000ms: the gap must be the jittered value (timers
  // never fire early; the < 990ms cap rejects a raw-backoff wiring).
  assert.ok(gap >= 700, `reconnect fires no earlier than the jittered delay: ${gap}ms`)
  assert.ok(gap < 990, `reconnect fires before the raw backoff: ${gap}ms`)
})

test("a replaced tunnel's late stderr can never poison the fresh attempt", async t => {
  const { manager, children, spawnCalls, setProbe } = makeManager(t)
  setProbe(true)
  manager.connect('s1')
  await waitFor(() => manager.status('s1')!.phase === 'ready')
  setProbe(false)
  children[0].simulateExit(0)
  await waitFor(() => spawnCalls.length === 2, 3000, 'retry spawn')
  children[0].stderrWrite('Permission denied (publickey).\n')
  await sleep(80)
  assert.notEqual(manager.status('s1')!.phase, 'error', 'stale stderr never failTerminals the fresh attempt')
  setProbe(true)
  await waitFor(() => manager.status('s1')!.phase === 'ready', 3000, 'fresh tunnel ready')
})

test('an auth failure landing while the final probe is in flight stays terminal', async t => {
  const dir = tempDir(t)
  const spawnCalls: Array<{ command: string; args: readonly string[]; options: SpawnOptions; child: FakeChild }> = []
  // Stub initializer: the probe's resolve is always installed by portProbe
  // before connect() runs; a non-union declared type keeps the later
  // resolveProbe(false) call always callable.
  let resolveProbe: ((ok: boolean) => void) = () => { throw new Error('probe not installed') }
  const manager = createTransportManager({
    provider: sshProvider,
    spawnFn: (command, args, options) => {
      const child = new FakeChild()
      spawnCalls.push({ command, args, options, child })
      return child
    },
    instancesFile: join(dir, 'ssh-instances.json'),
    logger: silentLogger,
    allocatePort: async () => 43123,
    // A probe that stays in flight past the ready deadline: the auth line
    // lands while the loop awaits, and the deadline branch must re-check
    // authFailed instead of falling through to a reconnect.
    portProbe: () => new Promise<boolean>(resolve => { resolveProbe = resolve }),
    options: { readyTimeoutMs: 100, probeIntervalMs: 5, retryBaseMs: 10, retryMaxMs: 40, maxRetryAttempts: 3 },
  })
  manager.saveInstances([{ id: 's1', label: 'home', host: 'h.example.com', remotePort: 2222 }])
  manager.connect('s1')
  await waitFor(() => spawnCalls.length === 1)
  spawnCalls[0].child.stderrWrite('Permission denied (publickey).\n')
  await sleep(150)
  resolveProbe(false)
  await waitFor(() => manager.status('s1')!.phase === 'error', 3000, 'terminal error')
  assert.equal(manager.status('s1')!.requiresUserAction, true)
  assert.equal(spawnCalls.length, 1, 'no reconnect after a terminal auth failure')
})

test('stderr redaction reassembles lines split across chunks (no bypass)', async t => {
  const { manager, children, spawnCalls, setProbe } = makeManager(t)
  setProbe(false)
  manager.connect('s1')
  await waitFor(() => spawnCalls.length === 1)
  children[0].stderrWrite('debug1: identity file /Users/x/.s')
  children[0].stderrWrite('sh/id_ed25519 type 3\n')
  await sleep(30)
  const lines = manager.logs('s1')
  assert.ok(lines.some(entry => entry.message === '[ssh material redacted]'), 'straddling key path is redacted as one complete line')
  assert.ok(lines.every(entry => !entry.message.includes('/.ssh') || entry.message === '[ssh material redacted]'), 'no raw key-path fragment in logs')
})

test('disconnect stops the process (SIGTERM) and lands on idle', async t => {
  const { manager, children, spawnCalls, setProbe } = makeManager(t)
  setProbe(true)
  manager.connect('s1')
  await waitFor(() => manager.status('s1')!.phase === 'ready')
  manager.disconnect('s1')
  assert.equal(manager.status('s1')!.phase, 'idle')
  assert.ok(children[0].killCalls.includes('SIGTERM'))
  children[0].simulateExit(143)
  assert.equal(manager.status('s1')!.phase, 'idle')
  assert.equal(manager.readyUrl('s1'), null)
})

test('ring buffer truncates to the configured limit', async t => {
  const { manager, children, spawnCalls, setProbe } = makeManager(t, { options: { ringBufferLimit: 5 } })
  setProbe(false)
  manager.connect('s1')
  await waitFor(() => spawnCalls.length === 1)
  for (let index = 0; index < 10; index += 1) {
    children[0].stderrWrite(`line ${index}\n`)
  }
  const lines = manager.logs('s1')
  assert.equal(lines.length, 5)
  assert.equal(lines[0].message, 'line 5')
  assert.equal(lines[lines.length - 1].message, 'line 9')
  manager.clearLogs('s1')
  assert.equal(manager.logs('s1').length, 0)
})

test('status/logs for unknown instances are null/empty; default ring limit is 200', t => {
  const { manager } = makeManager(t)
  assert.equal(manager.status('nope'), null)
  assert.deepEqual(manager.logs('nope'), [])
  assert.equal(RING_BUFFER_LIMIT, 200)
})

test('appendLog: external callers (plugin-sync seed outcomes) land in the ring buffer', async t => {
  const { manager, setProbe } = makeManager(t)
  setProbe(true)
  manager.connect('s1')
  await waitFor(() => manager.status('s1')!.phase === 'ready')

  assert.equal(manager.appendLog('s1', 'info', 'chamber host-graph 注入完成'), true)
  assert.equal(manager.appendLog('s1', 'error', 'chamber host-graph 注入失败：boom'), true)
  assert.equal(manager.appendLog('nope', 'info', 'unknown id'), false)
  const lines = manager.logs('s1')
  assert.ok(lines.some(entry => entry.level === 'info' && entry.message.includes('注入完成')))
  assert.ok(lines.some(entry => entry.level === 'error' && entry.message.includes('注入失败：boom')))
})

test('onStatusChanged pushes non-secret projections and unsubscribe works', async t => {
  const { manager, setProbe } = makeManager(t)
  const seen: Array<{ id: string } & StatusWithNoUrlLeak> = []
  const unsubscribe = manager.onStatusChanged((id, status) => seen.push({ id, ...status }))
  setProbe(true)
  manager.connect('s1')
  await waitFor(() => manager.status('s1')!.phase === 'ready')
  assert.ok(seen.some(entry => entry.id === 's1' && entry.phase === 'ready'))
  for (const entry of seen) {
    assert.equal(entry.localUrl, undefined)
    assert.equal(typeof entry.logSummary, 'string')
  }
  unsubscribe()
  const before = seen.length
  manager.disconnect('s1')
  assert.equal(seen.length, before)
})

/** A second instance with a managed systemd service, for the exec tests. */
const EXEC_INSTANCE: TransportInstanceInput = {
  id: 's2',
  label: 'lab-server',
  host: 'lab.example.com',
  user: 'bob',
  remotePort: 3080,
  serviceName: 'dsh-chamber',
}

test('startService spawns `ssh user@host systemctl start <service>` and lands serviceActive', async t => {
  const { manager, spawnCalls } = makeManager(t, { instances: [EXEC_INSTANCE] })
  const resultPromise = manager.exec('s2', 'start')
  assert.equal(spawnCalls.length, 1)
  const call = spawnCalls[0]
  assert.equal(call.command, 'ssh')
  assert.deepEqual(call.args, ['bob@lab.example.com', 'systemctl', 'start', 'dsh-chamber'])
  call.child.simulateExit(0)
  const result = await resultPromise
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.status.remotePort, 3080)
    assert.equal(result.status.serviceActive, true)
  }
})

test('stopService spawns `ssh user@host systemctl stop <service>`; non-zero exit is loud', async t => {
  const { manager, spawnCalls } = makeManager(t, { instances: [EXEC_INSTANCE] })
  const resultPromise = manager.exec('s2', 'stop')
  assert.equal(spawnCalls.length, 1)
  const call = spawnCalls[0]
  assert.deepEqual(call.args, ['bob@lab.example.com', 'systemctl', 'stop', 'dsh-chamber'])
  call.child.simulateExit(0)
  const okResult = await resultPromise
  assert.equal(okResult.ok, true)
  if (okResult.ok) assert.equal(okResult.status.serviceActive, false)
  const failurePromise = manager.exec('s2', 'stop')
  spawnCalls[1].child.simulateExit(1)
  const failure = await failurePromise
  assert.equal(failure.ok, false)
  if (!failure.ok) assert.match(failure.error, /failed/)
})

test('isActive maps exit 0 → serviceActive true, non-zero → serviceActive false', async t => {
  const { manager, spawnCalls } = makeManager(t, { instances: [EXEC_INSTANCE] })
  const activePromise = manager.exec('s2', 'is-active')
  assert.equal(spawnCalls.length, 1)
  assert.deepEqual(spawnCalls[0].args, ['bob@lab.example.com', 'systemctl', 'is-active', 'dsh-chamber'])
  spawnCalls[0].child.simulateExit(0)
  const active = await activePromise
  assert.equal(active.ok, true)
  if (active.ok) assert.equal(active.status.serviceActive, true)
  const inactivePromise = manager.exec('s2', 'is-active')
  spawnCalls[1].child.simulateExit(3)
  const inactive = await inactivePromise
  assert.equal(inactive.ok, true, 'non-zero is-active is a valid answer, not a failure')
  if (inactive.ok) assert.equal(inactive.status.serviceActive, false)
})

test('is-active distinguishes unit-not-found and ssh-exec failures from inactive', async t => {
  const { manager, spawnCalls } = makeManager(t, { instances: [EXEC_INSTANCE] })
  // exit 4 = no such unit: an explicit error, and serviceActive falls back
  // to null so a stale "active" never lingers beside the error.
  const notFoundPromise = manager.exec('s2', 'is-active')
  assert.equal(spawnCalls.length, 1)
  spawnCalls[0].child.simulateExit(4)
  const notFound = await notFoundPromise
  assert.equal(notFound.ok, false)
  if (!notFound.ok) assert.match(notFound.error, /not found/)
  assert.equal(manager.status('s2')!.serviceActive, null, 'a missing unit resets serviceActive to unknown')
  // exit 255 = the ssh exec could not reach the host: an explicit error,
  // never a mislabeled "inactive".
  const unreachablePromise = manager.exec('s2', 'is-active')
  assert.equal(spawnCalls.length, 2)
  spawnCalls[1].child.simulateExit(255)
  const unreachable = await unreachablePromise
  assert.equal(unreachable.ok, false)
  if (!unreachable.ok) assert.match(unreachable.error, /could not reach/)
  assert.equal(manager.status('s2')!.serviceActive, null, 'a failed exec never writes serviceActive')
  // signal death (exit null): the same honest failure, not "inactive".
  const killedPromise = manager.exec('s2', 'is-active')
  assert.equal(spawnCalls.length, 3)
  spawnCalls[2].child.simulateExit(null)
  const killed = await killedPromise
  assert.equal(killed.ok, false)
  if (!killed.ok) assert.match(killed.error, /could not reach/)
})

test('registry refuses an invalid serviceName before it can reach exec', async t => {
  const { manager, spawnCalls } = makeManager(t, {
    instances: [{ ...EXEC_INSTANCE, serviceName: 'bad;rm -rf /' }],
  })
  const result = await manager.exec('s2', 'start')
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /instance not found/)
  assert.equal(spawnCalls.length, 0, 'no ssh process may spawn for an unwhitelisted service name')
})

test('exec without a configured serviceName returns an error without spawning', async t => {
  const { manager, spawnCalls } = makeManager(t)
  const result = await manager.exec('s1', 'start')
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /no systemd service/)
  assert.equal(spawnCalls.length, 0)
})

test('exec times out (SIGTERM) and resolves as an error, logged to the ring buffer', async t => {
  const { manager, spawnCalls } = makeManager(t, {
    options: { execTimeoutMs: 20, disconnectGraceMs: 10 },
    instances: [EXEC_INSTANCE],
  })
  const resultPromise = manager.exec('s2', 'start')
  assert.equal(spawnCalls.length, 1)
  const result = await resultPromise
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /timed out/)
  assert.ok(spawnCalls[0].child.killCalls.includes('SIGTERM'))
  assert.ok(manager.logs('s2').some(entry => entry.level === 'error' && /timed out/.test(entry.message)))
})

test('exec auth failure returns an error but never touches the tunnel terminal state', async t => {
  const { manager, spawnCalls } = makeManager(t, { instances: [EXEC_INSTANCE] })
  const resultPromise = manager.exec('s2', 'start')
  assert.equal(spawnCalls.length, 1)
  spawnCalls[0].child.stderrWrite('Permission denied (publickey).\n')
  spawnCalls[0].child.simulateExit(255)
  const result = await resultPromise
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /authentication/)
  // The exec's auth failure surfaces through the result only: the tunnel's
  // own terminal classification must stay untouched, so a later routine
  // tunnel drop is never mislabeled requiresUserAction.
  assert.equal(manager.status('s2')!.requiresUserAction, false)
  assert.equal(manager.status('s2')!.phase, 'idle')
})

test('exec for an unknown instance is an explicit error; exec never touches the tunnel child', async t => {
  const { manager, spawnCalls, children, setProbe } = makeManager(t, { instances: [EXEC_INSTANCE] })
  setProbe(true)
  manager.connect('s1')
  await waitFor(() => manager.status('s1')!.phase === 'ready')
  assert.equal(spawnCalls.length, 1)
  const unknown = await manager.exec('nope', 'start')
  assert.equal(unknown.ok, false)
  if (!unknown.ok) assert.match(unknown.error, /not found/)
  assert.equal(spawnCalls.length, 1, 'the exec channel spawns its own process and leaves the tunnel alone')
  assert.equal(children[0].killCalls.length, 0)
})

test('exec run: the run payload passes through to the provider and captures stdout', async t => {
  const { manager, spawnCalls } = makeManager(t, { instances: [EXEC_INSTANCE] })
  const resultPromise = manager.exec('s2', 'run', {
    op: 'exec',
    command: 'dsh',
    argv: ['plugin', '--profile', 'web', 'add', 'pkg@^1.0.0'],
  })
  assert.equal(spawnCalls.length, 1)
  assert.equal(spawnCalls[0].command, 'ssh')
  assert.deepEqual(spawnCalls[0].args, ['bob@lab.example.com', 'dsh', 'plugin', '--profile', 'web', 'add', 'pkg@^1.0.0'])
  spawnCalls[0].child.stdout.emit('data', Buffer.from('packed'))
  spawnCalls[0].child.simulateExit(0)
  const result = await resultPromise
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.stdout, 'packed', 'the captured remote stdout rides the result')
    assert.ok(result.stdoutBytes !== undefined && result.stdoutBytes.equals(Buffer.from('packed')), 'raw stdout bytes ride the result')
  }
})

test('exec run: a whitelist-refused payload never spawns a process', async t => {
  const { manager, spawnCalls } = makeManager(t, { instances: [EXEC_INSTANCE] })
  const result = await manager.exec('s2', 'run', {
    op: 'exec',
    command: 'dsh',
    argv: ['plugin', '--profile', 'web', 'add', 'name; rm -rf /'],
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /whitelist/)
  assert.equal(spawnCalls.length, 0, 'no ssh process may spawn for a refused run payload')
})

test('exec run: the write-file payload drives the provider flow (stdin write + byte-domain read-back)', async t => {
  const { manager, spawnCalls } = makeManager(t, { instances: [EXEC_INSTANCE] })
  const resultPromise = manager.exec('s2', 'run', {
    op: 'write-file',
    path: '~/.dsh-chamber/plugins/pkg-a1b2.tgz',
    contentBase64: Buffer.from('hello').toString('base64'),
    sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
  })
  assert.equal(spawnCalls.length, 1)
  assert.deepEqual(spawnCalls[0].args, ['bob@lab.example.com', 'mkdir -p ~/.dsh-chamber/plugins && base64 -d > ~/.dsh-chamber/plugins/pkg-a1b2.tgz'])
  spawnCalls[0].child.simulateExit(0)
  await waitFor(() => spawnCalls.length === 2)
  assert.deepEqual(spawnCalls[1].args, ['bob@lab.example.com', 'LC_ALL=C', 'cat', '~/.dsh-chamber/plugins/pkg-a1b2.tgz'])
  // The read-back carries the exact original bytes — the provider hashes the
  // RAW captured bytes, so a binary-safe verification is exercised here.
  spawnCalls[1].child.stdout.emit('data', Buffer.from('hello'))
  spawnCalls[1].child.simulateExit(0)
  const result = await resultPromise
  assert.equal(result.ok, true)
})

test('legacy persisted instances without serviceName/sshPort migrate to null', () => {
  const dir = tempDir()
  const file = join(dir, 'ssh-instances.json')
  writeFileSync(file, JSON.stringify([{ id: 'legacy', label: 'old', host: 'h.example.com', user: null, remotePort: 22 }]))
  const manager = createTransportManager({ provider: sshProvider, instancesFile: file, logger: silentLogger })
  const instances = manager.loadInstances()
  assert.equal(instances.length, 1)
  assert.equal(instances[0].serviceName, null)
  assert.equal(instances[0].sshPort, null)
  assert.equal(instances[0].kind, 'ssh')
})

test('an auth phrase on the final newline-less stderr line is flushed before exit (tunnel)', async t => {
  const { manager, children, spawnCalls, setProbe } = makeManager(t)
  setProbe(false)
  manager.connect('s1')
  await waitFor(() => spawnCalls.length === 1)
  children[0].stderrWrite('Permission denied (publickey).')
  children[0].simulateExit(255)
  await waitFor(() => manager.status('s1')!.phase === 'error', 3000, 'terminal error')
  assert.equal(manager.status('s1')!.requiresUserAction, true)
  assert.equal(spawnCalls.length, 1, 'no reconnect after a terminal auth failure')
})

test('an auth phrase on the final newline-less stderr line is flushed before exit (exec)', async t => {
  const { manager, spawnCalls } = makeManager(t, { instances: [EXEC_INSTANCE] })
  const resultPromise = manager.exec('s2', 'start')
  assert.equal(spawnCalls.length, 1)
  spawnCalls[0].child.stderrWrite('Permission denied (publickey).')
  spawnCalls[0].child.simulateExit(255)
  const result = await resultPromise
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /authentication/)
  assert.equal(manager.status('s2')!.requiresUserAction, false)
})

test('a SIGTERM-ignoring child gets its SIGKILL escalation after the disconnect grace', async t => {
  const { manager, children, spawnCalls, setProbe } = makeManager(t, { options: { disconnectGraceMs: 60 } })
  setProbe(true)
  manager.connect('s1')
  await waitFor(() => manager.status('s1')!.phase === 'ready')
  manager.disconnect('s1')
  assert.ok(children[0].killCalls.includes('SIGTERM'))
  await waitFor(() => children[0].killCalls.includes('SIGKILL'), 3000, 'SIGKILL escalation')
})

test('a replaced child\u2019s late spawn error never failTerminals the fresh transport', async t => {
  const { manager, children, spawnCalls, setProbe } = makeManager(t)
  setProbe(true)
  manager.connect('s1')
  await waitFor(() => manager.status('s1')!.phase === 'ready')
  setProbe(false)
  children[0].simulateExit(0)
  await waitFor(() => spawnCalls.length === 2, 3000, 'retry spawn')
  children[0].simulateSpawnError(new Error('spawn ssh ENOENT'))
  await sleep(60)
  assert.notEqual(manager.status('s1')!.phase, 'error', 'stale spawn error never failTerminals the fresh attempt')
  assert.equal(manager.status('s1')!.requiresUserAction, false)
  setProbe(true)
  await waitFor(() => manager.status('s1')!.phase === 'ready', 3000, 'fresh transport ready')
})

test('saveInstances dedups duplicate ids (first wins) so the file never disagrees with the set', () => {
  const dir = tempDir()
  const file = join(dir, 'ssh-instances.json')
  const manager = createTransportManager({ provider: sshProvider, instancesFile: file, logger: silentLogger })
  const saved = manager.saveInstances([
    { id: 's1', label: 'first', host: 'a.example.com', remotePort: 2222 },
    { id: 's1', label: 'second', host: 'b.example.com', remotePort: 2222 },
  ])
  assert.equal(saved.length, 1)
  assert.equal(saved[0].label, 'first')
  const onDisk = JSON.parse(readFileSync(file, 'utf8'))
  assert.deepEqual(onDisk, saved)
})

test('loadInstances drops duplicate persisted ids loudly (first wins)', () => {
  const dir = tempDir()
  const file = join(dir, 'ssh-instances.json')
  writeFileSync(file, JSON.stringify([
    { id: 's1', label: 'first', host: 'a.example.com', remotePort: 2222 },
    { id: 's1', label: 'second', host: 'b.example.com', remotePort: 2222 },
  ]))
  const manager = createTransportManager({ provider: sshProvider, instancesFile: file, logger: silentLogger })
  const instances = manager.loadInstances()
  assert.equal(instances.length, 1)
  assert.equal(instances[0].label, 'first')
})

/** A process-less DIRECT ENDPOINT provider: the abstraction proof. */
const fakeEndpointProvider: TransportProvider = {
  kind: 'fake',
  validateSpec(input: unknown): TransportInstanceSpec | null {
    if (input === null || typeof input !== 'object') return null
    const record = input as Record<string, unknown>
    if (typeof record.id !== 'string' || typeof record.label !== 'string'
      || typeof record.host !== 'string' || typeof record.remotePort !== 'number') return null
    if (record.kind !== undefined && record.kind !== null && record.kind !== 'fake') return null
    return {
      id: record.id,
      label: record.label,
      kind: 'fake',
      host: record.host,
      user: null,
      sshPort: null,
      remotePort: record.remotePort,
      serviceName: null,
      remoteDshHome: null,
    }
  },
  // no buildStartArgs → direct endpoint mode
  probeTarget: spec => ({ host: 'fake.local', port: spec.remotePort }),
  endpointUrl: spec => `http://fake.local:${spec.remotePort}`,
  classifyStderr: line => ({ log: line, terminalAuth: false, enoent: false }),
  // no exec → exec returns an explicit unsupported error
}

test('direct-endpoint provider: no child, probe-driven ready, endpoint URL, kind routing', async t => {
  const { manager, spawnCalls, setProbe } = makeManager(t, {
    provider: fakeEndpointProvider,
    instances: [{ id: 'f1', label: 'tailnet-host', kind: 'fake', host: 'host1.tailnet', remotePort: 8080 }],
  })
  setProbe(false)
  const connecting = manager.connect('f1')!
  assert.equal(connecting.phase, 'connecting')
  assert.equal(spawnCalls.length, 0, 'direct endpoint mode spawns no process')
  setProbe(true)
  await waitFor(() => manager.status('f1')!.phase === 'ready', 3000, 'endpoint ready')
  const status = manager.status('f1')! as StatusWithNoUrlLeak
  assert.equal(status.kind, 'fake')
  assert.equal(status.localPort, null)
  assert.equal(status.localUrl, undefined)
  assert.equal(manager.readyUrl('f1'), 'http://fake.local:8080')
  // Disconnect lands on idle and leaves no child behind.
  manager.disconnect('f1')
  assert.equal(manager.status('f1')!.phase, 'idle')
  assert.equal(manager.readyUrl('f1'), null)
})

test('direct-endpoint provider: probe failure lands on degraded and reconnects (no child to kill)', async t => {
  const { manager, setProbe } = makeManager(t, {
    provider: fakeEndpointProvider,
    options: { readyTimeoutMs: 100, probeIntervalMs: 5, retryBaseMs: 10, retryMaxMs: 40 },
    instances: [{ id: 'f2', label: 'flaky', kind: 'fake', host: 'flaky.tailnet', remotePort: 9090 }],
  })
  setProbe(false)
  manager.connect('f2')
  await waitFor(() => manager.status('f2')!.phase === 'degraded', 3000, 'degraded after timeout')
  setProbe(true)
  await waitFor(() => manager.status('f2')!.phase === 'ready', 3000, 'reconnected ready')
  assert.equal(manager.readyUrl('f2'), 'http://fake.local:9090')
})

test('exec for a provider without an exec channel is an explicit error', async t => {
  const { manager, spawnCalls } = makeManager(t, {
    provider: fakeEndpointProvider,
    instances: [{ id: 'f3', label: 'noexec', kind: 'fake', host: 'x.tailnet', remotePort: 8080 }],
  })
  const result = await manager.exec('f3', 'start')
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /not supported by transport kind fake/)
  assert.equal(spawnCalls.length, 0)
})

test('entries whose kind mismatches the provider kind are dropped on save and load', () => {
  const dir = tempDir()
  const file = join(dir, 'ssh-instances.json')
  const manager = createTransportManager({ provider: fakeEndpointProvider, instancesFile: file, logger: silentLogger })
  const saved = manager.saveInstances([
    { id: 'ssh-one', label: 'wrong kind', kind: 'ssh', host: 'h.example.com', remotePort: 22 },
    { id: 'f4', label: 'right kind', kind: 'fake', host: 'x.tailnet', remotePort: 8080 },
  ])
  assert.deepEqual(saved.map(entry => entry.id), ['f4'])
  writeFileSync(file, JSON.stringify([
    { id: 'ssh-two', label: 'wrong kind', kind: 'ssh', host: 'h.example.com', remotePort: 22 },
  ]))
  const reopened = createTransportManager({ provider: fakeEndpointProvider, instancesFile: file, logger: silentLogger })
  assert.deepEqual(reopened.loadInstances().map(entry => entry.id), [])
})

test('a pending SIGKILL escalation for one child survives another child\u2019s failure', async t => {
  const { manager, children, spawnCalls, setProbe } = makeManager(t, { options: { disconnectGraceMs: 60 } })
  setProbe(true)
  manager.connect('s1')
  await waitFor(() => manager.status('s1')!.phase === 'ready')
  setProbe(false)
  manager.disconnect('s1')
  assert.ok(children[0].killCalls.includes('SIGTERM'))
  manager.connect('s1')
  await waitFor(() => spawnCalls.length === 2, 3000, 'fresh spawn after reconnect')
  children[1].stderrWrite('Permission denied (publickey).\n')
  children[1].simulateExit(255)
  await waitFor(() => manager.status('s1')!.phase === 'error', 3000, 'terminal error')
  // B's failTerminal arms B's OWN escalation and must never cancel A's pending
  // SIGKILL (per-child escalation slots).
  await waitFor(() => children[0].killCalls.includes('SIGKILL'), 3000, 'A still gets its SIGKILL')
  assert.ok(!children[1].killCalls.includes('SIGKILL'), 'a cleanly-exited child never gets SIGKILL')
})

test('disposeAsync SIGTERMs, SIGKILLs and settles an in-flight exec child that ignores TERM', async t => {
  const { manager, spawnCalls, children } = makeManager(t, { instances: [EXEC_INSTANCE] })
  const resultPromise = manager.exec('s2', 'start')
  assert.equal(spawnCalls.length, 1)
  const disposing = manager.disposeAsync()
  assert.ok(children[0].killCalls.includes('SIGTERM'), 'in-flight exec child is SIGTERMed on dispose')
  await waitFor(() => children[0].killCalls.includes('SIGKILL'), 3000, 'TERM-ignoring exec gets SIGKILL')
  children[0].simulateExit(null, 'SIGKILL')
  await disposing
  const result = await resultPromise
  assert.equal(result.ok, false)
})

/** A tunnel provider whose buildStartEnv injects an askpass-style env. */
const fakeEnvProvider: TransportProvider = {
  kind: 'fake-env',
  validateSpec(input: unknown): TransportInstanceSpec | null {
    if (input === null || typeof input !== 'object') return null
    const record = input as Record<string, unknown>
    if (typeof record.id !== 'string' || typeof record.label !== 'string'
      || typeof record.host !== 'string' || typeof record.remotePort !== 'number') return null
    if (record.kind !== undefined && record.kind !== null && record.kind !== 'fake-env') return null
    return {
      id: record.id,
      label: record.label,
      kind: 'fake-env',
      host: record.host,
      user: null,
      sshPort: null,
      remotePort: record.remotePort,
      serviceName: null,
      remoteDshHome: null,
    }
  },
  buildStartArgs: (spec, localPort) => ['-N', '-L', `${localPort}:127.0.0.1:${spec.remotePort}`, spec.host],
  buildStartEnv: spec => ({ SSH_ASKPASS: `/tmp/askpass-${spec.id}`, SSH_ASKPASS_REQUIRE: 'force' }),
  classifyStderr: line => ({ log: line, terminalAuth: false, enoent: false }),
}

test('a provider buildStartEnv is merged over process.env for the transport spawn', async t => {
  const { manager, spawnCalls, setProbe } = makeManager(t, {
    provider: fakeEnvProvider,
    instances: [{ id: 'e1', label: 'envhost', kind: 'fake-env', host: 'env.example.com', remotePort: 8080 }],
  })
  setProbe(true)
  manager.connect('e1')
  await waitFor(() => manager.status('e1')!.phase === 'ready')
  assert.equal(spawnCalls.length, 1)
  const env = spawnCalls[0].options.env
  assert.ok(env !== undefined, 'provider env is applied to the spawn')
  assert.equal(env.SSH_ASKPASS, '/tmp/askpass-e1')
  assert.equal(env.SSH_ASKPASS_REQUIRE, 'force')
  assert.equal(env.PATH, process.env.PATH, 'process.env is preserved, never replaced')
})

test('disposeAuth is called when a live transport is disconnected', async t => {
  const disposed: string[] = []
  const provider: TransportProvider = {
    ...fakeEnvProvider,
    disposeAuth: spec => { disposed.push(spec.id) },
  }
  const { manager, setProbe } = makeManager(t, {
    provider,
    instances: [{ id: 'e2', label: 'envhost2', kind: 'fake-env', host: 'env2.example.com', remotePort: 8080 }],
  })
  setProbe(true)
  manager.connect('e2')
  await waitFor(() => manager.status('e2')!.phase === 'ready')
  manager.disconnect('e2')
  assert.deepEqual(disposed, ['e2'])
})

test('a throwing provider buildStartEnv lands on a loud error, never a stuck connecting', async t => {
  const provider: TransportProvider = {
    ...fakeEnvProvider,
    buildStartEnv: () => { throw new Error('env boom') },
  }
  const { manager, spawnCalls } = makeManager(t, {
    provider,
    instances: [{ id: 'e3', label: 'envhost3', kind: 'fake-env', host: 'env3.example.com', remotePort: 8080 }],
  })
  manager.connect('e3')
  await waitFor(() => manager.status('e3')!.phase === 'error', 3000, 'terminal error')
  assert.equal(spawnCalls.length, 0, 'no transport spawns after a throwing buildStartEnv')
  assert.equal(manager.status('e3')!.requiresUserAction, false, 'a provider bug is not a user-action failure')
})

test('hostile thrown values from allocation and provider start hooks still settle loudly', async t => {
  const hostile = new Proxy({}, {
    get() { throw new Error('formatter trap') },
    getPrototypeOf() { throw new Error('instanceof trap') },
  })
  const allocation = makeManager(t, {
    allocatePort: async () => { throw hostile },
  })
  allocation.manager.connect('s1')
  await waitFor(() => allocation.manager.status('s1')?.phase === 'error', 3000, 'hostile allocation error')
  assert.match(allocation.manager.status('s1')!.logSummary, /unknown error/)
  assert.ok(allocation.manager.logs('s1').some(entry => entry.message.includes('unknown error')))

  const throwingProvider: TransportProvider = {
    ...sshProvider,
    buildStartArgs: () => { throw hostile },
  }
  const providerStart = makeManager(t, { provider: throwingProvider })
  providerStart.manager.connect('s1')
  await waitFor(() => providerStart.manager.status('s1')?.phase === 'error', 3000, 'hostile provider start error')
  assert.match(providerStart.manager.status('s1')!.logSummary, /unknown error/)
  assert.equal(providerStart.spawnCalls.length, 0)
})
