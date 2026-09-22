/**
 * Transport manager (design 03 §2.2, desktop main process) unit tests — part 1:
 * registry delta/password retirement, instances persistence, the ssh phase
 * machine (connecting → ready / error), option guards and stderr redaction.
 *
 * Sibling part: transport-connection-recovery.test.ts (load recovery, auth
 * failure, degraded/reconnect + backoff, identity verification, ring buffer,
 * disconnect). This file carries the provider exec channel + legacy registry
 * migration; the sibling carries provider routing/heartbeat/lease.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { attemptCommittedRegistryPush, computePasswordRetirementIds, computeRemovedInstanceIds, computeRetiredInstanceIds, createTransportManager } from '../../transport-manager.ts'
import { MAX_TRANSPORT_INSTANCES } from '../../transport-provider.ts'
import type { TransportInstanceInput, TransportInstanceSpec, TransportKind, TransportProvider } from '../../transport-provider.ts'
import { redactSshStderr, SERVER_ALIVE_COUNT_MAX, SERVER_ALIVE_INTERVAL_SECONDS, sshProvider } from '../../ssh-provider.ts'
import { gatewayProvider } from '../../gateway-provider.ts'
import { silentLogger, makeManager, tempDir, sleep, waitFor, EXEC_INSTANCE, fakeEnvProvider, type StatusWithNoUrlLeak } from '../support/transport-manager-harness.ts'
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
    userActionKind: null,
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

// ---------------------------------------------------------------------------
// Provider exec channel + legacy registry migration.
// The gateway credential/token assertions are covered by
// connection-save.test.ts:321-345 (live-transport replacement rollback),
// gateway-provider.test.ts:49-208 (token store + corrupt file), :774 (5xx
// transient) and ssh-provider-exec.test.ts:279-341 (write-file byte domain);
// the packaging/preload anchors by ipc-surface-mirror.test.ts:449-495 and
// scripts/after-pack-adhoc-sign.test.mjs:327.
// ---------------------------------------------------------------------------
test('exec: start/stop/is-active settle every systemctl exit class honestly', async t => {
  const { manager, spawnCalls } = makeManager(t, { instances: [EXEC_INSTANCE] })
  const startPromise = manager.exec('s2', 'start')
  assert.deepEqual(spawnCalls[0].args, ['bob@lab.example.com', 'systemctl', 'start', '--', 'dsh-chamber'])
  spawnCalls[0].child.simulateExit(0)
  const started = await startPromise
  assert.equal(started.ok, true)
  if (started.ok) {
    assert.equal(started.status.serviceActive, true)
    assert.equal(started.status.remotePort, 3080)
  }

  const stopPromise = manager.exec('s2', 'stop')
  assert.deepEqual(spawnCalls[1].args, ['bob@lab.example.com', 'systemctl', 'stop', '--', 'dsh-chamber'])
  spawnCalls[1].child.simulateExit(1)
  const stopped = await stopPromise
  assert.equal(stopped.ok, false, 'a non-zero stop is loud')
  if (!stopped.ok) assert.match(stopped.error, /failed/)

  const inactivePromise = manager.exec('s2', 'is-active')
  spawnCalls[2].child.simulateExit(3)
  const inactive = await inactivePromise
  assert.equal(inactive.ok, true, 'a non-zero is-active answer is a valid inactive answer')
  if (inactive.ok) assert.equal(inactive.status.serviceActive, false)

  const missingPromise = manager.exec('s2', 'is-active')
  spawnCalls[3].child.simulateExit(4)
  const missing = await missingPromise
  assert.equal(missing.ok, false, 'unit-not-found is an explicit error, never a mislabeled inactive')
  if (!missing.ok) assert.match(missing.error, /not found/)
  assert.equal(manager.status('s2')!.serviceActive, null, 'a failed probe resets the projection to unknown')

  const unreachablePromise = manager.exec('s2', 'is-active')
  spawnCalls[4].child.simulateExit(255)
  const unreachable = await unreachablePromise
  assert.equal(unreachable.ok, false, 'an unreachable host is never mislabeled inactive')
  if (!unreachable.ok) assert.match(unreachable.error, /could not reach/)
  assert.equal(manager.status('s2')!.serviceActive, null)
})

test('serviceName option-injection is refused atomically while a hyphenated unit passes', async t => {
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
  assert.deepEqual(spawnCalls[0].args, ['bob@lab.example.com', 'systemctl', 'start', '--', 'my-unit.service'])
  spawnCalls[0].child.simulateExit(0)
  assert.equal((await validPromise).ok, true)
})

test('exec: missing service, timeout and auth failure settle loudly without a new tunnel', async t => {
  const { manager, spawnCalls } = makeManager(t, { options: { execTimeoutMs: 20, disconnectGraceMs: 10 } })
  const noService = await manager.exec('s1', 'start')
  assert.equal(noService.ok, false)
  if (!noService.ok) assert.match(noService.error, /no systemd service/)
  assert.equal(spawnCalls.length, 0)

  const withService = makeManager(t, { instances: [EXEC_INSTANCE], options: { execTimeoutMs: 20, disconnectGraceMs: 10 } })
  const unknown = await withService.manager.exec('nope', 'start')
  assert.equal(unknown.ok, false)
  if (!unknown.ok) assert.match(unknown.error, /not found/)
  assert.equal(withService.spawnCalls.length, 0, 'an unknown instance never spawns')

  const timeoutPromise = withService.manager.exec('s2', 'start')
  const timedOut = await timeoutPromise
  assert.equal(timedOut.ok, false)
  if (!timedOut.ok) assert.match(timedOut.error, /timed out/)
  assert.ok(withService.spawnCalls[0].child.killCalls.includes('SIGTERM'))
  assert.ok(withService.manager.logs('s2').some(entry => entry.level === 'error' && /timed out/.test(entry.message)))

  // The auth phrase rides the final newline-less stderr line: it must be
  // flushed and classified before exit, and the exec failure must never touch
  // the tunnel's terminal classification.
  const authPromise = withService.manager.exec('s2', 'start')
  withService.spawnCalls[1].child.stderrWrite('Permission denied (publickey).')
  withService.spawnCalls[1].child.simulateExit(255)
  const auth = await authPromise
  assert.equal(auth.ok, false)
  if (!auth.ok) assert.match(auth.error, /authentication/)
  assert.equal(withService.manager.status('s2')!.requiresUserAction, false)
  assert.equal(withService.manager.status('s2')!.phase, 'idle')
})

test('exec run passes the payload through and refuses a whitelist-invalid argv before spawning', async t => {
  const { manager, spawnCalls } = makeManager(t, { instances: [EXEC_INSTANCE] })
  const resultPromise = manager.exec('s2', 'run', {
    op: 'exec',
    command: 'dsh',
    argv: ['plugin', '--profile', 'web', 'add', 'pkg@^1.0.0'],
  })
  assert.deepEqual(spawnCalls[0].args, ['bob@lab.example.com', 'dsh', 'plugin', '--profile', 'web', 'add', 'pkg@^1.0.0'])
  spawnCalls[0].child.stdout.emit('data', Buffer.from('packed'))
  spawnCalls[0].child.simulateExit(0)
  const result = await resultPromise
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.stdout, 'packed')
    assert.ok(result.stdoutBytes !== undefined && result.stdoutBytes.equals(Buffer.from('packed')), 'raw stdout bytes ride the result')
  }

  const refused = makeManager(t, { instances: [EXEC_INSTANCE] })
  const refusedResult = await refused.manager.exec('s2', 'run', {
    op: 'exec',
    command: 'dsh',
    argv: ['plugin', '--profile', 'web', 'add', 'name; rm -rf /'],
  })
  assert.equal(refusedResult.ok, false)
  if (!refusedResult.ok) assert.match(refusedResult.error, /whitelist/)
  assert.equal(refused.spawnCalls.length, 0, 'a whitelist refusal never spawns')
})

test('removing an instance cancels an in-flight exec and fences its late callbacks from a same-id reuse', async t => {
  const { manager, spawnCalls } = makeManager(t, { instances: [EXEC_INSTANCE] })
  const resultPromise = manager.exec('s2', 'start')
  const execChild = spawnCalls[0].child
  manager.saveInstances([])
  assert.ok(execChild.killCalls.includes('SIGTERM'), 'removal SIGTERMs the in-flight exec child')
  assert.equal(manager.status('s2'), null)
  manager.saveInstances([EXEC_INSTANCE])
  assert.equal(manager.status('s2')!.serviceActive, null, 'a same-id reuse starts from a clean projection')
  assert.deepEqual(manager.logs('s2'), [], 'a same-id reuse starts from a clean ring buffer')
  execChild.simulateExit(0)
  const result = await resultPromise
  assert.equal(result.ok, false, 'the stale caller is explicitly superseded')
  if (!result.ok) assert.match(result.error, /superseded/)
  assert.equal(manager.status('s2')!.serviceActive, null, 'late setProjection never pollutes the reused instance')
  assert.equal(manager.logs('s2').some(entry => /systemctl start/.test(entry.message)), false, 'late exec logs never reach the reused instance')
})

test('an idle-phase exec is torn down before a same-id retarget and cannot pollute the replacement', async t => {
  const { manager, spawnCalls } = makeManager(t, { instances: [EXEC_INSTANCE] })
  const resultPromise = manager.exec('s2', 'start')
  assert.equal(manager.status('s2')!.phase, 'idle', 'exec does not imply a connected tunnel phase')
  const oldChild = spawnCalls[0].child
  manager.saveInstances([{ ...EXEC_INSTANCE, host: 'replacement.example.com' }])
  assert.ok(oldChild.killCalls.includes('SIGTERM'), 'retarget tears down the old exec even while idle')
  assert.equal(spawnCalls.length, 1, 'an exec-only generation does not auto-connect the replacement')
  oldChild.simulateExit(0)
  const result = await resultPromise
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /superseded/)
  assert.equal(manager.status('s2')!.serviceActive, null, 'late projection is generation-guarded')
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
  assert.equal(manager.status('s2')!.serviceActive, null, 'the old service callback cannot restore the reset projection')
  assert.equal(manager.logs('s2').some(entry => entry.message === 'stale service callback'), false)
})

test('legacy v1 rows migrate to the v2 kind/transport contract on load and save', () => {
  const dir = tempDir()
  const file = join(dir, 'ssh-instances.json')
  writeFileSync(file, JSON.stringify([
    { id: 'legacy-ssh', label: 'a', kind: 'ssh', host: 'a.example.com', user: 'u', remotePort: 22 },
    { id: 'legacy-gw', label: 'b', kind: 'gateway', host: 'gw.example.com', remotePort: 443 },
    { id: 'no-kind', label: 'c', host: 'c.example.com', remotePort: 3080 },
    { id: 'no-transport', label: 'd', kind: 'gateway', host: 'd.example.com', remotePort: 8443 },
  ]))
  const manager = createTransportManager({
    provider: sshProvider, providers: { ssh: sshProvider, http: gatewayProvider }, instancesFile: file, logger: silentLogger,
  })
  const byId = new Map(manager.loadInstances().map(instance => [instance.id, instance]))
  assert.equal(byId.get('legacy-ssh')?.kind, 'dsh')
  assert.equal(byId.get('legacy-ssh')?.transport, 'ssh')
  assert.equal(byId.get('legacy-gw')?.kind, 'gateway')
  assert.equal(byId.get('legacy-gw')?.transport, 'http')
  assert.equal(byId.get('legacy-gw')?.insecureHttp, false)
  assert.equal(byId.get('no-kind')?.kind, 'dsh')
  assert.equal(byId.get('no-kind')?.transport, 'ssh')
  assert.equal(byId.get('no-kind')?.serviceName, null, 'missing serviceName/sshPort migrate to null')
  assert.equal(byId.get('no-kind')?.sshPort, null)
  assert.equal(byId.get('no-transport')?.transport, 'http', 'transport missing is inferred from the kind')
  const saved = manager.saveInstances([
    { id: 'save-legacy', label: 'e', kind: 'ssh', host: 'e.example.com', remotePort: 22 },
  ])
  assert.equal(saved[0].kind, 'dsh')
  assert.equal(saved[0].transport, 'ssh')
  assert.equal(saved[0].insecureHttp, false)
})

test('duplicate ids reject the save atomically, load keeps the first row, and kind mismatch rejects', () => {
  const dir = tempDir()
  const file = join(dir, 'ssh-instances.json')
  const manager = createTransportManager({ provider: sshProvider, instancesFile: file, logger: silentLogger })
  assert.throws(() => manager.saveInstances([
    { id: 's1', label: 'first', host: 'a.example.com', remotePort: 2222 },
    { id: 's1', label: 'second', host: 'b.example.com', remotePort: 2222 },
  ]), /duplicate instance id at index 1/)
  assert.deepEqual(manager.listInstances(), [])
  assert.equal(existsSync(file), false, 'a rejected save never writes the registry file')

  writeFileSync(file, JSON.stringify([
    { id: 's1', label: 'first', host: 'a.example.com', remotePort: 2222 },
    { id: 's1', label: 'second', host: 'b.example.com', remotePort: 2222 },
  ]))
  const reopened = createTransportManager({ provider: sshProvider, instancesFile: file, logger: silentLogger })
  const rows = reopened.loadInstances()
  assert.equal(rows.length, 1, 'persisted duplicates are dropped loudly, first wins')
  assert.equal(rows[0].label, 'first')

  const strict = createTransportManager({ provider: fakeEnvProvider, instancesFile: file, logger: silentLogger })
  assert.throws(() => strict.saveInstances([
    { id: 'wrong', label: 'wrong kind', kind: 'fake-env' as unknown as TransportKind, host: 'h.example.com', remotePort: 22 },
  ]), /instance at index 0 is invalid/)
})

test('a terminal auth phrase on the final newline-less stderr line is flushed before exit (tunnel)', async t => {
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

test("a replaced child's late spawn error never failTerminals the fresh transport", async t => {
  const { manager, children, spawnCalls, setProbe } = makeManager(t)
  setProbe(true)
  manager.connect('s1')
  await waitFor(() => manager.status('s1')!.phase === 'ready')
  setProbe(false)
  children[0].simulateExit(0)
  await waitFor(() => spawnCalls.length === 2, 3000, 'retry spawn')
  children[0].simulateSpawnError(new Error('spawn ssh ENOENT'))
  await sleep(60)
  assert.notEqual(manager.status('s1')!.phase, 'error', 'a stale spawn error never failTerminals the fresh attempt')
  setProbe(true)
  await waitFor(() => manager.status('s1')!.phase === 'ready', 3000, 'fresh transport ready')
})
