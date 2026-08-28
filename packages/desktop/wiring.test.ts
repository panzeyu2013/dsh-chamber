/**
 * wiring.ts pure-gate tests (A1 split from main.ts) — node:test, no electron.
 * Covers the drain-queue decisions (bounded enqueue / notification-open
 * drain condition / deep-link dedupe) and the quit-state-machine gates
 * (local-running / update-download-ready) extracted from main.ts.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DRAIN_QUEUE_LIMIT,
  LOCAL_RUNNING_STATES,
  enqueueBounded,
  isLocalProcessRunning,
  isUpdateDownloadReady,
  recordDeepLinkSeen,
  shouldDrainNotificationOpen,
} from './wiring.ts'

test('enqueueBounded: appends in order and drops the OLDEST past the cap', () => {
  assert.deepEqual(enqueueBounded([], 'a', 3), ['a'])
  assert.deepEqual(enqueueBounded(['a'], 'b', 3), ['a', 'b'])
  assert.deepEqual(enqueueBounded(['a', 'b'], 'c', 3), ['a', 'b', 'c'])
  assert.deepEqual(enqueueBounded(['a', 'b', 'c'], 'd', 3), ['b', 'c', 'd'], 'cap exceeded → oldest dropped')
  assert.deepEqual(enqueueBounded(['a', 'b', 'c', 'd'], 'e', 3), ['c', 'd', 'e'])
})

test('enqueueBounded: the input queue is never mutated', () => {
  const queue = ['a', 'b', 'c']
  const next = enqueueBounded(queue, 'd', 3)
  assert.deepEqual(queue, ['a', 'b', 'c'], 'input untouched')
  assert.deepEqual(next, ['b', 'c', 'd'])
})

test('recordDeepLinkSeen: same URL deduped, distinct URLs pass, cap clears the whole set', () => {
  const seen = new Set<string>()
  assert.equal(recordDeepLinkSeen(seen, 'dsh-chamber://open-vscode?instanceId=a&path=/x', DRAIN_QUEUE_LIMIT), true)
  assert.equal(recordDeepLinkSeen(seen, 'dsh-chamber://open-vscode?instanceId=a&path=/x', DRAIN_QUEUE_LIMIT), false, 'duplicate → skip')
  assert.equal(recordDeepLinkSeen(seen, 'dsh-chamber://open-vscode?instanceId=b&path=/y', DRAIN_QUEUE_LIMIT), true, 'distinct → proceed')
  // Cap semantics: the add that pushes the set PAST the cap clears the WHOLE
  // set (non-LRU) — the same URL becomes replayable afterwards (idempotent
  // open, harmless).
  const small = new Set<string>()
  assert.equal(recordDeepLinkSeen(small, 'dsh-chamber://open-vscode?instanceId=i0&path=/x', 2), true)
  assert.equal(recordDeepLinkSeen(small, 'dsh-chamber://open-vscode?instanceId=i1&path=/x', 2), true)
  assert.equal(small.size, 2, 'at cap — not yet cleared')
  assert.equal(recordDeepLinkSeen(small, 'dsh-chamber://open-vscode?instanceId=i2&path=/x', 2), true, 'add beyond cap still proceeds')
  assert.equal(small.size, 0, 'cap exceeded → the WHOLE set was cleared')
  assert.equal(recordDeepLinkSeen(small, 'dsh-chamber://open-vscode?instanceId=i0&path=/x', 2), true, 'cleared URL is replayable')
  assert.equal(small.size, 1)
})

test('shouldDrainNotificationOpen: window alive + not loading + not crashed + renderer ready', () => {
  const ready = { windowAlive: true, isLoading: false, isCrashed: false, rendererReady: true }
  assert.equal(shouldDrainNotificationOpen(ready), true, 'all four conditions → push now')
  assert.equal(shouldDrainNotificationOpen({ ...ready, windowAlive: false }), false, 'no window → re-enqueue')
  assert.equal(shouldDrainNotificationOpen({ ...ready, isLoading: true }), false, 'loading → re-enqueue')
  assert.equal(shouldDrainNotificationOpen({ ...ready, isCrashed: true }), false, 'crashed → re-enqueue')
  assert.equal(shouldDrainNotificationOpen({ ...ready, rendererReady: false }), false, 'renderer not ready → re-enqueue')
})

test('isLocalProcessRunning: state machine AND live-process gate (2026-08 修订)', () => {
  // The state-machine states that carry an interruptible process.
  for (const state of ['starting', 'ready', 'degraded', 'restarting']) {
    assert.equal(isLocalProcessRunning(state, true), true, `${state} + alive → running`)
  }
  // The same states WITHOUT an actually-live process are NOT running (restart
  // backoff / dead-but-unprobed windows — the 2026-08 fix).
  assert.equal(isLocalProcessRunning('ready', false), false, 'ready but no live process → not running')
  // Non-running states never confirm.
  for (const state of ['stopped', 'error', 'restart-exhausted', 'idle']) {
    assert.equal(isLocalProcessRunning(state, true), false, `${state} → not running`)
    assert.equal(isLocalProcessRunning(state, false), false)
  }
  assert.equal(LOCAL_RUNNING_STATES.has('starting'), true)
  assert.equal(LOCAL_RUNNING_STATES.has('stopped'), false)
})

test('isUpdateDownloadReady: downloaded + unblocked install = quit exemption (design 14 D2)', () => {
  assert.equal(isUpdateDownloadReady({ phase: 'downloaded', installBlockedReason: null }), true)
  assert.equal(isUpdateDownloadReady({ phase: 'downloaded', installBlockedReason: 'missing Developer ID signature' }), false)
  assert.equal(isUpdateDownloadReady({ phase: 'available', installBlockedReason: null }), false)
  assert.equal(isUpdateDownloadReady({ phase: 'error', installBlockedReason: null }), false)
  assert.equal(isUpdateDownloadReady(undefined), false, 'controller not created → no exemption')
})
