/**
 * Gateway-owned Git worktree orchestration.
 *
 * The bearer of a gateway credential is not implicitly allowed to run Git in
 * an arbitrary directory. Every mutation is correlated with the live
 * workspace projection, then reduced to a canonical main-workspace path and
 * one direct sibling target.
 *
 * dsh 0.1.2 wire note: the unary `workspace.list` RPC was REMOVED upstream
 * (replaced by the `workspace/follow` Remote stream over `/api/remote.mux`).
 * The Remote-stream client is not available in this package yet (the mux open
 * handshake `{type:'open',streamId,endpoint,payload}` cannot be sent by the
 * control-plane `openEventStream` carrier and the upstream stream-protocol
 * frame shapes are unverified against the real wire), so workspace PATH facts
 * are derived from `session/list` (slash): every live session's cwd is a live
 * workspace path. Sessionless workspaces are unprovable and FAIL CLOSED, and
 * workspaceId correlation is never derived — ids come from `workspace/create`
 * responses and the gateway's own persisted records (see `deleteWorktree`).
 * The residual id-rebinding gap and the `workspace/follow` TODO are recorded
 * in the WP9 migration's unresolved issues.
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { RpcBusinessError, RpcTransportError, call } from '@dsh-chamber/control-plane'

export interface CreateWorktreeInput {
  dshBaseUrl: string
  /** Must equal a canonical path of a live dsh workspace. On the 0.1.2 wire
   * workspace membership is derived from `session/list` (slash) cwds (the
   * unary `workspace.list` was removed); sessionless workspaces fail closed. */
  repo: string
  branch: string
  /** Must be a previously absent direct sibling of repo. */
  newPath: string
  agentPreset?: string
}

export interface WorktreeRecord {
  id: string
  workspaceId: string
  sessionId?: string
  /** Canonical main-workspace repository used as the Git authority. */
  repo?: string
  path: string
  branch: string
  /** `unverified` rows are observability-only and never deletion authority. */
  ownership?: 'owned' | 'unverified'
  state: 'creating' | 'ready' | 'deleting' | 'failed'
  error?: string
  createdAt: number
}

export interface DeleteWorktreeInput {
  dshBaseUrl: string
  workspaceId: string
  /** Persisted server-side value; never accepted from a delete request body. */
  repo: string
  path: string
  branch: string
  /** Session minted by the create saga, when its response was unambiguous. */
  sessionId?: string
  /** Persisted `state:'deleting'` proves a prior authorized attempt reached
   * the saga. It permits resuming after the Git directory is already gone. */
  resumeAfterGitRemoval?: boolean
}

export class GitFeatureError extends Error {
  readonly code: string
  /** A safe, non-destructively retained row that the route must persist. */
  readonly recovery?: WorktreeRecord
  constructor(code: string, message: string, recovery?: WorktreeRecord) {
    super(message)
    this.name = 'GitFeatureError'
    this.code = code
    this.recovery = recovery
  }
}

export interface GitRunResult {
  code: number | null
  stdout: string
  stderr: string
}

export interface GitRunOptions { timeoutMs?: number }

export const MAX_GIT_OUTPUT_BYTES = 256 * 1024
export const DEFAULT_GIT_TIMEOUT_MS = 30_000
export const MAX_CONCURRENT_GIT_PROCESSES = 4
const GIT_KILL_GRACE_MS = 1_000

let activeGitProcesses = 0

/** Rebuild a minimal, safe Git child environment — design 17 §9.4 "只显式
 * 重建安全的 Git 环境". Prefix-filtering the ambient environment is NOT
 * enough: non-GIT credential material (SSH_AUTH_SOCK, SSH_ASKPASS,
 * GIT_ASKPASS, any operator secret placed in the gateway env) would
 * otherwise reach git and its hooks (post-checkout runs on every worktree
 * add, and hook scripts are written by the same OS user as the repos). Only
 * the functional whitelist (executable lookup, config home, deterministic
 * output locale) plus the explicit non-interactive policy is re-added;
 * `git -C` does not neutralize GIT_DIR/GIT_WORK_TREE/GIT_CONFIG_* anyway,
 * so inheriting them could make authority checks inspect one path while
 * mutations hit another object database. */
export function sanitizedGitEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of ['PATH', 'HOME', 'LC_ALL', 'LANG'] as const) {
    const value = source[key]
    if (value !== undefined) env[key] = value
  }
  env.GIT_TERMINAL_PROMPT = '0'
  return env
}

/** Run one bounded Git child; excess requests fail fast instead of queueing. */
export function runGit(
  args: readonly string[],
  cwd: string,
  options: GitRunOptions = {},
): Promise<GitRunResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
    return Promise.reject(new GitFeatureError('git_invalid_timeout', 'git timeout must be a positive finite number'))
  }
  if (activeGitProcesses >= MAX_CONCURRENT_GIT_PROCESSES) {
    return Promise.reject(new GitFeatureError('git_busy', 'too many concurrent git operations'))
  }
  activeGitProcesses += 1

  return new Promise((resolvePromise, rejectPromise) => {
    let stdout = ''
    let stderr = ''
    let stdoutBytes = 0
    let stderrBytes = 0
    let settled = false
    let timedOut = false
    let killTimer: ReturnType<typeof setTimeout> | null = null
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null

    const settle = (outcome: GitRunResult | Error): void => {
      if (settled) return
      settled = true
      activeGitProcesses -= 1
      if (timeoutTimer !== null) clearTimeout(timeoutTimer)
      if (killTimer !== null) clearTimeout(killTimer)
      if (outcome instanceof Error) rejectPromise(outcome)
      else resolvePromise(outcome)
    }

    let child: ReturnType<typeof spawn>
    try {
      child = spawn('git', args, {
        cwd,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: sanitizedGitEnvironment(),
        // A separate POSIX process group lets the timeout terminate Git hooks,
        // credential helpers, and filters as well as the immediate git child.
        detached: process.platform !== 'win32',
      })
    } catch (error) {
      settle(new GitFeatureError('git_spawn_failed', `git spawn failed: ${String(error)}`))
      return
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      const remaining = MAX_GIT_OUTPUT_BYTES - stdoutBytes
      if (remaining > 0) stdout += chunk.subarray(0, remaining).toString('utf8')
      stdoutBytes += chunk.length
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      const remaining = MAX_GIT_OUTPUT_BYTES - stderrBytes
      if (remaining > 0) stderr += chunk.subarray(0, remaining).toString('utf8')
      stderrBytes += chunk.length
    })
    child.once('error', error => {
      settle(new GitFeatureError('git_spawn_failed', `git spawn failed: ${String(error)}`))
    })
    child.once('close', code => {
      if (timedOut) {
        settle(new GitFeatureError('git_timeout', `git operation exceeded ${timeoutMs}ms`))
        return
      }
      settle({ code, stdout: stdout.trimEnd(), stderr: stderr.trimEnd() })
    })

    const killChildTree = (signal: NodeJS.Signals): void => {
      try {
        if (process.platform !== 'win32' && child.pid !== undefined) process.kill(-child.pid, signal)
        else child.kill(signal)
      } catch { /* process already exited */ }
    }

    timeoutTimer = setTimeout(() => {
      timedOut = true
      killChildTree('SIGTERM')
      killTimer = setTimeout(() => killChildTree('SIGKILL'), GIT_KILL_GRACE_MS)
    }, timeoutMs)
  })
}

function tail(text: string, max = 1024): string {
  return text.length > max ? `…${text.slice(-max)}` : text
}

/** Path-level live workspace facts. workspaceId correlation is intentionally
 * absent: on the 0.1.2 wire there is no unary workspace list, so ids are never
 * derived — they come from `workspace/create` responses and the gateway's own
 * persisted records. */
interface WorkspaceFact { path: string }
interface WorkspaceCreateFact { workspaceId: string; path: string; created: boolean }
interface SessionFact { sessionId: string; running: boolean; cwd?: string }

/** Decode the actual workspace/create wire shape and correlate its path. */
export function decodeWorkspaceCreateValue(value: unknown, requestedPath: string): WorkspaceCreateFact {
  const row = value as { workspace?: { workspaceId?: unknown; path?: unknown }; created?: unknown } | null
  const workspaceId = row?.workspace?.workspaceId
  const path = row?.workspace?.path
  if (typeof workspaceId !== 'string' || workspaceId === '') {
    throw new GitFeatureError('workspace_create_failed', 'workspace/create returned no workspace id')
  }
  if (typeof path !== 'string' || path !== requestedPath) {
    throw new GitFeatureError('workspace_create_failed', 'workspace/create returned a different workspace path')
  }
  if (typeof row?.created !== 'boolean') {
    throw new GitFeatureError('workspace_create_failed', 'workspace/create returned no created ownership flag')
  }
  return { workspaceId, path, created: row.created }
}

/** Decode live workspace PATH facts from `session/list` (slash) rows: every
 * live session's cwd is a live workspace path. cwd-less rows and sessionless
 * workspaces are unprovable and excluded — callers must fail closed on them.
 * The old `workspace.list` wire is gone (→ `workspace/follow` stream, TODO);
 * this derivation is the fail-closed unary substitute (WP9 unresolved issue). */
function decodeWorkspacePathValue(value: unknown): WorkspaceFact[] {
  const items = (value as { items?: unknown } | null)?.items
  if (!Array.isArray(items)) {
    throw new GitFeatureError('workspace_list_failed', 'session/list returned no items array')
  }
  const facts: WorkspaceFact[] = []
  for (const item of items) {
    const row = item as { cwd?: unknown } | null
    const cwd = row?.cwd
    if (typeof cwd !== 'string' || cwd === '') continue
    if (!isAbsolute(cwd) || resolve(cwd) !== cwd || cwd.includes('\0')) {
      throw new GitFeatureError('workspace_list_failed', 'session/list returned a non-canonical workspace path')
    }
    facts.push({ path: resolve(cwd) })
  }
  return facts
}

async function listWorkspacePaths(dshBaseUrl: string): Promise<WorkspaceFact[]> {
  try {
    const { result } = await call(dshBaseUrl, 'session/list', { args: { _request: {} } })
    return decodeWorkspacePathValue(result.value)
  } catch (error) {
    if (error instanceof GitFeatureError) throw error
    throw rpcError('workspace_list_failed', error)
  }
}

/** A persisted saga id cannot authorize a path after another live workspace
 * has taken that path (or an alias/descendant of it). Check both the derived
 * path set and the current filesystem identity: the latter closes the symlink
 * alias variant without treating an unrelated missing workspace as proof of
 * ownership. Workspace facts are path-level (no ids on the 0.1.2 wire), so
 * the owned workspace is excluded by its canonical PATH rather than an id. */
async function assertNoWorkspacePathReoccupation(
  workspaces: WorkspaceFact[],
  path: string,
  ownedPath?: string,
): Promise<void> {
  for (const candidate of workspaces) {
    if (ownedPath !== undefined && candidate.path === ownedPath) continue
    if (isAtOrBelow(path, candidate.path)) {
      throw new GitFeatureError('worktree_not_allowed', 'worktree path is owned by a different live workspace')
    }
    try {
      const canonical = await realpath(candidate.path)
      if (isAtOrBelow(path, canonical)) {
        throw new GitFeatureError('worktree_not_allowed', 'worktree path is aliased by a different live workspace')
      }
    } catch (error) {
      if (error instanceof GitFeatureError) throw error
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new GitFeatureError('workspace_list_failed', 'cannot verify a live workspace path before deletion')
      }
    }
  }
}

function decodeSessionListValue(value: unknown): SessionFact[] {
  const items = (value as { items?: unknown } | null)?.items
  if (!Array.isArray(items)) throw new GitFeatureError('session_list_failed', 'session/list returned no items array')
  return items.map(item => {
    const row = item as { sessionId?: unknown; running?: unknown; cwd?: unknown } | null
    if (typeof row?.sessionId !== 'string' || row.sessionId === '' || typeof row.running !== 'boolean'
      || (row.cwd !== undefined && (typeof row.cwd !== 'string' || !isAbsolute(row.cwd) || resolve(row.cwd) !== row.cwd))) {
      throw new GitFeatureError('session_list_failed', 'session/list returned a malformed session row')
    }
    return {
      sessionId: row.sessionId,
      running: row.running,
      ...(typeof row.cwd === 'string' ? { cwd: row.cwd } : {}),
    }
  })
}

async function listSessions(dshBaseUrl: string): Promise<SessionFact[]> {
  try {
    const { result } = await call(dshBaseUrl, 'session/list', { args: { _request: {} } })
    return decodeSessionListValue(result.value)
  } catch (error) {
    if (error instanceof GitFeatureError) throw error
    throw rpcError('session_list_failed', error)
  }
}

function isAtOrBelow(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

async function canonicalSessionCwd(session: SessionFact): Promise<string> {
  if (session.cwd === undefined) {
    throw new GitFeatureError('session_liveness_unknown', 'cannot prove a session with missing cwd is unrelated')
  }
  try {
    return await realpath(session.cwd)
  } catch {
    throw new GitFeatureError('session_liveness_unknown', 'cannot canonicalize a live session cwd')
  }
}

/** Strong create-compensation proof: no session may address the new path. */
async function assertNoSessionAtPath(dshBaseUrl: string, path: string): Promise<void> {
  const sessions = await listSessions(dshBaseUrl)
  for (const session of sessions) {
    if (isAtOrBelow(path, await canonicalSessionCwd(session))) {
      throw new GitFeatureError('worktree_in_use', 'a session already addresses the worktree path')
    }
  }
}

/** Delete guard: fail closed unless every live running session is unrelated. */
async function assertNoRunningSession(
  dshBaseUrl: string,
  path: string,
  recordSessionId?: string,
): Promise<void> {
  const sessions = await listSessions(dshBaseUrl)
  for (const session of sessions) {
    if (!session.running) continue
    if (recordSessionId !== undefined && session.sessionId === recordSessionId) {
      throw new GitFeatureError('worktree_in_use', 'the worktree session is running')
    }
    if (isAtOrBelow(path, await canonicalSessionCwd(session))) {
      throw new GitFeatureError('worktree_in_use', 'a running session uses the worktree path')
    }
  }
}

async function canonicalDirectory(input: string, code: string): Promise<string> {
  if (!isAbsolute(input) || input.includes('\0') || resolve(input) !== input) {
    throw new GitFeatureError(code, 'path must already be a normalized absolute path')
  }
  try {
    const stat = await lstat(input)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('not a real directory')
    const canonical = await realpath(input)
    if (canonical !== input) throw new Error('path contains a symbolic-link alias')
    return canonical
  } catch (error) {
    if (error instanceof GitFeatureError) throw error
    throw new GitFeatureError(code, `path is not an existing canonical directory: ${String(error)}`)
  }
}

async function assertAbsent(path: string): Promise<void> {
  try {
    await lstat(path)
    throw new GitFeatureError('target_exists', 'worktree target already exists')
  } catch (error) {
    if (error instanceof GitFeatureError) throw error
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new GitFeatureError('invalid_target', `cannot inspect worktree target: ${String(error)}`)
    }
  }
}

async function inspectCanonicalDirectory(input: string, code: string): Promise<'present' | 'missing'> {
  if (!isAbsolute(input) || input.includes('\0') || resolve(input) !== input) {
    throw new GitFeatureError(code, 'path must already be a normalized absolute path')
  }
  try {
    const stat = await lstat(input)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('not a real directory')
    if (await realpath(input) !== input) throw new Error('path contains a symbolic-link alias')
    return 'present'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'
    throw new GitFeatureError(code, `path is not a canonical directory: ${String(error)}`)
  }
}

function isSafeBranch(branch: string): boolean {
  return branch.length >= 1 && branch.length <= 128
    && !branch.startsWith('-') && !branch.endsWith('.') && !branch.endsWith('.lock')
    && !branch.includes('..') && !branch.includes('@{') && !branch.includes('//')
    && /^[a-zA-Z0-9._/-]+$/.test(branch)
}

/** Prove that a live workspace path is still the canonical main checkout of
 * the Git repository that a mutation would affect. The workspace row alone
 * is not durable authority: the directory may have been replaced since it
 * was persisted. */
async function resolveMainRepoAuthority(repoInput: string, workspaces: WorkspaceFact[]): Promise<string> {
  const repo = await canonicalDirectory(repoInput, 'repo_not_allowed')
  if (!workspaces.some(workspace => workspace.path === repo)) {
    throw new GitFeatureError('repo_not_allowed', 'repository is not an authoritative dsh workspace')
  }

  const topLevelResult = await runGit(['-C', repo, 'rev-parse', '--show-toplevel'], repo)
  if (topLevelResult.code !== 0) {
    throw new GitFeatureError('repo_not_allowed', `workspace is not a git repository: ${tail(topLevelResult.stderr)}`)
  }
  let topLevel: string
  try {
    topLevel = await realpath(topLevelResult.stdout.trim())
  } catch {
    throw new GitFeatureError('repo_not_allowed', 'git returned an invalid repository root')
  }
  if (topLevel !== repo) throw new GitFeatureError('repo_not_allowed', 'workspace is not the main repository root')
  const gitDirs = await runGit(['-C', repo, 'rev-parse', '--git-dir', '--git-common-dir'], repo)
  if (gitDirs.code !== 0) throw new GitFeatureError('repo_not_allowed', 'cannot resolve repository authority')
  const [gitDirText, commonDirText] = gitDirs.stdout.split(/\r?\n/)
  if (gitDirText === undefined || commonDirText === undefined) {
    throw new GitFeatureError('repo_not_allowed', 'git returned an incomplete repository authority')
  }
  try {
    const gitDir = await realpath(resolve(repo, gitDirText))
    const commonDir = await realpath(resolve(repo, commonDirText))
    if (gitDir !== commonDir) {
      throw new GitFeatureError('repo_not_allowed', 'source workspace is a linked worktree, not the main checkout')
    }
  } catch (error) {
    if (error instanceof GitFeatureError) throw error
    throw new GitFeatureError('repo_not_allowed', 'cannot canonicalize repository metadata')
  }
  return repo
}

async function resolveGitRemovalAuthority(
  dshBaseUrl: string,
  repoInput: string,
  path: string,
  ownedPath?: string,
): Promise<string> {
  const workspaces = await listWorkspacePaths(dshBaseUrl)
  const repo = await resolveMainRepoAuthority(repoInput, workspaces)
  await assertNoWorkspacePathReoccupation(workspaces, path, ownedPath)
  // NOTE (0.1.2 wire, WP9 tradeoff): the old id↔path registry re-verification
  // ("the workspace row with id X still owns path") is not expressible with
  // path-level session-derived facts, and a session-liveness proof conflicts
  // with the removal path (removal requires the target to be session-free,
  // which makes it unprovable as a live workspace). Fail-closed substitutes:
  // the reoccupation check above (no OTHER live workspace path at/below/
  // aliasing the target) plus the caller's assertNoSessionAtPath live guard.
  // The workspace/follow stream client is the TODO restoration.
  return repo
}

async function resolveCreateAuthority(input: CreateWorktreeInput, workspaces: WorkspaceFact[]): Promise<{
  repo: string
  newPath: string
}> {
  if (!isSafeBranch(input.branch)) throw new GitFeatureError('invalid_input', 'invalid branch name')
  const repo = await resolveMainRepoAuthority(input.repo, workspaces)

  if (!isAbsolute(input.newPath) || input.newPath.includes('\0') || resolve(input.newPath) !== input.newPath) {
    throw new GitFeatureError('invalid_target', 'target must be a normalized absolute path')
  }
  const allowedRoot = await realpath(dirname(repo))
  const leaf = basename(input.newPath)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(leaf) || leaf === '.git') {
    throw new GitFeatureError('invalid_target', 'target name is not allowed')
  }
  const newPath = join(allowedRoot, leaf)
  if (newPath !== input.newPath || dirname(newPath) !== allowedRoot || newPath === repo) {
    throw new GitFeatureError('invalid_target', 'target must be a direct sibling of the repository')
  }
  if (workspaces.some(workspace => workspace.path === newPath)) {
    throw new GitFeatureError('target_exists', 'target is already registered as a workspace')
  }
  await assertAbsent(newPath)
  return { repo, newPath }
}

async function compensateCreatedWorktree(
  dsh: (method: string, payload: unknown) => ReturnType<typeof call>,
  dshBaseUrl: string,
  repo: string,
  path: string,
  workspace: WorkspaceCreateFact,
): Promise<{ workspaceDeleted: boolean; gitRemoved: boolean }> {
  // created:true + correlated path + successful git-add are the ownership
  // proofs. Without all three, compensation must not delete anything.
  if (!workspace.created || workspace.path !== path) return { workspaceDeleted: false, gitRemoved: false }
  const { result } = await dsh('workspace/delete', { args: { request: { workspaceId: workspace.workspaceId } } })
  if ((result.value as { deleted?: unknown } | null)?.deleted !== true) {
    return { workspaceDeleted: false, gitRemoved: false }
  }
  // workspace/delete and Git removal are separate authorities. Re-check after
  // the first mutation so a session or workspace that appeared meanwhile
  // retains its path, and re-prove that the repository itself was not swapped.
  await assertNoSessionAtPath(dshBaseUrl, path)
  const mutationRepo = await resolveGitRemovalAuthority(dshBaseUrl, repo, path)
  const removed = await runGit(['-C', mutationRepo, 'worktree', 'remove', path], mutationRepo)
  return { workspaceDeleted: true, gitRemoved: removed.code === 0 }
}

function failedRecord(
  createdAt: number,
  authority: { repo: string; newPath: string },
  branch: string,
  workspace: WorkspaceCreateFact,
  message: string,
  state: WorktreeRecord['state'] = 'failed',
): WorktreeRecord {
  return {
    id: workspace.workspaceId,
    workspaceId: workspace.workspaceId,
    repo: authority.repo,
    path: authority.newPath,
    branch,
    ownership: 'owned',
    state,
    error: message,
    createdAt,
  }
}

function unverifiedRecoveryRecord(
  createdAt: number,
  authority: { repo: string; newPath: string },
  branch: string,
  message: string,
  workspaceId = `recovery-${randomUUID()}`,
): WorktreeRecord {
  return {
    id: workspaceId,
    workspaceId,
    repo: authority.repo,
    path: authority.newPath,
    branch,
    ownership: 'unverified',
    state: 'failed',
    error: message,
    createdAt,
  }
}

export async function createWorktree(input: CreateWorktreeInput): Promise<WorktreeRecord> {
  const createdAt = Date.now()
  const dsh = (method: string, payload: unknown) => call(input.dshBaseUrl, method, payload)
  const workspaces = await listWorkspacePaths(input.dshBaseUrl)
  const authority = await resolveCreateAuthority(input, workspaces)

  // The initial authority proof performs filesystem/Git inspection and can
  // race workspace removal or target registration. Rebuild the complete proof
  // immediately before the first mutation; a stale snapshot must never grant
  // `git worktree add` authority.
  const mutationWorkspaces = await listWorkspacePaths(input.dshBaseUrl)
  const mutationAuthority = await resolveCreateAuthority(input, mutationWorkspaces)
  await assertNoWorkspacePathReoccupation(mutationWorkspaces, mutationAuthority.newPath)
  if (mutationAuthority.repo !== authority.repo || mutationAuthority.newPath !== authority.newPath) {
    throw new GitFeatureError('invalid_target', 'worktree authority changed before creation')
  }

  const add = await runGit(['-C', authority.repo, 'worktree', 'add', '-b', input.branch, authority.newPath], authority.repo)
  if (add.code !== 0) {
    throw new GitFeatureError('git_worktree_add_failed', `git worktree add failed: ${tail(add.stderr)}`)
  }

  let workspace: WorkspaceCreateFact
  try {
    const { result } = await dsh('workspace/create', { args: { request: { path: authority.newPath } } })
    workspace = decodeWorkspaceCreateValue(result.value, authority.newPath)
  } catch (error) {
    if (error instanceof RpcBusinessError) {
      // A business result definitively rejected the mutation. Best-effort,
      // non-force cleanup is allowed only with a live no-session proof.
      try {
        await assertNoSessionAtPath(input.dshBaseUrl, authority.newPath)
        const mutationRepo = await resolveGitRemovalAuthority(
          input.dshBaseUrl,
          authority.repo,
          authority.newPath,
        )
        const removed = await runGit(['-C', mutationRepo, 'worktree', 'remove', authority.newPath], mutationRepo)
        if (removed.code === 0) throw rpcError('workspace_create_failed', error)
      } catch (cleanupError) {
        if (cleanupError instanceof GitFeatureError && cleanupError.code === 'workspace_create_failed') throw cleanupError
        throw new GitFeatureError(
          'workspace_create_failed',
          `workspace/create failed and safe Git compensation did not complete: ${String(cleanupError)}`,
          unverifiedRecoveryRecord(createdAt, authority, input.branch, 'workspace/create Git compensation did not complete'),
        )
      }
      throw new GitFeatureError(
        'workspace_create_failed',
        'workspace/create failed and Git retained the worktree',
        unverifiedRecoveryRecord(createdAt, authority, input.branch, 'workspace/create Git compensation did not complete'),
      )
    }
    // A transport/protocol failure may have committed. The workspace registry
    // id is no longer recoverable (workspace.list removed → workspace/follow
    // stream TODO), so the result stays unverified with a synthetic record id
    // and can never drive DELETE automatically; operators locate the row by
    // its canonical path.
    const recovery = unverifiedRecoveryRecord(
      createdAt,
      authority,
      input.branch,
      'workspace/create outcome is ambiguous',
    )
    throw new GitFeatureError('workspace_create_ambiguous', 'workspace/create outcome is ambiguous; resources were retained', recovery)
  }
  if (!workspace.created) {
    // A pre-existing workspace row is not owned by this operation. Adopting it
    // would later let the gateway delete someone else's authoritative row.
    // The Git path itself is nevertheless ours (absent check + successful
    // git-add), so remove only that path and leave the workspace row untouched.
    // The pre-existing workspace may already own sessions. Only a live empty
    // session projection authorizes a non-force removal of our Git path.
    try {
      await assertNoSessionAtPath(input.dshBaseUrl, authority.newPath)
      const mutationRepo = await resolveGitRemovalAuthority(
        input.dshBaseUrl,
        authority.repo,
        authority.newPath,
        authority.newPath, // owned workspace path (path-level facts on the 0.1.2 wire)
      )
      const removed = await runGit(['-C', mutationRepo, 'worktree', 'remove', authority.newPath], mutationRepo)
      if (removed.code === 0) {
        throw new GitFeatureError('workspace_create_failed', 'workspace path was already registered; ownership was not granted')
      }
      throw new GitFeatureError(
        'workspace_create_failed',
        `workspace ownership was not granted and Git retained the worktree: ${tail(removed.stderr)}`,
        unverifiedRecoveryRecord(createdAt, authority, input.branch, 'created:false Git compensation did not complete'),
      )
    } catch (cleanupError) {
      if (cleanupError instanceof GitFeatureError && cleanupError.code === 'workspace_create_failed') throw cleanupError
      throw new GitFeatureError(
        'workspace_create_failed',
        'workspace ownership was not granted and safe Git compensation was blocked',
        unverifiedRecoveryRecord(createdAt, authority, input.branch, 'created:false Git compensation was blocked'),
      )
    }
  }

  let sessionId: string
  try {
    const { result } = await dsh('session/create', {
      args: { request: {
        workspaceId: workspace.workspaceId,
        ...(input.agentPreset !== undefined ? { agentPreset: input.agentPreset } : {}),
      } },
    })
    const value = result.value as { sessionId?: unknown } | null
    if (typeof value?.sessionId !== 'string' || value.sessionId === '') {
      throw new GitFeatureError('session_create_failed', 'session/create returned no session id')
    }
    sessionId = value.sessionId
  } catch (error) {
    const recovery = failedRecord(createdAt, authority, input.branch, workspace, 'session creation outcome requires recovery')
    const deletingRecovery = failedRecord(
      createdAt,
      authority,
      input.branch,
      workspace,
      'session failed after workspace compensation began; recovery is required',
      'deleting',
    )
    // A business error is a definitive non-commit. Only then, and only after a
    // live no-session proof, may compensation delete the owned workspace and
    // use Git's non-force dirty/locked guard. Transport/protocol failures are
    // commit-ambiguous and preserve every resource.
    if (error instanceof RpcBusinessError) {
      let workspaceDeleteAttempted = false
      try {
        await assertNoSessionAtPath(input.dshBaseUrl, authority.newPath)
        workspaceDeleteAttempted = true
        const compensation = await compensateCreatedWorktree(
          dsh,
          input.dshBaseUrl,
          authority.repo,
          authority.newPath,
          workspace,
        )
        if (compensation.gitRemoved) {
          throw rpcError('session_create_failed', error)
        }
        if (compensation.workspaceDeleted) {
          throw new GitFeatureError(
            'session_create_failed',
            'workspace was deleted but Git retained the worktree; recovery is required',
            deletingRecovery,
          )
        }
        throw new GitFeatureError(
          'session_create_failed',
          'workspace deletion was not confirmed; Git was retained',
          deletingRecovery,
        )
      } catch (compensationError) {
        if (compensationError instanceof GitFeatureError && compensationError.code === 'session_create_failed') {
          throw compensationError
        }
        throw new GitFeatureError(
          'session_create_failed',
          `session failed and safe compensation did not complete: ${String(compensationError)}`,
          workspaceDeleteAttempted ? deletingRecovery : recovery,
        )
      }
    }
    throw new GitFeatureError('session_create_ambiguous', 'session/create outcome is ambiguous; resources were retained', recovery)
  }

  return {
    id: workspace.workspaceId,
    workspaceId: workspace.workspaceId,
    sessionId,
    repo: authority.repo,
    path: authority.newPath,
    branch: input.branch,
    ownership: 'owned',
    state: 'ready',
    createdAt,
  }
}

export async function deleteWorktree(input: DeleteWorktreeInput): Promise<void> {
  const dsh = (method: string, payload: unknown) => call(input.dshBaseUrl, method, payload)
  // Workspace facts are path-level on the 0.1.2 wire (derived from live
  // session/list cwds; workspace.list removed → workspace/follow stream TODO).
  // The workspaceId used for workspace/delete is the gateway's OWN persisted
  // record id — never derived. Residual: the old id↔path registry re-check
  // (row with input.workspaceId still owns input.path) cannot be re-verified;
  // a live path proof is the fail-closed substitute (unresolved issue, WP9).
  const workspaces = await listWorkspacePaths(input.dshBaseUrl)
  const repo = await resolveMainRepoAuthority(input.repo, workspaces)
  if (!isAbsolute(input.path) || resolve(input.path) !== input.path || input.path.includes('\0')
    || dirname(input.path) !== dirname(repo) || input.path === repo) {
    throw new GitFeatureError('worktree_not_allowed', 'worktree is outside the repository sibling root')
  }
  await assertNoWorkspacePathReoccupation(workspaces, input.path, input.path)
  const workspaceLive = workspaces.some(candidate => candidate.path === input.path)
  if (!workspaceLive && input.resumeAfterGitRemoval !== true) {
    throw new GitFeatureError('worktree_not_allowed', 'worktree workspace is no longer registered')
  }

  const pathState = await inspectCanonicalDirectory(input.path, 'worktree_not_allowed')
  if (pathState === 'missing' && input.resumeAfterGitRemoval !== true) {
    throw new GitFeatureError('worktree_not_allowed', 'worktree path disappeared before the delete saga began')
  }
  // A missing workspace liveness can only be treated as a committed delete
  // after the Git path is also gone. If the path survived, it may have been
  // rebuilt outside this saga and the stale record has no authority to remove
  // it.
  if (pathState === 'present' && !workspaceLive) {
    throw new GitFeatureError('worktree_not_allowed', 'worktree path survived after its workspace authority disappeared')
  }
  if (pathState === 'present') {
    // Keep the fail-closed live check immediately adjacent to the mutation.
    await assertNoRunningSession(input.dshBaseUrl, input.path, input.sessionId)
    const mutationWorkspaces = await listWorkspacePaths(input.dshBaseUrl)
    const mutationRepo = await resolveMainRepoAuthority(input.repo, mutationWorkspaces)
    await assertNoWorkspacePathReoccupation(mutationWorkspaces, input.path, input.path)
    if (!mutationWorkspaces.some(candidate => candidate.path === input.path)) {
      throw new GitFeatureError('worktree_not_allowed', 'worktree workspace disappeared before deletion')
    }
    const removed = await runGit(['-C', mutationRepo, 'worktree', 'remove', input.path], mutationRepo)
    if (removed.code !== 0) {
      throw new GitFeatureError('git_worktree_remove_failed', `git worktree remove failed: ${tail(removed.stderr)}`)
    }
  }

  if (workspaceLive) {
    // Re-check after Git removal. This narrows the host's check/mutation gap
    // and blocks workspace deletion if a session became running meanwhile.
    // The public dsh API exposes no atomic session lease/guard, so these live
    // checks cannot fully eliminate a check -> mutation race; non-force Git
    // removal and fail-closed rechecks are the minimum safe model here.
    await assertNoRunningSession(input.dshBaseUrl, input.path, input.sessionId)
    try {
      const { result } = await dsh('workspace/delete', { args: { request: { workspaceId: input.workspaceId } } })
      if ((result.value as { deleted?: unknown } | null)?.deleted !== true) {
        throw new GitFeatureError('workspace_delete_failed', 'workspace/delete did not confirm deletion')
      }
    } catch (error) {
      throw rpcError('workspace_delete_failed', error)
    }
  }

}

function rpcError(featureCode: string, error: unknown): GitFeatureError {
  if (error instanceof GitFeatureError) {
    return error.code === featureCode ? error : new GitFeatureError(featureCode, error.message)
  }
  if (error instanceof RpcBusinessError) {
    return new GitFeatureError(featureCode, `dsh rpc ${error.code}: ${error.message}`)
  }
  if (error instanceof RpcTransportError) throw error
  return new GitFeatureError(featureCode, String(error))
}
