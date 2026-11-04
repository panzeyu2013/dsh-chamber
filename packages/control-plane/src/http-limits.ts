/**
 * HTTP server limits and the app-level header deadline (design 27 §3.4 / plan P0-1).
 *
 * WHY THIS MODULE EXISTS
 * Node's in-process request deadline is max(headersTimeout, requestTimeout) and is
 * swept on the construction-time connectionsCheckingInterval. That means the two
 * fields cannot express "short header window + long body budget": raising
 * requestTimeout to cover a slow upload also raises the header deadline. The
 * server therefore keeps BOTH Node values high as a last-resort backstop and
 * enforces the real 10s header window here, in user space.
 *
 * The body budget itself lives in the proxy (readBody totalBudgetMs), derived
 * from the wire NET_BUDGET table.
 */

import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { Socket } from 'node:net'

export interface HttpServerLimits {
  /** Last-resort Node header timeout. Keep it above every app-level budget. */
  headersTimeoutMs: number
  /** Last-resort Node whole-request timeout (body included). */
  requestTimeoutMs: number
  /** Node's checker cadence; must be passed at createServer time. */
  connectionsCheckingIntervalMs: number
  keepAliveTimeoutMs: number
  maxRequestsPerSocket: number
  /** Node's silent hard stop. Kept ABOVE `connectionSoftCap`: Node drops a
   *  connection over this limit with no HTTP answer, so the app-level soft cap
   *  must be the one a client actually reaches. */
  maxConnections: number
  /** Concurrent established TCP connections the app enforces itself: a socket
   *  that would exceed it receives a raw HTTP 503 + close (never a silent drop).
   *  Must stay below maxConnections. */
  connectionSoftCap: number
  /** The real header deadline enforced in user space. */
  headerDeadlineMs: number
  /** A declared Content-Length above this is refused before 100-continue; the
   *  proxy's own 300MiB cap is the source of this value at the call site. */
  expectContinueMaxBytes: number
}

export const HTTP_SERVER_LIMITS: HttpServerLimits = {
  // The application enforces a 10s header window and a 30min body budget; Node is
  // only the dead-man switch for bugs, so both values sit above the app budgets.
  headersTimeoutMs: 31 * 60_000,
  requestTimeoutMs: 31 * 60_000,
  connectionsCheckingIntervalMs: 5_000,
  keepAliveTimeoutMs: 5_000,
  maxRequestsPerSocket: 1_000,
  // Node's net stop is only the dead-man switch: the explicit 192 soft cap below
  // answers a real 503, while the last 64 connections of headroom absorb a burst
  // between the accept and the user-space verdict.
  maxConnections: 256,
  connectionSoftCap: 192,
  headerDeadlineMs: 10_000,
  expectContinueMaxBytes: 300 * 1024 * 1024,
}

/** Sockets the soft cap has already answered with a raw 503. The connection
 *  listener and the request parser both run on the same socket: without this
 *  mark, a request pipelined on a refused connection would still reach the app
 *  handler (side effects!) even though the client already got a 503. */
const softCapRefusedSockets = new WeakSet<Socket>()

/** Create the server with the construction-time options Node actually honours.
 *  maxRequestsPerSocket/maxConnections are applied afterwards: Node v24 resets
 *  maxRequestsPerSocket to 0 in its Server constructor, so passing it as an
 *  option is a silent no-op.
 *
 *  The request wrapper refuses a request parsed off an already-refused socket:
 *  the 503 went out at accept time, so the app must neither execute the request
 *  nor write a second response. */
export function createLimitedServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  limits: HttpServerLimits = HTTP_SERVER_LIMITS,
): Server {
  const server = createServer({
    headersTimeout: limits.headersTimeoutMs,
    requestTimeout: limits.requestTimeoutMs,
    connectionsCheckingInterval: limits.connectionsCheckingIntervalMs,
    keepAliveTimeout: limits.keepAliveTimeoutMs,
  })
  server.on('request', (req, res) => {
    if (softCapRefusedSockets.has(req.socket)) {
      try { res.destroy() } catch { /* already gone */ }
      return
    }
    handler(req, res)
  })
  // Expect: 100-continue must not earn an optimistic 100 for a body the proxy
  // will refuse anyway (413 before any body byte). A small body gets the normal
  // 100 and then the ordinary request path.
  server.on('checkContinue', (req, res) => {
    if (softCapRefusedSockets.has(req.socket)) {
      try { req.socket.destroy() } catch { /* already gone */ }
      return
    }
    const raw = req.headers['content-length']
    const declared = typeof raw === 'string' ? Number(raw) : NaN
    if (Number.isFinite(declared) && declared > limits.expectContinueMaxBytes) {
      try {
        res.writeHead(413, { 'content-type': 'application/json', connection: 'close' })
        res.end(JSON.stringify({ error: 'body_too_large', code: 'body_too_large' }))
      } catch { /* socket already gone */ }
      return
    }
    res.writeContinue()
    handler(req, res)
  })
  return server
}

/** Exposed for the upgrade dispatcher: a refused socket must not execute an
 *  upgrade either (the request wrapper only covers 'request'/'checkContinue'). */
export function isSoftCapRefusedSocket(socket: unknown): boolean {
  return softCapRefusedSockets.has(socket as Socket)
}

export function applyHttpServerLimits(server: Server, limits: HttpServerLimits = HTTP_SERVER_LIMITS): void {
  // Both are plain properties read per connection/request; neither is an option
  // on the Server constructor in Node v24.
  server.maxRequestsPerSocket = limits.maxRequestsPerSocket
  server.maxConnections = limits.maxConnections
}

/**
 * Enforce a real per-connection header deadline. Armed on connection, cleared
 * when a complete request arrives, re-armed after the response finishes so the
 * next keep-alive request gets the same window. A connection that never
 * completes its headers is destroyed (no HTTP response is possible yet).
 *
 * Returns an idempotent disposer for tests and re-created servers.
 */
export function installHeaderDeadline(
  server: Server,
  deadlineMs: number = HTTP_SERVER_LIMITS.headerDeadlineMs,
): () => void {
  const timers = new WeakMap<Socket, ReturnType<typeof setTimeout>>()
  /** Responses parsed but not finished on this socket. A pipelined second
   *  request must keep the header timer disarmed until ITS response finishes;
   *  re-arming on the first finish killed the second answer with a raw RST. */
  const active = new WeakMap<Socket, number>()

  const clear = (socket: Socket): void => {
    const timer = timers.get(socket)
    if (timer !== undefined) {
      clearTimeout(timer)
      timers.delete(socket)
    }
  }
  const arm = (socket: Socket): void => {
    clear(socket)
    if (socket.destroyed) return
    const timer = setTimeout(() => {
      timers.delete(socket)
      if (!socket.destroyed) socket.destroy()
    }, deadlineMs)
    timers.set(socket, timer)
  }

  const onConnection = (socket: Socket): void => {
    active.set(socket, active.get(socket) ?? 0)
    arm(socket)
    socket.once('close', () => {
      active.delete(socket)
      clear(socket)
    })
  }
  // Both events must share ONE accounting path: when createLimitedServer has a
  // checkContinue listener, Node does NOT emit 'request' for that exchange. If
  // only 'request' clears the timer, a slow Expect body is killed at the header
  // deadline even though its headers arrived long ago (merge review A-M1).
  const trackRequest = (req: IncomingMessage, res: ServerResponse): void => {
    const socket = req.socket
    clear(socket)
    active.set(socket, (active.get(socket) ?? 0) + 1)
    let settled = false
    const done = (): void => {
      if (settled) return
      settled = true
      const remaining = Math.max(0, (active.get(socket) ?? 1) - 1)
      active.set(socket, remaining)
      if (remaining === 0 && !socket.destroyed) arm(socket)
    }
    res.once('finish', done)
    res.once('close', () => {
      // A client abort settles the response too; never arm on a dead socket.
      if (settled) return
      settled = true
      active.set(socket, Math.max(0, (active.get(socket) ?? 1) - 1))
    })
    // A handler may end the response before this listener runs (the request
    // listeners are invoked in registration order); in that case 'finish' has
    // already fired or is about to, and the immediate check keeps the next
    // keep-alive request covered.
    if (res.writableEnded) done()
  }

  // An upgraded socket never fires 'request'; without this arm the connection's
  // header timer would destroy a live WebSocket 10s after the handshake.
  const onUpgrade = (_req: IncomingMessage, socket: import('node:stream').Duplex): void => {
    clear(socket as unknown as Socket)
  }

  server.on('connection', onConnection)
  server.on('request', trackRequest)
  server.on('checkContinue', trackRequest)
  server.on('upgrade', onUpgrade)
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    server.off('connection', onConnection)
    server.off('request', trackRequest)
    server.off('checkContinue', trackRequest)
    server.off('upgrade', onUpgrade)
  }
}

/**
 * The app-level concurrent-connection soft cap (plan P2-4). Node's
 * `maxConnections` is a silent hard stop: the socket is dropped without an HTTP
 * answer, which a client cannot classify (the historical 192 value did exactly
 * this while slow bodies occupied every slot). This listener counts established
 * TCP connections and, for every connection above the cap, writes a byte-exact
 * HTTP 503 + Connection: close before ending the socket. The hard cap
 * (`maxConnections`) stays above it as a net-level dead-man switch only.
 *
 * The JSON body is written without a request line: the client has just opened
 * the socket, and an explicit capacity answer is still more useful than a
 * reset. Rejected sockets are counted while they close, so a burst cannot
 * starve the accepted set for longer than the FIN round-trip. The request
 * guard that keeps a pipelined request off a refused socket is part of
 * createLimitedServer (the server factory this installer is paired with).
 *
 * Returns an idempotent disposer for tests and re-created servers.
 */
const CONNECTION_SOFT_CAP_BODY = JSON.stringify({
  error: 'too many concurrent connections',
  code: 'resource_exhausted',
  details: { kind: 'connection', scope: 'global' },
})
const CONNECTION_SOFT_CAP_RESPONSE = 'HTTP/1.1 503 Service Unavailable\r\n'
  + 'Connection: close\r\n'
  + 'Content-Type: application/json\r\n'
  + `Content-Length: ${Buffer.byteLength(CONNECTION_SOFT_CAP_BODY)}\r\n`
  + 'Cache-Control: no-store\r\n'
  + '\r\n'
  + CONNECTION_SOFT_CAP_BODY

export function installConnectionSoftCap(
  server: Server,
  softCap: number = HTTP_SERVER_LIMITS.connectionSoftCap,
): () => void {
  let active = 0
  const onConnection = (socket: Socket): void => {
    active += 1
    socket.once('close', () => { active = Math.max(0, active - 1) })
    if (active <= softCap) return
    // Mark BEFORE writing: a request already in flight on this socket must be
    // dropped by createLimitedServer's request guard, never dispatched.
    softCapRefusedSockets.add(socket)
    try {
      // The peer may already be gone: consume the error so an EPIPE can never
      // become an uncaught exception in the connection listener.
      socket.on('error', () => {})
      socket.write(CONNECTION_SOFT_CAP_RESPONSE)
      socket.end()
    } catch {
      socket.destroy()
    }
  }
  server.on('connection', onConnection)
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    server.off('connection', onConnection)
  }
}
