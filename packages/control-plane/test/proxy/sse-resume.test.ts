/**
 * SSE resume passthrough — a proxy case outside the injected-header policy.
 *
 * The risk: the control plane only ever constrained the headers it INJECTS
 * (`registerTransport`'s Authorization/Cookie), never the client headers it
 * must FORWARD — so a swallowed `Last-Event-ID` would silently turn every
 * reconnect into a full snapshot refetch: no crash,
 * no red test, just permanently worse facts. These are behavior-level pins
 * through `createInstanceProxy` and the fake upstream leg
 * (test/support/proxy-fakes.ts paradigm, no new deps): the header must reach
 * upstream verbatim, SSE frames must stream through one by one in order, and a
 * client disconnect must abort the upstream leg and release the in-flight
 * slot.
 *
 * Why it holds today: forwardHttp forwards client headers by DENY-LIST —
 * STRIPPED_REQUEST_HEADERS (proxy-forward.ts) is checked case-insensitively in
 * the header loop, and `last-event-id` is deliberately not in that set. This
 * file is the regression lock that keeps it that way.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { fakeRequest, fakeResponse, proxyFor } from '../support/proxy-fakes.ts'

/** The chamber session-state SSE path (wire contract). It is a
 *  gateway-kind capability, so the fixture registers a gateway transport —
 *  the same instance-proxy path the real attached gateway mirror uses. */
const GATEWAY_TRANSPORT = 'gateway:sse'
const SSE_PATH = '/api/i/gateway-sse/chamber/session-state/stream'
const SSE_UPSTREAM_PATH = '/chamber/session-state/stream'

/** Case-insensitive header read: forwardHttp keeps the client's original
 *  header casing on the upstream call object, exactly as node:http accepts it
 *  (the real wire lowercases names; the VALUE is what must survive). */
function headerOf(headers: Record<string, unknown>, name: string): unknown {
  const wanted = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value
  }
  return undefined
}

/**
 * The streaming upstream leg: every http.request call gets its own
 * EventEmitter request and, once the proxy has ended the request, its own
 * EventEmitter response — the test drives frames and the client teardown at
 * the exact points of the conversation. Mirrors test/support/proxy-fakes.ts
 * (including the abort-signal wiring) without touching that shared file.
 */
function sseUpstream() {
  interface UpstreamCall { url: URL; options: any; req: any }
  const calls: UpstreamCall[] = []
  const streams: any[] = []
  const fn: any = (url: URL, options: any) => {
    const req = new EventEmitter() as any
    req.destroyed = false
    req.write = () => true
    req.end = () => {
      req.emit('finish')
      const res = new EventEmitter() as any
      res.statusCode = 200
      res.headers = { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }
      res.destroyed = false
      res.destroy = () => {
        if (res.destroyed) return
        res.destroyed = true
        res.emit('close')
      }
      streams.push(res)
      req.emit('response', res)
    }
    const signal: AbortSignal | undefined = options?.signal
    if (signal !== undefined) {
      if (signal.aborted) process.nextTick(() => req.emit('error', new Error('Aborted')))
      else signal.addEventListener('abort', () => {
        req.destroyed = true
        req.emit('error', new Error('Aborted'))
      }, { once: true })
    }
    calls.push({ url, options, req })
    return req
  }
  return { fn, calls, streams }
}

test('SSE resume: Last-Event-ID rides upstream verbatim and frames stream through in order (R21 lock)', async () => {
  const upstream = sseUpstream()
  const proxy = proxyFor(upstream.fn)
  proxy.registerTransport(GATEWAY_TRANSPORT, 'https://gw.example.com')

  // Fresh connect (no cursor yet): the proxy must not fabricate one.
  const fresh = fakeResponse()
  await proxy.handleHttp(fakeRequest(SSE_PATH, 'GET', {
    accept: 'text/event-stream',
    'accept-encoding': 'gzip',
  }), fresh)

  assert.equal(upstream.calls.length, 1)
  assert.equal(upstream.calls[0].url.pathname, SSE_UPSTREAM_PATH, 'the /api/i/<id> prefix is stripped; the SSE path is preserved')
  assert.equal(upstream.calls[0].options.method, 'GET')
  assert.equal(headerOf(upstream.calls[0].options.headers, 'last-event-id'), undefined, 'a fresh stream carries no fabricated resume cursor')
  assert.equal(headerOf(upstream.calls[0].options.headers, 'accept'), 'text/event-stream')
  assert.equal(headerOf(upstream.calls[0].options.headers, 'accept-encoding'), undefined, 'SSE stays identity, so the stream is never gzip-buffered')
  assert.equal(fresh.status, 200)
  assert.equal(fresh.headers['content-type'], 'text/event-stream')
  assert.equal(fresh.headers['cache-control'], 'no-cache')
  assert.equal(fresh.headers['content-length'], undefined, 'a live stream has no precomputed length')
  assert.equal(fresh.headers['transfer-encoding'], undefined, 'framing stays node-side, never forwarded')

  const delivered = [
    'id: 7\nevent: session-state\ndata: {"revision":1}\n\n',
    ': heartbeat\n\n',
    'id: 8\nevent: session-state\ndata: {"revision":2}\n\n',
  ]
  for (const frame of delivered) upstream.streams[0].emit('data', Buffer.from(frame, 'utf8'))
  assert.equal(fresh.body, delivered.join(''), 'each frame is written downstream on arrival, byte for byte and in order')

  // The client drops mid-stream (app exit / page reload). The in-flight slot
  // must be released before the reconnect below (asserted here, and again in
  // the dedicated teardown test).
  fresh.destroy()
  assert.equal(proxy.getDiagnostics().activeHttpRequests, 0, 'a dropped SSE request releases its in-flight slot')

  // Reconnect from the last id the client saw: this is the whole point of the
  // pin — EventSource's Last-Event-ID must reach the upstream unchanged.
  const resumed = fakeResponse()
  await proxy.handleHttp(fakeRequest(SSE_PATH, 'GET', {
    accept: 'text/event-stream',
    'Last-Event-ID': '8',
  }), resumed)

  assert.equal(upstream.calls.length, 2)
  assert.equal(headerOf(upstream.calls[1].options.headers, 'last-event-id'), '8', 'the resume cursor reaches upstream verbatim')
  const resumedFrame = 'id: 9\nevent: session-state\ndata: {"revision":3}\n\n'
  upstream.streams[1].emit('data', Buffer.from(resumedFrame, 'utf8'))
  assert.equal(resumed.body, resumedFrame, 'the resumed stream continues in order downstream')
  assert.equal(proxy.getDiagnostics().activeHttpRequests, 1, 'the resumed stream is in flight')

  upstream.streams[1].emit('end')
  assert.equal(proxy.getDiagnostics().activeHttpRequests, 0, 'a normally ended SSE stream releases its slot too')
})

test('SSE client disconnect mid-stream: the upstream leg is aborted and no slot or budget leaks', async () => {
  const upstream = sseUpstream()
  const proxy = proxyFor(upstream.fn)
  proxy.registerTransport(GATEWAY_TRANSPORT, 'https://gw.example.com')
  const res = fakeResponse()
  await proxy.handleHttp(fakeRequest(SSE_PATH, 'GET', { accept: 'text/event-stream' }), res)

  const frame = 'id: 1\ndata: {"revision":1}\n\n'
  upstream.streams[0].emit('data', Buffer.from(frame, 'utf8'))
  assert.equal(res.body, frame)
  assert.equal(proxy.getDiagnostics().activeHttpRequests, 1, 'the stream is in flight before the disconnect')

  res.destroy()

  assert.equal(upstream.calls[0].req.destroyed, true, 'client teardown aborts the upstream request — no orphaned upstream stream')
  assert.equal(proxy.getDiagnostics().activeHttpRequests, 0, 'the in-flight HTTP/SSE slot is released')
  assert.equal(proxy.getDiagnostics().bufferedRequestBytes, 0, 'the request-body budget holds nothing')
  assert.equal(proxy.getDiagnostics().activeStreams, 0, 'an HTTP/SSE request is not a WS stream')
  res.destroy()
  assert.equal(proxy.getDiagnostics().activeHttpRequests, 0, 'a repeated close cannot double-release')
})
