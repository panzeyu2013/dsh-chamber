/**
 * WebSocket liveness heartbeat (RFC 6455 §5.5.2/§5.5.3) for the instance-proxy
 * event-stream splices.
 *
 * The host mux already pings and terminates on two missed pongs; this is a
 * redundant fallback for the browser leg across OS sleep/wake, where it can go
 * half-open with no local 'error'/'close'. Each interval the proxy injects an
 * unmasked ping downstream; a passive scanner marks the leg alive from pongs
 * without consuming bytes, and after `missesBeforeTeardown` pong-less cycles
 * `onDead` fires for the caller to tear the splice down.
 *
 * The upstream (host) leg deliberately has NO heartbeat: SSH keepalive, socket
 * 'error'/'close' and the host's own send-failure detection already cover it.
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
   * Missed browser pong cycles before onDead fires (the default follows the ws
   * README heartbeat example: 1 — a pong round-trip is loopback, so a full
   * cycle without one cannot be scheduler noise).
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

/** Start the heartbeat for one spliced stream. Returns an idempotent stop
 *  handle that clears the interval and removes the data listener. */
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

  // `timer` is assigned before the first tick(), so stop() can never hit the
  // TDZ — note tick() is also the onDead entry point.
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
  // interval check; misses only count after a ping has had a full cycle.
  tick()
  return { stop }
}
