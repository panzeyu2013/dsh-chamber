/** Same-origin client for the chamber host Git Remote. */
import type {
  CreateWorktreeResult, GitWorktreeSnapshot, PreviewCreateInput, PreviewCreateResult,
  RemoveWorktreeResult, RollbackCreateResult,
} from './types.ts'
import { normalizeGitSnapshot } from './snapshot.ts'

// 60s, not 30s (2026-08 bug report): the proxy's upstream idle timeout is
// 45s (UPSTREAM_TIMEOUT_MS in the control plane) and the host's git mutation
// budget is 30s — the browser must never abort while the host is still
// legitimately working, or a committed mutation is misread as ambiguous.
const RPC_TIMEOUT_MS = 60_000

export class GitWorktreeRpcError extends Error {
  readonly code: string
  readonly details: unknown
  readonly retryable: boolean | undefined

  constructor(code: string, message: string, details?: unknown, retryable?: boolean) {
    super(`${code}: ${message}`)
    this.name = 'GitWorktreeRpcError'
    this.code = code
    this.details = details
    this.retryable = retryable
  }
}

/**
 * True when the browser cannot know whether the host committed the request.
 * Typert business errors are definitive; transport/timeout/invalid response
 * failures must retain the operation id for an idempotent retry. A missing
 * host package (404) is DEFINITIVE: retrying the same mutation cannot help
 * until the instance loads the Remote, so it must not mint recovery entries.
 */
export function isAmbiguousGitRpcFailure(error: unknown): boolean {
  if (!(error instanceof GitWorktreeRpcError)) return true
  return error.code === 'http-error'
    || error.code === 'invalid-envelope'
    || error.code === 'rpc-failed'
    || error.code === 'invalid-domain-result'
    || error.code === 'invalid-domain-value'
    || error.retryable === true
}

/** Preflight/deterministic rejections that can NEVER have committed a
 *  mutation: surfacing them as an ambiguous recovery would replay the same
 *  failure forever and lock the whole source (review P2-1). They become a
 *  plain actionError instead — the user fixes the cause and retries. */
export function isDeterministicGitRejection(error: unknown): boolean {
  if (!(error instanceof GitWorktreeRpcError)) return false
  switch (error.code) {
    case 'invalid-input':
    case 'unsafe-path':
    case 'expected-mismatch':
    case 'workspace/not-found':
    case 'worktree-not-found':
    case 'main-worktree':
    case 'worktree-locked':
    case 'worktree-dirty':
    case 'worktree-submodules':
    case 'nested-workspace':
    case 'workspace-registered':
    case 'workspace-path-unavailable':
    case 'path-unavailable':
    case 'running-agent':
    case 'worktree-invalid':
    case 'branch-exists':
    case 'branch-not-found':
      return true
    default:
      return false
  }
}

export interface CreateWorktreeInput {
  previewToken: string
  operationId: string
}

export interface RemoveWorktreeInput {
  operationId: string
  /** Absent for an UNREGISTERED worktree removal (path required instead). */
  workspaceId?: string
  /** Required when workspaceId is absent: the exact worktree path. */
  path?: string
  expected: { repoId: string; worktreeId: string; branch: string | null; head: string }
  /** Optional local branch to delete after the worktree removal (design 08 §11). */
  deleteBranch?: string
  /** Explicit user authorization to DISCARD the worktree's uncommitted state:
   *  the host then removes a dirty worktree with `git worktree remove
   *  --force` (branch/commits/HEAD untouched). Never set without a confirmed
   *  dialog checkbox (design 08 §6 amendment 2026-08). */
  discardChanges?: boolean
}

export type RollbackCreateExpectation = Pick<
  CreateWorktreeResult,
  'repoId' | 'worktreeId' | 'commonDir' | 'path' | 'branch' | 'head'
>

const REPO_ID = /^repo_[0-9a-f]{64}$/u
const WORKTREE_ID = /^worktree_[0-9a-f]{64}$/u
const OBJECT_ID = /^[0-9a-f]{40,64}$/u

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalidValue(method: string, reason: string, details?: unknown): never {
  throw new GitWorktreeRpcError(
    'invalid-domain-value',
    `gitWorktree/${method} 返回值无效：${reason}`,
    details,
  )
}

function stringField(value: Record<string, any>, field: string, method: string): string {
  const result = value[field]
  if (typeof result !== 'string' || result === '') invalidValue(method, `${field} 必须为非空字符串`)
  return result
}

function booleanField(value: Record<string, any>, field: string, method: string): boolean {
  const result = value[field]
  if (typeof result !== 'boolean') invalidValue(method, `${field} 必须为布尔值`)
  return result
}

function repoIdField(value: Record<string, any>, method: string): string {
  const result = stringField(value, 'repoId', method)
  if (!REPO_ID.test(result)) invalidValue(method, 'repoId 不是宿主 opaque id')
  return result
}

function worktreeIdField(value: Record<string, any>, method: string): string {
  const result = stringField(value, 'worktreeId', method)
  if (!WORKTREE_ID.test(result)) invalidValue(method, 'worktreeId 不是宿主 opaque id')
  return result
}

function oidField(value: Record<string, any>, field: string, method: string): string {
  const result = stringField(value, field, method)
  if (!OBJECT_ID.test(result)) invalidValue(method, `${field} 不是 Git object id`)
  return result
}

function assertEqual(method: string, field: string, actual: unknown, expected: unknown): void {
  if (actual !== expected) invalidValue(method, `${field} 与请求上下文不匹配`, { field, expected, actual })
}

function stringArrayField(value: Record<string, any>, field: string, method: string): string[] {
  const result = value[field]
  if (!Array.isArray(result) || !result.every(item => typeof item === 'string' && item !== '')) {
    invalidValue(method, `${field} 必须为非空字符串数组`)
  }
  if (new Set(result).size !== result.length) invalidValue(method, `${field} 含重复 identity`)
  return [...result]
}

export function decodeSnapshotValue(value: unknown): GitWorktreeSnapshot {
  try {
    return normalizeGitSnapshot(value)
  } catch (error) {
    invalidValue('snapshot', error instanceof Error ? error.message : String(error))
  }
}

export function decodePreviewCreateValue(
  value: unknown,
  input: PreviewCreateInput,
): PreviewCreateResult {
  const method = 'previewCreate'
  if (!isRecord(value)) invalidValue(method, '结果必须为对象')
  const expiresAt = value.expiresAt
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
    invalidValue(method, 'expiresAt 必须为有限数值')
  }
  const result: PreviewCreateResult = {
    previewToken: stringField(value, 'previewToken', method),
    expiresAt,
    repoId: repoIdField(value, method),
    commonDir: stringField(value, 'commonDir', method),
    mainPath: stringField(value, 'mainPath', method),
    targetPath: stringField(value, 'targetPath', method),
    branch: stringField(value, 'branch', method),
    baseHead: oidField(value, 'baseHead', method),
  }
  assertEqual(method, 'branch', result.branch, input.branch.name)
  return result
}

/** Decode and correlate every durable create fact before workspace adoption. */
export function decodeCreateValue(
  value: unknown,
  input: CreateWorktreeInput,
  preview: PreviewCreateResult,
): CreateWorktreeResult {
  const method = 'create'
  if (!isRecord(value)) invalidValue(method, '结果必须为对象')
  const result: CreateWorktreeResult = {
    operationId: stringField(value, 'operationId', method),
    created: value.created === true ? true : invalidValue(method, 'created 必须为 true'),
    replayed: booleanField(value, 'replayed', method),
    repoId: repoIdField(value, method),
    worktreeId: worktreeIdField(value, method),
    commonDir: stringField(value, 'commonDir', method),
    path: stringField(value, 'path', method),
    branch: stringField(value, 'branch', method),
    head: oidField(value, 'head', method),
    branchCreated: booleanField(value, 'branchCreated', method),
    rollbackAuthorized: booleanField(value, 'rollbackAuthorized', method),
  }
  assertEqual(method, 'operationId', result.operationId, input.operationId)
  assertEqual(method, 'repoId', result.repoId, preview.repoId)
  assertEqual(method, 'commonDir', result.commonDir, preview.commonDir)
  assertEqual(method, 'path', result.path, preview.targetPath)
  assertEqual(method, 'branch', result.branch, preview.branch)
  assertEqual(method, 'head', result.head, preview.baseHead)
  return result
}

export function decodeRollbackCreateValue(
  value: unknown,
  input: { operationId: string },
  expected: RollbackCreateExpectation,
): RollbackCreateResult {
  const method = 'rollbackCreate'
  if (!isRecord(value)) invalidValue(method, '结果必须为对象')
  const result: RollbackCreateResult = {
    operationId: stringField(value, 'operationId', method),
    removed: value.removed === true ? true : invalidValue(method, 'removed 必须为 true'),
    replayed: booleanField(value, 'replayed', method),
    repoId: repoIdField(value, method),
    worktreeId: worktreeIdField(value, method),
    commonDir: stringField(value, 'commonDir', method),
    path: stringField(value, 'path', method),
    branch: stringField(value, 'branch', method),
    head: oidField(value, 'head', method),
    branchPreserved: value.branchPreserved === true
      ? true
      : invalidValue(method, 'branchPreserved 必须为 true'),
    ...(value.branchDeleted === true ? { branchDeleted: true } : {}),
    ...(value.branchDeleteFailed === true ? { branchDeleteFailed: true } : {}),
  }
  assertEqual(method, 'operationId', result.operationId, input.operationId)
  assertEqual(method, 'repoId', result.repoId, expected.repoId)
  assertEqual(method, 'worktreeId', result.worktreeId, expected.worktreeId)
  assertEqual(method, 'commonDir', result.commonDir, expected.commonDir)
  assertEqual(method, 'path', result.path, expected.path)
  assertEqual(method, 'branch', result.branch, expected.branch)
  assertEqual(method, 'head', result.head, expected.head)
  return result
}

export function decodeRemoveValue(
  value: unknown,
  input: RemoveWorktreeInput,
  expectedPath: string,
): RemoveWorktreeResult {
  const method = 'remove'
  if (!isRecord(value)) invalidValue(method, '结果必须为对象')
  const branch = value.branch
  if (!(branch === null || (typeof branch === 'string' && branch !== ''))) {
    invalidValue(method, 'branch 必须为非空字符串或 null')
  }
  const result: RemoveWorktreeResult = {
    operationId: stringField(value, 'operationId', method),
    removed: value.removed === true ? true : invalidValue(method, 'removed 必须为 true'),
    replayed: booleanField(value, 'replayed', method),
    ...(value.workspaceId === undefined ? {} : { workspaceId: stringField(value, 'workspaceId', method) }),
    repoId: repoIdField(value, method),
    worktreeId: worktreeIdField(value, method),
    commonDir: stringField(value, 'commonDir', method),
    path: stringField(value, 'path', method),
    branch,
    head: oidField(value, 'head', method),
    sessionIds: stringArrayField(value, 'sessionIds', method),
    next: value.next === 'delete-workspace' || value.next === 'none'
      ? value.next
      : invalidValue(method, "next 必须为 'delete-workspace' 或 'none'"),
    branchPreserved: value.branchPreserved === true
      ? true
      : invalidValue(method, 'branchPreserved 必须为 true'),
  }
  // Decode invariant (P2-1): `next` and `workspaceId` must agree — a
  // 'delete-workspace' without an id would call deleteWorkspace(undefined).
  if ((result.next === 'delete-workspace') !== (result.workspaceId !== undefined)) {
    return invalidValue(method, "next 与 workspaceId 不一致")
  }
  assertEqual(method, 'operationId', result.operationId, input.operationId)
  assertEqual(method, 'workspaceId', result.workspaceId, input.workspaceId)
  assertEqual(method, 'repoId', result.repoId, input.expected.repoId)
  assertEqual(method, 'worktreeId', result.worktreeId, input.expected.worktreeId)
  assertEqual(method, 'branch', result.branch, input.expected.branch)
  assertEqual(method, 'head', result.head, input.expected.head)
  assertEqual(method, 'path', result.path, expectedPath)
  return result
}

function rpcId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `git-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

async function callGitRemote(sourceId: string, method: string, input?: unknown): Promise<unknown> {
  const response = await fetch(`/api/i/${encodeURIComponent(sourceId)}/api/gitWorktree/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: rpcId(),
      method: `gitWorktree/${method}`,
      // Typert validates the named argument object exactly: snapshot() has no
      // argument, while every mutating method has the single argument `input`.
      payload: { args: input === undefined ? {} : { input } },
    }),
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
  })
  if (!response.ok) {
    // A 404 on the gitWorktree namespace means the instance gateway does not
    // know the Remote: the chamber host package is not loaded there (local:
    // stale profile overlay — restart the desktop; remote: package seeded at
    // ready but the instance must restart to pick up the patch; or the
    // package is genuinely absent). Surfacing the raw status hides the fix.
    if (response.status === 404) {
      throw new GitWorktreeRpcError(
        'git-host-not-loaded',
        'Git 插件未在该实例加载（host 包缺失或未生效）。本地实例请重启桌面端；远程实例请在连接设置中重新下发 chamber host 包并点击“重启生效”后重试。',
      )
    }
    throw new GitWorktreeRpcError('http-error', `Git Remote HTTP ${response.status}`)
  }
  let envelope: any
  try {
    envelope = await response.json()
  } catch {
    throw new GitWorktreeRpcError('invalid-envelope', 'Git Remote 返回的不是合法 JSON')
  }
  const result = envelope?.result
  if (typeof result !== 'object' || result === null || typeof result.ok !== 'boolean') {
    throw new GitWorktreeRpcError('invalid-envelope', 'Git Remote envelope 缺少 result')
  }
  if (result.ok !== true) {
    const error = result?.error
    throw new GitWorktreeRpcError(
      'rpc-failed',
      String(error?.message ?? error?.code ?? 'Git Remote 内部调用失败'),
      error?.details,
    )
  }
  // The host catches every known GitWorktreeError and returns a domain result
  // inside Typert's transport result. Only this inner error has stable domain
  // codes suitable for recovery decisions.
  const domain = result.value
  if (typeof domain !== 'object' || domain === null || typeof domain.ok !== 'boolean') {
    throw new GitWorktreeRpcError('invalid-domain-result', 'Git Remote 缺少领域结果 envelope')
  }
  if (domain.ok !== true) {
    const error = domain.error
    if (
      !isRecord(error)
      || typeof error.code !== 'string'
      || error.code === ''
      || typeof error.message !== 'string'
      || error.message === ''
      || (error.retryable !== undefined && typeof error.retryable !== 'boolean')
      || (error.details !== undefined && !isRecord(error.details))
    ) {
      throw new GitWorktreeRpcError('invalid-domain-result', 'Git Remote 领域错误形状无效')
    }
    throw new GitWorktreeRpcError(error.code, error.message, error.details, error.retryable)
  }
  return domain.value
}

export const gitWorktreeApi = {
  async snapshot(sourceId: string): Promise<GitWorktreeSnapshot> {
    return decodeSnapshotValue(await callGitRemote(sourceId, 'snapshot'))
  },
  async previewCreate(sourceId: string, input: PreviewCreateInput): Promise<PreviewCreateResult> {
    return decodePreviewCreateValue(await callGitRemote(sourceId, 'previewCreate', input), input)
  },
  async create(
    sourceId: string,
    input: CreateWorktreeInput,
    preview: PreviewCreateResult,
  ): Promise<CreateWorktreeResult> {
    return decodeCreateValue(await callGitRemote(sourceId, 'create', input), input, preview)
  },
  async rollbackCreate(
    sourceId: string,
    input: { operationId: string },
    expected: RollbackCreateExpectation,
  ): Promise<RollbackCreateResult> {
    return decodeRollbackCreateValue(await callGitRemote(sourceId, 'rollbackCreate', input), input, expected)
  },
  async remove(sourceId: string, input: RemoveWorktreeInput, expectedPath: string): Promise<RemoveWorktreeResult> {
    return decodeRemoveValue(await callGitRemote(sourceId, 'remove', input), input, expectedPath)
  },
}
