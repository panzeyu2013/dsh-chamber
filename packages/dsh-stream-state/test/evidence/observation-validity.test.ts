/**
 * Observation validity (design 14 §D4): the classifier every chamber liveness
 * deadline consumes. The lockstep assertions here are the contract the consumers'
 * comments point at — \`unscheduled\`/\`superseded\` must never book a source fact.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyObservation,
  isAdmissible,
  type ObservationVerdict,
} from '../../src/evidence.ts'

test('an answer is an answer', () => {
  assert.equal(classifyObservation({ outcome: 'answered' }), 'answered')
  assert.equal(isAdmissible('answered'), true)
})

test('a deadline the page was awake for is a source fact', () => {
  assert.equal(classifyObservation({ outcome: 'error', errorName: 'TimeoutError' }), 'deadline')
  assert.equal(
    classifyObservation({ outcome: 'error', errorName: 'TimeoutError', schedulingGap: false }),
    'deadline',
  )
  assert.equal(isAdmissible('deadline'), true)
})

test('a deadline inside an unscheduled window is NOT a source fact', () => {
  const verdict = classifyObservation({ outcome: 'error', errorName: 'TimeoutError', schedulingGap: true })
  assert.equal(verdict, 'unscheduled')
  assert.equal(isAdmissible(verdict), false)
})

test('cancellation is superseded, never admissible', () => {
  assert.equal(classifyObservation({ outcome: 'error', errorName: 'AbortError' }), 'superseded')
  assert.equal(isAdmissible('superseded'), false)
  // A gap never overrides cancellation either.
  assert.equal(
    classifyObservation({ outcome: 'error', errorName: 'AbortError', schedulingGap: true }),
    'superseded',
  )
})

test('the error NAME decides cancellation, never the message wording', () => {
  // A deadline that happens to carry abort-ish wording is still a deadline.
  assert.equal(
    classifyObservation({ outcome: 'error', errorName: 'TimeoutError', errorMessage: 'The operation was aborted.' }),
    'deadline',
  )
  // WebKit reports our own aborted fetch as an abort-worded TypeError: not a source fact.
  assert.equal(classifyObservation({ outcome: 'error', errorMessage: 'Fetch is aborted' }), 'superseded')
  // WebKit's transport failure is a channel observation, not a cancellation.
  assert.equal(classifyObservation({ outcome: 'error', errorMessage: 'Load failed' }), 'channel')
  assert.equal(isAdmissible('channel'), true)
})

test('not-serving-yet is a phase, not a fault', () => {
  const verdict = classifyObservation({ outcome: 'error', notServingYet: true, errorMessage: '503' })
  assert.equal(verdict, 'unavailable')
  assert.equal(isAdmissible(verdict), false)
})

test('unknown error shapes fall back to the channel verdict', () => {
  assert.equal(classifyObservation({ outcome: 'error' }), 'channel')
  assert.equal(classifyObservation({ outcome: 'error', errorName: 'TypeError' }), 'channel')
})

test('the admissible set is exactly answered/deadline/channel', () => {
  const verdicts: ObservationVerdict[] = ['answered', 'deadline', 'unscheduled', 'superseded', 'channel', 'unavailable']
  assert.deepEqual(verdicts.filter(isAdmissible), ['answered', 'deadline', 'channel'])
})
