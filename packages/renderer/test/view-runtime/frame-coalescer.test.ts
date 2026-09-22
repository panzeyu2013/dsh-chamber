/**
 * Frame coalescer contract.
 *
 * The per-frame "sample after a mutation" shape risks the JSC code-block
 * replacement trap in the WebContent process (rAF callback → OSR). The coalescer
 * must keep the caller's semantics — the LAST
 * state is always observed, the first change lands on the next frame — while
 * collapsing a mutation storm into a bounded sample rate. Schedulers are
 * injected, so the contract runs in plain node with no DOM.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createFrameCoalescer } from '../../src/frame-coalescer.ts'

interface Harness {
  readonly frames: Array<() => void>
  readonly delays: Array<{ run: () => void; ms: number }>
  samples: number
  now: () => number
  advance: (ms: number) => void
  fireFrame: () => void
  fireDelay: (index?: number) => void
}

function harness(minIntervalMs: number): { coalescer: ReturnType<typeof createFrameCoalescer> } & Harness {
  let clock = 0
  let samples = 0
  const frames: Array<() => void> = []
  const delays: Array<{ run: () => void; ms: number }> = []
  const coalescer = createFrameCoalescer({
    minIntervalMs,
    sample: (): void => {
      samples += 1
    },
    now: (): number => clock,
    scheduleFrame: (run) => frames.push(run),
    scheduleDelay: (run, ms) => delays.push({ run, ms }),
  })
  return {
    coalescer,
    frames,
    delays,
    get samples(): number {
      return samples
    },
    now: (): number => clock,
    advance: (ms: number): void => {
      clock += ms
    },
    fireFrame: (): void => {
      const run = frames.shift()
      assert.ok(run !== undefined, 'no frame scheduled')
      run()
    },
    fireDelay: (index = 0): void => {
      const entry = delays.splice(index, 1)[0]
      assert.ok(entry !== undefined, 'no delayed run scheduled')
      entry.run()
    },
  }
}

test('the first request samples on the next frame', () => {
  const h = harness(100)
  h.coalescer.request()
  assert.equal(h.frames.length, 1)
  assert.equal(h.delays.length, 0)
  h.fireFrame()
  assert.equal(h.samples, 1)
})

test('a mutation storm collapses into one trailing sample', () => {
  const h = harness(100)
  h.coalescer.request()
  h.fireFrame()
  assert.equal(h.samples, 1)

  // 40 mutations inside the interval: one delayed run, no per-frame work.
  h.advance(10)
  for (let i = 0; i < 40; i += 1) h.coalescer.request()
  assert.equal(h.frames.length, 0)
  assert.equal(h.delays.length, 1)
  assert.equal(h.delays[0]?.ms, 90)
  h.fireDelay()
  assert.equal(h.samples, 2)
})

test('the trailing sample is not lost when more changes land while it waits', () => {
  const h = harness(100)
  h.coalescer.request()
  h.fireFrame()
  h.advance(30)
  h.coalescer.request()
  // More activity arrives before the trailing run fires — it must not schedule
  // a second one (the pending run already covers the latest state).
  h.advance(10)
  h.coalescer.request()
  assert.equal(h.delays.length, 1)
  h.fireDelay()
  assert.equal(h.samples, 2)
})

test('an idle gap returns to the frame schedule', () => {
  const h = harness(100)
  h.coalescer.request()
  h.fireFrame()
  h.advance(500)
  h.coalescer.request()
  assert.equal(h.frames.length, 1)
  assert.equal(h.delays.length, 0)
})

test('cancel drops a pending sample and stops until the next request', () => {
  const h = harness(100)
  h.coalescer.request()
  h.coalescer.cancel()
  h.fireFrame()
  assert.equal(h.samples, 0)
  h.coalescer.request()
  h.fireFrame()
  assert.equal(h.samples, 1)
})

test('minIntervalMs 0 keeps the one-sample-per-frame shape', () => {
  const h = harness(0)
  h.coalescer.request()
  h.fireFrame()
  h.coalescer.request()
  assert.equal(h.frames.length, 1)
  assert.equal(h.delays.length, 0)
})
