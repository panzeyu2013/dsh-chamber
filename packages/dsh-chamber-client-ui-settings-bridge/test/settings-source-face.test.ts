/**
 * Per-instance settings-source face registry (design 05 §5, 2026-12 完整桥接
 * 修订). The registry is the page seam that replaced the detached child cordis
 * context: the panel renders the SELECTED source's own boot-ctx ledger with
 * that source's own renderer-bound seats, so the publishers and the readiness
 * gate are load-bearing contracts.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  getSettingsSourceFace, publishSettingsSourceRuntime, publishSettingsSourceSeats,
  settingsSourceFaceReady, settingsSourceFaceRevision, subscribeSettingsSourceFaces,
} from '../src/client/settings-source-face.ts'
import type { SettingsSourceLocale, SettingsSourceSeats, SettingsSourceSlots } from '../src/client/settings-source-face.ts'

/** Minimal slots read face (only identity matters to the registry). */
function slots(): SettingsSourceSlots {
  return {
    entries: () => [],
    entriesOfSlot: () => [],
    getVersion: () => 0,
    subscribe: () => () => {},
    spec: () => undefined,
    onEntryError: () => () => {},
  }
}

const locale: SettingsSourceLocale = {
  getSnapshot: () => ({ revision: 1 }),
  subscribe: () => () => {},
  bind: () => (key: string) => key,
}

const seats: SettingsSourceSeats = { useSessions: () => undefined, props: { chamberFileApiBase: '/api/i/local' } }

test('a source is renderable only once BOTH halves are published', () => {
  const ctxSlots = slots()
  const disposeRuntime = publishSettingsSourceRuntime('local', { slots: ctxSlots, locale, sourceFingerprint: 'local' })
  assert.equal(settingsSourceFaceReady(getSettingsSourceFace('local')), false,
    'the ledger alone is not enough: entries render with seats');
  const disposeSeats = publishSettingsSourceSeats('local', seats)
  const face = getSettingsSourceFace('local')
  assert.equal(settingsSourceFaceReady(face), true)
  assert.equal(face?.slots, ctxSlots)
  assert.equal(face?.locale, locale)
  assert.equal(face?.seats, seats)
  assert.equal(face?.sourceFingerprint, 'local', 'the incarnation proof must ride the face')
  disposeSeats()
  disposeRuntime()
});

test('retracting one half drops only that half; a full retraction removes the source', () => {
  const ctxSlots = slots()
  const disposeRuntime = publishSettingsSourceRuntime('dsh-a', { slots: ctxSlots, sourceFingerprint: 'a'.repeat(64) })
  const disposeSeats = publishSettingsSourceSeats('dsh-a', seats)
  disposeSeats()
  const afterSeats = getSettingsSourceFace('dsh-a')
  assert.equal(afterSeats?.slots, ctxSlots, 'the ctx half survives the seat retraction')
  assert.equal(settingsSourceFaceReady(afterSeats), false)
  disposeRuntime()
  assert.equal(getSettingsSourceFace('dsh-a'), undefined, 'no half may linger after both publishers left')
});

test('a republish notifies once per change and keeps the revision monotonic', () => {
  let notifications = 0
  const unsubscribe = subscribeSettingsSourceFaces(() => { notifications += 1 })
  const before = settingsSourceFaceRevision()
  const ctxSlots = slots()
  const disposeRuntime = publishSettingsSourceRuntime('gateway-b', { slots: ctxSlots })
  const afterRuntime = settingsSourceFaceRevision()
  assert.ok(afterRuntime > before, 'the revision must move for the uSES readers')
  assert.equal(notifications, 1)
  // The same ctx half published twice is not a change (stable uSES snapshot).
  const disposeAgain = publishSettingsSourceRuntime('gateway-b', { slots: ctxSlots })
  assert.equal(notifications, 1, 'an identical publication must not wake subscribers')
  disposeAgain()
  disposeRuntime()
  unsubscribe()
});

test('a throwing subscriber cannot starve its siblings', () => {
  let seen = 0
  const bad = subscribeSettingsSourceFaces(() => { throw new Error('boom') })
  const good = subscribeSettingsSourceFaces(() => { seen += 1 })
  const dispose = publishSettingsSourceRuntime('local-throwing', { slots: slots() })
  assert.equal(seen, 1, 'the registry must isolate per-listener failures')
  dispose()
  bad()
  good()
});
