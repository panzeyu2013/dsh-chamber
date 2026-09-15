/**
 * Git worktree core — the archived-aware running guard on removal, snapshot and record-only legs.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GitWorktreeCore, GitWorktreeError } from '../src/core.ts'
import {
  MAIN,
  LINKED,
  FEATURE_HEAD,
  FakeRepository,
  setup,
  mutationCalls,
  STALE,
  addStaleRecord,
} from './support/fake-repository.ts'

test('remove rejects running agent and stale expected state, then returns Git-first recovery data', async () => {
  const { core, repo, agents, workspaces } = setup({ linked: true })
  const snapshot = await core.snapshot()
  const repository = snapshot.repos[0]!
  const linked = repository.worktrees.find(worktree => worktree.path === LINKED)!
  const expected = {
    repoId: repository.repoId,
    worktreeId: linked.worktreeId,
    branch: linked.branch!,
    head: linked.head,
  }
  repo.existing.add(`${LINKED}/subagent`)
  agents.push({ sessionId: 's-unaccounted', status: 'running', cwd: `${LINKED}/subagent` })
  await assert.rejects(
    core.remove({ operationId: 'remove-running', workspaceId: 'ws-feature', expected }),
    error => error instanceof GitWorktreeError && error.code === 'running-agent',
  )
  agents.length = 0
  await assert.rejects(
    core.remove({
      operationId: 'remove-stale',
      workspaceId: 'ws-feature',
      expected: { ...expected, head: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    }),
    error => error instanceof GitWorktreeError && error.code === 'expected-mismatch',
  )

  const removed = await core.remove({ operationId: 'remove-ok', workspaceId: 'ws-feature', expected })
  assert.equal(removed.removed, true)
  assert.equal(removed.next, 'delete-workspace')
  assert.deepEqual(removed.sessionIds, ['s-feature'])
  assert.equal(removed.branchPreserved, true)
  assert.equal(workspaces.some(workspace => workspace.workspaceId === 'ws-feature'), true)
  assert.equal(repo.branches.has('feature'), true)
  assert.deepEqual(mutationCalls(repo, 'remove').at(-1)!.args, ['worktree', 'remove', '--', LINKED])
  assert.equal(repo.calls.some(call => call.args.includes('--force')), false)
  assert.equal(repo.calls.some(call => call.args[0] === 'branch'), false)

  const replay = await core.remove({ operationId: 'remove-ok', workspaceId: 'ws-feature', expected })
  assert.equal(replay.replayed, true)
  assert.equal(mutationCalls(repo, 'remove').length, 1)
  workspaces.splice(workspaces.findIndex(workspace => workspace.workspaceId === 'ws-feature'), 1)
  const replayAfterWorkspaceDelete = await core.remove({
    operationId: 'remove-ok',
    workspaceId: 'ws-feature',
    expected,
  })
  assert.equal(replayAfterWorkspaceDelete.replayed, true)
  assert.equal(mutationCalls(repo, 'remove').length, 1)
})

test('the running guard is archived-aware: an archived running session is INERT and does not block (2026-09 user decision)', async () => {
  const { core, repo, agents, workspaces, archived } = setup({ linked: true })
  const snapshot = await core.snapshot()
  const repository = snapshot.repos[0]!
  const linked = repository.worktrees.find(worktree => worktree.path === LINKED)!
  const expected = {
    repoId: repository.repoId,
    worktreeId: linked.worktreeId,
    branch: linked.branch!,
    head: linked.head,
  }
  // A running workspace MEMBER: without an archived fact it blocks, exactly as
  // before (same code, same message).
  agents.push({ sessionId: 's-feature', status: 'running', cwd: LINKED })
  await assert.rejects(
    core.remove({ operationId: 'running-non-archived', workspaceId: 'ws-feature', expected }),
    error => error instanceof GitWorktreeError
      && error.code === 'running-agent'
      && /s-feature/.test(error.message),
  )
  assert.equal(mutationCalls(repo, 'remove').length, 0, 'a refusal never mutates')

  // The SAME running member, now archived: inert → the removal proceeds and
  // the host touches no session (it neither stops nor deletes anything).
  archived.push('s-feature')
  const removed = await core.remove({ operationId: 'running-archived', workspaceId: 'ws-feature', expected })
  assert.equal(removed.removed, true)
  assert.deepEqual(removed.sessionIds, ['s-feature'], 'membership is still reported for the client workspace.delete')
  assert.equal(agents.length, 1, 'the running agent fact is never mutated by the removal')
  assert.equal(workspaces.some(workspace => workspace.workspaceId === 'ws-feature'), true,
    'the workspace registration is the CLIENT next step, never deleted here')
})

test('an archived ANCESTOR makes a running subagent descendant inert', async () => {
  const { core, repo, agents, archived } = setup({ linked: true })
  repo.existing.add(`${LINKED}/sub`)
  const snapshot = await core.snapshot()
  const repository = snapshot.repos[0]!
  const linked = repository.worktrees.find(worktree => worktree.path === LINKED)!
  const expected = {
    repoId: repository.repoId,
    worktreeId: linked.worktreeId,
    branch: linked.branch!,
    head: linked.head,
  }
  // child (running, SUBAGENT-origin) → parent (loaded, idle, ARCHIVED). The
  // child has no archived fact of its own: the chain walk is what makes it
  // inert. `origin: 'subagent'` is what makes the edge lineage at all — a
  // bare `parentSessionId` is FORK lineage and never walked (see the fork
  // test below).
  agents.push({ sessionId: 'parent', status: 'idle' })
  agents.push({ sessionId: 'child', status: 'running', cwd: `${LINKED}/sub`, parentSessionId: 'parent', origin: 'subagent' })
  await assert.rejects(
    core.remove({ operationId: 'chain-non-archived', workspaceId: 'ws-feature', expected }),
    error => error instanceof GitWorktreeError && error.code === 'running-agent',
  )
  archived.push('parent')
  const removed = await core.remove({ operationId: 'chain-archived', workspaceId: 'ws-feature', expected })
  assert.equal(removed.removed, true)
  assert.deepEqual(mutationCalls(repo, 'remove').at(-1)!.args, ['worktree', 'remove', '--', LINKED],
    'inertness never implies --force: dirty semantics are untouched')
  // An ARCHIVED-BUT-UNLOADED ancestor still wins: the parent row is dropped
  // from the agent registry, so the walk resolves it from the archived set
  // alone (never treated as an unresolvable chain).
  repo.addLinked()
  agents.length = 0
  agents.push({ sessionId: 'child', status: 'running', cwd: `${LINKED}/sub`, parentSessionId: 'parent', origin: 'subagent' })
  const unloaded = await core.remove({ operationId: 'chain-archived-unloaded', workspaceId: 'ws-feature', expected })
  assert.equal(unloaded.removed, true)
})

test('a running FORK of an archived session is NOT inert: fork lineage is not subagent lineage', async () => {
  const { core, repo, agents, workspaces, archived } = setup({ linked: true })
  const snapshot = await core.snapshot()
  const repository = snapshot.repos[0]!
  const linked = repository.worktrees.find(worktree => worktree.path === LINKED)!
  const expected = {
    repoId: repository.repoId,
    worktreeId: linked.worktreeId,
    branch: linked.branch!,
    head: linked.head,
  }
  // Upstream `session/fork` records `parentSession` with NO `origin`; only
  // delegation children carry `origin: 'subagent'`. The fork is an INDEPENDENT
  // running session: the archived source says nothing about its run, so the
  // edge must terminate the walk instead of inheriting inertness.
  archived.push('source-session')
  agents.push({ sessionId: 'source-session', status: 'idle' })
  // MEMBERSHIP leg: the fork is a workspace member (its cwd sits elsewhere).
  workspaces[1] = { ...workspaces[1]!, sessionIds: ['forked'] }
  agents.push({ sessionId: 'forked', status: 'running', cwd: `${MAIN}/elsewhere`, parentSessionId: 'source-session' })
  await assert.rejects(
    core.remove({ operationId: 'fork-member', workspaceId: 'ws-feature', expected }),
    error => error instanceof GitWorktreeError
      && error.code === 'running-agent'
      && /forked/.test(error.message),
  )
  assert.equal(mutationCalls(repo, 'remove').length, 0, 'a refusal never mutates')
  // PATH leg: ungrouped fork whose cwd sits inside the worktree.
  workspaces[1] = { ...workspaces[1]!, sessionIds: [] }
  agents.length = 0
  agents.push({ sessionId: 'source-session', status: 'idle' })
  agents.push({ sessionId: 'forked', status: 'running', cwd: LINKED, parentSessionId: 'source-session' })
  await assert.rejects(
    core.remove({ operationId: 'fork-path', workspaceId: 'ws-feature', expected }),
    error => error instanceof GitWorktreeError
      && error.code === 'running-agent'
      && /cwd/.test(error.message),
  )
  assert.equal(mutationCalls(repo, 'remove').length, 0)
})

test('subagent cycle rule: archived-free cycles are never inert, a cycle WITH an archived member is', async () => {
  const { core, repo, agents, archived } = setup({ linked: true })
  repo.existing.add(`${LINKED}/sub`)
  const snapshot = await core.snapshot()
  const repository = snapshot.repos[0]!
  const linked = repository.worktrees.find(worktree => worktree.path === LINKED)!
  const expected = {
    repoId: repository.repoId,
    worktreeId: linked.worktreeId,
    branch: linked.branch!,
    head: linked.head,
  }
  // Both members SUBAGENT-origin (so the walk really reaches the cycle guard
  // instead of stopping at a fork edge).
  agents.push({ sessionId: 'a', status: 'running', cwd: `${LINKED}/sub`, parentSessionId: 'b', origin: 'subagent' })
  agents.push({ sessionId: 'b', status: 'idle', parentSessionId: 'a', origin: 'subagent' })
  await assert.rejects(
    core.remove({ operationId: 'cycle-archived-free', workspaceId: 'ws-feature', expected }),
    error => error instanceof GitWorktreeError && error.code === 'running-agent',
    'a cycle with no archived member proves nothing: fail closed',
  )
  // The archived test runs BEFORE the cycle guard: an archived member reached
  // through the cycle is positive proof that the run is done (documented rule).
  archived.push('b')
  const removed = await core.remove({ operationId: 'cycle-archived-member', workspaceId: 'ws-feature', expected })
  assert.equal(removed.removed, true)
  assert.deepEqual(mutationCalls(repo, 'remove').at(-1)!.args, ['worktree', 'remove', '--', LINKED])
})

test('an UNRESOLVABLE parent chain is never inert (fail closed)', async () => {
  const { core, repo, agents, archived } = setup({ linked: true })
  repo.existing.add(`${LINKED}/sub`)
  const snapshot = await core.snapshot()
  const repository = snapshot.repos[0]!
  const linked = repository.worktrees.find(worktree => worktree.path === LINKED)!
  const expected = {
    repoId: repository.repoId,
    worktreeId: linked.worktreeId,
    branch: linked.branch!,
    head: linked.head,
  }
  // 'ghost' is neither loaded nor archived: the chain cannot be resolved, so
  // the running child keeps blocking (never guess an archived ancestor).
  agents.push({
    sessionId: 'child',
    status: 'running',
    cwd: `${LINKED}/sub`,
    parentSessionId: 'ghost',
    origin: 'subagent',
  })
  await assert.rejects(
    core.remove({ operationId: 'chain-unresolvable', workspaceId: 'ws-feature', expected }),
    error => error instanceof GitWorktreeError && error.code === 'running-agent',
  )
  // A subagent-origin row WITHOUT a recorded parent cannot resolve to an
  // ancestor either: fail closed.
  agents.length = 0
  agents.push({ sessionId: 'orphan-subagent', status: 'running', cwd: `${LINKED}/sub`, origin: 'subagent' })
  await assert.rejects(
    core.remove({ operationId: 'chain-parentless-subagent', workspaceId: 'ws-feature', expected }),
    error => error instanceof GitWorktreeError && error.code === 'running-agent',
  )
  assert.equal(archived.length, 0)
  assert.equal(mutationCalls(repo, 'remove').length, 0)
})

test('the PATH-level running leg is archived-aware too (a running cwd inside the worktree)', async () => {
  const { core, repo, agents, archived } = setup({ linked: true })
  repo.existing.add(`${LINKED}/sub`)
  const snapshot = await core.snapshot()
  const repository = snapshot.repos[0]!
  const linked = repository.worktrees.find(worktree => worktree.path === LINKED)!
  const expected = {
    repoId: repository.repoId,
    worktreeId: linked.worktreeId,
    branch: linked.branch!,
    head: linked.head,
  }
  // An UNGROUPED running session (not a workspace member) whose cwd sits inside
  // the worktree: the path leg is what catches it.
  agents.push({ sessionId: 's-ungrouped', status: 'running', cwd: `${LINKED}/sub` })
  await assert.rejects(
    core.remove({ operationId: 'path-non-archived', workspaceId: 'ws-feature', expected }),
    error => error instanceof GitWorktreeError
      && error.code === 'running-agent'
      && /cwd/.test(error.message),
  )
  archived.push('s-ungrouped')
  const removed = await core.remove({ operationId: 'path-archived', workspaceId: 'ws-feature', expected })
  assert.equal(removed.removed, true)
})

test('snapshot projects runningSessionIds (all) and blockingRunningSessionIds (non-inert)', async () => {
  const { core, repo, agents, archived } = setup({ linked: true })
  repo.existing.add(`${LINKED}/sub`)
  agents.push({ sessionId: 's-feature', status: 'running', cwd: LINKED })
  agents.push({ sessionId: 's-block', status: 'running', cwd: `${LINKED}/sub` })
  archived.push('s-feature')
  const snapshot = await core.snapshot()
  const linked = snapshot.repos[0]!.worktrees.find(worktree => worktree.path === LINKED)!
  // Display fact: every running session stays visible (an old client reading
  // only this field remains conservative).
  assert.deepEqual([...linked.runningSessionIds].sort(), ['s-block', 's-feature'])
  // Blocking fact: the archived one is inert, the other still gates removal.
  assert.deepEqual(linked.blockingRunningSessionIds, ['s-block'])
})

test('an archived RUNNING session is inert on the PATH and SNAPSHOT legs too, but its fork descendant is not', async () => {
  const { core, agents, archived } = setup({ linked: true })
  agents.push({ sessionId: 'archived-runner', status: 'running', cwd: `${LINKED}/sub` })
  agents.push({
    sessionId: 'forked',
    status: 'running',
    cwd: `${LINKED}/sub`,
    parentSessionId: 'archived-runner',
  })
  archived.push('archived-runner')
  const snapshot = await core.snapshot()
  const linked = snapshot.repos[0]!.worktrees.find(worktree => worktree.path === LINKED)!
  assert.deepEqual([...linked.runningSessionIds].sort(), ['archived-runner', 'forked'])
  assert.deepEqual(linked.blockingRunningSessionIds, ['forked'],
    'only the fork edge is lineage: the archived parent is inert, its fork is not')
})

// ---------------------------------------------------------------------------
// 2026-09 fail-open fix: the archived set is the ONLY fact that can make a
// running session inert, so a drifted/unreadable `archivedSessionIds` must
// fail LOUDLY on every entry point (snapshot AND the removal legs) — never
// degrade to "nothing archived" (which would silently un-inert a live run)
// and never degrade to "everything archived" either.
// ---------------------------------------------------------------------------

test('a throwing or non-array archivedSessionIds source fails snapshot AND remove loudly, mutating nothing', async () => {
  const cases = [
    { name: 'throw', mode: 'throw', code: 'state-source-unavailable' },
    { name: 'non-array', mode: 'non-array', code: 'state-source-invalid' },
    { name: 'non-string element', mode: 'non-string', code: 'state-source-invalid' },
    { name: 'empty element', mode: 'empty', code: 'state-source-invalid' },
  ] as const
  for (const testCase of cases) {
    const repo = new FakeRepository()
    repo.addLinked()
    let mode: string = 'ok'
    const core = new GitWorktreeCore({
      source: {
        listWorkspaces: () => [{ workspaceId: 'ws-feature', path: LINKED, sessionIds: ['s-feature'] }],
        listAgents: () => [{ sessionId: 's-feature', status: 'running', cwd: LINKED }],
        listArchivedSessionIds: () => {
          if (mode === 'throw') throw new Error('archived set offline')
          if (mode === 'non-array') return 's-feature' as unknown as readonly string[]
          if (mode === 'non-string') return ['s-feature', 42] as unknown as readonly string[]
          if (mode === 'empty') return ['']
          return []
        },
      },
      git: repo.runner,
      fs: repo.fs,
      worktreesRoot: '/worktrees',
    })
    // Healthy read first: capture the REAL opaque identities of the row.
    const healthy = await core.snapshot()
    const linked = healthy.repos[0]!.worktrees.find(worktree => worktree.path === LINKED)!
    mode = testCase.mode
    // SNAPSHOT: a loud sourceError, never an empty success (the snapshot
    // collapses every non-capacity source failure to state-source-unavailable;
    // the underlying detail rides the message).
    const failed = await core.snapshot()
    assert.notEqual(failed.sourceError, undefined, `${testCase.name}: snapshot must fail loudly`)
    assert.equal(failed.sourceError!.code, 'state-source-unavailable', testCase.name)
    assert.deepEqual(failed.repos, [], `${testCase.name}: never an empty success`)
    // REMOVE: the mutation legs re-read the same source and throw the exact
    // readSource code — nothing is mutated.
    await assert.rejects(
      core.remove({
        operationId: `archived-drift-${testCase.mode}`,
        workspaceId: 'ws-feature',
        expected: {
          repoId: healthy.repos[0]!.repoId,
          worktreeId: linked.worktreeId,
          branch: linked.branch!,
          head: linked.head,
        },
      }),
      error => error instanceof GitWorktreeError && error.code === testCase.code,
      `${testCase.name}: the removal legs re-read the same source and must fail identically`,
    )
    assert.equal(mutationCalls(repo, 'remove').length, 0, `${testCase.name}: nothing was mutated`)
  }
})

test('a drifted agent origin is handled PER ROW and reported loudly (never darkens the domain)', async () => {
  const { core, repo, agents, archived } = setup({ linked: true })
  // The drifted row keeps its recorded parent edge, but an unrecognized origin
  // means "not subagent-origin": the edge terminates, so the running session
  // keeps blocking even though its parent is archived.
  archived.push('parent')
  agents.push({ sessionId: 'parent', status: 'idle' })
  agents.push({
    sessionId: 'drifted',
    status: 'running',
    cwd: LINKED,
    parentSessionId: 'parent',
    origin: 'fork' as unknown as 'subagent',
  })
  const snapshot = await core.snapshot()
  assert.equal(snapshot.sourceError, undefined,
    'one drifted row must NOT erase the whole domain (AGENTS: one failed entity must not block unrelated complete entities)')
  assert.equal(snapshot.repos.length, 1)
  const linked = snapshot.repos[0]!.worktrees.find(worktree => worktree.path === LINKED)!
  assert.deepEqual(linked.blockingRunningSessionIds, ['drifted'],
    'fail-closed: an unrecognized origin is not subagent-origin, so the session blocks')
  const diagnostic = snapshot.errors.find(error => error.code === 'agent-origin-unknown')
  assert.notEqual(diagnostic, undefined, 'the drift is never silent')
  assert.match(diagnostic!.message, /drifted/)
  assert.match(diagnostic!.message, /fork/)
  // The removal guard agrees with the projection (same predicate).
  await assert.rejects(
    core.remove({
      operationId: 'drifted-origin',
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

// ---------------------------------------------------------------------------
// The UNREGISTERED and RECORD-ONLY removal legs run their own running guard
// (or provably need none); before this round no test exercised them with a
// running/archived session at all, so deleting those guards stayed green.
// ---------------------------------------------------------------------------

test('unregistered removal honors the archived-aware running guard on its path leg', async () => {
  const { core, repo, agents, archived } = setup()
  const extra = repo.addLinked({ path: '/repos/unregistered', branch: 'unreg', head: FEATURE_HEAD })
  const snapshot = await core.snapshot()
  const repository = snapshot.repos[0]!
  const row = repository.worktrees.find(worktree => worktree.path === extra.path)!
  const expected = { repoId: repository.repoId, worktreeId: row.worktreeId, branch: row.branch!, head: row.head }
  // A running session whose cwd sits inside the unregistered path blocks it.
  agents.push({ sessionId: 's-live', status: 'running', cwd: `${extra.path}/sub` })
  await assert.rejects(
    core.remove({ operationId: 'unregistered-running', expected, path: extra.path }),
    error => error instanceof GitWorktreeError
      && error.code === 'running-agent'
      && /cwd/.test(error.message),
  )
  assert.equal(mutationCalls(repo, 'remove').length, 0)
  // Archived → inert: the same unregistered removal proceeds.
  archived.push('s-live')
  const removed = await core.remove({ operationId: 'unregistered-archived', expected, path: extra.path })
  assert.equal(removed.removed, true)
  assert.equal(removed.next, 'none')
})

test('record-only removal of a missing leftover runs no running probe but keeps the archived fact authoritative', async () => {
  const { core, repo, agents, archived } = setup({ linked: true })
  addStaleRecord(repo)
  const snapshot = await core.snapshot()
  const repository = snapshot.repos[0]!
  const stale = repository.worktrees.find(row => row.path === STALE)!
  const expected = { repoId: repository.repoId, worktreeId: stale.worktreeId, branch: stale.branch!, head: stale.head }
  // A running session (archived or not) whose cwd is under the VANISHED path
  // cannot be probed; the record-only cleanup has no filesystem content to
  // protect and must still converge (the guard never invents a block from an
  // unresolvable cwd, and never silently treats the path as running either).
  agents.push({ sessionId: 's-archived', status: 'running', cwd: `${STALE}/sub` })
  archived.push('s-archived')
  const removed = await core.remove({ operationId: 'record-only-archived', expected, path: STALE })
  assert.equal(removed.removed, true)
  assert.equal(removed.next, 'none')
  assert.deepEqual(mutationCalls(repo, 'remove').at(-1)!.args, ['worktree', 'remove', '--', STALE])
})
