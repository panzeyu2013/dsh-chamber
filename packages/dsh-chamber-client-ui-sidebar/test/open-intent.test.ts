/**
 * open-intent.ts unit tests (plain node:test, no dsh, no DOM): the page-wide
 * "the user asked to open session X on source S" slot (design 05 §2.2 revision
 * 2026-12; 2026-12 field report problem 1 — switching to a remote session
 * flashed a new "新会话" before the requested one).
 *
 * Covered: the arm/replace/release lifecycle (including the session-id-guarded
 * release that keeps a NEWER click alive), retirement, subscriber fan-out with
 * per-listener isolation, and the two pure gates the App and the view render
 * from (current projection + veil hold). The veil rule is pinned on all four of
 * its inputs (2026-09-11 review S1): `blankCurrent` is what keeps a warm shell
 * from being covered by an opaque loading veil.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  __resetOpenIntentsForTests,
  armOpenIntent,
  clearOpenIntents,
  EARLY_OPEN_BUDGET_MS,
  EARLY_OPEN_RETRY_MS,
  getOpenIntent,
  projectableCurrent,
  releaseOpenIntent,
  shouldEarlyOpenSession,
  shouldHoldViewVeil,
  subscribeOpenIntent,
} from '../src/shared/open-intent.ts'

test('arm records the requested session; a repeated arm for the same session is a no-op', () => {
  __resetOpenIntentsForTests()
  assert.equal(armOpenIntent('ssh-b', 's1'), true)
  assert.equal(getOpenIntent('ssh-b'), 's1')
  assert.equal(getOpenIntent('ssh-b'), 's1')
  assert.equal(armOpenIntent('ssh-b', 's1'), false, 'the idempotent re-open must not churn the projection')
})

test('arming a NEWER session on the same source replaces the intent', () => {
  __resetOpenIntentsForTests()
  armOpenIntent('ssh-b', 's1')
  assert.equal(armOpenIntent('ssh-b', 's2'), true)
  assert.equal(getOpenIntent('ssh-b'), 's2')
})

test('release is session-guarded: an older dispatch settling late never clears a newer click', () => {
  __resetOpenIntentsForTests()
  armOpenIntent('ssh-b', 's1')
  armOpenIntent('ssh-b', 's2')
  // s1's open promise settles after the user already asked for s2.
  assert.equal(releaseOpenIntent('ssh-b', 's1'), false, 'the stale finally must not release the live intent')
  assert.equal(getOpenIntent('ssh-b'), 's2')
  assert.equal(releaseOpenIntent('ssh-b', 's2'), true)
  assert.equal(getOpenIntent('ssh-b'), undefined)
})

test('release without a session id (unconditional) clears whatever is pending, and a second release is a no-op', () => {
  __resetOpenIntentsForTests()
  armOpenIntent('ssh-b', 's1')
  assert.equal(releaseOpenIntent('ssh-b'), true)
  assert.equal(releaseOpenIntent('ssh-b'), false, 'nothing pending → no change, no notification')
  assert.equal(getOpenIntent('ssh-b'), undefined)
})

test('intents are per source: clearing one leaves the others pending', () => {
  __resetOpenIntentsForTests()
  armOpenIntent('ssh-b', 's1')
  armOpenIntent('ssh-c', 's2')
  releaseOpenIntent('ssh-b')
  assert.equal(getOpenIntent('ssh-b'), undefined)
  assert.equal(getOpenIntent('ssh-c'), 's2')
})

test('clearOpenIntents retires exactly the removed sources (same-id re-add starts clean)', () => {
  __resetOpenIntentsForTests()
  armOpenIntent('ssh-b', 's1')
  armOpenIntent('ssh-c', 's2')
  assert.equal(clearOpenIntents(['ssh-b', 'ssh-unknown']), true)
  assert.equal(getOpenIntent('ssh-b'), undefined)
  assert.equal(getOpenIntent('ssh-c'), 's2')
  assert.equal(clearOpenIntents(['ssh-unknown']), false, 'no match → no notification')
})

test('subscribers fire on every real change, and one throwing subscriber cannot abort the fan-out', () => {
  __resetOpenIntentsForTests()
  const seen: string[] = []
  const off = subscribeOpenIntent(() => { seen.push('a') })
  const offThrowing = subscribeOpenIntent(() => { throw new Error('boom') })
  const offThird = subscribeOpenIntent(() => { seen.push('c') })
  const originalError = console.error
  const logged: unknown[] = []
  console.error = (...args: unknown[]) => { logged.push(args) }
  try {
    armOpenIntent('ssh-b', 's1')
    armOpenIntent('ssh-b', 's1')   // no-op → no notification
    releaseOpenIntent('ssh-b')
  } finally {
    console.error = originalError
  }
  assert.deepEqual(seen, ['a', 'c', 'a', 'c'], 'the throwing subscriber must not swallow its siblings')
  assert.equal(logged.length, 2, 'each throw is reported once per notification')
  off()
  offThrowing()
  offThird()
  armOpenIntent('ssh-b', 's9')
  assert.deepEqual(seen, ['a', 'c', 'a', 'c'], 'unsubscribed listeners stop receiving')
})

test('projectableCurrent: only the active view projects a current, and never one the open is replacing', () => {
  assert.equal(projectableCurrent('ssh-b', 'ssh-b', 's1', undefined), 's1')
  assert.equal(projectableCurrent('ssh-b', 'ssh-c', 's1', undefined), undefined, 'non-active sources never project current (design 06 §4.3)')
  assert.equal(
    projectableCurrent('ssh-b', 'ssh-b', 'blank-1', 's1'),
    undefined,
    'the blank session the runtime self-selected during boot must never enter the navigation list',
  )
  assert.equal(projectableCurrent('ssh-b', 'ssh-b', undefined, 's1'), undefined)
  assert.equal(
    projectableCurrent('ssh-b', 'ssh-b', 's1', 's1'),
    's1',
    'an idempotent re-open keeps its highlight — the projection is already correct',
  )
  assert.equal(
    projectableCurrent('ssh-b', 'ssh-b', undefined, undefined),
    undefined,
    'no current and no open → nothing to project',
  )
})

test('shouldHoldViewVeil: holds only while the view would show NOTHING legitimate (2026-09-11 review S1)', () => {
  assert.equal(
    shouldHoldViewVeil({ failed: false, pendingIntent: true, showsRequestedSession: false, blankCurrent: true }),
    true,
    'cold boot: the requested session is not current and the view is blank — the hold hides the blank row',
  )
  assert.equal(
    shouldHoldViewVeil({ failed: false, pendingIntent: true, showsRequestedSession: false, blankCurrent: false }),
    false,
    'a WARM shell showing a legitimate session must not be covered by the opaque veil (design 05:162)',
  )
  assert.equal(
    shouldHoldViewVeil({ failed: false, pendingIntent: true, showsRequestedSession: true, blankCurrent: false }),
    false,
    'already showing the requested session → reveal now (idempotent re-open, or the early-open arm won)',
  )
  assert.equal(
    shouldHoldViewVeil({ failed: false, pendingIntent: true, showsRequestedSession: true, blankCurrent: true }),
    false,
    'the showsRequestedSession exclusion wins over a blankness flag that disagrees with it',
  )
  assert.equal(
    shouldHoldViewVeil({ failed: true, pendingIntent: true, showsRequestedSession: false, blankCurrent: true }),
    false,
    'a failed boot keeps the failure overlay in charge (and must not pin the veil for the 68s queued-open budget) — even when blank',
  )
  assert.equal(
    shouldHoldViewVeil({ failed: false, pendingIntent: false, showsRequestedSession: false, blankCurrent: true }),
    false,
    'no open in flight → the shell reveals at settle',
  )
  assert.equal(
    shouldHoldViewVeil({ failed: false, pendingIntent: false, showsRequestedSession: true, blankCurrent: false }),
    false,
    'no open in flight at all',
  )
})

test('shouldEarlyOpenSession: needs BOTH a live intent and an addressable session', () => {
  assert.equal(shouldEarlyOpenSession('s1', true), true)
  assert.equal(
    shouldEarlyOpenSession(undefined, true),
    false,
    'a released intent must retire the arm (the App already owns the outcome)',
  )
  assert.equal(
    shouldEarlyOpenSession('s1', false),
    false,
    'opening an unknown id would make the official controller throw sessions/select-unknown',
  )
})

test('the early-open arm is budgeted like the App dispatch and ticks far tighter than its 400ms retry', () => {
  assert.equal(EARLY_OPEN_BUDGET_MS, 8_000)
  assert.ok(EARLY_OPEN_RETRY_MS <= 100, 'the arm must observe addressability long before the App — its retry is 400ms')
})
