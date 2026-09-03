/**
 * Windows-safe directory rename with bounded retry (design 21 M2a / C5
 * mitigation). On Windows a directory rename fails with EPERM/EBUSY while any
 * third-party handle holds the tree (Defender scanning, search indexer, an
 * Explorer window, …). Windows never grants POSIX-style atomic directory
 * swaps, so the standard practice is: retry the rename over a short bounded
 * schedule and, when it still fails, surface the error honestly — the
 * activation journal / restore marker layers above this module already resume
 * an interrupted transaction on the next startup (续作), so a bounded retry
 * here shrinks the transient window without inventing false atomicity.
 *
 * POSIX behavior is byte-for-byte unchanged: off-win32 hosts call the plain
 * `rename` and never touch the retry schedule. Pure policy functions are
 * unit-tested on every CI leg; only the schedule constants are exported for
 * owners who need a visible policy.
 */

import { rename as renameFile } from 'node:fs/promises'

/** Retry schedule (ms) between attempts after a transient Windows rename
 *  failure. Bounded by design: the caller's transaction marker is durable and
 *  resumable, so an unbounded wait here would only delay the honest error. */
export const WINDOWS_RENAME_RETRY_DELAYS_MS: readonly number[] = [100, 250, 500, 1000]

/** Windows transient rename error codes: a handle is holding the tree
 *  (EPERM/EBUSY), or a permission/state hiccup worth one bounded retry
 *  (EACCES). Everything else is permanent and fails immediately. */
export function isTransientWindowsRenameError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES'
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

/**
 * Rename `from` → `to`. On win32 a transient failure is retried on the
 * bounded schedule (WINDOWS_RENAME_RETRY_DELAYS_MS); the final failure is the
 * original error. Off win32 this is exactly `rename(from, to)`.
 *
 * @param deps.renameFn - injectable fs seam (defaults to node:fs/promises rename).
 * @param deps.sleep - injectable delay seam (unit tests never wait real time).
 * @param deps.isWindows - injectable platform verdict (defaults to the real
 *   platform; tests simulate the win32 branch on any host).
 */
export async function renameWithWindowsRetry(
  from: string,
  to: string,
  deps: { renameFn?: typeof renameFile; sleep?: (ms: number) => Promise<void>; isWindows?: boolean } = {},
): Promise<void> {
  const rename = deps.renameFn ?? renameFile
  const isWindows = deps.isWindows ?? process.platform === 'win32'
  if (!isWindows) {
    await rename(from, to)
    return
  }
  const sleep = deps.sleep ?? delay
  let lastError: unknown
  for (let attempt = 0; attempt <= WINDOWS_RENAME_RETRY_DELAYS_MS.length; attempt++) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      lastError = error
      if (!isTransientWindowsRenameError(error)) throw error
      if (attempt < WINDOWS_RENAME_RETRY_DELAYS_MS.length) {
        await sleep(WINDOWS_RENAME_RETRY_DELAYS_MS[attempt])
      }
    }
  }
  throw lastError
}
