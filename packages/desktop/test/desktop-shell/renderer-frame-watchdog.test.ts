import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  RENDERER_FRAME_MAX_STRIKES,
  RENDERER_FRAME_PROBE_INTERVAL_MS,
  RENDERER_FRAME_PROBE_TIMEOUT_MS,
  RENDERER_FRAME_PROGRESS_SCRIPT,
  RENDERER_INPUT_BLOCK_RTT_MS,
  RendererFrameWatchdog,
} from '../../renderer-frame-watchdog.ts'

/**
 * One page stub for the shipped probe script: the script reads window/document/
 * requestAnimationFrame/setTimeout as globals, so the test owns exactly those and
 * restores them.
 */
function probeScriptPage(armed: (() => readonly string[]) | undefined) {
  const scheduled: Array<() => void> = []
  const timers: Array<() => void> = []
  const previous = {
    window: Reflect.get(globalThis, 'window'),
    document: Reflect.get(globalThis, 'document'),
    raf: Reflect.get(globalThis, 'requestAnimationFrame'),
    setTimeout: globalThis.setTimeout,
  }
  const pageWindow: Record<string, unknown> = {}
  if (armed !== undefined) pageWindow.__dshChamberInjection = { armed }
  Reflect.set(globalThis, 'window', pageWindow)
  Reflect.set(globalThis, 'document', { visibilityState: 'visible' })
  Reflect.set(globalThis, 'requestAnimationFrame', (cb: () => void): number => {
    scheduled.push(cb)
    return scheduled.length
  })
  globalThis.setTimeout = ((cb: () => void) => {
    timers.push(cb)
    return timers.length
  }) as typeof setTimeout
  return {
    probe: (): number => eval(RENDERER_FRAME_PROGRESS_SCRIPT) as number,
    runFrame: (): void => { scheduled.shift()?.() },
    pendingRearms: (): number => scheduled.length + timers.length,
    restore: (): void => {
      Reflect.set(globalThis, 'window', previous.window)
      Reflect.set(globalThis, 'document', previous.document)
      Reflect.set(globalThis, 'requestAnimationFrame', previous.raf)
      globalThis.setTimeout = previous.setTimeout
    },
  }
}

test('the shipped probe script counts frames and rearms the loop', () => {
  const page = probeScriptPage(undefined)
  try {
    assert.equal(page.probe(), 0, 'the probe initializes the counter and returns it')
    page.runFrame()
    assert.equal(page.probe(), 1)
    assert.equal(page.pendingRearms(), 1, 'the loop re-armed through the bounded timeout')
  } finally {
    page.restore()
  }
})

test("an armed frame-stop fault freezes the shipped probe script's counter", () => {
  const page = probeScriptPage(() => ['frame-stop'])
  try {
    assert.equal(page.probe(), 0)
    page.runFrame()
    assert.equal(page.probe(), 0, 'the loop stopped instead of counting frames')
    assert.equal(page.pendingRearms(), 0, 'no re-arm: a stopped loop stays stopped')
  } finally {
    page.restore()
  }
})

test('the probe cadence, strike limit and input-block budget are the shipped bounds', () => {
  assert.equal(RENDERER_FRAME_PROBE_INTERVAL_MS, 5_000)
  assert.equal(RENDERER_FRAME_PROBE_TIMEOUT_MS, 3_000)
  assert.equal(RENDERER_FRAME_MAX_STRIKES, 3)
  assert.equal(RENDERER_INPUT_BLOCK_RTT_MS, 1_000)
})

test('a slow main-process round trip is input-block evidence, not a frame strike', () => {
  const watchdog = new RendererFrameWatchdog()
  const probe = watchdog.tick(0)
  const id = probe.kind === 'probe' ? probe.id : 0
  assert.deepEqual(watchdog.succeeded(id, 10, RENDERER_INPUT_BLOCK_RTT_MS + 1),
    { kind: 'input-block', rttMs: RENDERER_INPUT_BLOCK_RTT_MS + 1 })
  // The frame count still counts as progress: the next static sample is the
  // first frame strike, not the second.
  const next = watchdog.tick(RENDERER_FRAME_PROBE_INTERVAL_MS)
  assert.deepEqual(watchdog.succeeded(next.kind === 'probe' ? next.id : 0, 10), { kind: 'none' })
})

test('three consecutive over-budget round trips reload at the same strike bound', () => {
  const watchdog = new RendererFrameWatchdog()
  let at = 0
  let frames = 0
  const outcomes: string[] = []
  for (let index = 0; index < RENDERER_FRAME_MAX_STRIKES; index += 1) {
    const probe = watchdog.tick(at)
    frames += 1
    outcomes.push(watchdog.succeeded(probe.kind === 'probe' ? probe.id : 0, frames, RENDERER_INPUT_BLOCK_RTT_MS + 5).kind)
    at += RENDERER_FRAME_PROBE_INTERVAL_MS
  }
  assert.deepEqual(outcomes, ['input-block', 'input-block', 'reload'])
})

test('one healthy round trip clears the input-block streak', () => {
  const watchdog = new RendererFrameWatchdog()
  let at = 0
  let frames = 0
  for (let index = 0; index < RENDERER_FRAME_MAX_STRIKES - 1; index += 1) {
    const probe = watchdog.tick(at)
    frames += 1
    assert.equal(watchdog.succeeded(probe.kind === 'probe' ? probe.id : 0, frames, RENDERER_INPUT_BLOCK_RTT_MS + 5).kind, 'input-block')
    at += RENDERER_FRAME_PROBE_INTERVAL_MS
  }
  const healthy = watchdog.tick(at)
  frames += 1
  assert.deepEqual(watchdog.succeeded(healthy.kind === 'probe' ? healthy.id : 0, frames, 1), { kind: 'none' })
  at += RENDERER_FRAME_PROBE_INTERVAL_MS
  const slow = watchdog.tick(at)
  frames += 1
  assert.equal(watchdog.succeeded(slow.kind === 'probe' ? slow.id : 0, frames, RENDERER_INPUT_BLOCK_RTT_MS + 5).kind,
    'input-block', 'the window restarts after a healthy sample')
})

test('a responsive page never reloads, however many probes it answers', () => {
  const watchdog = new RendererFrameWatchdog()
  let frames = 0
  let at = 0
  for (let index = 0; index < 10; index += 1) {
    const action = watchdog.tick(at)
    assert.equal(action.kind, 'probe')
    frames += 3
    assert.deepEqual(watchdog.succeeded(action.kind === 'probe' ? action.id : 0, frames), { kind: 'none' })
    at += RENDERER_FRAME_PROBE_INTERVAL_MS
  }
})

test('a page whose frame counter stops advancing reloads after the configured strikes', () => {
  const watchdog = new RendererFrameWatchdog()
  const first = watchdog.tick(0)
  assert.equal(first.kind, 'probe')
  assert.deepEqual(watchdog.succeeded(first.kind === 'probe' ? first.id : 0, 10), { kind: 'none' })
  let at = RENDERER_FRAME_PROBE_INTERVAL_MS
  for (let strike = 1; strike <= RENDERER_FRAME_MAX_STRIKES; strike += 1) {
    const probe = watchdog.tick(at)
    assert.equal(probe.kind, 'probe')
    const outcome = watchdog.succeeded(probe.kind === 'probe' ? probe.id : 0, 10)
    if (strike < RENDERER_FRAME_MAX_STRIKES) assert.deepEqual(outcome, { kind: 'none' })
    else assert.deepEqual(outcome, { kind: 'reload' })
    at += RENDERER_FRAME_PROBE_INTERVAL_MS
  }
})

test('an unanswered probe is a strike at its timeout, and a late id is inert', () => {
  const watchdog = new RendererFrameWatchdog()
  const probe = watchdog.tick(0)
  assert.equal(probe.kind, 'probe')
  const id = probe.kind === 'probe' ? probe.id : 0
  assert.deepEqual(watchdog.tick(RENDERER_FRAME_PROBE_TIMEOUT_MS - 1), { kind: 'none' })
  const failed = watchdog.tick(RENDERER_FRAME_PROBE_TIMEOUT_MS)
  assert.equal(failed.kind, 'none', 'one strike is not yet a reload')
  watchdog.reset()
  assert.deepEqual(watchdog.failed(id), { kind: 'none' }, 'a late failure from a previous navigation is inert')
  const next = watchdog.tick(RENDERER_FRAME_PROBE_INTERVAL_MS)
  assert.deepEqual(next, { kind: 'probe', id: 2 })
})

test('a document that declares itself hidden suspends judgment', () => {
  const watchdog = new RendererFrameWatchdog()
  const probe = watchdog.tick(0)
  assert.equal(probe.kind, 'probe')
  watchdog.suspended(probe.kind === 'probe' ? probe.id : 0)
  const after = watchdog.tick(1)
  assert.deepEqual(after, { kind: 'probe', id: 2 }, 'a suspended probe resets the window without a strike')
})

test('a recovering page clears the strikes accumulated before it', () => {
  const watchdog = new RendererFrameWatchdog()
  let at = 0
  const plan = []
  for (let index = 0; index < RENDERER_FRAME_MAX_STRIKES - 1; index += 1) {
    const probe = watchdog.tick(at)
    plan.push(probe)
    watchdog.succeeded(probe.kind === 'probe' ? probe.id : 0, 5)
    at += RENDERER_FRAME_PROBE_INTERVAL_MS
  }
  const recovered = watchdog.tick(at)
  assert.equal(recovered.kind, 'probe')
  assert.deepEqual(watchdog.succeeded(recovered.kind === 'probe' ? recovered.id : 0, 6), { kind: 'none' })
  const after = watchdog.tick(at + RENDERER_FRAME_PROBE_INTERVAL_MS)
  assert.equal(after.kind, 'probe')
  assert.deepEqual(watchdog.succeeded(after.kind === 'probe' ? after.id : 0, 6), { kind: 'none' },
    'the recovery cleared the strikes, so the same static count starts again')
})
