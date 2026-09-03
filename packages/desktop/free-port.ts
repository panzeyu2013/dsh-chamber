/**
 * Free-port probing for the dev control-plane auto-backoff.
 *
 * Pure node (no Electron import) so it runs under plain node in tests. Dev
 * instances isolate user-data per worktree (electron-dev.mjs
 * --user-data-dir), but the default dev control-plane port (17520) is shared
 * across parallel worktrees — the main process picks the first free port from
 * the base upward instead of colliding (DSH_CHAMBER_CP_PORT still pins a
 * fixed port; findFreePort is only consulted when it is unset).
 */

import { createServer } from 'node:net'

export interface FindFreePortOptions {
  host?: string
  /** Number of candidate ports to try from `start` upward. */
  attempts?: number
}

function isPortFree(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.unref()
    probe.once('error', () => {
      // EADDRINUSE etc. — the candidate is taken. close() on a server that
      // never listened throws; swallow it.
      try {
        probe.close()
      } catch {
        /* never listened */
      }
      resolve(false)
    })
    probe.listen(port, host, () => {
      // Resolve only after the 'close' event: the port is really released
      // before the caller binds it (listen-close ordering matters on some
      // platforms).
      probe.close(() => resolve(true))
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
  // an OS-assigned port pass 0 straight to the control plane instead.
  if (!Number.isInteger(start) || start < 1 || start > 65535) {
    throw new RangeError(`invalid start port: ${start}`)
  }
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new RangeError(`invalid attempts: ${attempts}`)
  }
  const last = Math.min(start + attempts - 1, 65535)
  for (let port = start; port <= last; port += 1) {
    if (await isPortFree(port, host)) return port
  }
  throw new RangeError(`no free port in ${start}..${last} on ${host}`)
}
