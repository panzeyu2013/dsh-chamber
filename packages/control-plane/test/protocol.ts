/**
 * Protocol-layer unit tests (no real dsh, no fixed ports): pending-table
 * settle-once races, timeout policy (incl. caller-signal-only), rpcId echo
 * validation, generation abort propagation (connection_offline), unknown-code
 * business error passthrough — plus the v4 local host-management surface
 * (spawn → ready, health failure counting → degraded, restart at threshold,
 * child-exit restart, graceful stop). The dsh wire (fetch, spawn) is fully
 * mocked — only node:test and the modules under test.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocketServer } from 'ws'
import type WebSocket from 'ws'
import { call, openEventStream, respond, RpcBusinessError, RpcTransportError, pendingStats } from '../src/dsh-client.ts'
import { createLocalConnection } from '../src/local-connection.ts'
import type { SpawnedDsh } from '../src/local-connection.ts'
import { seedDshHomeDefaults } from '../src/index.ts'

const HOST = 'http://127.0.0.1:17510'

/** A JSON Response body for the mock fetch. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function deferred<T = unknown>() {
  let resolve!: (value?: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = value => res(value as T)
    reject = rej
  })
  return { promise, resolve, reject }
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitFor(predicate: () => unknown, timeoutMs: number, what: string) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await sleep(50)
  }
  throw new Error(`timed out waiting for ${what} (${timeoutMs}ms)`)
}

async function createEventStreamServer() {
  const server = createServer()
  const sockets = new Set<import('node:net').Socket>()
  server.on('connection', socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object')
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    wss,
    async close() {
      for (const client of wss.clients) client.terminate()
      await new Promise<void>(resolve => wss.close(() => resolve()))
      await new Promise<void>(resolve => server.close(() => resolve()))
      for (const socket of sockets) socket.destroy()
    },
  }
}

function nextEventStreamClient(wss: WebSocketServer): Promise<WebSocket> {
  return new Promise(resolve => wss.once('connection', resolve))
}

function eventFrame(rpcId: string, padding = ''): string {
  return JSON.stringify({
    type: 'server-request',
    rpcId,
    method: 'session/status',
    payload: { padding },
  })
}

/** Echo the client-request rpcId and serve the given body. */
function echoFetch(body: any): typeof globalThis.fetch {
  return async (url, init) => {
    const sent = JSON.parse(init!.body as string)
    return jsonResponse({ type: 'server-response', rpcId: sent.rpcId, result: body })
  }
}

/** A fetch mock that never resolves until aborted (honors the signal). */
function hangingFetch(onStarted?: () => void): typeof globalThis.fetch {
  return (url, init) => new Promise<Response>((resolve, reject) => {
    onStarted?.()
    init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
  })
}

// ---------------------------------------------------------------------------
// dsh-client: pending table, timeout policy, echo validation, generation abort
// ---------------------------------------------------------------------------

test('call echoes the minted rpcId and resolves the narrow form', async () => {
  const originalFetch = globalThis.fetch
  let sent: any
  globalThis.fetch = async (url, init) => {
    sent = JSON.parse(init!.body as string)
    return jsonResponse({ type: 'server-response', rpcId: sent.rpcId, result: { ok: true, value: { items: [] } } })
  }
  try {
    const response = await call(HOST, 'session.list', {})
    assert.equal(response.rpcId, sent.rpcId)
    assert.deepEqual(response.result.value, { items: [] })
    assert.equal(pendingStats().size, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('pending settle-once: timeout wins a race against a late response', async () => {
  const originalFetch = globalThis.fetch
  const late = deferred()
  const settledBefore = pendingStats().settled
  globalThis.fetch = (url, init) => new Promise((resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
    late.promise.then(body => resolve(jsonResponse(body)))
  })
  try {
    const attempt = call(HOST, 'session.list', {}, { timeoutMs: 30 })
    await assert.rejects(attempt, error =>
      error instanceof RpcTransportError && error.code === 'request_timeout' && error.status === 0)
    // The response arrives after the timeout: the entry is already settled,
    // so the late path is a no-op — exactly one settle, table drained.
    late.resolve({ type: 'server-response', rpcId: 'late', result: { ok: true, value: {} } })
    await sleep(60)
    const stats = pendingStats()
    assert.equal(stats.size, 0)
    assert.equal(stats.settled - settledBefore, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('timeoutMs: null disables the timer (caller-signal-only policy)', async () => {
  const originalFetch = globalThis.fetch
  const started = deferred()
  globalThis.fetch = hangingFetch(() => started.resolve())
  try {
    const caller = new AbortController()
    const attempt = call(HOST, 'host.pickDirectory', {}, { signal: caller.signal, timeoutMs: null })
    await started.promise
    caller.abort()
    await assert.rejects(attempt, error =>
      error instanceof RpcTransportError && error.code === 'aborted' && error.status === 0)
    assert.equal(pendingStats().size, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('rpcId echo mismatch is a protocol violation', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => jsonResponse({
    type: 'server-response',
    rpcId: 'not-the-sent-id',
    result: { ok: true, value: {} },
  })
  try {
    await assert.rejects(call(HOST, 'session.list', {}), error =>
      error instanceof RpcTransportError && error.code === 'protocol_violation' && error.status === 200)
    assert.equal(pendingStats().size, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('generation abort settles the in-flight unary with connection_offline', async () => {
  const originalFetch = globalThis.fetch
  const started = deferred()
  const generation = new AbortController()
  const settledBefore = pendingStats().settled
  globalThis.fetch = hangingFetch(() => started.resolve())
  try {
    const attempt = call(HOST, 'session.prompt', { sessionId: 's1' }, {
      generationSignal: generation.signal,
      timeoutMs: null,
    })
    await started.promise
    generation.abort()
    await assert.rejects(attempt, error =>
      error instanceof RpcTransportError && error.code === 'connection_offline' && error.status === 0)
    assert.equal(pendingStats().size, 0)
    assert.equal(pendingStats().settled - settledBefore, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('respond honors the generation signal (connection_offline)', async () => {
  const originalFetch = globalThis.fetch
  const started = deferred()
  const generation = new AbortController()
  globalThis.fetch = hangingFetch(() => started.resolve())
  try {
    const attempt = respond(HOST, { rpcId: 'server-minted-1', result: { ok: true, value: {} } }, {
      generationSignal: generation.signal,
      timeoutMs: null,
    })
    await started.promise
    generation.abort()
    await assert.rejects(attempt, error =>
      error instanceof RpcTransportError && error.code === 'connection_offline')
    assert.equal(pendingStats().size, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('event-stream open barrier waits for the real WebSocket upgrade', async () => {
  const server = createServer()
  const sockets = new Set<import('node:net').Socket>()
  server.on('connection', socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  const wss = new WebSocketServer({ noServer: true })
  const upgradeSeen = deferred<void>()
  const releaseUpgrade = deferred<void>()
  server.on('upgrade', (request, socket, head) => {
    upgradeSeen.resolve()
    void releaseUpgrade.promise.then(() => {
      wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request))
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object')
  const abort = new AbortController()
  let opened = false
  const iterator = openEventStream(
    `http://127.0.0.1:${address.port}`,
    '/api/events.mux',
    abort.signal,
    () => { opened = true },
  )
  const pendingFrame = iterator.next()
  try {
    await upgradeSeen.promise
    assert.equal(opened, false, 'TCP/HTTP upgrade arrival is not yet a ready stream')
    releaseUpgrade.resolve()
    await waitFor(() => opened, 1_000, 'event-stream open barrier')
  } finally {
    abort.abort()
    await pendingFrame.catch(() => ({ done: true, value: undefined }))
    for (const client of wss.clients) client.terminate()
    await new Promise<void>(resolve => wss.close(() => resolve()))
    await new Promise<void>(resolve => server.close(() => resolve()))
    for (const socket of sockets) socket.destroy()
  }
})

test('event-stream single-frame maxPayload fails closed with an explicit transport error', async () => {
  const harness = await createEventStreamServer()
  const connected = nextEventStreamClient(harness.wss)
  const iterator = openEventStream(
    harness.baseUrl,
    '/api/events.mux',
    undefined,
    undefined,
    { maxPayloadBytes: 64 },
  )
  const pendingFrame = iterator.next()
  try {
    const peer = await connected
    peer.send('x'.repeat(65))
    await assert.rejects(pendingFrame, error => {
      assert.ok(error instanceof RpcTransportError)
      assert.equal(error.code, 'stream_frame_too_large')
      assert.equal(error.status, 0)
      assert.match(error.message, /exceeds 64 bytes/)
      return true
    })
    await waitFor(() => peer.readyState === 3, 1_000, 'oversized-frame socket termination')
    assert.equal((await iterator.next()).done, true, 'the rejected stream cannot retain or yield later data')
  } finally {
    await harness.close()
  }
})

test('event-stream raw queue frame-count overflow clears data and terminates the stream', async () => {
  const harness = await createEventStreamServer()
  const connected = nextEventStreamClient(harness.wss)
  const opened = deferred<void>()
  const iterator = openEventStream(
    harness.baseUrl,
    '/api/events.host',
    undefined,
    () => opened.resolve(),
    { maxPayloadBytes: 1_024, maxQueueBytes: 1_024, maxQueueFrames: 2 },
  )
  const firstFrame = iterator.next()
  try {
    const peer = await connected
    await opened.promise
    peer.send(eventFrame('first'))
    assert.equal((await firstFrame).value?.rpcId, 'first')

    // The generator is paused at yield, so these raw frames accumulate before
    // any JSON/envelope filtering. The third queued frame must fail closed.
    peer.send(eventFrame('queued-1'))
    peer.send(eventFrame('queued-2'))
    peer.send(eventFrame('must-not-survive'))
    await waitFor(() => peer.readyState === 3, 1_000, 'frame-count overflow socket termination')
    await assert.rejects(iterator.next(), error => {
      assert.ok(error instanceof RpcTransportError)
      assert.equal(error.code, 'stream_queue_overflow')
      assert.match(error.message, /2 frames or 1024 bytes/)
      return true
    })
    assert.equal((await iterator.next()).done, true, 'overflowed raw frames were cleared')
  } finally {
    await harness.close()
  }
})

test('event-stream raw queue byte overflow clears data and terminates the stream', async () => {
  const harness = await createEventStreamServer()
  const connected = nextEventStreamClient(harness.wss)
  const opened = deferred<void>()
  const queuedFrame = eventFrame('queued', 'x'.repeat(32))
  const queuedFrameBytes = Buffer.byteLength(queuedFrame)
  const queueByteLimit = queuedFrameBytes * 2 - 1
  const iterator = openEventStream(
    harness.baseUrl,
    '/api/events.mux',
    undefined,
    () => opened.resolve(),
    { maxPayloadBytes: 1_024, maxQueueBytes: queueByteLimit, maxQueueFrames: 8 },
  )
  const firstFrame = iterator.next()
  try {
    const peer = await connected
    await opened.promise
    peer.send(eventFrame('first'))
    assert.equal((await firstFrame).value?.rpcId, 'first')

    peer.send(queuedFrame)
    peer.send(queuedFrame)
    await waitFor(() => peer.readyState === 3, 1_000, 'byte overflow socket termination')
    await assert.rejects(iterator.next(), error => {
      assert.ok(error instanceof RpcTransportError)
      assert.equal(error.code, 'stream_queue_overflow')
      assert.match(error.message, new RegExp(`8 frames or ${queueByteLimit} bytes`))
      return true
    })
    assert.equal((await iterator.next()).done, true, 'overflowed raw bytes were cleared')
  } finally {
    await harness.close()
  }
})

test('unknown business error code passes through code/message/details verbatim', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = echoFetch({
    ok: false,
    error: { code: 'model-42-discontinued', message: 'newer host error', details: { model: 'm-42', hint: 'select another' } },
  })
  try {
    await assert.rejects(call(HOST, 'session.prompt', { sessionId: 's1' }), error => {
      assert.ok(error instanceof RpcBusinessError)
      assert.equal(error.code, 'model-42-discontinued')
      assert.equal(error.message, 'newer host error')
      assert.equal(error.details.model, 'm-42')
      assert.equal(error.details.hint, 'select another')
      return true
    })
    assert.equal(pendingStats().size, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('malformed error branch degrades to unknown_rpc_code instead of dropping', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = echoFetch({ ok: false, error: 'not-an-object' })
  try {
    await assert.rejects(call(HOST, 'session.list', {}), error =>
      error instanceof RpcBusinessError && error.code === 'unknown_rpc_code')
  } finally {
    globalThis.fetch = originalFetch
  }
})

// ---------------------------------------------------------------------------
// local-connection (v4 host management): spawn/ready, health, restart, stop
// ---------------------------------------------------------------------------

function mockCatalog() {
  const row: { connectionId: string; status?: string } = { connectionId: 'local' }
  return {
    getConnection: () => row,
    upsertConnection: (next: { status?: string }) => {
      if (next.status !== undefined) row.status = next.status
    },
  }
}

const quietLogger = { log: () => {}, warn: () => {}, error: () => {} }

let spawnCounter = 0
/** A spawn mock that always succeeds on a fresh port. */
function mockSpawn(): Promise<SpawnedDsh> {
  spawnCounter += 1
  return Promise.resolve({
    child: { on: () => {}, exitCode: null },
    port: 17910 + spawnCounter,
    stop: async () => {},
  })
}

/** A describe mock: healthy by default; `state.healthy` toggles failures. */
function mockDescribe() {
  const state = { healthy: true }
  return {
    state,
    describeCapabilities: async () => {
      if (!state.healthy) throw new Error('mock describe failure')
      return { value: { attachedSessions: 0 }, cachedAt: Date.now() }
    },
  }
}

test('start spawns and lands on ready; stop terminates and lands on stopped', async () => {
  const describe = mockDescribe()
  const connection = createLocalConnection({
    stateDir: '/tmp/none',
    dshHome: '/tmp/none',
    dshWorkspacePath: '/tmp/none',
    catalog: mockCatalog(),
    logger: quietLogger,
    deps: { spawnDsh: mockSpawn, describeCapabilities: describe.describeCapabilities },
  })
  assert.equal(connection.getState(), 'stopped')
  const row = await connection.start()
  assert.equal(connection.getState(), 'ready')
  assert.ok(connection.getDshPort() !== null)
  assert.equal(row?.status, 'ready')
  // Idempotent: a second start does not spawn again.
  await connection.start()
  assert.equal(spawnCounter, 1)
  await connection.stop()
  assert.equal(connection.getState(), 'stopped')
  assert.equal(connection.getDshPort(), null)
})

test('a spawn failure is fail-loud: state lands on error and start() rejects', async () => {
  const connection = createLocalConnection({
    stateDir: '/tmp/none',
    dshHome: '/tmp/none',
    dshWorkspacePath: '/tmp/none',
    catalog: mockCatalog(),
    logger: quietLogger,
    deps: {
      spawnDsh: async () => { throw new Error('port occupied after 5 attempts') },
      describeCapabilities: mockDescribe().describeCapabilities,
    },
  })
  await assert.rejects(connection.start(), /port occupied/)
  assert.equal(connection.getState(), 'error')
  assert.match(connection.getError() ?? '', /port occupied/)
})

test('a catalog write failure prevents publishing the next lifecycle state', async () => {
  let spawns = 0
  const connection = createLocalConnection({
    stateDir: '/tmp/none',
    dshHome: '/tmp/none',
    dshWorkspacePath: '/tmp/none',
    catalog: {
      getConnection: () => ({ connectionId: 'local', status: 'stopped' }),
      upsertConnection: () => { throw new Error('catalog disk unavailable') },
    },
    logger: quietLogger,
    deps: {
      spawnDsh: async () => { spawns += 1; return mockSpawn() },
      describeCapabilities: mockDescribe().describeCapabilities,
    },
  })
  await assert.rejects(connection.start(), /catalog disk unavailable/)
  assert.equal(connection.getState(), 'stopped')
  assert.equal(spawns, 0)
})

test('health failures count into degraded; success resets; threshold triggers a restart', async () => {
  const describe = mockDescribe()
  const connection = createLocalConnection({
    stateDir: '/tmp/none',
    dshHome: '/tmp/none',
    dshWorkspacePath: '/tmp/none',
    catalog: mockCatalog(),
    logger: quietLogger,
    options: { healthIntervalMs: 30, healthProbeTimeoutMs: 1000, restartFailureThreshold: 3, failureThrottleMs: 0 },
    deps: { spawnDsh: mockSpawn, describeCapabilities: describe.describeCapabilities },
  })
  await connection.start()
  assert.equal(connection.getState(), 'ready')

  // First failure → degraded, counter 1.
  describe.state.healthy = false
  await waitFor(() => connection.getState() === 'degraded', 3000, 'degraded state')
  assert.equal(connection.getConsecutiveFailures(), 1)

  // Success clears the counter and returns to ready.
  describe.state.healthy = true
  await waitFor(() => connection.getState() === 'ready', 3000, 'recovery to ready')
  assert.equal(connection.getConsecutiveFailures(), 0)

  // Three consecutive failures (threshold 3) trigger the restart sequence:
  // a fresh spawn lands the machine back on ready. The restart itself is
  // fast (no backoff on the first attempt), so observe the spawn side effect
  // rather than the transient 'restarting' state.
  describe.state.healthy = false
  const before = spawnCounter
  await waitFor(() => spawnCounter > before, 5000, 'restart spawn')
  await connection.stop()
  assert.equal(connection.getState(), 'stopped')
})

test('a dead child skips counting and restarts immediately', async () => {
  const describe = mockDescribe()
  // A single "process" whose exit listener is captured and fired by the test.
  const hooks: { exit?: (code: number | null, sig: string | null) => void } = {}
  const child: SpawnedDsh = {
    child: {
      on: (event: string, listener: any) => {
        if (event === 'exit') hooks.exit = listener
        return undefined
      },
      exitCode: null,
    },
    port: 17950,
    stop: async () => {},
  }
  const spawns: () => Promise<SpawnedDsh> = async () => child
  const connection = createLocalConnection({
    stateDir: '/tmp/none',
    dshHome: '/tmp/none',
    dshWorkspacePath: '/tmp/none',
    catalog: mockCatalog(),
    logger: quietLogger,
    options: { healthIntervalMs: 0, restartWindowMs: 5000 },
    deps: { spawnDsh: spawns, describeCapabilities: describe.describeCapabilities },
  })
  await connection.start()
  // Simulate process death: fire the exit listener (the local-connection
  // restarts immediately without counting a failure).
  child.child.exitCode = 1
  hooks.exit?.(1, null)
  await waitFor(() => connection.getState() === 'restarting', 3000, 'restart on child death')
  await waitFor(() => connection.getState() === 'ready', 3000, 'ready after respawn')
  assert.equal(connection.getConsecutiveFailures(), 0)
  await connection.stop()
})

test('restart window exhaustion lands on restart-exhausted (manual start required)', async () => {
  const describe = mockDescribe()
  describe.state.healthy = false
  const spawns = async (): Promise<SpawnedDsh> => {
    spawnCounter += 1
    // Every respawn fails the health probe → the restart loop counts up.
    return {
      child: { on: () => {}, exitCode: null },
      port: 17970 + spawnCounter,
      stop: async () => {},
    }
  }
  const connection = createLocalConnection({
    stateDir: '/tmp/none',
    dshHome: '/tmp/none',
    dshWorkspacePath: '/tmp/none',
    catalog: mockCatalog(),
    logger: quietLogger,
    options: {
      healthIntervalMs: 20,
      healthProbeTimeoutMs: 500,
      restartFailureThreshold: 1,
      failureThrottleMs: 0,
      restartBackoffFloorMs: 10,
      restartBackoffCeilMs: 20,
      restartWindowMs: 60_000,
      maxRestartsInWindow: 3,
    },
    deps: { spawnDsh: spawns, describeCapabilities: describe.describeCapabilities },
  })
  await connection.start()
  await waitFor(() => connection.getState() === 'restart-exhausted', 8000, 'restart-exhausted')
  assert.ok(connection.getConsecutiveFailures() >= 1)
  await connection.stop()
})

test('seedDshHomeDefaults writes a zh locale default once and never touches an existing document', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-chamber-seed-'))
  try {
    const dshHome = join(root, 'dsh-home')
    mkdirSync(dshHome, { recursive: true })

    // First run: the seed lands and the document parses as locale.preference=zh.
    assert.equal(seedDshHomeDefaults(dshHome), true)
    assert.equal(readFileSync(join(dshHome, 'settings.yaml'), 'utf8'), 'locale:\n  preference: zh\n')

    // Second call: idempotent, no rewrite.
    assert.equal(seedDshHomeDefaults(dshHome), false)
    assert.equal(readFileSync(join(dshHome, 'settings.yaml'), 'utf8'), 'locale:\n  preference: zh\n')

    // A user's own document is never touched.
    const custom = join(root, 'custom-home')
    mkdirSync(custom, { recursive: true })
    writeFileSync(join(custom, 'settings.yaml'), 'locale:\n  preference: en\n', { mode: 0o600 })
    assert.equal(seedDshHomeDefaults(custom), false)
    assert.equal(readFileSync(join(custom, 'settings.yaml'), 'utf8'), 'locale:\n  preference: en\n')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
