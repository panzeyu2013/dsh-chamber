/**
 * rename-retry unit tests (design 21 M2a / C5 mitigation): the transient-error
 * classification and the bounded win32 retry schedule are policy-pure and are
 * exercised here on every platform via the injected platform/fn/sleep seams.
 * The win32 policy cases are one failure-script table (2026-12 trim).
 *
 * Run directly: node packages/dsh-runtime/test/windows/rename-retry.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isTransientWindowsRenameError, renameWithWindowsRetry, WINDOWS_RENAME_RETRY_DELAYS_MS } from '../../src/rename-retry.ts'

function errWithCode(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException
  error.code = code
  return error
}

test('only transient Windows codes are retried', () => {
  assert.equal(isTransientWindowsRenameError(errWithCode('EPERM')), true)
  assert.equal(isTransientWindowsRenameError(errWithCode('EBUSY')), true)
  assert.equal(isTransientWindowsRenameError(errWithCode('EACCES')), true)
  assert.equal(isTransientWindowsRenameError(errWithCode('ENOENT')), false)
  assert.equal(isTransientWindowsRenameError(new Error('plain')), false)
  assert.equal(isTransientWindowsRenameError(null), false)
})

test('off win32 the rename is a single plain call (POSIX byte-identical behavior)', async () => {
  const sleeps: number[] = []
  let calls = 0
  const renameFn = async () => { calls++ }
  await renameWithWindowsRetry('a', 'b', {
    isWindows: false,
    renameFn: renameFn as never,
    sleep: async (ms) => { sleeps.push(ms) },
  })
  assert.equal(calls, 1)
  assert.deepEqual(sleeps, [])
})

/** Drive the win32 policy with a per-call failure script (null = succeed). */
async function driveWin32Rename(shouldFail: (call: number) => NodeJS.ErrnoException | null) {
  const sleeps: number[] = []
  let calls = 0
  const renameFn = async () => { calls++; const failure = shouldFail(calls); if (failure !== null) throw failure }
  let error: NodeJS.ErrnoException | null = null
  try {
    await renameWithWindowsRetry('a', 'b', { isWindows: true, renameFn: renameFn as never, sleep: async (ms) => { sleeps.push(ms) } })
  } catch (caught) { error = caught as NodeJS.ErrnoException }
  return { calls, sleeps, error }
}

test('win32 policy: transient retries, exhaustion rethrows, permanent fails fast', async () => {
  const retried = await driveWin32Rename(call => call < 3 ? errWithCode('EPERM') : null)
  assert.equal(retried.error, null)
  assert.equal(retried.calls, 3)
  assert.deepEqual(retried.sleeps, [WINDOWS_RENAME_RETRY_DELAYS_MS[0], WINDOWS_RENAME_RETRY_DELAYS_MS[1]])
  const exhausted = await driveWin32Rename(() => errWithCode('EBUSY'))
  assert.equal(exhausted.error?.code, 'EBUSY')
  assert.equal(exhausted.sleeps.length, WINDOWS_RENAME_RETRY_DELAYS_MS.length)
  assert.deepEqual(exhausted.sleeps, [...WINDOWS_RENAME_RETRY_DELAYS_MS])
  const permanent = await driveWin32Rename(() => errWithCode('ENOENT'))
  assert.equal(permanent.error?.code, 'ENOENT')
  assert.deepEqual(permanent.sleeps, [])
})
