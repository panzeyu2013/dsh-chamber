/** Client for the chamber host Git Remote over the shared per-instance carrier. */
import {
  getInstanceClient, InstanceDomainMissingError, type UnaryResult,
} from '@dsh-chamber/dsh-chamber-client-core'
import type {
  CreateWorktreeResult, GitWorktreeSnapshot, PreviewCreateInput, PreviewCreateResult,
  RemoveWorktreeResult, RollbackCreateResult,
} from './types.ts'
import { errorMessage, isRecord } from '@dsh-chamber/dsh-chamber-client-core'
import { normalizeGitSnapshot } from './snapshot.ts'
// The client leg of the three-layer git timeout ladder; the control-plane
// lockstep test imports the same module as the client's REAL budget.
import { RPC_TIMEOUT_MS } from './timeout-budget.ts'

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

/**
 * Preflight/deterministic rejections that can NEVER have committed a mutation:
 * surfacing them as an ambiguous recovery would replay the same failure
 * forever and lock the whole source. They become a plain
 * actionError instead — the user fixes the cause and retries.
 *
 * LOCKSTEP POINT (host classification): `RETRYABLE_CODES` in
 * `packages/dsh-chamber-seed-git-worktree/src/core.ts` is the codes the host
 * serializes with `retryable: true` (outcome unverified). This set must stay
 * disjoint from it except for {@link DETERMINISTIC_HOST_RETRYABLE_OVERRIDES},
 * and must cover every code the host proves to be a pre-mutation refusal. The
 * cross-package test `test/snapshot/host-client-lockstep.test.ts` fails on any other
 * divergence, so a code added or renamed on either side must be mirrored here.
 */
export const DETERMINISTIC_GIT_REJECTION_CODES: ReadonlySet<string> = new Set([
  'invalid-input',
  'unsafe-path',
  'expected-mismatch',
  'workspace/not-found',
  'worktree-not-found',
  'main-worktree',
  'worktree-locked',
  'worktree-dirty',
  'worktree-submodules',
  'nested-workspace',
  'workspace-registered',
  'workspace-path-unavailable',
  'path-unavailable',
  'running-agent',
  'worktree-invalid',
  'branch-exists',
  'branch-not-found',
])

/**
 * Host-RETRYABLE codes this client deliberately classifies as deterministic
 * anyway: both come from the host's filesystem probe
 * (`existingPath`), so replaying the same operation re-runs the same failing
 * probe. Treating them as ambiguous replaces the actionable refusal with a
 * recovery entry that replays forever and wedges the source. The host keeps
 * them retryable because the same code can also surface from a post-mutation
 * reconcile, but the client's only actionable outcome is the refusal — and an
 * explicit host `retryable: false` (isProvenPreMutationRefusal) remains the
 * proof that clears a pending recovery.
 *
 * LOCKSTEP POINT: `test/snapshot/host-client-lockstep.test.ts` asserts this set is
 * EXACTLY the overlap between {@link DETERMINISTIC_GIT_REJECTION_CODES} and the
 * host's `RETRYABLE_CODES` — an undeclared overlap (or a host code that stops
 * overlapping without this list being updated) fails the suite.
 */
export const DETERMINISTIC_HOST_RETRYABLE_OVERRIDES: ReadonlySet<string> = new Set([
  'path-unavailable',
  'workspace-path-unavailable',
])

/** True for a host code the browser refuses to replay (see
 *  {@link DETERMINISTIC_GIT_REJECTION_CODES}). */
export function isDeterministicGitRejection(error: unknown): boolean {
  return error instanceof GitWorktreeRpcError && DETERMINISTIC_GIT_REJECTION_CODES.has(error.code)
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
  /** Optional local branch to delete after the worktree removal (design 08 §5.3). */
  deleteBranch?: string
  /** Explicit user authorization to DISCARD the worktree's uncommitted state:
   *  the host then removes a dirty worktree with `git worktree remove
   *  --force` (branch/commits/HEAD untouched). Never set without a confirmed
   *  dialog checkbox (design 08 §5.3 amendment). */
  discardChanges?: boolean
}

export type RollbackCreateExpectation = Pick<
  CreateWorktreeResult,
  'repoId' | 'worktreeId' | 'commonDir' | 'path' | 'branch' | 'head'
>

const REPO_ID = /^repo_[0-9a-f]{64}$/u
const WORKTREE_ID = /^worktree_[0-9a-f]{64}$/u
const OBJECT_ID = /^[0-9a-f]{40,64}$/u

function invalidValue(method: string, reason: string, details?: unknown): never {
  throw new GitWorktreeRpcError(
    'invalid-domain-value',
    `gitWorktree/${method} returned an invalid value: ${reason}`,
    details,
  )
}

function stringField(value: Record<string, any>, field: string, method: string): string {
  const result = value[field]
  if (typeof result !== 'string' || result === '') invalidValue(method, `${field} must be a non-empty string`)
  return result
}

function booleanField(value: Record<string, any>, field: string, method: string): boolean {
  const result = value[field]
  if (typeof result !== 'boolean') invalidValue(method, `${field} must be a boolean`)
  return result
}

function repoIdField(value: Record<string, any>, method: string): string {
  const result = stringField(value, 'repoId', method)
  if (!REPO_ID.test(result)) invalidValue(method, 'repoId is not a host opaque id')
  return result
}

function worktreeIdField(value: Record<string, any>, method: string): string {
  const result = stringField(value, 'worktreeId', method)
  if (!WORKTREE_ID.test(result)) invalidValue(method, 'worktreeId is not a host opaque id')
  return result
}

function oidField(value: Record<string, any>, field: string, method: string): string {
  const result = stringField(value, field, method)
  if (!OBJECT_ID.test(result)) invalidValue(method, `${field} is not a Git object id`)
  return result
}

function assertEqual(method: string, field: string, actual: unknown, expected: unknown): void {
  if (actual !== expected) invalidValue(method, `${field} does not match the request context`, { field, expected, actual })
}

function stringArrayField(value: Record<string, any>, field: string, method: string): string[] {
  const result = value[field]
  if (!Array.isArray(result) || !result.every(item => typeof item === 'string' && item !== '')) {
    invalidValue(method, `${field} must be an array of non-empty strings`)
  }
  if (new Set(result).size !== result.length) invalidValue(method, `${field} contains duplicate identities`)
  return [...result]
}

export function decodeSnapshotValue(value: unknown): GitWorktreeSnapshot {
  try {
    return normalizeGitSnapshot(value)
  } catch (error) {
    invalidValue('snapshot', errorMessage(error))
  }
}

export function decodePreviewCreateValue(
  value: unknown,
  input: PreviewCreateInput,
): PreviewCreateResult {
  const method = 'previewCreate'
  if (!isRecord(value)) invalidValue(method, 'result must be an object')
  const expiresAt = value.expiresAt
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
    invalidValue(method, 'expiresAt must be a finite number')
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
  if (!isRecord(value)) invalidValue(method, 'result must be an object')
  const result: CreateWorktreeResult = {
    operationId: stringField(value, 'operationId', method),
    created: value.created === true ? true : invalidValue(method, 'created must be true'),
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
  if (!isRecord(value)) invalidValue(method, 'result must be an object')
  const result: RollbackCreateResult = {
    operationId: stringField(value, 'operationId', method),
    removed: value.removed === true ? true : invalidValue(method, 'removed must be true'),
    replayed: booleanField(value, 'replayed', method),
    repoId: repoIdField(value, method),
    worktreeId: worktreeIdField(value, method),
    commonDir: stringField(value, 'commonDir', method),
    path: stringField(value, 'path', method),
    branch: stringField(value, 'branch', method),
    head: oidField(value, 'head', method),
    branchPreserved: value.branchPreserved === true
      ? true
      : invalidValue(method, 'branchPreserved must be true'),
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
  if (!isRecord(value)) invalidValue(method, 'result must be an object')
  const branch = value.branch
  if (!(branch === null || (typeof branch === 'string' && branch !== ''))) {
    invalidValue(method, 'branch must be a non-empty string or null')
  }
  const result: RemoveWorktreeResult = {
    operationId: stringField(value, 'operationId', method),
    removed: value.removed === true ? true : invalidValue(method, 'removed must be true'),
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
      : invalidValue(method, "next must be 'delete-workspace' or 'none'"),
    branchPreserved: value.branchPreserved === true
      ? true
      : invalidValue(method, 'branchPreserved must be true'),
  }
  // Decode invariant: `next` and `workspaceId` must agree — a
  // 'delete-workspace' without an id would call deleteWorkspace(undefined).
  if ((result.next === 'delete-workspace') !== (result.workspaceId !== undefined)) {
    return invalidValue(method, 'next does not agree with workspaceId')
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

/**
 * One gitWorktree call over the SIDEBAR's per-instance unary carrier — the ONE
 * client-request envelope, rpcId correlation, timeout budget and error
 * classification in this repo (design 08 §7, design 20 §4.2). The carrier owns
 * the URL/base path, the browser-auth handling of the per-instance proxy, the
 * not-ready 503 class and the design 24 §5 404 domain-missing discrimination;
 * this module keeps only the git-specific two-layer domain decode and maps the
 * carrier's outcomes onto the codes THIS client's recovery rules consume.
 */
async function callGitRemote(sourceId: string, method: string, input?: unknown): Promise<unknown> {
  const endpoint = `gitWorktree/${method}`
  let transport: UnaryResult<unknown>
  try {
    transport = await getInstanceClient(sourceId).callUnary(
      endpoint,
      // Typert validates the named argument object exactly: snapshot() has no
      // argument, while every mutating method has the single argument `input`.
      input === undefined ? {} : { input },
      undefined,
      // The 60s budget must stay ABOVE the proxy's 45s upstream idle window
      // and the host's 30s mutation budget, and the
      // domain-missing opt-in keeps the design 24 §5 404 discrimination.
      { timeoutMs: RPC_TIMEOUT_MS, notFoundAsDomainMissing: true },
    )
  } catch (error) {
    // The carrier's domain-missing class IS the definitive design 08 §6.3 404:
    // the gitWorktree Remote is not mounted, so replaying the same mutation
    // cannot help and a recovery entry must never be minted from it.
    if (error instanceof InstanceDomainMissingError) {
      throw new GitWorktreeRpcError(
        'git-host-not-loaded',
        // The user-facing guide is localized (locales.gitHostNotLoaded); this
        // raw message is the unmapped/diagnostic fallback and stays English.
        'The Git plugin is not loaded in this instance (host package missing or inactive). Restart the desktop for a local instance, or re-send the chamber host package in the connection settings and restart to apply for a remote instance.',
      )
    }
    // Every other carrier outcome (not-ready 503, other non-2xx, envelope or
    // rpcId failure, abort/timeout, network loss) keeps this client's existing
    // ambiguous classification: a mutation may have committed, so the saga must
    // retain its operation id for an idempotent replay. That includes the one
    // carrier-owner nuance: a 404 whose body carries the control plane's own
    // `instance_not_found` code is classified by the carrier as an
    // instance-layer transport fact (design 24 §5), NOT as domain missing —
    // adopting that classification is deliberate.
    throw new GitWorktreeRpcError('http-error', carrierFailureMessage(error))
  }
  if (transport.ok !== true) {
    // RPC-layer refusal (the Remote threw or the gateway rejected the payload):
    // the code is `rpc-failed`, and the classification (ambiguous → the
    // recovery keeps its operation id) applies.
    throw new GitWorktreeRpcError('rpc-failed', transport.error.message, transport.error.details)
  }
  // The host catches every known GitWorktreeError and returns a domain result
  // inside the carrier result. Only this inner error has stable domain codes
  // suitable for recovery decisions.
  const domain = transport.value
  if (typeof domain !== 'object' || domain === null || typeof (domain as { ok?: unknown }).ok !== 'boolean') {
    throw new GitWorktreeRpcError('invalid-domain-result', 'The Git Remote is missing the domain-result envelope')
  }
  const carrier = domain as { ok: boolean; value?: unknown; error?: unknown }
  if (carrier.ok !== true) {
    const error = carrier.error
    if (
      !isRecord(error)
      || typeof error.code !== 'string'
      || error.code === ''
      || typeof error.message !== 'string'
      || error.message === ''
      || (error.retryable !== undefined && typeof error.retryable !== 'boolean')
      || (error.details !== undefined && !isRecord(error.details))
    ) {
      throw new GitWorktreeRpcError('invalid-domain-result', 'The Git Remote domain error has an invalid shape')
    }
    throw new GitWorktreeRpcError(error.code, error.message, error.details, error.retryable)
  }
  return carrier.value
}

/** Stable text for a carrier transport failure (never a non-Error value). */
function carrierFailureMessage(error: unknown): string {
  if (error instanceof Error) return error.message === '' ? error.name : error.message
  try {
    return String(error)
  } catch {
    return 'Git Remote transport failure'
  }
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
