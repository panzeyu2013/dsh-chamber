/**
 * Liveness and timeout behavior (part 4 of the test/proxy split): upstream
 * and idle timeouts, request-body/concurrency budgets, the long-RPC exemption
 * window, WS handshake timeouts and the WS heartbeat.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createInstanceProxy, getProcessBufferedRequestBytes } from '../../src/instance-proxy.ts'
import type { ProxyRequest } from '../../src/instance-proxy.ts'
import { matchesLongRpcPath } from '../../src/proxy-forward.ts'
import { startWsHeartbeat } from '../../src/ws-heartbeat.ts'
import { DEFAULT_DSH_START_PORT } from '../../src/spawn-dsh.ts'
import { pongFrame } from '../support/utils.ts'
import {
  fakeHttpRequest,
  fakeRequest,
  fakeResponse,
  fakeSocket,
  makeProxy,
  quietLogger,
  sleep,
  proxyFor,
} from '../support/proxy-fakes.ts'

// ---------------------------------------------------------------------------
// Upstream timeout (design 03 §3.4: silence → explicit 504, never a hang)
// ---------------------------------------------------------------------------

test('http: an upstream that never answers headers → explicit 504 upstream_timeout', async () => {
  const upstream = fakeHttpRequest(() => undefined) // hang: no response, no error
  const proxy = proxyFor(upstream.fn, { upstreamTimeoutMs: 40 })
  const res = fakeResponse()
  await proxy.handleHttp(fakeRequest('/api/i/local/api/session/list', 'GET'), res)
  assert.equal(res.status, null) // not answered synchronously — the timeout decides
  await sleep(80)
  assert.equal(res.status, 504)
  assert.equal(res.headers['content-type'], 'application/json')
  assert.ok(res.body.includes('upstream_timeout'))
  assert.ok(res.body.includes('timed out'))
  // The hung upstream was aborted, not left streaming into the void.
  assert.equal((upstream.calls[0].options.signal as AbortSignal).aborted, true)
})

test('http: a responding upstream stays unaffected by the timeout guard', async () => {
  const { proxy } = makeProxy()
  const res = fakeResponse()
  await proxy.handleHttp(fakeRequest('/api/i/local/api/session/list', 'GET'), res)
  await sleep(80)
  assert.equal(res.status, 200) // fast upstream: timeout guard cleared, no 504
})

test('http: IncomingMessage close after parsing does not abort a live upstream request', async () => {
  let pending: EventEmitter | null = null
  const captured = { signal: null as AbortSignal | null }
  const fn: any = (_url: URL, options: { signal: AbortSignal }) => {
    captured.signal = options.signal
    const request = new EventEmitter() as any
    request.write = () => true
    request.end = () => { pending = request }
    return request
  }
  const proxy = proxyFor(fn, { upstreamTimeoutMs: 200, getLocalDshPort: () => 17510 })
  const request = fakeRequest('/api/i/local/api/session/list', 'GET')
  const response = fakeResponse()
  await proxy.handleHttp(request, response)
  ;(request as unknown as EventEmitter).emit('close')
  assert.equal(captured.signal?.aborted, false)
  assert.equal(proxy.getDiagnostics().activeHttpRequests, 1)

  const upstream = pending as EventEmitter | null
  assert.ok(upstream !== null)
  const upstreamResponse = new EventEmitter() as any
  upstreamResponse.statusCode = 200
  upstreamResponse.headers = { 'content-type': 'application/json' }
  upstreamResponse.destroy = () => upstreamResponse.emit('close')
  upstreamResponse.pause = () => {}
  upstreamResponse.resume = () => {}
  upstream.emit('response', upstreamResponse)
  upstreamResponse.emit('data', Buffer.from('{"ok":true}'))
  upstreamResponse.emit('end')
  assert.equal(response.status, 200)
  assert.equal(response.body, '{"ok":true}')
  assert.equal(proxy.getDiagnostics().activeHttpRequests, 0)
})

test('http: unfinished downstream response close aborts upstream and clears timeout', async () => {
  const captured = { signal: null as AbortSignal | null }
  const fn: any = (_url: URL, options: { signal: AbortSignal }) => {
    captured.signal = options.signal
    const request = new EventEmitter() as any
    request.write = () => true
    request.end = () => {}
    return request
  }
  const proxy = proxyFor(fn, { upstreamTimeoutMs: 30, getLocalDshPort: () => 17510 })
  const response = fakeResponse()
  await proxy.handleHttp(fakeRequest('/api/i/local/api/session/list', 'GET'), response)
  ;(response as unknown as EventEmitter).emit('close')
  assert.equal(captured.signal?.aborted, true)
  assert.equal(proxy.getDiagnostics().activeHttpRequests, 0)
  await sleep(60)
  assert.equal(response.status, null, 'a cleared timeout must not write after the client disconnected')
})

test('http: concurrent request budget rejects excess work before opening another upstream', async () => {
  const upstream = fakeHttpRequest(() => undefined)
  const proxy = proxyFor(upstream.fn, { maxConcurrentHttpRequests: 1, upstreamTimeoutMs: 30 })
  const first = fakeResponse()
  await proxy.handleHttp(fakeRequest('/api/i/local/api/session/list', 'GET'), first)
  assert.equal(proxy.getDiagnostics().activeHttpRequests, 1)
  const second = fakeResponse()
  await proxy.handleHttp(fakeRequest('/api/i/local/api/session/list', 'GET'), second)
  assert.equal(second.status, 503)
  assert.match(second.body, /resource_exhausted/)
  assert.equal(upstream.calls.length, 1)
  await sleep(50)
  assert.equal(proxy.getDiagnostics().activeHttpRequests, 0)
})

test('http: a stalled client upload releases its body and request budgets with 408', async () => {
  const upstream = fakeHttpRequest(() => ({
    response: { status: 200, headers: {}, body: 'unexpected' },
  }))
  const emitter = new EventEmitter()
  let iteratorReturned = false
  const stalled = Object.assign(emitter, {
    url: '/api/i/local/api/upload',
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    [Symbol.asyncIterator]() {
      return {
        next: () => new Promise<IteratorResult<Buffer>>(() => {}),
        return: async () => {
          iteratorReturned = true
          return { done: true, value: undefined }
        },
      }
    },
  }) as unknown as ProxyRequest
  const proxy = proxyFor(upstream.fn, { clientBodyIdleTimeoutMs: 30 })
  const response = fakeResponse()
  await proxy.handleHttp(stalled, response)
  assert.equal(response.status, 408)
  assert.match(response.body, /request_timeout/)
  assert.equal(upstream.calls.length, 0)
  assert.equal(proxy.getDiagnostics().activeHttpRequests, 0)
  assert.equal(proxy.getDiagnostics().bufferedRequestBytes, 0)
  assert.equal(iteratorReturned, true)
})

test('http: request-body bytes stay reserved while upstream write is backpressured', async () => {
  let pendingRequest: EventEmitter | null = null
  let first = true
  const fn: any = () => {
    const req = new EventEmitter() as any
    req.write = () => {
      if (first) {
        first = false
        pendingRequest = req
        return false
      }
      return true
    }
    req.end = () => {
      req.emit('finish')
      const upstreamRes = new EventEmitter() as any
      upstreamRes.statusCode = 200
      upstreamRes.headers = { 'content-type': 'application/json' }
      upstreamRes.destroy = () => upstreamRes.emit('close')
      req.emit('response', upstreamRes)
      upstreamRes.emit('data', Buffer.from('{}'))
      upstreamRes.emit('end')
    }
    return req
  }
  const proxy = proxyFor(fn, { maxBufferedRequestBytes: 3, getLocalDshPort: () => 17510 })
  const response = fakeResponse()
  await proxy.handleHttp(fakeRequest('/api/i/local/api/upload', 'POST', { 'content-length': '3' }, 'abc'), response)
  assert.equal(response.status, null)
  assert.equal(proxy.getDiagnostics().bufferedRequestBytes, 3)
  assert.equal(getProcessBufferedRequestBytes(), 3, 'the reservation is shared process-wide, not only per proxy owner')

  const rejected = fakeResponse()
  await proxy.handleHttp(fakeRequest('/api/i/local/api/upload', 'POST', { 'content-length': '1' }, 'x'), rejected)
  assert.equal(rejected.status, 503)
  assert.match(rejected.body, /resource_exhausted/)

  const blocked = pendingRequest as EventEmitter | null
  assert.ok(blocked !== null)
  blocked.emit('drain')
  assert.equal(response.status, 200)
  assert.equal(proxy.getDiagnostics().bufferedRequestBytes, 0)
  assert.equal(getProcessBufferedRequestBytes(), 0)
})

test('http: non-SSE timeout is idle-based and re-arms on every body chunk', async () => {
  const fn: any = () => {
    const req = new EventEmitter() as any
    req.write = () => true
    req.end = () => {
      const res = new EventEmitter() as any
      res.statusCode = 200
      res.headers = { 'content-type': 'application/json' }
      res.destroy = () => {}
      res.pause = () => {}
      res.resume = () => {}
      req.emit('response', res)
      let count = 0
      const interval = setInterval(() => {
        count += 1
        res.emit('data', Buffer.from('x'))
        if (count === 4) {
          clearInterval(interval)
          res.emit('end')
        }
      }, 20)
    }
    return req
  }
  const proxy = createInstanceProxy({
    logger: quietLogger,
    getLocalState: () => 'ready',
    getLocalDshPort: () => DEFAULT_DSH_START_PORT,
    httpRequest: fn,
    // 20ms chunk cadence against a 100ms idle window: a 5x margin so a CI
    // pause between chunks can never trip the idle timeout spuriously.
    upstreamTimeoutMs: 100,
  })
  const response = fakeResponse()
  await proxy.handleHttp(fakeRequest('/api/i/local/api/slow', 'GET'), response)
  await sleep(110)
  assert.equal(response.status, 200)
  assert.equal(response.body, 'xxxx')
  assert.equal(proxy.getDiagnostics().failures, 0)
})

// ---------------------------------------------------------------------------
// Long-RPC window (design 03 §3.4, 2026-09): /api/commands/execute (the
// single funnel for every upstream slash command — /compact LLM summarization,
// dsh-command-compact → dsh-compaction-basic, measured: a ~627k-token manual
// compaction was cut at exactly 45 001 ms with the session unchanged) and
// /api/archiveCleanup/purge (chamber archived-session cleanup host domain,
// design 24 — unbounded fs deletions, client budget 5 min) carry host business
// with NO upstream cap and out-of-band progress, so the ordinary idle window
// must not fabricate a client disconnect for them. Exempted requests are POST
// on one of the EXACT upstream paths and get LONG_RPC_UPSTREAM_TIMEOUT_MS as
// an insurance fuse (NOT an SLA); everything else keeps the ordinary window.
// Timing discipline: assertions depend on single-process timer deadline ORDER
// (a CI stall delays all timers equally and cannot flip the verdict), not on
// absolute time — keep every gap >=50ms so scheduling noise cannot reorder.
// ---------------------------------------------------------------------------

test('long-RPC predicate: decision table (0 timers)', () => {
  const paths = ['/api/commands/execute', '/api/archiveCleanup/purge']
  assert.equal(matchesLongRpcPath('POST', '/api/commands/execute', paths), true)
  assert.equal(matchesLongRpcPath('POST', '/api/archiveCleanup/purge', paths), true)
  assert.equal(matchesLongRpcPath('post', '/api/commands/execute', paths), true) // method is case-insensitive
  assert.equal(matchesLongRpcPath('GET', '/api/commands/execute', paths), false) // method-scoped
  assert.equal(matchesLongRpcPath('PUT', '/api/commands/execute', paths), false)
  assert.equal(matchesLongRpcPath('POST', '/api/session/list', paths), false) // path-scoped
  assert.equal(matchesLongRpcPath('POST', '/api/commands/execute/', paths), false) // exact — no trailing slash
  assert.equal(matchesLongRpcPath('POST', '/x/api/commands/execute', paths), false) // exact — no prefix nesting
  assert.equal(matchesLongRpcPath('POST', '/api/commands/execute/child', paths), false) // no nested sub-resource
  assert.equal(matchesLongRpcPath('POST', '/api/ARCHIVECLEANUP/purge', paths), false) // case-sensitive
  assert.equal(matchesLongRpcPath('POST', '/api/commands/execute', []), false) // empty list disables the exemption
})

/** A fake upstream that answers only after `delayMs`, wiring abort like the
 * real transport (an aborted request emits 'error' and never answers). */
function delayedHttpRequest(delayMs: number, body = '{"ok":true}') {
  const calls: Array<{ url: URL; options: Record<string, unknown> }> = []
  const fn: any = (url: URL, options: Record<string, unknown>) => {
    calls.push({ url, options })
    const request = new EventEmitter() as any
    request.write = () => true
    let timer: ReturnType<typeof setTimeout> | null = null
    request.end = () => {
      request.emit('finish')
      timer = setTimeout(() => {
        const upstreamRes = new EventEmitter() as any
        upstreamRes.statusCode = 200
        upstreamRes.headers = { 'content-type': 'application/json' }
        upstreamRes.destroy = () => upstreamRes.emit('close')
        upstreamRes.pause = () => {}
        upstreamRes.resume = () => {}
        request.emit('response', upstreamRes)
        upstreamRes.emit('data', Buffer.from(body))
        upstreamRes.emit('end')
      }, delayMs)
    }
    const signal = options?.signal as AbortSignal | undefined
    if (signal !== undefined) {
      if (signal.aborted) process.nextTick(() => request.emit('error', new Error('Aborted')))
      else signal.addEventListener('abort', () => {
        if (timer !== null) clearTimeout(timer)
        request.emit('error', new Error('Aborted'))
      }, { once: true })
    }
    return request
  }
  return { fn, calls }
}

test('long-RPC window: commands/execute answers after the ordinary idle window', async () => {
  const upstream = delayedHttpRequest(150)
  const proxy = proxyFor(upstream.fn, { upstreamTimeoutMs: 40, longRpcUpstreamTimeoutMs: 400 })
  const res = fakeResponse()
  await proxy.handleHttp(fakeRequest('/api/i/local/api/commands/execute', 'POST'), res)
  assert.equal(res.status, null)
  await sleep(60) // already past the ordinary 40ms window — the old code would have cut here
  assert.equal(res.status, null)
  assert.equal((upstream.calls[0].options.signal as AbortSignal).aborted, false)
  await sleep(180) // total 240 >= the 150ms answer
  assert.equal(res.status, 200)
  assert.equal(res.body, '{"ok":true}')
  // The proxy never invented a client disconnect for the slow business.
  assert.equal((upstream.calls[0].options.signal as AbortSignal).aborted, false)
  assert.equal(proxy.getDiagnostics().failures, 0)
  assert.equal(proxy.getDiagnostics().longRpcRequests, 1)
  assert.equal(proxy.getDiagnostics().longRpcTimeouts, 0)
})

test('long-RPC window is path-scoped: POST on an ordinary endpoint keeps the ordinary idle window', async () => {
  const upstream = delayedHttpRequest(150)
  const proxy = proxyFor(upstream.fn, { upstreamTimeoutMs: 40, longRpcUpstreamTimeoutMs: 400 })
  const res = fakeResponse()
  await proxy.handleHttp(fakeRequest('/api/i/local/api/session/list', 'POST'), res)
  assert.equal(res.status, null)
  await sleep(240) // the 150ms answer arrives after the 40ms cut
  assert.equal(res.status, 504)
  assert.ok(res.body.includes('upstream_timeout'))
  assert.equal(proxy.getDiagnostics().failures, 1)
  assert.equal(proxy.getDiagnostics().longRpcRequests, 0)
})

test('long-RPC window is method-scoped: GET on commands/execute keeps the ordinary idle window', async () => {
  const upstream = delayedHttpRequest(150)
  const proxy = proxyFor(upstream.fn, { upstreamTimeoutMs: 40, longRpcUpstreamTimeoutMs: 400 })
  const res = fakeResponse()
  await proxy.handleHttp(fakeRequest('/api/i/local/api/commands/execute', 'GET'), res)
  assert.equal(res.status, null)
  await sleep(240)
  assert.equal(res.status, 504)
  assert.ok(res.body.includes('upstream_timeout'))
  assert.equal(proxy.getDiagnostics().failures, 1)
  assert.equal(proxy.getDiagnostics().longRpcRequests, 0)
})

test('long-RPC window keeps a fuse: total silence → explicit 504 upstream_timeout', async () => {
  const upstream = fakeHttpRequest(() => undefined) // hang: no response, no error
  const proxy = proxyFor(upstream.fn, { upstreamTimeoutMs: 40, longRpcUpstreamTimeoutMs: 80 })
  const res = fakeResponse()
  try {
    await proxy.handleHttp(fakeRequest('/api/i/local/api/commands/execute', 'POST'), res)
    assert.equal(res.status, null) // not answered synchronously — the fuse decides
    await sleep(220)
    assert.equal(res.status, 504)
    assert.ok(res.body.includes('upstream_timeout'))
    // The hung upstream was aborted at the long-RPC fuse, not earlier.
    assert.equal((upstream.calls[0].options.signal as AbortSignal).aborted, true)
    assert.equal(proxy.getDiagnostics().failures, 1)
    assert.equal(proxy.getDiagnostics().longRpcRequests, 1)
    assert.equal(proxy.getDiagnostics().longRpcTimeouts, 1)
  } finally {
    // Watchdog: if the long-window injection is ever ignored (the 30-minute
    // default fuse), the failing assertions above must not leave a pending
    // fuse timer that hangs the whole test process — client-side teardown
    // clears it.
    res.destroy()
  }
})

test('long-RPC window: an explicit empty path list disables the exemption', async () => {
  const upstream = fakeHttpRequest(() => undefined) // hang
  const proxy = proxyFor(upstream.fn, { upstreamTimeoutMs: 40, longRpcUpstreamTimeoutMs: 400, longRpcPaths: [] })
  const res = fakeResponse()
  await proxy.handleHttp(fakeRequest('/api/i/local/api/commands/execute', 'POST'), res)
  assert.equal(res.status, null)
  await sleep(120) // ordinary 40ms window decides despite the long-window injection
  assert.equal(res.status, 504)
  assert.ok(res.body.includes('upstream_timeout'))
  assert.equal(proxy.getDiagnostics().longRpcRequests, 0)
})

test('long-RPC window: archiveCleanup/purge (chamber host domain) is exempted too', async () => {
  const upstream = delayedHttpRequest(150)
  const proxy = proxyFor(upstream.fn, { upstreamTimeoutMs: 40, longRpcUpstreamTimeoutMs: 400 })
  const res = fakeResponse()
  await proxy.handleHttp(fakeRequest('/api/i/local/api/archiveCleanup/purge', 'POST'), res)
  assert.equal(res.status, null)
  await sleep(240)
  assert.equal(res.status, 200)
  assert.equal(proxy.getDiagnostics().longRpcRequests, 1)
})

test('long-RPC window: after headers, a sparse non-SSE body idles across ordinary windows', async () => {
  const fn: any = () => {
    const request = new EventEmitter() as any
    request.write = () => true
    request.end = () => {
      const upstreamRes = new EventEmitter() as any
      upstreamRes.statusCode = 200
      upstreamRes.headers = { 'content-type': 'application/json' }
      upstreamRes.destroy = () => upstreamRes.emit('close')
      upstreamRes.pause = () => {}
      upstreamRes.resume = () => {}
      request.emit('response', upstreamRes)
      // Header→first-chunk and chunk→chunk gaps both exceed the ordinary 40ms
      // window: only the long-RPC re-arms (response + data handlers) keep this
      // response alive.
      setTimeout(() => upstreamRes.emit('data', Buffer.from('a')), 70)
      setTimeout(() => upstreamRes.emit('data', Buffer.from('b')), 140)
      setTimeout(() => upstreamRes.emit('end'), 150)
    }
    return request
  }
  const proxy = proxyFor(fn, { upstreamTimeoutMs: 40, longRpcUpstreamTimeoutMs: 400 })
  const res = fakeResponse()
  await proxy.handleHttp(fakeRequest('/api/i/local/api/commands/execute', 'POST'), res)
  await sleep(120) // past two ordinary windows; second chunk not yet sent
  assert.equal(res.status, 200)
  assert.equal((proxy.getDiagnostics().failures), 0)
  await sleep(140) // total 260 >= end at 150ms
  assert.equal(res.body, 'ab')
  assert.equal(proxy.getDiagnostics().failures, 0)
  assert.equal(proxy.getDiagnostics().longRpcRequests, 1)
  assert.equal(proxy.getDiagnostics().longRpcTimeouts, 0)
})

test('upgrade: a WebSocket handshake that never completes → explicit 504 on the socket', async () => {
  const upstream = fakeHttpRequest(() => undefined) // hang
  const proxy = proxyFor(upstream.fn, { upstreamTimeoutMs: 40 })
  const socket = fakeSocket()
  await proxy.handleUpgrade(fakeRequest('/api/i/local/api/remote.mux'), socket, Buffer.alloc(0))
  await sleep(80)
  assert.ok(socket.closed)
  assert.ok(socket.written.includes('504'), `socket got: ${socket.written}`)
  assert.ok(socket.written.includes('upstream_timeout'))
})

test('upgrade: request close does not abort the handshake; downstream socket close does', async () => {
  const captured = { signal: null as AbortSignal | null }
  const fn: any = (_url: URL, options: { signal: AbortSignal }) => {
    captured.signal = options.signal
    const request = new EventEmitter() as any
    request.write = () => true
    request.end = () => {}
    return request
  }
  const proxy = proxyFor(fn, { upstreamTimeoutMs: 200, getLocalDshPort: () => 17510 })
  const request = fakeRequest('/api/i/local/api/remote.mux')
  const socket = fakeSocket()
  await proxy.handleUpgrade(request, socket, Buffer.alloc(0))
  ;(request as unknown as EventEmitter).emit('close')
  assert.equal(captured.signal?.aborted, false)
  ;(socket as unknown as EventEmitter).emit('close')
  assert.equal(captured.signal?.aborted, true)
})

test('transport revoke is owner-scoped and closeAllStreams aborts every remaining pending WebSocket handshake', async () => {
  const upstream = fakeHttpRequest(() => undefined)
  const proxy = proxyFor(upstream.fn, { upstreamTimeoutMs: 5_000 })
  proxy.registerTransport('dsh:pending', 'http://127.0.0.1:19191')
  const local = fakeSocket()
  const remote = fakeSocket()
  // 0.1.2 wire: the mux is the only stream path (events.mux/events.host
  // were deleted upstream) — both pending handshakes ride /api/remote.mux.
  await proxy.handleUpgrade(fakeRequest('/api/i/local/api/remote.mux'), local, Buffer.alloc(0))
  await proxy.handleUpgrade(fakeRequest('/api/i/dsh-pending/api/remote.mux'), remote, Buffer.alloc(0))
  assert.equal(proxy.getDiagnostics().pendingUpgrades, 2)

  proxy.unregisterTransport('dsh:pending')
  assert.equal(remote.closed, true)
  assert.equal(local.closed, false, 'revoking one remote transport must not close the local handshake')
  assert.equal((upstream.calls[1]?.options.signal as AbortSignal | undefined)?.aborted, true)
  assert.equal((upstream.calls[0]?.options.signal as AbortSignal | undefined)?.aborted, false)
  assert.equal(proxy.getDiagnostics().pendingUpgrades, 1)

  proxy.closeAllStreams()

  assert.equal(local.closed, true)
  assert.equal((upstream.calls[0]?.options.signal as AbortSignal | undefined)?.aborted, true)
  assert.equal(proxy.getDiagnostics().pendingUpgrades, 0)
})

// ---------------------------------------------------------------------------
// WebSocket heartbeat (design 14 extension: sleep/wake silent-death recovery)
// ---------------------------------------------------------------------------

/** An upgrade factory that exposes the spliced upstream socket and records its writes. */
function heartbeatUpgradeFactory() {
  let captured: any = null
  const fn: any = () => {
    const req = new EventEmitter() as any
    req.write = () => true
    req.end = () => {
      const upstreamRes = new EventEmitter() as any
      upstreamRes.statusCode = 101
      upstreamRes.headers = { upgrade: 'websocket', connection: 'Upgrade' }
      const upstreamSocket = new EventEmitter() as any
      upstreamSocket.writes = []
      upstreamSocket.write = (data: unknown) => {
        upstreamSocket.writes.push(Buffer.from(data as Buffer))
        return true
      }
      upstreamSocket.destroy = () => { upstreamSocket.destroyed = true }
      upstreamSocket.pipe = (target: unknown) => target
      captured = upstreamSocket
      req.emit('upgrade', upstreamRes, upstreamSocket, Buffer.alloc(0))
    }
    return req
  }
  return { fn, get upstreamSocket() { return captured } }
}

test('heartbeat: pings the browser only and keeps a ponging stream alive', async () => {
  const factory = heartbeatUpgradeFactory()
  const proxy = proxyFor(factory.fn, { wsPingIntervalMs: 20, wsPingMissesBeforeTeardown: 1 })
  const down = fakeSocket()
  await proxy.handleUpgrade(fakeRequest('/api/i/local/api/remote.mux', 'GET'), down, Buffer.alloc(0))
  const up = factory.upstreamSocket
  assert.ok(up !== null)
  assert.equal(proxy.getDiagnostics().activeStreams, 1)

  // The browser answers with masked pongs (client→server).
  const respond = () => {
    ;(down as unknown as EventEmitter).emit('data', pongFrame(Buffer.from('down'), true))
  }
  respond() // answer the immediate first ping
  const responder = setInterval(respond, 15)
  await sleep(120) // ~6 ping cycles
  clearInterval(responder)

  assert.equal(proxy.getDiagnostics().activeStreams, 1, 'a ponging stream must stay spliced')
  assert.equal(down.closed, false)
  assert.equal((up as any).destroyed, undefined)
  // Downstream pings are unmasked (the proxy is the ws server to the browser);
  // the upstream leg deliberately gets NO pings (SSH keepalive / socket
  // events own its liveness).
  const downPing = down.writtenBuffers.find(chunk => chunk.length >= 2 && chunk[0] === 0x89)
  assert.ok(downPing !== undefined, 'downstream got a ping frame')
  assert.equal(downPing[1] & 0x80, 0, 'downstream pings are unmasked (server role)')
  const upPing = up.writes.find((chunk: Buffer) => chunk.length >= 2 && chunk[0] === 0x89)
  assert.equal(upPing, undefined, 'upstream must receive no pings (downstream-only heartbeat)')
})

test('heartbeat: missed pongs tear the splice down so the browser reconnects', async () => {
  const factory = heartbeatUpgradeFactory()
  const proxy = proxyFor(factory.fn, { wsPingIntervalMs: 20, wsPingMissesBeforeTeardown: 1 })
  const down = fakeSocket()
  await proxy.handleUpgrade(fakeRequest('/api/i/local/api/remote.mux', 'GET'), down, Buffer.alloc(0))
  const up = factory.upstreamSocket
  assert.ok(up !== null)
  assert.equal(proxy.getDiagnostics().activeStreams, 1)
  // No browser pongs: the leg is silently dead — the heartbeat must tear it down.
  await sleep(90)
  assert.equal(proxy.getDiagnostics().activeStreams, 0)
  assert.equal(down.closed, true, 'the browser socket must be closed (pump reconnects)')
  assert.equal((up as any).destroyed, true, 'the upstream socket must be destroyed')
})

test('heartbeat: teardown by other means stops the heartbeat (no stray pings after)', async () => {
  const factory = heartbeatUpgradeFactory()
  const proxy = proxyFor(factory.fn, { wsPingIntervalMs: 20, wsPingMissesBeforeTeardown: 1 })
  const down = fakeSocket()
  await proxy.handleUpgrade(fakeRequest('/api/i/local/api/remote.mux', 'GET'), down, Buffer.alloc(0))
  const up = factory.upstreamSocket
  assert.ok(up !== null)
  const pingsBefore = down.writtenBuffers.filter(chunk => chunk.length >= 2 && chunk[0] === 0x89).length
  ;(down as unknown as EventEmitter).emit('error', new Error('EPIPE')) // browser-side splice error
  assert.equal(proxy.getDiagnostics().activeStreams, 0)
  await sleep(70)
  const pingsAfter = down.writtenBuffers.filter(chunk => chunk.length >= 2 && chunk[0] === 0x89).length
  assert.equal(pingsAfter, pingsBefore, 'no pings may be injected after teardown')
})

test('heartbeat: a throwing write self-cleans (onDead once, interval stopped)', async () => {
  // The first ping write fails synchronously (socket already destroyed): the
  // heartbeat must tear itself down — onDead exactly once, never an armed
  // interval firing onDead every cycle.
  const down = new EventEmitter() as any
  down.write = () => { throw new Error('socket destroyed') }
  let dead = 0
  const heartbeat = startWsHeartbeat({
    downstream: down,
    intervalMs: 20,
    missesBeforeTeardown: 1,
    onDead: () => { dead += 1 },
  })
  await sleep(100)
  assert.equal(dead, 1, 'onDead must fire exactly once (the interval is stopped)')
  heartbeat.stop()
})

