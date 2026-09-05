/**
 * M1 acceptance self-tests for the protocol-layer additions that survive the
 * v4 refactor:
 *   - probeHostIdentity: the unified host-identity probe — the fixed-size
 *     session/canOpenWorkspacePath boolean handshake, its legacy session/list
 *     fallback on an HTTP 404 (with the mandatory warn), the boolean-value
 *     requirement, the 64 KiB response cap, and the 401/timeout/abort/
 *     generation semantics;
 *   - the unary default 30s timeout policy (control).
 * Run directly: node packages/control-plane/test/m1-dsh-client.test.ts
 * Also run via the root test:control-plane script (pnpm run test:control-plane)
 * per AGENTS.md Validation; the integration smoke test lives at
 * test/smoke.test.ts and runs separately via pnpm run smoke.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  probeHostIdentity,
  call,
  RpcTransportError,
} from '../src/dsh-client.ts'
import { HOST_IDENTITY_METHOD, LEGACY_HOST_PROBE_METHOD } from '../src/rpc-envelope.ts'
import { DEFAULT_DSH_START_PORT } from '../src/spawn-dsh.ts'
import { clearAuthCookie, registerAuthCookie } from '../src/browser-auth-cookie.ts'

const HOST = `http://127.0.0.1:${DEFAULT_DSH_START_PORT}`

/** Unique baseUrl per test — nothing module-global remains keyed by baseUrl
 *  (the old capability cache is gone with describeCapabilities), but unique
 *  hosts keep the auth-cookie bookkeeping per test isolated. */
let portCounter = 0
function uniqueHost(): string {
  portCounter += 1
  return `http://127.0.0.1:${DEFAULT_DSH_START_PORT + portCounter}`
}

function jsonResponse(body: any, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** One recorded fetch: {url, init, body} — body is the parsed client-request. */
interface FetchEntry {
  url: string
  init: any
  body: any
}

type FetchHandler = (entry: FetchEntry) => Promise<Response>

interface FetchRecorder {
  calls: FetchEntry[]
  setHandler(next: FetchHandler): void
  restore(): void
}

/** Replace globalThis.fetch with a recorder; onCall receives {url, init, body}. */
function fetchRecorder(onCall: FetchHandler): FetchRecorder {
  const calls: FetchEntry[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (url, init) => {
    const entry: FetchEntry = { url: String(url), init, body: JSON.parse(init!.body as string) }
    calls.push(entry)
    return onCall(entry)
  }
  return {
    calls,
    setHandler(next) { onCall = next },
    restore() { globalThis.fetch = originalFetch },
  }
}

/** Replace globalThis.setTimeout with a probe recording every delay. */
function timerProbe() {
  const delays: Array<number | undefined> = []
  const originalSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    delays.push(ms)
    return originalSetTimeout(fn, ms, ...args)
  }) as typeof globalThis.setTimeout
  return {
    delays,
    restore() { globalThis.setTimeout = originalSetTimeout },
  }
}

/** A fetch mock that never resolves until the composed signal aborts. */
function hangingOnSignal(entry: FetchEntry): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    entry.init.signal?.addEventListener('abort',
      () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
  })
}

/** A warn recorder for the required probeHostIdentity logger seam. */
function warnRecorder() {
  const warnings: string[] = []
  return { logger: { warn(line: string) { warnings.push(line) } }, get warnings() { return warnings } }
}

/** Route by client-request method (the HTTP bridge routes claimed Remote
 *  namespaces; unclaimed ones answer 404). */
function routeHost(handlers: Record<string, FetchHandler>): FetchHandler {
  return entry => {
    const handler = handlers[entry.body.method]
    if (handler !== undefined) return handler(entry)
    return Promise.resolve(new Response('not found', { status: 404 }))
  }
}

/** The identity-method handler: ok:true + the given value unless 404. */
function identityAnswer(value: unknown, notFound = false): FetchHandler {
  return entry => {
    if (notFound) return Promise.resolve(new Response('not found', { status: 404 }))
    return Promise.resolve(jsonResponse({
      type: 'server-response', rpcId: entry.body.rpcId, result: { ok: true, value },
    }))
  }
}


/** Echo the client-request rpcId and serve the given result. */
function echoResult(result: any): FetchHandler {
  return entry => Promise.resolve(jsonResponse({
    type: 'server-response', rpcId: entry.body.rpcId, result,
  }))
}

async function withFetchHandler(handler: FetchHandler, fn: (recorder: FetchRecorder) => unknown) {
  const recorder = fetchRecorder(handler)
  try {
    return await fn(recorder)
  } finally {
    recorder.restore()
  }
}

// ---------------------------------------------------------------------------
// unary timeout policy (control) + probeHostIdentity host-identity probe
// ---------------------------------------------------------------------------

test('unary injects the 0.1.2 browser-auth cookie for a bootstrapped instance', async () => {
  // review-round3c P0: after the spawn-time token exchange, every direct
  // probe/unary call for the instance carries the minted cookie.
  const host = uniqueHost()
  clearAuthCookie(host)
  try {
    await withFetchHandler(echoResult({ ok: true, value: { items: [] } }), async recorder => {
      await call(host, 'session/list', { args: { _request: {} } })
      assert.equal(recorder.calls[0].init.headers.cookie, undefined)
      registerAuthCookie(host, 'browser-auth=session-value')
      await call(host, 'session/list', { args: { _request: {} } })
      assert.equal(recorder.calls[1].init.headers.cookie, 'browser-auth=session-value')
    })
  } finally {
    clearAuthCookie(host)
  }
})

test('unary keeps the default 30s timer', async () => {
  const probe = timerProbe()
  const recorder = fetchRecorder(hangingOnSignal)
  const caller = new AbortController()
  const attempt = call(HOST, 'session/list', { args: { _request: {} } }, { signal: caller.signal })
  try {
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(probe.delays, [30000])
    caller.abort()
    await assert.rejects(attempt,
      error => error instanceof RpcTransportError && error.code === 'aborted')
  } finally {
    caller.abort()
    probe.restore()
    recorder.restore()
  }
})

test('probeHostIdentity passes on the identity method and never touches session/list', async () => {
  const host = uniqueHost()
  const warn = warnRecorder()
  await withFetchHandler(routeHost({ [HOST_IDENTITY_METHOD]: identityAnswer(true) }), async recorder => {
    const verdict = await probeHostIdentity(host, { logger: warn.logger })
    assert.equal(verdict, true)
    assert.equal(recorder.calls.length, 1)
    assert.equal(new URL(recorder.calls[0].url).pathname, '/api/session/canOpenWorkspacePath')
    assert.deepEqual(recorder.calls[0].body.payload, { args: {} })
    assert.equal(recorder.calls[0].body.method, HOST_IDENTITY_METHOD)
    // The health-path probe must never read the session list.
    assert.equal(recorder.calls.some(callEntry => callEntry.body.method === LEGACY_HOST_PROBE_METHOD), false)
    assert.deepEqual(warn.warnings, [], 'no fallback → no warning')
  })
})

test('probeHostIdentity: value false is equally healthy', async () => {
  // Only method presence / protocol correctness / controller assembly is
  // under test — the host's platform answer is not a probe verdict.
  const host = uniqueHost()
  const warn = warnRecorder()
  await withFetchHandler(routeHost({ [HOST_IDENTITY_METHOD]: identityAnswer(false) }), async recorder => {
    const verdict = await probeHostIdentity(host, { logger: warn.logger })
    assert.equal(verdict, true)
    assert.equal(recorder.calls.length, 1)
  })
})

test('probeHostIdentity fails loud on a non-boolean value and a malformed envelope', async () => {
  for (const value of [{}, { attachedSessions: 1 }, 'yes', null]) {
    const host = uniqueHost()
    await withFetchHandler(routeHost({ [HOST_IDENTITY_METHOD]: identityAnswer(value) }), async recorder => {
      await assert.rejects(probeHostIdentity(host, { logger: warnRecorder().logger }),
        error => error instanceof RpcTransportError && error.code === 'protocol_violation')
      assert.equal(recorder.calls.length, 1, `one identity call for value ${JSON.stringify(value)}`)
    })
  }
  const host = uniqueHost()
  await withFetchHandler(async () => jsonResponse({ hello: 'world' }), async recorder => {
    await assert.rejects(probeHostIdentity(host, { logger: warnRecorder().logger }),
      error => error instanceof RpcTransportError && error.code === 'protocol_violation')
    assert.equal(recorder.calls.length, 1)
  })
})

test('probeHostIdentity: an HTTP 404 with a successful legacy fallback passes WITH a warning', async () => {
  const host = uniqueHost()
  const warn = warnRecorder()
  let legacyCalls = 0
  const legacyHandler: FetchHandler = async entry => {
    legacyCalls += 1
    assert.equal(entry.body.method, LEGACY_HOST_PROBE_METHOD)
    assert.deepEqual(entry.body.payload, { args: { _request: {} } })
    assert.equal(new URL(entry.url).pathname, '/api/session/list')
    return jsonResponse({ type: 'server-response', rpcId: entry.body.rpcId, result: { ok: true, value: { items: [] } } })
  }
  await withFetchHandler(routeHost({ [HOST_IDENTITY_METHOD]: identityAnswer(null, true), [LEGACY_HOST_PROBE_METHOD]: legacyHandler }), async recorder => {
    const verdict = await probeHostIdentity(host, { logger: warn.logger })
    assert.equal(verdict, true)
    assert.equal(recorder.calls.length, 2, 'identity 404 → legacy fallback')
    assert.equal(legacyCalls, 1)
    assert.equal(warn.warnings.length, 1)
    assert.match(warn.warnings[0], /404/)
    assert.match(warn.warnings[0], /legacy session\/list/)
  })
})

test('probeHostIdentity: 404 on BOTH methods fails loud WITHOUT a fallback warning', async () => {
  // A transient modern-tree 404 (routes still mounting) or a both-404 failure
  // never reaches a fallback — the warning is reserved for the successful
  // legacy fallback that proves a pre-identity tree.
  const host = uniqueHost()
  const warn = warnRecorder()
  await withFetchHandler(routeHost({}), async recorder => {
    await assert.rejects(probeHostIdentity(host, { logger: warn.logger }),
      error => error instanceof RpcTransportError && error.code === 'protocol_violation')
    assert.equal(recorder.calls.length, 2, 'identity 404 + legacy 404')
    assert.deepEqual(warn.warnings, [], 'no successful fallback → no warning')
  })
})

test('probeHostIdentity: a legacy fallback that throws non-404 propagates that failure without a warning', async () => {
  const host = uniqueHost()
  const warn = warnRecorder()
  await withFetchHandler(routeHost({
    [HOST_IDENTITY_METHOD]: identityAnswer(null, true),
    [LEGACY_HOST_PROBE_METHOD]: async () => new Response('denied', { status: 503 }),
  }), async recorder => {
    await assert.rejects(probeHostIdentity(host, { logger: warn.logger }),
      error => error instanceof RpcTransportError && error.status === 503)
    assert.equal(recorder.calls.length, 2)
    assert.deepEqual(warn.warnings, [], 'only a SUCCESSFUL legacy fallback warns')
  })
})

test('probeHostIdentity enforces the 64 KiB identity-response cap', async () => {
  const host = uniqueHost()
  const bloat = createBloatHandler(64 * 1024 + 1)
  await withFetchHandler(bloat, async recorder => {
    await assert.rejects(probeHostIdentity(host, { logger: warnRecorder().logger }),
      error => error instanceof RpcTransportError && error.code === 'response_too_large')
    assert.equal(recorder.calls.length, 1)
  })
})

test('probeHostIdentity classifies 401 and timeout as loud failures (no fallback)', async () => {
  // The 0.1.2 browser-auth gate answers 401 on every /api route: fail loud,
  // never downgrade to the legacy probe (the caller's 401 handling owns it).
  const host = uniqueHost()
  await withFetchHandler(async () => new Response('unauthorized', { status: 401 }), async recorder => {
    await assert.rejects(probeHostIdentity(host, { logger: warnRecorder().logger }),
      error => error instanceof RpcTransportError && error.status === 401)
    assert.equal(recorder.calls.length, 1, '401 → no legacy fallback')
  })

  const silentHost = uniqueHost()
  await withFetchHandler(hangingOnSignal, async recorder => {
    await assert.rejects(probeHostIdentity(silentHost, { logger: warnRecorder().logger, timeoutMs: 30 }),
      error => error instanceof RpcTransportError && error.code === 'request_timeout')
    assert.equal(recorder.calls.length, 1, 'timeout → no legacy fallback')
  })
})

test('probeHostIdentity honors caller abort and generation death', async () => {
  const host = uniqueHost()
  const recorder = fetchRecorder(hangingOnSignal)
  const generation = new AbortController()
  try {
    const attempt = probeHostIdentity(host, { generationSignal: generation.signal, logger: warnRecorder().logger })
    await new Promise(resolve => setImmediate(resolve))
    generation.abort()
    await assert.rejects(attempt,
      error => error instanceof RpcTransportError && error.code === 'connection_offline')
  } finally {
    recorder.restore()
  }
  const host2 = uniqueHost()
  const caller = new AbortController()
  const recorder2 = fetchRecorder(hangingOnSignal)
  try {
    const attempt = probeHostIdentity(host2, { signal: caller.signal, logger: warnRecorder().logger })
    await new Promise(resolve => setImmediate(resolve))
    caller.abort()
    await assert.rejects(attempt,
      error => error instanceof RpcTransportError && error.code === 'aborted')
  } finally {
    caller.abort()
    recorder2.restore()
  }
})

test('probeHostIdentity warns at most once per baseUrl for a persistent legacy host', async () => {
  // The legacy-fallback warning is a property of the HOST (pre-identity
  // runtime tree): the periodic 30s health probe must not re-announce it on
  // every cycle.
  const host = uniqueHost()
  const warn = warnRecorder()
  const handler = routeHost({
    [HOST_IDENTITY_METHOD]: identityAnswer(null, true),
    [LEGACY_HOST_PROBE_METHOD]: async entry => jsonResponse({
      type: 'server-response', rpcId: entry.body.rpcId, result: { ok: true, value: { items: [] } },
    }),
  })
  await withFetchHandler(handler, async recorder => {
    assert.equal(await probeHostIdentity(host, { logger: warn.logger }), true)
    assert.equal(warn.warnings.length, 1, 'first successful fallback warns')
    assert.equal(await probeHostIdentity(host, { logger: warn.logger }), true)
    assert.equal(recorder.calls.length, 4, 'both probes keep falling back per call')
    assert.equal(warn.warnings.length, 1, 'the second successful fallback on the same host stays silent')
  })
})

test('probeHostIdentity: a transient modern-tree 404 window never warns and self-heals', async () => {
  // The identity route is not mounted yet (spawn window): identity 404 +
  // legacy 404 fail loud WITHOUT a warning (no fallback happened). Once the
  // identity route mounts, the probe passes directly — still no warning.
  const host = uniqueHost()
  const warn = warnRecorder()
  const recorder = fetchRecorder(async entry => {
    if (entry.body.method === HOST_IDENTITY_METHOD) {
      return jsonResponse({ type: 'server-response', rpcId: entry.body.rpcId, result: { ok: true, value: true } })
    }
    return new Response('not found', { status: 404 })
  })
  try {
    await withFetchHandler(routeHost({}), async () => {
      await assert.rejects(probeHostIdentity(host, { logger: warn.logger }),
        error => error instanceof RpcTransportError && error.code === 'protocol_violation')
    })
    assert.deepEqual(warn.warnings, [], 'a both-404 transient window is quiet')
    recorder.setHandler(async entry => {
      if (entry.body.method === HOST_IDENTITY_METHOD) {
        return jsonResponse({ type: 'server-response', rpcId: entry.body.rpcId, result: { ok: true, value: true } })
      }
      return new Response('not found', { status: 404 })
    })
    const verdict = await probeHostIdentity(host, { logger: warn.logger })
    assert.equal(verdict, true)
    assert.deepEqual(warn.warnings, [], 'an identity-method success never warns')
  } finally {
    recorder.restore()
  }
})

test('probeHostIdentity enforces the 64 KiB cap on the STREAMED path (no content-length)', async () => {
  const host = uniqueHost()
  const bloat = streamBloatHandler(64 * 1024 + 1024)
  await withFetchHandler(bloat, async recorder => {
    await assert.rejects(probeHostIdentity(host, { logger: warnRecorder().logger }),
      error => error instanceof RpcTransportError && error.code === 'response_too_large')
    assert.equal(recorder.calls.length, 1)
  })
})

test('call rejects an invalid per-call maxResponseBytes before any request', async () => {
  const recorder = fetchRecorder(async () => {
    throw new Error('must not be reached: an invalid cap is refused before the fetch')
  })
  try {
    for (const invalid of [0, -1, 1.5, Number.NaN]) {
      await assert.rejects(call(HOST, 'session/list', { args: { _request: {} } }, { maxResponseBytes: invalid }),
        error => error instanceof RpcTransportError && error.code === 'protocol_violation'
          && /maxResponseBytes must be a positive safe integer/.test(error.message))
    }
    assert.equal(recorder.calls.length, 0, 'invalid caps never reach the wire')
  } finally {
    recorder.restore()
  }
})

test('call honors a per-call cap RAISE: 16 MiB accepts a ~2 MiB body the 1 MiB default rejects', async () => {
  // The B1 settings/describe widening rides exactly this option: a
  // legitimately large settings response (1 MiB < size ≤ 16 MiB) must be
  // readable when the caller raises the per-call cap, and still rejected
  // under the default 1 MiB cap.
  const padding = 'x'.repeat(2 * 1024 * 1024)
  const bigValue = { writable: true, namespaces: [], padding }
  const host = uniqueHost()
  await withFetchHandler(echoResult({ ok: true, value: bigValue }), async recorder => {
    const wide = await call(host, 'settings/describe', { args: {} }, { maxResponseBytes: 16 * 1024 * 1024 })
    assert.equal(wide.result.ok, true)
    assert.equal(recorder.calls.length, 1)
  })
  const host2 = uniqueHost()
  await withFetchHandler(echoResult({ ok: true, value: bigValue }), async recorder => {
    await assert.rejects(call(host2, 'settings/describe', { args: {} }),
      error => error instanceof RpcTransportError && error.code === 'response_too_large')
    assert.equal(recorder.calls.length, 1)
  })
})

/** A fetch mock answering an oversized 200 body WITHOUT a content-length
 *  header (the streamed-accumulation path of readBoundedJson). */
function streamBloatHandler(byteLength: number): FetchHandler {
  const chunkBytes = 32 * 1024
  return () => Promise.resolve(new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      let sent = 0
      const pump = () => {
        try {
          while (sent < byteLength) {
            controller.enqueue(new Uint8Array(chunkBytes).fill(0x61))
            sent += chunkBytes
          }
          controller.close()
        } catch {
          // reader cancellation after the cap tripped — expected
        }
      }
      // Defer one microtask so the reader is attached before any enqueue.
      queueMicrotask(pump)
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } }))
}

/** A fetch mock answering an oversized 200 body (used for the 64 KiB cap). */
function createBloatHandler(byteLength: number): FetchHandler {
  return () => Promise.resolve(new Response(JSON.stringify({ padding: 'x'.repeat(byteLength) }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }))
}
