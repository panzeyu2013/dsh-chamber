/**
 * Archive cleanup core — subset purges and the registry-global orphan sweep.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ArchiveCleanupCore,
  orphanArchivedMembers,
  MAX_PURGE_SESSIONS,
  MAX_PURGE_ERROR_RECORDS,
  type ArchivedSessionState,
} from '../src/core.ts'
import {
  state,
  subagent,
  FakeHost,
  buildHost,
  codeIs,
} from './support/archive-host.ts'

test('purge subset: a single selected root deletes only its deletable tree; the registry-global orphan sweep still clears record-less members outside the selection', async () => {
  const host = buildHost()
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge(['s2'])
  assert.equal(result.errors.length, 0)
  assert.equal(result.deletedSessions, 1)
  assert.equal(result.deletedSubagents, 0)
  assert.equal(result.skippedRunning, 0)
  assert.deepEqual(host.deleteLog, ['s2'])
  assert.equal(host.archived.has('s1'), true, 'a record-bearing member outside the subset is untouched')
  assert.equal(host.archived.has('s3'), true)
  // Design 24 §4 step 5: the record-less member is cleared even though
  // the filter never named it, and it never inflates the content counts.
  assert.equal(host.archived.has('s-orphan'), false)
  assert.equal(result.clearedOrphanMembers, 1)
  assert.deepEqual(host.removalCalls, [['s2', 's-orphan']])
})

test('purge subset: selecting an archived root cascades its subagent lineage children-first', async () => {
  const host = buildHost()
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge(['s1'])
  assert.equal(result.errors.length, 0)
  assert.equal(result.deletedSessions, 1)
  assert.equal(result.deletedSubagents, 2)
  // Children-first: descendants before the root.
  assert.equal(host.deleteLog.indexOf('s1'), host.deleteLog.length - 1)
  assert.deepEqual([...host.deleteLog].sort(), ['a1', 'a1a', 's1'])
  assert.equal(host.archived.has('s1'), false)
  assert.equal(host.archived.has('s2'), true)
})

test('purge subset: a stale/non-archived id is no candidate — nothing deleted, never an error; the orphan sweep still converges', async () => {
  const host = buildHost()
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge(['s4', 'never-archived'])
  assert.equal(result.errors.length, 0)
  assert.equal(result.deletedSessions, 0)
  assert.equal(result.deletedSubagents, 0)
  assert.equal(host.deleteLog.length, 0)
  // No content candidates — but the registry-global orphan sweep is
  // orthogonal to the filter (design 24 §4 step 5): the record-less set
  // member is cleared in the same single write.
  assert.deepEqual(host.removalCalls, [['s-orphan']])
  assert.equal(result.clearedOrphanMembers, 1)
  // The filter can never reach the non-archived live sibling.
  assert.equal(host.states.has('s4'), true)
  // Unrelated archived members stay untouched.
  assert.equal(host.archived.has('s1'), true)
  assert.equal(host.archived.has('s2'), true)
})

test('purge subset: running subtrees in the selection are skipped whole and stay archived', async () => {
  const host = buildHost()
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge(['s3'])
  assert.equal(result.errors.length, 0)
  assert.equal(result.deletedSessions, 0)
  assert.equal(result.skippedRunning, 1)
  assert.equal(host.deleteLog.length, 0)
  assert.equal(host.archived.has('s3'), true)
  assert.equal(host.states.has('b1'), true, 'running child untouched')
})

test('purge subset: mixed selection deletes the deletable roots and skips the running one in one run', async () => {
  const host = buildHost()
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge(['s1', 's3'])
  assert.equal(result.errors.length, 0)
  assert.equal(result.deletedSessions, 1)
  assert.equal(result.deletedSubagents, 2)
  assert.equal(result.skippedRunning, 1)
  assert.equal(host.archived.has('s1'), false)
  assert.equal(host.archived.has('s3'), true)
  assert.deepEqual(host.removalCalls, [['s1', 's-orphan']])
})

test('purge subset: an orphan member selected in the filter is cleared with the same batched write', async () => {
  const host = buildHost()
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge(['s1', 's-orphan'])
  assert.equal(result.errors.length, 0)
  assert.equal(result.deletedSessions, 1)
  assert.equal(result.clearedOrphanMembers, 1)
  assert.deepEqual(host.removalCalls, [['s1', 's-orphan']])
  assert.equal(host.archived.has('s2'), true, 'unselected member untouched')
})

test('purge subset: malformed filters refuse loudly before any mutation', async () => {
  const host = buildHost()
  const core = new ArchiveCleanupCore(host)
  await assert.rejects(() => core.purge(['s1', 42 as never]), codeIs('invalid-request'))
  await assert.rejects(() => core.purge(['']), codeIs('invalid-request'))
  const oversized: string[] = []
  for (let i = 0; i < MAX_PURGE_SESSIONS + 1; i += 1) oversized.push(`bulk-${i}`)
  await assert.rejects(() => core.purge(oversized), codeIs('invalid-request'))
  assert.equal(host.deleteLog.length, 0)
  assert.equal(host.removalCalls.length, 0)
})

test('purge subset: an empty selection deletes NO content but still converges the registry-global orphan backlog', async () => {
  // The empty filter is a deliberate delete-nothing CONTENT subset; the
  // registry-global orphan sweep is orthogonal to it (design 24 §4 step 5),
  // so the run still reads the corpus and clears record-less
  // set members in one write — no content is ever touched.
  const host = buildHost()
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge([])
  assert.equal(result.errors.length, 0)
  assert.equal(result.deletedSessions, 0)
  assert.equal(result.deletedSubagents, 0)
  assert.equal(result.skippedRunning, 0)
  assert.equal(result.clearedOrphanMembers, 1)
  assert.equal(host.deleteLog.length, 0, 'no content deletion')
  assert.deepEqual(host.removalCalls, [['s-orphan']])
  assert.equal(host.archived.has('s1'), true, 'record-bearing members untouched')
  assert.equal(host.archived.has('s2'), true)
  assert.equal(host.archived.has('s3'), true)
  assert.equal(host.archived.has('s-orphan'), false)
  // Idempotent: a second empty run has nothing left to clear and no error.
  const again = await core.purge([])
  assert.equal(again.errors.length, 0)
  assert.equal(again.clearedOrphanMembers, undefined)
  assert.equal(host.removalCalls.length, 1)
})

test('capacity guard: an oversized archived set still allows bounded subset purges', async () => {
  const host = new FakeHost()
  for (let i = 0; i < MAX_PURGE_SESSIONS + 1; i += 1) {
    host.archived.add(`bulk-${i}`)
    host.states.set(`bulk-${i}`, state(`bulk-${i}`))
  }
  const core = new ArchiveCleanupCore(host)
  // The full-set purge refuses (purge-capacity)…
  await assert.rejects(() => core.purge(), codeIs('purge-capacity'))
  // …but a bounded subset of the same oversized set still runs.
  const result = await core.purge(['bulk-0', 'bulk-1'])
  assert.equal(result.errors.length, 0)
  assert.equal(result.deletedSessions, 2)
  assert.equal(host.archived.has('bulk-0'), false)
  assert.equal(host.archived.has('bulk-2'), true)
})

test('purge subset: an archived descendant selected WITH its archived ancestor is covered by the ancestor tree', async () => {
  // Fixture: archived set contains BOTH s1 (top-level) and its subagent
  // descendant a1 (archived member). Candidates resolve in archived-set
  // order: s1 first → its tree covers a1 (no double deletion), and a1 — an
  // archived member covered by a completed tree — is cleared from the set
  // in the SAME batched write (merge-round Nit N1 semantics under a subset
  // run). Counts: one tree root (s1) + two subagent members (a1, a1a).
  const host = buildHost()
  host.archived.add('a1')
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge(['s1', 'a1'])
  assert.equal(result.errors.length, 0)
  assert.equal(result.deletedSessions, 1, 'one tree root — the a1 row is covered by its ancestor tree')
  assert.equal(result.deletedSubagents, 2, 'a1 + a1a deleted children-first')
  assert.deepEqual(host.deleteLog, ['a1a', 'a1', 's1'])
  // Set removal: root + covered archived descendant + the swept orphan, one
  // write, deduped.
  assert.equal(host.removalCalls.length, 1)
  assert.deepEqual(new Set(host.removalCalls[0]), new Set(['s1', 'a1', 's-orphan']))
  assert.equal(host.archived.has('a1'), false)
  assert.equal(host.archived.has('s1'), false)
  assert.equal(host.archived.has('s2'), true)
})

test('purge subset: an archived subagent-origin row selected without its ancestor deletes only its own subtree', async () => {
  // Wire-reachable edge (the UI never selects hidden subagent rows): s1 is
  // NOT selected and stays archived; a1 (archived subagent child of s1) is
  // selected alone → only a1's own subtree (a1 + a1a) is deleted; the
  // ancestor s1 record lives in its own directory and is untouched.
  const host = buildHost()
  host.archived.add('a1')
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge(['a1'])
  assert.equal(result.errors.length, 0)
  assert.equal(result.deletedSessions, 1, 'the archived subagent row is its own tree root')
  assert.equal(result.deletedSubagents, 1)
  assert.deepEqual(new Set(host.deleteLog), new Set(['a1', 'a1a']))
  assert.equal(host.archived.has('a1'), false)
  assert.equal(host.archived.has('s1'), true, 'ancestor content and membership untouched')
  assert.equal(host.states.has('s1'), true)
})

test('purge subset: the first in-tree failure still aborts the REMAINING members of that tree only', async () => {
  // F1 semantics under a subset run: deleting s2's tree fails at delete
  // time (storage) → s2 (its root) survives archived; the OTHER selected
  // tree (s1) completes; a rerun converges the remainder.
  const host = buildHost()
  host.failDeletes.set('s2', { code: 'storage', remaining: 1 })
  const core = new ArchiveCleanupCore(host)
  const first = await core.purge(['s1', 's2'])
  assert.equal(first.deletedSessions, 1)
  assert.equal(first.errors.length, 1)
  assert.equal(first.errors[0]?.sessionId, 's2')
  assert.equal(first.errors[0]?.code, 'storage')
  assert.equal(host.archived.has('s1'), false)
  assert.equal(host.archived.has('s2'), true, 'failed root stays archived')
  assert.equal(host.removalCalls.length, 1)
  assert.deepEqual(host.removalCalls[0], ['s1', 's-orphan'])
  // Rerun converges the aborted remainder.
  const second = await core.purge(['s2'])
  assert.equal(second.errors.length, 0)
  assert.equal(second.deletedSessions, 1)
  assert.equal(host.archived.has('s2'), false)
})

test('purge subset: duplicate filter ids delete once and keep counts honest', async () => {
  const host = buildHost()
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge(['s2', 's2', 's2'])
  assert.equal(result.errors.length, 0)
  assert.equal(result.deletedSessions, 1)
  assert.equal(host.deleteLog.length, 1)
  assert.deepEqual(host.removalCalls, [['s2', 's-orphan']])
})

test('purge subset: a malformed filter refuses BEFORE any authoritative read (validation-first)', async () => {
  const host = buildHost()
  const core = new ArchiveCleanupCore(host)
  await assert.rejects(() => core.purge([42 as never]), codeIs('invalid-request'))
  assert.equal(host.stateReadAttempts, 0, 'no corpus read for a malformed request')
  assert.equal(host.removalCalls.length, 0)
})

test('purge subset: an empty selection reads the corpus for the sweep but deletes no content and skips no tree', async () => {
  const host = buildHost()
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge([])
  assert.equal(result.errors.length, 0)
  assert.equal(result.deletedSessions, 0)
  assert.equal(result.skippedRunning, 0)
  assert.equal(host.stateListCalls, 1 + 1, 'snapshot scan + the sweep confirmation (s-orphan exists)')
  assert.equal(host.deleteLog.length, 0)
  assert.deepEqual(host.removalCalls, [['s-orphan']])
})

/* ------------------------------------------------------------------ */
/* Registry-global orphan sweep (design 24 §4 step 5).            */
/* ------------------------------------------------------------------ */

test('orphanArchivedMembers: record-less members only; a live record-less id is excluded (fail-closed predicate)', () => {
  const states = new Map<string, ArchivedSessionState>([
    ['with-record', state('with-record')],
    ['sub', subagent('sub', 'with-record')],
  ])
  assert.deepEqual(
    orphanArchivedMembers(['with-record', 'ghost-1', 'sub', 'ghost-2'], states, new Set()),
    ['ghost-1', 'ghost-2'],
  )
  // A record-less id that is live/open is NEVER swept (defense in depth: its
  // content is real even if the durable enumeration momentarily misses it).
  assert.deepEqual(orphanArchivedMembers(['ghost-1', 'ghost-2'], states, new Set(['ghost-1'])), ['ghost-2'])
  assert.deepEqual(orphanArchivedMembers([], states, new Set()), [])
})

test('purge: the registry-global sweep clears record-less members OUTSIDE the candidate subset without touching content', async () => {
  const host = buildHost()
  // A second historical no-directory member, never named by any filter.
  host.archived.add('s-orphan-2')
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge(['s1'])
  assert.equal(result.errors.length, 0)
  assert.equal(result.deletedSessions, 1)
  assert.equal(result.deletedSubagents, 2)
  // Content: ONLY s1's tree — the orphans were never deletion candidates.
  assert.deepEqual(host.deleteLog, ['a1a', 'a1', 's1'])
  assert.equal(host.deleteLog.includes('s-orphan'), false)
  assert.equal(host.deleteLog.includes('s-orphan-2'), false)
  // Membership: both record-less members ride the SAME single write as the
  // completed tree root; the record-bearing members outside the subset stay.
  assert.equal(host.removalCalls.length, 1)
  assert.deepEqual(host.removalCalls[0], ['s1', 's-orphan', 's-orphan-2'])
  assert.equal(result.clearedOrphanMembers, 2)
  assert.equal(host.archived.has('s1'), false)
  assert.equal(host.archived.has('s-orphan'), false)
  assert.equal(host.archived.has('s-orphan-2'), false)
  assert.equal(host.archived.has('s2'), true, 'record-bearing member outside the subset untouched')
  assert.equal(host.archived.has('s3'), true)
  assert.equal(host.states.has('s2'), true)
  assert.equal(host.states.has('s4'), true)
  // The swept count never inflates the content counts.
  assert.equal(result.deletedSessions, 1)
  assert.equal(result.deletedSubagents, 2)
})

test('purge: a member with a session record is NEVER swept — including one skipped as running and one outside the subset', async () => {
  const host = buildHost()
  const core = new ArchiveCleanupCore(host)
  // Full-set run: s3's subtree is running-skipped; s1/s2 delete.
  const full = await core.purge()
  assert.equal(full.skippedRunning, 1)
  assert.equal(full.clearedOrphanMembers, 1)
  assert.equal(host.archived.has('s3'), true, 'running-skipped member keeps its record AND its membership')
  assert.equal(host.states.has('s3'), true)
  assert.equal(host.states.has('b1'), true)
  assert.deepEqual(host.removalCalls[0], ['s1', 's2', 's-orphan'])
  // Subset run: an idle record-bearing member outside the subset is likewise
  // never swept (only record-less ids are).
  const host2 = buildHost()
  const core2 = new ArchiveCleanupCore(host2)
  await core2.purge(['s1'])
  assert.equal(host2.archived.has('s2'), true)
  assert.equal(host2.states.has('s2'), true)
  assert.equal(host2.archived.has('s3'), true)
})

test('purge: a failed sweep confirmation read SKIPS the sweep, records archive-set, and still commits the completed deletions', async () => {
  const host = buildHost()
  // Attempt 1 = the run snapshot (succeeds); attempt 2 = the sweep
  // confirmation read (fails) — the fail-closed leg.
  host.failStateReadOnAttempt = 2
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge()
  assert.equal(result.deletedSessions, 2, 'completed content deletions are reported')
  assert.equal(result.deletedSubagents, 2)
  assert.equal(result.clearedOrphanMembers, undefined, 'nothing was swept — never guessed')
  assert.equal(result.errors.length, 1)
  assert.equal(result.errors[0]?.sessionId, '')
  assert.equal(result.errors[0]?.code, 'archive-set')
  assert.equal(result.errors[0]?.message.includes('orphan sweep skipped'), true)
  // The completed trees still ride the single write; the record-less member
  // stays archived for a later run.
  assert.deepEqual(host.removalCalls, [['s1', 's2']])
  assert.equal(host.archived.has('s-orphan'), true)
  assert.equal(host.archived.has('s1'), false)
  assert.equal(host.archived.has('s2'), false)
  // A later run (enumeration healthy again) converges the orphan.
  host.failStateReadOnAttempt = null
  const again = await core.purge()
  assert.equal(again.errors.length, 0)
  assert.equal(again.clearedOrphanMembers, 1)
  assert.equal(host.archived.has('s-orphan'), false)
})

test('purge: the orphan sweep is idempotent — a second run is a no-op with no error and no extra set write', async () => {
  const host = buildHost()
  const core = new ArchiveCleanupCore(host)
  const first = await core.purge()
  assert.equal(first.clearedOrphanMembers, 1)
  const second = await core.purge()
  assert.equal(second.errors.length, 0)
  assert.equal(second.deletedSessions, 0)
  assert.equal(second.clearedOrphanMembers, undefined)
  assert.equal(host.removalCalls.length, 1, 'no second write')
  assert.deepEqual([...host.archived], ['s3'])
})

test('purge: swept orphans ride the SAME deduped single write as completed trees and covered descendants', async () => {
  const host = buildHost()
  // a1 is BOTH an archived member and a descendant covered by s1's tree.
  host.archived.add('a1')
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge()
  assert.equal(result.errors.length, 0)
  assert.equal(host.removalCalls.length, 1, 'ONE official set write')
  const call = host.removalCalls[0] as string[]
  assert.equal(new Set(call).size, call.length, 'clearIds is deduped')
  assert.deepEqual(new Set(call), new Set(['s1', 's2', 'a1', 's-orphan']))
  assert.equal(result.clearedOrphanMembers, 1, 'only the record-less member counts as swept')
  assert.deepEqual(host.archived, new Set(['s3']))
})

test('purge: an archived set beyond the defensive capacity skips the orphan sweep while bounded subset purges still run', async () => {
  const host = new FakeHost()
  for (let i = 0; i < MAX_PURGE_SESSIONS + 1; i += 1) {
    host.archived.add(`bulk-${i}`)
    host.states.set(`bulk-${i}`, state(`bulk-${i}`))
  }
  // A historical no-directory member inside the oversized set.
  host.archived.add('bulk-ghost')
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge(['bulk-0'])
  assert.equal(result.errors.length, 0)
  assert.equal(result.deletedSessions, 1)
  assert.equal(result.clearedOrphanMembers, undefined, 'capacity bounds the sweep — nothing swept')
  assert.deepEqual(host.removalCalls, [['bulk-0']])
  assert.equal(host.archived.has('bulk-ghost'), true)
  assert.equal(host.stateListCalls, 1, 'no confirmation scan when the sweep is out of capacity')
})

test('purge: a record-less member that is live is never swept (defense in depth)', async () => {
  const host = buildHost()
  host.live.add('s-orphan')
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge()
  assert.equal(result.errors.length, 0)
  assert.equal(result.clearedOrphanMembers, undefined)
  assert.deepEqual(host.removalCalls, [['s1', 's2']])
  assert.equal(host.archived.has('s-orphan'), true, 'a live id keeps its membership')
})

test('purge: a sweep-skip record shares the item error cap — truncated stays honest and completed deletions are unaffected', async () => {
  const host = new FakeHost()
  for (let i = 0; i < MAX_PURGE_ERROR_RECORDS; i += 1) {
    const id = `fail-${i}`
    host.archived.add(id)
    host.states.set(id, state(id))
    host.failDeletes.set(id, { code: 'storage', remaining: 1 })
  }
  host.archived.add('ghost') // record-less member → the sweep runs
  host.failStateReadOnAttempt = 2 // …and its confirmation read fails
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge()
  assert.equal(result.errors.length, MAX_PURGE_ERROR_RECORDS)
  assert.equal(result.truncated, true, 'the dropped sweep-skip record still sets the honest truncation flag')
  assert.equal(result.errors.every(error => error.code === 'storage'), true)
  assert.equal(result.deletedSessions, 0)
  assert.equal(result.clearedOrphanMembers, undefined)
  assert.equal(host.removalCalls.length, 0, 'nothing completed and the sweep was skipped → no write')
  assert.equal(host.archived.has('ghost'), true)
  assert.equal(host.archived.size, MAX_PURGE_ERROR_RECORDS + 1)
})

test('purge: a failed single set write keeps the swept orphans archived too (honest zero, rerun converges)', async () => {
  const host = buildHost()
  host.removalFailureRemaining = 1
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge()
  assert.equal(result.deletedSessions, 2, 'content deletions stand')
  assert.equal(result.clearedOrphanMembers, undefined, 'the failed write swept nothing')
  assert.equal(result.errors.length, 1)
  assert.equal(result.errors[0]?.code, 'archive-set')
  assert.equal(host.archived.has('s-orphan'), true)
  const again = await core.purge()
  assert.equal(again.errors.length, 0)
  assert.equal(again.deletedSessions, 0, 'content was already gone')
  // Convergence: the two completed-but-unwritten roots now have no record
  // either, so they are swept as orphans together with the historical member.
  assert.equal(again.clearedOrphanMembers, 3)
  assert.equal(host.archived.has('s-orphan'), false)
  assert.equal(host.archived.has('s1'), false)
  assert.equal(host.archived.has('s2'), false)
})

