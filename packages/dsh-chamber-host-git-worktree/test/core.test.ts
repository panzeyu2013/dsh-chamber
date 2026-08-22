/** Pure lifecycle tests: Git, filesystem and dsh state are all in-memory mocks. */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { basename, dirname, resolve } from 'node:path'
import {
  GitWorktreeCore,
  GitWorktreeError,
  MAX_REPOSITORIES,
  MAX_TOTAL_WORKTREES,
  MAX_TOTAL_SESSION_MEMBERSHIPS,
  MAX_WORKSPACES,
  MAX_WORKTREES_PER_REPOSITORY,
  OPERATION_TTL_MS,
  PREVIEW_TTL_MS,
  SNAPSHOT_DEADLINE_MS,
  assertSafeGitArgv,
  createLocalGitRunner,
  domainResult,
  type AgentFact,
  type GitChildProcess,
  type GitCommandRequest,
  type GitCommandResult,
  type GitRunner,
  type WorkspaceFact,
  type WorktreeFileSystem,
  parseBranchLine,
} from '../src/core.ts'

const MAIN = '/repos/project'
const COMMON = '/repos/project/.git'
const LINKED = '/repos/feature'
/** worktreeRootFor key: `<basename>-<sha256(commonDir) 8 hex>`. */
const WORKTREES_KEY = `project-${createHash('sha256').update(COMMON).digest('hex').slice(0, 12)}`
const MAIN_HEAD = '1111111111111111111111111111111111111111'
const FEATURE_HEAD = '2222222222222222222222222222222222222222'

interface FakeWorktree {
  path: string
  branch: string | null
  head: string
  dirty?: boolean
  locked?: boolean
  prunable?: boolean
  bare?: boolean
  /** Optional upstream facts echoed into the --branch status header. */
  upstream?: string
  ahead?: number
  behind?: number
  statusFailure?: boolean
  /** stderr text for a status failure (defaults to 'status unavailable'). */
  statusStderr?: string
}

class MissingPathError extends Error {
  readonly code = 'ENOENT'
}

class FakeRepository {
  readonly existing = new Set<string>([MAIN, COMMON])
  readonly aliases = new Map<string, string>()
  readonly realpathCalls = new Map<string, number>()
  readonly branches = new Map<string, string>([['main', MAIN_HEAD]])
  readonly worktrees: FakeWorktree[] = [{ path: MAIN, branch: 'main', head: MAIN_HEAD }]
  readonly calls: GitCommandRequest[] = []
  mutationDelayMs = 0
  activeMutations = 0
  maxActiveMutations = 0
  failNextList = false
  failListAfterAdd = false
  failListAfterRemove = false
  throwAfterAdd?: GitWorktreeError
  throwAfterRemove?: GitWorktreeError
  throwBeforeAdd?: GitWorktreeError
  throwBeforeRemove?: GitWorktreeError
  readDelayMs = 0
  /** Simulate a pre-2.47 Git: `worktree list --porcelain -z` exits 129. */
  legacyGit = false
  onWorktreeList?: () => void
  onStatus?: () => void
  /** worktreePath -> gitDir (linked worktree `.git` pointer target). */
  readonly gitDirs = new Map<string, string>()
  /** `.git` pointer text overrides (relative/malformed probe coverage). */
  readonly pointerOverrides = new Map<string, string>()
  /** gitDir -> state file basenames present (attention probes). */
  readonly gitDirStateFiles = new Map<string, Set<string>>()

  readonly fs: WorktreeFileSystem = {
    realpath: async path => {
      this.realpathCalls.set(path, (this.realpathCalls.get(path) ?? 0) + 1)
      const aliased = this.aliases.get(path)
      if (aliased !== undefined && this.existing.has(aliased)) return aliased
      if (!this.existing.has(path)) throw new MissingPathError(path)
      return path
    },
    lstat: async path => {
      if (this.gitDirs.has(dirname(path)) && basename(path) === '.git') {
        return { isDirectory: () => false }
      }
      if (this.aliases.has(path)) return { isDirectory: () => true }
      if (!this.existing.has(path)) throw new MissingPathError(path)
      return { isDirectory: () => true }
    },
    exists: async path => {
      if (this.gitDirs.has(dirname(path)) && basename(path) === '.git') return true
      for (const [gitDir, files] of this.gitDirStateFiles) {
        if (path.startsWith(`${gitDir}/`)) return files.has(path.slice(gitDir.length + 1))
      }
      return this.existing.has(path)
    },
    mkdir: async () => {},
    readFile: async path => {
      const override = this.pointerOverrides.get(path)
      if (override !== undefined) return override
      const gitDir = this.gitDirs.get(dirname(path))
      if (gitDir !== undefined && basename(path) === '.git') return `gitdir: ${gitDir}`
      throw new MissingPathError(path)
    },
  }

  readonly runner: GitRunner = async request => {
    this.calls.push({ ...request, args: [...request.args] })
    const args = request.args
    if (args[0] !== 'worktree' || (args[1] !== 'add' && args[1] !== 'remove')) {
      if (this.readDelayMs > 0) await new Promise(resolve => setTimeout(resolve, this.readDelayMs))
    }
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
      const root = this.worktreeFor(request.cwd)?.path
      return root === undefined ? this.result(128, '', 'not a git repository') : this.result(0, `${root}\n`)
    }
    if (args[0] === 'rev-parse' && args[1] === '--path-format=absolute') {
      return this.worktreeFor(request.cwd) === undefined
        ? this.result(128, '', 'not a git repository')
        : this.result(0, `${COMMON}\n`)
    }
    if (args[0] === 'worktree' && args[1] === 'list') {
      this.onWorktreeList?.()
      if (this.failNextList) {
        this.failNextList = false
        return this.result(2, '', 'transient list failure')
      }
      const withZ = args.includes('-z')
      if (withZ && this.legacyGit) {
        return this.result(129, '', "error: unknown switch `z'")
      }
      return this.result(0, withZ ? this.porcelain() : this.newlinePorcelain())
    }
    if (args[0] === 'status') {
      this.onStatus?.()
      const worktree = this.worktrees.find(candidate => candidate.path === request.cwd)
      if (worktree?.statusFailure) return this.result(2, '', worktree.statusStderr ?? 'status unavailable')
      if (args.includes('--branch')) {
        const meta: string[] = []
        if ((worktree?.ahead ?? 0) > 0) meta.push(`ahead ${worktree!.ahead}`)
        if ((worktree?.behind ?? 0) > 0) meta.push(`behind ${worktree!.behind}`)
        const suffix = meta.length > 0 ? ` [${meta.join(', ')}]` : ''
        const name = worktree?.upstream !== undefined ? `${worktree!.branch ?? 'HEAD'}...${worktree!.upstream}` : (worktree?.branch ?? 'HEAD (no branch)')
        const header = `## ${name}${suffix}\0`
        return this.result(0, `${header}${worktree?.dirty ? ' M changed.txt\0' : ''}`)
      }
      return this.result(0, worktree?.dirty ? ' M changed.txt\0' : '')
    }
    if (args[0] === 'check-ref-format') {
      const branch = args[2]!
      return branch.includes('..') || branch.endsWith('.') ? this.result(1) : this.result(0, `${branch}\n`)
    }
    if (args[0] === 'branch' && args[1] === '-D') {
      const name = args[2]!
      if (!this.branches.has(name)) return this.result(1, '', `error: branch '${name}' not found.`)
      this.branches.delete(name)
      return this.result(0)
    }
    if (args[0] === 'show-ref' && args[1] === '--heads') {
      const lines = [...this.branches.entries()].map(([name, head]) => `${head} refs/heads/${name}`)
      return this.result(0, lines.length === 0 ? '' : `${lines.join('\n')}\n`)
    }
    if (args[0] === 'show-ref') {
      const name = args[3]!.slice('refs/heads/'.length)
      const head = this.branches.get(name)
      return head === undefined ? this.result(1) : this.result(0, `${head}\n`)
    }
    if (args[0] === 'worktree' && args[1] === 'add') {
      if (this.throwBeforeAdd !== undefined) {
        const error = this.throwBeforeAdd
        this.throwBeforeAdd = undefined
        throw error
      }
      await this.enterMutation()
      try {
        if (args[2] === '--') {
          const path = args[3]!
          const branch = args[4]!
          const head = this.branches.get(branch)
          if (head === undefined || this.existing.has(path)) return this.result(128, '', 'cannot add')
          this.existing.add(path)
          this.worktrees.push({ path, branch, head })
          if (this.failListAfterAdd) this.failNextList = true
          if (this.throwAfterAdd !== undefined) {
            const error = this.throwAfterAdd
            this.throwAfterAdd = undefined
            throw error
          }
          return this.result(0)
        }
        const branch = args[3]!
        const path = args[5]!
        const head = args[6]!
        if (this.branches.has(branch) || this.existing.has(path)) return this.result(128, '', 'cannot add')
        this.branches.set(branch, head)
        this.existing.add(path)
        this.worktrees.push({ path, branch, head })
        if (this.failListAfterAdd) this.failNextList = true
        if (this.throwAfterAdd !== undefined) {
          const error = this.throwAfterAdd
          this.throwAfterAdd = undefined
          throw error
        }
        return this.result(0)
      } finally {
        this.leaveMutation()
      }
    }
    if (args[0] === 'worktree' && args[1] === 'remove') {
      if (this.throwBeforeRemove !== undefined) {
        const error = this.throwBeforeRemove
        this.throwBeforeRemove = undefined
        throw error
      }
      await this.enterMutation()
      try {
        const path = args[3]!
        const index = this.worktrees.findIndex(candidate => candidate.path === path)
        if (index < 1) return this.result(128, '', 'cannot remove')
        this.worktrees.splice(index, 1)
        this.existing.delete(path)
        if (this.failListAfterRemove) this.failNextList = true
        if (this.throwAfterRemove !== undefined) {
          const error = this.throwAfterRemove
          this.throwAfterRemove = undefined
          throw error
        }
        return this.result(0)
      } finally {
        this.leaveMutation()
      }
    }
    throw new Error(`unexpected fake Git call: ${args.join(' ')}`)
  }

  addLinked(options: Partial<FakeWorktree> = {}): FakeWorktree {
    const worktree: FakeWorktree = {
      path: LINKED,
      branch: 'feature',
      head: FEATURE_HEAD,
      ...options,
    }
    this.existing.add(worktree.path)
    this.branches.set(worktree.branch!, worktree.head)
    this.worktrees.push(worktree)
    return worktree
  }

  private result(exitCode: number, stdout = '', stderr = ''): GitCommandResult {
    return { exitCode, stdout, stderr }
  }

  private worktreeFor(path: string): FakeWorktree | undefined {
    return this.worktrees.find(worktree => path === worktree.path || path.startsWith(`${worktree.path}/`))
  }

  private porcelain(): string {
    const fields: string[] = []
    for (const worktree of this.worktrees) {
      fields.push(`worktree ${worktree.path}`, `HEAD ${worktree.head}`)
      fields.push(worktree.branch === null ? 'detached' : `branch refs/heads/${worktree.branch}`)
      if (worktree.locked) fields.push('locked test')
      if (worktree.prunable) fields.push('prunable test')
      if (worktree.bare) fields.push('bare')
      fields.push('')
    }
    return `${fields.join('\0')}\0`
  }

  /** Newline-delimited --porcelain form (the pre-2.47 fallback): fields are
   *  line-separated and a blank line closes each record. */
  private newlinePorcelain(): string {
    const lines: string[] = []
    for (const worktree of this.worktrees) {
      lines.push(`worktree ${worktree.path}`, `HEAD ${worktree.head}`)
      lines.push(worktree.branch === null ? 'detached' : `branch refs/heads/${worktree.branch}`)
      if (worktree.locked) lines.push('locked test')
      if (worktree.prunable) lines.push('prunable test')
      if (worktree.bare) lines.push('bare')
      lines.push('')
    }
    return `${lines.join('\n')}\n`
  }

  private async enterMutation(): Promise<void> {
    this.activeMutations += 1
    this.maxActiveMutations = Math.max(this.maxActiveMutations, this.activeMutations)
    if (this.mutationDelayMs > 0) await new Promise(resolve => setTimeout(resolve, this.mutationDelayMs))
  }

  private leaveMutation(): void {
    this.activeMutations -= 1
  }
}

function setup(options: { linked?: boolean; operationCapacity?: number } = {}) {
  const repo = new FakeRepository()
  if (options.linked) repo.addLinked()
  const workspaces: WorkspaceFact[] = [{ workspaceId: 'ws-main', path: MAIN, sessionIds: [] }]
  if (options.linked) workspaces.push({ workspaceId: 'ws-feature', path: LINKED, sessionIds: ['s-feature'] })
  const agents: AgentFact[] = []
  let token = 0
  let clock = 1_000
  let sourceReadHook: (() => void) | undefined
  const core = new GitWorktreeCore({
    source: {
      listWorkspaces: () => {
        sourceReadHook?.()
        return workspaces.map(workspace => ({ ...workspace, sessionIds: [...workspace.sessionIds] }))
      },
      listAgents: () => agents.map(agent => ({ ...agent })),
    },
    git: repo.runner,
    fs: repo.fs,
    now: () => clock,
    token: () => `token-${++token}`,
    worktreesRoot: '/worktrees',
    ...(options.operationCapacity === undefined ? {} : { operationCapacity: options.operationCapacity }),
  })
  return {
    repo,
    workspaces,
    agents,
    core,
    advanceTime: (milliseconds: number) => { clock += milliseconds },
    setSourceReadHook: (hook: (() => void) | undefined) => { sourceReadHook = hook },
  }
}

async function previewNew(
  core: GitWorktreeCore,
  basename = 'new-worktree',
  branch = 'topic',
  options: { startRef?: string } = {},
) {
  return await core.previewCreate({
    sourceWorkspaceId: 'ws-main',
    basename,
    branch: { kind: 'new', name: branch },
    ...(options.startRef === undefined ? {} : { startRef: options.startRef }),
  })
}

function mutationCalls(repo: FakeRepository, verb: 'add' | 'remove') {
  return repo.calls.filter(call => call.args[0] === 'worktree' && call.args[1] === verb)
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
  const fs: WorktreeFileSystem = {
    realpath: async path => {
      if (!paths.has(path)) throw new MissingPathError(path)
      return path
    },
    lstat: async path => {
      if (!paths.has(path)) throw new MissingPathError(path)
      return { isDirectory: () => true }
    },
    exists: async path => paths.has(path),
    mkdir: async () => {},
    readFile: async () => { throw new MissingPathError('.git') },
  }
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
  const core = new GitWorktreeCore({
    source: { listWorkspaces: () => workspaces, listAgents: () => [] },
    git: runner,
    fs,
  })
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
    source: { listWorkspaces: () => { throw new Error('storage offline') }, listAgents: () => [] },
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
  const unavailable = new GitWorktreeCore({
    source: { listWorkspaces: () => workspaces, listAgents: () => [] },
    git: async () => { throw new GitWorktreeError('git-spawn-failed', 'spawn git ENOENT') },
    fs: repo.fs,
  })
  const sourceWide = await unavailable.snapshot()
  assert.equal(sourceWide.sourceError?.code, 'git-unavailable')
  assert.deepEqual(sourceWide.repos, [])
  assert.equal(sourceWide.errors.length, 2)
  assert.equal(sourceWide.errors.every(error => error.code === 'git-spawn-failed'), true)

  const notRepository = new GitWorktreeCore({
    source: { listWorkspaces: () => [workspaces[0]!], listAgents: () => [] },
    git: async () => ({ exitCode: 128, stdout: '', stderr: 'not a git repository' }),
    fs: repo.fs,
  })
  const localOnly = await notRepository.snapshot()
  assert.equal(localOnly.sourceError, undefined)
  assert.deepEqual(localOnly.repos, [])
  assert.equal(localOnly.errors[0]?.code, 'git-command-failed')
})

test('preview and create a new branch with bounded fixed argv and idempotent replay', async () => {
  const { core, repo } = setup()
  const preview = await previewNew(core)
  assert.equal(preview.targetPath, `/worktrees/${WORKTREES_KEY}/new-worktree`)
  assert.equal(preview.baseHead, MAIN_HEAD)
  assert.match(preview.repoId, /^repo_[0-9a-f]{64}$/)

  const created = await core.create({ previewToken: preview.previewToken, operationId: 'create-1' })
  assert.equal(created.created, true)
  assert.equal(created.replayed, false)
  assert.equal(created.rollbackAuthorized, true)
  assert.equal(created.branchCreated, true)
  assert.match(created.worktreeId, /^worktree_[0-9a-f]{64}$/)
  assert.deepEqual(mutationCalls(repo, 'add')[0]!.args, [
    'worktree', 'add', '-b', 'topic', '--', `/worktrees/${WORKTREES_KEY}/new-worktree`, MAIN_HEAD,
  ])
  assert.equal(mutationCalls(repo, 'add')[0]!.timeoutMs, 30_000)
  assert.equal(mutationCalls(repo, 'add')[0]!.maxOutputBytes, 256 * 1024)

  const replay = await core.create({ previewToken: preview.previewToken, operationId: 'create-1' })
  assert.equal(replay.replayed, true)
  assert.equal(replay.worktreeId, created.worktreeId)
  assert.equal(mutationCalls(repo, 'add').length, 1)
})

test('create revalidates an existing branch and rejects a moved preview', async () => {
  const { core, repo } = setup()
  repo.branches.set('existing', FEATURE_HEAD)
  const preview = await core.previewCreate({
    sourceWorkspaceId: 'ws-main',
    basename: 'existing-tree',
    branch: { kind: 'existing', name: 'existing' },
  })
  repo.branches.set('existing', '3333333333333333333333333333333333333333')
  await assert.rejects(
    core.create({ previewToken: preview.previewToken, operationId: 'stale-1' }),
    error => error instanceof GitWorktreeError && error.code === 'preview-stale',
  )
  assert.equal(mutationCalls(repo, 'add').length, 0)
})

test('a zero-exit add remains rollback-authorized when postcondition reading fails', async () => {
  const { core, repo } = setup()
  const preview = await previewNew(core)
  repo.failListAfterAdd = true
  await assert.rejects(core.create({ previewToken: preview.previewToken, operationId: 'uncertain-create' }))
  assert.equal(repo.worktrees.some(worktree => worktree.path === preview.targetPath), true)
  const reconciled = await core.create({ previewToken: preview.previewToken, operationId: 'uncertain-create' })
  assert.equal(reconciled.replayed, true)
  assert.equal(reconciled.rollbackAuthorized, true)
  assert.equal(mutationCalls(repo, 'add').length, 1)
  const rollback = await core.rollbackCreate({ operationId: 'uncertain-create' })
  assert.equal(rollback.removed, true)
  assert.equal(repo.worktrees.some(worktree => worktree.path === preview.targetPath), false)
})

test('timeout reconciliation can advance but never grants rollback provenance', async () => {
  const { core, repo } = setup()
  const preview = await previewNew(core)
  repo.throwAfterAdd = new GitWorktreeError('git-timeout', 'simulated timeout')
  await assert.rejects(
    core.create({ previewToken: preview.previewToken, operationId: 'timeout-create' }),
    error => error instanceof GitWorktreeError && error.code === 'git-timeout',
  )
  const reconciled = await core.create({ previewToken: preview.previewToken, operationId: 'timeout-create' })
  assert.equal(reconciled.created, true)
  assert.equal(reconciled.replayed, true)
  assert.equal(reconciled.rollbackAuthorized, false)
  assert.equal(reconciled.branchCreated, false)
  assert.equal(mutationCalls(repo, 'add').length, 1)
  await assert.rejects(
    core.rollbackCreate({ operationId: 'timeout-create' }),
    error => error instanceof GitWorktreeError && error.code === 'rollback-not-authorized',
  )
  assert.equal(mutationCalls(repo, 'remove').length, 0)
})

test('spawn failure cannot adopt or roll back an external exact-identity worktree', async () => {
  const { core, repo } = setup()
  const preview = await previewNew(core)
  repo.throwBeforeAdd = new GitWorktreeError('git-spawn-failed', 'simulated ENOENT')
  await assert.rejects(
    core.create({ previewToken: preview.previewToken, operationId: 'spawn-create' }),
    error => error instanceof GitWorktreeError && error.code === 'git-spawn-failed',
  )
  repo.branches.set(preview.branch, preview.baseHead)
  repo.existing.add(preview.targetPath)
  repo.worktrees.push({ path: preview.targetPath, branch: preview.branch, head: preview.baseHead })
  await assert.rejects(
    core.create({ previewToken: preview.previewToken, operationId: 'spawn-create' }),
    error => error instanceof GitWorktreeError && error.code === 'target-exists',
  )
  await assert.rejects(
    core.rollbackCreate({ operationId: 'spawn-create' }),
    error => error instanceof GitWorktreeError && error.code === 'operation-not-created',
  )
  assert.equal(mutationCalls(repo, 'remove').length, 0)
})

test('created terminal replay rejects a deleted or replaced worktree instead of returning cached authority', async () => {
  for (const change of ['deleted', 'replaced'] as const) {
    const { core, repo } = setup()
    const preview = await previewNew(core, `terminal-${change}`, `terminal-branch-${change}`)
    const created = await core.create({
      previewToken: preview.previewToken,
      operationId: `terminal-create-${change}`,
    })
    const index = repo.worktrees.findIndex(worktree => worktree.path === created.path)
    assert.ok(index > 0)
    if (change === 'deleted') {
      repo.worktrees.splice(index, 1)
      repo.existing.delete(created.path)
    } else {
      repo.worktrees[index]!.branch = 'external-replacement'
    }
    await assert.rejects(
      core.create({ previewToken: preview.previewToken, operationId: `terminal-create-${change}` }),
      error => error instanceof GitWorktreeError && error.code === 'operation-conflict',
    )
    assert.equal(mutationCalls(repo, 'add').length, 1)
  }
})

test('same repository worktree mutations are serialized by absolute common directory', async () => {
  const { core, repo } = setup()
  const first = await previewNew(core, 'one', 'topic-one')
  const second = await previewNew(core, 'two', 'topic-two')
  repo.mutationDelayMs = 20
  const [one, two] = await Promise.all([
    core.create({ previewToken: first.previewToken, operationId: 'parallel-1' }),
    core.create({ previewToken: second.previewToken, operationId: 'parallel-2' }),
  ])
  assert.equal(one.created && two.created, true)
  assert.equal(repo.maxActiveMutations, 1)
})

test('terminal operation ids expire after the bounded replay TTL', async () => {
  const { core, advanceTime } = setup()
  const first = await previewNew(core, 'ttl-first', 'ttl-branch-first')
  await core.create({ previewToken: first.previewToken, operationId: 'ttl-operation' })
  await core.rollbackCreate({ operationId: 'ttl-operation' })
  advanceTime(OPERATION_TTL_MS + 1)

  const second = await previewNew(core, 'ttl-second', 'ttl-branch-second')
  const reused = await core.create({ previewToken: second.previewToken, operationId: 'ttl-operation' })
  assert.equal(reused.path, `/worktrees/${WORKTREES_KEY}/ttl-second`)
  assert.equal(reused.replayed, false)
})

test('operation capacity evicts the oldest safe pre-admission record instead of wedging new work', async () => {
  const operationCapacity = 4
  const { core, advanceTime } = setup({ operationCapacity })
  const zeros = '0'.repeat(64)
  const expected = {
    repoId: `repo_${zeros}`,
    worktreeId: `worktree_${zeros}`,
    branch: 'main',
    head: MAIN_HEAD,
  }
  for (let index = 0; index <= operationCapacity; index += 1) {
    await assert.rejects(
      core.remove({
        operationId: `capacity-${index}`,
        workspaceId: `missing-${index}`,
        expected,
      }),
      error => error instanceof GitWorktreeError && error.code === 'workspace-not-found',
    )
    advanceTime(1)
  }
  await assert.rejects(
    core.remove({
      operationId: 'capacity-0',
      workspaceId: 'reused-after-eviction',
      expected,
    }),
    error => error instanceof GitWorktreeError && error.code === 'workspace-not-found',
  )
})

test('capacity never evicts an uncertain mutation tombstone before TTL', async () => {
  const { core, repo } = setup({ linked: true, operationCapacity: 1 })
  const snapshot = await core.snapshot()
  const repository = snapshot.repos[0]!
  const linked = repository.worktrees.find(worktree => worktree.path === LINKED)!
  const expected = {
    repoId: repository.repoId,
    worktreeId: linked.worktreeId,
    branch: linked.branch,
    head: linked.head,
  }
  repo.throwBeforeRemove = new GitWorktreeError('git-timeout', 'simulated pre-commit timeout')
  await assert.rejects(
    core.remove({ operationId: 'retained-uncertain', workspaceId: 'ws-feature', expected }),
    error => error instanceof GitWorktreeError && error.code === 'git-timeout',
  )
  await assert.rejects(
    core.remove({ operationId: 'must-fail-closed', workspaceId: 'ws-feature', expected }),
    error => error instanceof GitWorktreeError && error.code === 'operation-capacity',
  )
  assert.equal(mutationCalls(repo, 'remove').length, 1)
})

test('capacity retains a completed remove tombstone against same-identity ABA', async () => {
  const { core, repo } = setup({ linked: true, operationCapacity: 1 })
  const snapshot = await core.snapshot()
  const repository = snapshot.repos[0]!
  const linked = repository.worktrees.find(worktree => worktree.path === LINKED)!
  const expected = {
    repoId: repository.repoId,
    worktreeId: linked.worktreeId,
    branch: linked.branch,
    head: linked.head,
  }
  await core.remove({ operationId: 'retained-removed', workspaceId: 'ws-feature', expected })
  repo.addLinked()
  await assert.rejects(
    core.remove({ operationId: 'aba-remove', workspaceId: 'ws-feature', expected }),
    error => error instanceof GitWorktreeError && error.code === 'operation-capacity',
  )
  assert.equal(mutationCalls(repo, 'remove').length, 1)
  assert.equal(repo.worktrees.some(worktree => worktree.path === LINKED), true)
})

test('rollback is operation-bound, refuses a workspace, then removes clean without force', async () => {
  const { core, repo, workspaces } = setup()
  const preview = await previewNew(core)
  const created = await core.create({ previewToken: preview.previewToken, operationId: 'rollback-1' })
  workspaces.push({ workspaceId: 'ws-new', path: created.path, sessionIds: [] })
  await assert.rejects(
    core.rollbackCreate({ operationId: 'rollback-1' }),
    error => error instanceof GitWorktreeError && error.code === 'rollback-has-workspace',
  )
  workspaces.pop()
  const rolledBack = await core.rollbackCreate({ operationId: 'rollback-1' })
  assert.equal(rolledBack.removed, true)
  assert.equal(rolledBack.branchPreserved, true)
  assert.deepEqual(mutationCalls(repo, 'remove')[0]!.args, ['worktree', 'remove', '--', created.path])
  assert.equal(repo.branches.has('topic'), true)
  const replay = await core.rollbackCreate({ operationId: 'rollback-1' })
  assert.equal(replay.replayed, true)
  assert.equal(mutationCalls(repo, 'remove').length, 1)
})

test('rollback reconciles authoritative absence after its postcondition read fails', async () => {
  const { core, repo } = setup()
  const preview = await previewNew(core)
  const created = await core.create({ previewToken: preview.previewToken, operationId: 'rollback-reconcile' })
  repo.failListAfterRemove = true
  await assert.rejects(core.rollbackCreate({ operationId: 'rollback-reconcile' }))
  assert.equal(repo.worktrees.some(worktree => worktree.path === created.path), false)
  const reconciled = await core.rollbackCreate({ operationId: 'rollback-reconcile' })
  assert.equal(reconciled.removed, true)
  assert.equal(reconciled.replayed, true)
  assert.equal(mutationCalls(repo, 'remove').length, 1)
})

test('rollback refuses dirty operation-created worktrees', async () => {
  const { core, repo } = setup()
  const preview = await previewNew(core)
  const created = await core.create({ previewToken: preview.previewToken, operationId: 'dirty-rollback' })
  repo.worktrees.find(worktree => worktree.path === created.path)!.dirty = true
  await assert.rejects(
    core.rollbackCreate({ operationId: 'dirty-rollback' }),
    error => error instanceof GitWorktreeError && error.code === 'worktree-dirty',
  )
  assert.equal(mutationCalls(repo, 'remove').length, 0)
})

test('rollback refuses clean worktrees whose HEAD changed after creation', async () => {
  const { core, repo } = setup()
  const preview = await previewNew(core)
  const created = await core.create({ previewToken: preview.previewToken, operationId: 'head-rollback' })
  repo.worktrees.find(worktree => worktree.path === created.path)!.head =
    '4444444444444444444444444444444444444444'
  await assert.rejects(
    core.rollbackCreate({ operationId: 'head-rollback' }),
    error => error instanceof GitWorktreeError && error.code === 'worktree-changed',
  )
  assert.equal(mutationCalls(repo, 'remove').length, 0)
})

test('rollback repeats Git identity checks after the final registry and agent scan', async () => {
  const { core, repo, setSourceReadHook } = setup()
  const preview = await previewNew(core)
  const created = await core.create({ previewToken: preview.previewToken, operationId: 'rollback-final-check' })
  let reads = 0
  setSourceReadHook(() => {
    reads += 1
    if (reads === 2) {
      repo.worktrees.find(worktree => worktree.path === created.path)!.head =
        '5555555555555555555555555555555555555555'
    }
  })
  await assert.rejects(
    core.rollbackCreate({ operationId: 'rollback-final-check' }),
    error => error instanceof GitWorktreeError && error.code === 'worktree-changed',
  )
  assert.equal(mutationCalls(repo, 'remove').length, 0)
})

test('rollback canonicalizes workspace paths and catches a symlink alias', async () => {
  const { core, repo, workspaces } = setup()
  const preview = await previewNew(core)
  const created = await core.create({ previewToken: preview.previewToken, operationId: 'alias-rollback' })
  repo.aliases.set('/aliases/created', created.path)
  workspaces.push({ workspaceId: 'ws-alias', path: '/aliases/created', sessionIds: [] })
  await assert.rejects(
    core.rollbackCreate({ operationId: 'alias-rollback' }),
    error => error instanceof GitWorktreeError && error.code === 'rollback-has-workspace',
  )
  assert.equal(mutationCalls(repo, 'remove').length, 0)
})

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

test('removed terminal replay rejects a reappeared worktree without deleting it again', async () => {
  const { core, repo } = setup({ linked: true })
  const snapshot = await core.snapshot()
  const repository = snapshot.repos[0]!
  const linked = repository.worktrees.find(worktree => worktree.path === LINKED)!
  const input = {
    operationId: 'terminal-remove-reappeared',
    workspaceId: 'ws-feature',
    expected: {
      repoId: repository.repoId,
      worktreeId: linked.worktreeId,
      branch: linked.branch,
      head: linked.head,
    },
  }
  await core.remove(input)
  repo.addLinked()
  await assert.rejects(
    core.remove(input),
    error => error instanceof GitWorktreeError && error.code === 'operation-conflict',
  )
  assert.equal(mutationCalls(repo, 'remove').length, 1)
  assert.equal(repo.worktrees.some(worktree => worktree.path === LINKED), true)
})

test('removed terminal replay requires the same workspace membership and no running agent', async () => {
  for (const change of ['membership', 'running'] as const) {
    const { core, repo, workspaces, agents } = setup({ linked: true })
    const snapshot = await core.snapshot()
    const repository = snapshot.repos[0]!
    const linked = repository.worktrees.find(worktree => worktree.path === LINKED)!
    const input = {
      operationId: `terminal-remove-${change}`,
      workspaceId: 'ws-feature',
      expected: {
        repoId: repository.repoId,
        worktreeId: linked.worktreeId,
        branch: linked.branch,
        head: linked.head,
      },
    }
    await core.remove(input)
    if (change === 'membership') {
      const workspaceIndex = workspaces.findIndex(workspace => workspace.workspaceId === 'ws-feature')
      workspaces[workspaceIndex] = {
        ...workspaces[workspaceIndex]!,
        sessionIds: [...workspaces[workspaceIndex]!.sessionIds, 'new-session'],
      }
    } else {
      agents.push({ sessionId: 's-feature', status: 'running', cwd: LINKED })
    }
    await assert.rejects(
      core.remove(input),
      error => error instanceof GitWorktreeError
        && error.code === (change === 'membership' ? 'operation-conflict' : 'running-agent'),
    )
    assert.equal(mutationCalls(repo, 'remove').length, 1)
  }
})

test('remove retries reconcile committed timeout and postcondition-read failures without a second delete', async () => {
  for (const failure of ['timeout', 'post-read'] as const) {
    const { core, repo } = setup({ linked: true })
    const snapshot = await core.snapshot()
    const repository = snapshot.repos[0]!
    const linked = repository.worktrees.find(worktree => worktree.path === LINKED)!
    const input = {
      operationId: `remove-${failure}`,
      workspaceId: 'ws-feature',
      expected: {
        repoId: repository.repoId,
        worktreeId: linked.worktreeId,
        branch: linked.branch,
        head: linked.head,
      },
    }
    if (failure === 'timeout') {
      repo.throwAfterRemove = new GitWorktreeError('git-timeout', 'simulated timeout')
    } else {
      repo.failListAfterRemove = true
    }
    await assert.rejects(core.remove(input))
    assert.equal(repo.worktrees.some(worktree => worktree.path === LINKED), false)
    const reconciled = await core.remove(input)
    assert.equal(reconciled.removed, true)
    assert.equal(reconciled.replayed, true)
    assert.deepEqual(reconciled.sessionIds, ['s-feature'])
    assert.equal(mutationCalls(repo, 'remove').length, 1)
  }
})

test('uncertain remove reconciliation fails closed when membership or liveness changed', async () => {
  for (const change of ['membership', 'running'] as const) {
    const { core, repo, workspaces, agents } = setup({ linked: true })
    const snapshot = await core.snapshot()
    const repository = snapshot.repos[0]!
    const linked = repository.worktrees.find(worktree => worktree.path === LINKED)!
    const input = {
      operationId: `uncertain-receipt-${change}`,
      workspaceId: 'ws-feature',
      expected: {
        repoId: repository.repoId,
        worktreeId: linked.worktreeId,
        branch: linked.branch,
        head: linked.head,
      },
    }
    repo.throwAfterRemove = new GitWorktreeError('git-timeout', 'simulated committed timeout')
    await assert.rejects(core.remove(input))
    if (change === 'membership') {
      const workspaceIndex = workspaces.findIndex(workspace => workspace.workspaceId === 'ws-feature')
      workspaces[workspaceIndex] = {
        ...workspaces[workspaceIndex]!,
        sessionIds: [...workspaces[workspaceIndex]!.sessionIds, 'late-session'],
      }
    } else {
      agents.push({ sessionId: 's-feature', status: 'running', cwd: LINKED })
    }
    await assert.rejects(
      core.remove(input),
      error => error instanceof GitWorktreeError
        && error.code === (change === 'membership' ? 'operation-conflict' : 'running-agent'),
    )
    assert.equal(mutationCalls(repo, 'remove').length, 1)
    assert.equal(repo.worktrees.some(worktree => worktree.path === LINKED), false)
  }
})

test('remove repeats Git identity checks after the final registry and agent scan', async () => {
  const { core, repo, setSourceReadHook } = setup({ linked: true })
  const snapshot = await core.snapshot()
  const repository = snapshot.repos[0]!
  const linked = repository.worktrees.find(worktree => worktree.path === LINKED)!
  let reads = 0
  setSourceReadHook(() => {
    reads += 1
    if (reads === 3) repo.worktrees[1]!.branch = 'changed-after-state-scan'
  })
  await assert.rejects(
    core.remove({
      operationId: 'remove-final-check',
      workspaceId: 'ws-feature',
      expected: {
        repoId: repository.repoId,
        worktreeId: linked.worktreeId,
        branch: linked.branch,
        head: linked.head,
      },
    }),
    error => error instanceof GitWorktreeError && error.code === 'operation-conflict',
  )
  assert.equal(mutationCalls(repo, 'remove').length, 0)
})

test('remove final absent convergence rechecks membership and liveness receipts', async () => {
  for (const change of ['membership', 'running'] as const) {
    const { core, repo, workspaces, agents } = setup({ linked: true })
    const snapshot = await core.snapshot()
    const repository = snapshot.repos[0]!
    const linked = repository.worktrees.find(worktree => worktree.path === LINKED)!
    let actionLists = 0
    repo.onWorktreeList = () => {
      actionLists += 1
      if (actionLists !== 2) return
      const targetIndex = repo.worktrees.findIndex(worktree => worktree.path === LINKED)
      assert.notEqual(targetIndex, -1)
      repo.worktrees.splice(targetIndex, 1)
      repo.existing.delete(LINKED)
      if (change === 'membership') {
        const workspaceIndex = workspaces.findIndex(workspace => workspace.workspaceId === 'ws-feature')
        workspaces[workspaceIndex] = {
          ...workspaces[workspaceIndex]!,
          sessionIds: [...workspaces[workspaceIndex]!.sessionIds, 'late-session'],
        }
      } else {
        agents.push({ sessionId: 's-feature', status: 'running', cwd: LINKED })
      }
    }

    await assert.rejects(
      core.remove({
        operationId: `remove-final-absent-${change}`,
        workspaceId: 'ws-feature',
        expected: {
          repoId: repository.repoId,
          worktreeId: linked.worktreeId,
          branch: linked.branch,
          head: linked.head,
        },
      }),
      error => error instanceof GitWorktreeError
        && error.code === (change === 'membership' ? 'operation-conflict' : 'running-agent'),
    )
    assert.equal(actionLists, 2)
    assert.equal(repo.worktrees.some(worktree => worktree.path === LINKED), false)
    assert.equal(mutationCalls(repo, 'remove').length, 0)
  }
})

test('remove refuses main, dirty and locked worktrees without exposing force', async () => {
  const { core, repo } = setup({ linked: true })
  let snapshot = await core.snapshot()
  const repository = snapshot.repos[0]!
  const main = repository.worktrees[0]!
  await assert.rejects(
    core.remove({
      operationId: 'remove-main',
      workspaceId: 'ws-main',
      expected: { repoId: repository.repoId, worktreeId: main.worktreeId, branch: 'main', head: MAIN_HEAD },
    }),
    error => error instanceof GitWorktreeError && error.code === 'main-worktree',
  )

  repo.worktrees[1]!.dirty = true
  snapshot = await core.snapshot()
  let linked = snapshot.repos[0]!.worktrees[1]!
  await assert.rejects(
    core.remove({
      operationId: 'remove-dirty',
      workspaceId: 'ws-feature',
      expected: {
        repoId: snapshot.repos[0]!.repoId,
        worktreeId: linked.worktreeId,
        branch: linked.branch!,
        head: linked.head,
      },
    }),
    error => error instanceof GitWorktreeError && error.code === 'worktree-dirty',
  )
  repo.worktrees[1]!.dirty = false
  repo.worktrees[1]!.locked = true
  snapshot = await core.snapshot()
  linked = snapshot.repos[0]!.worktrees[1]!
  await assert.rejects(
    core.remove({
      operationId: 'remove-locked',
      workspaceId: 'ws-feature',
      expected: {
        repoId: snapshot.repos[0]!.repoId,
        worktreeId: linked.worktreeId,
        branch: linked.branch!,
        head: linked.head,
      },
    }),
    error => error instanceof GitWorktreeError && error.code === 'worktree-locked',
  )
  assert.equal(mutationCalls(repo, 'remove').length, 0)
})

test('remove accepts a detached linked worktree only with expected branch null', async () => {
  const { core, repo } = setup({ linked: true })
  repo.worktrees[1]!.branch = null
  const snapshot = await core.snapshot()
  const repository = snapshot.repos[0]!
  const linked = repository.worktrees[1]!
  assert.equal(linked.branch, null)
  const removed = await core.remove({
    operationId: 'remove-detached',
    workspaceId: 'ws-feature',
    expected: {
      repoId: repository.repoId,
      worktreeId: linked.worktreeId,
      branch: null,
      head: linked.head,
    },
  })
  assert.equal(removed.branch, null)
  assert.equal(removed.removed, true)
})

test('remove refuses a second workspace nested below the worktree', async () => {
  const { core, repo, workspaces } = setup({ linked: true })
  const snapshot = await core.snapshot()
  const repository = snapshot.repos[0]!
  const linked = repository.worktrees[1]!
  repo.existing.add(`${LINKED}/nested-workspace`)
  workspaces.push({ workspaceId: 'ws-nested', path: `${LINKED}/nested-workspace`, sessionIds: [] })
  await assert.rejects(
    core.remove({
      operationId: 'remove-nested',
      workspaceId: 'ws-feature',
      expected: {
        repoId: repository.repoId,
        worktreeId: linked.worktreeId,
        branch: linked.branch,
        head: linked.head,
      },
    }),
    error => error instanceof GitWorktreeError && error.code === 'nested-workspace',
  )
  assert.equal(mutationCalls(repo, 'remove').length, 0)
})

test('wire input cannot inject a path, option, network verb or operation reuse', async () => {
  assert.throws(
    () => assertSafeGitArgv(['fetch', 'origin']),
    error => error instanceof GitWorktreeError && error.code === 'unsafe-git-argv',
  )
  assert.throws(
    () => assertSafeGitArgv(['worktree', 'add', '--', '/safe/path', '--upload-pack=evil']),
    error => error instanceof GitWorktreeError && error.code === 'unsafe-git-argv',
  )
  const { core } = setup()
  await assert.rejects(
    core.previewCreate({
      sourceWorkspaceId: 'ws-main',
      basename: '../escape',
      branch: { kind: 'new', name: 'topic' },
    }),
    error => error instanceof GitWorktreeError && error.code === 'unsafe-path',
  )
  await assert.rejects(
    core.previewCreate({
      sourceWorkspaceId: 'ws-main',
      basename: 'safe',
      branch: { kind: 'new', name: '--evil' },
    }),
    error => error instanceof GitWorktreeError && error.code === 'invalid-branch',
  )

  const first = await previewNew(core, 'first', 'first-branch')
  const second = await previewNew(core, 'second', 'second-branch')
  await core.create({ previewToken: first.previewToken, operationId: 'same-op' })
  await assert.rejects(
    core.create({ previewToken: second.previewToken, operationId: 'same-op' }),
    error => error instanceof GitWorktreeError && error.code === 'operation-conflict',
  )
})

test('core independently enforces injected runner output caps', async () => {
  const repo = new FakeRepository()
  const overflowing: GitRunner = async request => {
    if (request.args[0] === 'rev-parse') {
      return { exitCode: 0, stdout: 'x'.repeat(request.maxOutputBytes + 1), stderr: '' }
    }
    return repo.runner(request)
  }
  const core = new GitWorktreeCore({
    source: { listWorkspaces: () => [{ workspaceId: 'ws', path: MAIN, sessionIds: [] }], listAgents: () => [] },
    git: overflowing,
    fs: repo.fs,
  })
  const result = await core.snapshot()
  assert.equal(result.repos.length, 0)
  assert.equal(result.errors.some(error => error.code === 'git-output-limit'), true)
})

test('domain carrier preserves stable business errors and lets true internal failures throw', async () => {
  assert.deepEqual(await domainResult(async () => ({ answer: 42 })), {
    ok: true,
    value: { answer: 42 },
  })
  assert.deepEqual(await domainResult(async () => {
    throw new GitWorktreeError('git-timeout', 'try again', {
      details: { phase: 'create' },
    })
  }), {
    ok: false,
    error: {
      code: 'git-timeout',
      message: 'try again',
      retryable: true,
      details: { phase: 'create' },
    },
  })
  await assert.rejects(
    domainResult(async () => { throw new Error('programming failure') }),
    /programming failure/,
  )
})

test('local runner waits for child close after output kill before settling', async () => {
  class FakeChild extends EventEmitter implements GitChildProcess {
    readonly stdout = new EventEmitter()
    readonly stderr = new EventEmitter()
    killed = false

    kill(): boolean {
      this.killed = true
      this.emit('error', new Error('simulated kill failure event'))
      return false
    }
  }

  const child = new FakeChild()
  const runner = createLocalGitRunner(() => child)
  const pending = runner({
    cwd: MAIN,
    args: ['status', '--porcelain=v1', '-z', '--untracked-files=normal'],
    timeoutMs: 1_000,
    maxOutputBytes: 4,
  })
  let settled = false
  void pending.then(
    () => { settled = true },
    () => { settled = true },
  )
  child.stdout.emit('data', Buffer.from('12345'))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(child.killed, true)
  assert.equal(settled, false)
  child.emit('close', null)
  await assert.rejects(
    pending,
    error => error instanceof GitWorktreeError && error.code === 'git-output-limit',
  )
  assert.equal(settled, true)
})

test('local runner normalizes synchronous spawn throws as pre-admission failure', async () => {
  const runner = createLocalGitRunner(() => { throw new Error('synchronous spawn failure') })
  await assert.rejects(
    runner({
      cwd: MAIN,
      args: ['status', '--porcelain=v1', '-z', '--untracked-files=normal'],
      timeoutMs: 1_000,
      maxOutputBytes: 1_024,
    }),
    error => error instanceof GitWorktreeError
      && error.code === 'git-spawn-failed'
      && /synchronous spawn failure/u.test(error.message),
  )
})

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
  const fs: WorktreeFileSystem = {
    realpath: async path => {
      if (!paths.has(path)) throw new MissingPathError(path)
      return path
    },
    lstat: async path => {
      if (!paths.has(path)) throw new MissingPathError(path)
      return { isDirectory: () => true }
    },
    exists: async path => paths.has(path),
    mkdir: async () => {},
    readFile: async () => { throw new MissingPathError('.git') },
  }
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
  const core = new GitWorktreeCore({
    source: { listWorkspaces: () => workspaces, listAgents: () => [] },
    git: runner,
    fs,
  })
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
  class FakeChild extends EventEmitter implements GitChildProcess {
    readonly stdout = new EventEmitter()
    readonly stderr = new EventEmitter()
    killed = false

    kill(): boolean {
      this.killed = true
      return true
    }
  }

  const child = new FakeChild()
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
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(child.killed, true)
  assert.equal(settled, false)
  child.emit('close', null)
  await assert.rejects(
    pending,
    error => error instanceof GitWorktreeError && error.code === 'git-timeout',
  )
  assert.equal(settled, true)
})

test('local runner enforces a combined stdout+stderr byte cap', async () => {
  class FakeChild extends EventEmitter implements GitChildProcess {
    readonly stdout = new EventEmitter()
    readonly stderr = new EventEmitter()
    killed = false

    kill(): boolean {
      this.killed = true
      return true
    }
  }

  const child = new FakeChild()
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
  const failingCore = new GitWorktreeCore({
    source: {
      listWorkspaces: () => workspaces.map(workspace => ({ ...workspace, sessionIds: [...workspace.sessionIds] })),
      listAgents: () => [],
    },
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
  const strictCore = new GitWorktreeCore({
    source: {
      listWorkspaces: () => workspaces.map(workspace => ({ ...workspace, sessionIds: [...workspace.sessionIds] })),
      listAgents: () => [],
    },
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
