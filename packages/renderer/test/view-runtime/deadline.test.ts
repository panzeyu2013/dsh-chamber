/**
 * Deadline primitive (host/use-deadline.ts): the pure answer plus a source lock
 * that the control-plane health grace is deadline-driven, not a polling counter.
 * The predicate is the whole decision — the hook only arms one timer for it —
 * so this runs in plain node with no DOM.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { deadlineFired } from '../../src/host/use-deadline.ts'

test('deadlineFired: null never fires, the instant itself fires', () => {
  assert.equal(deadlineFired(null, 1_000, null), false, 'no deadline = never reached')
  assert.equal(deadlineFired(1_000, 999, null), false, 'before the deadline')
  assert.equal(deadlineFired(1_000, 1_000, null), true, 'at the deadline (inclusive)')
  assert.equal(deadlineFired(1_000, 1_001, null), true, 'after the deadline')
})

test('a fire belongs to the deadline it was armed for (no stale true)', () => {
  assert.equal(deadlineFired(null, 1_000, 1_000), false, 'a fired deadline followed by null must render false')
  assert.equal(deadlineFired(2_000, 0, 1_000), false, 'an older fire must not mark a NEW deadline as reached')
  assert.equal(deadlineFired(2_000, 0, 2_000), true, 'the matching fire counts')
})

test('the App health grace is a deadline, not a 1 Hz tick counter', () => {
  const app = readFileSync(fileURLToPath(new URL('../../src/App.tsx', import.meta.url)), 'utf8')
  assert.match(app, /useDeadline\(/, 'the frame must consume the deadline primitive')
  assert.match(app, /healthErrorAt \+ HEALTH_ERROR_GRACE_MS/, 'the deadline is the error instant plus the grace window')
  assert.doesNotMatch(app, /setHealthErrorTick/, 'the tick counter must not come back')
  const hook = readFileSync(fileURLToPath(new URL('../../src/host/use-deadline.ts', import.meta.url)), 'utf8')
  assert.match(hook, /setTimeout\(/, 'one timer for the remaining wait')
  assert.match(hook, /MAX_TIMEOUT_MS/, 'a wait longer than one setTimeout must re-arm, not fire early')
  assert.doesNotMatch(hook, /setInterval\(/, 'never a polling interval')
})
