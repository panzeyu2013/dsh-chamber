/**
 * The retry lane's wait for a connection generation is BOUNDED (chamber fork,
 * 2026-09 renderer-crash round).
 *
 * Upstream waited on the generation source with no timer: with the lane parked
 * (offline suspension, or a lane that stopped restarting) every new logical
 * stream parked forever — no error edge, no reopen attempt, nothing visible but
 * the loading hint. This suite drives the REAL `RemoteStream` with a parked
 * connection and asserts the bound actually reopens the stream and publishes the
 * condition through the carrier-failed seam.
 */
import assert from 'node:assert/strict'
import { test, mock } from 'node:test'
import { RemoteStream } from '../../src/client/remote-stream.ts'
import { RemoteStreamCarrierError } from '../../src/client/stream-client.ts'
import { REMOTE_STREAM_NO_GENERATION_WAIT_MAX_MS } from '../../src/client/remote-retry-policy.ts'

/** Drain queued microtasks (mock timers leave setImmediate real). */
function flush(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

function parkedConnection(): { generation: { getSnapshot: () => undefined; subscribe: (fn: () => void) => () => void } } {
  return {
    generation: {
      getSnapshot: () => undefined,
      subscribe: () => () => {},
    },
  }
}

test('a parked lane no longer waits forever: the bound reopens the stream', async (t) => {
  mock.timers.enable({ apis: ['setTimeout'] })
  t.after(() => mock.timers.reset())
  let opens = 0
  const failures: string[] = []
  const stream = new RemoteStream(parkedConnection(), {
    name: 'session/follow',
    open: async function* () {
      opens += 1
      throw new RemoteStreamCarrierError('carrier down')
    },
    ended: () => new Error('ended'),
    carrierFailed: (error) => {
      failures.push(error.message)
    },
  })
  const iterator = stream[Symbol.asyncIterator]()
  const first = iterator.next()
  first.catch(() => {})
  await flush()
  assert.equal(opens, 1, 'the first attempt ran and failed')

  // Still parked: upstream waited here forever. The bound must fire.
  await flush()
  assert.equal(opens, 1, 'no reopen before the bound')
  mock.timers.tick(REMOTE_STREAM_NO_GENERATION_WAIT_MAX_MS - 1)
  await flush()
  assert.equal(opens, 1, 'no reopen one tick before the bound')

  mock.timers.tick(1)
  await flush()
  assert.equal(opens, 2, 'the bound reopens the stream instead of waiting forever')
  assert.ok(
    failures.some(message => message.includes('without a connection generation')),
    'the expired wait is published on the carrier-failed seam',
  )

  await stream.dispose()
  await flush()
})

test('a live generation paces the wait with the episode backoff (bound not reached)', async (t) => {
  mock.timers.enable({ apis: ['setTimeout'] })
  t.after(() => mock.timers.reset())
  let opens = 0
  const stream = new RemoteStream({ generation: { getSnapshot: () => ({ id: 1 }), subscribe: () => () => {} } } as never, {
    name: 'session/follow',
    open: async function* () {
      opens += 1
      throw new RemoteStreamCarrierError('carrier down')
    },
    ended: () => new Error('ended'),
  })
  const iterator = stream[Symbol.asyncIterator]()
  iterator.next().catch(() => {})
  // No timers are involved before the first paced retry: the episode's first
  // failure reopens immediately (unchanged upstream shape), so one microtask
  // drain already reaches the second attempt.
  await flush()
  assert.equal(opens, 2, 'the first failure reopens immediately')
  // The second failure is paced by the base backoff (250ms) — the live-generation
  // branch, so the no-generation bound plays no part here.
  mock.timers.tick(249)
  await flush()
  assert.equal(opens, 2, 'no reopen before the backoff elapses')
  mock.timers.tick(1)
  await flush()
  assert.equal(opens, 3)
  await stream.dispose()
  await flush()
})
