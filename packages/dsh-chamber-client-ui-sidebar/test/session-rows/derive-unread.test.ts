/**
 * deriveUnread — THE unread predicate of the B edge track (plan §3.2/§5-3,
 * W0 notes §2.3/H3b): `unread ⟺ max(updatedAt, completedAt) > readThrough`,
 * where `completedAt` counts when the last turn-end classification is
 * `completed` OR ABSENT (the watcher's degraded marker for an unreadable tail,
 * R12: an edge that already armed `completedAt` must never be dropped here).
 * node:test, pure (no ledger state, no clock).
 *
 * Pinned here: the strict `>` boundary, the completed-or-degraded gate (every
 * KNOWN non-completion — aborted incl. cause user, blocked, error, max-tokens,
 * interrupted — suppresses; only a missing classification arms), updatedAt
 * coverage for user content, and the "no ledger, no wall clock" signature
 * (length 4).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveUnread, type TurnEndFact } from '../../src/shared/derive.ts'

const COMPLETED: TurnEndFact = { kind: 'completed' }

test('a completed edge above the read watermark is unread; at the watermark it is read', () => {
  assert.equal(deriveUnread(2_000, COMPLETED, 1_000, undefined), true)
  // Strictly greater: reaching the watermark is read (the same watermark never re-arms).
  assert.equal(deriveUnread(2_000, COMPLETED, 2_000, undefined), false)
  assert.equal(deriveUnread(2_000, COMPLETED, 2_001, undefined), false)
})

test('completedAt counts for a completed classification and for the degraded (absent) marker', () => {
  const classifications: [string, TurnEndFact | undefined | null][] = [
    ['completed', COMPLETED],
    ['aborted (user stop)', { kind: 'aborted', cause: 'user' }],
    ['aborted (parent)', { kind: 'aborted', cause: 'parent' }],
    ['aborted without cause', { kind: 'aborted' }],
    ['blocked', { kind: 'blocked' }],
    ['error', { kind: 'error' }],
    ['max-tokens', { kind: 'max-tokens' }],
    ['interrupted', { kind: 'interrupted' }],
    ['missing classification (degraded)', undefined],
    ['null classification (degraded watcher marker)', null],
  ]
  for (const [label, turnEnd] of classifications) {
    // Only completed — or the degraded absence — may arm from completedAt; a
    // KNOWN non-completion suppresses (R12).
    const arms = label === 'completed' || label.startsWith('missing') || label.startsWith('null')
    assert.equal(deriveUnread(2_000, turnEnd, 1_000, undefined), arms, label)
  }
})

test('a degraded arm still respects the read watermark (no permanent unread)', () => {
  // The degraded marker must not resurrect the pre-read dot after the reader
  // caught up: the same strict > boundary applies.
  assert.equal(deriveUnread(2_000, undefined, 2_000, undefined), false)
  assert.equal(deriveUnread(2_000, null, 2_500, undefined), false)
  // And it may not invent unread with nothing armed.
  assert.equal(deriveUnread(undefined, undefined, 1_000, undefined), false)
})

test('the updatedAt content watermark arms regardless of how the turn ended', () => {
  // A user prompt that advanced updatedAt is unread even when the turn was stopped.
  assert.equal(deriveUnread(undefined, { kind: 'aborted', cause: 'user' }, 1_000, 2_000), true)
  assert.equal(deriveUnread(undefined, undefined, 1_000, 2_000), true)
  // …while a neutral classification never adds the completedAt on top of it.
  assert.equal(deriveUnread(3_000, { kind: 'error' }, 2_000, 1_000), false)
})

test('unread uses max(updatedAt, completedAt): either watermark above readThrough wins', () => {
  // updatedAt below the watermark, completion above it.
  assert.equal(deriveUnread(2_000, COMPLETED, 1_500, 1_000), true)
  // completion below the watermark, updatedAt above it.
  assert.equal(deriveUnread(1_000, COMPLETED, 1_500, 2_000), true)
  // both at/below the watermark.
  assert.equal(deriveUnread(1_000, COMPLETED, 1_500, 1_200), false)
  // equality on either leg is read.
  assert.equal(deriveUnread(1_500, COMPLETED, 1_500, 1_200), false)
  assert.equal(deriveUnread(1_000, COMPLETED, 1_500, 1_500), false)
})

test('absent readThrough = nothing read yet; absent/zero watermarks = no unread', () => {
  assert.equal(deriveUnread(2_000, COMPLETED, undefined, undefined), true)
  assert.equal(deriveUnread(undefined, undefined, undefined, 2_000), true)
  // Nothing known on the content side: no unread may be invented.
  assert.equal(deriveUnread(undefined, undefined, undefined, undefined), false)
  assert.equal(deriveUnread(0, COMPLETED, undefined, undefined), false)
  assert.equal(deriveUnread(undefined, undefined, 0, 0), false)
})

test('the predicate is host-domain only: no ledger input and no wall clock in the signature', () => {
  // R2 anti-cheat: deriveUnread must not read any ledger state
  // (completedBySource). The arity lock keeps a future "let me pass the ledger
  // in" refactor visible in review.
  assert.equal(deriveUnread.length, 4)
  // The comparison is entirely driven by the injected host-domain integers: a
  // desktop wall clock far ahead of the host watermark changes nothing because
  // it is never an input.
  assert.equal(deriveUnread(5_000, COMPLETED, 4_000, 3_000), true)
  assert.equal(deriveUnread(5_000, COMPLETED, 6_000, 3_000), false)
})
