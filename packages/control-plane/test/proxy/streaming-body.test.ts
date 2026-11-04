/**
 * P1-1: streaming request bodies (design 27 §3.4 "streaming" mode).
 *
 * forwardHttp used to buffer EVERY body before it created the upstream request:
 * a body above the byte budget could not be forwarded at all, the client paid the
 * inbound budget twice (read, then flush) and the upstream saw its first byte
 * only after the last one had arrived. Above the declared 8MiB threshold the body
 * now streams — ONE overlapped transfer with:
 *   - the client's own content-length forwarded unchanged (never recomputed),
 *   - a single size-derived budget charged from the first body byte,
 *   - zero body bytes before the peer is proven (SPKI pin),
 *   - the upstream header window armed only after the body finished,
 *   - a cap counter that refuses a byte beyond the declared framing.
 *
 * The suite drives the real proxy through the shared fakes plus one small
 * injection: an upstream spy that records WHEN each byte arrived and exposes the
 * created ClientRequest, so the SPKI gate can be driven deterministically.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, X509Certificate } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import {
  MAX_REQUEST_BODY_BYTES,
  STREAM_REQUEST_BODY_THRESHOLD_BYTES,
} from '../../src/proxy-forward.ts'
import type { ProxyRequest } from '../../src/proxy-forward.ts'
import { STREAM_REQUEST_BODY_ENV, streamRequestBodyEnabled } from '../../src/instance-proxy.ts'
import { fakeResponse, proxyFor, sleep } from '../support/proxy-fakes.ts'

function tick(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate() && Date.now() < deadline) await sleep(5)
  assert.ok(predicate(), 'condition was not reached in time')
}

/** A streaming client request: a REAL Readable (so pause/resume/pipe/unpipe are
 *  genuine stream semantics, no hand-rolled stub) carrying the proxy's request
 *  surface. Writing to it is "the client sending body bytes". */
function streamingRequest(url: string, method: string, headers: Record<string, string>): PassThrough & ProxyRequest {
  const stream = new PassThrough()
  return Object.assign(stream, { url, method, headers }) as unknown as PassThrough & ProxyRequest
}

interface UpstreamCall {
  headers: Record<string, string>
  chunks: Buffer[]
  firstWriteAtMs: number | null
  finished: boolean
  destroyed: boolean
  request: EventEmitter & { destroyed: boolean }
}

/** Upstream spy: records forwarded bytes and their arrival order. \`respond:
 *  false\` keeps the upstream silent (it accepts the body and never answers). */
function upstreamSpy(options: { respond?: boolean; blocked?: boolean } = {}) {
  const calls: UpstreamCall[] = []
  const fn = ((_url: URL, opts: any) => {
    const request = new EventEmitter() as EventEmitter & { destroyed: boolean; writableNeedDrain: boolean; writableLength: number }
    request.destroyed = false
    request.writableNeedDrain = false
    request.writableLength = 0
    const call: UpstreamCall = {
      headers: (opts.headers ?? {}) as Record<string, string>,
      chunks: [],
      firstWriteAtMs: null,
      finished: false,
      destroyed: false,
      request,
    }
    calls.push(call)
    const write = (chunk: Buffer): boolean => {
      if (call.firstWriteAtMs === null) call.firstWriteAtMs = Date.now()
      call.chunks.push(Buffer.from(chunk))
      request.writableNeedDrain = options.blocked === true
      return options.blocked !== true
    }
    ;(request as any).write = write
    ;(request as any).end = (): void => {
      call.finished = true
      request.emit('finish')
      if (options.respond === false) return
      const upstreamRes = new EventEmitter() as any
      upstreamRes.statusCode = 200
      upstreamRes.headers = { 'content-type': 'application/json' }
      upstreamRes.destroy = () => upstreamRes.emit('close')
      request.emit('response', upstreamRes)
      upstreamRes.emit('data', Buffer.from('{"ok":true}'))
      upstreamRes.emit('end')
    }
    ;(request as any).destroy = (error?: Error): void => {
      if (call.destroyed) return
      call.destroyed = true
      request.destroyed = true
      request.emit('close')
      if (error !== undefined) request.emit('error', error)
    }
    const signal: AbortSignal | undefined = opts?.signal
    signal?.addEventListener('abort', () => {
      const abortError: Error & { name: string } = new Error('Aborted')
      abortError.name = 'AbortError'
      ;(request as any).destroy(abortError)
    }, { once: true })
    return request
  }) as unknown as Parameters<typeof proxyFor>[0]
  return { fn, calls }
}

function uploadedBytes(call: UpstreamCall): number {
  return call.chunks.reduce((total, chunk) => total + chunk.length, 0)
}

// ---------------------------------------------------------------------------
// Threshold: only a DECLARED length above 8MiB streams.
// ---------------------------------------------------------------------------

test('only a declared length above 8MiB streams; at the threshold the buffered path is kept', async () => {
  // At the threshold: buffered. Nothing leaves the proxy before the whole body is
  // in memory, and the forwarded Length comes from the RECEIVED bytes.
  const buffered = upstreamSpy()
  const bufferedProxy = proxyFor(buffered.fn, { streamRequestBody: true })
  const atThreshold = streamingRequest('/api/i/local/api/upload', 'POST', {
    'content-length': String(STREAM_REQUEST_BODY_THRESHOLD_BYTES),
  })
  const bufferedRes = fakeResponse()
  const bufferedRun = bufferedProxy.handleHttp(atThreshold, bufferedRes)
  atThreshold.write(Buffer.from('abc'))
  await tick()
  assert.equal(buffered.calls.length, 0, 'a declared length AT the threshold is buffered: no upstream request yet')
  atThreshold.end()
  await bufferedRun
  assert.equal(buffered.calls.length, 1)
  assert.equal(buffered.calls[0].headers['content-length'], '3', 'the buffered path re-frames from the bytes it accepted')
  assert.equal(bufferedRes.status, 200)

  // One byte over: streaming. The upstream exists — and already has the first
  // chunk — while the client request is still open.
  const streamed = upstreamSpy()
  const streamedProxy = proxyFor(streamed.fn, { streamRequestBody: true })
  const above = streamingRequest('/api/i/local/api/upload', 'POST', {
    'content-length': String(STREAM_REQUEST_BODY_THRESHOLD_BYTES + 1),
  })
  const streamedRes = fakeResponse()
  const streamedRun = streamedProxy.handleHttp(above, streamedRes)
  above.write(Buffer.from('abc'))
  await tick()
  assert.equal(streamed.calls.length, 1, 'a declared length above the threshold opens the upstream immediately')
  assert.equal(streamed.calls[0].chunks.join(''), 'abc', 'the first chunk reaches the upstream BEFORE the client ends')
  assert.equal(streamed.calls[0].finished, false, 'and before the body finished')
  assert.equal(
    streamed.calls[0].headers['content-length'],
    String(STREAM_REQUEST_BODY_THRESHOLD_BYTES + 1),
    'the DECLARED length is forwarded verbatim, never the received byte count',
  )
  above.end()
  // handleHttp resolves once the transfer is DISPATCHED, not when the response
  // arrives: the streaming leg completes asynchronously.
  await streamedRun
  await waitFor(() => streamedRes.status !== null)
  assert.equal(streamed.calls[0].headers['content-length'], String(STREAM_REQUEST_BODY_THRESHOLD_BYTES + 1))
  assert.equal(uploadedBytes(streamed.calls[0]), 3)
  assert.equal(streamedRes.status, 200)
})

test('a chunked (undeclared) body stays buffered even when streaming is enabled', async () => {
  const upstream = upstreamSpy()
  const proxy = proxyFor(upstream.fn, { streamRequestBody: true })
  const req = streamingRequest('/api/i/local/api/upload', 'POST', { 'transfer-encoding': 'chunked' })
  const res = fakeResponse()
  const run = proxy.handleHttp(req, res)
  req.write(Buffer.from('chunked-body'))
  await tick()
  assert.equal(upstream.calls.length, 0, 'no declaration means no streaming: the 32MiB buffered cap stays authoritative')
  req.end()
  await run
  assert.equal(upstream.calls[0].headers['content-length'], String('chunked-body'.length))
  assert.equal(res.status, 200)
})

test('deps.streamRequestBody=false keeps the buffered path even above the threshold', async () => {
  const upstream = upstreamSpy()
  const proxy = proxyFor(upstream.fn, { streamRequestBody: false })
  const req = streamingRequest('/api/i/local/api/upload', 'POST', {
    'content-length': String(STREAM_REQUEST_BODY_THRESHOLD_BYTES + 1),
  })
  const res = fakeResponse()
  const run = proxy.handleHttp(req, res)
  req.write(Buffer.from('abc'))
  await tick()
  assert.equal(upstream.calls.length, 0, 'the default owner behavior is the P0-1 buffered path')
  req.end()
  await run
  assert.equal(upstream.calls[0].headers['content-length'], '3')
})

test('the instance proxy streams by default and DSH_CHAMBER_PROXY_STREAM_BODY=0 opts out', async () => {
  assert.equal(streamRequestBodyEnabled({}), true, 'production default is ON')
  assert.equal(streamRequestBodyEnabled({ [STREAM_REQUEST_BODY_ENV]: '1' }), true)
  assert.equal(streamRequestBodyEnabled({ [STREAM_REQUEST_BODY_ENV]: '0' }), false, 'only the exact 0 disables it')
  assert.equal(streamRequestBodyEnabled({ [STREAM_REQUEST_BODY_ENV]: 'off' }), true, 'no other spelling silently disables it')

  process.env[STREAM_REQUEST_BODY_ENV] = '0'
  try {
    const upstream = upstreamSpy()
    const proxy = proxyFor(upstream.fn)
    const req = streamingRequest('/api/i/local/api/upload', 'POST', {
      'content-length': String(STREAM_REQUEST_BODY_THRESHOLD_BYTES + 1),
    })
    const res = fakeResponse()
    const run = proxy.handleHttp(req, res)
    req.write(Buffer.from('abc'))
    await tick()
    assert.equal(upstream.calls.length, 0, 'the env opt-out keeps the buffered path')
    req.end()
    await run
    assert.equal(upstream.calls[0].headers['content-length'], '3')
  } finally {
    delete process.env[STREAM_REQUEST_BODY_ENV]
  }
})

// ---------------------------------------------------------------------------
// Bounds: the 300MiB declaration cap and the byte counter cap.
// ---------------------------------------------------------------------------

test('a declaration above the 300MiB cap is refused with 413 before any byte moves', async () => {
  const upstream = upstreamSpy()
  const proxy = proxyFor(upstream.fn, { streamRequestBody: true })
  const req = streamingRequest('/api/i/local/api/upload', 'POST', {
    'content-length': String(MAX_REQUEST_BODY_BYTES + 1),
  })
  const res = fakeResponse()
  await proxy.handleHttp(req, res)
  assert.equal(res.status, 413)
  assert.equal(JSON.parse(res.body).code, 'body_too_large')
  assert.equal(upstream.calls.length, 0, 'the cap is decided from the declaration, before the upstream exists')
})

test('a client that sends more bytes than it declared is aborted with 413 (counter cap)', async () => {
  const upstream = upstreamSpy({ respond: false })
  // A shrunk threshold keeps the byte counter reachable without allocating 8MiB.
  const proxy = proxyFor(upstream.fn, { streamRequestBody: true, streamThresholdBytes: 4 })
  const req = streamingRequest('/api/i/local/api/upload', 'POST', { 'content-length': '8' })
  const res = fakeResponse()
  void proxy.handleHttp(req, res)
  await tick()
  req.write(Buffer.alloc(8))
  await tick()
  assert.equal(uploadedBytes(upstream.calls[0]), 8, 'exactly the declared bytes are forwarded')
  req.write(Buffer.alloc(1))
  await tick()
  await tick()
  assert.equal(res.status, 413)
  assert.equal(JSON.parse(res.body).code, 'body_too_large')
  assert.equal(upstream.calls[0].destroyed, true, 'the partial upstream leg is destroyed')
  assert.equal(upstream.calls[0].finished, false, 'an aborted upload never claims an after-body verdict')
  assert.deepEqual(JSON.parse(res.body).details, undefined)
})

// ---------------------------------------------------------------------------
// Budget: ONE size-derived window charged from the first body byte.
// ---------------------------------------------------------------------------

test('a streaming transfer that outlives its budget answers 408 and tears both legs down', async () => {
  const upstream = upstreamSpy({ respond: false })
  const proxy = proxyFor(upstream.fn, {
    streamRequestBody: true,
    // Shrink the shared rate/cap seams: the budget is derived from the same wire
    // table the client uses, so only the scale changes.
    uploadMinBytesPerSec: 1,
    uploadMaxBudgetMs: 30,
  })
  const req = streamingRequest('/api/i/local/api/upload', 'POST', {
    'content-length': String(STREAM_REQUEST_BODY_THRESHOLD_BYTES + 1),
  })
  const res = fakeResponse()
  void proxy.handleHttp(req, res)
  await tick()
  req.write(Buffer.from('abc')) // starts the transfer window
  await waitFor(() => res.status !== null)
  assert.equal(res.status, 408)
  assert.equal(JSON.parse(res.body).code, 'request_timeout')
  assert.equal(upstream.calls[0].destroyed, true, 'the upstream leg is destroyed')
  assert.equal(req.destroyed, true, 'the still-uploading client leg is released')
})

test('a streaming body that stalls after its first byte is still idle-bounded (R6 A-MINOR-1)', async () => {
  const upstream = upstreamSpy({ respond: false })
  const proxy = proxyFor(upstream.fn, { streamRequestBody: true, clientBodyIdleTimeoutMs: 25, streamThresholdBytes: 1 })
  const req = streamingRequest('/api/i/local/api/upload', 'POST', {
    'content-length': String(STREAM_REQUEST_BODY_THRESHOLD_BYTES + 1),
  })
  const res = fakeResponse()
  void proxy.handleHttp(req, res)
  await tick()
  req.write(Buffer.from('a'))
  await waitFor(() => res.status !== null, 2000)
  assert.equal(res.status, 408)
  assert.equal(JSON.parse(res.body).code, 'request_timeout')
  assert.equal(req.destroyed, true)
})

test('a declaration that never sends a byte is bounded by the client-body window', async () => {
  const upstream = upstreamSpy({ respond: false })
  const proxy = proxyFor(upstream.fn, { streamRequestBody: true, clientBodyIdleTimeoutMs: 25 })
  const req = streamingRequest('/api/i/local/api/upload', 'POST', {
    'content-length': String(STREAM_REQUEST_BODY_THRESHOLD_BYTES + 1),
  })
  const res = fakeResponse()
  void proxy.handleHttp(req, res)
  await tick()
  await waitFor(() => res.status !== null)
  assert.equal(res.status, 408)
  assert.equal(JSON.parse(res.body).code, 'request_timeout')
  assert.equal(req.destroyed, true)
})

// ---------------------------------------------------------------------------
// After-body: only a body that fully LEFT the writable queue may claim it.
// ---------------------------------------------------------------------------

test('the after-body verdict appears only after the upstream accepted the whole body', async () => {
  const upstream = upstreamSpy({ respond: false })
  const proxy = proxyFor(upstream.fn, { streamRequestBody: true, upstreamTimeoutMs: 25 })
  const req = streamingRequest('/api/i/local/api/session/create', 'POST', {
    'content-length': String(STREAM_REQUEST_BODY_THRESHOLD_BYTES + 1),
  })
  const res = fakeResponse()
  void proxy.handleHttp(req, res)
  await tick()
  req.write(Buffer.from('abc'))
  await tick()
  req.end()
  await waitFor(() => res.status !== null)
  assert.equal(upstream.calls[0].finished, true, 'the upstream saw the end of the body')
  assert.equal(res.status, 504)
  assert.deepEqual(JSON.parse(res.body).details, { phase: 'after-body' }, 'a fully sent body makes the timeout ambiguous')
})

// ---------------------------------------------------------------------------
// Client abort: destroy the upstream, release the slot, leave nothing behind.
// ---------------------------------------------------------------------------

test('a client abort mid-stream destroys the upstream, releases the slot and leaves no listener', async () => {
  const upstream = upstreamSpy({ respond: false })
  const proxy = proxyFor(upstream.fn, { streamRequestBody: true })
  const req = streamingRequest('/api/i/local/api/upload', 'POST', {
    'content-length': String(STREAM_REQUEST_BODY_THRESHOLD_BYTES + 1),
  })
  const res = fakeResponse()
  void proxy.handleHttp(req, res)
  await tick()
  req.write(Buffer.from('abc'))
  await tick()
  assert.equal(proxy.getDiagnostics().activeHttpRequests, 1)
  ;(req as unknown as EventEmitter).emit('aborted')
  await tick()
  assert.equal(upstream.calls[0].destroyed, true, 'the upstream leg is destroyed with the client')
  assert.equal(upstream.calls[0].finished, false, 'an aborted stream never claims after-body')
  assert.equal(proxy.getDiagnostics().activeHttpRequests, 0, 'the request slot is released')
  assert.equal(req.listenerCount('data'), 0, 'the pipe is gone: no data listener survives')
  assert.equal(req.isPaused(), true, 'the client leg is paused, not still flowing')
  assert.equal(res.status, null, 'a gone client gets no answer attempt')
})

// ---------------------------------------------------------------------------
// SPKI pin: zero body bytes before the verdict; a mismatch destroys the client.
// ---------------------------------------------------------------------------

/** The pinned fixture certificate (same self-signed test cert as
 *  real-node-spki.test.ts; only the public half is needed — no TLS handshake is
 *  performed here, the socket is driven directly). */
const PINNED_CERT = `-----BEGIN CERTIFICATE-----
MIICyTCCAbGgAwIBAgIJAMuxiI8oRgl7MA0GCSqGSIb3DQEBCwUAMBQxEjAQBgNV
BAMMCTEyNy4wLjAuMTAeFw0yNjA4MjgwNDM4MDRaFw0zNjA4MjUwNDM4MDRaMBQx
EjAQBgNVBAMMCTEyNy4wLjAuMTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoC
ggEBALYDiUAFkzdtkyjr/VrNpyfe3p5c0lLWSy+OtqeRK4db2toYN8aWr+vxFMYT
4HqF/VW0ByfOAl0Mfi3kCZPbAFShUY11oYtoHCIGNyQIP6sf+Uc8a2zjodcm67yG
uS980hNK7e1v19B1L/kIZXncrkS7acXbC905GOihh6U3ZQyAGNva/CRlV4fdn2N2
Ti27Hy2xek9S8guA5/Ck+IEAq1iR0KwVNYcYd1yNBYwOGHCbNoSv+bOS2dKNurB0
SgolQYO7FFHWFCDO1dtPbwZfe8B1ucGCQSrgvSEELMjucaZxKMlRh4odH35Asxo8
ldUIdAwEqMK0rDdVmlDWWcEpQGECAwEAAaMeMBwwGgYDVR0RBBMwEYcEfwAAAYIJ
bG9jYWxob3N0MA0GCSqGSIb3DQEBCwUAA4IBAQB1f5w9ld+gR42JDBgqy/UM8eI4
StDLYWNcOrImEV+OiCwhYDs/zXLk4CH9/MGTK3dypCY8nrfRiQ+JRfZf05sWeTyx
vFUu+tfaAKRiNQ39t+//josjJ2CuZeMctPap+F+YwxpxsDdQIEuAELgdWYAVvog4
nYQ7wAd7xngG/RoHv8hoXN7r+ZBk8+hU53YQ4o8xg5gTw6PFG7fVJ4YUxZC8uK72
yld1ntC7f8QDh0iHd9OEz3a+gs1ygsElBO49Rj58JgZLMBsOOOroowhnIsbVR/hN
E0KrcDN2oPfeHsQOarolqSXpNbJJF+Ue+Xlf9RfZNYLc6z2ntclmBAOHr14l
-----END CERTIFICATE-----
`

const PIN_MATCH = createHash('sha256')
  .update(new X509Certificate(PINNED_CERT).publicKey.export({ type: 'spki', format: 'der' }))
  .digest('hex')
const PIN_OTHER = '0'.repeat(64)

/** The pin gate's two events, driven directly: no TLS handshake is performed. */
function fakeTlsSocket() {
  let secureConnect: (() => void) | null = null
  const socket = {
    once(event: string, listener: () => void) {
      if (event === 'secureConnect') secureConnect = listener
      return socket
    },
    getPeerCertificate() {
      return { raw: new X509Certificate(PINNED_CERT).raw }
    },
  }
  return {
    socket,
    fireSecureConnect(): void {
      const listener = secureConnect
      secureConnect = null
      listener?.()
    },
  }
}

async function pinnedGateway(upstream: ReturnType<typeof upstreamSpy>, pin: string) {
  const proxy = proxyFor(upstream.fn, { streamRequestBody: true })
  proxy.registerTransport('gateway:pinned', 'https://127.0.0.1:9', undefined, { tls: { spkiPin: pin } })
  const req = streamingRequest('/api/i/gateway-pinned/api/upload', 'POST', {
    'content-length': String(STREAM_REQUEST_BODY_THRESHOLD_BYTES + 1),
  })
  const res = fakeResponse()
  const run = proxy.handleHttp(req, res)
  await tick()
  return { proxy, req, res, run }
}

test('a pinned target consumes zero body bytes before secureConnect passes', async () => {
  const upstream = upstreamSpy()
  const { req, res, run } = await pinnedGateway(upstream, PIN_MATCH)
  assert.equal(upstream.calls.length, 1, 'the upstream request exists (headers held behind the gate)')
  const tls = fakeTlsSocket()
  upstream.calls[0].request.emit('socket', tls.socket)
  req.write(Buffer.from('secret-business-bytes'))
  await tick()
  assert.equal(upstream.calls[0].chunks.length, 0, 'not one body byte reaches the peer before the pin verdict')
  assert.equal(req.isPaused(), true, 'the client leg waits, paused')
  tls.fireSecureConnect()
  await tick()
  assert.equal(upstream.calls[0].chunks.join(''), 'secret-business-bytes', 'the splice starts only after the pin matched')
  req.end()
  await run
  await waitFor(() => res.status !== null)
  assert.equal(res.status, 200)
})

test('a pin mismatch destroys the paused client request (502, no body bytes)', async () => {
  const upstream = upstreamSpy()
  const { req, res, run } = await pinnedGateway(upstream, PIN_OTHER)
  const tls = fakeTlsSocket()
  upstream.calls[0].request.emit('socket', tls.socket)
  req.write(Buffer.from('secret-business-bytes'))
  await tick()
  assert.equal(upstream.calls[0].chunks.length, 0)
  tls.fireSecureConnect()
  await tick()
  await run
  assert.equal(upstream.calls[0].chunks.length, 0, 'a mismatched peer never sees a body byte')
  assert.equal(res.status, 502)
  assert.equal(JSON.parse(res.body).code, 'upstream_failed')
  assert.equal(req.destroyed, true, 'the paused client leg is destroyed with the upstream')
})

test('a slow streaming body is not charged the upstream header window (M3)', async () => {
  const upstream = upstreamSpy()
  const proxy = proxyFor(upstream.fn, {
    streamRequestBody: true,
    streamThresholdBytes: 1,
    upstreamTimeoutMs: 50,
  })
  const req = streamingRequest('/api/i/local/upload', 'POST', { 'content-length': '4' })
  const res = fakeResponse()
  const run = proxy.handleHttp(req, res)
  for (const chunk of ['a', 'b', 'c', 'd']) {
    req.write(chunk)
    await sleep(20)
  }
  req.end()
  await run
  await waitFor(() => res.status !== null)
  assert.equal(res.status, 200, 'the header window must start only after upstream finish')
  assert.equal(uploadedBytes(upstream.calls[0]!), 4)
})

test('an early upstream response destroys the unfinished streaming request (M1)', async () => {
  const upstream = upstreamSpy({ respond: false })
  const proxy = proxyFor(upstream.fn, { streamRequestBody: true, streamThresholdBytes: 1 })
  const req = streamingRequest('/api/i/local/upload', 'POST', { 'content-length': '100' })
  const res = fakeResponse()
  const run = proxy.handleHttp(req, res)
  req.write(Buffer.alloc(10))
  await waitFor(() => upstream.calls[0]?.chunks.length === 1)
  const call = upstream.calls[0]!
  const upstreamRes = new EventEmitter() as any
  upstreamRes.statusCode = 401
  upstreamRes.headers = { 'content-type': 'text/plain' }
  upstreamRes.destroy = () => upstreamRes.emit('close')
  call.request.emit('response', upstreamRes)
  upstreamRes.emit('end')
  await run
  await waitFor(() => res.status !== null)
  assert.equal(res.status, 401)
  assert.equal(call.destroyed, true, 'the request half is destroyed, not left pinning the socket')
  req.destroy()
})


test('a blocked upstream after a client chunk is still 504 + probe, not idle 408 (R6 B0)', async () => {
  const upstream = upstreamSpy({ respond: false, blocked: true })
  const proxy = proxyFor(upstream.fn, {
    streamRequestBody: true,
    streamThresholdBytes: 1,
    clientBodyIdleTimeoutMs: 50,
    streamBudgetMs: 1_500,
  })
  proxy.registerTransport('dsh:blocked-idle', 'http://127.0.0.1:9')
  let failures = 0
  proxy.onUpstreamFailure(() => { failures += 1 })
  const req = streamingRequest('/api/i/dsh-blocked-idle/upload', 'POST', { 'content-length': '10000' })
  const res = fakeResponse()
  void proxy.handleHttp(req, res)
  req.write(Buffer.alloc(9000, 0x61))
  await waitFor(() => res.status !== null, 1000)
  assert.equal(res.status, 504)
  assert.equal(JSON.parse(res.body).code, 'upstream_timeout')
  assert.equal(failures, 1, 'the 504 must feed the failure-driven probe')
  req.destroy()
})

test('a blocked upstream leg is a 504 and feeds the failure probe, not a client 408 (M2)', async () => {
  const upstream = upstreamSpy({ respond: false, blocked: true })
  const proxy = proxyFor(upstream.fn, {
    streamRequestBody: true,
    streamThresholdBytes: 1,
    streamBudgetMs: 40,
  })
  proxy.registerTransport('dsh:blocked', 'http://127.0.0.1:9')
  let failures = 0
  proxy.onUpstreamFailure(() => { failures += 1 })
  const req = streamingRequest('/api/i/dsh-blocked/upload', 'POST', { 'content-length': '10' })
  const res = fakeResponse()
  const run = proxy.handleHttp(req, res)
  req.write('a')
  await run
  await waitFor(() => res.status !== null)
  assert.equal(res.status, 504)
  assert.equal(JSON.parse(res.body).code, 'upstream_timeout')
  assert.equal(failures, 1, 'the 504 must feed the failure-driven probe')
  req.destroy()
})
