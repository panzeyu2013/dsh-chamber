/**
 * Archive cleanup core — orphan-sweep credibility gates (G1–G3), probe budget and protectSessionIds.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ArchiveCleanupCore,
  ArchiveCleanupError,
  indexChildren,
  resolveDeletableTree,
  MAX_PURGE_SESSIONS,
  MAX_SWEEP_CONTENT_PROBES,
} from '../src/core.ts'
import {
  state,
  subagent,
  FakeHost,
  buildHost,
} from './support/archive-host.ts'

/* ------------------------------------------------------------------ */
/* Orphan-sweep blocker fix (2026-12 adversarial second scan): the      */
/* sweep's G1 credibility guards + G3 decisive existence probe.         */
/* ------------------------------------------------------------------ */

test('purge BLOCKER: a content-bearing member missing from BOTH bulk reads is never swept (G3 authoritative probe)', async () => {
  // The reviewer's repro, minus the empty-corpus guard: a NON-empty corpus
  // that silently omits two content-bearing archived members (jsonl skips
  // unparseable artifacts / the query corpus narrows live-only). Before the
  // fix, `purge(['keep-1'])` answered deleted=0, clearedOrphanMembers=2 and
  // erased both memberships while keep-2's artifact stayed on disk.
  const host = new FakeHost()
  host.states.set('other', state('other')) // credible corpus (G1a passes)
  host.archived.add('keep-1')
  host.archived.add('keep-2')
  host.archived.add('ghost-1') // genuinely record-less AND content-less
  host.contentIds.add('keep-1')
  host.contentIds.add('keep-2')
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge(['keep-1'])
  assert.equal(result.deletedSessions, 0, 'no record → no content-deletion candidate')
  assert.equal(result.deletedSubagents, 0)
  // The probe is PER CANDIDATE: only the id the official read cannot
  // materialize loses its membership; the two content-bearing members keep
  // theirs and never inflate the swept count.
  assert.equal(result.clearedOrphanMembers, 1)
  assert.deepEqual(host.removalCalls, [['ghost-1']], 'ONE official set write, containing only the content-free member')
  assert.deepEqual([...host.archived], ['keep-1', 'keep-2'], 'both content-bearing memberships survive')
  assert.deepEqual(host.probeCalls, ['keep-1', 'keep-2', 'ghost-1'], 'every candidate asked the authoritative read')
})

test('purge subset (reviewer repro): a one-row purge deletes its own row and never clears an unrelated content-bearing archived member', async () => {
  // The reviewer's call shape: `purge(['keep-1'])` on an archived set where
  // keep-2 has content on disk but no record in the narrowed corpus.
  // Pre-fix: clearedOrphanMembers=2 and keep-2's membership gone (content
  // orphaned, the session reappears non-archived and can never be re-deleted
  // through the manager). Post-fix: keep-2 keeps its membership.
  const host = new FakeHost()
  host.states.set('other', state('other')) // unrelated session keeps the corpus non-empty
  host.archived.add('keep-1')
  host.states.set('keep-1', state('keep-1'))
  host.archived.add('keep-2')
  host.contentIds.add('keep-2')
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge(['keep-1'])
  assert.equal(result.deletedSessions, 1, 'the selected row is deleted')
  assert.equal(result.clearedOrphanMembers, undefined, 'the unrelated member is NOT cleared')
  assert.deepEqual(host.removalCalls, [['keep-1']], 'the set write names only the completed tree')
  assert.deepEqual([...host.archived], ['keep-2'], 'keep-2 stays archived → still reachable via the manager')
  assert.deepEqual(host.probeCalls, ['keep-2'], 'the unrelated candidate was probed and kept')
  assert.equal(result.errors.length, 0, 'keeping a content-bearing member is not an error')
})

test('purge sweep G1a: an empty snapshot corpus never clears archived members (reviewer repro, no probes)', async () => {
  // The reviewer's exact shape: the corpus reports ZERO records while two
  // members are archived (an absent sessions root / unmounted persistence
  // binding answers empty with NO error). Zero records is not evidence that
  // content is absent — the sweep must not even probe.
  const host = new FakeHost()
  host.archived.add('keep-1')
  host.archived.add('keep-2')
  host.contentIds.add('keep-2')
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge(['keep-1'])
  assert.equal(result.deletedSessions, 0)
  assert.equal(result.clearedOrphanMembers, undefined)
  assert.deepEqual(host.removalCalls, [])
  assert.deepEqual([...host.archived], ['keep-1', 'keep-2'])
  assert.deepEqual(host.probeCalls, [], 'G1a skips BEFORE the confirmation read and every probe')
  assert.equal(host.stateListCalls, 1, 'no confirmation read on a non-credible corpus')
  assert.equal(result.errors.length, 1)
  assert.equal(result.errors[0]?.sessionId, '')
  assert.equal(result.errors[0]?.code, 'archive-set')
  assert.match(result.errors[0]?.message ?? '', /corpus is empty/)
})

test('purge sweep G1b: a confirmation corpus collapsing to empty skips the sweep and still commits completed deletions', async () => {
  const host = buildHost()
  host.emptyStateReadOnAttempt = 2
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge()
  assert.equal(result.deletedSessions, 2, 'completed content deletions are committed')
  assert.equal(result.deletedSubagents, 2)
  assert.equal(result.clearedOrphanMembers, undefined)
  assert.deepEqual(host.removalCalls, [['s1', 's2']])
  assert.equal(host.archived.has('s-orphan'), true, 'the candidate stays archived')
  assert.deepEqual(host.probeCalls, [], 'no probes on a collapsed corpus')
  assert.equal(result.errors.length, 1)
  assert.equal(result.errors[0]?.code, 'archive-set')
  assert.match(result.errors[0]?.message ?? '', /collapsed to empty/)
})

test('purge sweep G2: a candidate the CONFIRMATION read lists is not swept (transient snapshot miss)', async () => {
  const host = buildHost()
  host.archived.add('late-1') // record-less in the snapshot → a candidate
  host.addStatesOnStateRead = { attempt: 2, states: [state('late-1')] }
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge(['s1'])
  assert.equal(result.errors.length, 0)
  assert.equal(result.clearedOrphanMembers, 1, 'only the genuinely record-less member')
  assert.deepEqual(host.removalCalls, [['s1', 's-orphan']])
  assert.equal(host.archived.has('late-1'), true)
  assert.equal(host.probeCalls.includes('late-1'), false, 'filtered by G2 before any probe')
})

test('purge sweep G2: a candidate that left the archived set (concurrent purge) is not double-cleared', async () => {
  const host = buildHost()
  host.archived.add('ghost-late')
  host.removeArchivedOnArchivedRead = { attempt: 2, id: 'ghost-late' }
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge(['s1'])
  assert.equal(result.errors.length, 0)
  assert.equal(result.clearedOrphanMembers, 1)
  assert.deepEqual(host.removalCalls, [['s1', 's-orphan']], 'no redundant clear of the departed id')
  assert.equal(host.probeCalls.includes('ghost-late'), false)
})

test('purge sweep G3: a failing content-existence probe keeps the membership (fail closed) and never aborts the run', async () => {
  const host = buildHost()
  host.failContentProbes.set('s-orphan', { code: 'storage', remaining: 1 })
  const core = new ArchiveCleanupCore(host)
  const first = await core.purge()
  assert.equal(first.deletedSessions, 2, 'completed content deletions stand')
  assert.equal(first.deletedSubagents, 2)
  assert.equal(first.clearedOrphanMembers, undefined)
  assert.deepEqual(host.removalCalls, [['s1', 's2']])
  assert.equal(host.archived.has('s-orphan'), true, 'an unreadable existence check never clears a membership')
  assert.equal(first.errors.length, 1)
  assert.equal(first.errors[0]?.code, 'archive-set')
  assert.match(first.errors[0]?.message ?? '', /probe failed/)
  // A LATER run (probe healthy again) converges it.
  const again = await core.purge()
  assert.equal(again.errors.length, 0)
  assert.equal(again.clearedOrphanMembers, 1)

  // A RAW (non-domain) probe failure must be caught too — it can never abort
  // the run or clear a membership.
  const host2 = buildHost()
  host2.rawContentProbeFailures.add('s-orphan')
  const result2 = await new ArchiveCleanupCore(host2).purge()
  assert.equal(result2.deletedSessions, 2)
  assert.equal(result2.clearedOrphanMembers, undefined)
  assert.equal(host2.archived.has('s-orphan'), true)
  assert.equal(result2.errors.length, 1)
  assert.match(result2.errors[0]?.message ?? '', /raw content probe failure/)
})

test('purge sweep G3: a probe answer that is not the exact boolean false never clears a membership', async () => {
  // Only the exact boolean false is a proof of absent content. A drifted host
  // returning undefined/0/'' (falsy but not false) must NOT be read as "no
  // content" — and such an answer is not an error, just insufficient proof.
  for (const answer of [undefined, null, 0, ''] as const) {
    const host = buildHost()
    Object.defineProperty(host, 'hasStoredContent', {
      value: async () => answer,
      configurable: true,
    })
    const result = await new ArchiveCleanupCore(host).purge()
    assert.equal(result.deletedSessions, 2, 'content deletions unaffected')
    assert.equal(result.clearedOrphanMembers, undefined, `probe answer ${String(answer)} is not a proof of absence`)
    assert.deepEqual(host.removalCalls, [['s1', 's2']])
    assert.equal(host.archived.has('s-orphan'), true)
    assert.equal(result.errors.length, 0, 'a non-false answer is not an error — just not a proof')
  }
  // The exact boolean false still sweeps (no over-correction).
  const okHost = buildHost()
  const okResult = await new ArchiveCleanupCore(okHost).purge()
  assert.equal(okResult.clearedOrphanMembers, 1)
})

test('purge sweep G3: a host without the hasStoredContent capability never sweeps (fail closed, run-level note)', async () => {
  const host = buildHost()
  // The seam requires the capability, but a drifted/older host may not
  // provide it at runtime — shadow the prototype method with undefined.
  Object.defineProperty(host, 'hasStoredContent', { value: undefined, configurable: true })
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge()
  assert.equal(result.deletedSessions, 2)
  assert.equal(result.deletedSubagents, 2)
  assert.equal(result.clearedOrphanMembers, undefined)
  assert.deepEqual(host.removalCalls, [['s1', 's2']])
  assert.equal(host.archived.has('s-orphan'), true)
  assert.equal(result.errors.length, 1)
  assert.equal(result.errors[0]?.code, 'archive-set')
  assert.match(result.errors[0]?.message ?? '', /no hasStoredContent capability/)
})

test('purge sweep G3: the per-run probe budget bounds one sweep, notes the truncation, and the remainder converges later', async () => {
  const host = new FakeHost()
  host.states.set('keeper', state('keeper'))
  host.states.set('other', state('other'))
  host.archived.add('keeper')
  for (let i = 0; i < MAX_SWEEP_CONTENT_PROBES + 1; i += 1) host.archived.add(`ghost-${i}`)
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge(['keeper'])
  assert.equal(result.deletedSessions, 1)
  assert.equal(host.probeCalls.length, MAX_SWEEP_CONTENT_PROBES, 'exactly the budget is probed')
  assert.equal(result.clearedOrphanMembers, MAX_SWEEP_CONTENT_PROBES)
  assert.equal(host.archived.has(`ghost-${MAX_SWEEP_CONTENT_PROBES}`), true, 'the truncated remainder stays archived')
  assert.equal(host.archived.has('keeper'), false)
  assert.equal(result.errors.length, 1)
  assert.equal(result.errors[0]?.code, 'archive-set')
  assert.match(result.errors[0]?.message ?? '', new RegExp(`truncated at ${MAX_SWEEP_CONTENT_PROBES}`))
  // Convergence: the next run (corpus still non-empty via `other`) sweeps the
  // single remaining member.
  const again = await core.purge()
  assert.equal(again.errors.length, 0)
  assert.equal(again.clearedOrphanMembers, 1)
  assert.equal(host.archived.size, 0)
})

// ---------------------------------------------------------------------------
// protectSessionIds (2026-09 protection amendment): protection outranks every
// liveness classification and `force`, matches the FULL subtree closure, and
// can only ever shrink the deletion set.
// ---------------------------------------------------------------------------

/** Fixture: two independent archived trees (r1 → c1 → c1a, r2) plus a leaf. */
function protectionHost(): FakeHost {
  const host = new FakeHost()
  host.archived.add('r1')
  host.states.set('r1', state('r1'))
  host.states.set('c1', subagent('c1', 'r1'))
  host.states.set('c1a', subagent('c1a', 'c1'))
  host.archived.add('r2')
  host.states.set('r2', state('r2'))
  return host
}

test('purge protection: a protected ROOT skips its whole tree and reports skippedProtected (membership kept)', async () => {
  const host = protectionHost()
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge(undefined, true, ['r1'])
  assert.equal(result.skippedProtected, 1)
  assert.equal(result.deletedSessions, 1, 'the unprotected tree is still deleted')
  assert.equal(result.deletedSubagents, 0)
  assert.deepEqual(host.deleteLog, ['r2'])
  assert.equal(host.archived.has('r1'), true, 'the protected tree keeps its membership')
  assert.equal(host.removedFromArchived.includes('r1'), false)
  assert.equal(result.errors.length, 0)
})

test('purge protection: a protected SUBAGENT descendant protects its archived ancestor tree (closure match, not id match)', async () => {
  const host = protectionHost()
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge(['r1'], true, ['c1a'])
  assert.equal(result.skippedProtected, 1)
  assert.equal(result.deletedSessions, 0)
  assert.deepEqual(host.deleteLog, [], 'no member of the protected closure is cut')
  assert.equal(host.archived.has('r1'), true)
})

test('purge protection outranks running and loaded: the tree is counted protected, not skipped for liveness', async () => {
  const host = protectionHost()
  host.live.add('c1')
  const core = new ArchiveCleanupCore(host)
  const running = await core.purge(['r1'], true, ['c1a'])
  assert.equal(running.skippedProtected, 1)
  assert.equal(running.skippedRunning, 0)
  assert.equal(running.skippedLoaded, 0)

  const loadedHost = protectionHost()
  loadedHost.loaded.add('r1')
  const loaded = await new ArchiveCleanupCore(loadedHost).purge(['r1'], true, ['r1'])
  assert.equal(loaded.skippedProtected, 1)
  assert.equal(loaded.skippedLoaded, 0)
  assert.equal(loaded.forcedLoaded, 0)
  assert.deepEqual(loadedHost.deleteLog, [])
})

test('purge protection: unknown / non-archived protected ids are silent no-ops (fail-closed direction only)', async () => {
  const host = protectionHost()
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge(['r2'], true, ['never-archived', 'r1'])
  assert.equal(result.deletedSessions, 1)
  assert.equal(result.skippedProtected, 0, 'a protected id outside the candidate set is not a skip')
  assert.deepEqual(host.deleteLog, ['r2'])
  assert.equal(result.errors.length, 0)
})

test('purge protection: a protected ORPHAN member is never swept and never removed from the archived set', async () => {
  const host = new FakeHost()
  host.archived.add('keeper')
  host.states.set('keeper', state('keeper'))
  host.archived.add('ghost-protected')
  const core = new ArchiveCleanupCore(host)
  const result = await core.purge(['keeper'], true, ['ghost-protected'])
  assert.equal(result.deletedSessions, 1)
  assert.equal(result.clearedOrphanMembers, undefined)
  assert.equal(host.archived.has('ghost-protected'), true, 'the sweep must not clear a protected membership')
  assert.deepEqual(host.removalCalls, [['keeper']])
})

test('purge protection: a protected tree injected into the plan is skipped BEFORE any member deletion (tree-level re-check)', async () => {
  const host = protectionHost()
  // Simulate a plan bug: force the protected tree into plan.trees and assert
  // the tree-level re-check refuses to START deleting it (no prefix deletions).
  const core = new ArchiveCleanupCore(host)
  const original = core['resolvePlan'].bind(core)
  core['resolvePlan'] = ((...args: Parameters<typeof original>) => {
    const plan = original(...args)
    const tree = resolveDeletableTree('r1', host.states, indexChildren([...host.states.values()]), { running: host.live, loaded: host.loaded }, true)
    if (tree !== null) plan.trees.unshift(tree)
    return plan
  }) as typeof core['resolvePlan']
  const result = await core.purge(['r1'], true, ['r1'])
  assert.deepEqual(host.deleteLog, [], 'no member of the injected protected tree is cut')
  // 2 = the plan-level skip of the real candidate + the injected duplicate's
  // tree-level refusal (the violation the re-check exists for).
  assert.equal(result.skippedProtected, 2)
  assert.equal(result.errors.length, 1)
  assert.equal(result.errors[0]?.code, 'archive-set')
  assert.match(result.errors[0]?.message ?? '', /invariant violation/)
})

test('purge protection: malformed / oversized protected filters refuse before any authoritative read', async () => {
  const host = protectionHost()
  const core = new ArchiveCleanupCore(host)
  const isInvalid = (error: unknown): boolean => error instanceof ArchiveCleanupError && error.code === 'invalid-request'
  await assert.rejects(core.purge(undefined, true, ['']), isInvalid)
  await assert.rejects(core.purge(undefined, true, ['ok', 7 as unknown as string]), isInvalid)
  await assert.rejects(core.purge(undefined, true, new Array(MAX_PURGE_SESSIONS + 1).fill('x')), isInvalid)
  assert.equal(host.stateReadAttempts, 0, 'validation runs before the corpus read')
  assert.equal(host.archivedListCalls, 0)
  assert.deepEqual(host.deleteLog, [])
})

test('purge protection: an empty protected set keeps the historical behavior byte-for-byte', async () => {
  const withEmpty = protectionHost()
  const withoutArg = protectionHost()
  const a = await new ArchiveCleanupCore(withEmpty).purge(undefined, true, [])
  const b = await new ArchiveCleanupCore(withoutArg).purge(undefined, true)
  assert.deepEqual(a, b)
  assert.equal(a.skippedProtected, 0)
})
