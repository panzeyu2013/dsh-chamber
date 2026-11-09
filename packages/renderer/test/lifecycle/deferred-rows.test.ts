/**
 * Deferred-row deadline: every chunk row is bounded, so a hung chunk is a per-row
 * failure report instead of a silently unmounted cluster (design 09 §3.5).
 *
 * Run directly: node test/lifecycle/deferred-rows.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFERRED_ROW_DEADLINE_MS, DeferredRowTimeoutError, withDeferredRowDeadline } from '../../src/deferred-rows.ts'

test('a chunk that arrives before the deadline settles with its value', async () => {
  assert.equal(await withDeferredRowDeadline('fast', Promise.resolve(42), 50), 42)
  assert.equal(DEFERRED_ROW_DEADLINE_MS, 30_000)
})

test('a chunk rejection keeps its own error (the failed id set is the report)', async () => {
  const boom = new Error('boom')
  await assert.rejects(() => withDeferredRowDeadline('row', Promise.reject(boom), 50), (error) => error === boom)
})

test('a chunk that never settles rejects at the deadline, naming the row', async () => {
  const never = new Promise<never>(() => {})
  await assert.rejects(
    () => withDeferredRowDeadline('@deepseek-ai/dsh-client-ui-tool', never, 20),
    (error: unknown) => {
      assert.ok(error instanceof DeferredRowTimeoutError)
      assert.equal(error.id, '@deepseek-ai/dsh-client-ui-tool')
      assert.equal(error.deadlineMs, 20)
      assert.match(error.message, /did not settle within 20ms/)
      return true
    },
  )
})

test('the deadline bounds the cluster wait: one hung row cannot hang the others', async () => {
  const settled = await Promise.all([
    withDeferredRowDeadline('fast', Promise.resolve('ok'), 20),
    withDeferredRowDeadline('hung', new Promise<never>(() => {}), 20).then(() => 'unexpected', () => 'timed-out'),
  ])
  assert.deepEqual(settled, ['ok', 'timed-out'])
})
