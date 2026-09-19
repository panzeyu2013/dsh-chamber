/**
 * Git worktree core — snapshot topology, budget caps and source-wide failure semantics.
 * Siblings from the same split: create-rollback, remove-running-guard, reconcile-replay-force,
 * mutation-safety, snapshot-classification-branches, unregistered-leftover-vanish.
 * Shared fixtures: support/fake-repository.ts.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import {
  GitWorktreeCore,
  GitWorktreeError,
  MAX_TOTAL_WORKTREES,
  MAX_TOTAL_SESSION_MEMBERSHIPS,
  MAX_WORKSPACES,
  MAX_WORKTREES_PER_REPOSITORY,
  SNAPSHOT_DEADLINE_MS,
  type GitRunner,
  type WorkspaceFact,
  type WorktreeFileSystem,
} from '../src/core.ts'
import {
  MAIN,
  LINKED,
  MAIN_HEAD,
  FEATURE_HEAD,
  FakeRepository,
  setup,
  pathSetFs,
  coreOver,
  previewNew,
} from './support/fake-repository.ts'

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

test('snapshot falls back to newline-delimited porcelain when Git predates worktree list -z', async () => {
  const { core, repo } = setup({ linked: true })
  repo.legacyGit = true

  const snapshot = await core.snapshot()
  assert.equal(snapshot.sourceError, undefined)
  assert.equal(snapshot.repos.length, 1)
  assert.equal(snapshot.repos[0]!.worktrees.length, 2)
  assert.equal(snapshot.repos[0]!.worktrees[0]!.isMain, true)
  assert.equal(snapshot.repos[0]!.worktrees[0]!.workspaceId, 'ws-main')
  assert.equal(snapshot.repos[0]!.worktrees[1]!.workspaceId, 'ws-feature')
  // The NUL form was attempted first, then the newline fallback.
  const listCalls = repo.calls.filter(call => call.args[0] === 'worktree' && call.args[1] === 'list')
  assert.deepEqual(listCalls.map(call => call.args.slice(2)), [['--porcelain', '-z'], ['--porcelain']])
})

test('preview/create also fall back to newline porcelain on a legacy Git', async () => {
  const { core, repo } = setup({ linked: true })
  repo.legacyGit = true

  const preview = await previewNew(core, 'new-worktree', 'topic')
  assert.match(preview.repoId, /^repo_[0-9a-f]{64}$/)
  const listCalls = repo.calls.filter(call => call.args[0] === 'worktree' && call.args[1] === 'list')
  assert.deepEqual(listCalls.map(call => call.args.slice(2)), [['--porcelain', '-z'], ['--porcelain']])
})

test('overlapping snapshot polls share one in-flight host scan', async () => {
  const { core, repo } = setup({ linked: true })
  repo.readDelayMs = 2
  const first = core.snapshot()
  const second = core.snapshot()
  assert.equal(first, second)
  const [left, right] = await Promise.all([first, second])
  assert.equal(left, right)
  assert.equal(repo.calls.filter(call => call.args[0] === 'worktree' && call.args[1] === 'list').length, 1)
})

test('snapshot wall deadline settles callers without overlapping an uncancellable old scan', async () => {
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
  const first = core.snapshot()
  assert.equal(core.snapshot(), first)
  const timedOut = await first
  assert.equal(timedOut.sourceError?.code, 'snapshot-deadline')
  assert.equal(core.snapshot(), first)
  assert.equal(sourceCalls, 1)

  release([])
  await new Promise(resolve => setImmediate(resolve))
  const fresh = core.snapshot()
  assert.notEqual(fresh, first)
  assert.equal((await fresh).sourceError, undefined)
  assert.equal(sourceCalls, 2)
})

test('snapshot fails loud before Git when the host workspace structure exceeds its cap', async () => {
  let gitCalls = 0
  const core = new GitWorktreeCore({
    source: {
      listWorkspaces: () => Array.from({ length: MAX_WORKSPACES + 1 }, (_, index) => ({
        workspaceId: `ws-${index}`,
        path: `/repos/workspace-${index}`,
        sessionIds: [],
      })),
      listAgents: () => [],
      listArchivedSessionIds: () => [],
    },
    git: async () => {
      gitCalls += 1
      return { exitCode: 0, stdout: '', stderr: '' }
    },
  })
  const snapshot = await core.snapshot()
  assert.equal(snapshot.sourceError?.code, 'state-source-capacity')
  assert.deepEqual(snapshot.repos, [])
  assert.equal(gitCalls, 0)
})

test('snapshot caps total workspace/session memberships before projection', async () => {
  const sessionIds = Array.from({ length: MAX_TOTAL_SESSION_MEMBERSHIPS / 4 }, (_, index) => `s-${index}`)
  const core = new GitWorktreeCore({
    source: {
      listWorkspaces: () => Array.from({ length: 5 }, (_, index) => ({
        workspaceId: `ws-memberships-${index}`,
        path: `/repos/memberships-${index}`,
        sessionIds,
      })),
      listAgents: () => [],
      listArchivedSessionIds: () => [],
    },
    git: async () => { throw new Error('Git must not run after source capacity failure') },
  })
  const snapshot = await core.snapshot()
  assert.equal(snapshot.sourceError?.code, 'state-source-capacity')
  assert.deepEqual(snapshot.repos, [])
})

test('snapshot caps worktree rows and canonicalizes each running cwd only once', async () => {
  const { core, repo, agents } = setup()
  for (let index = 0; index < MAX_WORKTREES_PER_REPOSITORY + 8; index += 1) {
    const path = `/repos/bounded-${index}`
    const branch = `bounded-${index}`
    repo.existing.add(path)
    repo.branches.set(branch, FEATURE_HEAD)
    repo.worktrees.push({ path, branch, head: FEATURE_HEAD })
  }
  const nested = '/repos/bounded-0/nested'
  const alias = '/aliases/running-agent'
  repo.existing.add(nested)
  repo.aliases.set(alias, nested)
  agents.push({ sessionId: 'bounded-agent', status: 'running', cwd: alias })

  const snapshot = await core.snapshot()
  assert.equal(snapshot.repos[0]!.worktrees.length, MAX_WORKTREES_PER_REPOSITORY)
  assert.equal(snapshot.sourceError?.code, 'snapshot-capacity')
  assert.equal(snapshot.errors.some(error => error.code === 'snapshot-worktree-limit'), true)
  const owner = snapshot.repos[0]!.worktrees.find(worktree => worktree.path === '/repos/bounded-0')!
  assert.deepEqual(owner.runningSessionIds, ['bounded-agent'])
  assert.equal(repo.realpathCalls.get(alias), 1)
})

test('snapshot enforces one total worktree budget across repositories', async () => {
  const repositoryCount = 3
  const paths = new Set<string>()
  const workspaces: WorkspaceFact[] = []
  for (let repository = 0; repository < repositoryCount; repository += 1) {
    const main = `/multi/${repository}/main`
    paths.add(main)
    paths.add(`${main}/.git`)
    workspaces.push({ workspaceId: `multi-${repository}`, path: main, sessionIds: [] })
    for (let row = 1; row < MAX_WORKTREES_PER_REPOSITORY; row += 1) {
      paths.add(`/multi/${repository}/linked-${row}`)
    }
  }
  const fs = pathSetFs(paths)
  const runner: GitRunner = async request => {
    const match = /^\/multi\/(\d+)\//u.exec(request.cwd)
    assert.ok(match)
    const repository = Number(match[1])
    const main = `/multi/${repository}/main`
    if (request.args[0] === 'rev-parse' && request.args[1] === '--show-toplevel') {
      const top = request.cwd === main || request.cwd.startsWith(`/multi/${repository}/linked-`)
        ? request.cwd
        : main
      return { exitCode: 0, stdout: `${top}\n`, stderr: '' }
    }
    if (request.args[0] === 'rev-parse') {
      return { exitCode: 0, stdout: `${main}/.git\n`, stderr: '' }
    }
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
  const core = coreOver({ workspaces, git: runner, fs })
  const snapshot = await core.snapshot()
  assert.equal(snapshot.repos.reduce((count, repo) => count + repo.worktrees.length, 0), MAX_TOTAL_WORKTREES)
  assert.equal(snapshot.errors.some(error => error.code === 'snapshot-total-worktree-limit'), true)
  assert.equal(snapshot.sourceError?.code, 'snapshot-capacity')
})

test('snapshot deadline stops launching status and filesystem association work', async () => {
  const { core, repo, advanceTime } = setup()
  for (let index = 0; index < 24; index += 1) {
    const path = `/repos/deadline-${index}`
    repo.existing.add(path)
    repo.worktrees.push({ path, branch: `deadline-${index}`, head: FEATURE_HEAD })
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

test('state source failure is explicit and never masquerades as an empty healthy snapshot', async () => {
  const repo = new FakeRepository()
  const core = new GitWorktreeCore({
    source: { listWorkspaces: () => { throw new Error('storage offline') }, listAgents: () => [], listArchivedSessionIds: () => [] },
    git: repo.runner,
    fs: repo.fs,
  })
  const result = await core.snapshot()
  assert.deepEqual(result.repos, [])
  assert.equal(result.sourceError?.code, 'state-source-unavailable')
  assert.match(result.sourceError!.message, /storage offline/)
})

test('Git spawn failure is source-wide while ordinary non-Git discovery stays local', async () => {
  const repo = new FakeRepository()
  repo.addLinked()
  const workspaces: WorkspaceFact[] = [
    { workspaceId: 'ws-main', path: MAIN, sessionIds: [] },
    { workspaceId: 'ws-linked', path: LINKED, sessionIds: [] },
  ]
  const unavailable = coreOver({
    workspaces,
    git: async () => { throw new GitWorktreeError('git-spawn-failed', 'spawn git ENOENT') },
    fs: repo.fs,
  })
  const sourceWide = await unavailable.snapshot()
  assert.equal(sourceWide.sourceError?.code, 'git-unavailable')
  assert.deepEqual(sourceWide.repos, [])
  assert.equal(sourceWide.errors.length, 2)
  assert.equal(sourceWide.errors.every(error => error.code === 'git-spawn-failed'), true)

  const notRepository = coreOver({
    workspaces: [workspaces[0]!],
    git: async () => ({ exitCode: 128, stdout: '', stderr: 'not a git repository' }),
    fs: repo.fs,
  })
  const localOnly = await notRepository.snapshot()
  assert.equal(localOnly.sourceError, undefined)
  assert.deepEqual(localOnly.repos, [])
  assert.equal(localOnly.errors[0]?.code, 'git-command-failed')
})
