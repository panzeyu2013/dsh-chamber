/**
 * Behavior tests for the runtime write fence (the module the split extracted):
 * activation/quarantine edges, the sticky dispose latch, the writer
 * single-flight matrix, the managed profile-write lease and the tracked
 * operation epoch. These drive the fence directly — no manager, no routes.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRuntimeWriteFence } from '../../src/runtime/write-fence.ts'
import type { Logger } from '@dsh-chamber/control-plane'

interface Harness {
  fence: ReturnType<typeof createRuntimeWriteFence>
  edges: boolean[]
  warnings: string[]
}

function harness(overrides: {
  getStartupBlockReason?: () => string | null
  onQuarantineChange?: (active: boolean) => void
} = {}): Harness {
  const edges: boolean[] = []
  const warnings: string[] = []
  const logger: Logger = {
    log() {},
    warn: (message: string) => { warnings.push(message) },
    error() {},
  }
  const fence = createRuntimeWriteFence({
    logger,
    getStartupBlockReason: overrides.getStartupBlockReason ?? (() => null),
    onQuarantineChange: overrides.onQuarantineChange ?? ((active) => { edges.push(active) }),
  })
  return { fence, edges, warnings }
}

test('activation window publishes one quarantine edge per open/close, nesting included', () => {
  const { fence, edges } = harness()
  assert.equal(fence.activationInProgress(), false)
  fence.beginActivation()
  fence.beginActivation()
  assert.deepEqual(edges, [true], 'nested begin must not republish the quarantine edge')
  assert.equal(fence.activationInProgress(), true)
  fence.endActivation()
  assert.deepEqual(edges, [true], 'the window stays open while depth > 0')
  fence.endActivation()
  assert.deepEqual(edges, [true, false])
  assert.equal(fence.activationInProgress(), false)
  assert.throws(() => fence.endActivation(), /gateway runtime activation gate underflow/)
})

test('dispose is a sticky quarantine and suppresses the closing edge', () => {
  const { fence, edges } = harness()
  fence.beginActivation()
  fence.markDisposed()
  fence.endActivation()
  assert.deepEqual(edges, [true], 'a disposed manager must never publish a false open edge')
  assert.equal(fence.activationInProgress(), true, 'activationInProgress is sticky after dispose')
  assert.equal(fence.mutationInProgress(), true)
  assert.throws(() => fence.assertManagerReadable(), (error: unknown) => {
    return (error as { code?: string }).code === 'runtime_disposed'
  })
})

test('exposureQuarantined reads the live startup block and spares snapshot-failed only', () => {
  let block: string | null = 'swap-attempted'
  const { fence } = harness({ getStartupBlockReason: () => block })
  assert.equal(fence.exposureQuarantined(), true)
  block = 'snapshot-failed'
  assert.equal(fence.exposureQuarantined(), false, 'snapshot-failed happens before the pointer moves')
  block = null
  assert.equal(fence.exposureQuarantined(), false)
  fence.beginActivation()
  block = 'snapshot-failed'
  assert.equal(fence.exposureQuarantined(), true, 'the window itself always quarantines')
  fence.endActivation()
})

test('mutationInProgress covers the start primitive; metadataWriterBusy keeps the historical matrix', () => {
  const { fence } = harness()
  assert.equal(fence.mutationInProgress(), false)
  fence.setStartInFlight(true)
  assert.equal(fence.mutationInProgress(), true)
  assert.equal(fence.metadataWriterBusy(), false, 'the metadata projection predates start')
  fence.setStartInFlight(false)
  for (const set of [
    (v: boolean) => { fence.setInstallInFlight(v) },
    (v: boolean) => { fence.setRestartInFlight(v) },
    (v: boolean) => { fence.setApplyNowInFlight(v) },
    (v: boolean) => { fence.setRestartExhaustedRollbackInFlight(v) },
  ]) {
    set(true)
    assert.equal(fence.mutationInProgress(), true)
    assert.equal(fence.metadataWriterBusy(), true)
    set(false)
  }
  assert.equal(fence.mutationInProgress(), false)
})

test('profile-write lease counts, wakes idle waiters and underflow-guards release', async () => {
  const { fence } = harness()
  assert.equal(fence.profileWriteInFlight(), false)
  const lease = fence.acquireProfileWrite()
  assert.equal(fence.profileWriteInFlight(), true)
  const pending = fence.waitForProfileWriteIdle(5_000)
  lease.release()
  assert.equal(await pending, 'idle', 'release at zero resolves the waiter')
  assert.equal(fence.profileWriteInFlight(), false)
  assert.throws(() => lease.release(), /gateway runtime profile write lease underflow/)
})

test('profile-write idle wait times out on the bound and on the lifecycle abort', async () => {
  const timed = harness()
  const held = timed.fence.acquireProfileWrite()
  assert.equal(await timed.fence.waitForProfileWriteIdle(10), 'timeout')
  held.release()

  const aborted = harness()
  const heldAbort = aborted.fence.acquireProfileWrite()
  aborted.fence.abortLifecycle()
  assert.equal(await aborted.fence.waitForProfileWriteIdle(5_000), 'timeout', 'abort must not stall shutdown')
  heldAbort.release()
})

test('quarantine callback failures are logged, never propagated into runtime safety', () => {
  const { warnings } = harness({
    onQuarantineChange: () => { throw new Error('feature resync exploded') },
  })
  assert.equal(typeof warnings.length, 'number')
})

test('tracked operations drain to a fixed point and can exclude the caller', async () => {
  const { fence } = harness()
  let settle: () => void = () => {}
  const tracked = new Promise<void>((resolve) => { settle = resolve })
  fence.trackOperation(tracked)
  let drained = false
  const drain = fence.drainOperations().then(() => { drained = true })
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(drained, false, 'drain waits for the tracked writer')
  settle()
  await drain
  assert.equal(drained, true)

  const self = new Promise<void>(() => {})
  fence.trackOperation(self)
  // Excluding the caller itself is the F7 rollback contract: it must not
  // self-wait, otherwise the rollback deadlocks behind its own promise.
  await Promise.race([
    fence.drainOtherOperations(self),
    new Promise((_, reject) => setTimeout(() => reject(new Error('drainOtherOperations self-waited')), 100)),
  ])
})
