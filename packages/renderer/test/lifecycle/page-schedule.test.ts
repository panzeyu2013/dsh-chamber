/**
 * The page's scheduling record (design 14 §D4). A rAF heartbeat is the only in-page
 * evidence that the page is being scheduled at all: WebKit throttles an unfocused or
 * occluded WKWebView while \`document.visibilityState\` still says \`visible\`, and these
 * tests pin the conservative rules every liveness deadline relies on.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PAGE_SCHEDULE_GAP_MS,
  hadSchedulingGap,
  noteFocus,
  notePageTick,
  noteVisibility,
  pageScheduleSnapshot,
  resetPageScheduleForTests,
} from '../../../dsh-chamber-client-core/src/page-schedule.ts'

test('a healthy cadence is not a gap', () => {
  resetPageScheduleForTests()
  for (let at = 1_000; at <= 5_000; at += 16) notePageTick(at)
  assert.equal(hadSchedulingGap(2_000, 5_000, 5_000), false)
  assert.equal(pageScheduleSnapshot().lastGap, null)
})

test('a tick gap overlapping the window is positive evidence', () => {
  resetPageScheduleForTests()
  notePageTick(1_000)
  notePageTick(5_000) // 4s of silence: throttled or suspended
  assert.equal(PAGE_SCHEDULE_GAP_MS <= 4_000, true)
  assert.equal(hadSchedulingGap(2_000, 5_000, 5_000), true)
  assert.deepEqual(pageScheduleSnapshot().lastGap, { from: 1_000, to: 5_000 })
})

test('silence across the whole window counts even without a recorded gap', () => {
  resetPageScheduleForTests()
  notePageTick(1_000)
  assert.equal(hadSchedulingGap(2_000, 6_000, 6_500), true)
})

test('an unfocused window is positive evidence', () => {
  resetPageScheduleForTests()
  notePageTick(10_000)
  noteFocus(false)
  assert.equal(hadSchedulingGap(9_000, 10_000, 10_000), true)
  noteFocus(true)
  assert.equal(hadSchedulingGap(9_000, 10_000, 10_000), false)
})

test('a hidden document is positive evidence', () => {
  resetPageScheduleForTests()
  notePageTick(10_000)
  noteVisibility(false)
  assert.equal(hadSchedulingGap(9_000, 10_000, 10_000), true)
})

test('no evidence never claims a gap (unknown must not excuse a failure)', () => {
  resetPageScheduleForTests()
  assert.equal(hadSchedulingGap(1_000, 2_000, 2_000), false)
  assert.equal(pageScheduleSnapshot().lastTickAt, null)
})
