/**
 * Transport manager — part 2: load recovery, auth-failure terminality, degraded
 * → reconnect with jittered backoff, real dsh identity verification through the
 * tunnel, ring-buffer bounds, disconnect, provider routing / askpass-lease /
 * ready-heartbeat and the reconnectStaleTransports leaf. Sibling part:
 * transport-manager (harness: test/support).
 */

import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SpawnOptions } from 'node:child_process'
import { createTransportManager, jitteredBackoffMs, RING_BUFFER_LIMIT, RING_LOG_MESSAGE_MAX_CHARS } from '../../transport-manager.ts'
import { CHAMBER_HOST_PACKAGES } from '../../control-plane-module.ts'
import { CHILD_LINE_MAX_CHARS } from '../../bounded-lines.ts'
import { configureSshPasswordStore, probeChamberHostLive, purgeSshAuth, setSshPassword, sshProvider, verifyDshEndpoint } from '../../ssh-provider.ts'
import type { TransportInstanceInput, TransportInstanceSpec, TransportKind, TransportProvider, TransportVerifyResult } from '../../transport-provider.ts'
import { gatewayProvider } from '../../gateway-provider.ts'
import { reconnectStaleTransports } from '../../transport-reconnect.ts'
import { silentLogger, FakeChild, fakeEnvProvider, makeManager, tempDir, sleep, waitFor, readyThenDrop, EXEC_INSTANCE, type StatusWithNoUrlLeak, type ManagerHarness } from '../support/transport-manager-harness.ts'

/** Bind an ephemeral 127.0.0.1 server for one test and return its port. */
async function listen(t: TestContext, handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.close() })
  return (server.address() as AddressInfo).port
}

function readBody(req: IncomingMessage, reply: (body: string) => void) {
  let body = ''
  req.on('data', chunk => { body += String(chunk) })
  req.on('end', () => reply(body))
}

function jsonReply(res: ServerResponse, envelope: unknown) {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(envelope))
}

/** makeManager + pre-ready connect + first spawn wait. */
async function noProbeManager(t: TestContext, overrides: Parameters<typeof makeManager>[1] = {}) {
  const harness = makeManager(t, overrides)
  harness.setProbe(false)
  harness.manager.connect('s1')
  await waitFor(() => harness.spawnCalls.length === 1)
  return harness
}

/** makeManager + s1 connected to ready. */
async function readyManager(t: TestContext, overrides: Parameters<typeof makeManager>[1] = {}) {
  const harness = makeManager(t, overrides)
  harness.setProbe(true)
  harness.manager.connect('s1')
  await waitFor(() => harness.manager.status('s1')!.phase === 'ready')
  return harness
}

/** Exhaust the fast burst: every pre-ready exit until the terminal error. */
async function exhaustBurst(harness: Pick<ManagerHarness, 'manager' | 'children' | 'spawnCalls'>, maxRetryAttempts: number) {
  for (let attempt = 0; attempt <= maxRetryAttempts; attempt += 1) {
    await waitFor(() => harness.spawnCalls.length === attempt + 1, 3000, `spawn ${attempt + 1}`)
    harness.children[attempt].simulateExit(1)
    const phase = attempt === maxRetryAttempts ? 'error' : 'degraded'
    const what = attempt === maxRetryAttempts ? 'error after the last retry' : `degraded after attempt ${attempt + 1}`
    await waitFor(() => harness.manager.status('s1')!.phase === phase, 3000, what)
  }
}

/** A manager whose allocated local port IS the given identity server. */
function managerOn(dir: string, port: number) {
  return createTransportManager({
    provider: sshProvider, spawnFn: () => new FakeChild(), instancesFile: join(dir, 'ssh-instances.json'),
    logger: silentLogger, portProbe: async () => true, allocatePort: async () => port,
    options: { readyTimeoutMs: 100, probeIntervalMs: 5, retryBaseMs: 10, retryMaxMs: 40, maxRetryAttempts: 3 },
  })
}
/** kind+transport are required inputs since the pre-v2 normalization was
 *  removed; the fixtures in this file are local-dsh-over-ssh. */
function saveCompleted(
  manager: ReturnType<typeof createTransportManager>,
  inputs: TransportInstanceInput[],
): TransportInstanceSpec[] {
  return manager.saveInstances(inputs.map(input => ({
    ...input,
    ...(input.kind === undefined ? { kind: 'dsh' as TransportKind } : {}),
    ...(input.transport === undefined ? { transport: 'ssh' as const } : {}),
  })))
}

test('loadInstances fails loudly on corrupt files and drops invalid entries', () => {
  const dir = tempDir()
  const corrupt = join(dir, 'corrupt.json')
  writeFileSync(corrupt, '{not json')
  const corruptManager = createTransportManager({ provider: sshProvider, instancesFile: corrupt, logger: silentLogger })
  assert.throws(() => corruptManager.loadInstances(), /corrupt/)
  const mixed = join(dir, 'mixed.json')
  writeFileSync(mixed, JSON.stringify([
    { id: 'ok', label: 'fine', kind: 'dsh', transport: 'ssh', host: 'h.example.com', remotePort: 22 },
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
    { id: 'ok', label: 'fine', kind: 'dsh', transport: 'ssh', host: 'h.example.com', remotePort: 22 },
    null,
    42,
    'stray',
    { id: 'also-ok', label: 'fine', kind: 'dsh', transport: 'ssh', host: 'h.example.com', remotePort: 22 },
  ]))
  const nullManager = createTransportManager({ provider: sshProvider, instancesFile: withNull, logger: silentLogger })
  const nullLoaded = nullManager.loadInstances()
  assert.deepEqual(nullLoaded.map(entry => entry.id), ['ok', 'also-ok'], 'valid entries survive; null/non-object entries are dropped')
})
test('label-only edits keep the live tunnel untouched', async t => {
  const { manager, spawnCalls } = await readyManager(t)
  assert.equal(spawnCalls.length, 1)
  saveCompleted(manager, [
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
  saveCompleted(manager, [{ ...EXEC_INSTANCE, serviceName: 'other.service' }])
  assert.ok(originalTunnel.killCalls.includes('SIGTERM'), 'service identity change tears down the old tunnel')
  assert.equal(manager.status('s2')!.serviceActive, null, 'a cached old-unit status never labels the replacement unit')
  await waitFor(() => spawnCalls.length === 3, 3_000, 'serviceName replacement tunnel')
  await waitFor(() => manager.status('s2')!.phase === 'ready', 3_000, 'serviceName replacement ready')

  const serviceTunnel = spawnCalls[2].child
  saveCompleted(manager, [{ ...EXEC_INSTANCE, serviceName: 'other.service', remoteDshHome: '/srv/dsh' }])
  assert.ok(serviceTunnel.killCalls.includes('SIGTERM'), 'remote dsh home is part of the live exec generation')
  await waitFor(() => spawnCalls.length === 4, 3_000, 'remoteDshHome replacement tunnel')
})
test('auth failure → error with requiresUserAction, no auto-retry', async t => {
  const { manager, children, spawnCalls } = await noProbeManager(t)
  children[0].stderrWrite('Permission denied (publickey,password).\n')
  children[0].simulateExit(255)
  await waitFor(() => manager.status('s1')!.phase === 'error')
  const status = manager.status('s1')!
  assert.equal(status.requiresUserAction, true)
  await sleep(80)
  assert.equal(spawnCalls.length, 1, 'no auto-retry after a terminal auth failure')
})
test('ring projection truncation happens after auth classification', async t => {
  const { manager, children } = await noProbeManager(t)
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
  const { manager, spawnCalls } = await noProbeManager(t)
  spawnCalls[0].child.simulateSpawnError(new Error('spawn ssh ENOENT'))
  await waitFor(() => manager.status('s1')!.phase === 'error')
  assert.equal(manager.status('s1')!.requiresUserAction, true)
})
test('ready tunnel drop → degraded → reconnects with backoff → ready again', async t => {
  const { manager, children, spawnCalls, setProbe } = await readyManager(t)
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
  const { manager, children, spawnCalls } = await noProbeManager(t, { options: { maxRetryAttempts } })
  await exhaustBurst({ manager, children, spawnCalls }, maxRetryAttempts)
  const status = manager.status('s1')!
  assert.equal(status.retryAttempt, maxRetryAttempts)
  assert.equal(status.requiresUserAction, false)
  await sleep(80)
  assert.equal(spawnCalls.length, maxRetryAttempts + 1)
})
test('slow re-probe: burst exhaustion lands on error but keeps retrying and recovers on its own', async t => {
  const maxRetryAttempts = 3
  const { manager, children, spawnCalls, setProbe } = await noProbeManager(t, { options: { maxRetryAttempts, slowRetryMs: 40 } })
  await exhaustBurst({ manager, children, spawnCalls }, maxRetryAttempts)
  const status = manager.status('s1')!
  assert.equal(status.retryAttempt, maxRetryAttempts)
  assert.equal(status.requiresUserAction, false, 'burst exhaustion is not a user-action failure')
  assert.ok(status.logSummary.includes('retrying periodically'), 'the projection announces the slow re-probe')
  assert.ok(manager.logs('s1').some(entry => entry.message.includes('slow re-probe')), 'the slow re-probe is logged')
  // 静默期：快速突发已耗尽，错误态下不立即重试（慢速重探尚未到点）。
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
  const { manager, children, spawnCalls, setProbe } = await noProbeManager(t, { options: { maxRetryAttempts: 1, slowRetryMs: 30 } })
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
  const { manager, children, spawnCalls, setProbe } = await noProbeManager(t, { options: { maxRetryAttempts, slowRetryMs: 20 } })
  await exhaustBurst({ manager, children, spawnCalls }, maxRetryAttempts)
  manager.disconnect('s1')
  assert.equal(manager.status('s1')!.phase, 'idle')
  setProbe(true) // even if the condition clears, the manual disconnect must win
  await sleep(80) // well past several slowRetryMs
  assert.equal(spawnCalls.length, maxRetryAttempts + 1, 'disconnect cancels the slow re-probe forever')
})
test('a terminal failure never arms the slow re-probe', async t => {
  // probe=false keeps the ready loop iterating (re-checking authFailed each
  // turn); with probe=true the machine would race to ready before the auth
  // line lands (ready-loop auth re-checks are in-flight-only).
  const { manager, children, spawnCalls } = await noProbeManager(t, { options: { slowRetryMs: 20 } })
  children[0].stderrWrite('Permission denied (publickey).\n')
  await waitFor(() => manager.status('s1')!.phase === 'error', 3000, 'terminal auth error')
  assert.equal(manager.status('s1')!.requiresUserAction, true)
  assert.equal(manager.status('s1')!.userActionKind, 'auth', 'an SSH auth failure is transport-level, not an endpoint failure')
  await sleep(60) // well past slowRetryMs — no probe may fire for a terminal failure
  assert.equal(spawnCalls.length, 1, 'no auto-retry after a terminal failure')
})
test('an endpoint that accepts TCP but fails the identity verification is never ready', async t => {
  const { manager, spawnCalls, setProbe } = makeManager(t, { verifyProbe: async () => ({ ok: false, detail: 'the destination is not a dsh instance' }) })
  setProbe(true)
  manager.connect('s1')
  await waitFor(() => manager.status('s1')!.phase === 'error', 3000, 'error after verification failures')
  assert.equal(manager.readyUrl('s1'), null, 'a non-dsh endpoint never registers a transport')
  assert.equal(manager.status('s1')!.requiresUserAction, false)
  assert.equal(manager.status('s1')!.userActionKind, null, 'a transient verification failure carries no terminal class')
  assert.equal(manager.status('s1')!.retryAttempt, 3)
  assert.ok(manager.logs('s1').some(entry => entry.message.includes('the destination is not a dsh instance')), 'the reason lands in the ring buffer')
  assert.ok(manager.status('s1')!.logSummary.includes('max retry attempts exceeded'), 'the projection carries the reason')
  await sleep(80)
  assert.equal(spawnCalls.length, 4, 'bounded: initial attempt + maxRetryAttempts reconnects')
})
test('a DETERMINISTIC verification failure (terminal) lands on error immediately, no reconnect', async t => {
  const { manager, spawnCalls, setProbe } = makeManager(t, {
    verifyProbe: async () => ({ ok: false, detail: 'the destination answered HTTP 404 to the dsh identity probe — it does not appear to be a dsh instance', terminal: true }),
  })
  setProbe(true)
  manager.connect('s1')
  await waitFor(() => manager.status('s1')!.phase === 'error', 3000, 'error on the FIRST terminal verification failure')
  assert.equal(manager.readyUrl('s1'), null, 'a deterministic non-dsh endpoint never registers a transport')
  assert.equal(manager.status('s1')!.requiresUserAction, true, 'the user must fix the destination (config/port/version)')
  assert.equal(manager.status('s1')!.userActionKind, 'endpoint', 'a deterministic verification failure is INSTANCE-level — the UI must not suggest fixing SSH credentials')
  assert.equal(manager.status('s1')!.retryAttempt, 0, 'no reconnect cycle started')
  await sleep(80)
  assert.equal(spawnCalls.length, 1, 'exactly one attempt: terminal verification failures are never retried')
  assert.ok(manager.logs('s1').some(entry => entry.message.includes('HTTP 404') && entry.message.includes('dsh identity probe')),
    'the concrete non-dsh reason lands in the ring buffer')
  assert.ok(manager.status('s1')!.logSummary.includes('HTTP 404'), 'the projection carries the deterministic reason')
})
test('a throwing identity verification is contained: warn, never ready, bounded retry', async t => {
  const { manager, setProbe } = makeManager(t, { verifyProbe: async () => { throw new Error('verify boom') } })
  setProbe(true)
  manager.connect('s1')
  await waitFor(() => manager.status('s1')!.phase === 'error', 3000, 'error after contained verification throws')
  assert.equal(manager.readyUrl('s1'), null)
})
test('a real dsh identity handshake through the tunnel destination is required for ready', async t => {
  const dir = tempDir(t)
  // A server that answers /api/session/canOpenWorkspacePath like a real dsh
  // host: the client-request envelope is echoed as a valid server-response
  // with the fixed-size BOOLEAN identity value.
  let sessionListCalls = 0
  const port = await listen(t, (req, res) => {
    if (req.method === 'POST' && req.url === '/api/session/list') {
      sessionListCalls += 1
    }
    if (req.method === 'POST' && req.url === '/api/session/canOpenWorkspacePath') {
      readBody(req, body => {
        let envelope: { type?: unknown; rpcId?: unknown; method?: unknown } | null = null
        try { envelope = JSON.parse(body) } catch { envelope = null }
        if (envelope?.type === 'client-request' && envelope.method === 'session/canOpenWorkspacePath' && typeof envelope.rpcId === 'string') {
          jsonReply(res, { type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value: true } })
        } else {
          res.writeHead(400)
          res.end()
        }
      })
      return
    }
    res.writeHead(404)
    res.end()
  })
  // The tunnel's allocated local port IS the dsh server above, so the
  // runtime's identity probe (real sshProvider.verifyUp) reaches it.
  const manager = managerOn(dir, port)
  saveCompleted(manager, [{ id: 's1', label: 'home', host: 'h.example.com', remotePort: 2222 }])
  manager.connect('s1')
  await waitFor(() => manager.status('s1')!.phase === 'ready', 3000, 'ready after the dsh identity handshake')
  assert.equal(manager.readyUrl('s1'), `http://127.0.0.1:${port}`)
  assert.ok(manager.logs('s1').some(entry => entry.message.includes('transport ready')), 'the handshake-gated ready is logged')
  assert.equal(sessionListCalls, 0, 'the attach probe never re-reads the session list')
  manager.dispose()
})
test('a session-list-heavy dsh destination attaches via the fixed-size identity probe', async t => {
  // The endpoint's session/list answer grows with session data (here a 1 MiB+
  // list that would overflow the legacy probe cap). The identity probe never
  // reads it, so attach stays healthy.
  const dir = tempDir(t)
  let sessionListCalls = 0
  const padding = 'x'.repeat(1024 * 1024 + 64)
  const port = await listen(t, (req, res) => {
    if (req.method === 'POST' && req.url === '/api/session/list') {
      sessionListCalls += 1
      readBody(req, body => {
        const envelope = JSON.parse(body) as { rpcId?: unknown }
        jsonReply(res, { type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value: { items: [{ sessionId: 's1', padding }] } } })
      })
      return
    }
    if (req.method === 'POST' && req.url === '/api/session/canOpenWorkspacePath') {
      readBody(req, body => {
        const envelope = JSON.parse(body) as { rpcId?: unknown }
        jsonReply(res, { type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value: true } })
      })
      return
    }
    res.writeHead(404)
    res.end()
  })
  const manager = managerOn(dir, port)
  saveCompleted(manager, [{ id: 's1', label: 'home', host: 'h.example.com', remotePort: 2222 }])
  manager.connect('s1')
  await waitFor(() => manager.status('s1')!.phase === 'ready', 3000, 'ready via the fixed-size identity probe')
  assert.equal(manager.readyUrl('s1'), `http://127.0.0.1:${port}`)
  assert.equal(sessionListCalls, 0, 'the session-data-bearing probe is never invoked')
  manager.dispose()
})
test('a tunnel destination that is not a dsh instance never becomes ready', async t => {
  const dir = tempDir(t)
  const port = await listen(t, (_req, res) => { res.writeHead(404); res.end() })
  const manager = managerOn(dir, port)
  saveCompleted(manager, [{ id: 's1', label: 'home', host: 'h.example.com', remotePort: 2222 }])
  manager.connect('s1')
  await waitFor(() => manager.status('s1')!.phase === 'error', 3000, 'error after verification failures')
  assert.equal(manager.readyUrl('s1'), null, 'a non-dsh service never presents as connected')
  assert.ok(manager.logs('s1').some(entry => entry.message.includes('HTTP 404') && entry.message.includes('dsh identity probe')),
    'the concrete non-dsh reason lands in the ring buffer')
  manager.dispose()
})
test('verifyDshEndpoint rejects a wrong-shaped 200 answer and times out on a silent endpoint', async t => {
  const wrongPort = await listen(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ hello: 'world' }))
  })
  const mismatched = await verifyDshEndpoint({ host: '127.0.0.1', port: wrongPort })
  assert.equal(mismatched.ok, false, 'a non-dsh 200 body is rejected')
  if (!mismatched.ok) {
    assert.match(mismatched.detail ?? '', /does not appear to be a dsh/)
    assert.equal(mismatched.terminal, true, 'a destination that ANSWERED is deterministic: retrying cannot change the answer')
  }
  const silentPort = await listen(t, () => { /* never answer */ })
  const timedOut = await verifyDshEndpoint({ host: '127.0.0.1', port: silentPort }, 50)
  assert.equal(timedOut.ok, false, 'a silent (non-HTTP-like) endpoint times out instead of hanging')
  if (!timedOut.ok) {
    assert.match(timedOut.detail ?? '', /did not answer/)
    assert.equal(timedOut.terminal, undefined, 'a silent endpoint is TRANSIENT: the bounded reconnect path applies')
  }
  const bloatPort = await listen(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ padding: 'x'.repeat(64 * 1024) }))
  })
  // No explicit cap argument: the DEFAULT identity-arm cap (64 KiB,
  // HOST_PROBE_MAX_RESPONSE_BYTES) is what this leg pins end-to-end. The
  // body is ~64 KiB + JSON framing — just over the default cap.
  const oversized = await verifyDshEndpoint({ host: '127.0.0.1', port: bloatPort }, 5000)
  assert.equal(oversized.ok, false, 'an oversized answer is rejected instead of buffered unbounded')
  if (!oversized.ok) {
    assert.match(oversized.detail ?? '', /oversized/)
    assert.equal(oversized.terminal, true, 'an oversized answer is deterministic non-dsh evidence')
  }
})
test('verifyDshEndpoint: a value:false identity answer is still a healthy dsh handshake', async t => {
  // The identity method reports the platform answer (can this deployment hand
  // a Session workspace path to a native desktop?). Headless remote dsh
  // deployments legitimately answer false — only method presence / protocol /
  // controller assembly are under test, so false is ready too.
  const port = await listen(t, (req, res) => {
    readBody(req, body => {
      const envelope = JSON.parse(body) as { rpcId?: unknown; method?: unknown }
      jsonReply(res, { type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value: false } })
    })
  })
  const result = await verifyDshEndpoint({ host: '127.0.0.1', port })
  assert.deepEqual(result, { ok: true }, 'value false is equally healthy')
})
test('verifyDshEndpoint: an ok:true envelope with a non-boolean value is terminal non-dsh', async t => {
  // A host answering the identity method with ok:true but a non-boolean value
  // contradicts the identity contract — deterministic non-dsh evidence, same
  // terminal surface as any wrong-shaped 200 answer.
  const port = await listen(t, (req, res) => {
    readBody(req, body => {
      const envelope = JSON.parse(body) as { rpcId?: unknown }
      // A matching envelope echo with ok:true and a NON-boolean value: the
      // method contract is violated → deterministic non-dsh evidence.
      jsonReply(res, { type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value: { items: [] } } })
    })
  })
  const result = await verifyDshEndpoint({ host: '127.0.0.1', port })
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.match(result.detail ?? '', /does not appear to be a dsh/)
    assert.equal(result.terminal, true)
  }
})
test('verifyDshEndpoint flags an old-version dsh destination (positive legacy signature)', async t => {
  // The identity method call (session/canOpenWorkspacePath) answers 404 —
  // the destination is an old-version dsh (dsh < 0.1.2-rc.1) — but the
  // signature re-probe's LEGACY session/list arm answers the canonical
  // legacy payload shape (a plain record carrying an items array, the
  // single-sourced predicate): positive dsh evidence, so the detail tells the
  // user the destination IS dsh ("check or upgrade") instead of claiming
  // "not dsh".
  let calls = 0
  const inconsistentDshPort = await listen(t, (req, res) => {
    calls++
    if (req.method === 'POST' && req.url === '/api/session/list' && calls > 1) {
      readBody(req, body => {
        const envelope = JSON.parse(body) as { rpcId?: unknown }
        jsonReply(res, { type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value: { items: [] } } })
      })
    } else {
      res.writeHead(404)
      res.end()
    }
  })
  const stale = await verifyDshEndpoint({ host: '127.0.0.1', port: inconsistentDshPort })
  assert.equal(stale.ok, false)
  if (!stale.ok) {
    assert.match(stale.detail ?? '', /is a dsh instance/, 'a positive dsh signature wins over the generic not-dsh message')
    assert.equal(stale.terminal, true, 'a destination that ANSWERED the signature probe is deterministic: retrying cannot change the answer')
  }
})
test('verifyDshEndpoint keeps the generic message when no dsh signature exists', async t => {
  // 404 on the identity method (the primary probe) AND 404 on both signature
  // arms (identity + legacy session/list re-answer): indistinguishable from
  // a plain web server — honesty over guessing, the dsh claim must not be
  // made without positive evidence.
  const plainPort = await listen(t, (_req, res) => { res.writeHead(404); res.end() })
  const result = await verifyDshEndpoint({ host: '127.0.0.1', port: plainPort })
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.match(result.detail ?? '', /does not appear to be a dsh/)
    assert.ok(!(result.detail ?? '').includes('is a dsh instance'), 'no positive dsh evidence → no dsh claim')
    assert.equal(result.terminal, true, 'an HTTP answer that is not a dsh handshake is deterministic: retrying cannot change it')
  }
})
test('probeChamberHostLive classifies every registry host package the same way: live / not-live / unknown', async t => {
  // Parameterized over the control-plane registry (CHAMBER_HOST_PACKAGES), so a
  // package added to the registry is covered automatically — the probe is
  // generic (method + args from the descriptor) and must not grow a per-package
  // branch. Classification:
  // 200 + ok:true = the running instance resolved the method; 404 = the gateway
  // does not claim the namespace (injected, restart pending); no answer /
  // unclassifiable body = unknown, never a guessed claim.
  const livePort = await listen(t, (req, res) => {
    readBody(req, body => {
      const envelope = JSON.parse(body) as { rpcId?: unknown }
      jsonReply(res, { type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value: { ok: true, value: {} } } })
    })
  })
  const missingPort = await listen(t, (_req, res) => { res.writeHead(404); res.end() })
  const silentPort = await listen(t, () => { /* never answer */ })
  // A well-formed envelope with result.ok:false = the gateway answered but the
  // method is not resolvable: deterministic not-live (the running instance
  // booted before the injection). The classification lives in the ONE generic
  // path.
  const unresolvedPort = await listen(t, (req, res) => {
    readBody(req, body => {
      const envelope = JSON.parse(body) as { rpcId?: unknown }
      jsonReply(res, { type: 'server-response', rpcId: envelope.rpcId, result: { ok: false, error: { code: 'method_not_found' } } })
    })
  })
  // Non-404 non-200 is unclassifiable — never a guessed claim.
  const failingPort = await listen(t, (_req, res) => { res.writeHead(500); res.end() })

  assert.ok(CHAMBER_HOST_PACKAGES.length > 0, 'the registry must carry at least one host package')
  for (const descriptor of CHAMBER_HOST_PACKAGES) {
    const { method, args } = descriptor.probe
    assert.equal(await probeChamberHostLive({ host: '127.0.0.1', port: livePort }, method, args), 'live',
      `${descriptor.insert.id}: a resolved method is live`)
    assert.equal(await probeChamberHostLive({ host: '127.0.0.1', port: unresolvedPort }, method, args), 'not-live',
      `${descriptor.insert.id}: an unresolved-method envelope = injected, restart pending`)
    assert.equal(await probeChamberHostLive({ host: '127.0.0.1', port: missingPort }, method, args), 'not-live',
      `${descriptor.insert.id}: 404 = the boot row is not loaded yet`)
    assert.equal(await probeChamberHostLive({ host: '127.0.0.1', port: failingPort }, method, args), 'unknown',
      `${descriptor.insert.id}: a non-404 non-200 answer is unclassifiable`)
    assert.equal(await probeChamberHostLive({ host: '127.0.0.1', port: silentPort }, method, args, 50), 'unknown',
      `${descriptor.insert.id}: silence times out instead of claiming a state`)
  }
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
  const { manager, children, spawnCalls } = await noProbeManager(t, { options: { maxRetryAttempts }, random: () => 0.5 })
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
  const { manager, children, spawnCalls } = await noProbeManager(t, { options: { maxRetryAttempts }, random: () => 0 })
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
  const { children, spawnCalls, spawnTimes, setProbe } = await readyManager(t, { options: { retryBaseMs: 1000, retryMaxMs: 4000 }, random: () => 0.5 })
  setProbe(false)
  const exitAt = Date.now()
  // Reference timer with the same jittered delay, started before the exit:
  // a CI stall inflates BOTH timers equally, so the reconnect gap must track
  // the reference — a raw 1000ms backoff would lag it by ~250ms no matter
  // how the loop is stalled (an absolute <990ms cap flaked under pauses).
  let refDelta = 0
  const refTimer = setTimeout(() => { refDelta = Date.now() - exitAt }, 750)
  children[0].simulateExit(0)
  await waitFor(() => spawnCalls.length === 2, 3000, 'jittered reconnect spawn')
  clearTimeout(refTimer)
  const gap = spawnTimes[1] - exitAt
  assert.ok(refDelta > 0, 'the 750ms reference timer fired before the reconnect spawn')
  assert.ok(gap >= 700, `reconnect fires no earlier than the jittered delay: ${gap}ms`)
  assert.ok(gap <= refDelta + 50, `reconnect fires with the jittered delay, not the raw backoff (gap ${gap}ms vs reference ${refDelta}ms)`)
})
test("a replaced tunnel's late stderr can never poison the fresh attempt", async t => {
  const harness = makeManager(t)
  const { manager, children, setProbe } = harness
  await readyThenDrop(harness)
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
  saveCompleted(manager, [{ id: 's1', label: 'home', host: 'h.example.com', remotePort: 2222 }])
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
  const { manager, children } = await noProbeManager(t)
  children[0].stderrWrite('debug1: identity file /Users/x/.s')
  children[0].stderrWrite('sh/id_ed25519 type 3\n')
  await sleep(30)
  const lines = manager.logs('s1')
  assert.ok(lines.some(entry => entry.message === '[ssh material redacted]'), 'straddling key path is redacted as one complete line')
  assert.ok(lines.every(entry => !entry.message.includes('/.ssh') || entry.message === '[ssh material redacted]'), 'no raw key-path fragment in logs')
})
test('stdout redaction also reassembles lines split across chunks', async t => {
  const { manager, children } = await noProbeManager(t)
  children[0].stdout.emit('data', Buffer.from('debug1: identity file /Users/x/.s'))
  children[0].stdout.emit('data', Buffer.from('sh/id_ed25519 type 3\n'))
  await sleep(30)
  const lines = manager.logs('s1')
  assert.ok(lines.some(entry => entry.message === '[ssh material redacted]'))
  assert.ok(lines.every(entry => !entry.message.includes('/.ssh') || entry.message === '[ssh material redacted]'))
})
test('unterminated transport output is bounded, dropped, and resumes at the next line', async t => {
  const { manager, children } = await noProbeManager(t)
  children[0].stderrWrite('x'.repeat(CHILD_LINE_MAX_CHARS + 1))
  children[0].stderrWrite('\nordinary line\n')
  await sleep(30)
  const lines = manager.logs('s1')
  assert.ok(lines.some(entry => entry.message.includes('output line dropped')))
  assert.ok(lines.some(entry => entry.message === 'ordinary line'))
  assert.ok(lines.every(entry => !entry.message.includes('xxxxx')))
})
test('disconnect stops the process (SIGTERM) and lands on idle', async t => {
  const { manager, children } = await readyManager(t)
  manager.disconnect('s1')
  assert.equal(manager.status('s1')!.phase, 'idle')
  assert.ok(children[0].killCalls.includes('SIGTERM'))
  children[0].simulateExit(143)
  assert.equal(manager.status('s1')!.phase, 'idle')
  assert.equal(manager.readyUrl('s1'), null)
})
test('ring buffer truncates to the configured limit', async t => {
  const { manager, children } = await noProbeManager(t, { options: { ringBufferLimit: 5 } })
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
  const { manager } = await readyManager(t)
  assert.equal(manager.appendLog('s1', 'info', 'chamber host-graph 注入完成'), true)
  assert.equal(manager.appendLog('s1', 'error', 'chamber host-graph 注入失败：boom'), true)
  assert.equal(manager.appendLog('nope', 'info', 'unknown id'), false)
  const lines = manager.logs('s1')
  assert.ok(lines.some(entry => entry.level === 'info' && entry.message.includes('注入完成')))
  assert.ok(lines.some(entry => entry.level === 'error' && entry.message.includes('注入失败：boom')))
})
test('ring entries retain a useful prefix but cap classified messages independently of parser lines', async t => {
  const { manager } = await readyManager(t)
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

// ---------------------------------------------------------------------------
// Provider routing / askpass-lease / ready-heartbeat suite. The lease-lifecycle
// primitives (helper generation, exact-owner spawn, five-generation retention)
// are pinned in ssh-provider.test.ts:96-259; the frame-level askpass env
// contract in ssh-provider-exec.test.ts:184.
// ---------------------------------------------------------------------------

/** A minimal transport-provider spec projection for the process-less providers. */
function directSpec(record: Record<string, unknown>, kind: string): TransportInstanceSpec {
  return {
    id: record.id as string, label: record.label as string, kind, transport: kind, host: record.host as string,
    user: null, sshPort: null, remotePort: record.remotePort as number, serviceName: null, remoteDshHome: null, insecureHttp: false,
  }
}

/** A process-less provider: probe-driven ready, no child, optional dispose/exec hooks. */
function endpointProvider(kind: string, events: string[] = []): TransportProvider {
  return {
    kind,
    validateSpec(input: unknown): TransportInstanceSpec | null {
      if (input === null || typeof input !== 'object') return null
      const record = input as Record<string, unknown>
      if (typeof record.id !== 'string' || typeof record.label !== 'string'
        || typeof record.host !== 'string' || typeof record.remotePort !== 'number') return null
      if (record.kind !== kind) return null
      return directSpec(record, kind)
    },
    probeTarget: spec => ({ host: 'fake.local', port: spec.remotePort }),
    endpointUrl: spec => `http://fake.local:${spec.remotePort}`,
    classifyStderr: line => ({ log: line, terminalAuth: false, enoent: false }),
    disposeAuth: spec => { events.push(`dispose:${spec.kind}`) },
    exec: (spec, _action, deps) => {
      deps.setProjection(spec.id, 'serviceActive', true)
      const status = deps.projection(spec.id)
      return Promise.resolve(status === null ? { ok: false, error: 'missing projection' } : { ok: true, status })
    },
  }
}

/** A fakeEnvProvider that counts buildStartEnv lease releases. */
function leaseProvider(helper: string) {
  const state = { releases: 0 }
  const provider: TransportProvider = {
    ...fakeEnvProvider,
    buildStartEnv: () => ({ env: { SSH_ASKPASS: helper }, release: () => { state.releases += 1 } }),
  }
  return { provider, releases: () => state.releases }
}

/** Set the s2 askpass password before the first spawn and tear it down after. */
function sshPasswordLease(t: TestContext, manager: { dispose(): void }) {
  configureSshPasswordStore(null)
  setSshPassword('s2', 'lease-password')
  t.after(() => {
    manager.dispose()
    setSshPassword('s2', null)
    purgeSshAuth('s2')
    configureSshPasswordStore(null)
  })
}

/** makeManager + connect the given instance to ready. */
async function readyOn(t: TestContext, id: string, overrides: Parameters<typeof makeManager>[1] = {}) {
  const harness = makeManager(t, overrides)
  harness.setProbe(true)
  harness.manager.connect(id)
  await waitFor(() => harness.manager.status(id)!.phase === 'ready')
  return harness
}

test('transport switch disposes the old provider before the replacement starts and resolveProvider prefers transport keys', async t => {
  const events: string[] = []
  const manager = createTransportManager({
    provider: endpointProvider('fallback', events),
    providers: { ssh: endpointProvider('dsh', events), http: endpointProvider('gateway', events) },
    instancesFile: join(tempDir(t), 'instances.json'),
    logger: silentLogger,
    portProbe: async () => true,
    options: { readyTimeoutMs: 100, probeIntervalMs: 5 },
  })
  saveCompleted(manager, [{ id: 'switch', label: 'switch', kind: 'dsh', transport: 'ssh', host: 'old.example.com', remotePort: 443 }])
  manager.onStatusChanged((_id, status) => { events.push(`status:${status.kind}:${status.phase}`) })
  manager.connect('switch')
  await waitFor(() => manager.status('switch')?.phase === 'ready', 3000, 'old provider ready')
  const oldExec = await manager.exec('switch', 'start')
  assert.equal(oldExec.ok, true)
  events.length = 0
  saveCompleted(manager, [{ id: 'switch', label: 'switch', kind: 'gateway', transport: 'http', host: 'new.example.com', remotePort: 443 }])
  await waitFor(() => manager.status('switch')?.phase === 'ready', 3000, 'new provider ready')
  assert.deepEqual(events.slice(0, 3), ['dispose:dsh', 'status:dsh:idle', 'status:gateway:connecting'])
  assert.equal(manager.readyUrl('switch'), 'http://fake.local:443')
  assert.equal(manager.status('switch')?.serviceActive, null, 'old provider projections do not cross the kind boundary')

  // Design 17 §2.2 registration: a provider keyed by TRANSPORT wins; a spec
  // without a transport key falls back to the default provider.
  const dir = tempDir(t)
  const keyed = createTransportManager({
    provider: sshProvider,
    providers: { http: gatewayProvider },
    instancesFile: join(dir, 'instances.json'),
    logger: silentLogger,
    portProbe: async () => true,
    verifyProbe: async () => ({ ok: true }),
    options: { readyTimeoutMs: 100, probeIntervalMs: 5 },
  })
  keyed.saveInstances([{ id: 'gw', label: 'gw', kind: 'gateway', transport: 'http', host: 'gw.example.com', remotePort: 443 }])
  assert.equal(keyed.status('gw')!.transport, 'http')
  keyed.connect('gw')
  await waitFor(() => keyed.status('gw')?.phase === 'ready', 3000, 'transport-keyed provider ready')
  keyed.saveInstances([
    { id: 'gw', label: 'gw', kind: 'gateway', transport: 'http', host: 'gw.example.com', remotePort: 443 },
    { id: 's1', label: 's', kind: 'dsh', transport: 'ssh', host: 'h.example.com', remotePort: 3080 },
  ])
  assert.equal(keyed.status('s1')!.transport, 'ssh')
})

test('direct-endpoint provider: probe-driven ready, endpoint URL, no child, degraded then recovery', async t => {
  const { manager, spawnCalls, setProbe } = makeManager(t, {
    provider: endpointProvider('fake'),
    includeDefault: false,
    instances: [{ id: 'f1', label: 'tailnet-host', kind: 'fake', host: 'host1.tailnet', remotePort: 8080 }],
  })
  setProbe(false)
  const connecting = manager.connect('f1')!
  assert.equal(connecting.phase, 'connecting')
  assert.equal(spawnCalls.length, 0, 'direct endpoint mode spawns no process')
  await waitFor(() => manager.status('f1')!.phase === 'degraded', 3000, 'degraded after timeout')
  setProbe(true)
  await waitFor(() => manager.status('f1')!.phase === 'ready', 3000, 'endpoint ready')
  assert.equal(manager.readyUrl('f1'), 'http://fake.local:8080')
  manager.disconnect('f1')
  assert.equal(manager.status('f1')!.phase, 'idle')
  assert.equal(manager.readyUrl('f1'), null)

  const { manager: noExec, spawnCalls: noExecSpawns } = makeManager(t, {
    provider: fakeEnvProvider,
    instances: [{ id: 'f3', label: 'noexec', kind: 'ssh', host: 'x.tailnet', remotePort: 8080 }],
  })
  const result = await noExec.exec('f3', 'start')
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.error, /not supported by transport kind/)
  assert.equal(noExecSpawns.length, 0)
})

test('per-child SIGKILL escalation slots and provider env injection survive a sibling failure', async t => {
  const { manager, children, spawnCalls, setProbe } = await readyOn(t, 's1', { options: { disconnectGraceMs: 60 } })
  setProbe(false)
  manager.disconnect('s1')
  assert.ok(children[0].killCalls.includes('SIGTERM'))
  manager.connect('s1')
  await waitFor(() => spawnCalls.length === 2, 3000, 'fresh spawn after reconnect')
  children[1].stderrWrite('Permission denied (publickey).\n')
  children[1].simulateExit(255)
  await waitFor(() => manager.status('s1')!.phase === 'error', 3000, 'terminal error')
  await waitFor(() => children[0].killCalls.includes('SIGKILL'), 3000, 'A still gets its SIGKILL')
  assert.ok(!children[1].killCalls.includes('SIGKILL'), 'a cleanly-exited child never gets SIGKILL')

  const env = await readyOn(t, 'e1', {
    provider: fakeEnvProvider, instances: [{ id: 'e1', label: 'envhost', kind: 'ssh', host: 'env.example.com', remotePort: 8080 }],
  })
  assert.equal(env.spawnCalls.length, 1)
  assert.equal(env.spawnCalls[0].options.env?.SSH_ASKPASS, '/tmp/askpass-e1')
  assert.equal(env.spawnCalls[0].options.env?.SSH_ASKPASS_REQUIRE, 'force')
  assert.equal(env.spawnCalls[0].options.env?.PATH, process.env.PATH, 'process.env is preserved, never replaced')
})

test('a provider lease is released exactly once across spawn throw, error/exit and exit/error orderings', async t => {
  const sync = leaseProvider('/tmp/fake-sync-throw-helper')
  const syncManager = makeManager(t, {
    provider: sync.provider,
    instances: [{ id: 'e-throw', label: 'env-throw', kind: 'dsh', transport: 'ssh', host: 'env-throw.example.com', remotePort: 8080 }],
    spawnFn: () => { throw new Error('synthetic spawn failure') },
  })
  syncManager.manager.connect('e-throw')
  await waitFor(() => syncManager.manager.status('e-throw')!.phase === 'error')
  assert.equal(sync.releases(), 1, 'a throwing spawn releases the provider lease exactly once')

  const errored = leaseProvider('/tmp/fake-child-error-helper')
  const errorManager = makeManager(t, {
    provider: errored.provider,
    instances: [{ id: 'e-error', label: 'env-error', kind: 'dsh', transport: 'ssh', host: 'env-error.example.com', remotePort: 8080 }],
    options: { disconnectGraceMs: 500 },
  })
  errorManager.manager.connect('e-error')
  await waitFor(() => errorManager.spawnCalls.length === 1)
  errorManager.spawnCalls[0].child.simulateSpawnError(new Error('synthetic child error'))
  await waitFor(() => errorManager.manager.status('e-error')!.phase === 'error')
  assert.equal(errored.releases(), 1, 'a child error releases the provider lease')
  errorManager.spawnCalls[0].child.simulateExit(1)
  assert.equal(errored.releases(), 1, 'a following exit cannot double-release the lease')

  const exited = leaseProvider('/tmp/fake-child-exit-helper')
  const exitManager = makeManager(t, {
    provider: exited.provider,
    instances: [{ id: 'e-exit', label: 'env-exit', kind: 'dsh', transport: 'ssh', host: 'env-exit.example.com', remotePort: 8080 }],
  })
  exitManager.manager.connect('e-exit')
  await waitFor(() => exitManager.spawnCalls.length === 1)
  exitManager.manager.disconnect('e-exit')
  exitManager.spawnCalls[0].child.simulateExit(143, 'SIGTERM')
  assert.equal(exited.releases(), 1, 'a normal child exit releases the provider lease')
  exitManager.spawnCalls[0].child.simulateSpawnError(new Error('late synthetic error'))
  assert.equal(exited.releases(), 1, 'a following error cannot double-release the lease')
})

test('a stale-epoch tunnel keeps its lease until the spawned child actually exits', async t => {
  const { provider, releases } = leaseProvider('/tmp/fake-stale-helper')
  let staleChild: FakeChild | null = null
  let runtime: ReturnType<typeof createTransportManager>
  const made = makeManager(t, {
    provider,
    instances: [{ id: 'e-stale', label: 'env-stale', kind: 'dsh', transport: 'ssh', host: 'env-stale.example.com', remotePort: 8080 }],
    spawnFn: () => {
      staleChild = new FakeChild()
      // Re-enter disconnect while doSpawn is in flight: the stale epoch must
      // retain the lease through the SIGTERM-pending child's real lifetime.
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

test('disconnect keeps an idle exec lease through the bounded SIGKILL escalation; disposeAsync waits too', async t => {
  const { manager, spawnCalls } = makeManager(t, { instances: [EXEC_INSTANCE], options: { disconnectGraceMs: 20, execTimeoutMs: 2_000 } })
  sshPasswordLease(t, manager)
  const resultPromise = manager.exec('s2', 'start')
  const child = spawnCalls[0].child
  const helper = spawnCalls[0].options.env?.SSH_ASKPASS as string
  assert.ok(existsSync(helper))
  manager.disconnect('s2')
  manager.disconnect('s2')
  assert.ok(child.killCalls.includes('SIGTERM'))
  await waitFor(() => child.killCalls.includes('SIGKILL'), 2_000, 'idle exec SIGKILL escalation')
  assert.equal(child.killCalls.filter(signal => signal === 'SIGKILL').length, 1, 'one non-renewable escalation per child')
  assert.ok(existsSync(helper), 'SIGKILL request cannot release a helper before the child exits')
  child.simulateExit(null, 'SIGKILL')
  assert.equal((await resultPromise).ok, false)
  assert.ok(!existsSync(helper), 'the real exit releases the child-bound helper')

  const dispose = makeManager(t, { instances: [EXEC_INSTANCE] })
  const disposePromiseResult = dispose.manager.exec('s2', 'start')
  const disposeChild = dispose.spawnCalls[0].child
  let settled = false
  const disposePromise = dispose.manager.disposeAsync().then(() => { settled = true })
  await waitFor(() => disposeChild.killCalls.includes('SIGTERM'), 2000, 'exec child SIGTERM')
  assert.equal(settled, false, 'disposeAsync must still be waiting after SIGTERM (M2 wait semantics)')
  await waitFor(() => disposeChild.killCalls.includes('SIGKILL'), 2000, 'exec child SIGKILL escalation')
  assert.equal(settled, false, 'the SIGKILL request alone does not release the child-bound lifecycle')
  disposeChild.simulateExit(null, 'SIGKILL')
  await disposePromise
  assert.equal(settled, true)
  assert.equal((await disposePromiseResult).ok, false)
})

test('hostile thrown values from allocation and provider start hooks still settle loudly', async t => {
  const hostile = new Proxy({}, {
    get() { throw new Error('formatter trap') },
    getPrototypeOf() { throw new Error('instanceof trap') },
  })
  const allocation = makeManager(t, { allocatePort: async () => { throw hostile } })
  allocation.manager.connect('s1')
  await waitFor(() => allocation.manager.status('s1')?.phase === 'error', 3000, 'hostile allocation error')
  assert.match(allocation.manager.status('s1')!.logSummary, /unknown error/)

  const throwingProvider: TransportProvider = { ...sshProvider, buildStartArgs: () => { throw hostile } }
  const providerStart = makeManager(t, { provider: throwingProvider })
  providerStart.manager.connect('s1')
  await waitFor(() => providerStart.manager.status('s1')?.phase === 'error', 3000, 'hostile provider start error')
  assert.match(providerStart.manager.status('s1')!.logSummary, /unknown error/)
  assert.equal(providerStart.spawnCalls.length, 0)

  const throwingEnv: TransportProvider = { ...fakeEnvProvider, buildStartEnv: () => { throw new Error('env boom') } }
  const envStart = makeManager(t, { provider: throwingEnv, instances: [{ id: 'e3', label: 'envhost3', kind: 'ssh', host: 'env3.example.com', remotePort: 8080 }] })
  envStart.manager.connect('e3')
  await waitFor(() => envStart.manager.status('e3')!.phase === 'error', 3000, 'throwing buildStartEnv error')
  assert.equal(envStart.spawnCalls.length, 0, 'no transport spawns after a throwing buildStartEnv')
  assert.equal(envStart.manager.status('e3')!.requiresUserAction, false, 'a provider bug is not a user-action failure')
})

test('ready-state heartbeat: terminal failures leave ready with no auto-retry, transient ones reconnect', async t => {
  let outcome: TransportVerifyResult = { ok: true }
  const terminal = await readyOn(t, 's1', {
    options: { readyVerifyIntervalMs: 20, readyVerifyMinIntervalMs: 5 }, verifyProbe: async () => outcome,
  })
  outcome = { ok: false, terminal: true, detail: 'the gateway rejected the password authentication (401) — re-enter the password' }
  await waitFor(() => terminal.manager.status('s1')!.phase === 'error', 3000, 'heartbeat terminal error')
  const status = terminal.manager.status('s1')!
  assert.equal(status.requiresUserAction, true)
  assert.equal(status.userActionKind, 'endpoint')
  assert.match(status.logSummary, /re-enter the password/)
  await sleep(80)
  assert.equal(terminal.manager.status('s1')!.phase, 'error')
  assert.equal(terminal.spawnCalls.length, 1, 'terminal failures never auto-retry')

  let transientOutcome: TransportVerifyResult = { ok: true }
  const transient = await readyOn(t, 's1', {
    options: { readyVerifyIntervalMs: 15, readyVerifyMinIntervalMs: 5, readyTimeoutMs: 50, retryBaseMs: 10, retryMaxMs: 20, maxRetryAttempts: 3 },
    verifyProbe: async () => transientOutcome,
  })
  transientOutcome = { ok: false, detail: 'connection reset' }
  await waitFor(() => transient.manager.status('s1')!.phase === 'degraded', 3000, 'degraded after transient heartbeat failure')
  transientOutcome = { ok: true }
  await waitFor(() => transient.manager.status('s1')!.phase === 'ready', 3000, 'recovered ready')
  assert.equal(transient.manager.status('s1')!.retryAttempt, 0)
})

test('reverify: one quiet-windowed on-demand probe, a no-op while not ready, and no heartbeat after leaving ready', async t => {
  let verifyCalls = 0
  const { manager } = await readyOn(t, 's1', {
    options: { readyVerifyIntervalMs: 60_000, readyVerifyMinIntervalMs: 5_000 },
    verifyProbe: async () => { verifyCalls += 1; return { ok: true } },
  })
  const atReady = verifyCalls
  manager.reverify('s1')
  await sleep(30)
  assert.equal(verifyCalls, atReady + 1, 'on-demand reverify runs one probe')
  manager.reverify('s1')
  await sleep(30)
  assert.equal(verifyCalls, atReady + 1, 'the quiet window suppresses repeat on-demand probes')
  manager.disconnect('s1')
  await waitFor(() => manager.status('s1')!.phase === 'idle', 3000, 'idle')
  const before = verifyCalls
  manager.reverify('s1')
  await sleep(30)
  assert.equal(verifyCalls, before, 'reverify is a no-op while not ready')

  let heartbeatCalls = 0
  const heartbeat = await readyOn(t, 's1', {
    options: { readyVerifyIntervalMs: 30, readyVerifyMinIntervalMs: 5 },
    verifyProbe: async () => { heartbeatCalls += 1; return { ok: true } },
  })
  heartbeat.manager.disconnect('s1')
  await waitFor(() => heartbeat.manager.status('s1')!.phase === 'idle', 3000, 'idle')
  const atIdle = heartbeatCalls
  await sleep(120)
  assert.equal(heartbeatCalls, atIdle, 'no heartbeat probes fire after leaving ready')
})

test('onVerified fires only after successful re-verifications, and a user probe colliding with the tick keeps the chain alive', async t => {
  let outcome: TransportVerifyResult = { ok: true }
  const verified: string[] = []
  const { manager, setProbe } = makeManager(t, {
    options: { readyVerifyIntervalMs: 15, readyVerifyMinIntervalMs: 5, readyTimeoutMs: 50, retryBaseMs: 10, retryMaxMs: 20, maxRetryAttempts: 3, slowRetryMs: 30 },
    verifyProbe: async () => outcome,
  })
  setProbe(true)
  manager.onVerified(id => { verified.push(id) })
  manager.connect('s1')
  await waitFor(() => manager.status('s1')!.phase === 'ready', 3000, 'ready')
  await waitFor(() => verified.length >= 1, 3000, 'onVerified after heartbeat success')
  const afterSuccess = verified.length
  outcome = { ok: false, detail: 'connection reset' }
  await waitFor(() => manager.status('s1')!.phase === 'degraded', 3000, 'degraded')
  assert.equal(verified.length, afterSuccess, 'a failed verification never emits onVerified')
  outcome = { ok: true }
  await waitFor(() => manager.status('s1')!.phase === 'ready', 3000, 'recovered')
  await waitFor(() => verified.length > afterSuccess, 3000, 'onVerified after recovery heartbeat')

  let hold = false
  const gate = { release: null as (() => void) | null }
  let verifyCalls = 0
  const collision = makeManager(t, {
    options: { readyVerifyIntervalMs: 25, readyVerifyMinIntervalMs: 5 },
    verifyProbe: async () => {
      verifyCalls += 1
      if (hold) await new Promise<void>(resolve => { gate.release = resolve })
      return outcome
    },
  })
  collision.setProbe(true)
  collision.manager.connect('s1')
  await waitFor(() => collision.manager.status('s1')!.phase === 'ready', 3000, 'ready')
  hold = true
  collision.manager.reverify('s1')
  await waitFor(() => gate.release !== null, 1000, 'user probe held in flight')
  const heldCalls = verifyCalls
  await sleep(80)
  assert.equal(verifyCalls, heldCalls, 'the periodic tick was eaten by the in-flight user probe')
  hold = false
  gate.release!()
  gate.release = null
  await waitFor(() => verifyCalls > heldCalls, 3000, 'heartbeat chain continues after the collision')
  assert.equal(collision.manager.status('s1')!.phase, 'ready')
})

test('disposeAuth fires on disconnect; a removed tunnel stays tracked through disposeAsync until its real exit', async t => {
  const disposed: string[] = []
  const provider: TransportProvider = { ...fakeEnvProvider, disposeAuth: spec => { disposed.push(spec.id) } }
  const { manager } = await readyOn(t, 'e2', { provider, instances: [{ id: 'e2', label: 'envhost2', kind: 'ssh', host: 'env2.example.com', remotePort: 8080 }] })
  manager.disconnect('e2')
  assert.deepEqual(disposed, ['e2'])

  configureSshPasswordStore(null)
  setSshPassword('s2', 'lease-password')
  const removed = await readyOn(t, 's2', { instances: [EXEC_INSTANCE], options: { disconnectGraceMs: 20 } })
  t.after(() => { removed.manager.dispose(); setSshPassword('s2', null); purgeSshAuth('s2'); configureSshPasswordStore(null) })
  const child = removed.spawnCalls[0].child
  const helper = removed.spawnCalls[0].options.env?.SSH_ASKPASS as string
  assert.ok(existsSync(helper))
  removed.manager.saveInstances(removed.manager.listInstances().filter(instance => instance.id !== 's2'))
  assert.equal(removed.manager.status('s2'), null)
  assert.ok(child.killCalls.includes('SIGTERM'))
  let disposeSettled = false
  const disposePromise = removed.manager.disposeAsync().then(() => { disposeSettled = true })
  await waitFor(() => child.killCalls.includes('SIGKILL'), 2_000, 'removed tunnel SIGKILL escalation')
  assert.equal(disposeSettled, false, 'a removed instance cannot hide its still-live child from disposeAsync')
  assert.ok(existsSync(helper), 'the helper remains leased until the removed child actually exits')
  child.simulateExit(null, 'SIGKILL')
  await disposePromise
  assert.equal(disposeSettled, true)
  assert.ok(!existsSync(helper), 'the real child exit releases the removed generation helper')
})

test('reconnectStaleTransports skips a null status and keeps probing after one failed connect', () => {
  const connected: string[] = []
  const warnings: Array<{ message: string; error: unknown }> = []
  const rows = [{ id: 'ghost' }, { id: 'err-1' }, { id: 'deg-1' }]
  const sm = {
    listInstances: () => rows,
    status: (id: string) => {
      if (id === 'ghost') return null
      return { phase: id === 'err-1' ? 'error' : 'degraded', requiresUserAction: false }
    },
    connect: (id: string) => {
      connected.push(id)
      if (id === 'err-1') throw new Error('boom')
      return null
    },
  } as unknown as Parameters<typeof reconnectStaleTransports>[0]
  reconnectStaleTransports(sm, () => false, (message, error) => { warnings.push({ message, error }) }, '[flavor]')
  assert.deepEqual(connected, ['err-1', 'deg-1'], 'a null status is skipped and a failed connect never stops the loop')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0]!.message, /\[flavor\] 唤醒重探 err-1 失败：/)
  assert.match(String(warnings[0]!.error), /boom/)
})
