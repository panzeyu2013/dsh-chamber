/**
 * Cross-package parity: the mobile stall observer and the desktop open-in
 * stream-health ladder implement the SAME recovery contract (design 14 §D4) on
 * two tiers. This lockstep test imports BOTH pure decision modules and pins:
 *  - the evidence rule (a parked `loading` open with NO open in flight): the
 *    automatic rebuild fires on one tier exactly when it fires on the other;
 *  - the shared ledger (cooldown / rolling window / attempts) and the failure
 *    wording bound, which must stay equal;
 *  - the ONE intentional deviation (the notice threshold, longer here because
 *    this tier observes a DOM-only shape without the official openState).
 * Any drift on either side turns this file red by design.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  decideStallNotice, STALL_FAILED_MS, STALL_RESYNC_COOLDOWN_MS, STALL_RESYNC_MAX,
  STALL_RESYNC_WINDOW_MS, STALL_THRESHOLD_MS,
} from '../../src/client/session-stall.ts'
import {
  createSessionStreamHealthState, planSessionStreamHealth, SESSION_STREAM_HEALTH_DEFAULTS,
} from '../../../dsh-chamber-client-ui-open-in/src/client/session-stream-health.ts'

const NOW = 1_000_000

/** Desktop ladder state parked in the loading hold since `heldMs` ago. */
function desktopLoadingHold(heldMs: number) {
  return { phase: 'loading-hold' as const, since: NOW - heldMs, healStamps: [] }
}

test('the shared ledger and the failure bound are equal across tiers', () => {
  assert.equal(STALL_RESYNC_COOLDOWN_MS, SESSION_STREAM_HEALTH_DEFAULTS.healCooldownMs)
  assert.equal(STALL_RESYNC_WINDOW_MS, SESSION_STREAM_HEALTH_DEFAULTS.healBudgetWindowMs)
  assert.equal(STALL_RESYNC_MAX, SESSION_STREAM_HEALTH_DEFAULTS.healBudgetMax)
  assert.equal(STALL_FAILED_MS, SESSION_STREAM_HEALTH_DEFAULTS.loadingFailedMs)
})

test('the notice threshold is the ONE documented deviation (mobile is DOM-only)', () => {
  assert.equal(SESSION_STREAM_HEALTH_DEFAULTS.loadingStallMs, 20_000)
  assert.equal(STALL_THRESHOLD_MS, 45_000)
  assert.ok(STALL_THRESHOLD_MS > SESSION_STREAM_HEALTH_DEFAULTS.loadingStallMs,
    'the mobile tier has no openState channel and must stay conservative')
  assert.ok(STALL_THRESHOLD_MS < STALL_FAILED_MS, 'the failure wording must not precede the notice')
})

test('the automatic-rebuild evidence rule agrees on every in-flight value', () => {
  const desktop = (openInFlight: boolean | undefined): boolean => planSessionStreamHealth(
    desktopLoadingHold(SESSION_STREAM_HEALTH_DEFAULTS.loadingStallMs),
    {
      openState: 'loading',
      presented: true,
      // The stage move is NOT required for the automatic rebuild: neither tier
      // gates the per-session resync on a neighbour.
      neighborAvailable: false,
      resyncAvailable: true,
      openInFlight,
    },
    NOW,
  ).action === 'auto-resync'
  const mobile = (openInFlight: boolean | undefined): boolean => decideStallNotice({
    shape: true,
    pageVisible: true,
    since: NOW - STALL_THRESHOLD_MS,
    now: NOW,
    dismissed: false,
    loading: true,
    openInFlight,
    resyncStamps: [],
  }).resync
  for (const openInFlight of [false, true, undefined]) {
    assert.equal(desktop(openInFlight), mobile(openInFlight),
      'automatic rebuild verdict drifted for openInFlight=' + String(openInFlight))
  }
  assert.equal(desktop(false), true, 'a parked open is rebuilt automatically on both tiers')
  assert.equal(desktop(true), false, 'an in-flight open is never interrupted')
  assert.equal(desktop(undefined), false, 'an unreadable face fails closed')
})

test('the loading evidence is required on both tiers (the shape alone is not enough)', () => {
  // Mobile: the DOM stall shape without a concrete `loading` state must not
  // rebuild — a healthy open session can share the shape.
  assert.equal(decideStallNotice({
    shape: true, pageVisible: true, since: NOW - STALL_THRESHOLD_MS, now: NOW,
    dismissed: false, loading: false, openInFlight: false, resyncStamps: [],
  }).resync, false)
  assert.equal(decideStallNotice({
    shape: true, pageVisible: true, since: NOW - STALL_THRESHOLD_MS, now: NOW,
    dismissed: false, openInFlight: false, resyncStamps: [],
  }).resync, false, 'an unreadable loading state fails closed')
  // Desktop: the automatic arm lives in the loading branch only; an error state
  // may arm the MANUAL control but never executes on its own.
  const errorArm = planSessionStreamHealth(
    createSessionStreamHealthState(),
    { openState: 'error', presented: true, neighborAvailable: true, resyncAvailable: true, openInFlight: false },
    NOW,
  )
  assert.notEqual(errorArm.action, 'auto-resync')
})
