/**
 * Git worktree core — snapshot row classification, branch/upstream reads and the discovery cache.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { basename, resolve } from 'node:path'
import {
  GitWorktreeCore,
  GitWorktreeError,
  MAX_REPOSITORIES,
  PREVIEW_TTL_MS,
  assertSafeGitArgv,
  createLocalGitRunner,
  type GitRunner,
  type WorkspaceFact,
  parseBranchLine,
} from '../src/core.ts'
import {
  MAIN,
  COMMON,
  LINKED,
  MAIN_HEAD,
  FEATURE_HEAD,
  FakeGitChild,
  coreOver,
  pathSetFs,
  setup,
  previewNew,
  mutationCalls,
} from './support/fake-repository.ts'

/** Bounded poll: the git timeout timer is unref'ed, so a plain sleep raced
 * CI stalls; wait on the observable side effect instead. */
async function waitFor(predicate: () => boolean, what: string, timeoutMs = 2_000): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail(`${what} did not become true within ${timeoutMs}ms`)
}

test('snapshot classifies a vanished worktree path as missing', async () => {
  const { core, repo } = setup({ linked: true })
  const linked = repo.worktrees[1]!
  repo.existing.delete(linked.path)
  const snapshot = await core.snapshot()
  const row = snapshot.repos[0]!.worktrees[1]!
  assert.equal(row.status, 'missing')
  assert.equal(row.dirty, null)
})

test('snapshot classifies a non-git path as not-a-repo', async () => {
  const { core, repo } = setup({ linked: true })
  repo.worktrees[1]!.statusFailure = true
  repo.worktrees[1]!.statusStderr = 'fatal: not a git repository: /repos/feature/.git'
  const snapshot = await core.snapshot()
  const row = snapshot.repos[0]!.worktrees[1]!
  assert.equal(row.status, 'not-a-repo')
  assert.equal(snapshot.errors.some(error => error.operation === 'status' && error.path === LINKED), true)
})

test('snapshot classifies a failing status as invalid', async () => {
  const { core, repo } = setup({ linked: true })
  repo.worktrees[1]!.statusFailure = true
  const snapshot = await core.snapshot()
  const row = snapshot.repos[0]!.worktrees[1]!
  assert.equal(row.status, 'invalid')
})

test('snapshot classifies branch, detached and unborn heads', async () => {
  const { core, repo } = setup({ linked: true })
  repo.addLinked({ path: '/repos/unborn', branch: 'unborn', head: '0'.repeat(40) })
  repo.addLinked({ path: '/repos/detached', branch: null, head: FEATURE_HEAD })
  const snapshot = await core.snapshot()
  const rows = snapshot.repos[0]!.worktrees
  assert.equal(rows.find(row => row.path === MAIN)!.headState, 'branch')
  assert.equal(rows.find(row => row.path === '/repos/unborn')!.headState, 'unborn')
  assert.equal(rows.find(row => row.path === '/repos/detached')!.headState, 'detached')
})

test('snapshot detects in-progress git operations from git-dir state files', async () => {
  const { core, repo } = setup({ linked: true })
  const linkedGitDir = `${COMMON}/worktrees/feature`
  repo.gitDirs.set(LINKED, linkedGitDir)
  repo.gitDirStateFiles.set(linkedGitDir, new Set(['MERGE_HEAD', 'BISECT_LOG']))
  repo.gitDirStateFiles.set(COMMON, new Set(['CHERRY_PICK_HEAD']))
  const snapshot = await core.snapshot()
  const rows = snapshot.repos[0]!.worktrees
  const linked = rows.find(row => row.path === LINKED)!
  assert.deepEqual(linked.attention, ['merge', 'bisect'])
  const main = rows.find(row => row.path === MAIN)!
  assert.deepEqual(main.attention, ['cherry-pick'])
})

test('snapshot attention stays empty for an unresolvable git dir', async () => {
  const { core, repo } = setup({ linked: true })
  // No gitDirs registration: the linked .git pointer read fails -> no attention.
  const snapshot = await core.snapshot()
  const row = snapshot.repos[0]!.worktrees[1]!
  assert.deepEqual(row.attention, [])
  assert.equal(row.status, 'ready')
})

test('snapshot caps the repository count at MAX_REPOSITORIES', async () => {
  const repositoryCount = MAX_REPOSITORIES + 1
  const paths = new Set<string>()
  const workspaces: WorkspaceFact[] = []
  for (let repository = 0; repository < repositoryCount; repository += 1) {
    const main = `/cap/${repository}/main`
    paths.add(main)
    paths.add(`${main}/.git`)
    workspaces.push({ workspaceId: `cap-${repository}`, path: main, sessionIds: [] })
  }
  const fs = pathSetFs(paths)
  const runner: GitRunner = async request => {
    const match = /^\/cap\/(\d+)\//u.exec(request.cwd)
    assert.ok(match)
    const main = `/cap/${Number(match[1])}/main`
    if (request.args[0] === 'rev-parse') {
      return { exitCode: 0, stdout: `${main}/.git\n`, stderr: '' }
    }
    if (request.args[0] === 'worktree') {
      return { exitCode: 0, stdout: `worktree ${main}\0HEAD ${MAIN_HEAD}\0branch refs/heads/main\0\0`, stderr: '' }
    }
    if (request.args[0] === 'status') return { exitCode: 0, stdout: '', stderr: '' }
    throw new Error(`unexpected Git call: ${request.args.join(' ')}`)
  }
  const core = coreOver({ workspaces, git: runner, fs })
  const snapshot = await core.snapshot()
  assert.equal(snapshot.repos.length, MAX_REPOSITORIES)
  assert.equal(snapshot.sourceError?.code, 'snapshot-capacity')
  assert.equal(snapshot.errors.some(error => error.code === 'snapshot-repository-limit'), true)
})

test('preview rejects a checked-out branch and a bare repository', async () => {
  const { core } = setup()
  await assert.rejects(
    core.previewCreate({
      sourceWorkspaceId: 'ws-main',
      basename: 'x',
      branch: { kind: 'existing', name: 'main' },
    }),
    error => error instanceof GitWorktreeError && error.code === 'branch-checked-out',
  )
  const { core: bareCore, repo: bareRepo } = setup()
  bareRepo.worktrees[0]!.bare = true
  await assert.rejects(
    bareCore.previewCreate({
      sourceWorkspaceId: 'ws-main',
      basename: 'x',
      branch: { kind: 'new', name: 'topic' },
    }),
    error => error instanceof GitWorktreeError && error.code === 'bare-repository',
  )
})

test('preview rejects a new branch that already exists', async () => {
  const { core, repo } = setup()
  repo.branches.set('feature', FEATURE_HEAD)
  await assert.rejects(
    core.previewCreate({
      sourceWorkspaceId: 'ws-main',
      basename: 'x',
      branch: { kind: 'new', name: 'feature' },
    }),
    error => error instanceof GitWorktreeError && error.code === 'branch-exists',
  )
})

test('create fails loud on an unknown or expired preview token', async () => {
  const { core, advanceTime } = setup()
  await assert.rejects(
    core.create({ previewToken: 'unknown-token', operationId: 'op-unknown' }),
    error => error instanceof GitWorktreeError && error.code === 'preview-not-found',
  )
  const preview = await previewNew(core)
  advanceTime(PREVIEW_TTL_MS + 1)
  // pruneCaches removes expired previews before the lookup, so an expired
  // token surfaces as preview-not-found (the preview-expired branch is the
  // narrow race backstop between prune and check).
  await assert.rejects(
    core.create({ previewToken: preview.previewToken, operationId: 'op-expired' }),
    error => error instanceof GitWorktreeError && error.code === 'preview-not-found',
  )
})

test('duplicate workspace paths surface explicitly and never duplicate ownership', async () => {
  const { core, workspaces } = setup()
  workspaces.push({ workspaceId: 'ws-dupe', path: MAIN, sessionIds: [] })
  const snapshot = await core.snapshot()
  assert.equal(snapshot.errors.some(error => error.code === 'duplicate-workspace-path'), true)
  const workspaceIds = snapshot.repos.flatMap(repo => repo.worktrees)
    .map(worktree => worktree.workspaceId)
    .filter((id): id is string => id !== null)
  assert.equal(workspaceIds.filter(id => id === 'ws-main').length, 1)
  assert.equal(workspaceIds.includes('ws-dupe'), false)
})

test('rollback refuses a worktree that now hosts a running agent cwd', async () => {
  const { core, agents } = setup()
  const preview = await previewNew(core)
  const created = await core.create({ previewToken: preview.previewToken, operationId: 'op-rollback-running' })
  assert.equal(created.rollbackAuthorized, true)
  agents.push({ sessionId: 's-inside', status: 'running', cwd: created.path })
  await assert.rejects(
    core.rollbackCreate({ operationId: 'op-rollback-running' }),
    error => error instanceof GitWorktreeError && error.code === 'running-agent',
  )
})

test('remove replay with the same operation id but a drifted expected head fails closed', async () => {
  const { core, repo } = setup({ linked: true })
  const snapshot = await core.snapshot()
  const repository = snapshot.repos[0]!
  const linked = repository.worktrees.find(worktree => worktree.path === LINKED)!
  const input = {
    operationId: 'op-drift',
    workspaceId: 'ws-feature',
    expected: {
      repoId: repository.repoId,
      worktreeId: linked.worktreeId,
      branch: linked.branch,
      head: linked.head,
    },
  }
  await core.remove(input)
  await assert.rejects(
    core.remove({ ...input, expected: { ...input.expected, head: 'f'.repeat(40) } }),
    error => error instanceof GitWorktreeError && error.code === 'operation-conflict',
  )
  assert.equal(mutationCalls(repo, 'remove').length, 1)
})

test('local runner times out, kills the child and only settles after close', async () => {
  const child = new FakeGitChild()
  const runner = createLocalGitRunner(() => child)
  const pending = runner({
    cwd: MAIN, args: ['status', '--porcelain=v1', '-z', '--untracked-files=normal'],
    timeoutMs: 5, maxOutputBytes: 4096,
  })
  let settled = false
  void pending.then(
    () => { settled = true },
    () => { settled = true },
  )
  await waitFor(() => child.killed === true, 'the 5ms git timeout killed the child')
  assert.equal(settled, false)
  child.emit('close', null)
  await assert.rejects(
    pending,
    error => error instanceof GitWorktreeError && error.code === 'git-timeout',
  )
  assert.equal(settled, true)
})

test('local runner enforces a combined stdout+stderr byte cap', async () => {
  const child = new FakeGitChild()
  const runner = createLocalGitRunner(() => child)
  const pending = runner({
    cwd: MAIN, args: ['status', '--porcelain=v1', '-z', '--untracked-files=normal'],
    timeoutMs: 1_000, maxOutputBytes: 8,
  })
  let settled = false
  void pending.then(
    () => { settled = true },
    () => { settled = true },
  )
  child.stdout.emit('data', Buffer.from('12345'))
  child.stderr.emit('data', Buffer.from('678'))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(child.killed, false)
  child.stdout.emit('data', Buffer.from('9'))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(child.killed, true)
  child.emit('close', null)
  await assert.rejects(
    pending,
    error => error instanceof GitWorktreeError && error.code === 'git-output-limit',
  )
  assert.equal(settled, true)
})

test('snapshot attention resolves a RELATIVE gitdir pointer against the worktree path', async () => {
  const { core, repo } = setup({ linked: true })
  const relativeGitDir = '../.git/worktrees/feature'
  repo.pointerOverrides.set(`${LINKED}/.git`, `gitdir: ${relativeGitDir}`)
  const resolved = resolve(LINKED, relativeGitDir)
  repo.gitDirStateFiles.set(resolved, new Set(['REVERT_HEAD']))
  const snapshot = await core.snapshot()
  const row = snapshot.repos[0]!.worktrees.find(worktree => worktree.path === LINKED)!
  assert.deepEqual(row.attention, ['revert'])
})

test('snapshot attention stays empty for a malformed gitdir pointer', async () => {
  const { core, repo } = setup({ linked: true })
  repo.pointerOverrides.set(`${LINKED}/.git`, 'not-a-gitdir-line')
  const snapshot = await core.snapshot()
  const row = snapshot.repos[0]!.worktrees.find(worktree => worktree.path === LINKED)!
  assert.deepEqual(row.attention, [])
})

test('snapshot lists local branches via show-ref --heads for the existing-branch picker', async () => {
  const { core, repo } = setup({ linked: true })
  repo.branches.set('feature/x', FEATURE_HEAD)
  const snapshot = await core.snapshot()
  assert.equal(snapshot.repos.length, 1)
  // 'main' is the FakeRepository default; show-ref --heads lists all heads.
  assert.deepEqual(snapshot.repos[0]!.branches, ['main', 'feature', 'feature/x'])
  // show-ref --heads must be the allowed fixed-flag form; anything else fails.
  assert.throws(() => assertSafeGitArgv(['show-ref', '--heads', 'refs/heads/main']), /outside the worktree allowlist/)
})

test('a failing show-ref --heads yields empty branches, never a snapshot error', async () => {
  const { core: _, repo, workspaces } = setup({ linked: true })
  const failing: GitRunner = async request => {
    if (request.args[0] === 'show-ref') return { ok: true, stdout: '', stderr: '', exitCode: 2, command: 'show-ref' }
    return repo.runner(request)
  }
  const failingCore = coreOver({
    workspaces,
    git: failing,
    fs: repo.fs,
    now: () => Date.now(),
    token: () => 'token-x',
  })
  const snapshot = await failingCore.snapshot()
  assert.equal(snapshot.repos.length, 1)
  assert.deepEqual(snapshot.repos[0]!.branches, [])
  assert.equal(snapshot.sourceError, undefined)
})

test('a missing branch reported with exit 128 (git version quirk) is treated as absent, not a hard git failure', async () => {
  // Some git versions exit 128 with `fatal: ... not a valid ref` where others
  // exit 1 for `show-ref --verify` on a missing ref. The new-branch preview
  // and create paths must read both as "branch does not exist yet".
  const { core: _, repo, workspaces } = setup({ linked: true })
  const strictRunner: GitRunner = async request => {
    if (request.args[0] === 'show-ref' && request.args[1] === '--hash') {
      return { ok: true, stdout: '', stderr: `fatal: '${request.args[3]}' - not a valid ref\n`, exitCode: 128, command: 'show-ref' }
    }
    return repo.runner(request)
  }
  const strictCore = coreOver({
    workspaces,
    git: strictRunner,
    fs: repo.fs,
    now: () => Date.now(),
    token: () => 'token-strict',
  })
  // The new-branch preview must succeed (branch does not exist → null head).
  const preview = await previewNew(strictCore, 'new-worktree', 'rapid-meadow')
  assert.equal(preview.branch, 'rapid-meadow')
  assert.equal(preview.baseHead, MAIN_HEAD)
  // And the create must commit the worktree + branch.
  const result = await strictCore.create({ previewToken: preview.previewToken, operationId: 'op-strict' })
  assert.equal(result.branch, 'rapid-meadow')
})

test('remove with deleteBranch deletes the local branch after the worktree removal', async () => {
  const { core, repo, workspaces } = setup({ linked: true })
  const snapshot = await core.snapshot()
  const repository = snapshot.repos[0]!
  const linked = repository.worktrees.find(worktree => worktree.path === LINKED)!
  const expected = { repoId: repository.repoId, worktreeId: linked.worktreeId, branch: linked.branch!, head: linked.head }
  assert.equal(repo.branches.has('feature'), true)
  const removed = await core.remove({ operationId: 'remove-del', workspaceId: 'ws-feature', expected, deleteBranch: 'feature' })
  assert.equal(removed.removed, true)
  assert.equal(removed.branchDeleted, true)
  assert.equal(removed.branchDeleteFailed, undefined)
  assert.equal(removed.branchDeleteError, undefined, 'a successful branch delete carries no failure reason')
  assert.equal(repo.branches.has('feature'), false)
  const branchCalls = repo.calls.filter(call => call.args[0] === 'branch' && call.args[1] === '-D')
  assert.deepEqual(branchCalls.at(-1)!.args, ['branch', '-D', 'feature'])
})

test('remove with deleteBranch reports a failed branch delete honestly and keeps the removed worktree', async () => {
  const { core, repo, workspaces } = setup({ linked: true })
  const snapshot = await core.snapshot()
  const repository = snapshot.repos[0]!
  const linked = repository.worktrees.find(worktree => worktree.path === LINKED)!
  const expected = { repoId: repository.repoId, worktreeId: linked.worktreeId, branch: linked.branch!, head: linked.head }
  // Remove the branch behind the host's back so `branch -D` fails.
  repo.branches.delete('feature')
  const removed = await core.remove({ operationId: 'remove-fail-branch', workspaceId: 'ws-feature', expected, deleteBranch: 'feature' })
  assert.equal(removed.removed, true)
  assert.equal(removed.branchDeleted, undefined)
  assert.equal(removed.branchDeleteFailed, true)
  // The failure is no longer a bare boolean: the host carries the bounded
  // reason so the client can show WHY the optional branch delete failed.
  assert.equal(typeof removed.branchDeleteError, 'string')
  assert.ok((removed.branchDeleteError ?? '').length > 0)
})

test('branch -D allowlist accepts a plain name and rejects a leading dash', () => {
  assertSafeGitArgv(['branch', '-D', 'feature'])
  assert.throws(() => assertSafeGitArgv(['branch', '-D', '-x']), /outside the worktree allowlist/)
  assert.throws(() => assertSafeGitArgv(['branch', '-D']), /outside the worktree allowlist/)
})

test('discovery cache skips rev-parse/worktree-list within TTL for an unchanged registry, and invalidates on registry change', async () => {
  const { core, repo, workspaces } = setup({ linked: true })
  // advanceTime must move the clock; setup returns advanceTime.
  let snap1 = await core.snapshot()
  assert.equal(snap1.repos.length, 1)
  const revParseCallsAfterFirst = repo.calls.filter(call => call.args[0] === 'rev-parse').length
  const listCallsAfterFirst = repo.calls.filter(call => call.args[0] === 'worktree' && call.args[1] === 'list').length

  // Second snapshot within TTL, same registry: no new rev-parse/worktree-list spawns.
  const snap2 = await core.snapshot()
  assert.equal(snap2.repos.length, 1)
  const revParseCallsAfterSecond = repo.calls.filter(call => call.args[0] === 'rev-parse').length
  const listCallsAfterSecond = repo.calls.filter(call => call.args[0] === 'worktree' && call.args[1] === 'list').length
  assert.equal(revParseCallsAfterSecond, revParseCallsAfterFirst, 'rev-parse must be served from cache within TTL')
  assert.equal(listCallsAfterSecond, listCallsAfterFirst, 'worktree list must be served from cache within TTL')

  // A workspace registry change invalidates the caches → full re-discovery.
  workspaces.push({ workspaceId: 'ws-new', path: '/repos/other', sessionIds: [] })
  const snap3 = await core.snapshot()
  assert.ok(repo.calls.filter(call => call.args[0] === 'rev-parse').length > revParseCallsAfterSecond, 'registry change must re-run discovery')
  assert.ok(snap3.repos.length >= 1)
})


test('previewCreate accepts startRef: the new branch starts from the chosen source branch head', async () => {
  const { core, repo } = setup({ linked: true })
  // setup({linked:true}) already has 'feature' (FEATURE_HEAD) as a local branch.
  const preview = await previewNew(core, 'from-feature', 'topic-src')
  // default: baseHead = main HEAD
  assert.equal(preview.baseHead, MAIN_HEAD)
  const withStart = await previewNew(core, 'from-start', 'topic-start', { startRef: 'feature' })
  assert.equal(withStart.baseHead, FEATURE_HEAD)
  // unknown source branch -> clean branch-not-found, not a raw git error
  await assert.rejects(
    previewNew(core, 'from-missing', 'topic-missing', { startRef: 'no-such-branch' }),
    error => error instanceof GitWorktreeError && error.code === 'branch-not-found',
  )
})

test('create reconciles a startRef source branch: a moved source fails preview-stale', async () => {
  const { core, repo } = setup({ linked: true })
  const preview = await previewNew(core, 'from-start', 'topic-start', { startRef: 'feature' })
  assert.equal(preview.baseHead, FEATURE_HEAD)
  // Move the source branch after preview -> create must refuse (stale).
  repo.branches.set('feature', '3333333333333333333333333333333333333333')
  await assert.rejects(
    core.create({ previewToken: preview.previewToken, operationId: 'op-start-stale' }),
    error => error instanceof GitWorktreeError && error.code === 'preview-stale',
  )
})

test('a replay of a committed remove still attempts the optional branch delete', async () => {
  const { core, repo, workspaces } = setup({ linked: true })
  const snapshot = await core.snapshot()
  const repository = snapshot.repos[0]!
  const linked = repository.worktrees.find(worktree => worktree.path === LINKED)!
  const expected = { repoId: repository.repoId, worktreeId: linked.worktreeId, branch: linked.branch!, head: linked.head }
  // First remove commits the worktree removal (branch still present).
  const first = await core.remove({ operationId: 'op-replay-del', workspaceId: 'ws-feature', expected, deleteBranch: 'feature' })
  assert.equal(first.removed, true)
  assert.equal(first.branchDeleted, true)
  assert.equal(repo.branches.has('feature'), false)
  // Replay (target absent now): branch delete must NOT re-run (guarded once).
  const branchCallsBefore = repo.calls.filter(call => call.args[0] === 'branch').length
  const replay = await core.remove({ operationId: 'op-replay-del', workspaceId: 'ws-feature', expected, deleteBranch: 'feature' })
  assert.equal(replay.replayed, true)
  assert.equal(replay.removed, true)
  assert.equal(repo.calls.filter(call => call.args[0] === 'branch').length, branchCallsBefore, 'branch delete must run at most once')
})

test('create clears the discovery cache so the next snapshot sees the new worktree immediately', async () => {
  const { core, repo } = setup({ linked: true })
  await core.snapshot()
  const revParseBefore = repo.calls.filter(call => call.args[0] === 'rev-parse').length
  const preview = await previewNew(core, 'cache-clear', 'topic-clear')
  await core.create({ previewToken: preview.previewToken, operationId: 'op-clear' })
  // Next snapshot (unchanged registry) must still re-discover (no stale cache).
  const snapshot = await core.snapshot()
  assert.ok(snapshot.repos.some(repoRow => repoRow.worktrees.some(row => row.path === preview.targetPath)), 'new worktree visible in the next snapshot')
  assert.ok(repo.calls.filter(call => call.args[0] === 'rev-parse').length > revParseBefore, 'create cleared the discovery cache')
})

test('parseBranchLine extracts local-ref upstream/ahead/behind facts', () => {
  assert.deepEqual(parseBranchLine('## main...origin/main [ahead 2, behind 1]\u0000'), { upstream: 'origin/main', ahead: 2, behind: 1 })
  assert.deepEqual(parseBranchLine('## feature...origin/feature [ahead 3]'), { upstream: 'origin/feature', ahead: 3, behind: 0 })
  assert.deepEqual(parseBranchLine('## main'), { upstream: null, ahead: 0, behind: 0 })
  assert.deepEqual(parseBranchLine('## HEAD (no branch)'), { upstream: null, ahead: 0, behind: 0 })
  assert.deepEqual(parseBranchLine('?? untracked.txt'), { upstream: null, ahead: 0, behind: 0 })
})

test('snapshot carries upstream/ahead/behind from the --branch status header', async () => {
  const { core, repo } = setup({ linked: true })
  repo.worktrees[1]!.upstream = 'origin/feature'
  repo.worktrees[1]!.ahead = 2
  repo.worktrees[1]!.behind = 1
  const snapshot = await core.snapshot()
  const row = snapshot.repos[0]!.worktrees.find(worktree => worktree.path === LINKED)!
  assert.equal(row.upstream, 'origin/feature')
  assert.equal(row.ahead, 2)
  assert.equal(row.behind, 1)
  // The main checkout has no upstream facts.
  const mainRow = snapshot.repos[0]!.worktrees.find(worktree => worktree.path === MAIN)!
  assert.equal(mainRow.upstream, null)
  assert.equal(mainRow.ahead, 0)
  assert.equal(mainRow.behind, 0)
})

test('--branch snapshot dirty detection: clean stays false, dirty becomes true', async () => {
  const { core, repo } = setup({ linked: true })
  const clean = await core.snapshot()
  const cleanRow = clean.repos[0]!.worktrees.find(row => row.path === LINKED)!
  assert.equal(cleanRow.dirty, false)
  repo.worktrees[1]!.dirty = true
  const dirty = await core.snapshot()
  const dirtyRow = dirty.repos[0]!.worktrees.find(row => row.path === LINKED)!
  assert.equal(dirtyRow.dirty, true)
})
