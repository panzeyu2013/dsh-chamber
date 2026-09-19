/**
 * Transport manager — part 4: provider kind routing, the process-less
 * direct-endpoint provider (probe-driven ready / degraded), askpass-lease and
 * child-disposal lifecycle, buildStartEnv injection and the ready-state
 * heartbeat / reverify surface.
 *
 * Sibling parts: transport-manager, transport-connection-recovery,
 * transport-exec-and-registry (harness: test/support).
 */

import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createTransportManager } from '../../transport-manager.ts'
import type { TransportManager } from '../../transport-manager.ts'
import type { TransportInstanceSpec, TransportProvider, TransportVerifyResult } from '../../transport-provider.ts'
import { configureSshPasswordStore, purgeSshAuth, setSshPassword, sshProvider } from '../../ssh-provider.ts'
import { gatewayProvider } from '../../gateway-provider.ts'
import { silentLogger, FakeChild, makeManager, tempDir, sleep, waitFor, fakeEnvProvider, EXEC_INSTANCE, type StatusWithNoUrlLeak } from '../support/transport-manager-harness.ts'

/** The shared spec projection of the two direct-endpoint providers. */
function directSpec(record: Record<string, unknown>, kind: string, transport: string): TransportInstanceSpec {
  return {
    id: record.id as string, label: record.label as string, kind, transport, host: record.host as string,
    user: null, sshPort: null, remotePort: record.remotePort as number, serviceName: null, remoteDshHome: null, insecureHttp: false,
  }
}

/** A fakeEnvProvider that counts buildStartEnv lease releases for one helper. */
function leaseProvider(helper: string) {
  const state = { releases: 0 }
  const provider: TransportProvider = {
    ...fakeEnvProvider,
    buildStartEnv: () => ({ env: { SSH_ASKPASS: helper }, release: () => { state.releases += 1 } }),
  }
  return { provider, releases: () => state.releases }
}

/** Purge the s2 askpass password and dispose the manager on teardown. */
function sshPasswordTeardown(t: TestContext, manager: TransportManager) {
  t.after(() => {
    manager.dispose()
    setSshPassword('s2', null)
    purgeSshAuth('s2')
    configureSshPasswordStore(null)
  })
}

/** Lease the s2 askpass password (before the first spawn) plus teardown. */
function sshPasswordLease(t: TestContext, manager: TransportManager) {
  configureSshPasswordStore(null)
  setSshPassword('s2', 'lease-password')
  sshPasswordTeardown(t, manager)
}

/** makeManager + connect the given instance to ready. */
async function readyOn(t: TestContext, id: string, overrides: Parameters<typeof makeManager>[1] = {}) {
  const harness = makeManager(t, overrides)
  harness.setProbe(true)
  harness.manager.connect(id)
  await waitFor(() => harness.manager.status(id)!.phase === 'ready')
  return harness
}

/** A process-less DIRECT ENDPOINT provider: the abstraction proof. */
const fakeEndpointProvider: TransportProvider = {
  kind: 'fake',
  validateSpec(input: unknown): TransportInstanceSpec | null {
    if (input === null || typeof input !== 'object') return null
    const record = input as Record<string, unknown>
    if (typeof record.id !== 'string' || typeof record.label !== 'string'
      || typeof record.host !== 'string' || typeof record.remotePort !== 'number') return null
    if (record.kind !== undefined && record.kind !== null && record.kind !== 'fake') return null
    return directSpec(record, 'fake', 'fake')
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
      return directSpec(record, kind, kind)
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
  const { manager, children, spawnCalls, setProbe } = await readyOn(t, 's1', { options: { disconnectGraceMs: 60 } })
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

test('a provider buildStartEnv is merged over process.env for the transport spawn', async t => {
  const { spawnCalls } = await readyOn(t, 'e1', {
    provider: fakeEnvProvider, instances: [{ id: 'e1', label: 'envhost', kind: 'ssh', host: 'env.example.com', remotePort: 8080 }],
  })
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
  const { manager, spawnCalls } = makeManager(t, { instances: [EXEC_INSTANCE], options: { disconnectGraceMs: 20, execTimeoutMs: 2_000 } })
  sshPasswordLease(t, manager)
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
  const { manager, spawnCalls } = await readyOn(t, 's2', { instances: [EXEC_INSTANCE], options: { disconnectGraceMs: 20 } })
  sshPasswordTeardown(t, manager)
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
  let helperPath: string | null = null
  const { manager } = makeManager(t, {
    instances: [EXEC_INSTANCE],
    spawnFn: (_command, _args, options) => {
      helperPath = typeof options.env?.SSH_ASKPASS === 'string' ? options.env.SSH_ASKPASS : null
      throw new Error('synthetic spawn failure')
    },
  })
  sshPasswordLease(t, manager)
  manager.connect('s2')
  await waitFor(() => manager.status('s2')!.phase === 'error')
  assert.ok(helperPath !== null, 'the helper existed when spawn was attempted')
  assert.ok(!existsSync(helperPath), 'the thrown spawn releases the helper immediately')
})
test('a synchronous tunnel spawn throw invokes provider lease release exactly once', async t => {
  const { provider, releases } = leaseProvider('/tmp/fake-sync-throw-helper')
  const { manager } = makeManager(t, {
    provider,
    instances: [{ id: 'e-throw', label: 'env-throw', kind: 'dsh', transport: 'ssh', host: 'env-throw.example.com', remotePort: 8080 }],
    spawnFn: () => { throw new Error('synthetic spawn failure') },
  })
  manager.connect('e-throw')
  await waitFor(() => manager.status('e-throw')!.phase === 'error')
  assert.equal(releases(), 1)
})
test('a tunnel child error releases its lease exactly once even if exit follows', async t => {
  const { provider, releases } = leaseProvider('/tmp/fake-child-error-helper')
  const { manager, spawnCalls } = makeManager(t, {
    provider,
    instances: [{ id: 'e-error', label: 'env-error', kind: 'dsh', transport: 'ssh', host: 'env-error.example.com', remotePort: 8080 }],
    options: { disconnectGraceMs: 500 },
  })
  manager.connect('e-error')
  await waitFor(() => spawnCalls.length === 1)
  spawnCalls[0].child.simulateSpawnError(new Error('synthetic child error'))
  await waitFor(() => manager.status('e-error')!.phase === 'error')
  assert.equal(releases(), 1, 'child error releases the provider lease')
  const disposedPromptly = await Promise.race([
    manager.disposeAsync().then(() => true),
    sleep(100).then(() => false),
  ])
  assert.equal(disposedPromptly, true, 'spawn error without exit clears global tunnel tracking immediately')
  spawnCalls[0].child.simulateExit(1)
  assert.equal(releases(), 1, 'a following exit cannot double-release the lease')
})
test('a normal tunnel exit releases its lease exactly once even if an error follows', async t => {
  const { provider, releases } = leaseProvider('/tmp/fake-child-exit-helper')
  const { manager, spawnCalls } = makeManager(t, {
    provider,
    instances: [{ id: 'e-exit', label: 'env-exit', kind: 'dsh', transport: 'ssh', host: 'env-exit.example.com', remotePort: 8080 }],
  })
  manager.connect('e-exit')
  await waitFor(() => spawnCalls.length === 1)
  manager.disconnect('e-exit')
  spawnCalls[0].child.simulateExit(143, 'SIGTERM')
  assert.equal(releases(), 1, 'normal child exit releases the provider lease')
  spawnCalls[0].child.simulateSpawnError(new Error('late synthetic error'))
  assert.equal(releases(), 1, 'a following error cannot double-release the lease')
})
test('a stale-epoch tunnel keeps its lease until the spawned child actually exits', async t => {
  const { provider, releases } = leaseProvider('/tmp/fake-stale-helper')
  let staleChild: FakeChild | null = null
  let runtime: TransportManager
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
  assert.equal(releases(), 0, 'stale-epoch handling cannot release before child termination')
  staleChild!.simulateExit(143, 'SIGTERM')
  assert.equal(releases(), 1)
})
test('disposeAuth is called when a live transport is disconnected', async t => {
  const disposed: string[] = []
  const provider: TransportProvider = {
    ...fakeEnvProvider,
    disposeAuth: spec => { disposed.push(spec.id) },
  }
  const { manager } = await readyOn(t, 'e2', { provider, instances: [{ id: 'e2', label: 'envhost2', kind: 'ssh', host: 'env2.example.com', remotePort: 8080 }] })
  manager.disconnect('e2')
  assert.deepEqual(disposed, ['e2'])
})
test('a throwing provider buildStartEnv lands on a loud error, never a stuck connecting', async t => {
  const provider: TransportProvider = {
    ...fakeEnvProvider,
    buildStartEnv: () => { throw new Error('env boom') },
  }
  const { manager, spawnCalls } = makeManager(t, { provider, instances: [{ id: 'e3', label: 'envhost3', kind: 'ssh', host: 'env3.example.com', remotePort: 8080 }] })
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
test('ready-state heartbeat: a terminal verification failure while ready lands error:requires_user_action with no auto-retry', async t => {
  let outcome: TransportVerifyResult = { ok: true }
  const { manager, spawnCalls } = await readyOn(t, 's1', {
    options: { readyVerifyIntervalMs: 20, readyVerifyMinIntervalMs: 5 }, verifyProbe: async () => outcome,
  })
  // A dead gateway session (remote password change): the probe 401 is
  // terminal — the machine must leave ready within one heartbeat tick.
  outcome = { ok: false, terminal: true, detail: 'the gateway rejected the password authentication (401) — re-enter the password' }
  await waitFor(() => manager.status('s1')!.phase === 'error', 3000, 'heartbeat terminal error')
  const status = manager.status('s1')!
  assert.equal(status.requiresUserAction, true)
  assert.equal(status.userActionKind, 'endpoint')
  assert.match(status.logSummary, /re-enter the password/)
  // Terminal failures never auto-retry: no new transport attempt appears.
  await sleep(80)
  assert.equal(manager.status('s1')!.phase, 'error')
  assert.equal(spawnCalls.length, 1)
})
test('ready-state heartbeat: a transient verification failure reconnects through degraded and recovers on its own', async t => {
  let outcome: TransportVerifyResult = { ok: true }
  const { manager } = await readyOn(t, 's1', {
    options: { readyVerifyIntervalMs: 15, readyVerifyMinIntervalMs: 5, readyTimeoutMs: 50, retryBaseMs: 10, retryMaxMs: 20, maxRetryAttempts: 3 },
    verifyProbe: async () => outcome,
  })
  // A transient probe failure (remote restart window) takes the bounded
  // reconnect path — degraded first, then a fresh attempt.
  outcome = { ok: false, detail: 'connection reset' }
  await waitFor(() => manager.status('s1')!.phase === 'degraded', 3000, 'degraded after transient heartbeat failure')
  outcome = { ok: true }
  await waitFor(() => manager.status('s1')!.phase === 'ready', 3000, 'recovered ready')
  assert.equal(manager.status('s1')!.retryAttempt, 0)
})
test('reverify(): on-demand probe runs once, is quiet-windowed, and is a no-op while not ready', async t => {
  let verifyCalls = 0
  const { manager } = await readyOn(t, 's1', {
    // Heartbeat far away (the on-demand quiet window is the tested gate).
    options: { readyVerifyIntervalMs: 60_000, readyVerifyMinIntervalMs: 5_000 },
    verifyProbe: async () => { verifyCalls += 1; return { ok: true } },
  })
  const atReady = verifyCalls // the connect-time verification
  manager.reverify('s1')
  await sleep(30)
  assert.equal(verifyCalls, atReady + 1, 'on-demand reverify runs one probe')
  // Quiet window: a second immediate reverify must not pile another probe.
  manager.reverify('s1')
  await sleep(30)
  assert.equal(verifyCalls, atReady + 1, 'quiet window suppresses repeat on-demand probes')
  // Not ready (manual disconnect): reverify is a no-op.
  manager.disconnect('s1')
  await waitFor(() => manager.status('s1')!.phase === 'idle', 3000, 'idle')
  const before = verifyCalls
  manager.reverify('s1')
  await sleep(30)
  assert.equal(verifyCalls, before, 'reverify is a no-op while not ready')
})
test('leaving ready cancels the ready-state heartbeat', async t => {
  let verifyCalls = 0
  const { manager } = await readyOn(t, 's1', {
    options: { readyVerifyIntervalMs: 30, readyVerifyMinIntervalMs: 5 },
    verifyProbe: async () => { verifyCalls += 1; return { ok: true } },
  })
  manager.disconnect('s1')
  await waitFor(() => manager.status('s1')!.phase === 'idle', 3000, 'idle')
  const atIdle = verifyCalls
  await sleep(120)
  assert.equal(verifyCalls, atIdle, 'no heartbeat probes fire after leaving ready')
})
test('onVerified fires after every successful ready-state re-verification, never on failures', async t => {
  let outcome: TransportVerifyResult = { ok: true }
  const verified: string[] = []
  const { manager, setProbe } = makeManager(t, {
    options: {
      readyVerifyIntervalMs: 15, readyVerifyMinIntervalMs: 5, readyTimeoutMs: 50,
      retryBaseMs: 10, retryMaxMs: 20, maxRetryAttempts: 3, slowRetryMs: 30,
    },
    verifyProbe: async () => outcome,
  })
  setProbe(true)
  manager.onVerified(id => { verified.push(id) })
  manager.connect('s1')
  await waitFor(() => manager.status('s1')!.phase === 'ready', 3000, 'ready')
  // The periodic heartbeat succeeds → onVerified fires.
  await waitFor(() => verified.length >= 1, 3000, 'onVerified after heartbeat success')
  const afterSuccess = verified.length
  // A transient failure (reconnect path) must never emit onVerified.
  outcome = { ok: false, detail: 'connection reset' }
  await waitFor(() => manager.status('s1')!.phase === 'degraded', 3000, 'degraded')
  outcome = { ok: true }
  // The machine recovers through its own reconnect; the next successful
  // heartbeat fires again — count grows only on successes.
  await waitFor(() => manager.status('s1')!.phase === 'ready', 3000, 'recovered')
  await waitFor(() => verified.length > afterSuccess, 3000, 'onVerified after recovery heartbeat')
})
test('a user reverify overlapping the periodic tick does not kill the heartbeat chain (single-flight collision)', async t => {
  let outcome: TransportVerifyResult = { ok: true }
  let hold = false
  // Object holder (not a bare let): property narrowing across the closure
  // boundary keeps the release call type-safe for the strict checker.
  const gate = { release: null as (() => void) | null }
  let verifyCalls = 0
  const { manager, setProbe } = makeManager(t, {
    options: { readyVerifyIntervalMs: 25, readyVerifyMinIntervalMs: 5 },
    verifyProbe: async () => {
      verifyCalls += 1
      if (hold) await new Promise<void>(resolve => { gate.release = resolve })
      return outcome
    },
  })
  setProbe(true)
  manager.connect('s1')
  await waitFor(() => manager.status('s1')!.phase === 'ready', 3000, 'ready')
  // Start a user reverify and HOLD its probe in flight across the next
  // periodic tick: the tick is eaten by single-flight and (without the
  // chain-continuation fix) nothing ever re-arms the heartbeat.
  hold = true
  manager.reverify('s1')
  await waitFor(() => gate.release !== null, 1000, 'user probe held in flight')
  const heldCalls = verifyCalls
  await sleep(80) // comfortably past one readyVerifyIntervalMs tick
  assert.equal(verifyCalls, heldCalls, 'the periodic tick was eaten by the in-flight user probe')
  // Release the user probe successfully.
  outcome = { ok: true }
  hold = false
  gate.release!()
  gate.release = null
  // The chain must continue: the next periodic probe fires on its own.
  await waitFor(() => verifyCalls > heldCalls, 3000, 'heartbeat chain continues after the collision')
  assert.equal(manager.status('s1')!.phase, 'ready')
})
