/**
 * Transport manager — part 2: load recovery, auth-failure terminality, degraded
 * → reconnect with jittered backoff, real dsh identity verification through the
 * tunnel, ring-buffer bounds and disconnect. Sibling parts: transport-manager,
 * transport-exec-and-registry, transport-providers (harness: test/support).
 */

import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SpawnOptions } from 'node:child_process'
import { createTransportManager, jitteredBackoffMs, RING_BUFFER_LIMIT, RING_LOG_MESSAGE_MAX_CHARS } from '../../transport-manager.ts'
import { CHAMBER_HOST_PACKAGES } from '../../control-plane-module.ts'
import { CHILD_LINE_MAX_CHARS } from '../../bounded-lines.ts'
import { probeChamberHostLive, sshProvider, verifyDshEndpoint } from '../../ssh-provider.ts'
import { silentLogger, FakeChild, makeManager, tempDir, sleep, waitFor, readyThenDrop, EXEC_INSTANCE, type StatusWithNoUrlLeak, type ManagerHarness } from '../support/transport-manager-harness.ts'

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
  const { manager, spawnCalls } = await readyManager(t)
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
  manager.saveInstances([{ id: 's1', label: 'home', host: 'h.example.com', remotePort: 2222 }])
  manager.connect('s1')
  await waitFor(() => manager.status('s1')!.phase === 'ready', 3000, 'ready after the dsh identity handshake')
  assert.equal(manager.readyUrl('s1'), `http://127.0.0.1:${port}`)
  assert.ok(manager.logs('s1').some(entry => entry.message.includes('transport ready')), 'the handshake-gated ready is logged')
  assert.equal(sessionListCalls, 0, 'the attach probe never re-reads the session list')
  manager.dispose()
})
test('a session-list-heavy dsh destination attaches via the fixed-size identity probe', async t => {
  // 2026 probe-contract regression: the endpoint's session/list answer grows
  // with session data (here a 1 MiB+ list that would overflow the legacy
  // probe cap). The identity probe never reads it, so attach stays healthy.
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
  manager.saveInstances([{ id: 's1', label: 'home', host: 'h.example.com', remotePort: 2222 }])
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
  manager.saveInstances([{ id: 's1', label: 'home', host: 'h.example.com', remotePort: 2222 }])
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
  // signature re-probe's LEGACY session/list arm answers a valid
  // server-response envelope: positive dsh evidence, so the detail tells the
  // user the destination IS dsh ("check or upgrade") instead of claiming
  // "not dsh".
  let calls = 0
  const inconsistentDshPort = await listen(t, (req, res) => {
    calls++
    if (req.method === 'POST' && req.url === '/api/session/list' && calls > 1) {
      readBody(req, body => {
        const envelope = JSON.parse(body) as { rpcId?: unknown }
        jsonReply(res, { type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value: {} } })
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
  // branch. Same discipline as the deleted per-package probes:
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
  // booted before the injection). Kept from the deleted per-package probes —
  // the classification lives in the ONE generic path now.
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
