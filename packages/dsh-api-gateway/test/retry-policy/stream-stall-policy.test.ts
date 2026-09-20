/**
 * Silence-watchdog truth table (chamber fork patch, design 14 §D4, 2026-09).
 *
 * The contract this pins: the watchdog only ever says `'probe'` — a read-only
 * sibling follow — and never a blind restart, because legal silence (TTFT,
 * multi-minute tool calls) must not churn the subscription. The restart only
 * happens after the probe proves an advanced Host cursor.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  decideStreamStallAction,
  DEFAULT_STREAM_STALL_TIMING,
  MAX_STREAM_STALL_PROBE_INTERVAL_MS,
  streamStallProbeIntervalMs,
  type StreamStallClock,
} from '../../src/client/stream-stall-policy.ts'

const timing = DEFAULT_STREAM_STALL_TIMING

function clock(overrides: Partial<StreamStallClock> = {}): StreamStallClock {
  return {
    now: 1_000_000,
    lastProgressAt: 1_000_000,
    probing: false,
    quietProbes: 0,
    ...overrides,
  }
}

test('silence below the probe window never acts', () => {
  assert.equal(decideStreamStallAction(clock({ lastProgressAt: 1_000_000 - (timing.probeAfterMs - 1) }), timing), 'wait')
})

test('a quiet stream probes once the window passes', () => {
  assert.equal(decideStreamStallAction(clock({ lastProgressAt: 1_000_000 - timing.probeAfterMs }), timing), 'probe')
})

test('an in-flight probe is never overlapped', () => {
  assert.equal(
    decideStreamStallAction(clock({ lastProgressAt: 1_000_000 - timing.probeAfterMs, probing: true }), timing),
    'wait',
  )
})

test('probes are spaced by the probe interval while the stream stays silent', () => {
  const base = { lastProgressAt: 1_000_000 - timing.probeAfterMs }
  assert.equal(
    decideStreamStallAction(clock({ ...base, lastProbeAt: 1_000_000 - (timing.probeIntervalMs - 1) }), timing),
    'wait',
  )
  assert.equal(
    decideStreamStallAction(clock({ ...base, lastProbeAt: 1_000_000 - timing.probeIntervalMs }), timing),
    'probe',
  )
})

test('a fresh restart keeps the watchdog quiet for its cooldown', () => {
  const base = { lastProgressAt: 1_000_000 - timing.probeAfterMs }
  assert.equal(
    decideStreamStallAction(clock({ ...base, lastRestartAt: 1_000_000 - (timing.restartCooldownMs - 1) }), timing),
    'wait',
  )
  assert.equal(
    decideStreamStallAction(clock({ ...base, lastRestartAt: 1_000_000 - timing.restartCooldownMs }), timing),
    'probe',
  )
})

test('a dormant stream backs its probe cadence off instead of probing forever', () => {
  const base = { lastProgressAt: 1_000_000 - timing.probeAfterMs }
  assert.equal(streamStallProbeIntervalMs(0, timing), timing.probeIntervalMs)
  assert.equal(streamStallProbeIntervalMs(1, timing), timing.probeIntervalMs * 2)
  assert.equal(streamStallProbeIntervalMs(9, timing), MAX_STREAM_STALL_PROBE_INTERVAL_MS)
  // One quiet probe already widens the next window from 45 s to 90 s.
  assert.equal(
    decideStreamStallAction(clock({ ...base, lastProbeAt: 1_000_000 - timing.probeIntervalMs, quietProbes: 1 }), timing),
    'wait',
  )
  assert.equal(
    decideStreamStallAction(
      clock({ ...base, lastProbeAt: 1_000_000 - timing.probeIntervalMs * 2, quietProbes: 1 }),
      timing,
    ),
    'probe',
  )
})

test('the probe cadence widening stays capped and fails safe on degenerate streaks', () => {
  let previous = 0
  for (let quiet = 0; quiet <= 40; quiet++) {
    const interval = streamStallProbeIntervalMs(quiet, timing)
    assert.ok(interval >= timing.probeIntervalMs, 'quiet ' + String(quiet) + ' keeps at least the base interval')
    assert.ok(interval <= MAX_STREAM_STALL_PROBE_INTERVAL_MS, 'quiet ' + String(quiet) + ' stays capped')
    assert.ok(interval >= previous, 'quiet ' + String(quiet) + ' must not shrink the interval')
    previous = interval
  }
  for (const quiet of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.equal(streamStallProbeIntervalMs(quiet, timing), timing.probeIntervalMs, String(quiet))
  }
})

test('degenerate clocks fail safe to waiting', () => {
  assert.equal(decideStreamStallAction(clock({ lastProgressAt: Number.NaN }), timing), 'wait')
  assert.equal(
    decideStreamStallAction(clock({ lastProgressAt: Number.POSITIVE_INFINITY }), timing),
    'wait',
  )
})

test('the defaults keep probes cheap, bounded and slower than legal TTFT', () => {
  assert.ok(timing.probeAfterMs <= 75_000, 'a probe must land below the measured 75 s TTFT ceiling')
  assert.ok(timing.probeIntervalMs >= timing.probeAfterMs, 'the silent-stream probe cadence must not be faster than the first probe')
  assert.ok(timing.tickMs <= timing.probeAfterMs, 'the tick must resolve the probe window')
  assert.ok(timing.probeTimeoutMs >= 5_000 && timing.probeTimeoutMs <= 60_000, 'probe deadline stays a generous but real bound')
  assert.ok(timing.restartCooldownMs >= 30_000, 'a replaced generation gets real time before the next probe')
  assert.ok(timing.readDeadlineMs >= 10_000 && timing.readDeadlineMs <= 120_000, 'a user page read gets a real but bounded deadline')
})
