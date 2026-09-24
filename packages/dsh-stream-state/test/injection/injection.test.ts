/**
 * Cross-shell injection harness contract: deterministic arming, bounded counts,
 * the one global read view, and the two carrier starvations the wrapper models.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createInjectionHarness,
  installInjectionHarness,
  readInjectionHarness,
  wrapOpenWithInjection,
} from '../../src/injection.ts'

test('the scenario vocabulary is the frozen acceptance set', () => {
  const harness = createInjectionHarness()
  for (const scenario of ['frame-stop', 'append-silent', 'break-streams'] as const) {
    harness.arm({ scenario, everyMs: 0, count: 1 })
    assert.deepEqual(harness.armed(), [scenario])
    assert.equal(harness.consume(scenario, 0), true)
    assert.deepEqual(harness.armed(), [])
  }
})

test('an armed scenario fires on its schedule, bounded by count', () => {
  const harness = createInjectionHarness()
  assert.deepEqual(harness.armed(), [])
  harness.arm({ scenario: 'break-streams', everyMs: 1_000, count: 2 })
  assert.deepEqual(harness.armed(), ['break-streams'])
  assert.deepEqual(harness.poll(0).map(action => action.scenario), ['break-streams'])
  assert.deepEqual(harness.poll(500), [], 'inside the period nothing fires')
  assert.deepEqual(harness.poll(1_000).map(action => action.seq), [2])
  assert.deepEqual(harness.armed(), [], 'the bounded count retired the plan')
  assert.deepEqual(harness.poll(2_000), [])
})

test('an unbounded plan keeps firing and clear() disarms everything', () => {
  const harness = createInjectionHarness()
  harness.arm({ scenario: 'frame-stop', everyMs: 0 })
  assert.equal(harness.poll(0).length, 1)
  assert.equal(harness.poll(0).length, 1)
  assert.deepEqual(harness.armed(), ['frame-stop'])
  harness.clear()
  assert.deepEqual(harness.armed(), [])
  assert.deepEqual(harness.poll(0), [])
})

test('one-shot consumption reads one scenario without disturbing the others', () => {
  const harness = createInjectionHarness()
  harness.arm({ scenario: 'append-silent', everyMs: 0, count: 1 })
  harness.arm({ scenario: 'break-streams', everyMs: 0, count: 1 })
  assert.equal(harness.consume('append-silent', 0), true)
  assert.equal(harness.consume('append-silent', 1), false, 'the fault was consumed')
  assert.deepEqual(harness.armed(), ['break-streams'], 'an unrelated scenario is still armed')
  assert.equal(harness.consume('break-streams', 1), true)
})

test('the global read view is what a page script and the driver share', () => {
  const target: Record<string, unknown> = {}
  assert.equal(readInjectionHarness(target), undefined)
  const harness = createInjectionHarness()
  installInjectionHarness(target, harness)
  const read = readInjectionHarness(target)
  assert.ok(read !== undefined)
  read.arm({ scenario: 'frame-stop', everyMs: 0 })
  assert.deepEqual(read.armed(), ['frame-stop'])
  assert.deepEqual(harness.armed(), ['frame-stop'], 'the global is the same instance, not a copy')
  assert.equal(readInjectionHarness({ [('x' as string)]: { poll: 'nope' } }), undefined)
})

test('without an armed harness the wrapper forwards every item unchanged', async () => {
  async function* source(): AsyncGenerator<number> {
    yield 1
    yield 2
  }
  const wrapped = wrapOpenWithInjection(source, {
    name: 'test',
    harness: () => undefined,
    makeBreakError: reason => new Error(reason),
  })
  const seen: number[] = []
  for await (const item of wrapped(new AbortController().signal)) seen.push(item)
  assert.deepEqual(seen, [1, 2])
})

test('break-streams throws the consumer carrier error before the next item', async () => {
  async function* source(): AsyncGenerator<number> {
    yield 1
  }
  const harness = createInjectionHarness()
  harness.arm({ scenario: 'break-streams', everyMs: 0, count: 1 })
  const wrapped = wrapOpenWithInjection(source, {
    name: 'remote-events',
    harness: () => harness,
    makeBreakError: reason => new Error(reason),
  })
  await assert.rejects(async () => {
    for await (const _item of wrapped(new AbortController().signal)) { /* consume */ }
  }, /remote-events: injected carrier break/)
})

test('append-silent starves the consumer until the generation aborts', async () => {
  async function* source(): AsyncGenerator<number> {
    yield 1
    await new Promise<void>(() => {})
  }
  const harness = createInjectionHarness()
  harness.arm({ scenario: 'append-silent', everyMs: 0, count: 1 })
  const wrapped = wrapOpenWithInjection(source, {
    name: 'journal',
    harness: () => harness,
    makeBreakError: reason => new Error(reason),
  })
  const abort = new AbortController()
  const seen: number[] = []
  const consuming = (async (): Promise<void> => {
    for await (const item of wrapped(abort.signal)) seen.push(item)
  })()
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.deepEqual(seen, [], 'the appended bytes were never signaled to the consumer')
  abort.abort()
  await consuming
  assert.deepEqual(seen, [])
})
