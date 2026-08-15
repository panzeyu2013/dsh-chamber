/**
 * busy-enter-policy.ts unit tests (plain node:test, no dsh, no DOM): initial
 * default, adoption from the scope (on subscribe and on later publishes),
 * set-publishes-before-durable-write, same-value no-op, absent-scope
 * process-local fallback.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BusyEnterPolicy,
  DEFAULT_BUSY_ENTER_BEHAVIOR,
  BUSY_ENTER_FIELD,
  type BusyEnterScope,
} from '../src/client/bridge-rows/enter-row-controller.ts'

/** Controllable fake scope over a mutable section. */
class FakeScope implements BusyEnterScope {
  private readonly listeners = new Set<() => void>()
  private section: { busyEnter?: 'queue' | 'steer' } | undefined

  constructor(initial?: { busyEnter?: 'queue' | 'steer' }) {
    this.section = initial
  }

  getSnapshot(): { status: string; value: unknown } {
    return { status: 'ready', value: this.section }
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  async set(field: string, value: unknown): Promise<void> {
    assert.equal(field, BUSY_ENTER_FIELD)
    this.section = { busyEnter: value as 'queue' | 'steer' }
  }

  /** Push a host-side change (simulating an invalidation-driven read). */
  publish(section: { busyEnter?: 'queue' | 'steer' } | undefined): void {
    this.section = section
    for (const fn of this.listeners) fn()
  }
}

test('default is queue without a scope', () => {
  const policy = new BusyEnterPolicy()
  assert.equal(policy.busyEnter.getSnapshot(), 'queue')
})

test('adopts the durable value at construction', () => {
  const policy = new BusyEnterPolicy(new FakeScope({ busyEnter: 'steer' }))
  assert.equal(policy.busyEnter.getSnapshot(), 'steer')
})

test('keeps the default while the section is absent', () => {
  const policy = new BusyEnterPolicy(new FakeScope())
  assert.equal(policy.busyEnter.getSnapshot(), DEFAULT_BUSY_ENTER_BEHAVIOR)
})

test('adopts host-side publishes through the scope subscription', () => {
  const scope = new FakeScope()
  const policy = new BusyEnterPolicy(scope)
  assert.equal(policy.busyEnter.getSnapshot(), 'queue')
  scope.publish({ busyEnter: 'steer' })
  assert.equal(policy.busyEnter.getSnapshot(), 'steer')
})

test('set publishes the live value before the durable write', async () => {
  const scope = new FakeScope()
  const policy = new BusyEnterPolicy(scope)
  let visible = false
  let durable = false
  policy.busyEnter.subscribe(() => {
    visible = policy.busyEnter.getSnapshot() === 'steer'
  })
  const originalSet = scope.set.bind(scope)
  scope.set = async (field, value) => {
    durable = visible
    await originalSet(field, value)
  }
  policy.setBusyEnter('steer')
  assert.equal(visible, true)
  assert.equal(durable, true, 'the store publish must precede the durable write')
  assert.deepEqual(scope.getSnapshot().value, { busyEnter: 'steer' })
})

test('set with the current behavior is a no-op (no store change, no write)', async () => {
  const scope = new FakeScope()
  const policy = new BusyEnterPolicy(scope)
  let writes = 0
  scope.set = async () => { writes += 1 }
  let notifications = 0
  policy.busyEnter.subscribe(() => { notifications += 1 })
  policy.setBusyEnter('queue')
  await Promise.resolve()
  assert.equal(notifications, 0)
  assert.equal(writes, 0)
})

test('a publish of the same value does not publish the store', () => {
  const scope = new FakeScope({ busyEnter: 'steer' })
  const policy = new BusyEnterPolicy(scope)
  let notifications = 0
  policy.busyEnter.subscribe(() => { notifications += 1 })
  scope.publish({ busyEnter: 'steer' })
  assert.equal(notifications, 0)
})

test('set without a host still publishes the live value and never writes', async () => {
  const policy = new BusyEnterPolicy()
  let notifications = 0
  policy.busyEnter.subscribe(() => { notifications += 1 })
  policy.setBusyEnter('steer')
  await Promise.resolve()
  assert.equal(policy.busyEnter.getSnapshot(), 'steer')
  assert.equal(notifications, 1)
})
