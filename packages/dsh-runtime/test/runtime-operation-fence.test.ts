import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RuntimeOperationFence } from '../src/runtime-operation-fence.ts'

test('runtime waits for an existing plugin writer and queued runtime blocks new plugin writers', async () => {
  const fence = new RuntimeOperationFence()
  const plugin = fence.tryAcquire('plugin:add')
  assert.notEqual(plugin, null)
  const runtimePromise = fence.acquire('runtime:apply')
  assert.equal(fence.tryAcquire('plugin:remove'), null)
  plugin!.release()
  const runtime = await runtimePromise
  assert.equal(runtime.owner, 'runtime:apply')
  assert.equal(fence.tryAcquire('plugin:add'), null)
  runtime.release()
  assert.equal(fence.busy, false)
})

test('aborted waiter is removed and leases are idempotent', async () => {
  const fence = new RuntimeOperationFence()
  const first = fence.tryAcquire('first')!
  const controller = new AbortController()
  const waiting = fence.acquire('second', controller.signal)
  controller.abort()
  await assert.rejects(waiting, /aborted/)
  first.release()
  first.release()
  assert.equal(fence.busy, false)
  fence.tryAcquire('third')!.release()
})
