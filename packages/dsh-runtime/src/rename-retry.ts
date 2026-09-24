/**
 * Windows-safe directory rename with bounded retry. On Windows a directory rename fails
 * with EPERM/EBUSY while any third-party handle holds the tree (Defender, indexer, an
 * Explorer window, …); Windows never grants POSIX-style atomic directory swaps, so the
 * practice is to retry on a short bounded schedule and then surface the error honestly —
 * the journal/marker layers above resume an interrupted transaction on the next startup,
 * so the retry shrinks the transient window without inventing false atomicity.
 *
 * POSIX is the plain `rename`: off-win32 hosts never touch the retry schedule.
 */

import { renameSync } from 'node:fs'
import { rename as renameFile } from 'node:fs/promises'

/** Retry schedule (ms) between attempts after a transient Windows rename failure. Bounded
 *  by design: the caller's transaction marker is durable and resumable. */
export const WINDOWS_RENAME_RETRY_DELAYS_MS: readonly number[] = [100, 250, 500, 1000]

/** Windows transient rename error codes: a handle holding the tree (EPERM/EBUSY) or a
 *  permission/state hiccup worth one retry (EACCES). Everything else fails immediately. */
export function isTransientWindowsRenameError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES'
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

/** Injectable seams for both schedules: async callers use renameFn/sleep, the synchronous
 *  metadata-recovery API uses renameSyncFn/sleepSync. */
export interface RenameRetryDeps {
  renameFn?: typeof renameFile
  sleep?: (ms: number) => Promise<void>
  renameSyncFn?: (from: string, to: string) => void
  sleepSync?: (ms: number) => void
  /** Injectable platform verdict (defaults to the real platform; tests simulate win32). */
  isWindows?: boolean
}

/**
 * Rename `from` → `to`. On win32 a transient failure is retried on the bounded schedule;
 * the final failure is the original error. Off win32 this is exactly `rename(from, to)`.
 */
export async function renameWithWindowsRetry(
  from: string,
  to: string,
  deps: RenameRetryDeps = {},
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

/** Bounded synchronous wait. Atomics.wait parks the thread without spinning; the
 *  SharedArrayBuffer is a fresh throwaway, so the schedule costs no allocation loop. */
function boundedSyncDelay(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Synchronous sibling of renameWithWindowsRetry for the metadata-recovery transaction, whose
 * renamePath seam is synchronous. Off win32 this is exactly renameSync; on win32 the same
 * transient-code schedule is retried with a bounded synchronous wait.
 */
export function renameWithWindowsRetrySync(from: string, to: string, deps: RenameRetryDeps = {}): void {
  const rename = deps.renameSyncFn ?? renameSync
  const isWindows = deps.isWindows ?? process.platform === 'win32'
  if (!isWindows) {
    rename(from, to)
    return
  }
  const sleep = deps.sleepSync ?? boundedSyncDelay
  let lastError: unknown
  for (let attempt = 0; attempt <= WINDOWS_RENAME_RETRY_DELAYS_MS.length; attempt++) {
    try {
      rename(from, to)
      return
    } catch (error) {
      lastError = error
      if (!isTransientWindowsRenameError(error)) throw error
      if (attempt < WINDOWS_RENAME_RETRY_DELAYS_MS.length) {
        sleep(WINDOWS_RENAME_RETRY_DELAYS_MS[attempt])
      }
    }
  }
  throw lastError
}
