/**
 * rename-retry unit tests (design 21 M2a / C5 mitigation): the transient-error
 * classification and the bounded win32 retry schedule are policy-pure and are
 * exercised here on every platform via the injected platform/fn/sleep seams.
 *
 * Run directly: node packages/dsh-runtime/test/rename-retry.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isTransientWindowsRenameError, renameWithWindowsRetry, WINDOWS_RENAME_RETRY_DELAYS_MS } from '../src/rename-retry.ts'

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

test('win32: a transient failure retries on the bounded schedule then succeeds', async () => {
  const sleeps: number[] = []
  let calls = 0
  const renameFn = async () => {
    calls++
    if (calls < 3) throw errWithCode('EPERM')
  }
  await renameWithWindowsRetry('a', 'b', {
    isWindows: true,
    renameFn: renameFn as never,
    sleep: async (ms) => { sleeps.push(ms) },
  })
  assert.equal(calls, 3)
  assert.deepEqual(sleeps, [WINDOWS_RENAME_RETRY_DELAYS_MS[0], WINDOWS_RENAME_RETRY_DELAYS_MS[1]])
})

test('win32: exhaustion rethrows the final transient error (bounded, no infinite wait)', async () => {
  const sleeps: number[] = []
  const renameFn = async () => { throw errWithCode('EBUSY') }
  await assert.rejects(
    renameWithWindowsRetry('a', 'b', {
      isWindows: true,
      renameFn: renameFn as never,
      sleep: async (ms) => { sleeps.push(ms) },
    }),
    (error: unknown) => (error as NodeJS.ErrnoException).code === 'EBUSY',
  )
  assert.equal(sleeps.length, WINDOWS_RENAME_RETRY_DELAYS_MS.length)
  assert.deepEqual(sleeps, [...WINDOWS_RENAME_RETRY_DELAYS_MS])
})

test('win32: a permanent error fails immediately without retrying', async () => {
  const sleeps: number[] = []
  const renameFn = async () => { throw errWithCode('ENOENT') }
  await assert.rejects(
    renameWithWindowsRetry('a', 'b', {
      isWindows: true,
      renameFn: renameFn as never,
      sleep: async (ms) => { sleeps.push(ms) },
    }),
    (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT',
  )
  assert.deepEqual(sleeps, [])
})
