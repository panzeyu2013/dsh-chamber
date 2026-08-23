/**
 * Git worktree offload (design 16 §8.1): the gateway runs `git` directly as
 * the same OS user as the managed dsh, and drives workspace/session facts
 * through dsh's public `/api` — NO dsh host/client plugin. P0-1 (conclusion A)
 * confirmed the four prerequisite facts are all served by `/api`:
 * `workspace.list` (items carry canonical `path` + `archivedSessionIds`),
 * `workspace.create({path})` (existing dir only), `session.create({workspaceId,
 * cwd?, sessionId?, agentPreset?})` (workspaceId gives grouping semantics).
 *
 * Failure semantics (design 16 §8.1): every step's failure is a loud typed
 * error; the create flow compensates best-effort (git worktree remove /
 * workspace.delete) so a half-created worktree never strands.
 */

import { spawn } from 'node:child_process'
import {
  RpcBusinessError,
  RpcTransportError,
  call,
} from '@dsh-chamber/control-plane'

export interface CreateWorktreeInput {
  /** dsh loopback origin, e.g. http://127.0.0.1:17510 (feature-host直连, 不经 proxy). */
  dshBaseUrl: string
  /** Main worktree repo root (canonical path). */
  repo: string
  /** New branch name (git worktree add -b). */
  branch: string
  /** New worktree directory path (sibling of repo, NOT inside it). */
  newPath: string
  /** Optional agent preset id for the created session. */
  agentPreset?: string
}

export interface WorktreeRecord {
  /** Record id (== workspaceId in the single-worktree-per-workspace model; the
   * store key for worktrees.json). */
  id: string
  workspaceId: string
  sessionId?: string
  path: string
  branch: string
  state: 'creating' | 'ready' | 'deleting' | 'failed'
  error?: string
  createdAt: number
}

export interface DeleteWorktreeInput {
  dshBaseUrl: string
  workspaceId: string
  /** Main worktree repo root (where `git worktree remove` runs). */
  repo: string
  path: string
  branch: string
  /** Set when the user authorized deleting the local branch (git worktree remove does not). */
  deleteBranch?: boolean
}

/** A typed feature-host error with a stable code (surfaced to the caller/route). */
export class GitFeatureError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'GitFeatureError'
    this.code = code
  }
}

/** Bounded git run result. */
interface GitRunResult {
  code: number | null
  stdout: string
  stderr: string
}

const MAX_GIT_OUTPUT_BYTES = 256 * 1024

/** Run git with an argument array (shell:false), bounded output. */
function runGit(args: readonly string[], cwd: string): Promise<GitRunResult> {
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let stdoutBytes = 0
    let stderrBytes = 0
    const child = spawn('git', args, { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length
      if (stdoutBytes <= MAX_GIT_OUTPUT_BYTES) stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length
      if (stderrBytes <= MAX_GIT_OUTPUT_BYTES) stderr += chunk.toString('utf8')
    })
    child.on('error', error => {
      reject(new GitFeatureError('git_spawn_failed', `git spawn failed: ${String(error)}`))
    })
    child.on('close', code => {
      resolve({ code, stdout, stderr: stderr.trimEnd() })
    })
  })
}

/** Truncate a git stderr tail for the error message (never the whole stream). */
function tail(text: string, max = 1024): string {
  return text.length > max ? `…${text.slice(-max)}` : text
}

/**
 * Create a worktree → workspace → session (design 16 §8.1). Compensation is
 * best-effort: a failed step rolls back the git worktree / workspace it just
 * created so a half-created worktree never strands. Returns the record on
 * success; throws GitFeatureError (or RpcTransportError for a dead dsh) on
 * failure.
 */
export async function createWorktree(input: CreateWorktreeInput): Promise<WorktreeRecord> {
  const createdAt = Date.now()
  const dsh = (method: string, payload: unknown) => call(input.dshBaseUrl, method, payload)

  // 1. workspace.list → main workspace facts (path + archive set).
  let workspaces: unknown
  try {
    const { result } = await dsh('workspace.list', {})
    workspaces = result.value
  } catch (error) {
    throw rpcError('workspace_list_failed', error)
  }
  // The main repo path is caller-supplied; we only use workspace.list to
  // confirm the target directory is not already a workspace and to learn the
  // archive set (informational). A wrong/missing repo surfaces at the git step.
  void workspaces

  // 2. git worktree add -b <branch> <newPath> (existing dir NOT required — git
  //    creates it; newPath must be outside the repo).
  const add = await runGit(['-C', input.repo, 'worktree', 'add', '-b', input.branch, input.newPath], input.repo)
  if (add.code !== 0) {
    throw new GitFeatureError('git_worktree_add_failed', `git worktree add failed: ${tail(add.stderr)}`)
  }

  // 3. workspace.create({ path }) → adopt the new directory.
  let workspaceId: string
  try {
    const { result } = await dsh('workspace.create', { path: input.newPath })
    workspaceId = workspaceViewId(result.value)
  } catch (error) {
    // Compensate: remove the just-created worktree.
    await runGit(['-C', input.repo, 'worktree', 'remove', '--force', input.newPath], input.repo).catch(() => {})
    throw rpcError('workspace_create_failed', error)
  }

  // 4. session.create({ workspaceId, agentPreset? }) → grouping semantics.
  let sessionId: string | undefined
  try {
    const { result } = await dsh('session.create', {
      workspaceId,
      ...(input.agentPreset !== undefined ? { agentPreset: input.agentPreset } : {}),
    })
    sessionId = typeof (result.value as { sessionId?: unknown } | null | undefined)?.sessionId === 'string'
      ? (result.value as { sessionId: string }).sessionId
      : undefined
  } catch (error) {
    // Compensate: remove the workspace registration + the worktree directory.
    await dsh('workspace.delete', { workspaceId }).catch(() => {})
    await runGit(['-C', input.repo, 'worktree', 'remove', '--force', input.newPath], input.repo).catch(() => {})
    throw rpcError('session_create_failed', error)
  }

  return { id: workspaceId, workspaceId, ...(sessionId !== undefined ? { sessionId } : {}), path: input.newPath, branch: input.branch, state: 'ready', createdAt }
}

/**
 * Git-first delete (design 16 §8.1): refuses a dirty/locked target, never
 * archives sessions, never force-deletes branches unless `deleteBranch` is set.
 * The workspace registration is removed via `/api`; the worktree directory via
 * git (which honors the dirty/locked guard).
 */
export async function deleteWorktree(input: DeleteWorktreeInput): Promise<void> {
  const dsh = (method: string, payload: unknown) => call(input.dshBaseUrl, method, payload)

  // git worktree remove (run from the main repo, NO --force: it refuses a
  // dirty/locked worktree — the design's guard).
  const removed = await runGit(['-C', input.repo, 'worktree', 'remove', input.path], input.repo)
  if (removed.code !== 0) {
    throw new GitFeatureError('git_worktree_remove_failed', `git worktree remove failed: ${tail(removed.stderr)}`)
  }

  // Optional user-authorized branch deletion (NEVER forced: `-d` only removes
  // the branch when it is fully merged; an unmerged branch is refused by git).
  if (input.deleteBranch === true) {
    const deleted = await runGit(['-C', input.repo, 'branch', '-d', input.branch], input.repo)
    if (deleted.code !== 0) {
      throw new GitFeatureError('git_branch_delete_failed', `git branch -d failed: ${tail(deleted.stderr)}`)
    }
  }

  // Remove the workspace registration (best-effort after the git deletion).
  try {
    await dsh('workspace.delete', { workspaceId: input.workspaceId })
  } catch (error) {
    throw rpcError('workspace_delete_failed', error)
  }
}

/** Normalize a dsh RPC error into a GitFeatureError (business code preserved). */
function rpcError(featureCode: string, error: unknown): GitFeatureError {
  if (error instanceof RpcBusinessError) {
    return new GitFeatureError(featureCode, `dsh rpc ${error.code}: ${error.message}`)
  }
  if (error instanceof RpcTransportError) {
    throw error // carrier-level (dead dsh): re-throw, the caller surfaces it distinctly.
  }
  return new GitFeatureError(featureCode, String(error))
}

/** Extract the id from a workspace.create result.value (WorkspaceView). */
function workspaceViewId(value: unknown): string {
  if (typeof value === 'object' && value !== null && typeof (value as { id?: unknown }).id === 'string') {
    return (value as { id: string }).id
  }
  throw new GitFeatureError('workspace_create_failed', 'workspace.create returned no id')
}
