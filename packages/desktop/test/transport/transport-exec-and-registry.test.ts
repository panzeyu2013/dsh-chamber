/**
 * Transport manager — part 3: the provider exec channel (start/stop/is-active,
 * serviceName whitelist, timeouts, service-identity fences, write-file),
 * legacy kind/transport migration, duplicate-id recovery and the gateway
 * credential-reconnect path.
 *
 * Sibling parts: transport-manager.test.ts, transport-connection-recovery.test.ts,
 * transport-providers.test.ts.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { commitTransportCredentialUpdate, createTransportManager } from '../../transport-manager.ts'
import type { TransportManager } from '../../transport-manager.ts'
import type { TransportKind, TransportProvider, TransportStatusProjection } from '../../transport-provider.ts'
import { sshProvider } from '../../ssh-provider.ts'
import {
  configureGatewayTokenStore,
  gatewayHttpFailureIsTerminal,
  gatewayProvider,
  getGatewayToken,
  setGatewayToken,
} from '../../gateway-provider.ts'
import { silentLogger, makeManager, tempDir, sleep, waitFor, fakeEnvProvider, EXEC_INSTANCE } from '../support/transport-manager-harness.ts'
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
  const { manager, children, setProbe } = makeManager(t, { options: { disconnectGraceMs: 60 } })
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
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
    build?: { files?: unknown[] }
  }
  assert.ok(Array.isArray(pkg.build?.files), 'electron-builder files list exists')
  assert.ok(pkg.build?.files?.includes('*.ts'), 'all production TypeScript providers ship in the packaged app')
  assert.ok(pkg.build?.files?.includes('!*.test.ts'), 'test-only TypeScript stays outside the packaged app')
  const preload = readFileSync(new URL('../../preload.cts', import.meta.url), 'utf8')
  assert.match(preload, /set_gateway_token:\s*\(id, token\)\s*=>\s*ipcRenderer\.invoke\('desktop_gateway_set_token'/)
  assert.doesNotMatch(preload, /get_gateway_token|gateway_token_get/, 'renderer receives no token getter')
  const main = readFileSync(new URL('../../main.ts', import.meta.url), 'utf8')
  // W-10 S3: SSH_SET_PASSWORD / GATEWAY_SET_TOKEN / GATEWAY_SET_PASSWORD 三个
  // clear-only 注册体（commitTransportCredentialUpdate 实时重建 + clear-only
  // 拒写文案）随 C 组迁入 shell-core installIpcHandlers——三条文本锚的读取源
  // 指向 shell-core.ts，断言意图与正则原样保留。
  // 2026-12 stage-3 域拆分：C 组凭据注册体迁入 shell-ipc-connections.ts——读取源
  // 取两文件并集，文本锚/断言意图不变。
  const core = readFileSync(new URL('../../shell-core.ts', import.meta.url), 'utf8')
    + readFileSync(new URL('../../shell-ipc-connections.ts', import.meta.url), 'utf8')
  assert.match(main, /providers:\s*\{\s*ssh: sshProvider,\s*http: gatewayProvider/, 'main.ts registers providers BY TRANSPORT (design 17 §2.2)')
  assert.match(core, /commitTransportCredentialUpdate\(sm, id, status => status\.transport === 'ssh'/, 'SSH password updates rebuild a live SSH transport')
  assert.match(core, /commitTransportCredentialUpdate\(sm, id, status => status\.kind === 'gateway'/, 'gateway token updates use the same live replacement transaction')
  assert.match(core, /desktop_ssh_set_password is clear-only/, 'legacy SSH credential IPC cannot bypass the main-owned save transaction')
  assert.match(main, /status\.kind === 'dsh' && status\.transport === 'ssh'/, 'the chamber host seed gate keys on dsh+ssh (v2)')
})
test('credential updates reconnect live transports and restore the old transport after a failed write', () => {
  const events: string[] = []
  let status: TransportStatusProjection | null = {
    kind: 'dsh', transport: 'ssh', insecureHttp: false, phase: 'ready', localPort: 1234, sshPort: 22, remotePort: 17500,
    retryAttempt: 0, requiresUserAction: false, userActionKind: null, serviceActive: null,
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