/**
 * WebSocket liveness heartbeat (RFC 6455 §5.5.2/§5.5.3) for the instance-proxy
 * event-stream splices (design 14 extension — sleep/wake stuck-deep-diving
 * fix).
 *
 * ## Why
 *
 * `events.mux` / `events.host` are downlink-only WebSockets with no heartbeat
 * on either side: the dsh host never pings, and its ws server closes (1008)
 * any client message, so the browser cannot probe the connection itself.
 * After an OS sleep/wake the BROWSER leg of the splice can silently die
 * (half-open TCP) without any 'error'/'close' firing — the proxy would hold
 * the stream open forever while the browser's pump stays "connected" but
 * receives nothing (stuck "Deep diving..." UI, backend still processing).
 *
 * The proxy owns the DOWNSTREAM leg's liveness (it is the one point that sees
 * it, and neither the browser nor the host can probe it):
 *
 *  - every `intervalMs`, an unmasked ping frame is injected downstream (the
 *    proxy is the ws server to the browser; the browser auto-pongs per RFC,
 *    transparently, no app code);
 *  - a passive pong scanner on the browser socket's 'data' stream marks the
 *    leg alive (the scanner never consumes bytes, so the existing pipe is
 *    untouched — only the browser→proxy direction carries pongs);
 *  - after `missesBeforeTeardown` consecutive ping cycles without a pong,
 *    `onDead` fires — the caller tears the splice down, the browser's
 *    WebSocket closes, and the renderer pump reconnects (fresh stream → host
 *    baseline replay → the runtime re-syncs session state).
 *
 * The UPSTREAM (host) leg deliberately has NO heartbeat here: its death is
 * covered by the existing industry-standard mechanisms — SSH keepalive for
 * remote tunnels (`ServerAliveInterval=30 × CountMax=3` ≈ 90s, ssh-provider),
 * socket 'error'/'close' for local host death/restart, and the host's own
 * send-failure detection (its ws server closes on write errors). A proxy-side
 * upstream ping would only race SSH keepalive into a reconnect flap against a
 * half-open tunnel (strict tolerance) or fire later than it (lenient
 * tolerance — useless), so it is intentionally not implemented.
 *
 * Defaults follow the canonical `ws` README heartbeat example (30s interval,
 * one unanswered ping cycle → terminate): `WS_PING_INTERVAL_MS` /
 * `WS_PING_MISSES_BEFORE_TEARDOWN` in instance-proxy.ts. The interval is
 * unref'd so it can never block app exit, and stop() clears it.
 */

import { encodePingFrame, PongScanner } from './ws-frames.ts'

/** A socket surface sufficient for the heartbeat (ProxySocket fits). */
export interface WsHeartbeatSocket {
  write(chunk: Buffer): unknown
  on(event: 'data', listener: (chunk: Buffer) => void): unknown
  removeListener(event: 'data', listener: (chunk: Buffer) => void): unknown
}

export interface WsHeartbeatOptions {
  /** The downstream (browser) socket; the proxy acts as the ws server. */
  downstream: WsHeartbeatSocket
  /** Ping cadence. */
  intervalMs: number
  /**
   * Consecutive ping cycles without a browser pong before onDead fires
   * (defaults per the ws README heartbeat example: 1 — a single unanswered
   * ping cycle means the leg is dead; the pong round-trip is loopback so a
   * full cycle without one cannot be scheduler noise).
   */
  missesBeforeTeardown: number
  /** Fired once when the leg is judged dead (caller tears the splice down). */
  onDead: () => void
  /** Injectable ping payload (default: 8 random bytes, ≤ 125). */
  pingPayload?: () => Buffer
}

export interface WsHeartbeatHandle {
  stop(): void
}

function defaultPingPayload(): Buffer {
  const payload = Buffer.allocUnsafe(8)
  for (let i = 0; i < payload.length; i++) payload[i] = Math.floor(Math.random() * 256)
  return payload
}

/**
 * Start the heartbeat for one spliced stream. Returns a stop handle
 * (idempotent; clears the interval and removes the data listener).
 */
export function startWsHeartbeat(options: WsHeartbeatOptions): WsHeartbeatHandle {
  const { downstream, intervalMs, missesBeforeTeardown, onDead } = options
  const pingPayload = options.pingPayload ?? defaultPingPayload
  const scanner = new PongScanner()
  let pong = false
  let misses = 0
  let stopped = false

  const onData = (chunk: Buffer): void => {
    if (scanner.push(chunk)) pong = true
  }
  downstream.on('data', onData)

  // `timer` is assigned before the first tick() runs, so stop() — which
  // clears it — can never hit the TDZ (tick() is also the onDead entry
  // point, and stop() must be safe from inside the very first tick).
  const stop = (): void => {
    if (stopped) return
    stopped = true
    clearInterval(timer)
    downstream.removeListener('data', onData)
  }

  let outstanding = false

  /** One cycle: account for the previous ping (if any), then send a fresh one. */
  const tick = (): void => {
    if (stopped) return
    if (outstanding) {
      if (pong) misses = 0
      else misses += 1
      pong = false
    }
    if (misses >= missesBeforeTeardown) {
      onDead()
      stop() // self-cleanup: never leave an armed interval on a dead stream
      return
    }
    const payload = pingPayload()
    try {
      downstream.write(encodePingFrame(payload))
      outstanding = true
    } catch {
      onDead()
      stop()
    }
  }

  const timer: ReturnType<typeof setInterval> = setInterval(tick, intervalMs)
  timer.unref?.()
  // First ping immediately so a healthy connection answers before the first
  // interval check; misses only start counting once a ping has had a full
  // cycle to be answered.
  tick()
  return { stop }
}
