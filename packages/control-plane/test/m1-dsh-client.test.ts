/**
 * M1 acceptance self-tests for the protocol-layer additions that survive the
 * v4 refactor:
 *   - describeCapabilities: generation-scoped session/list probe snapshot
 *     cache (hit/force/refetch, generation abort invalidation, in-flight
 *     abort, no caching of failures);
 *   - the unary default 30s timeout policy (control).
 * Run directly: node packages/control-plane/test/m1-dsh-client.test.ts
 * Also run via the root test:control-plane script (pnpm run test:control-plane)
 * per AGENTS.md Validation; the integration smoke test lives at
 * test/smoke.test.ts and runs separately via pnpm run smoke.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  describeCapabilities,
  call,
  RpcTransportError,
} from '../src/dsh-client.ts'
import { DEFAULT_DSH_START_PORT } from '../src/spawn-dsh.ts'
import { clearAuthCookie, registerAuthCookie } from '../src/browser-auth-cookie.ts'

const HOST = `http://127.0.0.1:${DEFAULT_DSH_START_PORT}`

/** Unique baseUrl per test — the capability cache is module-global and keyed by baseUrl. */
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

/** A successful session/list value. */
function describeValue() {
  return { items: [{ sessionId: 's1' }] }
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
// unary timeout policy (control) + describeCapabilities snapshot cache
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

test('describeCapabilities caches per generation; force and new generations refetch', async () => {
  const host = uniqueHost()
  await withFetchHandler(echoResult({ ok: true, value: describeValue() }), async recorder => {
    const generation = new AbortController()
    const first = await describeCapabilities(host, { generationSignal: generation.signal })
    assert.equal(recorder.calls.length, 1)
    assert.equal(new URL(recorder.calls[0].url).pathname, '/api/session/list')
    assert.deepEqual(recorder.calls[0].body.payload, { args: { _request: {} } })
    const firstItems = (first.value as { items: Array<{ sessionId: string }> }).items
    assert.equal(firstItems[0].sessionId, 's1')
    assert.equal(typeof first.cachedAt, 'number')

    const hit = await describeCapabilities(host, { generationSignal: generation.signal })
    assert.equal(recorder.calls.length, 1)
    assert.equal(hit.value, first.value)
    assert.equal(hit.cachedAt, first.cachedAt)

    const forced = await describeCapabilities(host, { generationSignal: generation.signal, force: true })
    assert.equal(recorder.calls.length, 2)
    assert.notEqual(forced.value, first.value)
    assert.ok(forced.cachedAt >= first.cachedAt)

    const nextGeneration = new AbortController()
    const fresh = await describeCapabilities(host, { generationSignal: nextGeneration.signal })
    assert.equal(recorder.calls.length, 3)
    assert.notEqual(fresh.value, first.value)
  })
})

test('describeCapabilities: generation abort invalidates the snapshot', async () => {
  const host = uniqueHost()
  await withFetchHandler(echoResult({ ok: true, value: describeValue() }), async recorder => {
    const generation = new AbortController()
    await describeCapabilities(host, { generationSignal: generation.signal })
    assert.equal(recorder.calls.length, 1)
    generation.abort()

    await assert.rejects(describeCapabilities(host, { generationSignal: generation.signal }),
      error => error instanceof RpcTransportError && error.code === 'connection_offline')
    assert.equal(recorder.calls.length, 1)

    const next = new AbortController()
    const fresh = await describeCapabilities(host, { generationSignal: next.signal })
    assert.equal(recorder.calls.length, 2)
    assert.deepEqual(fresh.value, describeValue())
  })
})

test('describeCapabilities: an in-flight fetch aborted by generation death leaves no cache behind', async () => {
  const host = uniqueHost()
  const recorder = fetchRecorder(hangingOnSignal)
  const generation = new AbortController()
  const attempt = describeCapabilities(host, { generationSignal: generation.signal })
  try {
    await new Promise(resolve => setImmediate(resolve))
    generation.abort()
    await assert.rejects(attempt,
      error => error instanceof RpcTransportError && error.code === 'connection_offline')
    recorder.setHandler(echoResult({ ok: true, value: describeValue() }))
    const fresh = await describeCapabilities(host, { generationSignal: new AbortController().signal })
    assert.equal(recorder.calls.length, 2)
    assert.deepEqual(fresh.value, describeValue())
  } finally {
    recorder.restore()
  }
})

test('describeCapabilities never caches transport failures', async () => {
  const host = uniqueHost()
  const recorder = fetchRecorder(() => Promise.reject(new TypeError('network down')))
  try {
    await assert.rejects(describeCapabilities(host),
      error => error instanceof RpcTransportError && error.code === 'transport_error')
    assert.equal(recorder.calls.length, 1)
    recorder.setHandler(echoResult({ ok: true, value: describeValue() }))
    const recovered = await describeCapabilities(host)
    assert.equal(recorder.calls.length, 2)
    assert.deepEqual(recovered.value, describeValue())
  } finally {
    recorder.restore()
  }
})

test('describeCapabilities rejects a malformed value slot', async () => {
  const host = uniqueHost()
  await withFetchHandler(echoResult({ ok: true }), async recorder => {
    await assert.rejects(describeCapabilities(host),
      error => error instanceof RpcTransportError && error.code === 'protocol_violation')
    assert.equal(recorder.calls.length, 1)
  })
})
