/**
 * Source/session ordering (part 4 of the derive split): orderServersForDisplay,
 * nextServerOrder drop math, nextUpdatedOrder bookkeeping, the ungrouped
 * order and deriveLocalSearchMatches hit selection.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  deriveLocalSearchMatches,
  nextServerOrder,
  nextUpdatedOrder,
  orderServersForDisplay,
  orderUngroupedSessions,
} from '../../src/shared/derive.ts'
import { server, session, snapshot, workspace } from '../support/derive-fixtures.ts'

// ---- orderServersForDisplay / nextServerOrder (design 06 §2.4: stored source display order + the shared drop math) ----

test('orderServersForDisplay with no stored preference returns the projection array unchanged (same reference)', () => {
  const servers = [server('local'), server('ssh-r1'), server('ssh-r2')]
  assert.equal(orderServersForDisplay(servers, undefined), servers)
  assert.equal(orderServersForDisplay(servers, []), servers)
})

test('orderServersForDisplay leads with stored-known ids in stored order and places each id once', () => {
  const servers = [server('local'), server('ssh-r1'), server('ssh-r2')]
  const ordered = orderServersForDisplay(servers, ['ssh-r2', 'local', 'ssh-r2', 'ssh-r1'])
  // The duplicated 'ssh-r2' stored entry is skipped: every server appears once.
  assert.deepEqual(ordered.map(server => server.id), ['ssh-r2', 'local', 'ssh-r1'])
})

test('orderServersForDisplay keeps projection ids not listed in stored after the stored block, in projection order', () => {
  const servers = [server('local'), server('ssh-r1'), server('ssh-r2')]
  // ssh-r1 was never listed: it keeps its projection position at the bottom
  // (a newly added source appears there until the user drags it).
  assert.deepEqual(
    orderServersForDisplay(servers, ['ssh-r2', 'local']).map(server => server.id),
    ['ssh-r2', 'local', 'ssh-r1'],
  )
  assert.deepEqual(
    orderServersForDisplay(servers, ['ssh-r1']).map(server => server.id),
    ['ssh-r1', 'local', 'ssh-r2'],
  )
})

test('orderServersForDisplay skips stored ids unknown to the projection (no ghost groups)', () => {
  const servers = [server('local'), server('ssh-r1')]
  const ordered = orderServersForDisplay(servers, ['ghost-a', 'ssh-r1', 'ghost-b', 'local', 'ghost-c'])
  assert.deepEqual(ordered.map(server => server.id), ['ssh-r1', 'local'])
})

test('nextServerOrder returns null when the target or the dragged source is not in the rendered order', () => {
  const rendered = ['a', 'b', 'c']
  // The target (over.id) is absent from the rendered order.
  assert.equal(nextServerOrder(rendered, 'a', { id: 'ghost', half: 'before' }), null)
  assert.equal(nextServerOrder(rendered, 'a', { id: 'ghost', half: 'after' }), null)
  // The dragged source is absent from the rendered order.
  assert.equal(nextServerOrder(rendered, 'ghost', { id: 'b', half: 'before' }), null)
  assert.equal(nextServerOrder(rendered, 'ghost', { id: 'b', half: 'after' }), null)
  // Both absent: the missing-target check fires first.
  assert.equal(nextServerOrder(rendered, 'ghost', { id: 'ghost-2', half: 'before' }), null)
})

test("nextServerOrder half='before' inserts the dragged source directly before the target row", () => {
  assert.deepEqual(nextServerOrder(['a', 'b', 'c', 'd'], 'd', { id: 'b', half: 'before' }), ['a', 'd', 'b', 'c'])
  assert.deepEqual(nextServerOrder(['a', 'b', 'c'], 'a', { id: 'c', half: 'before' }), ['b', 'a', 'c'])
})

test("nextServerOrder half='after' inserts the dragged source directly after the target (before the next row; appends on the last row)", () => {
  // Dragged below the target: a lands between b and the next row c.
  assert.deepEqual(nextServerOrder(['a', 'b', 'c', 'd'], 'a', { id: 'b', half: 'after' }), ['b', 'a', 'c', 'd'])
  // Dragged upward: c lands directly after a (before b).
  assert.deepEqual(nextServerOrder(['a', 'b', 'c'], 'c', { id: 'a', half: 'after' }), ['a', 'c', 'b'])
  // The target is the last row: nothing follows it, so the source appends at the end.
  assert.deepEqual(nextServerOrder(['a', 'b', 'c'], 'a', { id: 'c', half: 'after' }), ['b', 'c', 'a'])
})

test('nextServerOrder returns null when the drop leaves the rendered order unchanged', () => {
  const rendered = ['a', 'b', 'c']
  // Dropping the dragged row onto itself (both halves).
  assert.equal(nextServerOrder(rendered, 'b', { id: 'b', half: 'before' }), null)
  assert.equal(nextServerOrder(rendered, 'b', { id: 'b', half: 'after' }), null)
  // Dropping onto its own current position: b already sits directly after a,
  // so "b after a" (inserting right after itself) would not move it.
  assert.equal(nextServerOrder(rendered, 'b', { id: 'a', half: 'after' }), null)
  // a already sits directly before b.
  assert.equal(nextServerOrder(rendered, 'a', { id: 'b', half: 'before' }), null)
  // c is already directly after b.
  assert.equal(nextServerOrder(rendered, 'c', { id: 'b', half: 'after' }), null)
  // Appending a row that is already last: half='after' over the last row.
  assert.equal(nextServerOrder(rendered, 'c', { id: 'c', half: 'after' }), null)
})

test('nextServerOrder preserves membership, returns a NEW array, and never mutates the rendered input', () => {
  const rendered = ['a', 'b', 'c', 'd']
  const moved = nextServerOrder(rendered, 'd', { id: 'b', half: 'after' })
  assert.ok(moved)
  assert.deepEqual(moved, ['a', 'b', 'd', 'c'])
  // Exactly the same id set as the input (membership preserved).
  assert.deepEqual([...moved].sort(), [...rendered].sort())
  // A real move mints a new array and leaves the input untouched.
  assert.notEqual(moved, rendered)
  assert.deepEqual(rendered, ['a', 'b', 'c', 'd'])
})

// ---- nextUpdatedOrder (design 06 §3.1, 2026-08: updated = manual + activity promotion) ----

function byIdOf(rows: { id: string; updatedAt?: number }[]): Map<string, { id: string; updatedAt?: number }> {
  return new Map(rows.map(row => [row.id, row]))
}

test('nextUpdatedOrder first observation does a full recency sort and records bookkeeping', () => {
  const sessions = [
    { id: 'a', updatedAt: 100 },
    { id: 'b', updatedAt: 300 },
    { id: 'c', updatedAt: 200 },
  ]
  const first = nextUpdatedOrder({
    sessionIds: ['a', 'b', 'c'],
    stored: undefined,
    previousUpdatedAt: undefined,
    byId: byIdOf(sessions),
  })
  assert.deepEqual(first.order, ['b', 'c', 'a'])
  assert.deepEqual(first.updatedAt, { a: 100, b: 300, c: 200 })
  assert.equal(first.changed, true)
  // A re-run with the recorded bookkeeping and the recorded order changes nothing.
  const second = nextUpdatedOrder({
    sessionIds: ['a', 'b', 'c'],
    stored: first.order,
    previousUpdatedAt: first.updatedAt,
    byId: byIdOf(sessions),
  })
  assert.deepEqual(second.order, ['b', 'c', 'a'])
  assert.equal(second.changed, false)
})

test('nextUpdatedOrder preserves the stored (manual) order until activity promotes', () => {
  const sessions = [
    { id: 'a', updatedAt: 100 },
    { id: 'b', updatedAt: 300 },
    { id: 'c', updatedAt: 200 },
  ]
  const next = nextUpdatedOrder({
    sessionIds: ['a', 'b', 'c'],
    stored: ['c', 'a', 'b'],
    previousUpdatedAt: { a: 100, b: 300, c: 200 },
    byId: byIdOf(sessions),
  })
  // No session updated since the last observation → the stored order stands.
  assert.deepEqual(next.order, ['c', 'a', 'b'])
  assert.equal(next.changed, false)
})

test('nextUpdatedOrder promotes a freshly-updated session to the top and pins it there', () => {
  const sessions = [
    { id: 'a', updatedAt: 100 },
    { id: 'b', updatedAt: 350 }, // b updated since bookkeeping (300)
    { id: 'c', updatedAt: 200 },
  ]
  const promoted = nextUpdatedOrder({
    sessionIds: ['a', 'b', 'c'],
    stored: ['c', 'a', 'b'],
    previousUpdatedAt: { a: 100, b: 300, c: 200 },
    byId: byIdOf(sessions),
  })
  assert.deepEqual(promoted.order, ['b', 'c', 'a'])
  assert.equal(promoted.changed, true)
  // Pinned: with bookkeeping recorded, a later run with unchanged timestamps
  // keeps b at its promoted position instead of falling back to the wire order.
  const pinned = nextUpdatedOrder({
    sessionIds: ['a', 'b', 'c'],
    stored: promoted.order,
    previousUpdatedAt: promoted.updatedAt,
    byId: byIdOf(sessions),
  })
  assert.deepEqual(pinned.order, ['b', 'c', 'a'])
  assert.equal(pinned.changed, false)
  // A newer promotion outranks the earlier one.
  const superseded = nextUpdatedOrder({
    sessionIds: ['a', 'b', 'c'],
    stored: promoted.order,
    previousUpdatedAt: promoted.updatedAt,
    byId: byIdOf([
      { id: 'a', updatedAt: 100 },
      { id: 'b', updatedAt: 350 },
      { id: 'c', updatedAt: 500 },
    ]),
  })
  assert.deepEqual(superseded.order, ['c', 'b', 'a'])
})

test('nextUpdatedOrder promotes sessions never observed before (new members)', () => {
  const next = nextUpdatedOrder({
    sessionIds: ['a', 'd', 'b'],
    stored: ['a', 'b'],
    previousUpdatedAt: { a: 100, b: 300 },
    byId: byIdOf([
      { id: 'a', updatedAt: 100 },
      { id: 'd', updatedAt: 900 },
      { id: 'b', updatedAt: 300 },
    ]),
  })
  // d was never observed → promoted to the top; a/b keep the stored order.
  assert.deepEqual(next.order, ['d', 'a', 'b'])
})

test('nextUpdatedOrder drops sessions that left the wire membership', () => {
  const next = nextUpdatedOrder({
    sessionIds: ['a', 'c'],
    stored: ['b', 'a', 'c'],
    previousUpdatedAt: { a: 100, b: 300, c: 200 },
    byId: byIdOf([
      { id: 'a', updatedAt: 100 },
      { id: 'c', updatedAt: 200 },
    ]),
  })
  assert.deepEqual(next.order, ['a', 'c'])
  assert.equal(next.changed, true)
  // Appends new wire members at the end (reconciledSessionOrder semantics).
  const withNew = nextUpdatedOrder({
    sessionIds: ['a', 'c', 'e'],
    stored: ['a', 'c'],
    previousUpdatedAt: { a: 100, c: 200 },
    byId: byIdOf([
      { id: 'a', updatedAt: 100 },
      { id: 'c', updatedAt: 200 },
      { id: 'e', updatedAt: 1 },
    ]),
  })
  // e is new (never observed) → promoted to the top, not appended.
  assert.deepEqual(withNew.order, ['e', 'a', 'c'])
})

test('nextUpdatedOrder recency sorts by updatedAt descending with the id tiebreak', () => {
  const next = nextUpdatedOrder({
    sessionIds: ['z', 'a', 'm'],
    stored: undefined,
    previousUpdatedAt: undefined,
    byId: byIdOf([
      { id: 'z', updatedAt: 100 },
      { id: 'a', updatedAt: 100 },
      { id: 'm', updatedAt: 100 },
    ]),
  })
  assert.deepEqual(next.order, ['a', 'm', 'z'])
})

test('nextUpdatedOrder treats a missing updatedAt as 0: sorts last, then stays promoted (official edge)', () => {
  const first = nextUpdatedOrder({
    sessionIds: ['known', 'unknown1', 'unknown2'],
    stored: undefined,
    previousUpdatedAt: undefined,
    byId: byIdOf([
      { id: 'known', updatedAt: 5 },
      { id: 'unknown1' },
      { id: 'unknown2' },
    ]),
  })
  // First observation: full recency sort, missing updatedAt sorts as 0.
  assert.deepEqual(first.order, ['known', 'unknown1', 'unknown2'])
  // Sessions without an updatedAt are never recorded in the bookkeeping, so
  // they read as "never observed" and are re-promoted on every run (official
  // behavior) — they settle at the top in id order and stay stable.
  const second = nextUpdatedOrder({
    sessionIds: ['known', 'unknown1', 'unknown2'],
    stored: first.order,
    previousUpdatedAt: first.updatedAt,
    byId: byIdOf([
      { id: 'known', updatedAt: 5 },
      { id: 'unknown1' },
      { id: 'unknown2' },
    ]),
  })
  assert.deepEqual(second.order, ['unknown1', 'unknown2', 'known'])
  const third = nextUpdatedOrder({
    sessionIds: ['known', 'unknown1', 'unknown2'],
    stored: second.order,
    previousUpdatedAt: second.updatedAt,
    byId: byIdOf([
      { id: 'known', updatedAt: 5 },
      { id: 'unknown1' },
      { id: 'unknown2' },
    ]),
  })
  assert.deepEqual(third.order, ['unknown1', 'unknown2', 'known'])
  assert.equal(third.changed, false)
})

test('nextUpdatedOrder re-entry (switched to updated): stored account kept, bookkeeping cleared → one full recency sort, then converges', () => {
  // setOrderBy clears the source's bookkeeping while KEEPING updatedOrder
  // (official switchedToUpdated): the trigger is `previousUpdatedAt ===
  // undefined`, NOT `stored === undefined` — a regression to the latter
  // would silently skip the headline one-time recency sort on re-entry.
  const sessions = [
    { id: 'c', updatedAt: 300 },
    { id: 'a', updatedAt: 100 },
    { id: 'b', updatedAt: 200 },
  ]
  const reentry = nextUpdatedOrder({
    sessionIds: ['a', 'b', 'c'],
    stored: ['c', 'a', 'b'],       // retained manual arrangement
    previousUpdatedAt: undefined,  // bookkeeping cleared on switch-in
    byId: byIdOf(sessions),
  })
  // Full recency sort over the retained account: c(300), b(200), a(100).
  assert.deepEqual(reentry.order, ['c', 'b', 'a'])
  assert.deepEqual(reentry.updatedAt, { a: 100, b: 200, c: 300 })
  assert.equal(reentry.changed, true)
  // Converges: the re-run with the recorded bookkeeping is a no-op.
  const steady = nextUpdatedOrder({
    sessionIds: ['a', 'b', 'c'],
    stored: reentry.order,
    previousUpdatedAt: reentry.updatedAt,
    byId: byIdOf(sessions),
  })
  assert.deepEqual(steady.order, ['c', 'b', 'a'])
  assert.equal(steady.changed, false)
})

test('nextUpdatedOrder a timestamp-only decrease refreshes bookkeeping without reordering', () => {
  // The order never depends on a DECREASED updatedAt (nothing to promote),
  // but the bookkeeping must be refreshed — changed=true so the caller
  // persists the new timestamps (a later increase is then measured from
  // the corrected baseline).
  const sessions = [
    { id: 'a', updatedAt: 100 },
    { id: 'b', updatedAt: 150 }, // decreased from 200 since the last observation
  ]
  const next = nextUpdatedOrder({
    sessionIds: ['a', 'b'],
    stored: ['a', 'b'],
    previousUpdatedAt: { a: 100, b: 200 },
    byId: byIdOf(sessions),
  })
  assert.deepEqual(next.order, ['a', 'b'])
  assert.deepEqual(next.updatedAt, { a: 100, b: 150 })
  assert.equal(next.changed, true)
})

// ---- orderUngroupedSessions (P2-9 extraction, design 06 §3.1, manual mode) ----

test('orderUngroupedSessions uses the stored order with wire-id appends', () => {
  const wire = [
    { id: 'a' },
    { id: 'b' },
    { id: 'c' },
  ]
  const out = orderUngroupedSessions(wire, ['c', 'a'])
  assert.deepEqual(out.map(x => x.id), ['c', 'a', 'b'])
})

test('orderUngroupedSessions skips stored ids unknown to the wire', () => {
  const wire = [
    { id: 'a' },
    { id: 'b' },
  ]
  const out = orderUngroupedSessions(wire, ['ghost', 'b', 'a'])
  assert.deepEqual(out.map(x => x.id), ['b', 'a'])
})

test('orderUngroupedSessions with no stored order returns the wire order copy', () => {
  const wire = [{ id: 'b' }, { id: 'a' }]
  const out = orderUngroupedSessions(wire, undefined)
  assert.deepEqual(out.map(x => x.id), ['b', 'a'])
  assert.notEqual(out, wire)
})

// ---- deriveLocalSearchMatches (design 06 §1.1 local leg) ----

test('deriveLocalSearchMatches hits session titles case-insensitively', () => {
  const result = deriveLocalSearchMatches(
    snapshot(
      [workspace('w1', 'Work', ['a', 'b'])],
      [session('a', 10, { title: 'DeepSeek R1' }), session('b', 20, { title: 'other' })],
    ),
    'deepseek',
  )
  assert.deepEqual(result, [{ sessionId: 'a', snippet: '' }])
})

test('deriveLocalSearchMatches hits workspace titles (a session with no title still matches)', () => {
  const result = deriveLocalSearchMatches(
    snapshot(
      [workspace('w1', 'Alpha Project', ['a']), workspace('w2', 'Other', ['b'])],
      [session('a', 10), session('b', 20, { title: 'Other' })],
    ),
    'alpha',
  )
  // Session a has NO title (missing titles never hit on title), but its
  // workspace title hit still counts; b sits in a non-matching workspace.
  assert.deepEqual(result, [{ sessionId: 'a', snippet: '' }])
})

test('deriveLocalSearchMatches matches either leg independently', () => {
  const result = deriveLocalSearchMatches(
    snapshot(
      [workspace('w1', 'Work', ['a']), workspace('w2', 'Docs', ['b'])],
      [session('a', 10, { title: 'Notes' }), session('b', 20, { title: 'no-match' })],
    ),
    'docs',
  )
  assert.deepEqual(result, [{ sessionId: 'b', snippet: '' }])
})

test('deriveLocalSearchMatches excludes blank, archived and subagent sessions', () => {
  const result = deriveLocalSearchMatches(
    {
      workspaces: [workspace('w1', 'Match', ['hit', 'blank-hit', 'archived-hit', 'sub-hit'])],
      sessions: [
        session('hit', 10, { title: 'match me' }),
        session('blank-hit', 20, { title: 'match me', blank: true }),
        session('archived-hit', 30, { title: 'match me' }),
        session('sub-hit', 40, { title: 'match me', origin: 'subagent' }),
      ],
      archivedSessionIds: ['archived-hit'],
    },
    'match',
  )
  assert.deepEqual(result, [{ sessionId: 'hit', snippet: '' }])
})

test('deriveLocalSearchMatches orders hits by recency with the id tiebreak', () => {
  const result = deriveLocalSearchMatches(
    snapshot(
      [workspace('w1', 'Work', ['a', 'b', 'c'])],
      [
        session('a', 100, { title: 'hit' }),
        session('b', 300, { title: 'hit' }),
        session('c', 300, { title: 'hit' }),
      ],
    ),
    'hit',
  )
  assert.deepEqual(result.map(row => row.sessionId), ['b', 'c', 'a'])
})

test('deriveLocalSearchMatches returns [] for an empty query (defensive trim)', () => {
  const result = deriveLocalSearchMatches(
    snapshot([workspace('w1', 'Work', ['a'])], [session('a', 1, { title: 'hit' })]),
    '   ',
  )
  assert.deepEqual(result, [])
})

test('deriveLocalSearchMatches returns [] when nothing matches', () => {
  const result = deriveLocalSearchMatches(
    snapshot([workspace('w1', 'Work', ['a'])], [session('a', 1, { title: 'hit' })]),
    'zzz',
  )
  assert.deepEqual(result, [])
})

