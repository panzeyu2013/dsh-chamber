/**
 * Archive cleanup core — preview/purge planning, retention, force, the event
 * contract, and the folded-in subset/orphan-sweep fail-closed legs (the deleted
 * subset-and-orphan-sweep.test.ts). Sibling: sweep-gates-and-protection.
 * Shared fixtures: support/archive-host.ts.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ArchiveCleanupCore,
  ArchiveCleanupError,
  indexChildren,
  subtreeLiveness,
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

test('preview: counts deletable trees, subagents, running subtrees and orphans', async () => {
  const core = new ArchiveCleanupCore(buildHost())
  const preview = await core.preview()
  assert.equal(preview.archived, 4)
  assert.equal(preview.deletableSessions, 2) // s1 + s2; s3 skipped (running child), s-orphan has no record
  assert.equal(preview.deletableSubagents, 2) // a1 + a1a
  assert.equal(preview.skippedRunning, 1)
  assert.equal(preview.skippedLoaded, 0)
})

test('preview: loaded-only subtrees are reported separately from running ones', async () => {
  const host = buildHost()
  host.loaded.add('s2')
  const preview = await new ArchiveCleanupCore(host).preview()
  assert.equal(preview.skippedRunning, 1) // s3 (running child)
  assert.equal(preview.skippedLoaded, 1) // s2 (attached but idle)
  assert.equal(preview.deletableSessions, 1) // s1 only under the default guard
})

test('indexChildren: uninterrupted subagent-origin children only', () => {
  const host = buildHost()
  const children = indexChildren([...host.states.values()])
  assert.deepEqual([...children.get('s1') ?? []].sort(), ['a1'])
  assert.deepEqual([...children.get('a1') ?? []], ['a1a'])
  assert.deepEqual([...children.get('s3') ?? []], ['b1'])
  assert.equal(children.has('s2'), false)
})

test('subtreeLiveness: running beats loaded beats clear (force gating lives in purge)', () => {
  const host = buildHost()
  const states = new Map([...host.states.entries()])
  const children = indexChildren([...states.values()])
  const facts = { running: host.live, loaded: host.loaded }

  assert.equal(subtreeLiveness('s1', children, facts), 'clear')
  host.loaded.add('a1a')
  assert.equal(subtreeLiveness('s1', children, facts), 'loaded')
  // A RUNNING member wins.
  host.live.add('a1a')
  assert.equal(subtreeLiveness('s1', children, facts), 'running')
})

test('purge: loaded-only subtrees are skipped by default and deleted under force', async () => {
  const host = buildHost()
  // s2 is attached-but-idle (loaded); s3 keeps its running child b1.
  host.loaded.add('s2')
  const core = new ArchiveCleanupCore(host)

  const skipped = await core.purge()
  assert.equal(skipped.deletedSessions, 1) // s1 only
  assert.equal(skipped.skippedRunning, 1) // s3
  assert.equal(skipped.skippedLoaded, 1) // s2
  assert.equal(skipped.forcedLoaded, 0)
  assert.equal(host.states.has('s2'), true)
  assert.deepEqual(host.archived, new Set(['s2', 's3']))

  // The default run left s2 archived; force (caller already cancelled the
  // run) deletes its CONTENT — the running subtree s3 is STILL refused.
  const forced = await core.purge(['s2', 's3'], true)
  assert.equal(forced.deletedSessions, 1) // s2
  assert.equal(forced.forcedLoaded, 1)
  assert.equal(forced.skippedRunning, 1) // s3's b1 is running — force must not bypass
  assert.equal(host.states.has('s2'), false)
  assert.equal(host.states.has('s3'), true)
  assert.equal(host.states.has('b1'), true)
  // RESIDENT RETENTION (design 24 §4 step 9, 2026-13): s2 is still attached
  // to this process, so its membership — the ONLY thing hiding its row from
  // the live-preferred session list — is KEPT instead of un-hiding a session
  // the user just deleted.
  assert.deepEqual(forced.residentRetainedRoots, ['s2'])
  assert.deepEqual(host.archived, new Set(['s2', 's3']))
  assert.equal(host.removedFromArchived.includes('s2'), false)
})

test('purge: a resident root whose content is already gone re-affirms retention on the rerun', async () => {
  const host = buildHost()
  host.loaded.add('s2')
  const core = new ArchiveCleanupCore(host)

  const first = await core.purge(['s2'], true)
  assert.equal(first.deletedSessions, 1)
  assert.equal(first.forcedLoaded, 1)
  assert.deepEqual(first.residentRetainedRoots, ['s2'])

  // Second run: the content is gone but the session is STILL ATTACHED, and the
  // real record corpus is a union whose live leg keeps serving its header — so
  // the id is NOT record-less: the plan builds the tree again, this run's
  // deletion reports 'missing', and the membership is retained (and reported)
  // again. Only after the instance restarts does the id become record-less and
  // get converged by the orphan sweep (2026-13 review: the earlier assertion
  // here claimed the rerun planned no tree and reported nothing, which no real
  // host does).
  const again = await core.purge(['s2'], true)
  assert.equal(again.deletedSessions, 0)
  assert.equal(again.forcedLoaded, 0)
  assert.deepEqual(again.errors, [])
  assert.deepEqual(again.residentRetainedRoots, ['s2'], 'retention is re-affirmed, not silently dropped')
  assert.equal(host.archived.has('s2'), true)
  assert.equal(host.removedFromArchived.includes('s2'), false)
  assert.equal(host.states.has('s2'), false, 'the durable record is gone; only the live leg serves it')
})

test('purge: a tree retained for residency keeps its covered archived descendants too (no partial membership)', async () => {
  const host = buildHost()
  // s1's subagent descendant a1 is itself an archived member (design 24 §4
  // step 9 N1 case) and the root is resident.
  host.archived.add('a1')
  host.loaded.add('s1')
  const core = new ArchiveCleanupCore(host)

  const result = await core.purge(['s1'], true)
  assert.equal(result.deletedSessions, 1)
  assert.equal(result.deletedSubagents, 2) // a1 + a1a
  assert.deepEqual(result.residentRetainedRoots, ['s1'])
  // The retained tree contributes NOTHING to the batched membership removal:
  // neither the root nor its covered archived descendant is cleared.
  assert.equal(host.removedFromArchived.includes('s1'), false)
  assert.equal(host.removedFromArchived.includes('a1'), false)
  assert.equal(host.archived.has('s1'), true)
  assert.equal(host.archived.has('a1'), true)
})

test('purge: a root that becomes resident AFTER the tree recheck is still retained (mid-run attach race)', async () => {
  const host = buildHost()
  // Plan-time snapshot says s2 is clear; another client attaches it while the
  // run is deleting, so the binding reports `resident` at the deletion
  // instant. Clearing the membership there would re-surface the row.
  host.attachOnDeleteOf = 's2'
  const core = new ArchiveCleanupCore(host)

  const result = await core.purge(['s2'], true)
  assert.equal(result.deletedSessions, 1)
  assert.equal(host.loaded.has('s2'), true, 'the attach hook fired at deletion time')
  assert.deepEqual(result.residentRetainedRoots, ['s2'])
  assert.equal(host.archived.has('s2'), true)
  assert.equal(host.removedFromArchived.includes('s2'), false)
  // Force accounting follows the retained root: its content WAS removed while
  // it was live/attached.
  assert.equal(result.forcedLoaded, 1)
})

test('purge: a DESCENDANT that becomes resident after the tree recheck also retains the tree', async () => {
  const host = buildHost()
  // The ROOT stays non-resident: only a1 (a subagent member) is attached at ITS
  // own deletion instant, i.e. after the tree-level recheck already ran (force
  // lets the delete-time guard through). That per-member report is the only
  // signal this subagent is still being served — reading residency off the root
  // alone dropped it, completed the tree and cleared the membership, so the
  // subagent row could re-surface exactly like the user-reported root case
  // (2026-13 self-review).
  host.attachOnDeleteOf = 'a1'
  const core = new ArchiveCleanupCore(host)

  const result = await core.purge(['s1'], true)
  assert.equal(host.loaded.has('a1'), true, 'the attach hook fired at a1 deletion time')
  assert.deepEqual(result.residentRetainedRoots, ['s1'], 'the member report retains the whole tree')
  assert.equal(host.archived.has('s1'), true, 'membership retained — no partial membership for the tree')
  assert.equal(host.removedFromArchived.includes('s1'), false)
  // The CONTENT was still deleted, and the counts stay honest.
  assert.equal(result.deletedSubagents, 2, 'the s1 tree is a1 + a1a')
  assert.equal(result.deletedSessions, 1)
})

test('purge: an attach landing after the deletions but before the batched write keeps the membership', async () => {
  const host = buildHost()
  // The sweep runs after every tree deletion and before the single archived-set
  // write (up to MAX_SWEEP_CONTENT_PROBES content probes), so it is the last
  // window in which a session can attach while its root is already a completed
  // tree. Without the final live re-check the membership was cleared there and
  // the live-preferred corpus served the row again — the original symptom, one
  // window later (2026-13 review).
  host.attachOnSweepProbe = 's2'
  const core = new ArchiveCleanupCore(host)

  const result = await core.purge(['s2'], true)
  assert.equal(host.loaded.has('s2'), true, 'the attach landed inside the window')
  assert.equal(result.deletedSessions, 1, 'its content was deleted before it attached')
  assert.equal(host.archived.has('s2'), true, 'the membership must survive: the row is being served again')
  assert.equal(host.removedFromArchived.includes('s2'), false)
  assert.deepEqual(result.residentRetainedRoots, ['s2'], 'reported, so the manager labels the row')
  assert.equal(result.forcedLoaded, 1, 'its content WAS force-deleted while it was live')
})

test('purge: a failed FINAL live re-check clears nothing this run (fail-closed)', async () => {
  const host = buildHost()
  const core = new ArchiveCleanupCore(host)
  // Reads: 1 snapshot + 1 per deletable tree (s1, s2) + 1 sweep confirmation +
  // the final pre-write re-check. Fail only that last one.
  host.failLiveReadOnCall = 5
  const result = await core.purge()

  // The deletions themselves already happened (they were decided and executed
  // earlier in the run); what must NOT happen is clearing memberships while
  // "nobody attached in the meantime" cannot be proven.
  assert.equal(result.deletedSessions, 2)
  assert.equal(host.removalCalls.length, 0, 'an unprovable window must clear nothing')
  assert.deepEqual(host.archived, new Set(['s1', 's2', 's3', 's-orphan']), 'every membership survives')
  assert.equal(result.clearedOrphanMembers, undefined)
  assert.ok(result.errors.some(error => error.code === 'archive-set'), 'and the run records why')
})

test('purge: a NON-resident tree is still cleared normally (retention is residency-only)', async () => {
  const host = buildHost()
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge()
  assert.equal(result.residentRetainedRoots, undefined)
  assert.deepEqual(host.removedFromArchived, ['s1', 's2', 's-orphan'])
})

test('purge: a running member is refused with force too (delete-time guard)', async () => {
  const host = buildHost()
  // Deleting s1's leaf a1a flips its parent a1 RUNNING inside the SAME tree —
  // only the binding's delete-time guard can catch it, and force must not
  // bypass it (a live writer would recreate the artifact).
  host.liveAddOnDeleteOf = 'a1a'
  host.liveAddOnDelete = 'a1'
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge(['s1'], true)
  assert.deepEqual(host.deleteLog, ['a1a'])
  assert.equal(result.errors.length, 1)
  assert.equal(result.errors[0]?.code, 'running')
  assert.equal(host.states.has('a1'), true)
  assert.equal(host.states.has('s1'), true)
  // The aborted tree keeps its members archived (s1 + the unrelated running
  // s2/s3). `s-orphan` IS cleared: the registry-global orphan sweep is
  // orthogonal to this run's tree outcome and only removes members with no
  // session record at all (design 24 §4 step 5) — it deletes no content.
  assert.deepEqual(host.archived, new Set(['s1', 's2', 's3']))
})

test('purge: deletes children-first and removes archived members last', async () => {
  const host = buildHost()
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge()
  assert.equal(result.deletedSessions, 2)
  assert.equal(result.deletedSubagents, 2)
  assert.equal(result.skippedRunning, 1)
  assert.deepEqual(result.errors, [])
  assert.deepEqual(host.deleteLog, ['a1a', 'a1', 's1', 's2'])
  assert.deepEqual(host.removedFromArchived, ['s1', 's2', 's-orphan'])
  // Only archived subtrees were touched; the running subtree and the live
  // sibling are intact.
  assert.equal(host.states.has('s3'), true)
  assert.equal(host.states.has('b1'), true)
  assert.equal(host.states.has('s4'), true)
  assert.deepEqual(host.archived, new Set(['s3']))
})

test('purge: idempotent rerun converges to the running-skipped remainder only', async () => {
  const host = buildHost()
  const core = new ArchiveCleanupCore(host)
  await core.purge()
  const again = await core.purge()
  assert.equal(again.deletedSessions, 0)
  assert.equal(again.deletedSubagents, 0)
  assert.equal(again.skippedRunning, 1) // s3 stays running-skipped
  assert.equal(again.errors.length, 0)
})

test('purge: a running subtree is skipped whole and stays archived', async () => {
  const host = buildHost()
  host.live.add('b1')
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge()
  assert.equal(result.skippedRunning, 1)
  assert.equal(host.states.has('s3'), true)
  assert.equal(host.states.has('b1'), true)
  assert.deepEqual(host.archived, new Set(['s3']))
})

test('purge: mid-run running flip is caught by the per-subtree recheck', async () => {
  // s3's child b1 is idle (not running) at plan time; deleting s1 flips it
  // live. The per-tree recheck before s3 must skip the whole subtree mid-run.
  const host = buildHost()
  host.live.delete('b1')
  host.liveAddOnDeleteOf = 's1'
  host.liveAddOnDelete = 'b1'
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge()
  assert.equal(result.deletedSessions, 2)
  assert.equal(result.deletedSubagents, 2)
  assert.equal(result.skippedRunning, 1) // s3 flipped live between plan and its turn
  assert.equal(result.errors.length, 0)
  assert.equal(host.states.has('s3'), true)
  assert.equal(host.states.has('b1'), true)
  assert.deepEqual(host.archived, new Set(['s3']))
})

test('purge: item failure isolation — a failing subtree does not block others and keeps its archived member for a rerun', async () => {
  const host = buildHost()
  host.failDeletes.set('s2', { code: 'storage', remaining: 1 })
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge()
  assert.equal(result.deletedSessions, 1) // s1 subtree only
  assert.equal(result.deletedSubagents, 2)
  assert.equal(result.errors.length, 1)
  assert.equal(result.errors[0]?.sessionId, 's2')
  assert.equal(result.errors[0]?.code, 'storage')
  // s2 stays archived (partial failure → re-enumerable).
  assert.deepEqual(host.archived, new Set(['s2', 's3']))
  const again = await core.purge()
  assert.equal(again.deletedSessions, 1)
  assert.equal(again.errors.length, 0)
  assert.deepEqual(host.archived, new Set(['s3']))
})

test('purge: delete-time running refusal surfaces as a per-item error and keeps the member', async () => {
  const host = buildHost()
  // s2's delete refuses with `running` exactly once (plan-time it is idle).
  host.failDeletes.set('s2', { code: 'running', remaining: 1 })
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge()
  assert.equal(result.errors.length, 1)
  assert.equal(result.errors[0]?.code, 'running')
  assert.deepEqual(host.archived, new Set(['s2', 's3']))
  const again = await core.purge()
  assert.equal(again.deletedSessions, 1)
  assert.equal(again.errors.length, 0)
  assert.deepEqual(host.archived, new Set(['s3']))
})

test('purge: a mid-tree running refusal aborts the tree — the refused member, its ancestors and the root survive; a rerun converges (review F1)', async () => {
  const host = buildHost()
  // a1 (NON-root member of s1's tree [a1a, a1, s1]) refuses at delete time
  // with `running` — the binding-guard shape for a mid-window live flip.
  host.failDeletes.set('a1', { code: 'running', remaining: 1 })
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge()
  // a1a (deleted before the failure) stays deleted — prefix deletions are
  // not rolled back; a1 and its ancestors/root content are NOT touched.
  assert.deepEqual(host.deleteLog, ['a1a', 's2'])
  assert.equal(host.states.has('a1'), true, 'the refused member survives')
  assert.equal(host.states.has('s1'), true, 'the root survives (record intact)')
  assert.equal(result.deletedSessions, 1) // s2 only — s1's root content NOT deleted
  assert.equal(result.deletedSubagents, 1) // a1a only
  assert.equal(result.skippedRunning, 1) // s3 (running child)
  assert.equal(result.errors.length, 1)
  assert.equal(result.errors[0]?.sessionId, 'a1')
  assert.equal(result.errors[0]?.code, 'running')
  // The root stays archived → the next purge re-enumerates the tree.
  assert.deepEqual(host.archived, new Set(['s1', 's3']))
  // Rerun with the member no longer running: a1a is gone ('missing'-safe),
  // a1 + root delete and the set member clears.
  const again = await core.purge()
  assert.equal(again.deletedSessions, 1)
  assert.equal(again.deletedSubagents, 1)
  assert.equal(again.errors.length, 0)
  assert.deepEqual(host.deleteLog, ['a1a', 's2', 'a1', 's1'])
  assert.deepEqual(host.archived, new Set(['s3']))
})

test('purge: a mid-tree storage failure aborts the tree — the refused member, its ancestors and the root survive; a rerun converges (review F1)', async () => {
  const host = buildHost()
  host.failDeletes.set('a1', { code: 'storage', remaining: 1 })
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge()
  assert.deepEqual(host.deleteLog, ['a1a', 's2'])
  assert.equal(host.states.has('a1'), true, 'the refused member survives')
  assert.equal(host.states.has('s1'), true, 'the root survives (record intact)')
  assert.equal(result.deletedSessions, 1)
  assert.equal(result.deletedSubagents, 1)
  assert.equal(result.errors.length, 1)
  assert.equal(result.errors[0]?.sessionId, 'a1')
  assert.equal(result.errors[0]?.code, 'storage')
  assert.deepEqual(host.archived, new Set(['s1', 's3']))
  const again = await core.purge()
  assert.equal(again.deletedSessions, 1)
  assert.equal(again.deletedSubagents, 1)
  assert.equal(again.errors.length, 0)
  assert.deepEqual(host.archived, new Set(['s3']))
})

test('purge: >1000 failing members truncate the error list at the shared cap with truncated=true (review F4)', async () => {
  const host = new FakeHost()
  for (let i = 0; i < MAX_PURGE_ERROR_RECORDS + 1; i += 1) {
    const id = `fail-${i}`
    host.archived.add(id)
    host.states.set(id, state(id))
    host.failDeletes.set(id, { code: 'storage', remaining: 1 })
  }
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge()
  assert.equal(result.errors.length, MAX_PURGE_ERROR_RECORDS)
  assert.equal(result.truncated, true)
  assert.equal(result.deletedSessions, 0)
  assert.equal(result.deletedSubagents, 0)
  assert.equal(result.skippedRunning, 0)
  assert.equal(host.deleteLog.length, 0, 'every delete failed')
  assert.equal(host.removalCalls.length, 0, 'no tree completed → no batched set removal')
  // Truncation is surface-honest: the set members stay archived and a rerun
  // converges once the failures clear.
  assert.equal(host.archived.size, MAX_PURGE_ERROR_RECORDS + 1)
})

test('purge: an archived descendant covered by a completed tree is cleared in the SAME run (merge-round Nit N1)', async () => {
  const host = new FakeHost()
  // s1 archived with an archived subagent-origin descendant a1 (itself a set
  // member) plus a deeper descendant a1a; s2 archived leaf; s3 running-skipped.
  host.archived.add('s1')
  host.states.set('s1', state('s1'))
  host.archived.add('a1')
  host.states.set('a1', subagent('a1', 's1'))
  host.states.set('a1a', subagent('a1a', 'a1'))
  host.archived.add('s2')
  host.states.set('s2', state('s2'))
  host.archived.add('s3')
  host.states.set('s3', state('s3'))
  host.states.set('b1', subagent('b1', 's3'))
  host.live.add('b1')
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge()
  assert.equal(result.deletedSessions, 2)
  assert.equal(result.deletedSubagents, 2)
  assert.deepEqual(result.errors, [])
  // a1's archived marker rides the SAME end-of-run batched write — no lag to
  // a later orphan pass.
  assert.deepEqual(host.removalCalls, [['s1', 's2', 'a1']])
  assert.deepEqual(host.archived, new Set(['s3']))
  // Converged after ONE run: a rerun has nothing left to clear or delete.
  const again = await core.purge()
  assert.equal(again.deletedSessions, 0)
  assert.equal(again.deletedSubagents, 0)
})

test('purge: crash mid-subtree leaves the root archived and a rerun converges', async () => {
  const host = buildHost()
  host.crashAfterDeleteCount = 1
  const core = new ArchiveCleanupCore(host)
  await assert.rejects(() => core.purge(), /process crashed/)
  assert.deepEqual(host.deleteLog, ['a1a'])
  assert.deepEqual(host.removedFromArchived, [])
  // A "restarted process" sees the same persisted state (archived set
  // unchanged; a1a's record gone) and the same live-agent facts (b1's run
  // outlives the mid-run crash) — the running guard is sourced from the live
  // facts, never from a persisted per-record bit.
  const restarted = new FakeHost()
  for (const id of host.archived) restarted.archived.add(id)
  for (const [id, st] of host.states) restarted.states.set(id, st)
  for (const id of host.live) restarted.live.add(id)
  const rerun = new ArchiveCleanupCore(restarted)
  const result = await rerun.purge()
  // s1's subtree: a1a is missing (no double delete), a1 + s1 delete; s2 too.
  assert.equal(result.deletedSessions, 2)
  assert.equal(result.deletedSubagents, 1)
  assert.deepEqual(restarted.deleteLog, ['a1', 's1', 's2'])
  assert.equal(restarted.states.has('s3'), true)
})

test('purge: registry-unreadable state fails the whole run without mutating', async () => {
  const host = buildHost()
  host.failStateRead = true
  const core = new ArchiveCleanupCore(host)
  await assert.rejects(() => core.purge(), codeIs('registry-unreadable'))
  assert.equal(host.deleteLog.length, 0)
  assert.equal(host.removedFromArchived.length, 0)
})

test('purge: batched set-removal failure keeps every id archived for rerun convergence', async () => {
  const host = buildHost()
  host.removalFailureRemaining = 1
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge()
  assert.equal(result.deletedSessions, 2) // content went
  assert.equal(result.errors.length, 1)
  assert.equal(result.errors[0]?.code, 'archive-set')
  // The single batched write failed → every completed root AND the orphan
  // stay archived (content is gone; the rerun converges via orphan handling).
  assert.equal(host.removalCalls.length, 0) // failed before recording
  assert.equal(host.archived.has('s1'), true)
  assert.equal(host.archived.has('s2'), true)
  assert.equal(host.archived.has('s-orphan'), true)
  const again = await core.purge()
  assert.equal(again.deletedSessions, 0)
  assert.equal(again.errors.length, 0)
  assert.equal(host.archived.has('s1'), false)
  assert.equal(host.archived.has('s2'), false)
  assert.equal(host.archived.has('s-orphan'), false)
  assert.deepEqual([...host.archived], ['s3'])
  assert.deepEqual(host.removalCalls, [['s1', 's2', 's-orphan']])
})

test('domainResult: ArchiveCleanupError maps through the carrier; unknown failures stay throws', async () => {
  const { domainResult } = await import('../src/core.ts')
  const ok = await domainResult(async () => 42)
  assert.deepEqual(ok, { ok: true, value: 42 })
  const refused = await domainResult(async () => {
    throw new ArchiveCleanupError('busy', 'busy message', true)
  })
  assert.deepEqual(refused, { ok: false, error: { code: 'busy', message: 'busy message', retryable: true } })
  await assert.rejects(() => domainResult(async () => { throw new Error('boom') }), /boom/)
})

test('capacity guard: oversized archived sets refuse before any mutation', async () => {
  const host = new FakeHost()
  for (let i = 0; i < MAX_PURGE_SESSIONS + 1; i += 1) {
    host.archived.add(`bulk-${i}`)
    host.states.set(`bulk-${i}`, state(`bulk-${i}`))
  }
  const core = new ArchiveCleanupCore(host)
  await assert.rejects(() => core.purge(), codeIs('purge-capacity'))
  assert.equal(host.deleteLog.length, 0)
})

test('purge reads the state corpus once plus ONE orphan-sweep confirmation scan, re-reads only the live set per tree, and batches the set removal (perf contract)', async () => {
  const host = buildHost()
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge()
  assert.equal(result.errors.length, 0)
  assert.equal(result.clearedOrphanMembers, 1)
  assert.equal(host.stateListCalls, 1 + 1, 'snapshot scan + the ONE sweep confirmation scan (s-orphan exists)')
  assert.equal(host.liveListCalls, 1 + 2 + 1 + 1,
    'snapshot + one live refresh per deletable tree (s1, s2) + the sweep confirmation + the LAST re-check before the batched write (2026-13 review: the write may land minutes after the deletions, so nothing may be cleared without one final live read; the extra call reads the LIVE store/agent list only — never the durable corpus, whose scan count below is unchanged)')
  assert.equal(host.removalCalls.length, 1, 'archived-set removal is ONE batched write')
  assert.deepEqual(host.removalCalls[0], ['s1', 's2', 's-orphan'])
})

test('purge: a converged set with no orphan members keeps the single-scan contract (no confirmation read)', async () => {
  const host = buildHost()
  host.archived.delete('s-orphan')
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge()
  assert.equal(result.errors.length, 0)
  assert.equal(result.clearedOrphanMembers, undefined)
  assert.equal(host.stateListCalls, 1, 'no orphan candidates → no confirmation scan')
  assert.equal(host.liveListCalls, 1 + 2 + 1, 'same contract as above: the batched write is always preceded by one final live read')
  assert.deepEqual(host.removalCalls, [['s1', 's2']])
})

/* ---- subset/orphan-sweep invariants folded in from the deleted
 * subset-and-orphan-sweep.test.ts (2026-12 test-trim round 2): the
 * fail-closed and boundary legs only; the subset-mode happy paths were
 * covered by the purge/subset assertions above. ---- */
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
test('purge subset: a malformed filter refuses BEFORE any authoritative read (validation-first)', async () => {
  const host = buildHost()
  const core = new ArchiveCleanupCore(host)
  await assert.rejects(() => core.purge([42 as never]), codeIs('invalid-request'))
  assert.equal(host.stateReadAttempts, 0, 'no corpus read for a malformed request')
  assert.equal(host.removalCalls.length, 0)
})
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
