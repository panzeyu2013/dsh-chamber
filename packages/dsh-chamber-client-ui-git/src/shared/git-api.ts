/** Same-origin client for the chamber host Git Remote. */
import type {
  CreateWorktreeResult, GitWorktreeSnapshot, PreviewCreateInput, PreviewCreateResult,
  RemoveWorktreeResult, RollbackCreateResult,
} from './types.ts'
import { normalizeGitSnapshot } from './snapshot.ts'

const RPC_TIMEOUT_MS = 30_000

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
 * failures must retain the operation id for an idempotent retry.
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

export interface CreateWorktreeInput {
  previewToken: string
  operationId: string
}

export interface RemoveWorktreeInput {
  operationId: string
  workspaceId: string
  expected: { repoId: string; worktreeId: string; branch: string | null; head: string }
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
    workspaceId: stringField(value, 'workspaceId', method),
    repoId: repoIdField(value, method),
    worktreeId: worktreeIdField(value, method),
    commonDir: stringField(value, 'commonDir', method),
    path: stringField(value, 'path', method),
    branch,
    head: oidField(value, 'head', method),
    sessionIds: stringArrayField(value, 'sessionIds', method),
    next: value.next === 'delete-workspace'
      ? 'delete-workspace'
      : invalidValue(method, "next 必须为 'delete-workspace'"),
    branchPreserved: value.branchPreserved === true
      ? true
      : invalidValue(method, 'branchPreserved 必须为 true'),
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
  if (!response.ok) throw new GitWorktreeRpcError('http-error', `Git Remote HTTP ${response.status}`)
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
