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
 * redaction, per-child guards, provider environment injection, and endpoint
 * identity verification (a port that merely accepts TCP is never
 * ready; a real dsh host.describe handshake is required — covered against
 * real loopback HTTP servers).
 */

import { test } from 'node:test'
import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SpawnOptions } from 'node:child_process'
import {
  attemptCommittedRegistryPush,
  commitTransportCredentialUpdate,
  computePasswordRetirementIds,
  computeRemovedInstanceIds,
  computeRetiredInstanceIds,
  createTransportManager,
  jitteredBackoffMs,
  RING_BUFFER_LIMIT,
  RING_LOG_MESSAGE_MAX_CHARS,
} from './transport-manager.ts'
import { prepareRegistryPasswordCommit } from './registry-password-commit.ts'
import { CHILD_LINE_MAX_CHARS } from './bounded-lines.ts'
import type { TransportManager, TransportManagerOptions } from './transport-manager.ts'
import { MAX_TRANSPORT_INSTANCES } from './transport-provider.ts'
import type { TransportInstanceInput, TransportInstanceSpec, TransportKind, TransportProvider, TransportStatusProjection, TransportVerifyResult, SpawnedProcess } from './transport-provider.ts'
import {
  configureSshPasswordStore,
  probeClientGraphLive,
  probeGitWorktreeLive,
  purgeSshAuth,
  redactSshStderr,
  SERVER_ALIVE_COUNT_MAX,
  SERVER_ALIVE_INTERVAL_SECONDS,
  setSshPassword,
  sshProvider,
  verifyDshEndpoint,
} from './ssh-provider.ts'
import {
  configureGatewayTokenStore,
  gatewayHttpFailureIsTerminal,
  gatewayProvider,
  getGatewayToken,
  setGatewayToken,
} from './gateway-provider.ts'

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

function makeManager(t: TestContext, overrides: {
  options?: TransportManagerOptions
  instances?: TransportInstanceInput[]
  random?: () => number
  provider?: TransportProvider
  verifyProbe?: (spec: TransportInstanceSpec, endpoint: { host: string; port: number }) => Promise<TransportVerifyResult>
  allocatePort?: () => Promise<number>
  logger?: { log?(message: string): void; warn?(message: string): void; error?(message: string): void }
  spawnFn?: (command: string, args: readonly string[], options: SpawnOptions) => SpawnedProcess
  includeDefault?: boolean
} = {}) {
  const spawnCalls: Array<{ command: string; args: readonly string[]; options: SpawnOptions; child: FakeChild }> = []
  const children: FakeChild[] = []
  const spawnTimes: number[] = []
  let probeOk = false
  const instancesFile = join(tempDir(t), 'ssh-instances.json')
  const manager = createTransportManager({
    provider: overrides.provider ?? sshProvider,
    spawnFn: (command, args, options) => {
      if (overrides.spawnFn !== undefined) return overrides.spawnFn(command, args, options)
      const child = new FakeChild()
      spawnCalls.push({ command, args, options, child })
      children.push(child)
      spawnTimes.push(Date.now())
      return child
    },
    instancesFile,
    logger: overrides.logger ?? silentLogger,
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
    ...(overrides.includeDefault === false
      ? []
      : [{ id: 's1', label: 'home-server', host: 'home.example.com', user: 'alice', remotePort: 2222 }]),
    ...(overrides.instances ?? []),
  ])
  return {
    manager,
    spawnCalls,
    children,
    spawnTimes,
    instancesFile,
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
    id: 'same', label: 'old label', kind: 'dsh', transport: 'ssh', insecureHttp: false,
    host: 'old.example.com', user: 'alice', sshPort: 22, remotePort: 3080,
    serviceName: 'dsh-old', remoteDshHome: '~/.old',
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

test('password ownership follows the SSH authentication peer, not unrelated host metadata', () => {
  const before: TransportInstanceSpec[] = [{
    id: 'same', label: 'old label', kind: 'dsh', transport: 'ssh', insecureHttp: false,
    host: 'old.example.com', user: 'alice', sshPort: 22, remotePort: 3080,
    serviceName: 'dsh-old', remoteDshHome: '~/.old',
  }]
  assert.deepEqual(computePasswordRetirementIds(before, []), ['same'])
  assert.deepEqual(computePasswordRetirementIds(before, [{ ...before[0], host: 'new.example.com' }]), ['same'])
  assert.deepEqual(computePasswordRetirementIds(before, [{ ...before[0], user: 'bob' }]), ['same'])
  assert.deepEqual(computePasswordRetirementIds(before, [{ ...before[0], sshPort: 2222 }]), ['same'])
  const nonAuthenticationEdit: TransportInstanceSpec[] = [{
    ...before[0], label: 'new label', remotePort: 4080, serviceName: 'dsh-new', remoteDshHome: '~/.new',
  }]
  assert.deepEqual(computePasswordRetirementIds(before, nonAuthenticationEdit), [])
})

test('endpoint edit commits replacement password before restart, including other retirements in one write', async (t) => {
  const secrets = new Map([['s1', 'old-password'], ['retired', 'retired-password']])
  const provider: TransportProvider = {
    ...sshProvider,
    buildStartEnv: spec => ({
      env: { CHAMBER_TEST_PASSWORD: secrets.get(spec.id) ?? '' },
      release() {},
    }),
    disposeAuth() {},
  }
  const runtime = makeManager(t, {
    provider,
    instances: [{ id: 'retired', label: 'retired', host: 'retired.example.com', remotePort: 3080 }],
  })
  runtime.setProbe(true)
  runtime.manager.connect('s1')
  await waitFor(() => runtime.manager.status('s1')?.phase === 'ready', 1000, 'initial ready transport')

  const before = runtime.manager.listInstances()
  let updateCalls = 0
  const saved = runtime.manager.saveInstances(
    [{ ...before[0], host: 'moved.example.com' }],
    after => prepareRegistryPasswordCommit(
      before,
      after,
      { id: 's1', password: 'new-password' },
      {
        update(clearIds, replacement) {
          updateCalls += 1
          assert.deepEqual(clearIds, ['s1', 'retired'])
          assert.equal(replacement?.owner.host, 'moved.example.com')
          assert.equal(runtime.manager.listInstances()[0].host, 'home.example.com', 'runtime is not published yet')
          assert.deepEqual(runtime.children[0].killCalls, [], 'old transport is not retired before the secret commit')
          const next = new Map(secrets)
          for (const id of clearIds) next.delete(id)
          if (replacement !== undefined) next.set(replacement.owner.id, replacement.password)
          secrets.clear()
          for (const [id, password] of next) secrets.set(id, password)
        },
      },
    ),
  )

  assert.equal(updateCalls, 1)
  assert.equal(saved[0].host, 'moved.example.com')
  assert.equal(secrets.get('s1'), 'new-password')
  assert.equal(secrets.has('retired'), false)
  await waitFor(() => runtime.spawnCalls.length === 2, 1000, 'replacement transport spawn')
  assert.equal(runtime.spawnCalls[1].options.env?.CHAMBER_TEST_PASSWORD, 'new-password')
  assert.deepEqual(runtime.children[0].killCalls, ['SIGTERM'])
})

test('password commit failure restores the old registry and leaves its live transport and secret untouched', async (t) => {
  const runtime = makeManager(t)
  runtime.setProbe(true)
  runtime.manager.connect('s1')
  await waitFor(() => runtime.manager.status('s1')?.phase === 'ready', 1000, 'initial ready transport')
  const before = runtime.manager.listInstances()
  const beforeFile = readFileSync(runtime.instancesFile, 'utf8')
  let secret = 'old-password'

  assert.throws(() => runtime.manager.saveInstances(
    [{ ...before[0], host: 'moved.example.com' }],
    after => prepareRegistryPasswordCommit(
      before,
      after,
      { id: 's1', password: 'new-password' },
      {
        update() {
          throw new Error('password write failed')
        },
      },
    ),
  ), /password write failed/)

  assert.equal(secret, 'old-password')
  assert.deepEqual(runtime.manager.listInstances(), before)
  assert.equal(readFileSync(runtime.instancesFile, 'utf8'), beforeFile)
  assert.equal(runtime.manager.status('s1')?.phase, 'ready')
  assert.deepEqual(runtime.children[0].killCalls, [])
  assert.equal(runtime.spawnCalls.length, 1)
})

test('replacement owner is validated against the complete normalized proposal before registry persistence', (t) => {
  const runtime = makeManager(t)
  const before = runtime.manager.listInstances()
  const beforeFile = readFileSync(runtime.instancesFile, 'utf8')
  assert.throws(() => runtime.manager.saveInstances(
    [{ ...before[0], label: 'renamed' }],
    after => prepareRegistryPasswordCommit(
      before,
      after,
      { id: 'not-in-proposal', password: 'pw' },
      { update() { assert.fail('password store must not run for an invalid owner') } },
    ),
  ), /does not match an instance/)
  assert.deepEqual(runtime.manager.listInstances(), before)
  assert.equal(readFileSync(runtime.instancesFile, 'utf8'), beforeFile)
})

test('authentication-owner edit without a replacement retires the old secret', (t) => {
  const runtime = makeManager(t)
  const before = runtime.manager.listInstances()
  let secret: string | null = 'old-password'
  let clearIds: readonly string[] = []
  runtime.manager.saveInstances(
    [{ ...before[0], user: 'bob' }],
    after => prepareRegistryPasswordCommit(before, after, undefined, {
      update(ids, replacement) {
        clearIds = ids
        assert.equal(replacement, undefined)
        secret = null
      },
    }),
  )
  assert.deepEqual(clearIds, ['s1'])
  assert.equal(secret, null)
})

test('non-authentication edit does not touch the password store', (t) => {
  const runtime = makeManager(t)
  const before = runtime.manager.listInstances()
  let updateCalls = 0
  runtime.manager.saveInstances(
    [{ ...before[0], label: 'renamed', remotePort: 4080, serviceName: 'dsh-new' }],
    after => prepareRegistryPasswordCommit(before, after, undefined, {
      update() { updateCalls += 1 },
    }),
  )
  assert.equal(updateCalls, 0)
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

test('saveInstances atomically replaces a valid set and disconnects removed instances', t => {
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
    kind: 'dsh',
    transport: 'ssh',
    insecureHttp: false,
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
  assert.deepEqual(await oldExec, { ok: false, error: 'exec superseded by connection change' })
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
  assert.deepEqual(await oldExec, { ok: false, error: 'exec superseded by connection change' })
  assert.equal(manager.status('s2')?.serviceActive, null, 'late old result cannot project onto the edited host')
  assert.deepEqual(manager.logs('s2'), [], 'late old result cannot log onto the edited host')

  const freshExec = manager.exec('s2', 'start')
  assert.equal(spawnCalls.length, 2)
  assert.deepEqual(spawnCalls[1].args, ['carol@replacement.example.com', 'systemctl', 'start', '--', 'dsh-chamber'])
  spawnCalls[1].child.simulateExit(0)
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
  assert.deepEqual(execCall.args, ['-p', '2202', 'carol@box.example.com', 'systemctl', 'start', '--', 'dsh-chamber'])
  execCall.child.simulateExit(0)
  const result = await resultPromise
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.status.serviceActive, true)
})

test('invalid sshPort rejects the whole save without creating a partial registry', () => {
  const dir = tempDir()
  const file = join(dir, 'ssh-instances.json')
  const manager = createTransportManager({ provider: sshProvider, instancesFile: file, logger: silentLogger })
  assert.throws(() => manager.saveInstances([
    { id: 'zero', label: 'x', host: 'h', sshPort: 0, remotePort: 3080 },
    { id: 'huge', label: 'y', host: 'h2', sshPort: 70000, remotePort: 3080 },
    { id: 'float', label: 'z', host: 'h3', sshPort: 22.5, remotePort: 3080 },
    { id: 'ok', label: 'w', host: 'h4', sshPort: 2202, remotePort: 3080 },
  ]), /instance at index 0 is invalid/)
  assert.deepEqual(manager.listInstances(), [])
  assert.equal(existsSync(file), false)
})

test('an invalid edit cannot delete the existing host from memory or disk', () => {
  const dir = tempDir()
  const file = join(dir, 'ssh-instances.json')
  const manager = createTransportManager({ provider: sshProvider, instancesFile: file, logger: silentLogger })
  const before = manager.saveInstances([
    { id: 's1', label: 'home', host: 'home.example.com', remotePort: 3080, remoteDshHome: '/srv/dsh' },
  ])
  assert.throws(
    () => manager.saveInstances([{ ...before[0], remoteDshHome: '/srv/../tmp' }]),
    /instance at index 0 is invalid/,
  )
  assert.deepEqual(manager.listInstances(), before)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), before)
})

test('option-injection guards: id/host/user must match the whitelists (no leading -)', () => {
  const dir = tempDir()
  const file = join(dir, 'ssh-instances.json')
  const manager = createTransportManager({ provider: sshProvider, instancesFile: file, logger: silentLogger })
  assert.throws(() => manager.saveInstances([
    { id: 'bad id', label: 'x', host: 'h', remotePort: 3080 },
    { id: 'slash/id', label: 'x', host: 'h', remotePort: 3080 },
    { id: 'local', label: 'x', host: 'h', remotePort: 3080 },
    { id: 'dash-host', label: 'x', host: '-oProxyCommand=curl evil', remotePort: 3080 },
    { id: 'dash-user', label: 'x', host: 'h', user: '-o', remotePort: 3080 },
    { id: 'spaces', label: 'x', host: 'h two words', remotePort: 3080 },
    { id: 'good', label: 'x', host: '192.168.1.10', user: 'root', remotePort: 3080 },
  ]), /instance at index 0 is invalid/)
  assert.deepEqual(manager.listInstances(), [])
})

test('hyphenated hostnames and bracketed IPv6 literals are accepted', () => {
  const dir = tempDir()
  const file = join(dir, 'ssh-instances.json')
  const manager = createTransportManager({ provider: sshProvider, instancesFile: file, logger: silentLogger })
  const saved = manager.saveInstances([
    { id: 'hy', label: 'x', host: 'my-server.example.com', remotePort: 3080 },
    { id: 'v6', label: 'y', host: '[::1]', remotePort: 3080 },
  ])
  assert.deepEqual(saved.map(entry => entry.id), ['hy', 'v6'])
  assert.throws(
    () => manager.saveInstances([...saved, { id: 'v6zone', label: 'z', host: '[fe80::1%eth0]', remotePort: 3080 }]),
    /instance at index 2 is invalid/,
  )
  assert.deepEqual(manager.listInstances(), saved)
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

test('a throwing provider classifier drops output without logging its sensitive input', async t => {
  const warnings: string[] = []
  const throwingProvider: TransportProvider = {
    ...sshProvider,
    classifyStderr: () => { throw new Error('classifier failed') },
  }
  const { manager, children, spawnCalls } = makeManager(t, {
    provider: throwingProvider,
    logger: { warn: message => warnings.push(message) },
  })
  manager.connect('s1')
  await waitFor(() => spawnCalls.length === 1)
  const secret = "Enter passphrase for key '/Users/private/.ssh/id_ed25519'"
  children[0].stdout.emit('data', Buffer.from(`${secret}\n`))
  children[0].stderrWrite(`${secret}\n`)

  const visible = [...warnings, ...manager.logs('s1').map(entry => entry.message)]
  assert.ok(visible.some(line => line.includes('output dropped')))
  assert.ok(visible.every(line => !line.includes(secret) && !line.includes('.ssh/')))
  manager.disconnect('s1')
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
  // A null/non-object entry among valid ones must be DROPPED loudly, never
  // throw inside provider resolution (per-entry defense beside the corrupt
  // whole-file path).
  const withNull = join(dir, 'with-null.json')
  writeFileSync(withNull, JSON.stringify([
    { id: 'ok', label: 'fine', host: 'h.example.com', remotePort: 22 },
    null,
    42,
    'stray',
    { id: 'also-ok', label: 'fine', host: 'h.example.com', remotePort: 22 },
  ]))
  const nullManager = createTransportManager({ provider: sshProvider, instancesFile: withNull, logger: silentLogger })
  const nullLoaded = nullManager.loadInstances()
  assert.deepEqual(nullLoaded.map(entry => entry.id), ['ok', 'also-ok'], 'valid entries survive; null/non-object entries are dropped')
})

test('label-only edits keep the live tunnel untouched', async t => {
  const { manager, spawnCalls, setProbe } = makeManager(t)
  setProbe(true)
  manager.connect('s1')
  await waitFor(() => manager.status('s1')!.phase === 'ready')
  assert.equal(spawnCalls.length, 1)
  manager.saveInstances([
    { id: 's1', label: 'renamed', host: 'home.example.com', user: 'alice', remotePort: 2222 },
  ])
  await sleep(60)
  assert.equal(spawnCalls.length, 1, 'no restart for metadata-only edits')
  assert.equal(manager.status('s1')!.phase, 'ready')
})

test('serviceName and remoteDshHome edits reset service projection and restart a live transport', async t => {
  const { manager, spawnCalls, setProbe } = makeManager(t, { instances: [EXEC_INSTANCE] })

  const activePromise = manager.exec('s2', 'is-active')
  assert.equal(spawnCalls.length, 1)
  spawnCalls[0].child.simulateExit(0)
  assert.equal((await activePromise).ok, true)
  assert.equal(manager.status('s2')!.serviceActive, true)

  setProbe(true)
  manager.connect('s2')
  await waitFor(() => manager.status('s2')!.phase === 'ready')
  const originalTunnel = spawnCalls[1].child
  manager.saveInstances([{ ...EXEC_INSTANCE, serviceName: 'other.service' }])
  assert.ok(originalTunnel.killCalls.includes('SIGTERM'), 'service identity change tears down the old tunnel')
  assert.equal(manager.status('s2')!.serviceActive, null, 'a cached old-unit status never labels the replacement unit')
  await waitFor(() => spawnCalls.length === 3, 3_000, 'serviceName replacement tunnel')
  await waitFor(() => manager.status('s2')!.phase === 'ready', 3_000, 'serviceName replacement ready')

  const serviceTunnel = spawnCalls[2].child
  manager.saveInstances([{ ...EXEC_INSTANCE, serviceName: 'other.service', remoteDshHome: '/srv/dsh' }])
  assert.ok(serviceTunnel.killCalls.includes('SIGTERM'), 'remote dsh home is part of the live exec generation')
  await waitFor(() => spawnCalls.length === 4, 3_000, 'remoteDshHome replacement tunnel')
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

test('ring projection truncation happens after auth classification', async t => {
  const { manager, children, spawnCalls, setProbe } = makeManager(t)
  setProbe(false)
  manager.connect('s1')
  await waitFor(() => spawnCalls.length === 1)
  children[0].stderrWrite(`${'x'.repeat(RING_LOG_MESSAGE_MAX_CHARS + 128)} Permission denied (publickey,password).\n`)
  children[0].simulateExit(255)
  await waitFor(() => manager.status('s1')!.phase === 'error')
  assert.equal(manager.status('s1')!.requiresUserAction, true, 'the classifier still sees the auth marker after the display cap')
  const retained = manager.logs('s1').find(entry => entry.message.startsWith('x'))?.message ?? ''
  assert.equal(retained.length, RING_LOG_MESSAGE_MAX_CHARS)
  assert.ok(retained.endsWith('[truncated]'))
  assert.ok(manager.logs('s1').some(entry => entry.message.includes('authentication failure detected')))
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

test('stdout redaction also reassembles lines split across chunks', async t => {
  const { manager, children, spawnCalls, setProbe } = makeManager(t)
  setProbe(false)
  manager.connect('s1')
  await waitFor(() => spawnCalls.length === 1)
  children[0].stdout.emit('data', Buffer.from('debug1: identity file /Users/x/.s'))
  children[0].stdout.emit('data', Buffer.from('sh/id_ed25519 type 3\n'))
  await sleep(30)
  const lines = manager.logs('s1')
  assert.ok(lines.some(entry => entry.message === '[ssh material redacted]'))
  assert.ok(lines.every(entry => !entry.message.includes('/.ssh') || entry.message === '[ssh material redacted]'))
})

test('unterminated transport output is bounded, dropped, and resumes at the next line', async t => {
  const { manager, children, spawnCalls, setProbe } = makeManager(t)
  setProbe(false)
  manager.connect('s1')
  await waitFor(() => spawnCalls.length === 1)
  children[0].stderrWrite('x'.repeat(CHILD_LINE_MAX_CHARS + 1))
  children[0].stderrWrite('\nordinary line\n')
  await sleep(30)
  const lines = manager.logs('s1')
  assert.ok(lines.some(entry => entry.message.includes('output line dropped')))
  assert.ok(lines.some(entry => entry.message === 'ordinary line'))
  assert.ok(lines.every(entry => !entry.message.includes('xxxxx')))
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

test('ring entries retain a useful prefix but cap classified messages independently of parser lines', async t => {
  const { manager, setProbe } = makeManager(t)
  setProbe(true)
  manager.connect('s1')
  await waitFor(() => manager.status('s1')!.phase === 'ready')
  const oversized = `diagnostic:${'x'.repeat(RING_LOG_MESSAGE_MAX_CHARS * 2)}`
  assert.equal(manager.appendLog('s1', 'info', oversized), true)
  const retained = manager.logs('s1').at(-1)?.message ?? ''
  assert.equal(retained.length, RING_LOG_MESSAGE_MAX_CHARS)
  assert.ok(retained.startsWith('diagnostic:'))
  assert.ok(retained.endsWith('[truncated]'))
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

test('startService spawns `ssh user@host systemctl start -- <service>` and lands serviceActive', async t => {
  const { manager, spawnCalls } = makeManager(t, { instances: [EXEC_INSTANCE] })
  const resultPromise = manager.exec('s2', 'start')
  assert.equal(spawnCalls.length, 1)
  const call = spawnCalls[0]
  assert.equal(call.command, 'ssh')
  assert.deepEqual(call.args, ['bob@lab.example.com', 'systemctl', 'start', '--', 'dsh-chamber'])
  call.child.simulateExit(0)
  const result = await resultPromise
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.status.remotePort, 3080)
    assert.equal(result.status.serviceActive, true)
  }
})

test('stopService spawns `ssh user@host systemctl stop -- <service>`; non-zero exit is loud', async t => {
  const { manager, spawnCalls } = makeManager(t, { instances: [EXEC_INSTANCE] })
  const resultPromise = manager.exec('s2', 'stop')
  assert.equal(spawnCalls.length, 1)
  const call = spawnCalls[0]
  assert.deepEqual(call.args, ['bob@lab.example.com', 'systemctl', 'stop', '--', 'dsh-chamber'])
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
  assert.deepEqual(spawnCalls[0].args, ['bob@lab.example.com', 'systemctl', 'is-active', '--', 'dsh-chamber'])
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

test('registry refuses option-shaped serviceName values atomically and accepts a normal hyphenated unit', async t => {
  const { manager, spawnCalls } = makeManager(t)
  const before = manager.listInstances()
  for (const serviceName of ['bad;rm -rf /', '--help', '-Hattacker.example', '-x', '--user']) {
    assert.throws(
      () => manager.saveInstances([...before, { ...EXEC_INSTANCE, serviceName }]),
      (error: unknown) => (error as { code?: string }).code === 'ssh_instances_invalid',
      serviceName,
    )
  }
  assert.deepEqual(manager.listInstances(), before)
  assert.equal(spawnCalls.length, 0, 'no ssh process may spawn for an unwhitelisted service name')
  manager.saveInstances([...before, { ...EXEC_INSTANCE, id: 'good-unit', serviceName: 'my-unit.service' }])
  const validPromise = manager.exec('good-unit', 'start')
  assert.equal(spawnCalls.length, 1)
  assert.deepEqual(spawnCalls[0].args, ['bob@lab.example.com', 'systemctl', 'start', '--', 'my-unit.service'])
  spawnCalls[0].child.simulateExit(0)
  assert.equal((await validPromise).ok, true)
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

test('removing an instance cancels its in-flight exec; its late callbacks never pollute a same-id reuse', async t => {
  // Review 2026-08: an instance removed while an exec is in flight must not
  // leave the exec running (disconnect SIGTERMs it), and the exec's LATE
  // setProjection/log callbacks must never write into the state of a later
  // same-id reuse (execEpoch bumped at disconnect + states.delete on
  // removal are the authoritative cleanup).
  const { manager, spawnCalls } = makeManager(t, { instances: [EXEC_INSTANCE] })
  const resultPromise = manager.exec('s2', 'start')
  assert.equal(spawnCalls.length, 1)
  const execChild = spawnCalls[0].child
  // Removal → disconnect: the in-flight exec child is SIGTERMed.
  manager.saveInstances([])
  assert.ok(execChild.killCalls.includes('SIGTERM'), 'disconnect SIGTERMs the in-flight exec child')
  assert.equal(manager.status('s2'), null)
  // Same id re-added: the new instance must start from a clean state.
  manager.saveInstances([EXEC_INSTANCE])
  assert.equal(manager.status('s2')!.serviceActive, null, 'fresh state — no carry-over projection')
  assert.deepEqual(manager.logs('s2'), [], 'fresh ring buffer — no carry-over logs')
  // The OLD exec's ssh process finally exits 0: its late callbacks are
  // stale and must never reach the NEW instance.
  execChild.simulateExit(0)
  const result = await resultPromise
  assert.equal(result.ok, false, 'the stale caller is explicitly superseded')
  if (!result.ok) assert.match(result.error, /superseded/)
  assert.equal(manager.status('s2')!.serviceActive, null, 'late setProjection never pollutes the reused instance')
  assert.equal(manager.logs('s2').some(entry => /systemctl start/.test(entry.message)), false, 'late exec logs never reach the reused instance')
})

test('an idle-phase exec is torn down before a same-id endpoint retarget and cannot pollute the replacement', async t => {
  const { manager, spawnCalls } = makeManager(t, { instances: [EXEC_INSTANCE] })
  const resultPromise = manager.exec('s2', 'start')
  assert.equal(manager.status('s2')!.phase, 'idle', 'exec does not imply a connected tunnel phase')
  assert.equal(spawnCalls.length, 1)
  const oldChild = spawnCalls[0].child

  const replacement = { ...EXEC_INSTANCE, host: 'replacement.example.com' }
  manager.saveInstances([replacement])
  assert.ok(oldChild.killCalls.includes('SIGTERM'), 'retarget tears down the old exec even though phase was idle')
  assert.equal(spawnCalls.length, 1, 'an exec-only generation does not auto-connect the replacement transport')
  assert.equal(manager.listInstances()[0]?.host, replacement.host)
  assert.equal(manager.status('s2')!.phase, 'idle')

  oldChild.simulateExit(0)
  const result = await resultPromise
  assert.equal(result.ok, false, 'the stale caller settles as superseded')
  if (!result.ok) assert.match(result.error, /superseded/)
  assert.equal(manager.status('s2')!.serviceActive, null, 'late projection is generation-guarded')
  assert.equal(manager.logs('s2').some(entry => /systemctl start/.test(entry.message)), false, 'late log is generation-guarded')
})

test('an exec callback between child stages is fenced by service identity even without an epoch bump', async t => {
  let finishProvider!: () => void
  const providerGate = new Promise<void>(resolve => { finishProvider = resolve })
  const provider: TransportProvider = {
    ...sshProvider,
    exec: async (spec, _action, deps) => {
      await providerGate
      deps.log('info', 'stale service callback')
      deps.setProjection(spec.id, 'serviceActive', true)
      const projected = deps.projection(spec.id)
      return projected === null
        ? { ok: false, error: 'provider projection unavailable' }
        : { ok: true, status: projected }
    },
  }
  const { manager } = makeManager(t, { provider, instances: [EXEC_INSTANCE] })
  const resultPromise = manager.exec('s2', 'start')
  manager.saveInstances([{ ...EXEC_INSTANCE, serviceName: 'replacement.service' }])
  assert.equal(manager.status('s2')!.serviceActive, null)
  finishProvider()
  const result = await resultPromise
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /superseded/)
  assert.equal(manager.status('s2')!.serviceActive, null, 'old service callback cannot restore the reset projection')
  assert.equal(manager.logs('s2').some(entry => entry.message === 'stale service callback'), false)
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

test('a multi-stage write-file cannot spawn its second old-spec child after a home retarget', async t => {
  const { manager, spawnCalls } = makeManager(t, { instances: [EXEC_INSTANCE] })
  const resultPromise = manager.exec('s2', 'run', {
    op: 'write-file',
    path: '~/.dsh-chamber/plugins/pkg-a1b2.tgz',
    contentBase64: Buffer.from('hello').toString('base64'),
    sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
  })
  assert.equal(spawnCalls.length, 1)
  // The provider resolves stage one synchronously and queues stage two as a
  // microtask. Retarget in that gap: there is no tracked child at save time,
  // so the spec-identity fence (not only execEpoch) must refuse stage two.
  spawnCalls[0].child.simulateExit(0)
  manager.saveInstances([{ ...EXEC_INSTANCE, remoteDshHome: '/srv/dsh' }])
  const result = await resultPromise
  assert.equal(spawnCalls.length, 1, 'no read-back ssh child reaches the old target')
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /superseded/)
})

test('legacy persisted instances without serviceName/sshPort migrate to null (v2 kind/transport)', () => {
  const dir = tempDir()
  const file = join(dir, 'ssh-instances.json')
  writeFileSync(file, JSON.stringify([{ id: 'legacy', label: 'old', host: 'h.example.com', user: null, remotePort: 22 }]))
  const manager = createTransportManager({ provider: sshProvider, instancesFile: file, logger: silentLogger })
  const instances = manager.loadInstances()
  assert.equal(instances.length, 1)
  assert.equal(instances[0].serviceName, null)
  assert.equal(instances[0].sshPort, null)
  // v2 migration (design 17 §2.2): kind missing → { kind:'dsh', transport:'ssh' }.
  assert.equal(instances[0].kind, 'dsh')
  assert.equal(instances[0].transport, 'ssh')
  assert.equal(instances[0].insecureHttp, false)
})

test('v2 migration: legacy kinds normalize on load and save (design 17 §2.2)', () => {
  const dir = tempDir()
  const file = join(dir, 'ssh-instances.json')
  // Legacy v1 file: kind 'ssh' / kind 'gateway' / kind missing / v2-form with
  // transport missing — each must normalize before provider validation.
  writeFileSync(file, JSON.stringify([
    { id: 'legacy-ssh', label: 'a', kind: 'ssh', host: 'a.example.com', user: 'u', remotePort: 22 },
    { id: 'legacy-gw', label: 'b', kind: 'gateway', host: 'gw.example.com', remotePort: 443 },
    { id: 'no-kind', label: 'c', host: 'c.example.com', remotePort: 3080 },
    { id: 'no-transport', label: 'd', kind: 'gateway', host: 'd.example.com', remotePort: 8443 },
  ]))
  const manager = createTransportManager({
    provider: sshProvider,
    // v2 (design 17 §2.2): providers register BY TRANSPORT — mirrors the
    // main.ts assembly ({ ssh: sshProvider, http: gatewayProvider }).
    providers: { ssh: sshProvider, http: gatewayProvider },
    instancesFile: file,
    logger: silentLogger,
  })
  const instances = manager.loadInstances()
  const byId = new Map(instances.map(instance => [instance.id, instance]))
  // kind:'ssh' → { kind:'dsh', transport:'ssh' }; source-id legacy mapping
  // (ssh-<id>) is a control-plane concern, the registry carries the v2 kind.
  assert.equal(byId.get('legacy-ssh')?.kind, 'dsh')
  assert.equal(byId.get('legacy-ssh')?.transport, 'ssh')
  // kind:'gateway' → { kind:'gateway', transport:'http' } (v1 gateway = direct https).
  assert.equal(byId.get('legacy-gw')?.kind, 'gateway')
  assert.equal(byId.get('legacy-gw')?.transport, 'http')
  assert.equal(byId.get('legacy-gw')?.insecureHttp, false)
  // kind missing → default { kind:'dsh', transport:'ssh' }.
  assert.equal(byId.get('no-kind')?.kind, 'dsh')
  assert.equal(byId.get('no-kind')?.transport, 'ssh')
  // transport missing → inferred from kind (gateway→http).
  assert.equal(byId.get('no-transport')?.kind, 'gateway')
  assert.equal(byId.get('no-transport')?.transport, 'http')
  // The save path migrates identically (a legacy kind:'ssh' input normalizes).
  const saved = manager.saveInstances([
    { id: 'save-legacy', label: 'e', kind: 'ssh', host: 'e.example.com', remotePort: 22 },
  ])
  assert.equal(saved[0].kind, 'dsh')
  assert.equal(saved[0].transport, 'ssh')
  assert.equal(saved[0].insecureHttp, false)
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

test('saveInstances rejects duplicate ids atomically', () => {
  const dir = tempDir()
  const file = join(dir, 'ssh-instances.json')
  const manager = createTransportManager({ provider: sshProvider, instancesFile: file, logger: silentLogger })
  assert.throws(() => manager.saveInstances([
    { id: 's1', label: 'first', host: 'a.example.com', remotePort: 2222 },
    { id: 's1', label: 'second', host: 'b.example.com', remotePort: 2222 },
  ]), /duplicate instance id at index 1/)
  assert.deepEqual(manager.listInstances(), [])
  assert.equal(existsSync(file), false)
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

// Provider registration is transport-keyed; a provider that rejects a
// target kind must fail the whole save while corrupt persisted rows are
// dropped during recovery.
// Direct-endpoint mode was removed: every provider owns a local tunnel.
test('kind mismatches reject saves atomically while load-time recovery still drops them', () => {
  const dir = tempDir()
  const file = join(dir, 'ssh-instances.json')
  const manager = createTransportManager({ provider: fakeEnvProvider, instancesFile: file, logger: silentLogger })
  assert.throws(() => manager.saveInstances([
    { id: 'wrong', label: 'wrong kind', kind: 'fake-env' as unknown as TransportKind, host: 'h.example.com', remotePort: 22 },
    { id: 'right', label: 'right kind', kind: 'ssh', host: 'x.tailnet', remotePort: 8080 },
  ]), /instance at index 0 is invalid/)
  assert.deepEqual(manager.listInstances(), [])
  writeFileSync(file, JSON.stringify([
    { id: 'wrong-two', label: 'wrong kind', kind: 'fake-env', host: 'h.example.com', remotePort: 22 },
  ]))
  const reopened = createTransportManager({ provider: fakeEnvProvider, instancesFile: file, logger: silentLogger })
  assert.deepEqual(reopened.loadInstances().map(entry => entry.id), [])
})

test('desktop package includes the gateway provider required by main.ts', () => {
  const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
    build?: { files?: unknown[] }
  }
  assert.ok(Array.isArray(pkg.build?.files), 'electron-builder files list exists')
  assert.ok(pkg.build?.files?.includes('*.ts'), 'all production TypeScript providers ship in the packaged app')
  assert.ok(pkg.build?.files?.includes('!*.test.ts'), 'test-only TypeScript stays outside the packaged app')
  const preload = readFileSync(new URL('./preload.cts', import.meta.url), 'utf8')
  assert.match(preload, /set_gateway_token:\s*\(id, token\)\s*=>\s*ipcRenderer\.invoke\('desktop_gateway_set_token'/)
  assert.doesNotMatch(preload, /get_gateway_token|gateway_token_get/, 'renderer receives no token getter')
  const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8')
  assert.match(main, /providers:\s*\{\s*ssh: sshProvider,\s*http: gatewayProvider/, 'main.ts registers providers BY TRANSPORT (design 17 §2.2)')
  assert.match(main, /commitTransportCredentialUpdate\(sm, id, status => status\.transport === 'ssh'/, 'SSH password updates rebuild a live SSH transport')
  assert.match(main, /commitTransportCredentialUpdate\(sm, id, status => status\.kind === 'gateway'/, 'gateway token updates use the same live replacement transaction')
  assert.match(main, /desktop_ssh_set_password is clear-only/, 'legacy SSH credential IPC cannot bypass the main-owned save transaction')
  assert.match(main, /status\.kind === 'dsh' && status\.transport === 'ssh'/, 'the chamber host seed gate keys on dsh+ssh (v2)')
})

test('credential updates reconnect live transports and restore the old transport after a failed write', () => {
  const events: string[] = []
  let status: TransportStatusProjection | null = {
    kind: 'dsh', transport: 'ssh', insecureHttp: false, phase: 'ready', localPort: 1234, sshPort: 22, remotePort: 17500,
    retryAttempt: 0, requiresUserAction: false, serviceActive: null,
    remoteDshHome: null, logSummary: '',
  }
  // The ssh PASSWORD is an SSH-TRANSPORT credential (design 17 §2): only a
  // live ssh transport consumes it.
  const belongsToSsh = (projection: TransportStatusProjection) => projection.transport === 'ssh'
  const transport: Pick<TransportManager, 'status' | 'disconnect' | 'connect'> = {
    status: () => status,
    disconnect: () => {
      events.push('disconnect')
      status = status === null ? null : { ...status, phase: 'idle', localPort: null }
    },
    connect: () => {
      events.push('connect')
      status = status === null ? null : { ...status, phase: 'connecting', localPort: null }
      return status
    },
  }

  commitTransportCredentialUpdate(transport, 'host', belongsToSsh, () => { events.push('commit:new') })
  assert.deepEqual(events, ['disconnect', 'commit:new', 'connect'])

  events.length = 0
  status = status === null ? null : { ...status, phase: 'error', requiresUserAction: true }
  assert.throws(() => {
    commitTransportCredentialUpdate(transport, 'host', belongsToSsh, () => {
      events.push('commit:failed')
      throw new Error('disk full')
    })
  }, /disk full/)
  assert.deepEqual(events, ['disconnect', 'commit:failed', 'connect'], 'failed persistence restores the prior credential transport')

  events.length = 0
  // The instance was kind-switched to a gateway (transport 'http'): the ssh
  // credential update must never rebuild the replacement gateway transport.
  status = status === null ? null : { ...status, kind: 'gateway', transport: 'http', phase: 'ready' }
  commitTransportCredentialUpdate(transport, 'host', belongsToSsh, () => { events.push('clear-old-ssh') })
  assert.deepEqual(events, ['clear-old-ssh'], 'clearing the old kind secret never interrupts the replacement provider')
  // A GATEWAY-TARGET credential (the token) matches the live gateway
  // transport and rebuilds it (design 17 §2 — any transport).
  const belongsToGateway = (projection: TransportStatusProjection) => projection.kind === 'gateway'
  commitTransportCredentialUpdate(transport, 'host', belongsToGateway, () => { events.push('commit:token') })
  assert.deepEqual(events, ['clear-old-ssh', 'disconnect', 'commit:token', 'connect'], 'a gateway token update rebuilds a live gateway transport')
})

test('gateway identity HTTP classification keeps every 5xx transient', () => {
  for (const status of [500, 502, 503, 504, 599, 408, 425, 429]) {
    assert.equal(gatewayHttpFailureIsTerminal(status), false, `HTTP ${status} is retried`)
  }
  for (const status of [201, 204, 301, 400, 401, 403, 404, 409, 422]) {
    assert.equal(gatewayHttpFailureIsTerminal(status), true, `HTTP ${status} requires a config/auth fix`)
  }
})

test('gateway tokens stay outside registry projections and clear durably', t => {
  const token = 'write-only-secret-0123456789abcdef'
  const file = join(tempDir(t), 'gateway-tokens.json')
  const resolveGateway = (id: string) => gatewayProvider.validateSpec({
    id, label: 'Gateway', kind: 'gateway', host: 'gateway.example.com', remotePort: 443,
  })
  t.after(() => { configureGatewayTokenStore(null) })
  assert.equal(configureGatewayTokenStore(file, resolveGateway), null)
  setGatewayToken('never-owned-token', null)
  assert.equal(existsSync(file), false, 'clearing the other provider store is a disk no-op')
  setGatewayToken('gateway-one', token)
  assert.equal(getGatewayToken('gateway-one'), token)
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600)
  assert.equal(configureGatewayTokenStore(file, resolveGateway), null)
  assert.equal(getGatewayToken('gateway-one'), token, 'restart reloads the durable token')
  assert.throws(() => setGatewayToken('gateway-one', 'line-one\r\nline-two'), /visible ASCII/)
  assert.equal(getGatewayToken('gateway-one'), token, 'a rejected value never mutates the live store')
  const spec = gatewayProvider.validateSpec({
    id: 'gateway-one', label: 'Gateway', kind: 'gateway', host: 'gateway.example.com', remotePort: 443,
    token: 'must-not-enter-the-registry',
  })
  assert.ok(spec !== null)
  assert.equal(JSON.stringify(spec).includes('write-only-secret'), false)
  assert.equal(JSON.stringify(spec).includes('must-not-enter-the-registry'), false)

  setGatewayToken('gateway-one', null)
  assert.equal(getGatewayToken('gateway-one'), null)
  const persisted = JSON.parse(readFileSync(file, 'utf8')) as { tokens: Record<string, string> }
  assert.deepEqual(persisted.tokens, {})
})

test('a corrupt gateway-token file is preserved and never treated as a valid empty store', t => {
  const file = join(tempDir(t), 'gateway-tokens.json')
  t.after(() => { configureGatewayTokenStore(null) })
  writeFileSync(file, '{broken-token-json')
  const notice = configureGatewayTokenStore(file)
  assert.match(notice ?? '', /preserved/)
  assert.equal(existsSync(file), false)
  assert.equal(existsSync(`${file}.corrupt`), true)
  assert.equal(getGatewayToken('anything'), null)
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
      transport: 'fake',
      host: record.host,
      user: null,
      sshPort: null,
      remotePort: record.remotePort,
      serviceName: null,
      remoteDshHome: null,
      insecureHttp: false,
    }
  },
  // no buildStartArgs → direct endpoint mode
  probeTarget: spec => ({ host: 'fake.local', port: spec.remotePort }),
  endpointUrl: spec => `http://fake.local:${spec.remotePort}`,
  classifyStderr: line => ({ log: line, terminalAuth: false, enoent: false }),
  // no exec → exec returns an explicit unsupported error
}

function directKindProvider(kind: string, events: string[]): TransportProvider {
  return {
    kind,
    validateSpec(input: unknown): TransportInstanceSpec | null {
      if (input === null || typeof input !== 'object') return null
      const record = input as Record<string, unknown>
      if (record.kind !== kind || typeof record.id !== 'string' || typeof record.label !== 'string'
        || typeof record.host !== 'string' || typeof record.remotePort !== 'number') return null
      return {
        id: record.id,
        label: record.label,
        kind,
        transport: kind,
        host: record.host,
        user: null,
        sshPort: null,
        remotePort: record.remotePort,
        serviceName: null,
        remoteDshHome: null,
        insecureHttp: false,
      }
    },
    probeTarget: spec => ({ host: spec.host, port: spec.remotePort }),
    endpointUrl: spec => `https://${spec.host}:${spec.remotePort}`,
    classifyStderr: line => ({ log: line, terminalAuth: false, enoent: false }),
    disposeAuth: spec => { events.push(`dispose:${spec.kind}`) },
    exec: (spec, _action, deps) => {
      deps.setProjection(spec.id, 'serviceActive', true)
      const status = deps.projection(spec.id)
      return Promise.resolve(status === null ? { ok: false, error: 'missing projection' } : { ok: true, status })
    },
  }
}

test('kind switch unregisters and disposes the old provider before the replacement starts', async t => {
  const events: string[] = []
  const oldProvider = directKindProvider('old-kind', events)
  const newProvider = directKindProvider('new-kind', events)
  const manager = createTransportManager({
    provider: oldProvider,
    providers: { 'new-kind': newProvider },
    instancesFile: join(tempDir(t), 'instances.json'),
    logger: silentLogger,
    portProbe: async () => true,
    options: { readyTimeoutMs: 100, probeIntervalMs: 5 },
  })
  manager.saveInstances([{
    id: 'switch', label: 'switch', kind: 'old-kind', host: 'old.example.com', remotePort: 443,
  }])
  manager.onStatusChanged((_id, status) => { events.push(`status:${status.kind}:${status.phase}`) })
  manager.connect('switch')
  await waitFor(() => manager.status('switch')?.phase === 'ready', 3000, 'old provider ready')
  const oldExec = await manager.exec('switch', 'start')
  assert.equal(oldExec.ok, true)
  assert.equal(manager.status('switch')?.serviceActive, true)
  events.length = 0

  manager.saveInstances([{
    id: 'switch', label: 'switch', kind: 'new-kind', host: 'new.example.com', remotePort: 443,
  }])
  await waitFor(() => manager.status('switch')?.phase === 'ready', 3000, 'new provider ready')

  assert.deepEqual(events.slice(0, 3), [
    'dispose:old-kind',
    'status:old-kind:idle',
    'status:new-kind:connecting',
  ])
  assert.ok(events.includes('status:new-kind:ready'))
  assert.equal(manager.readyUrl('switch'), 'https://new.example.com:443')
  assert.equal(manager.status('switch')?.serviceActive, null, 'old provider projections do not cross the kind boundary')
})

test('resolveProvider prefers the TRANSPORT-keyed provider, then the legacy kind key, then the default (design 17 §2.2)', async t => {
  const dir = tempDir(t)
  const manager = createTransportManager({
    provider: sshProvider,
    // Design 17 §2.2 registration: providers keyed BY TRANSPORT (a gateway
    // http spec resolves this provider even though the kind key is absent).
    providers: { http: gatewayProvider },
    instancesFile: join(dir, 'instances.json'),
    logger: silentLogger,
    portProbe: async () => true,
    verifyProbe: async () => ({ ok: true }),
    options: { readyTimeoutMs: 100, probeIntervalMs: 5 },
  })
  // Gateway/http spec (v2 form): the transport key 'http' wins.
  manager.saveInstances([{ id: 'gw', label: 'gw', kind: 'gateway', transport: 'http', host: 'gw.example.com', remotePort: 443 }])
  assert.equal(manager.status('gw')!.transport, 'http')
  manager.connect('gw')
  await waitFor(() => manager.status('gw')?.phase === 'ready', 3000, 'transport-keyed provider ready')
  assert.equal(manager.readyUrl('gw'), 'https://gw.example.com')
  // An ssh/dsh spec: no 'ssh' key, no 'dsh' kind key → the default provider.
  manager.saveInstances([
    { id: 'gw', label: 'gw', kind: 'gateway', transport: 'http', host: 'gw.example.com', remotePort: 443 },
    { id: 's1', label: 's', kind: 'dsh', transport: 'ssh', host: 'h.example.com', remotePort: 3080 },
  ])
  assert.equal(manager.status('s1')!.kind, 'dsh')
  assert.equal(manager.status('s1')!.transport, 'ssh')
})

test('direct-endpoint provider: no child, probe-driven ready, endpoint URL, kind routing', async t => {
  const { manager, spawnCalls, setProbe } = makeManager(t, {
    provider: fakeEndpointProvider,
    includeDefault: false,
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
    includeDefault: false,
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
    provider: fakeEnvProvider,
    instances: [{ id: 'f3', label: 'noexec', kind: 'ssh', host: 'x.tailnet', remotePort: 8080 }],
  })
  const result = await manager.exec('f3', 'start')
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /not supported by transport kind dsh/)
  assert.equal(spawnCalls.length, 0)
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
  kind: 'ssh',
  validateSpec(input: unknown): TransportInstanceSpec | null {
    if (input === null || typeof input !== 'object') return null
    const record = input as Record<string, unknown>
    if (typeof record.id !== 'string' || typeof record.label !== 'string'
      || typeof record.host !== 'string' || typeof record.remotePort !== 'number') return null
    if (record.kind !== 'dsh' && record.kind !== 'ssh') return null
    if (record.transport !== 'ssh') return null
    return {
      id: record.id,
      label: record.label,
      kind: 'dsh',
      transport: 'ssh',
      host: record.host,
      user: null,
      sshPort: null,
      remotePort: record.remotePort,
      serviceName: null,
      remoteDshHome: null,
      insecureHttp: false,
    }
  },
  buildStartArgs: (spec, localPort) => ['-N', '-L', `${localPort}:127.0.0.1:${spec.remotePort}`, spec.host],
  buildStartEnv: spec => ({
    env: { SSH_ASKPASS: `/tmp/askpass-${spec.id}`, SSH_ASKPASS_REQUIRE: 'force' },
    release() {},
  }),
  classifyStderr: line => ({ log: line, terminalAuth: false, enoent: false }),
}

test('a provider buildStartEnv is merged over process.env for the transport spawn', async t => {
  const { manager, spawnCalls, setProbe } = makeManager(t, {
    provider: fakeEnvProvider,
    instances: [{ id: 'e1', label: 'envhost', kind: 'ssh', host: 'env.example.com', remotePort: 8080 }],
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

test('tunnel plus more than five concurrent execs retain askpass helpers until each child exits', async t => {
  configureSshPasswordStore(null)
  setSshPassword('s2', 'lease-password')
  const { manager, spawnCalls, children, setProbe } = makeManager(t, { instances: [EXEC_INSTANCE] })
  t.after(() => {
    manager.dispose()
    for (const child of children) {
      if (child.exitCode === null) child.simulateExit(143, 'SIGTERM')
    }
    setSshPassword('s2', null)
    purgeSshAuth('s2')
    configureSshPasswordStore(null)
  })

  setProbe(true)
  manager.connect('s2')
  await waitFor(() => manager.status('s2')!.phase === 'ready')
  assert.equal(spawnCalls.length, 1, 'the first password lease belongs to the tunnel')

  const execs = Array.from({ length: 6 }, () => manager.exec('s2', 'is-active'))
  assert.equal(spawnCalls.length, 7, 'six exec children coexist with the tunnel')
  const paths = spawnCalls.map(call => call.options.env?.SSH_ASKPASS)
  assert.ok(paths.every((path): path is string => typeof path === 'string'))
  assert.equal(new Set(paths).size, 7, 'every child receives its own fresh generation')
  assert.ok(paths.every(path => existsSync(path)), 'the old tunnel helper survives more than five newer exec generations')

  for (let i = 1; i < children.length; i += 1) {
    children[i].simulateExit(0)
    const result = await execs[i - 1]
    assert.equal(result.ok, true)
    assert.ok(!existsSync(paths[i]), `exec child ${i} removes its helper on exit`)
    assert.ok(existsSync(paths[0]), 'the still-live tunnel helper is never pruned by exec cleanup')
    assert.ok(paths.slice(i + 1).every(path => existsSync(path)), 'later live exec helpers remain available')
  }

  manager.disconnect('s2')
  assert.ok(existsSync(paths[0]), 'plain disconnect does not delete the SIGTERM-pending tunnel helper')
  manager.saveInstances(manager.listInstances().filter(instance => instance.id !== 's2'))
  assert.ok(existsSync(paths[0]), 'final instance removal/purge still honors the live tunnel lease')
  children[0].simulateExit(143, 'SIGTERM')
  assert.ok(!existsSync(paths[0]), 'the final child exit leaves no askpass residue')
})

test('disconnect gives an idle exec one bounded SIGKILL escalation and keeps its askpass lease until real exit', async t => {
  configureSshPasswordStore(null)
  setSshPassword('s2', 'lease-password')
  const { manager, spawnCalls } = makeManager(t, {
    instances: [EXEC_INSTANCE],
    options: { disconnectGraceMs: 20, execTimeoutMs: 2_000 },
  })
  t.after(() => {
    manager.dispose()
    setSshPassword('s2', null)
    purgeSshAuth('s2')
    configureSshPasswordStore(null)
  })

  const resultPromise = manager.exec('s2', 'start')
  assert.equal(spawnCalls.length, 1)
  const child = spawnCalls[0].child
  const helper = spawnCalls[0].options.env?.SSH_ASKPASS
  assert.equal(typeof helper, 'string')
  assert.ok(existsSync(helper as string))
  assert.equal(manager.status('s2')!.phase, 'idle')

  manager.disconnect('s2')
  // A repeated disconnect must not reset the grace deadline or arm a second
  // manager-owned escalation for the same still-live child.
  manager.disconnect('s2')
  assert.ok(child.killCalls.includes('SIGTERM'))
  await waitFor(() => child.killCalls.includes('SIGKILL'), 2_000, 'idle exec SIGKILL escalation')
  assert.equal(child.killCalls.filter(signal => signal === 'SIGKILL').length, 1, 'one non-renewable escalation per child')
  assert.ok(existsSync(helper as string), 'disconnect/SIGKILL request cannot release a helper before the child exits')

  child.simulateExit(null, 'SIGKILL')
  assert.equal((await resultPromise).ok, false)
  assert.ok(!existsSync(helper as string), 'the real exit releases the child-bound helper')
})

test('removed tunnel stays globally tracked through immediate disposeAsync until SIGKILL and real exit release askpass', async t => {
  configureSshPasswordStore(null)
  setSshPassword('s2', 'lease-password')
  const { manager, spawnCalls, setProbe } = makeManager(t, {
    instances: [EXEC_INSTANCE],
    options: { disconnectGraceMs: 20 },
  })
  t.after(() => {
    manager.dispose()
    setSshPassword('s2', null)
    purgeSshAuth('s2')
    configureSshPasswordStore(null)
  })

  setProbe(true)
  manager.connect('s2')
  await waitFor(() => manager.status('s2')!.phase === 'ready')
  const child = spawnCalls[0].child
  const helper = spawnCalls[0].options.env?.SSH_ASKPASS
  assert.equal(typeof helper, 'string')
  assert.ok(existsSync(helper as string))

  manager.saveInstances(manager.listInstances().filter(instance => instance.id !== 's2'))
  assert.equal(manager.status('s2'), null)
  assert.ok(child.killCalls.includes('SIGTERM'))
  let disposeSettled = false
  const disposePromise = manager.disposeAsync().then(() => { disposeSettled = true })
  await waitFor(() => child.killCalls.includes('SIGKILL'), 2_000, 'removed tunnel SIGKILL escalation')
  assert.equal(disposeSettled, false, 'deleted state cannot hide its still-live child from disposeAsync')
  assert.ok(existsSync(helper as string), 'helper remains leased until the removed child actually exits')

  child.simulateExit(null, 'SIGKILL')
  await disposePromise
  assert.equal(disposeSettled, true)
  assert.ok(!existsSync(helper as string), 'real child exit releases the removed generation helper')
})

test('a synchronous tunnel spawn failure releases its askpass lease', async t => {
  configureSshPasswordStore(null)
  setSshPassword('s2', 'lease-password')
  let helperPath: string | null = null
  const { manager } = makeManager(t, {
    instances: [EXEC_INSTANCE],
    spawnFn: (_command, _args, options) => {
      helperPath = typeof options.env?.SSH_ASKPASS === 'string' ? options.env.SSH_ASKPASS : null
      throw new Error('synthetic spawn failure')
    },
  })
  t.after(() => {
    manager.dispose()
    setSshPassword('s2', null)
    purgeSshAuth('s2')
    configureSshPasswordStore(null)
  })

  manager.connect('s2')
  await waitFor(() => manager.status('s2')!.phase === 'error')
  assert.ok(helperPath !== null, 'the helper existed when spawn was attempted')
  assert.ok(!existsSync(helperPath), 'the thrown spawn releases the helper immediately')
})

test('a synchronous tunnel spawn throw invokes provider lease release exactly once', async t => {
  let releases = 0
  const provider: TransportProvider = {
    ...fakeEnvProvider,
    buildStartEnv: () => ({
      env: { SSH_ASKPASS: '/tmp/fake-sync-throw-helper' },
      release: () => { releases += 1 },
    }),
  }
  const { manager } = makeManager(t, {
    provider,
    instances: [{ id: 'e-throw', label: 'env-throw', kind: 'dsh', transport: 'ssh', host: 'env-throw.example.com', remotePort: 8080 }],
    spawnFn: () => { throw new Error('synthetic spawn failure') },
  })
  manager.connect('e-throw')
  await waitFor(() => manager.status('e-throw')!.phase === 'error')
  assert.equal(releases, 1)
})

test('a tunnel child error releases its lease exactly once even if exit follows', async t => {
  let releases = 0
  const provider: TransportProvider = {
    ...fakeEnvProvider,
    buildStartEnv: () => ({
      env: { SSH_ASKPASS: '/tmp/fake-child-error-helper' },
      release: () => { releases += 1 },
    }),
  }
  const { manager, spawnCalls } = makeManager(t, {
    provider,
    instances: [{ id: 'e-error', label: 'env-error', kind: 'dsh', transport: 'ssh', host: 'env-error.example.com', remotePort: 8080 }],
    options: { disconnectGraceMs: 500 },
  })
  manager.connect('e-error')
  await waitFor(() => spawnCalls.length === 1)
  spawnCalls[0].child.simulateSpawnError(new Error('synthetic child error'))
  await waitFor(() => manager.status('e-error')!.phase === 'error')
  assert.equal(releases, 1, 'child error releases the provider lease')
  const disposedPromptly = await Promise.race([
    manager.disposeAsync().then(() => true),
    sleep(100).then(() => false),
  ])
  assert.equal(disposedPromptly, true, 'spawn error without exit clears global tunnel tracking immediately')
  spawnCalls[0].child.simulateExit(1)
  assert.equal(releases, 1, 'a following exit cannot double-release the lease')
})

test('a normal tunnel exit releases its lease exactly once even if an error follows', async t => {
  let releases = 0
  const provider: TransportProvider = {
    ...fakeEnvProvider,
    buildStartEnv: () => ({
      env: { SSH_ASKPASS: '/tmp/fake-child-exit-helper' },
      release: () => { releases += 1 },
    }),
  }
  const { manager, spawnCalls } = makeManager(t, {
    provider,
    instances: [{ id: 'e-exit', label: 'env-exit', kind: 'dsh', transport: 'ssh', host: 'env-exit.example.com', remotePort: 8080 }],
  })
  manager.connect('e-exit')
  await waitFor(() => spawnCalls.length === 1)
  manager.disconnect('e-exit')
  spawnCalls[0].child.simulateExit(143, 'SIGTERM')
  assert.equal(releases, 1, 'normal child exit releases the provider lease')
  spawnCalls[0].child.simulateSpawnError(new Error('late synthetic error'))
  assert.equal(releases, 1, 'a following error cannot double-release the lease')
})

test('a stale-epoch tunnel keeps its lease until the spawned child actually exits', async t => {
  let releases = 0
  let staleChild: FakeChild | null = null
  let runtime: TransportManager
  const provider: TransportProvider = {
    ...fakeEnvProvider,
    buildStartEnv: () => ({
      env: { SSH_ASKPASS: '/tmp/fake-stale-helper' },
      release: () => { releases += 1 },
    }),
  }
  const made = makeManager(t, {
    provider,
    instances: [{ id: 'e-stale', label: 'env-stale', kind: 'dsh', transport: 'ssh', host: 'env-stale.example.com', remotePort: 8080 }],
    spawnFn: () => {
      staleChild = new FakeChild()
      // Re-enter disconnect while doSpawn is in flight. startTransport sees
      // the stale epoch only after spawn returns and must retain the lease
      // through the SIGTERM-pending child's real lifetime.
      runtime.disconnect('e-stale')
      return staleChild
    },
  })
  runtime = made.manager
  runtime.connect('e-stale')
  await waitFor(() => staleChild !== null)
  assert.equal(runtime.status('e-stale')!.phase, 'idle')
  assert.ok(staleChild!.killCalls.includes('SIGTERM'))
  assert.equal(releases, 0, 'stale-epoch handling cannot release before child termination')
  staleChild!.simulateExit(143, 'SIGTERM')
  assert.equal(releases, 1)
})

test('disposeAuth is called when a live transport is disconnected', async t => {
  const disposed: string[] = []
  const provider: TransportProvider = {
    ...fakeEnvProvider,
    disposeAuth: spec => { disposed.push(spec.id) },
  }
  const { manager, setProbe } = makeManager(t, {
    provider,
    instances: [{ id: 'e2', label: 'envhost2', kind: 'ssh', host: 'env2.example.com', remotePort: 8080 }],
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
    instances: [{ id: 'e3', label: 'envhost3', kind: 'ssh', host: 'env3.example.com', remotePort: 8080 }],
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

test('dispose(): exec children get SIGTERM plus a SIGKILL escalation that disposeAsync WAITS for (M2)', async t => {
  const { manager, spawnCalls } = makeManager(t, { instances: [EXEC_INSTANCE] })
  const resultPromise = manager.exec('s2', 'start')
  assert.equal(spawnCalls.length, 1)
  const child = spawnCalls[0].child
  // The exec child never exits on its own (in-flight ssh exec at app quit).
  let disposeSettled = false
  const disposePromise = manager.disposeAsync().then(() => { disposeSettled = true })
  await waitFor(() => child.killCalls.includes('SIGTERM'), 2000, 'exec child SIGTERM')
  // The wait semantics are the point: disposeAsync must NOT settle before
  // the SIGKILL escalation fired (a no-wait regression would settle here).
  assert.equal(disposeSettled, false, 'disposeAsync must still be waiting after SIGTERM (M2 wait semantics)')
  await waitFor(() => child.killCalls.includes('SIGKILL'), 2000, 'exec child SIGKILL escalation')
  assert.equal(disposeSettled, false, 'SIGKILL request alone does not release the child-bound lifecycle')
  child.simulateExit(null, 'SIGKILL')
  await disposePromise
  assert.equal(disposeSettled, true)
  assert.equal((await resultPromise).ok, false)
})
