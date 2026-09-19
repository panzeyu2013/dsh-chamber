/**
 * Shared in-memory fixtures for the git-worktree core suite: the Git/filesystem fakes,
 * FakeRepository, and the setup/preview/mutation/leftover-record helpers. Never a test entry point.
 */

import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import {
  basename,
  dirname,
  resolve,
} from 'node:path'
import {
  GitWorktreeCore,
  GitWorktreeError,
  type AgentFact,
  type GitChildProcess,
  type GitCommandRequest,
  type GitCommandResult,
  type GitRunner,
  type WorkspaceFact,
  type WorktreeFileSystem,
} from '../../src/core.ts'

export const MAIN = '/repos/project'
export const COMMON = '/repos/project/.git'
export const LINKED = '/repos/feature'
/** worktreeRootFor key: `<basename>-<sha256(commonDir) 12 hex>`. */
export const WORKTREES_KEY = `project-${createHash('sha256').update(COMMON).digest('hex').slice(0, 12)}`
export const MAIN_HEAD = '1111111111111111111111111111111111111111'
export const FEATURE_HEAD = '2222222222222222222222222222222222222222'

export interface FakeWorktree {
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

export class MissingPathError extends Error {
  readonly code = 'ENOENT'
}

export class FakeRepository {
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
      // Reality model: spawning `git status` inside a cwd that no longer
      // exists fails like a spawn-ENOENT — a retryable runner rejection, NOT
      // the path-unavailable GitWorktreeError the removal degrade catches
      // route. A missing-row removal path must never issue this probe.
      if (!this.existing.has(request.cwd)) {
        throw new GitWorktreeError('git-spawn-failed', `spawn git ENOENT for '${request.cwd}'`)
      }
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
        // Both grammars are allowlisted: `remove -- <path>` and the
        // discardChanges-authorized `remove --force -- <path>`.
        const path = args[2] === '--force' ? args[4]! : args[3]!
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

export function setup(options: { linked?: boolean; operationCapacity?: number; worktreesRoot?: string | null } = {}) {
  const repo = new FakeRepository()
  if (options.linked) repo.addLinked()
  const workspaces: WorkspaceFact[] = [{ workspaceId: 'ws-main', path: MAIN, sessionIds: [] }]
  if (options.linked) workspaces.push({ workspaceId: 'ws-feature', path: LINKED, sessionIds: ['s-feature'] })
  const agents: AgentFact[] = []
  /** Authoritative archived set the guard reads (mutable per test). */
  const archived: string[] = []
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
      listArchivedSessionIds: () => [...archived],
    },
    git: repo.runner,
    fs: repo.fs,
    now: () => clock,
    token: () => `token-${++token}`,
    // `null` OMITS the option, so the constructor resolves the harness home
    // itself (the `$DSH_HOME` coverage below).
    ...(options.worktreesRoot === null ? {} : { worktreesRoot: options.worktreesRoot ?? '/worktrees' }),
    ...(options.operationCapacity === undefined ? {} : { operationCapacity: options.operationCapacity }),
  })
  return {
    repo,
    workspaces,
    agents,
    archived,
    core,
    advanceTime: (milliseconds: number) => { clock += milliseconds },
    setSourceReadHook: (hook: (() => void) | undefined) => { sourceReadHook = hook },
  }
}

export async function previewNew(
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

export function mutationCalls(repo: FakeRepository, verb: 'add' | 'remove') {
  return repo.calls.filter(call => call.args[0] === 'worktree' && call.args[1] === verb)
}

export const STALE = '/repos/stale-missing'

export function addStaleRecord(repo: FakeRepository): void {
  repo.addLinked({ path: STALE, branch: 'stale', head: FEATURE_HEAD })
  // The drill deletes the directory; the git metadata record survives.
  repo.existing.delete(STALE)
}

/**
 * Snapshot the first repository and resolve one row by path, with the wire
 * identity object every removal call needs. The missing-row lookup is a test
 * bug: fixtures must register the path they target.
 */
export async function targetOf(core: GitWorktreeCore, path: string = LINKED) {
  const snapshot = await core.snapshot()
  const repository = snapshot.repos[0]!
  const row = repository.worktrees.find(worktree => worktree.path === path)!
  return {
    snapshot,
    repository,
    row,
    expected: { repoId: repository.repoId, worktreeId: row.worktreeId, branch: row.branch!, head: row.head },
  }
}

/** assert.rejects predicate for a typed core refusal, optionally matching the message. */
export function refuses(code: string, message?: RegExp) {
  return (error: unknown): boolean => error instanceof GitWorktreeError
    && error.code === code
    && (message === undefined || message.test(error.message))
}

/** Minimal filesystem over a path set: only registered paths exist, .git never reads. */
export function pathSetFs(paths: ReadonlySet<string>): WorktreeFileSystem {
  return {
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
}

/** Core over an explicit workspace/agent source plus an optional runner and fs. */
export function coreOver(options: {
  workspaces: WorkspaceFact[]
  agents?: AgentFact[]
  archived?: readonly string[]
  git?: GitRunner
  fs?: WorktreeFileSystem
  now?: () => number
  token?: () => string
}): GitWorktreeCore {
  return new GitWorktreeCore({
    source: {
      listWorkspaces: () => options.workspaces,
      listAgents: () => options.agents ?? [],
      listArchivedSessionIds: () => [...(options.archived ?? [])],
    },
    ...(options.git === undefined ? {} : { git: options.git }),
    ...(options.fs === undefined ? {} : { fs: options.fs }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.token === undefined ? {} : { token: options.token }),
  })
}

/** Git child process whose streams the local-runner tests drive by hand. */
export class FakeGitChild extends EventEmitter implements GitChildProcess {
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  killed = false

  kill(): boolean {
    this.killed = true
    return true
  }
}

