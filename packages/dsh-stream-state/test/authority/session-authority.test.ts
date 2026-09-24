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
  type AuthorityReadProof,
  type SessionAuthorityConfig,
  type SessionAuthorityEffect,
  type SessionAuthorityObservation,
  type SessionAuthorityTicket,
  type SessionAuthorityState,
} from '../../src/index.ts'

const CONFIG = { confirmReads: 2 } as const

type ScenarioStep = SessionAuthorityObservation
  | { readonly kind: 'readFixture'; readonly now: number; readonly read: { ok: boolean; proof: AuthorityReadProof; rows: Record<string, boolean> } }
  | { readonly kind: 'correctionFixture'; readonly now: number; readonly ok: boolean }

function run(
  steps: readonly ScenarioStep[],
  config: SessionAuthorityConfig = CONFIG,
): { state: SessionAuthorityState; flat: string[] } {
  let state = initialSessionAuthorityState()
  const all: SessionAuthorityEffect[] = []
  let lastCorrection: Extract<SessionAuthorityEffect, { kind: 'correct' }> | undefined
  const apply = (observation: SessionAuthorityObservation, record = true): void => {
    const reduction = reduceSessionAuthority(state, observation, config)
    state = reduction.state
    if (record) all.push(...reduction.effects)
    lastCorrection = reduction.effects.find((effect): effect is Extract<SessionAuthorityEffect, { kind: 'correct' }> =>
      effect.kind === 'correct') ?? lastCorrection
  }
  for (const step of steps) {
    if (step.kind === 'readFixture') {
      if (state.pendingRead === undefined) apply({ kind: 'readRequested' }, false)
      const ticket = state.pendingRead
      if (ticket === undefined) continue
      apply({ kind: 'authorityRead', now: step.now, ticket, read: step.read })
    } else if (step.kind === 'correctionFixture') {
      assert.ok(lastCorrection, 'a correction effect must own its result')
      apply({ kind: 'correctionResult', now: step.now, ticket: lastCorrection.ticket, ok: step.ok })
    } else {
      apply(step)
    }
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
  proof: AuthorityReadProof = { kind: 'asOfSeq', asOfSeq: 1 },
  ok = true,
): ScenarioStep => ({ kind: 'readFixture', now, read: { ok, proof, rows } })

const correction = (now: number, ok: boolean): ScenarioStep =>
  ({ kind: 'correctionFixture', now, ok })

test('first running tick seeds the episode without any effect', () => {
  const { state, flat } = run([tick(0, { s1: { running: true } })])
  assert.deepEqual(flat, [])
  assert.equal(state.sessions.s1?.since, 0)
})

test('an explicit official running=false edge ends the episode once', () => {
  const { state, flat } = run([
    tick(0, { s1: { running: true } }),
    tick(30_000, { s1: { running: false } }),
    tick(60_000, { s1: { running: false } }),
  ])
  assert.deepEqual(flat, ['episodeEnded:s1'])
  assert.equal(state.sessions.s1, undefined)
})

test('a session absent from a complete official list ends the episode', () => {
  const { flat } = run([
    tick(0, { s1: { running: true } }),
    tick(30_000, {}),
  ])
  assert.deepEqual(flat, ['episodeEnded:s1'])
})

test('episode end carries a diagnostic cause and no notification decision', () => {
  const running = reduceSessionAuthority(initialSessionAuthorityState(), tick(0, { s1: { running: true } }), CONFIG).state
  const stopped = reduceSessionAuthority(running, tick(1, { s1: { running: false } }), CONFIG)
  const removed = reduceSessionAuthority(running, tick(1, {}), CONFIG)
  assert.deepEqual(stopped.effects, [{ kind: 'episodeEnded', sessionId: 's1', at: 1, cause: 'official-stop' }])
  assert.deepEqual(removed.effects, [{ kind: 'episodeEnded', sessionId: 's1', at: 1, cause: 'list-removal' }])
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
    read(10, { sub: false }, { kind: 'asOfSeq', asOfSeq: 1 }, true),
    read(20, { sub: false }, { kind: 'asOfSeq', asOfSeq: 1 }, true),
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
    read(10, { s1: false }, { kind: 'asOfSeq', asOfSeq: 1 }, false),
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
    read(10, { s1: false }, { kind: 'none' }),
    read(20, { s1: false }, { kind: 'none' }),
  ])
  assert.deepEqual(flat, ['probe:s1', 'correct:s1'])
})

test('an incomplete read with the id absent is unknown, not a denial', () => {
  const { flat, state } = run([
    tick(0, { s1: { running: true } }),
    read(10, {}, { kind: 'none' }),
  ])
  assert.deepEqual(flat, [])
  assert.equal(state.sessions.s1?.deniedReads, 0)
})

test('an incomplete read reports every uncovered active episode as unresolved', () => {
  const running = reduceSessionAuthority(initialSessionAuthorityState(), tick(0, {
    s1: { running: true }, s2: { running: true },
  }), CONFIG).state
  const requested = startRead(running)
  const result = reduceSessionAuthority(requested.state, {
    kind: 'authorityRead', now: 10, ticket: requested.ticket,
    read: { ok: true, proof: { kind: 'none' }, rows: { s1: true } },
  }, CONFIG)
  assert.deepEqual(result.unresolved, ['s2'])
  assert.equal(result.state.sessions.s2?.deniedReads, 0)
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

test('a confirmed denial writes back and the accepted write ends the episode', () => {
  const { state, flat } = run([
    tick(0, { s1: { running: true } }),
    read(10, { s1: false }),
    read(20, { s1: false }),
    correction(30, true),
  ])
  assert.deepEqual(flat, ['probe:s1', 'correct:s1', 'episodeEnded:s1'])
  assert.equal(state.sessions.s1, undefined)
})

test('a failed write-back does not complete and must be reconfirmed before retrying', () => {
  const { state, flat } = run([
    tick(0, { s1: { running: true } }),
    read(10, { s1: false }),
    read(20, { s1: false }),
    correction(30, false),
    read(40, { s1: false }),
    read(50, { s1: false }),
  ])
  assert.deepEqual(flat, ['probe:s1', 'correct:s1', 'probe:s1', 'correct:s1'])
  assert.notEqual(state.sessions.s1?.correctionTicket, undefined)
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
    read(20, {}, { kind: 'none' }),
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
  assert.deepEqual(flat, ['episodeEnded:s1', 'episodeEnded:s1'])
  assert.equal(state.sessions.s1, undefined)
})

test('a host that re-asserts running after a completed correction starts a new episode', () => {
  const { flat } = run([
    tick(0, { s1: { running: true } }),
    read(10, { s1: false }),
    read(20, { s1: false }),
    correction(30, true),
    tick(40, { s1: { running: true } }),
    tick(50, { s1: { running: false } }),
  ])
  assert.deepEqual(flat, ['probe:s1', 'correct:s1', 'episodeEnded:s1', 'episodeEnded:s1'])
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
    correction(40, true),
  ])
  assert.deepEqual(flat, ['probe:s1', 'correct:s1'], 'the abandoned write must not complete the new episode')
  assert.equal(state.sessions.s1?.since, 30)
  assert.equal(state.sessions.s1?.correctionTicket, undefined)
})

test('an absent row completes exactly once when the official list later turns complete', () => {
  const { flat } = run([
    tick(0, { s1: { running: true } }),
    tick(10, {}, false),
    tick(20, {}, true),
    tick(30, {}, true),
  ])
  assert.deepEqual(flat, ['episodeEnded:s1'])
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
    correction(200_300, true),
    // Official store now reflects the write.
    tick(230_000, { s1: { running: false } }),
  ])
  assert.deepEqual(flat, ['probe:s1', 'correct:s1', 'episodeEnded:s1'])
  assert.equal(state.sessions.s1, undefined)
})

function startRead(state: SessionAuthorityState): { state: SessionAuthorityState; ticket: SessionAuthorityTicket } {
  const result = reduceSessionAuthority(state, { kind: 'readRequested' }, CONFIG)
  const ticket = result.effects.find((effect): effect is Extract<SessionAuthorityEffect, { kind: 'probe' }> =>
    effect.kind === 'probe')?.ticket
  assert.ok(ticket)
  return { state: result.state, ticket }
}

test('a late read from an old generation cannot deny a new running episode', () => {
  const old = startRead(reduceSessionAuthority(initialSessionAuthorityState(),
    tick(0, { s1: { running: true } }, true, 'g1'), CONFIG).state)
  const fresh = reduceSessionAuthority(old.state, tick(10, { s1: { running: true } }, true, 'g2'), CONFIG).state
  const late = reduceSessionAuthority(fresh, {
    kind: 'authorityRead', now: 20, ticket: old.ticket, read: { ok: true, proof: { kind: 'asOfSeq', asOfSeq: 1 }, rows: { s1: false } },
  }, CONFIG)
  assert.equal(late.state.sessions.s1?.deniedReads, 0)
  assert.deepEqual(late.effects, [])
})

test('a late read cannot act on a new episode with the same session id', () => {
  const old = startRead(reduceSessionAuthority(initialSessionAuthorityState(),
    tick(0, { s1: { running: true } }), CONFIG).state)
  const stopped = reduceSessionAuthority(old.state, tick(10, { s1: { running: false } }), CONFIG).state
  const restarted = reduceSessionAuthority(stopped, tick(20, { s1: { running: true } }), CONFIG).state
  const late = reduceSessionAuthority(restarted, {
    kind: 'authorityRead', now: 30, ticket: old.ticket, read: { ok: true, proof: { kind: 'asOfSeq', asOfSeq: 1 }, rows: { s1: false } },
  }, CONFIG)
  assert.equal(late.state.sessions.s1?.deniedReads, 0)
  assert.deepEqual(late.effects, [])
})

test('the newest read owns the pending verdict within one episode', () => {
  const running = reduceSessionAuthority(initialSessionAuthorityState(),
    tick(0, { s1: { running: true } }), CONFIG).state
  const old = startRead(running)
  const fresh = startRead(old.state)
  const accepted = reduceSessionAuthority(fresh.state, {
    kind: 'authorityRead', now: 10, ticket: fresh.ticket,
    read: { ok: true, proof: { kind: 'asOfSeq', asOfSeq: 1 }, rows: { s1: true } },
  }, CONFIG)
  const late = reduceSessionAuthority(accepted.state, {
    kind: 'authorityRead', now: 20, ticket: old.ticket,
    read: { ok: true, proof: { kind: 'asOfSeq', asOfSeq: 1 }, rows: { s1: false } },
  }, CONFIG)
  assert.equal(late.state.sessions.s1?.deniedReads, 0)
  assert.deepEqual(late.effects, [])
})

test('an old correction cannot settle a newer correction after a generation switch', () => {
  let state = initialSessionAuthorityState()
  const apply = (observation: SessionAuthorityObservation): SessionAuthorityEffect[] => {
    const result = reduceSessionAuthority(state, observation, CONFIG)
    state = result.state
    return [...result.effects]
  }
  const confirmed = (at: number): SessionAuthorityTicket => {
    const requested = startRead(state)
    state = requested.state
    const ticket = requested.ticket
    const first = apply({ kind: 'authorityRead', now: at, ticket,
      read: { ok: true, proof: { kind: 'asOfSeq', asOfSeq: 1 }, rows: { s1: false } } })
    const confirm = first.find((effect): effect is Extract<SessionAuthorityEffect, { kind: 'probe' }> => effect.kind === 'probe')
    assert.ok(confirm)
    const second = apply({ kind: 'authorityRead', now: at + 1, ticket: confirm.ticket,
      read: { ok: true, proof: { kind: 'asOfSeq', asOfSeq: 1 }, rows: { s1: false } } })
    const correct = second.find((effect): effect is Extract<SessionAuthorityEffect, { kind: 'correct' }> => effect.kind === 'correct')
    assert.ok(correct)
    return correct.ticket
  }
  apply(tick(0, { s1: { running: true } }, true, 'g1'))
  const old = confirmed(10)
  apply(tick(20, { s1: { running: true } }, true, 'g2'))
  const fresh = confirmed(30)
  assert.notEqual(old.id, fresh.id)
  assert.deepEqual(apply({ kind: 'correctionResult', now: 40, ticket: old, ok: true }), [])
  assert.equal(state.sessions.s1?.correctionTicket, fresh.id)
  assert.deepEqual(apply({ kind: 'correctionResult', now: 50, ticket: fresh, ok: true })
    .map(effect => effect.kind), ['episodeEnded'])
})

test('a retry within one episode has a new write identity', () => {
  let state = reduceSessionAuthority(initialSessionAuthorityState(),
    tick(0, { s1: { running: true } }), CONFIG).state
  const apply = (observation: SessionAuthorityObservation): readonly SessionAuthorityEffect[] => {
    const result = reduceSessionAuthority(state, observation, CONFIG)
    state = result.state
    return result.effects
  }
  const confirmed = (at: number): SessionAuthorityTicket => {
    const first = startRead(state)
    state = first.state
    const effects = apply({ kind: 'authorityRead', now: at, ticket: first.ticket,
      read: { ok: true, proof: { kind: 'asOfSeq', asOfSeq: 1 }, rows: { s1: false } } })
    const confirm = effects.find((effect): effect is Extract<SessionAuthorityEffect, { kind: 'probe' }> => effect.kind === 'probe')
    assert.ok(confirm)
    const second = apply({ kind: 'authorityRead', now: at + 1, ticket: confirm.ticket,
      read: { ok: true, proof: { kind: 'asOfSeq', asOfSeq: 1 }, rows: { s1: false } } })
    const correct = second.find((effect): effect is Extract<SessionAuthorityEffect, { kind: 'correct' }> => effect.kind === 'correct')
    assert.ok(correct)
    return correct.ticket
  }
  const old = confirmed(10)
  apply({ kind: 'correctionResult', now: 20, ticket: old, ok: false })
  const fresh = confirmed(30)
  assert.notEqual(old.id, fresh.id)
  assert.deepEqual(apply({ kind: 'correctionResult', now: 40, ticket: old, ok: true }), [])
  assert.equal(state.sessions.s1?.correctionTicket, fresh.id)
})

test('positive authority evidence revokes a pending correction ticket', () => {
  let state = reduceSessionAuthority(initialSessionAuthorityState(),
    tick(0, { s1: { running: true } }), CONFIG).state
  const first = startRead(state)
  state = first.state
  const denied = reduceSessionAuthority(state, { kind: 'authorityRead', now: 10, ticket: first.ticket,
    read: { ok: true, proof: { kind: 'asOfSeq', asOfSeq: 1 }, rows: { s1: false } } }, CONFIG)
  state = denied.state
  const confirm = denied.effects.find((effect): effect is Extract<SessionAuthorityEffect, { kind: 'probe' }> => effect.kind === 'probe')
  assert.ok(confirm)
  const confirmed = reduceSessionAuthority(state, { kind: 'authorityRead', now: 20, ticket: confirm.ticket,
    read: { ok: true, proof: { kind: 'asOfSeq', asOfSeq: 1 }, rows: { s1: false } } }, CONFIG)
  state = confirmed.state
  const correct = confirmed.effects.find((effect): effect is Extract<SessionAuthorityEffect, { kind: 'correct' }> => effect.kind === 'correct')
  assert.ok(correct)
  const fresh = startRead(state)
  const allowed = reduceSessionAuthority(fresh.state, { kind: 'authorityRead', now: 30, ticket: fresh.ticket,
    read: { ok: true, proof: { kind: 'asOfSeq', asOfSeq: 1 }, rows: { s1: true } } }, CONFIG)
  const staleWrite = reduceSessionAuthority(allowed.state, {
    kind: 'correctionResult', now: 40, ticket: correct.ticket, ok: true,
  }, CONFIG)
  assert.equal(staleWrite.state.sessions.s1?.correctionTicket, undefined)
  assert.equal(staleWrite.state.sessions.s1?.deniedReads, 0)
  assert.deepEqual(staleWrite.effects, [])
})
