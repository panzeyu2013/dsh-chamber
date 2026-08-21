/** Defensive, pure fold for the untrusted Git Remote snapshot response. */
import type {
  GitRepoTopology, GitWorktreeError, GitWorktreeInfo, GitWorktreeSnapshot,
} from './types.ts'

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}

const REPO_ID = /^repo_[0-9a-f]{64}$/u
const WORKTREE_ID = /^worktree_[0-9a-f]{64}$/u
const OBJECT_ID = /^[0-9a-f]{40,64}$/u
const SNAPSHOT_OPERATIONS = new Set(['discover', 'list', 'status', 'associate'])
const WORKTREE_STATES = new Set(['ready', 'missing', 'invalid', 'not-a-repo'])
const HEAD_STATES = new Set(['branch', 'detached', 'unborn'])
const ATTENTION_REASONS = new Set(['merge', 'rebase', 'cherry-pick', 'revert', 'bisect'])

function stringIds(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every(isNonEmptyString) ? [...value] : undefined
}

function attentionReasons(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every(reason => ATTENTION_REASONS.has(reason))) return undefined
  return [...value]
}

function normalizeError(value: unknown): GitWorktreeError | undefined {
  if (
    !isRecord(value)
    || !isNonEmptyString(value.code)
    || !isNonEmptyString(value.operation)
    || !SNAPSHOT_OPERATIONS.has(value.operation)
    || !isNonEmptyString(value.message)
    || (value.repoId !== undefined && (typeof value.repoId !== 'string' || !REPO_ID.test(value.repoId)))
    || (value.worktreeId !== undefined && (typeof value.worktreeId !== 'string' || !WORKTREE_ID.test(value.worktreeId)))
    || (value.path !== undefined && typeof value.path !== 'string')
    || (value.workspaceId !== undefined && !isNonEmptyString(value.workspaceId))
  ) return undefined
  return {
    code: value.code,
    operation: value.operation,
    ...(typeof value.repoId === 'string' ? { repoId: value.repoId } : {}),
    ...(typeof value.worktreeId === 'string' ? { worktreeId: value.worktreeId } : {}),
    ...(typeof value.path === 'string' ? { path: value.path } : {}),
    ...(typeof value.workspaceId === 'string' ? { workspaceId: value.workspaceId } : {}),
    message: value.message,
  }
}

function normalizeWorktree(value: unknown): GitWorktreeInfo | undefined {
  if (!isRecord(value)) return undefined
  const sessionIds = stringIds(value.sessionIds)
  const runningSessionIds = stringIds(value.runningSessionIds)
  const attention = attentionReasons(value.attention)
  if (
    !isNonEmptyString(value.worktreeId)
    || !WORKTREE_ID.test(value.worktreeId)
    || !isNonEmptyString(value.path)
    || !isNonEmptyString(value.head)
    || !OBJECT_ID.test(value.head)
    || !(value.branch === null || isNonEmptyString(value.branch))
    || typeof value.isMain !== 'boolean'
    || !(value.dirty === null || typeof value.dirty === 'boolean')
    || typeof value.locked !== 'boolean'
    || !WORKTREE_STATES.has(value.status)
    || !HEAD_STATES.has(value.headState)
    || attention === undefined
    || !(value.workspaceId === null || isNonEmptyString(value.workspaceId))
    || sessionIds === undefined
    || runningSessionIds === undefined
  ) return undefined
  return {
    worktreeId: value.worktreeId,
    path: value.path,
    head: value.head,
    branch: value.branch,
    isMain: value.isMain,
    dirty: value.dirty,
    locked: value.locked,
    status: value.status,
    headState: value.headState,
    attention,
    workspaceId: value.workspaceId,
    sessionIds,
    runningSessionIds,
  }
}

/**
 * Malformed individual repos/worktrees become partial errors; valid siblings
 * survive. Duplicate opaque identities are dropped so mutations can never
 * resolve an ambiguous UI row.
 */
export function normalizeGitSnapshot(value: unknown): GitWorktreeSnapshot {
  if (!isRecord(value)) throw new Error('gitWorktree/snapshot: result must be an object')
  if (!Array.isArray(value.repos)) throw new Error('gitWorktree/snapshot: repos must be an array')
  if (!Array.isArray(value.errors)) throw new Error('gitWorktree/snapshot: errors must be an array')
  const errors: GitWorktreeError[] = []
  for (const [errorIndex, rawError] of value.errors.entries()) {
    const error = normalizeError(rawError)
    if (error === undefined) {
      errors.push({ code: 'invalid-error', operation: 'snapshot', message: `Git snapshot error ${errorIndex} 形状无效` })
    } else {
      errors.push(error)
    }
  }
  const repos: GitRepoTopology[] = []
  const repoIds = new Set<string>()
  for (const [repoIndex, rawRepo] of value.repos.entries()) {
    if (
      !isRecord(rawRepo)
      || !isNonEmptyString(rawRepo.repoId)
      || !REPO_ID.test(rawRepo.repoId)
      || !isNonEmptyString(rawRepo.commonDir)
      || !isNonEmptyString(rawRepo.mainPath)
      || !Array.isArray(rawRepo.worktrees)
    ) {
      errors.push({ code: 'invalid-repo', operation: 'snapshot', message: `Git snapshot repo ${repoIndex} 形状无效` })
      continue
    }
    if (repoIds.has(rawRepo.repoId)) {
      errors.push({ code: 'duplicate-repo-id', operation: 'snapshot', repoId: rawRepo.repoId, message: `Git snapshot repo ${repoIndex} identity duplicated` })
      continue
    }
    repoIds.add(rawRepo.repoId)
    const worktrees: GitWorktreeInfo[] = []
    const worktreeIds = new Set<string>()
    for (const [rowIndex, rawWorktree] of rawRepo.worktrees.entries()) {
      const worktree = normalizeWorktree(rawWorktree)
      if (worktree === undefined) {
        errors.push({
          code: 'invalid-worktree', operation: 'snapshot', path: rawRepo.mainPath,
          message: `Git snapshot worktree ${repoIndex}/${rowIndex} 形状无效`,
        })
      } else if (worktreeIds.has(worktree.worktreeId)) {
        errors.push({
          code: 'duplicate-worktree-id', operation: 'snapshot', repoId: rawRepo.repoId,
          worktreeId: worktree.worktreeId, path: worktree.path,
          message: `Git snapshot worktree ${repoIndex}/${rowIndex} identity duplicated`,
        })
      } else {
        worktreeIds.add(worktree.worktreeId)
        worktrees.push(worktree)
      }
    }
    repos.push({ repoId: rawRepo.repoId, commonDir: rawRepo.commonDir, mainPath: rawRepo.mainPath, worktrees })
  }
  const snapshot: GitWorktreeSnapshot = { repos, errors }
  if (value.sourceError !== undefined) {
    // Unknown codes from a NEWER host are accepted and passed through: a new
    // source-level code must not reject the whole snapshot (and its valid
    // partial facts). Only malformed shapes fail loud.
    if (
      !isRecord(value.sourceError)
      || !isNonEmptyString(value.sourceError.code)
      || !isNonEmptyString(value.sourceError.message)
    ) {
      throw new Error('gitWorktree/snapshot: sourceError must carry string code/message')
    }
    snapshot.sourceError = {
      code: value.sourceError.code,
      message: value.sourceError.message,
    }
  }
  return snapshot
}
