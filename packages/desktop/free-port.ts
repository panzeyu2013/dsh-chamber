/**
 * Free-port probing for the dev control-plane auto-backoff and the tunnel
 * transports' local ports.
 *
 * Pure node (no Electron import). Dev instances isolate user-data per worktree
 * but share the default dev control-plane port (17520) across parallel
 * worktrees, so the main process picks the first free port from the base
 * upward unless DSH_CHAMBER_CP_PORT pins one. Tunnel transports have no port
 * preference and use the OS-assigned ephemeral arm; both arms share one
 * bind-and-release probe kernel (`listen(0)` semantics).
 */

import { createServer, type AddressInfo } from 'node:net'

export interface FindFreePortOptions {
  host?: string
  attempts?: number
}

/** Bind-and-release probe shared by both arms: binds `port` on `host` (0 =
 * OS-assigned) and resolves with the ACTUAL bound port only after 'close', so
 * the port is really released before the caller binds it (listen-close
 * ordering matters on some platforms). A bind failure resolves `{ok:false}`
 * with the raw error (the range probe reads it as "taken"; the ephemeral arm
 * rethrows it). */
function probePort(port: number, host: string): Promise<{ ok: true; port: number } | { ok: false; error: unknown }> {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.unref()
    probe.once('error', (error: unknown) => {
      // close() on a server that never listened throws; swallow it.
      try {
        probe.close()
      } catch {
        /* never listened */
      }
      resolve({ ok: false, error })
    })
    probe.listen(port, host, () => {
      const bound = (probe.address() as AddressInfo).port
      probe.close(() => resolve({ ok: true, port: bound }))
    })
  })
}

/** First free port at or above `start` on `host` (default 127.0.0.1, the
 * control plane's own bind host); RangeError when the range is full. The
 * probe-then-bind race is inherent but negligible on the dev loopback surface,
 * and the control plane reports a bind failure loudly instead of silently
 * picking another port. */
export async function findFreePort(start: number, options: FindFreePortOptions = {}): Promise<number> {
  const host = options.host ?? '127.0.0.1'
  const attempts = options.attempts ?? 200
  // start < 1 is rejected on purpose: listen(0) would bind a random port,
  // contradicting the "first free from start" contract (see findFreeEphemeralPort).
  if (!Number.isInteger(start) || start < 1 || start > 65535) {
    throw new RangeError(`invalid start port: ${start}`)
  }
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new RangeError(`invalid attempts: ${attempts}`)
  }
  const last = Math.min(start + attempts - 1, 65535)
  for (let port = start; port <= last; port += 1) {
    if ((await probePort(port, host)).ok) return port
  }
  throw new RangeError(`no free port in ${start}..${last} on ${host}`)
}

/** One OS-assigned (ephemeral) port on `host` (default 127.0.0.1, the tunnel
 * transports' loopback bind host): `listen(0)` semantics for callers with no
 * port preference. Rejects with the raw bind error when the OS cannot assign
 * one. */
export async function findFreeEphemeralPort(host = '127.0.0.1'): Promise<number> {
  const outcome = await probePort(0, host)
  if (!outcome.ok) throw outcome.error
  return outcome.port
}
