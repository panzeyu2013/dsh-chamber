import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PendingOpenQueue } from './pending-open-queue.ts'

test('a queued open stays pending until dispatch succeeds', async () => {
  const queue = new PendingOpenQueue(1000)
  let settled = false
  const opened = queue.enqueue('local', 's1').finally(() => { settled = true })
  await Promise.resolve()
  assert.equal(settled, false)
  assert.equal(queue.flush('local', async sessionId => assert.equal(sessionId, 's1')), 1)
  await opened
  assert.equal(settled, true)
})

test('dispatch, explicit teardown and timeout failures reject the original promise', async () => {
  const queue = new PendingOpenQueue(10)
  const dispatchFailure = queue.enqueue('a', 's1')
  queue.flush('a', async () => { throw new Error('runtime rejected') })
  await assert.rejects(dispatchFailure, /runtime rejected/)

  const disposed = queue.enqueue('b', 's2')
  assert.equal(queue.reject('b', new Error('shell disposed')), 1)
  await assert.rejects(disposed, /shell disposed/)

  await assert.rejects(queue.enqueue('c', 's3'), /启动超时/)
})

test('a synchronously-throwing dispatch rejects the original promise (never stranded)', async () => {
  const queue = new PendingOpenQueue(1000)
  const opened = queue.enqueue('d', 's4')
  assert.equal(queue.flush('d', () => { throw new Error('sync dispatch failure') }), 1)
  await assert.rejects(opened, /sync dispatch failure/)
})

test('a hostile synchronous thrown value still rejects instead of stranding the promise', async () => {
  const queue = new PendingOpenQueue(1000)
  const opened = queue.enqueue('hostile', 's-hostile')
  const hostile = new Proxy({}, {
    getPrototypeOf() {
      throw new Error('prototype coercion exploded')
    },
    get(_target, key) {
      if (key === Symbol.toPrimitive || key === 'toString') {
        throw new Error('string coercion exploded')
      }
      return undefined
    },
  })

  assert.doesNotThrow(() => queue.flush('hostile', () => { throw hostile }))
  await assert.rejects(opened, /unknown error/)
})

test('flush carries the enqueue-time absolute deadline instead of resetting the total wait budget', async () => {
  const originalNow = Date.now
  let now = 10_000
  Date.now = () => now
  const queue = new PendingOpenQueue(68_000)
  try {
    const opened = queue.enqueue('e', 's5')
    now = 77_500
    let dispatchedDeadline: number | undefined
    assert.equal(queue.flush('e', async (sessionId, deadline) => {
      assert.equal(sessionId, 's5')
      dispatchedDeadline = deadline
    }), 1)
    await opened
    assert.equal(dispatchedDeadline, 78_000)
  } finally {
    Date.now = originalNow
  }
})
