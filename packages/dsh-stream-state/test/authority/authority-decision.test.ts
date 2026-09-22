/**
 * The sidebar receipt chain's DECISION, separated from its async orchestration.
 *
 * These cases pin the four verdict branches and the write-back outcome directly,
 * without the whole async chain.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  decideAfterAuthorityProbe,
  decideAfterWriteBack,
  shouldWarnAboutBrokenRefresh,
} from '../../src/index.ts'

test('a converged authority settles ok without correcting anything', () => {
  const step = decideAfterAuthorityProbe('converged', false)
  assert.equal(step.step, 'settle')
  assert.equal(step.step === 'settle' && step.ok, true)
  assert.equal(step.step === 'settle' && step.corrected, false)
})

test('an unavailable probe is NOT a stale fact: it settles unknown, not ok', () => {
  const step = decideAfterAuthorityProbe('unknown', true)
  assert.equal(step.step === 'settle' && step.ok, false)
  assert.match(step.step === 'settle' ? step.note : '', /probe is unavailable/)
})

test('a stale verdict with a write-back seam goes to the write-back first', () => {
  assert.deepEqual(decideAfterAuthorityProbe('stale', true), { step: 'writeBack' })
})

test('a stale verdict without a seam settles stale (which is what lets the guard escalate)', () => {
  const step = decideAfterAuthorityProbe('stale', false)
  assert.equal(step.step === 'settle' && step.ok, false)
  assert.match(step.step === 'settle' ? step.note : '', /did not converge/)
})

test('a write-back that verified settles converged+corrected', () => {
  const step = decideAfterWriteBack(true)
  assert.equal(step.step === 'settle' && step.ok, true)
  assert.equal(step.step === 'settle' && step.corrected, true)
})

test('a write-back that did NOT verify must still settle stale, never corrected', () => {
  const step = decideAfterWriteBack(false)
  assert.equal(step.step === 'settle' && step.ok, false)
  assert.equal(step.step === 'settle' && step.corrected, false)
})

test('only a SUCCESSFUL settle warns about a broken official refresh', () => {
  const ok = decideAfterAuthorityProbe('converged', false)
  const failed = decideAfterWriteBack(false)
  assert.equal(shouldWarnAboutBrokenRefresh(true, ok), true)
  assert.equal(shouldWarnAboutBrokenRefresh(true, failed), false, 'a failure already carries the reason')
  assert.equal(shouldWarnAboutBrokenRefresh(false, ok), false)
})