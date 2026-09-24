/** Defensive, pure fold for the untrusted Git Remote snapshot response. */
import type {
  GitRepoTopology, GitWorktreeError, GitWorktreeInfo, GitWorktreeSnapshot,
} from './types.ts'
import { isRecord } from '@dsh-chamber/dsh-chamber-client-core'

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}

/** 状态字面量收窄（`Set.has` 本身不是类型守卫；非字符串一律判不合规）。 */
function isWorktreeState(value: unknown): value is 'invalid' | 'missing' | 'not-a-repo' | 'ready' {
  return typeof value === 'string' && WORKTREE_STATES.has(value)
}

function isHeadState(value: unknown): value is 'branch' | 'detached' | 'unborn' {
  return typeof value === 'string' && HEAD_STATES.has(value)
}

const REPO_ID = /^repo_[0-9a-f]{64}$/u
const WORKTREE_ID = /^worktree_[0-9a-f]{64}$/u
const OBJECT_ID = /^[0-9a-f]{40,64}$/u
const SNAPSHOT_OPERATIONS = new Set(['discover', 'list', 'status', 'associate'])
const WORKTREE_STATES = new Set(['ready', 'missing', 'invalid', 'not-a-repo'])
const HEAD_STATES = new Set(['branch', 'detached', 'unborn'])
// Must stay in sync with the occupant's attention labels: an unknown reason
// rejects the row (fail-closed) instead of rendering an unmapped badge.
const ATTENTION_REASONS = new Set(['merge', 'rebase', 'cherry-pick', 'revert', 'bisect'])

function stringIds(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every(isNonEmptyString) ? [...value] : undefined
}

function attentionReasons(value: unknown): string[] | undefined {
  // ABSENT attention (an older host) degrades to [], the honest "no in-progress
  // git operation"; a PRESENT but unknown reason still rejects the row (fail-closed).
  if (value === undefined) return []
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
  // Optional (a NEWER host): absent on an older host → caller falls back to
  // runningSessionIds (conservative); present-but-malformed fails the row.
  const blockingRunningSessionIds = value.blockingRunningSessionIds === undefined
    ? undefined
    : stringIds(value.blockingRunningSessionIds)
  // The archived-aware field is a SUBSET by contract (the running sessions that
  // gate removal); a non-subset would under-report inert sessions — reject the row.
  if (
    blockingRunningSessionIds !== undefined
    && runningSessionIds !== undefined
    && blockingRunningSessionIds.some(id => !runningSessionIds.includes(id))
  ) return undefined
  const attention = attentionReasons(value.attention)
  // upstream/ahead/behind are OPTIONAL: an older host omits them (degrade to null/0); malformed fails the row.
  const upstream = value.upstream === undefined || value.upstream === null
    ? null
    : (isNonEmptyString(value.upstream) ? value.upstream : undefined)
  const ahead = value.ahead === undefined
    ? 0
    : (typeof value.ahead === 'number' && Number.isInteger(value.ahead) && value.ahead >= 0 ? value.ahead : undefined)
  const behind = value.behind === undefined
    ? 0
    : (typeof value.behind === 'number' && Number.isInteger(value.behind) && value.behind >= 0 ? value.behind : undefined)
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
    || !isWorktreeState(value.status)
    || !isHeadState(value.headState)
    || upstream === undefined
    || ahead === undefined
    || behind === undefined
    || attention === undefined
    || !(value.workspaceId === null || isNonEmptyString(value.workspaceId))
    || sessionIds === undefined
    || runningSessionIds === undefined
    || (value.blockingRunningSessionIds !== undefined && blockingRunningSessionIds === undefined)
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
    upstream,
    ahead,
    behind,
    attention,
    workspaceId: value.workspaceId,
    sessionIds,
    runningSessionIds,
    ...(blockingRunningSessionIds === undefined ? {} : { blockingRunningSessionIds }),
  }
}

/**
 * Malformed individual repos/worktrees become partial errors; valid siblings
 * survive. Duplicate opaque identities are dropped so mutations can never resolve
 * an ambiguous UI row.
 */
export function normalizeGitSnapshot(value: unknown): GitWorktreeSnapshot {
  if (!isRecord(value)) throw new Error('gitWorktree/snapshot: result must be an object')
  if (!Array.isArray(value.repos)) throw new Error('gitWorktree/snapshot: repos must be an array')
  if (!Array.isArray(value.errors)) throw new Error('gitWorktree/snapshot: errors must be an array')
  const errors: GitWorktreeError[] = []
  for (const [errorIndex, rawError] of value.errors.entries()) {
    const error = normalizeError(rawError)
    if (error === undefined) {
      errors.push({ code: 'invalid-error', operation: 'snapshot', message: `Git snapshot error ${errorIndex} has an invalid shape` })
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
      errors.push({ code: 'invalid-repo', operation: 'snapshot', message: `Git snapshot repo ${repoIndex} has an invalid shape` })
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
          message: `Git snapshot worktree ${repoIndex}/${rowIndex} has an invalid shape`,
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
    // branches is OPTIONAL: an older host omits it and the picker degrades to empty
    // rather than rejecting the snapshot (fail-closed applies to shapes, not version skew).
    const branches = Array.isArray(rawRepo.branches) && rawRepo.branches.every(isNonEmptyString)
      ? rawRepo.branches
      : []
    repos.push({ repoId: rawRepo.repoId, commonDir: rawRepo.commonDir, mainPath: rawRepo.mainPath, worktrees, branches })
  }
  const snapshot: GitWorktreeSnapshot = { repos, errors }
  if (value.sourceError !== undefined) {
    // Unknown codes from a NEWER host pass through: a new source-level code must not
    // reject the whole snapshot and its valid partial facts.
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
