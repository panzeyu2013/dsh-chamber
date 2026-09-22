/**
 * Git worktree core — snapshot topology, budgets, row classification, branch
 * facts and the local Git runner. Round-2 consolidation of core.test.ts and
 * snapshot-classification-branches.test.ts; fixtures in support/fake-repository.ts.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolve, join } from 'node:path'
import { homedir } from 'node:os'
import {
  GitWorktreeCore,
  GitWorktreeError,
  MAX_TOTAL_WORKTREES,
  MAX_TOTAL_SESSION_MEMBERSHIPS,
  MAX_WORKSPACES,
  MAX_WORKTREES_PER_REPOSITORY,
  MAX_REPOSITORIES,
  PREVIEW_TTL_MS,
  SNAPSHOT_DEADLINE_MS,
  assertSafeGitArgv,
  createLocalGitRunner,
  parseBranchLine,
  type GitRunner,
  type WorkspaceFact,
} from '../src/core.ts'
import {
  MAIN,
  COMMON,
  LINKED,
  MAIN_HEAD,
  FEATURE_HEAD,
  WORKTREES_KEY,
  FakeGitChild,
  FakeRepository,
  setup,
  pathSetFs,
  coreOver,
  previewNew,
} from './support/fake-repository.ts'

/** Bounded poll: the git timeout timer is unref'ed, so a plain sleep raced CI stalls. */
async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail(`${what} did not become true within 2000ms`)
}

test('snapshot keeps repository topology when one worktree status fails', async () => {
  const { core, repo, agents } = setup({ linked: true })
  repo.worktrees[1]!.statusFailure = true
  repo.existing.add(`${LINKED}/nested`)
  agents.push({ sessionId: 's-ungrouped', status: 'running', cwd: `${LINKED}/nested` })

  const snapshot = await core.snapshot()
  assert.equal(snapshot.sourceError, undefined)
  assert.equal(snapshot.repos.length, 1)
  assert.match(snapshot.repos[0]!.repoId, /^repo_[0-9a-f]{64}$/)
  assert.equal(snapshot.repos[0]!.worktrees.length, 2)
  const linked = snapshot.repos[0]!.worktrees[1]!
  assert.match(linked.worktreeId, /^worktree_[0-9a-f]{64}$/)
  assert.equal(linked.workspaceId, 'ws-feature')
  assert.deepEqual(linked.sessionIds, ['s-feature'])
  assert.deepEqual(linked.runningSessionIds, ['s-ungrouped'])
  assert.equal(linked.dirty, null)
  assert.equal(snapshot.errors.some(error => error.operation === 'status' && error.path === LINKED), true)
})

test('snapshot classifies missing, non-git and failing rows', async () => {
  const missing = setup({ linked: true })
  missing.repo.existing.delete(LINKED)
  const missingRow = (await missing.core.snapshot()).repos[0]!.worktrees[1]!
  assert.equal(missingRow.status, 'missing')
  assert.equal(missingRow.dirty, null)

  for (const scenario of ['not-a-repo', 'invalid'] as const) {
    const { core, repo } = setup({ linked: true })
    repo.worktrees[1]!.statusFailure = true
    if (scenario === 'not-a-repo') repo.worktrees[1]!.statusStderr = 'fatal: not a git repository: /repos/feature/.git'
    const snapshot = await core.snapshot()
    const row = snapshot.repos[0]!.worktrees[1]!
    assert.equal(row.status, scenario)
    assert.equal(snapshot.errors.some(error => error.operation === 'status' && error.path === LINKED), true)
  }
})

test('snapshot classifies branch, detached and unborn heads', async () => {
  const { core, repo } = setup({ linked: true })
  repo.addLinked({ path: '/repos/unborn', branch: 'unborn', head: '0'.repeat(40) })
  repo.addLinked({ path: '/repos/detached', branch: null, head: FEATURE_HEAD })
  const rows = (await core.snapshot()).repos[0]!.worktrees
  assert.equal(rows.find(row => row.path === MAIN)!.headState, 'branch')
  assert.equal(rows.find(row => row.path === '/repos/unborn')!.headState, 'unborn')
  assert.equal(rows.find(row => row.path === '/repos/detached')!.headState, 'detached')
})

test('snapshot maps git-dir state files and relative, malformed or unresolvable pointers to attention', async () => {
  // Absolute git dirs: linked + common dir state files are both probed.
  const absolute = setup({ linked: true })
  const linkedGitDir = `${COMMON}/worktrees/feature`
  absolute.repo.gitDirs.set(LINKED, linkedGitDir)
  absolute.repo.gitDirStateFiles.set(linkedGitDir, new Set(['MERGE_HEAD', 'BISECT_LOG']))
  absolute.repo.gitDirStateFiles.set(COMMON, new Set(['CHERRY_PICK_HEAD']))
  const absoluteRows = (await absolute.core.snapshot()).repos[0]!.worktrees
  assert.deepEqual(absoluteRows.find(row => row.path === LINKED)!.attention, ['merge', 'bisect'])
  assert.deepEqual(absoluteRows.find(row => row.path === MAIN)!.attention, ['cherry-pick'])

  // A RELATIVE gitdir pointer resolves against the worktree path.
  const relative = setup({ linked: true })
  const relativeGitDir = '../.git/worktrees/feature'
  relative.repo.pointerOverrides.set(`${LINKED}/.git`, `gitdir: ${relativeGitDir}`)
  relative.repo.gitDirStateFiles.set(resolve(LINKED, relativeGitDir), new Set(['REVERT_HEAD']))
  assert.deepEqual((await relative.core.snapshot()).repos[0]!.worktrees.find(row => row.path === LINKED)!.attention, ['revert'])

  // A malformed pointer or an unresolvable git dir yields no attention at all.
  const malformed = setup({ linked: true })
  malformed.repo.pointerOverrides.set(`${LINKED}/.git`, 'not-a-gitdir-line')
  const malformedRow = (await malformed.core.snapshot()).repos[0]!.worktrees.find(row => row.path === LINKED)!
  assert.deepEqual(malformedRow.attention, [])
  assert.equal(malformedRow.status, 'ready')

  const unresolved = setup({ linked: true })
  const unresolvedRow = (await unresolved.core.snapshot()).repos[0]!.worktrees[1]!
  assert.deepEqual(unresolvedRow.attention, [])
  assert.equal(unresolvedRow.status, 'ready')
})

test('snapshot falls back to newline-delimited porcelain when Git predates worktree list -z', async () => {
  const { core, repo } = setup({ linked: true })
  repo.legacyGit = true
  const snapshot = await core.snapshot()
  assert.equal(snapshot.sourceError, undefined)
  assert.equal(snapshot.repos[0]!.worktrees.length, 2)
  assert.equal(snapshot.repos[0]!.worktrees[0]!.isMain, true)
  assert.equal(snapshot.repos[0]!.worktrees[1]!.workspaceId, 'ws-feature')
  // The NUL form was attempted first, then the newline fallback.
  const listCalls = repo.calls.filter(call => call.args[0] === 'worktree' && call.args[1] === 'list')
  assert.deepEqual(listCalls.map(call => call.args.slice(2)), [['--porcelain', '-z'], ['--porcelain']])
})

test('overlapping snapshot polls share one in-flight host scan and a deadline cannot overlap an old one', async () => {
  const shared = setup({ linked: true })
  shared.repo.readDelayMs = 2
  const first = shared.core.snapshot()
  assert.equal(shared.core.snapshot(), first)
  const [left, right] = await Promise.all([first, first])
  assert.equal(left, right)
  assert.equal(shared.repo.calls.filter(call => call.args[0] === 'worktree' && call.args[1] === 'list').length, 1)

  // Wall deadline: the timed-out value stays single-flight until the old scan exits.
  let sourceCalls = 0
  let release!: (workspaces: WorkspaceFact[]) => void
  const core = new GitWorktreeCore({
    source: {
      listWorkspaces: () => {
        sourceCalls += 1
        if (sourceCalls > 1) return []
        return new Promise<WorkspaceFact[]>(resolvePromise => { release = resolvePromise })
      },
      listAgents: () => [],
      listArchivedSessionIds: () => [],
    },
    snapshotWallTimeoutMs: 5,
  })
  const pending = core.snapshot()
  assert.equal(core.snapshot(), pending)
  const timedOut = await pending
  assert.equal(timedOut.sourceError?.code, 'snapshot-deadline')
  assert.equal(core.snapshot(), pending)
  assert.equal(sourceCalls, 1)
  release([])
  await new Promise(resolve => setImmediate(resolve))
  const fresh = core.snapshot()
  assert.notEqual(fresh, pending)
  assert.equal((await fresh).sourceError, undefined)
  assert.equal(sourceCalls, 2)
})

test('snapshot fails loud before Git when workspace structure or memberships exceed their caps', async () => {
  let gitCalls = 0
  const tooManyWorkspaces = new GitWorktreeCore({
    source: {
      listWorkspaces: () => Array.from({ length: MAX_WORKSPACES + 1 }, (_, index) => ({
        workspaceId: `ws-${index}`, path: `/repos/workspace-${index}`, sessionIds: [],
      })),
      listAgents: () => [],
      listArchivedSessionIds: () => [],
    },
    git: async () => {
      gitCalls += 1
      return { exitCode: 0, stdout: '', stderr: '' }
    },
  })
  const capped = await tooManyWorkspaces.snapshot()
  assert.equal(capped.sourceError?.code, 'state-source-capacity')
  assert.deepEqual(capped.repos, [])
  assert.equal(gitCalls, 0)

  const sessionIds = Array.from({ length: MAX_TOTAL_SESSION_MEMBERSHIPS / 4 }, (_, index) => `s-${index}`)
  const tooManyMemberships = new GitWorktreeCore({
    source: {
      listWorkspaces: () => Array.from({ length: 5 }, (_, index) => ({
        workspaceId: `ws-memberships-${index}`, path: `/repos/memberships-${index}`, sessionIds,
      })),
      listAgents: () => [],
      listArchivedSessionIds: () => [],
    },
    git: async () => { throw new Error('Git must not run after source capacity failure') },
  })
  const membershipCapped = await tooManyMemberships.snapshot()
  assert.equal(membershipCapped.sourceError?.code, 'state-source-capacity')
  assert.deepEqual(membershipCapped.repos, [])
})

test('snapshot caps worktree rows, canonicalizes each running cwd once and enforces one total budget', async () => {
  const bounded = setup()
  for (let index = 0; index < MAX_WORKTREES_PER_REPOSITORY + 8; index += 1) {
    const path = `/repos/bounded-${index}`
    const branch = `bounded-${index}`
    bounded.repo.existing.add(path)
    bounded.repo.branches.set(branch, FEATURE_HEAD)
    bounded.repo.worktrees.push({ path, branch, head: FEATURE_HEAD })
  }
  const alias = '/aliases/running-agent'
  bounded.repo.existing.add('/repos/bounded-0/nested')
  bounded.repo.aliases.set(alias, '/repos/bounded-0/nested')
  bounded.agents.push({ sessionId: 'bounded-agent', status: 'running', cwd: alias })
  const boundedSnapshot = await bounded.core.snapshot()
  assert.equal(boundedSnapshot.repos[0]!.worktrees.length, MAX_WORKTREES_PER_REPOSITORY)
  assert.equal(boundedSnapshot.sourceError?.code, 'snapshot-capacity')
  assert.equal(boundedSnapshot.errors.some(error => error.code === 'snapshot-worktree-limit'), true)
  const owner = boundedSnapshot.repos[0]!.worktrees.find(worktree => worktree.path === '/repos/bounded-0')!
  assert.deepEqual(owner.runningSessionIds, ['bounded-agent'])
  assert.equal(bounded.repo.realpathCalls.get(alias), 1)

  const repositoryCount = 3
  const paths = new Set<string>()
  const workspaces: WorkspaceFact[] = []
  for (let repository = 0; repository < repositoryCount; repository += 1) {
    const main = `/multi/${repository}/main`
    paths.add(main)
    paths.add(`${main}/.git`)
    workspaces.push({ workspaceId: `multi-${repository}`, path: main, sessionIds: [] })
    for (let row = 1; row < MAX_WORKTREES_PER_REPOSITORY; row += 1) paths.add(`/multi/${repository}/linked-${row}`)
  }
  const runner: GitRunner = async request => {
    const match = /^\/multi\/(\d+)\//u.exec(request.cwd)
    assert.ok(match)
    const repository = Number(match[1])
    const main = `/multi/${repository}/main`
    if (request.args[0] === 'rev-parse' && request.args[1] === '--show-toplevel') {
      const top = request.cwd === main || request.cwd.startsWith(`/multi/${repository}/linked-`) ? request.cwd : main
      return { exitCode: 0, stdout: `${top}\n`, stderr: '' }
    }
    if (request.args[0] === 'rev-parse') return { exitCode: 0, stdout: `${main}/.git\n`, stderr: '' }
    if (request.args[0] === 'worktree') {
      const fields: string[] = []
      for (let row = 0; row < MAX_WORKTREES_PER_REPOSITORY; row += 1) {
        const path = row === 0 ? main : `/multi/${repository}/linked-${row}`
        fields.push(`worktree ${path}`, `HEAD ${MAIN_HEAD}`, `branch refs/heads/r-${repository}-${row}`, '')
      }
      return { exitCode: 0, stdout: `${fields.join('\0')}\0`, stderr: '' }
    }
    if (request.args[0] === 'status') return { exitCode: 0, stdout: '', stderr: '' }
    throw new Error(`unexpected Git call: ${request.args.join(' ')}`)
  }
  const multi = coreOver({ workspaces, git: runner, fs: pathSetFs(paths) })
  const multiSnapshot = await multi.snapshot()
  assert.equal(multiSnapshot.repos.reduce((count, repo) => count + repo.worktrees.length, 0), MAX_TOTAL_WORKTREES)
  assert.equal(multiSnapshot.errors.some(error => error.code === 'snapshot-total-worktree-limit'), true)
  assert.equal(multiSnapshot.sourceError?.code, 'snapshot-capacity')

  const capCount = MAX_REPOSITORIES + 1
  const capPaths = new Set<string>()
  const capWorkspaces: WorkspaceFact[] = []
  for (let repository = 0; repository < capCount; repository += 1) {
    const main = `/cap/${repository}/main`
    capPaths.add(main)
    capPaths.add(`${main}/.git`)
    capWorkspaces.push({ workspaceId: `cap-${repository}`, path: main, sessionIds: [] })
  }
  const capRunner: GitRunner = async request => {
    const match = /^\/cap\/(\d+)\//u.exec(request.cwd)
    assert.ok(match)
    const main = `/cap/${Number(match[1])}/main`
    if (request.args[0] === 'rev-parse') return { exitCode: 0, stdout: `${main}/.git\n`, stderr: '' }
    if (request.args[0] === 'worktree') return { exitCode: 0, stdout: `worktree ${main}\0HEAD ${MAIN_HEAD}\0branch refs/heads/main\0\0`, stderr: '' }
    if (request.args[0] === 'status') return { exitCode: 0, stdout: '', stderr: '' }
    throw new Error(`unexpected Git call: ${request.args.join(' ')}`)
  }
  const cap = coreOver({ workspaces: capWorkspaces, git: capRunner, fs: pathSetFs(capPaths) })
  const capSnapshot = await cap.snapshot()
  assert.equal(capSnapshot.repos.length, MAX_REPOSITORIES)
  assert.equal(capSnapshot.sourceError?.code, 'snapshot-capacity')
  assert.equal(capSnapshot.errors.some(error => error.code === 'snapshot-repository-limit'), true)
})

test('snapshot deadline stops launching status and filesystem association work', async () => {
  const { core, repo, advanceTime } = setup()
  for (let index = 0; index < 24; index += 1) {
    repo.existing.add(`/repos/deadline-${index}`)
    repo.worktrees.push({ path: `/repos/deadline-${index}`, branch: `deadline-${index}`, head: FEATURE_HEAD })
  }
  const perStatusElapsed = 2_500
  repo.onStatus = () => advanceTime(perStatusElapsed)
  const snapshot = await core.snapshot()
  const statusCalls = repo.calls.filter(call => call.args[0] === 'status').length
  assert.ok(statusCalls <= Math.ceil(SNAPSHOT_DEADLINE_MS / perStatusElapsed))
  assert.equal(snapshot.sourceError?.code, 'snapshot-deadline')
  assert.equal(snapshot.errors.some(error => error.code === 'snapshot-deadline'), true)
  assert.equal(repo.realpathCalls.has('/repos/deadline-23'), false)
  assert.equal(snapshot.repos[0]!.worktrees.at(-1)!.dirty, null)
})

test('source failures are explicit: no empty healthy snapshot, source-wide only at the Git spawn boundary', async () => {
  const offline = new FakeRepository()
  const unavailable = new GitWorktreeCore({
    source: { listWorkspaces: () => { throw new Error('storage offline') }, listAgents: () => [], listArchivedSessionIds: () => [] },
    git: offline.runner,
    fs: offline.fs,
  })
  const result = await unavailable.snapshot()
  assert.deepEqual(result.repos, [])
  assert.equal(result.sourceError?.code, 'state-source-unavailable')
  assert.match(result.sourceError!.message, /storage offline/)

  const repo = new FakeRepository()
  repo.addLinked()
  const workspaces: WorkspaceFact[] = [
    { workspaceId: 'ws-main', path: MAIN, sessionIds: [] },
    { workspaceId: 'ws-linked', path: LINKED, sessionIds: [] },
  ]
  const sourceWide = await coreOver({
    workspaces,
    git: async () => { throw new GitWorktreeError('git-spawn-failed', 'spawn git ENOENT') },
    fs: repo.fs,
  }).snapshot()
  assert.equal(sourceWide.sourceError?.code, 'git-unavailable')
  assert.deepEqual(sourceWide.repos, [])
  assert.equal(sourceWide.errors.length, 2)
  assert.equal(sourceWide.errors.every(error => error.code === 'git-spawn-failed'), true)

  const localOnly = await coreOver({
    workspaces: [workspaces[0]!],
    git: async () => ({ exitCode: 128, stdout: '', stderr: 'not a git repository' }),
    fs: repo.fs,
  }).snapshot()
  assert.equal(localOnly.sourceError, undefined)
  assert.deepEqual(localOnly.repos, [])
  assert.equal(localOnly.errors[0]?.code, 'git-command-failed')
})

test('preview rejects checked-out and existing branches and a bare repository', async () => {
  const checkedOut = setup()
  await assert.rejects(
    checkedOut.core.previewCreate({ sourceWorkspaceId: 'ws-main', basename: 'x', branch: { kind: 'existing', name: 'main' } }),
    error => error instanceof GitWorktreeError && error.code === 'branch-checked-out',
  )
  const bare = setup()
  bare.repo.worktrees[0]!.bare = true
  await assert.rejects(
    bare.core.previewCreate({ sourceWorkspaceId: 'ws-main', basename: 'x', branch: { kind: 'new', name: 'topic' } }),
    error => error instanceof GitWorktreeError && error.code === 'bare-repository',
  )
  const existing = setup()
  existing.repo.branches.set('feature', FEATURE_HEAD)
  await assert.rejects(
    existing.core.previewCreate({ sourceWorkspaceId: 'ws-main', basename: 'x', branch: { kind: 'new', name: 'feature' } }),
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
  // pruneCaches removes expired previews before the lookup, so an expired token
  // surfaces as preview-not-found (the preview-expired branch is the narrow
  // race backstop between prune and check).
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

test('local runner bounds time and output and settles only after the child closes', async () => {
  // Timeout kill.
  const timedOut = new FakeGitChild()
  const timeoutRunner = createLocalGitRunner(() => timedOut)
  const timeoutPending = timeoutRunner({
    cwd: MAIN, args: ['status', '--porcelain=v1', '-z', '--untracked-files=normal'], timeoutMs: 5, maxOutputBytes: 4096,
  })
  let timeoutSettled = false
  void timeoutPending.then(() => { timeoutSettled = true }, () => { timeoutSettled = true })
  await waitFor(() => timedOut.killed === true, 'the 5ms git timeout killed the child')
  assert.equal(timeoutSettled, false)
  timedOut.emit('close', null)
  await assert.rejects(timeoutPending, error => error instanceof GitWorktreeError && error.code === 'git-timeout')
  assert.equal(timeoutSettled, true)

  // Combined stdout+stderr byte cap, killing only once the cap is exceeded.
  const capped = new FakeGitChild()
  const capRunner = createLocalGitRunner(() => capped)
  const capPending = capRunner({
    cwd: MAIN, args: ['status', '--porcelain=v1', '-z', '--untracked-files=normal'], timeoutMs: 1_000, maxOutputBytes: 8,
  })
  let capSettled = false
  void capPending.then(() => { capSettled = true }, () => { capSettled = true })
  capped.stdout.emit('data', Buffer.from('12345'))
  capped.stderr.emit('data', Buffer.from('678'))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(capped.killed, false)
  capped.stdout.emit('data', Buffer.from('9'))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(capped.killed, true)
  capped.emit('close', null)
  await assert.rejects(capPending, error => error instanceof GitWorktreeError && error.code === 'git-output-limit')
  assert.equal(capSettled, true)

  // A kill() that returns false and emits an error still waits for close.
  class KillFailingChild extends FakeGitChild {
    override kill(): boolean {
      this.killed = true
      this.emit('error', new Error('simulated kill failure event'))
      return false
    }
  }
  const failing = new KillFailingChild()
  const failingPending = createLocalGitRunner(() => failing)({
    cwd: MAIN, args: ['status', '--porcelain=v1', '-z', '--untracked-files=normal'], timeoutMs: 1_000, maxOutputBytes: 4,
  })
  let failingSettled = false
  void failingPending.then(() => { failingSettled = true }, () => { failingSettled = true })
  failing.stdout.emit('data', Buffer.from('12345'))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(failing.killed, true)
  assert.equal(failingSettled, false)
  failing.emit('close', null)
  await assert.rejects(failingPending, error => error instanceof GitWorktreeError && error.code === 'git-output-limit')
  assert.equal(failingSettled, true)
})

test('local runner normalizes synchronous spawn throws as pre-admission failure', async () => {
  const runner = createLocalGitRunner(() => { throw new Error('synchronous spawn failure') })
  await assert.rejects(
    runner({ cwd: MAIN, args: ['status', '--porcelain=v1', '-z', '--untracked-files=normal'], timeoutMs: 1_000, maxOutputBytes: 1_024 }),
    error => error instanceof GitWorktreeError
      && error.code === 'git-spawn-failed'
      && /synchronous spawn failure/u.test(error.message),
  )
})

test('snapshot lists local branches via show-ref --heads and yields empty branches on failure', async () => {
  const { core, repo } = setup({ linked: true })
  repo.branches.set('feature/x', FEATURE_HEAD)
  const snapshot = await core.snapshot()
  assert.equal(snapshot.repos.length, 1)
  assert.deepEqual(snapshot.repos[0]!.branches, ['main', 'feature', 'feature/x'])
  // show-ref --heads must be the allowed fixed-flag form; anything else fails.
  assert.throws(() => assertSafeGitArgv(['show-ref', '--heads', 'refs/heads/main']), /outside the worktree allowlist/)

  const failing = setup({ linked: true })
  const failingRunner: GitRunner = async request => {
    if (request.args[0] === 'show-ref') return { ok: true, stdout: '', stderr: '', exitCode: 2, command: 'show-ref' }
    return failing.repo.runner(request)
  }
  const failingCore = coreOver({ workspaces: failing.workspaces, git: failingRunner, fs: failing.repo.fs, now: () => Date.now(), token: () => 'token-x' })
  const failedSnapshot = await failingCore.snapshot()
  assert.equal(failedSnapshot.repos.length, 1)
  assert.deepEqual(failedSnapshot.repos[0]!.branches, [])
  assert.equal(failedSnapshot.sourceError, undefined)
})

test('branch -D allowlist accepts a plain name and rejects a leading dash', () => {
  assertSafeGitArgv(['branch', '-D', 'feature'])
  assert.throws(() => assertSafeGitArgv(['branch', '-D', '-x']), /outside the worktree allowlist/)
  assert.throws(() => assertSafeGitArgv(['branch', '-D']), /outside the worktree allowlist/)
})

test('discovery cache skips rev-parse/worktree-list within TTL, invalidates on registry change and clears on create', async () => {
  const { core, repo, workspaces } = setup({ linked: true })
  assert.equal((await core.snapshot()).repos.length, 1)
  const revParseAfterFirst = repo.calls.filter(call => call.args[0] === 'rev-parse').length
  const listAfterFirst = repo.calls.filter(call => call.args[0] === 'worktree' && call.args[1] === 'list').length

  // Second snapshot within TTL, same registry: no new discovery spawns.
  assert.equal((await core.snapshot()).repos.length, 1)
  assert.equal(repo.calls.filter(call => call.args[0] === 'rev-parse').length, revParseAfterFirst, 'rev-parse must be served from cache within TTL')
  assert.equal(repo.calls.filter(call => call.args[0] === 'worktree' && call.args[1] === 'list').length, listAfterFirst, 'worktree list must be served from cache within TTL')

  // A workspace registry change invalidates the caches.
  workspaces.push({ workspaceId: 'ws-new', path: '/repos/other', sessionIds: [] })
  assert.equal((await core.snapshot()).repos.length >= 1, true)
  assert.ok(repo.calls.filter(call => call.args[0] === 'rev-parse').length > revParseAfterFirst, 'registry change must re-run discovery')

  // create clears the discovery cache so the next snapshot sees the new worktree.
  const revParseBeforeCreate = repo.calls.filter(call => call.args[0] === 'rev-parse').length
  const preview = await previewNew(core, 'cache-clear', 'topic-clear')
  await core.create({ previewToken: preview.previewToken, operationId: 'op-clear' })
  const afterCreate = await core.snapshot()
  assert.ok(afterCreate.repos.some(row => row.worktrees.some(worktree => worktree.path === preview.targetPath)), 'new worktree visible in the next snapshot')
  assert.ok(repo.calls.filter(call => call.args[0] === 'rev-parse').length > revParseBeforeCreate, 'create cleared the discovery cache')
})

test('previewCreate startRef pins the chosen source branch; a moved source fails preview-stale', async () => {
  const { core, repo } = setup({ linked: true })
  // setup({linked:true}) has 'feature' (FEATURE_HEAD) as a local branch.
  assert.equal((await previewNew(core, 'from-feature', 'topic-src')).baseHead, MAIN_HEAD)
  assert.equal((await previewNew(core, 'from-start', 'topic-start', { startRef: 'feature' })).baseHead, FEATURE_HEAD)
  await assert.rejects(
    previewNew(core, 'from-missing', 'topic-missing', { startRef: 'no-such-branch' }),
    error => error instanceof GitWorktreeError && error.code === 'branch-not-found',
  )
  const pinned = await previewNew(core, 'from-start', 'topic-start', { startRef: 'feature' })
  repo.branches.set('feature', '3333333333333333333333333333333333333333')
  await assert.rejects(
    core.create({ previewToken: pinned.previewToken, operationId: 'op-start-stale' }),
    error => error instanceof GitWorktreeError && error.code === 'preview-stale',
  )
})

test('a non-zero show-ref --hash exit (the git 128 missing-ref quirk) reads as branch absent', async () => {
  // Git versions disagree on the missing-ref exit code (1 vs 128);
  // `src/core.ts` localBranchHead treats ANY non-zero exit as
  // "branch absent" — a regression to a hard failure would break new-branch
  // preview/create on those versions.
  const { repo, workspaces } = setup({ linked: true })
  const strictRunner: GitRunner = async request => {
    if (request.args[0] === 'show-ref' && request.args[1] === '--hash') {
      return { exitCode: 128, stdout: '', stderr: `fatal: '${request.args[3]}' - not a valid ref\n` }
    }
    return repo.runner(request)
  }
  const strictCore = coreOver({ workspaces, git: strictRunner, fs: repo.fs, now: () => Date.now(), token: () => 'token-strict' })
  const preview = await previewNew(strictCore, 'new-worktree', 'rapid-meadow')
  assert.equal(preview.baseHead, MAIN_HEAD, 'a 128 missing ref is an absent branch, not a hard git failure')
  const created = await strictCore.create({ previewToken: preview.previewToken, operationId: 'op-strict' })
  assert.equal(created.branch, 'rapid-meadow')
})

test('a blank or whitespace-only $DSH_HOME is UNSET: the worktrees root follows upstream resolveDshHome', async () => {
  const previousDshHome = process.env.DSH_HOME
  try {
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
    assert.equal(
      (await previewNew(setup({ worktreesRoot: null }).core)).targetPath,
      `/opt/dsh-home/worktrees/${WORKTREES_KEY}/new-worktree`,
      'an absolute $DSH_HOME is the resolved harness home',
    )
    process.env.DSH_HOME = '~/elsewhere'
    assert.equal(
      (await previewNew(setup({ worktreesRoot: null }).core)).targetPath,
      join(homedir(), 'elsewhere', 'worktrees', WORKTREES_KEY, 'new-worktree'),
      'a ~-prefixed $DSH_HOME expands against the OS home (upstream expandHomePath)',
    )
  } finally {
    if (previousDshHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousDshHome
  }
})

test('parseBranchLine extracts upstream/ahead/behind facts', () => {
  assert.deepEqual(parseBranchLine('## main...origin/main [ahead 2, behind 1]\u0000'), { upstream: 'origin/main', ahead: 2, behind: 1 })
  assert.deepEqual(parseBranchLine('## feature...origin/feature [ahead 3]'), { upstream: 'origin/feature', ahead: 3, behind: 0 })
  assert.deepEqual(parseBranchLine('## main'), { upstream: null, ahead: 0, behind: 0 })
  assert.deepEqual(parseBranchLine('## HEAD (no branch)'), { upstream: null, ahead: 0, behind: 0 })
  assert.deepEqual(parseBranchLine('?? untracked.txt'), { upstream: null, ahead: 0, behind: 0 })
})

test('snapshot carries upstream/ahead/behind and dirty facts from the --branch status header', async () => {
  const { core, repo } = setup({ linked: true })
  const clean = await core.snapshot()
  assert.equal(clean.repos[0]!.worktrees.find(row => row.path === LINKED)!.dirty, false)
  repo.worktrees[1]!.upstream = 'origin/feature'
  repo.worktrees[1]!.ahead = 2
  repo.worktrees[1]!.behind = 1
  repo.worktrees[1]!.dirty = true
  const dirty = await core.snapshot()
  const linked = dirty.repos[0]!.worktrees.find(worktree => worktree.path === LINKED)!
  assert.equal(linked.dirty, true)
  assert.equal(linked.upstream, 'origin/feature')
  assert.equal(linked.ahead, 2)
  assert.equal(linked.behind, 1)
  const mainRow = dirty.repos[0]!.worktrees.find(worktree => worktree.path === MAIN)!
  assert.equal(mainRow.upstream, null)
  assert.equal(mainRow.ahead, 0)
  assert.equal(mainRow.behind, 0)
})
