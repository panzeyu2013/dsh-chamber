/**
 * Writer-quiescence notice model (2026-09-10, design 02 §3.4 / 04 §3.2).
 *
 * The local card must name the blocker and offer 清理并接管 EXACTLY when the
 * control plane says a takeover could clear it — never for a sticky verdict (a
 * failed termination no scan can re-prove) and never for a writer whose
 * control plane is still alive.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writerNotice, writerReasonKey } from '../src/client/writer-diagnosis.ts'
import type { LocalWriterDiagnosisWire } from '@dsh-chamber/dsh-chamber-client-ui-sidebar/shared'

const blocker = (over: Partial<LocalWriterDiagnosisWire['writers'][number]> = {}) => ({
  name: '4242.json',
  status: 'kept' as const,
  pid: 4242,
  reason: 'identity-unverified',
  takeOverAvailable: true,
  ...over,
})

const diagnosis = (over: Partial<LocalWriterDiagnosisWire> = {}): LocalWriterDiagnosisWire => ({
  quiescent: false, writers: [blocker()], errors: [], ...over,
})

test('writerNotice: a quiescent or missing diagnosis renders nothing', () => {
  assert.equal(writerNotice(null), null)
  assert.equal(writerNotice(diagnosis({ quiescent: true, writers: [] })), null)
})

test('writerNotice: kept records are named and the takeover is offered', () => {
  const notice = writerNotice(diagnosis())
  assert.deepEqual(notice?.blockers, [{ pid: 4242, reason: 'identity-unverified', takeOverAvailable: true }])
  assert.equal(notice?.canTakeOver, true)
  assert.equal(notice?.restartRequired, false)
})

test('writerNotice: a live foreign writer never offers the takeover', () => {
  // The record's owning control plane is still alive (another app instance):
  // clearing or killing it would break that instance.
  const notice = writerNotice(diagnosis({
    writers: [blocker({ reason: 'live-foreign-writer', takeOverAvailable: false })],
  }))
  assert.equal(notice?.canTakeOver, false)
  assert.equal(notice?.restartRequired, false)
  assert.equal(notice?.blockers.length, 1)
})

test('writerNotice: a sticky verdict asks for an app restart instead', () => {
  const notice = writerNotice(diagnosis({
    writers: [],
    errors: [
      'writer quiescence unknown: process group cleanup could not be proven',
      'restart the app to re-prove writer quiescence',
    ],
  }))
  assert.equal(notice?.restartRequired, true)
  assert.equal(notice?.canTakeOver, false, 'no evidence is left to act on')
  assert.equal(notice?.blockers.length, 0)
})

test('writerNotice: reclaimed/removed entries are not blockers', () => {
  const notice = writerNotice(diagnosis({
    writers: [blocker({ status: 'reclaimed' }), blocker({ status: 'removed', pid: 4343 })],
  }))
  assert.deepEqual(notice?.blockers, [])
  assert.equal(notice?.canTakeOver, false)
})

test('writerReasonKey: every machine reason maps to a gloss', () => {
  assert.equal(writerReasonKey('identity-unverified'), 'writerReasonIdentityUnverified')
  assert.equal(writerReasonKey('identity-mismatch'), 'writerReasonIdentityMismatch')
  assert.equal(writerReasonKey('live-foreign-writer'), 'writerReasonLiveForeignWriter')
  assert.equal(writerReasonKey('port-unverified'), 'writerReasonPortUnverified')
  assert.equal(writerReasonKey('residual-group'), 'writerReasonResidualGroup')
  assert.equal(writerReasonKey('invalid-record'), 'writerReasonInvalidRecord')
  assert.equal(writerReasonKey('claim-owner-alive'), 'writerReasonClaim')
  // Unknown tokens still render a sentence rather than a raw key.
  assert.equal(writerReasonKey('brand-new-reason'), 'writerReasonIdentityUnverified')
})
