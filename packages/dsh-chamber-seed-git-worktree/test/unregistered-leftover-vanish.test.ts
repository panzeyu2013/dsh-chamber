/**
 * Git worktree core — unregistered removal, missing-dir leftover records and mid-flight directory vanish.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { GitWorktreeError, type GitCommandRequest } from '../src/core.ts'
import {
  LINKED,
  WORKTREES_KEY,
  FEATURE_HEAD,
  FakeRepository,
  setup,
  previewNew,
  mutationCalls,
  STALE,
  addStaleRecord,
} from './support/fake-repository.ts'

test('unregistered worktree removal: no workspace, git-first, next none', async () => {
  const { core, repo } = setup({ linked: true })
  repo.addLinked({ path: '/repos/external', branch: 'ext', head: FEATURE_HEAD })
  const snapshot = await core.snapshot()
  const repository = snapshot.repos[0]!
  const ext = repository.worktrees.find(worktree => worktree.path === '/repos/external')!
  const removed = await core.remove({
    operationId: 'op-unreg',
    expected: { repoId: repository.repoId, worktreeId: ext.worktreeId, branch: ext.branch!, head: ext.head },
    path: '/repos/external',
  })
  assert.equal(removed.removed, true)
  assert.equal(removed.next, 'none')
  assert.equal(removed.workspaceId, undefined)
  const after = await core.snapshot()
  assert.equal(after.repos[0]!.worktrees.some(row => row.path === '/repos/external'), false)
})

test('unregistered removal keeps the dirty/locked/main guards and rejects without a path', async () => {
  const { core, repo } = setup({ linked: true })
  repo.addLinked({ path: '/repos/external', branch: 'ext', head: FEATURE_HEAD })
  const snapshot = await core.snapshot()
  const repository = snapshot.repos[0]!
  const ext = repository.worktrees.find(worktree => worktree.path === '/repos/external')!
  const expected = { repoId: repository.repoId, worktreeId: ext.worktreeId, branch: ext.branch!, head: ext.head }
  repo.worktrees.find(row => row.path === '/repos/external')!.dirty = true
  await assert.rejects(
    core.remove({ operationId: 'op-unreg-dirty', expected, path: '/repos/external' }),
    error => error instanceof GitWorktreeError && error.code === 'worktree-dirty',
  )
  await assert.rejects(
    core.remove({ operationId: 'op-unreg-nopath', expected }),
    error => error instanceof GitWorktreeError && error.code === 'invalid-input',
  )
})

test('unregistered removal replay is idempotent', async () => {
  const { core, repo } = setup({ linked: true })
  repo.addLinked({ path: '/repos/external', branch: 'ext', head: FEATURE_HEAD })
  const snapshot = await core.snapshot()
  const repository = snapshot.repos[0]!
  const ext = repository.worktrees.find(worktree => worktree.path === '/repos/external')!
  const expected = { repoId: repository.repoId, worktreeId: ext.worktreeId, branch: ext.branch!, head: ext.head }
  const first = await core.remove({ operationId: 'op-unreg-replay', expected, path: '/repos/external' })
  assert.equal(first.next, 'none')
  const replay = await core.remove({ operationId: 'op-unreg-replay', expected, path: '/repos/external' })
  assert.equal(replay.removed, true)
  assert.equal(replay.replayed, true)
  assert.equal(replay.next, 'none')
})

test('a worktree whose directory vanished but git metadata survives stays associated (raw-path fallback)', async () => {
  const { core, repo, workspaces } = setup({ linked: true })
  // The linked worktree's directory disappears (externally deleted) while its
  // git metadata still lists it (git worktree list keeps 'prunable' rows).
  repo.existing.delete(LINKED)
  const before = await core.snapshot()
  const repository = before.repos[0]!
  const row = repository.worktrees.find(worktree => worktree.path === LINKED)
  assert.ok(row !== undefined, 'the vanished worktree row still exists (metadata alive)')
  assert.equal(row.status, 'missing')
  // The workspace registration at the raw path (also failed realpath) keeps
  // the association — it must NOT leak into the unregistered block.
  assert.equal(row.workspaceId, 'ws-feature')
})

test('a VANISHED (orphaned) workspace no longer blocks another worktree removal', async () => {
  const { core, repo, workspaces } = setup({ linked: true })
  // The orphan: a workspace whose path no longer resolves (externally deleted
  // worktree left a registration). The registered remove preflight must
  // tolerate it (review 2026-08: it hard-failed EVERY registered removal on
  // the source and the retryable error wedged the source in recovery).
  workspaces.push({ workspaceId: 'orphan-1', path: '/repos/orphaned-path', sessionIds: [] })
  const before = await core.snapshot()
  const repository = before.repos[0]!
  const row = repository.worktrees.find(worktree => worktree.path === LINKED)!
  const removed = await core.remove({
    operationId: 'op-with-orphan',
    workspaceId: 'ws-feature',
    expected: { repoId: repository.repoId, worktreeId: row.worktreeId, branch: row.branch!, head: row.head },
  })
  assert.equal(removed.removed, true)
  assert.equal(removed.next, 'delete-workspace')
})

// ---------------------------------------------------------------------------
// Missing-dir leftover records (2026-09 live report): a merge drill created a
// worktree and later deleted its DIRECTORY without `git worktree remove` (rm
// -rf only; the live record was detached, so branch deletion was not blocked —
// the leftover record itself is the whole problem). The admin record survives
// in `git worktree list` (porcelain marks it prunable), the sidebar shows the
// row as a missing unregistered worktree — and topology() previously failed
// every mutation on the whole repository with path-unavailable. The removal
// of such a row must clear the leftover record only (plain `git worktree
// remove`, verified to succeed on a missing directory), and other operations
// must keep working.
// ---------------------------------------------------------------------------

test('a missing-dir leftover record does not block preview/create or another removal', async () => {
  const { core, repo } = setup({ linked: true })
  addStaleRecord(repo)
  const before = await core.snapshot()
  const repository = before.repos[0]!
  const stale = repository.worktrees.find(row => row.path === STALE)!
  assert.equal(stale.status, 'missing')
  assert.equal(stale.workspaceId, null)
  // The mutation-path topology no longer fails on the stale row:
  const preview = await previewNew(core, 'new-worktree', 'topic')
  assert.match(preview.repoId, /^repo_[0-9a-f]{64}$/)
  // Removing another (ready, registered) worktree of the same repo succeeds:
  const linkedRow = repository.worktrees.find(row => row.path === LINKED)!
  const removed = await core.remove({
    operationId: 'op-other-with-stale',
    workspaceId: 'ws-feature',
    expected: { repoId: repository.repoId, worktreeId: linkedRow.worktreeId, branch: linkedRow.branch!, head: linkedRow.head },
  })
  assert.equal(removed.removed, true)
  assert.equal(removed.next, 'delete-workspace')
})

test('unregistered removal of a missing-dir leftover record clears only the git record', async () => {
  const { core, repo } = setup({ linked: true })
  addStaleRecord(repo)
  const snapshot = await core.snapshot()
  const repository = snapshot.repos[0]!
  const stale = repository.worktrees.find(row => row.path === STALE)!
  const removed = await core.remove({
    operationId: 'op-stale-clean',
    expected: { repoId: repository.repoId, worktreeId: stale.worktreeId, branch: stale.branch!, head: stale.head },
    path: STALE,
  })
  assert.equal(removed.removed, true)
  assert.equal(removed.replayed, false)
  assert.equal(removed.next, 'none')
  assert.equal(removed.path, STALE)
  // git was told to clear exactly this leftover record — plain remove, no
  // --force, no dirty/submodule probes (there is no directory to probe).
  const removeCalls = mutationCalls(repo, 'remove')
  assert.equal(removeCalls.length, 1)
  assert.deepEqual(removeCalls[0]!.args, ['worktree', 'remove', '--', STALE])
  const after = await core.snapshot()
  assert.equal(after.repos[0]!.worktrees.some(row => row.path === STALE), false)
})

test('missing leftover record removal replay is idempotent after a lost response', async () => {
  const { core, repo } = setup({ linked: true })
  addStaleRecord(repo)
  const snapshot = await core.snapshot()
  const repository = snapshot.repos[0]!
  const stale = repository.worktrees.find(row => row.path === STALE)!
  const expected = { repoId: repository.repoId, worktreeId: stale.worktreeId, branch: stale.branch!, head: stale.head }
  const first = await core.remove({ operationId: 'op-stale-replay', expected, path: STALE })
  assert.equal(first.removed, true)
  const replay = await core.remove({ operationId: 'op-stale-replay', expected, path: STALE })
  assert.equal(replay.removed, true)
  assert.equal(replay.replayed, true)
  assert.equal(replay.next, 'none')
})

test('missing leftover record removal matches a DETACHED (branch-less) record', async () => {
  // The 2026-09 live record itself was detached: the drill left the worktree
  // on a bare commit (its HEAD file holds the object id, no branch ref), so
  // the sidebar row's branch fact is null and the name comes from the
  // directory basename. Removal must match the null identity exactly.
  const { core, repo } = setup({ linked: true })
  repo.existing.add(STALE)
  repo.worktrees.push({ path: STALE, branch: null, head: FEATURE_HEAD })
  repo.existing.delete(STALE)
  const snapshot = await core.snapshot()
  const repository = snapshot.repos[0]!
  const stale = repository.worktrees.find(row => row.path === STALE)!
  assert.equal(stale.status, 'missing')
  assert.equal(stale.branch, null)
  const removed = await core.remove({
    operationId: 'op-stale-detached',
    expected: { repoId: repository.repoId, worktreeId: stale.worktreeId, branch: null, head: stale.head },
    path: STALE,
  })
  assert.equal(removed.removed, true)
  assert.equal(removed.next, 'none')
  assert.equal(removed.branch, null)
  const after = await core.snapshot()
  assert.equal(after.repos[0]!.worktrees.some(row => row.path === STALE), false)
})

test('missing leftover record removal keeps the locked/main/ghost/identity guards', async () => {
  const { core, repo, workspaces } = setup({ linked: true })
  addStaleRecord(repo)
  const snapshot = await core.snapshot()
  const repository = snapshot.repos[0]!
  const staleRow = repository.worktrees.find(row => row.path === STALE)!
  const expected = { repoId: repository.repoId, worktreeId: staleRow.worktreeId, branch: staleRow.branch!, head: staleRow.head }
  // Locked leftover record: refuse (git worktree prune would skip it too).
  repo.worktrees.find(row => row.path === STALE)!.locked = true
  await assert.rejects(
    core.remove({ operationId: 'op-stale-locked', expected, path: STALE }),
    error => error instanceof GitWorktreeError && error.code === 'worktree-locked',
  )
  repo.worktrees.find(row => row.path === STALE)!.locked = false
  // A ghost workspace at the RAW path owns the record — never clean it
  // behind its registration (registration-first workspace flows own it).
  workspaces.push({ workspaceId: 'ghost-stale', path: STALE, sessionIds: [] })
  await assert.rejects(
    core.remove({ operationId: 'op-stale-ghost', expected, path: STALE }),
    error => error instanceof GitWorktreeError && error.code === 'workspace-registered',
  )
  workspaces.pop()
  // Repository identity mismatch: deterministic refusal.
  await assert.rejects(
    core.remove({ operationId: 'op-stale-repo', expected: { ...expected, repoId: `repo_${'0'.repeat(64)}` }, path: STALE }),
    error => error instanceof GitWorktreeError && error.code === 'expected-mismatch',
  )
  // Worktree identity mismatch: deterministic refusal.
  await assert.rejects(
    core.remove({ operationId: 'op-stale-wtid', expected: { ...expected, worktreeId: `worktree_${'0'.repeat(64)}` }, path: STALE }),
    error => error instanceof GitWorktreeError && error.code === 'expected-mismatch',
  )
  // None of the refusals ran a git mutation.
  assert.equal(mutationCalls(repo, 'remove').length, 0)
})

test('missing leftover record removal refuses when the directory reappears before the commit', async () => {
  const { core, repo } = setup({ linked: true })
  addStaleRecord(repo)
  const snapshot = await core.snapshot()
  const repository = snapshot.repos[0]!
  const stale = repository.worktrees.find(row => row.path === STALE)!
  // The directory comes back between the locating listing and the in-lock
  // commit listing: the record is a live worktree again — record-only
  // cleanup must refuse deterministically WITHOUT deleting a restored tree.
  let lists = 0
  repo.onWorktreeList = () => {
    lists += 1
    if (lists === 2) repo.existing.add(STALE)
  }
  await assert.rejects(
    core.remove({
      operationId: 'op-stale-race',
      expected: { repoId: repository.repoId, worktreeId: stale.worktreeId, branch: stale.branch!, head: stale.head },
      path: STALE,
    }),
    error => error instanceof GitWorktreeError && error.code === 'worktree-invalid',
  )
  assert.equal(mutationCalls(repo, 'remove').length, 0)
})

// ---------------------------------------------------------------------------
// Mid-flight directory vanish on the REMOVAL paths (invariant: no filesystem
// probe may touch a missing row). A row whose directory is externally deleted
// between the in-lock preflight and the mutation is resolved MISSING by the
// topology read; a dirty probe against it would spawn `git status` inside the
// gone cwd and fail with a spawn-ENOENT the degrade catches (path-unavailable
// only) cannot route — stalling convergence. Each removal site must skip the
// probe and converge through its existing missing-row handling instead. The
// fake models the spawn failure as a runner rejection above, so a leaked
// probe fails the removal outright.
// ---------------------------------------------------------------------------

const VANISH = '/repos/vanish-target'

function addVanishTarget(repo: FakeRepository): void {
  repo.addLinked({ path: VANISH, branch: 'vanish', head: FEATURE_HEAD })
}

function statusProbes(repo: FakeRepository, cwd: string): GitCommandRequest[] {
  // Only the removal dirty probes (isDirty, no --branch); the snapshot's own
  // `--branch` status reads are not removal probes.
  return repo.calls.filter(call => call.args[0] === 'status' && !call.args.includes('--branch') && call.cwd === cwd)
}

test('unregistered removal whose target vanishes between the in-lock preflight and the mutation degrades to record cleanup on the first attempt', async () => {
  const { core, repo } = setup({ linked: true })
  addVanishTarget(repo)
  const snapshot = await core.snapshot()
  const repository = snapshot.repos[0]!
  const target = repository.worktrees.find(row => row.path === VANISH)!
  const expected = { repoId: repository.repoId, worktreeId: target.worktreeId, branch: target.branch!, head: target.head }
  // The directory vanishes when the removal's FIRST topology listing runs: the
  // row's path probe right after it resolves the target as MISSING. The dirty
  // probe that follows would spawn git inside the gone cwd.
  let lists = 0
  repo.onWorktreeList = () => {
    lists += 1
    if (lists === 1) repo.existing.delete(VANISH)
  }
  const removed = await core.remove({ operationId: 'op-vanish-midflight', expected, path: VANISH })
  assert.equal(removed.removed, true)
  // Degraded ON THIS ATTEMPT (no same-id retry needed): the outer catch routed
  // the in-lock path-unavailable to the leftover-record cleanup, whose guards
  // were re-verified from scratch and whose mutation is a plain remove.
  assert.equal(removed.replayed, false)
  assert.equal(removed.next, 'none')
  const removeCalls = mutationCalls(repo, 'remove')
  assert.equal(removeCalls.length, 1)
  assert.deepEqual(removeCalls[0]!.args, ['worktree', 'remove', '--', VANISH])
  // The dirty probe never ran against the vanished cwd (it would have failed
  // the removal with the simulated spawn-ENOENT).
  assert.equal(statusProbes(repo, VANISH).length, 0)
  const after = await core.snapshot()
  assert.equal(after.repos[0]!.worktrees.some(row => row.path === VANISH), false)
})

test('no dirty probe is issued after a vanished-cwd row resolves at the in-lock commit', async () => {
  const { core, repo } = setup({ linked: true })
  addVanishTarget(repo)
  const snapshot = await core.snapshot()
  const repository = snapshot.repos[0]!
  const target = repository.worktrees.find(row => row.path === VANISH)!
  const expected = { repoId: repository.repoId, worktreeId: target.worktreeId, branch: target.branch!, head: target.head }
  // The directory survives the first topology read (the dirty probe still runs
  // against a LIVE cwd) but vanishes before the commit's in-lock re-read: the
  // row is MISSING at commitBoundRemove's final topology. The commit must not
  // re-probe it — the plain `git worktree remove` below clears the leftover
  // record under the re-verified in-lock identity guards.
  const listCount = (): number => repo.calls.filter(call => call.args[0] === 'worktree' && call.args[1] === 'list').length
  const listsBeforeRemove = listCount()
  let lists = 0
  repo.onWorktreeList = () => {
    lists += 1
    if (lists === 2) repo.existing.delete(VANISH)
  }
  const removed = await core.remove({ operationId: 'op-vanish-commit', expected, path: VANISH })
  assert.equal(removed.removed, true)
  assert.equal(removed.replayed, false)
  assert.equal(removed.next, 'none')
  const removeCalls = mutationCalls(repo, 'remove')
  assert.equal(removeCalls.length, 1)
  assert.deepEqual(removeCalls[0]!.args, ['worktree', 'remove', '--', VANISH])
  // Exactly ONE dirty probe was recorded — the pre-vanish one after the first
  // topology read — and none after the second listing of the removal (which
  // resolved the row missing; any later probe would have rejected with the
  // simulated spawn-ENOENT and failed the removal).
  const probes = statusProbes(repo, VANISH)
  assert.equal(probes.length, 1)
  const removeLists = repo.calls.filter(call => call.args[0] === 'worktree' && call.args[1] === 'list')
  const vanishList = removeLists[listsBeforeRemove + 1]!
  assert.ok(
    repo.calls.indexOf(probes[0]!) < repo.calls.indexOf(vanishList),
    'the only dirty probe ran before the row was resolved missing',
  )
})

test('registered removal replay with a vanished target converges without a dirty probe', async () => {
  const { core, repo } = setup({ linked: true })
  const snapshot = await core.snapshot()
  const repository = snapshot.repos[0]!
  const row = repository.worktrees.find(worktree => worktree.path === LINKED)!
  const expected = { repoId: repository.repoId, worktreeId: row.worktreeId, branch: row.branch!, head: row.head }
  // First attempt: the mutation-stage spawn fails retryably with the target
  // still present — the operation is left with a bound intent to reconcile.
  repo.throwBeforeRemove = new GitWorktreeError('git-spawn-failed', 'simulated ENOENT')
  await assert.rejects(
    core.remove({ operationId: 'op-reg-vanish', workspaceId: 'ws-feature', expected }),
    error => error instanceof GitWorktreeError && error.code === 'git-spawn-failed',
  )
  // The registered workspace's directory is now externally gone. The same-id
  // replay's registered branch must NOT dirty-probe the missing row (the spawn
  // would fail with the simulated spawn-ENOENT): it fails the deterministic
  // path-unavailable exactly like the first attempt's preflight, which routes
  // the workspace to its orphan (registration-only) flows.
  const probesBeforeReplay = statusProbes(repo, LINKED).length
  repo.existing.delete(LINKED)
  await assert.rejects(
    core.remove({ operationId: 'op-reg-vanish', workspaceId: 'ws-feature', expected }),
    error => error instanceof GitWorktreeError && error.code === 'path-unavailable',
  )
  assert.equal(statusProbes(repo, LINKED).length, probesBeforeReplay)
  // The replay never re-attempted the git mutation.
  assert.equal(mutationCalls(repo, 'remove').length, 1)
})

// ---------------------------------------------------------------------------
// 2026-09 review fixes: the harness home is resolved like upstream
// `resolveDshHome`, and the two remaining per-row agent columns (`status`,
// `cwd`) follow the same per-row rule as `origin` — conservative reading, loud
// diagnostic, never a whole-source darkness.
// ---------------------------------------------------------------------------

test('a blank or whitespace-only $DSH_HOME is UNSET: the default worktrees root follows upstream resolveDshHome', async () => {
  const previousDshHome = process.env.DSH_HOME
  try {
    // A blank override used to be joined verbatim, so the derived root was not
    // absolute and the constructor failed 'invalid-config' before any work.
    for (const blank of ['', '   ']) {
      process.env.DSH_HOME = blank
      const preview = await previewNew(setup({ worktreesRoot: null }).core)
      assert.equal(
        preview.targetPath,
        join(homedir(), '.dsh', 'worktrees', WORKTREES_KEY, 'new-worktree'),
        `DSH_HOME=${JSON.stringify(blank)} must fall back to ~/.dsh`,
      )
    }
    process.env.DSH_HOME = '/opt/dsh-home'
    const explicit = await previewNew(setup({ worktreesRoot: null }).core)
    assert.equal(
      explicit.targetPath,
      `/opt/dsh-home/worktrees/${WORKTREES_KEY}/new-worktree`,
      'an absolute $DSH_HOME is the resolved harness home',
    )
    process.env.DSH_HOME = '~/elsewhere'
    const tilded = await previewNew(setup({ worktreesRoot: null }).core)
    assert.equal(
      tilded.targetPath,
      join(homedir(), 'elsewhere', 'worktrees', WORKTREES_KEY, 'new-worktree'),
      'a ~-prefixed $DSH_HOME expands against the OS home (upstream expandHomePath)',
    )
  } finally {
    if (previousDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousDshHome
  }
})

test('an unrecognized agent status is read per row as RUNNING and reported loudly (never darkens the source)', async () => {
  const { core, repo, workspaces, agents } = setup({ linked: true })
  // `sessionIds` is readonly on the fact: replace the row instead of mutating it.
  workspaces[1] = { ...workspaces[1]!, sessionIds: [...workspaces[1]!.sessionIds, 's-status'] }
  agents.push({ sessionId: 's-status', status: 'paused' as unknown as 'running', cwd: LINKED })

  const snapshot = await core.snapshot()
  assert.equal(snapshot.sourceError, undefined,
    'one drifted status must NOT erase the whole domain (AGENTS: one failed entity must not block unrelated complete entities)')
  assert.equal(snapshot.repos.length, 1)
  const linked = snapshot.repos[0]!.worktrees.find(worktree => worktree.path === LINKED)!
  assert.deepEqual(linked.runningSessionIds, ['s-status'], 'an unknown status is not idle')
  assert.deepEqual(linked.blockingRunningSessionIds, ['s-status'],
    'fail-closed: an unreadable liveness fact keeps blocking')
  const diagnostic = snapshot.errors.find(error => error.code === 'agent-status-unknown')
  assert.notEqual(diagnostic, undefined, 'the drift is never silent')
  assert.match(diagnostic!.message, /s-status/)
  assert.match(diagnostic!.message, /paused/)
  // The removal guard agrees with the projection (same predicate).
  await assert.rejects(
    core.remove({
      operationId: 'drifted-status',
      workspaceId: 'ws-feature',
      expected: {
        repoId: snapshot.repos[0]!.repoId,
        worktreeId: linked.worktreeId,
        branch: linked.branch!,
        head: linked.head,
      },
    }),
    error => error instanceof GitWorktreeError && error.code === 'running-agent',
  )
  assert.equal(mutationCalls(repo, 'remove').length, 0)
})

test('a non-absolute running cwd keeps its BLOCKING semantics and stays fail-closed on the cwd-derived guard', async () => {
  const { core, repo, agents } = setup({ linked: true })
  const extra = repo.addLinked({ path: '/repos/unregistered', branch: 'unreg', head: FEATURE_HEAD })
  // UNGROUPED running row (no workspace membership) with an unusable cwd: the
  // path leg is the ONLY guard that can refuse this removal.
  agents.push({ sessionId: 's-cwd', status: 'running', cwd: 'relative/worktree' })

  const snapshot = await core.snapshot()
  assert.equal(snapshot.sourceError, undefined, 'one drifted cwd must NOT erase the whole domain')
  assert.equal(snapshot.repos.length, 1)
  const diagnostic = snapshot.errors.find(error => error.code === 'agent-cwd-unknown')
  assert.notEqual(diagnostic, undefined, 'the drift is never silent')
  assert.match(diagnostic!.message, /s-cwd/)
  assert.match(diagnostic!.message, /relative\/worktree/)

  const repository = snapshot.repos[0]!
  const row = repository.worktrees.find(worktree => worktree.path === extra.path)!
  const expected = { repoId: repository.repoId, worktreeId: row.worktreeId, branch: row.branch!, head: row.head }
  await assert.rejects(
    core.remove({ operationId: 'drifted-cwd', expected, path: extra.path }),
    error => error instanceof GitWorktreeError && error.code === 'running-agent-cwd-unavailable',
    'an unknown running location must refuse the removal rather than assume it is unrelated',
  )
  assert.equal(mutationCalls(repo, 'remove').length, 0)
  // The SAME source read still serves the other removal leg: a workspace-level
  // removal is refused by the identical cwd-derived guard instead of a
  // source-wide failure, and nothing is mutated either.
  const registered = repository.worktrees.find(worktree => worktree.path === LINKED)!
  await assert.rejects(
    core.remove({
      operationId: 'drifted-cwd-registered',
      workspaceId: 'ws-feature',
      expected: {
        repoId: repository.repoId,
        worktreeId: registered.worktreeId,
        branch: registered.branch!,
        head: registered.head,
      },
    }),
    error => error instanceof GitWorktreeError && error.code === 'running-agent-cwd-unavailable',
  )
  assert.equal(mutationCalls(repo, 'remove').length, 0)
})
