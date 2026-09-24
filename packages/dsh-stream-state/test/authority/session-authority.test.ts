/**
 * P1 scenario corpus for the session-fact authority.
 *
 * These vectors are the CONTRACT: a future requirement is a new vector here, never a new
 * repair function. They cover the silent-completion family (lost status frame, live but
 * silent carrier, host genuinely running, incomplete authority list, generation switch,
 * subagents, correction failure) plus the exactly-once completion edge.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  initialSessionAuthorityState,
  reduceSessionAuthority,
  type SessionAuthorityConfig,
  type SessionAuthorityEffect,
  type SessionAuthorityObservation,
  type SessionAuthorityState,
} from '../../src/index.ts'

const CONFIG = { confirmReads: 2 } as const

function run(
  steps: readonly SessionAuthorityObservation[],
  config: SessionAuthorityConfig = CONFIG,
): { state: SessionAuthorityState; flat: string[] } {
  let state = initialSessionAuthorityState()
  const all: SessionAuthorityEffect[] = []
  for (const step of steps) {
    const reduction = reduceSessionAuthority(state, step, config)
    state = reduction.state
    all.push(...reduction.effects)
  }
  return { state, flat: all.map(effect => effect.kind + ':' + ('sessionId' in effect ? effect.sessionId : effect.sessionIds.join(','))) }
}

function tick(
  now: number,
  official: Record<string, { running: boolean; completed?: boolean; subagent?: boolean }>,
  listComplete = true,
  generation = 'g1',
): SessionAuthorityObservation {
  return { kind: 'tick', now, generation, official, listComplete }
}

const read = (
  now: number,
  rows: Record<string, boolean>,
  complete = true,
  ok = true,
): SessionAuthorityObservation => ({ kind: 'authorityRead', now, read: { ok, complete, rows } })

test('first running tick seeds the episode without any effect', () => {
  const { state, flat } = run([tick(0, { s1: { running: true } })])
  assert.deepEqual(flat, [])
  assert.equal(state.sessions.s1?.since, 0)
})

test('an explicit official running=false edge completes exactly once with notify', () => {
  const { state, flat } = run([
    tick(0, { s1: { running: true } }),
    tick(30_000, { s1: { running: false } }),
    tick(60_000, { s1: { running: false } }),
  ])
  assert.deepEqual(flat, ['complete:s1'])
  assert.equal(state.sessions.s1, undefined)
})

test('a session absent from a COMPLETE official list completes without notify', () => {
  const { flat } = run([
    tick(0, { s1: { running: true } }),
    tick(30_000, {}),
  ])
  assert.deepEqual(flat, ['complete:s1'])
})

test('a session absent from an INCOMPLETE official list stays in its episode', () => {
  const { state, flat } = run([
    tick(0, { s1: { running: true } }),
    tick(30_000, {}, false),
  ])
  assert.deepEqual(flat, [])
  assert.equal(state.sessions.s1?.since, 0)
})

test('subagent rows are never reconciled, corrected or completed', () => {
  const { state, flat } = run([
    tick(0, { sub: { running: true, subagent: true } }),
    read(10, { sub: false }, true, true),
    read(20, { sub: false }, true, true),
    tick(30, { sub: { running: false, subagent: true } }),
  ])
  assert.deepEqual(flat, [])
  assert.deepEqual(state.sessions, {})
})

test('a generation change resets every episode without a completion', () => {
  const { state, flat } = run([
    tick(0, { s1: { running: true } }, true, 'g1'),
    tick(10, { s1: { running: true } }, true, 'g2'),
  ])
  assert.deepEqual(flat, [])
  assert.equal(state.sessions.s1?.since, 10)
})

test('a failed authority read is no evidence: neither denial nor confirmation', () => {
  const { flat } = run([
    tick(0, { s1: { running: true } }),
    read(10, { s1: false }, true, false),
  ])
  assert.deepEqual(flat, [])
})

test('N=2: the first denial asks for a confirmation read, the second corrects', () => {
  const { flat } = run([
    tick(0, { s1: { running: true } }),
    read(10, { s1: false }),
    read(20, { s1: false }),
  ])
  assert.deepEqual(flat, ['probe:s1', 'correct:s1'])
})

test('an explicit false denies even when the authority list is incomplete', () => {
  const { flat } = run([
    tick(0, { s1: { running: true } }),
    read(10, { s1: false }, false),
    read(20, { s1: false }, false),
  ])
  assert.deepEqual(flat, ['probe:s1', 'correct:s1'])
})

test('an incomplete read with the id absent is unknown, not a denial', () => {
  const { flat, state } = run([
    tick(0, { s1: { running: true } }),
    read(10, {}, false),
  ])
  assert.deepEqual(flat, [])
  assert.equal(state.sessions.s1?.deniedReads, 0)
})

test('the authority saying running resets denials (the bit converged)', () => {
  const { flat, state } = run([
    tick(0, { s1: { running: true } }),
    read(10, { s1: false }),
    read(20, { s1: true }),
  ])
  assert.deepEqual(flat, ['probe:s1'])
  assert.equal(state.sessions.s1?.deniedReads, 0)
})

test('a confirmed denial writes back and the accepted write completes with notify', () => {
  const { state, flat } = run([
    tick(0, { s1: { running: true } }),
    read(10, { s1: false }),
    read(20, { s1: false }),
    { kind: 'correctionResult', now: 30, sessionIds: ['s1'], ok: true },
  ])
  assert.deepEqual(flat, ['probe:s1', 'correct:s1', 'complete:s1'])
  assert.equal(state.sessions.s1, undefined)
})

test('a failed write-back does not complete and must be reconfirmed before retrying', () => {
  const { state, flat } = run([
    tick(0, { s1: { running: true } }),
    read(10, { s1: false }),
    read(20, { s1: false }),
    { kind: 'correctionResult', now: 30, sessionIds: ['s1'], ok: false },
    read(40, { s1: false }),
    read(50, { s1: false }),
  ])
  assert.deepEqual(flat, ['probe:s1', 'correct:s1', 'probe:s1', 'correct:s1'])
  assert.equal(state.sessions.s1?.correctionPending, true)
})

test('a second denial while a correction is in flight cannot duplicate the write', () => {
  const { flat } = run([
    tick(0, { s1: { running: true } }),
    read(10, { s1: false }),
    read(20, { s1: false }),
    read(30, { s1: false }),
  ])
  assert.deepEqual(flat, ['probe:s1', 'correct:s1'])
})

test('unknown reads between two explicit denials keep the denial count', () => {
  const { flat } = run([
    tick(0, { s1: { running: true } }),
    read(10, { s1: false }),
    read(20, {}, false),
    read(30, { s1: false }),
  ])
  assert.deepEqual(flat, ['probe:s1', 'correct:s1'])
})

test('an episode that ended can start again as a fresh episode', () => {
  const { state, flat } = run([
    tick(0, { s1: { running: true } }),
    tick(10, { s1: { running: false } }),
    tick(20, { s1: { running: true } }),
    tick(30, { s1: { running: false } }),
  ])
  assert.deepEqual(flat, ['complete:s1', 'complete:s1'])
  assert.equal(state.sessions.s1, undefined)
})

test('a host that re-asserts running after a completed correction starts a new episode', () => {
  const { flat } = run([
    tick(0, { s1: { running: true } }),
    read(10, { s1: false }),
    read(20, { s1: false }),
    { kind: 'correctionResult', now: 30, sessionIds: ['s1'], ok: true },
    tick(40, { s1: { running: true } }),
    tick(50, { s1: { running: false } }),
  ])
  assert.deepEqual(flat, ['probe:s1', 'correct:s1', 'complete:s1', 'complete:s1'])
})

test('confirmReads=1 writes back on the first denial', () => {
  const { flat } = run([
    tick(0, { s1: { running: true } }),
    read(10, { s1: false }),
  ], { confirmReads: 1 })
  assert.deepEqual(flat, ['correct:s1'])
})

test('a generation change drops an in-flight correction and ignores its late result', () => {
  const { state, flat } = run([
    tick(0, { s1: { running: true } }, true, 'g1'),
    read(10, { s1: false }),
    read(20, { s1: false }),
    tick(30, { s1: { running: true } }, true, 'g2'),
    { kind: 'correctionResult', now: 40, sessionIds: ['s1'], ok: true },
  ])
  assert.deepEqual(flat, ['probe:s1', 'correct:s1'], 'the abandoned write must not complete the new episode')
  assert.equal(state.sessions.s1?.since, 30)
  assert.equal(state.sessions.s1?.correctionPending, false)
})

test('an absent row completes exactly once when the official list later turns complete', () => {
  const { flat } = run([
    tick(0, { s1: { running: true } }),
    tick(10, {}, false),
    tick(20, {}, true),
    tick(30, {}, true),
  ])
  assert.deepEqual(flat, ['complete:s1'])
})

test('an authority read for an unknown id is ignored', () => {
  const { flat, state } = run([
    tick(0, { s1: { running: true } }),
    read(10, { s1: true, ghost: false }),
    read(20, { s1: true, ghost: false }),
  ])
  assert.deepEqual(flat, [], 'ghost has no episode: it can neither be probed nor corrected')
  assert.equal(state.sessions.ghost, undefined)
})

test('the full lost-frame scenario converges within two reads and one write', () => {
  const { state, flat } = run([
    // Host idle since 60s; the status frame was lost, the official bit stays true.
    tick(0, { s1: { running: true } }, true, 'g1'),
    tick(200_000, { s1: { running: true } }, true, 'g1'),
    // The ladder probes; the independent authority denies twice.
    read(200_100, { s1: false }),
    read(200_200, { s1: false }),
    { kind: 'correctionResult', now: 200_300, sessionIds: ['s1'], ok: true },
    // Official store now reflects the write.
    tick(230_000, { s1: { running: false } }),
  ])
  assert.deepEqual(flat, ['probe:s1', 'correct:s1', 'complete:s1'])
  assert.equal(state.sessions.s1, undefined)
})
