/**
 * Free-port probing for the dev control-plane auto-backoff and the tunnel
 * transports' local ports.
 *
 * Pure node (no Electron import) so it runs under plain node in tests. Dev
 * instances isolate user-data per worktree (electron-dev.mjs
 * --user-data-dir), but the default dev control-plane port (17520) is shared
 * across parallel worktrees — the main process picks the first free port from
 * the base upward instead of colliding (DSH_CHAMBER_CP_PORT still pins a
 * fixed port; findFreePort is only consulted when it is unset). Tunnel
 * transports have no port preference and use the OS-assigned ephemeral arm
 * (findFreeEphemeralPort) for their loopback local ports — the same
 * bind-and-release probe kernel, `listen(0)` semantics (formerly a separate
 * allocateLocalPort in transport-manager.ts).
 */

import { createServer, type AddressInfo } from 'node:net'

export interface FindFreePortOptions {
  host?: string
  /** Number of candidate ports to try from `start` upward. */
  attempts?: number
}

/** Bind-and-release probe shared by findFreePort / findFreeEphemeralPort.
 * Binds `port` on `host` (0 = OS-assigned ephemeral port) and resolves with
 * the ACTUAL bound port only after the 'close' event — the port is really
 * released before the caller binds it (listen-close ordering matters on some
 * platforms). A bind failure resolves `{ok:false}` carrying the raw error
 * (the range probe treats it as "taken"; the ephemeral arm rethrows it). */
function probePort(port: number, host: string): Promise<{ ok: true; port: number } | { ok: false; error: unknown }> {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.unref()
    probe.once('error', (error: unknown) => {
      // EADDRINUSE etc. — the candidate is taken (or the bind failed).
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

/**
 * First free port at or above `start` bound on `host` (default 127.0.0.1 —
 * the control plane's own bind host). Rejects with RangeError when the whole
 * range is occupied. There is an inherent probe-then-bind race; on the dev
 * loopback surface it is negligible, and the control plane reports a bind
 * failure loudly instead of silently picking another port.
 */
export async function findFreePort(start: number, options: FindFreePortOptions = {}): Promise<number> {
  const host = options.host ?? '127.0.0.1'
  const attempts = options.attempts ?? 200
  // 0 is rejected on purpose: listen(0) binds a random ephemeral port, which
  // contradicts the "first free port from start" contract. Callers that want
  // an OS-assigned port use findFreeEphemeralPort.
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

/**
 * One OS-assigned (ephemeral) free port bound on `host` (default 127.0.0.1 —
 * the tunnel transports' loopback bind host): `listen(0)` semantics for
 * callers with no port preference. Rejects with the raw bind error when the
 * OS cannot assign an ephemeral port.
 */
export async function findFreeEphemeralPort(host = '127.0.0.1'): Promise<number> {
  const outcome = await probePort(0, host)
  if (!outcome.ok) throw outcome.error
  return outcome.port
}
