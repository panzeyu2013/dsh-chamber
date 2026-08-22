/**
 * Conservative Git worktree lifecycle core.
 *
 * TRUST BOUNDARY: callers arrive over the instance's host wire and are
 * untrusted JSON. They never provide a Git command. This module validates the
 * small business vocabulary, derives every argv array itself, invokes Git with
 * `shell: false`, and caps time and output. The allowlist exposes no network Git
 * verb, disables credential prompts/lazy fetch and disables hooks. A checkout
 * may still run clean/smudge/process filters configured by the repository; that
 * repo configuration and any subprocess/I/O it causes are part of the dsh OS
 * user's trusted boundary. This is intentionally a host plugin, never a
 * desktop/SSH command relay.
 */

import { createHash, randomUUID } from 'node:crypto'
import { access, lstat, mkdir, open, realpath } from 'node:fs/promises'
import { basename, isAbsolute, dirname, join, relative, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'

const READ_TIMEOUT_MS = 10_000
const MUTATION_TIMEOUT_MS = 30_000
const READ_OUTPUT_CAP = 1024 * 1024
const MUTATION_OUTPUT_CAP = 256 * 1024
export const PREVIEW_TTL_MS = 5 * 60_000
export const OPERATION_TTL_MS = 24 * 60 * 60_000
export const SNAPSHOT_DEADLINE_MS = 20_000
/** Discovery cache TTL (design 08 §11, OpenChamber parity): the per-workspace
 *  rev-parse and per-repository worktree-list/show-ref results are reused
 *  within this window when the workspace registry signature is unchanged, so
 *  unchanged sources skip the spawn storm on every 30s poll. Per-worktree
 *  STATUS (dirty) always runs fresh. Mutations clear the caches. */
const DISCOVERY_TTL_MS = 30_000
export const SNAPSHOT_WALL_TIMEOUT_MS = 25_000
export const MAX_WORKSPACES = 128
export const MAX_REPOSITORIES = 64
export const MAX_WORKTREES_PER_REPOSITORY = 128
export const MAX_TOTAL_WORKTREES = 256
const MAX_AGENTS = 4_096
const MAX_SESSIONS_PER_WORKSPACE = 4_096
export const MAX_TOTAL_SESSION_MEMBERSHIPS = 16_384
const SNAPSHOT_STATUS_TIMEOUT_MS = 1_500
const MAX_PATH_LENGTH = 4_096
const MAX_PREVIEWS = 512
export const MAX_OPERATIONS = 2_048

type MaybePromise<T> = T | Promise<T>

export interface WorkspaceFact {
  readonly workspaceId: string
  readonly path: string
  readonly sessionIds: readonly string[]
}

export interface AgentFact {
  readonly sessionId: string
  readonly status: 'idle' | 'running'
  readonly cwd?: string
}

export interface WorktreeStateSource {
  listWorkspaces(): MaybePromise<readonly WorkspaceFact[]>
  listAgents(): MaybePromise<readonly AgentFact[]>
}

export interface GitCommandRequest {
  readonly cwd: string
  readonly args: readonly string[]
  readonly timeoutMs: number
  readonly maxOutputBytes: number
}

export interface GitCommandResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export type GitRunner = (request: GitCommandRequest) => Promise<GitCommandResult>

export interface GitChildProcess {
  readonly stdout: { on(event: 'data', listener: (chunk: Buffer) => void): unknown }
  readonly stderr: { on(event: 'data', listener: (chunk: Buffer) => void): unknown }
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'close', listener: (code: number | null) => void): unknown
  kill(signal: NodeJS.Signals): boolean
}

export type GitSpawner = (
  command: string,
  args: string[],
  options: {
    readonly cwd: string
    readonly shell: false
    readonly stdio: readonly ['ignore', 'pipe', 'pipe']
    readonly windowsHide: true
    readonly env: NodeJS.ProcessEnv
  },
) => GitChildProcess

export interface WorktreeFileSystem {
  realpath(path: string): Promise<string>
  lstat(path: string): Promise<{ isDirectory(): boolean }>
  /** Recursive directory creation (the unified worktree root). */
  mkdir(path: string): Promise<void>
  /** True when `path` exists as a file or directory (git-dir state probes). */
  exists(path: string): Promise<boolean>
  /** Read a small UTF-8 file (the worktree `.git` pointer). Rejects when absent/unreadable. */
  readFile(path: string): Promise<string>
}

export interface GitWorktreeCoreOptions {
  readonly source: WorktreeStateSource
  readonly git?: GitRunner
  readonly fs?: WorktreeFileSystem
  readonly now?: () => number
  readonly token?: () => string
  /** Test seam; production retains the fixed MAX_OPERATIONS policy. */
  readonly operationCapacity?: number
  /** Test seam for the non-cancelling snapshot response deadline. */
  readonly snapshotWallTimeoutMs?: number
  /** Unified worktree root (design 08 §11): all chamber checkouts live under
   *  the dsh home (`$DSH_HOME/worktrees`, one subdirectory per repository) —
   *  outside any working tree so git status stays clean. Defaults from the
   *  instance's DSH_HOME (fallback: ~/.dsh). */
  readonly worktreesRoot?: string
}

export type CreateBranch =
  | { readonly kind: 'existing'; readonly name: string }
  | { readonly kind: 'new'; readonly name: string }

export interface PreviewCreateInput {
  readonly sourceWorkspaceId: string
  readonly basename: string
  readonly branch: CreateBranch
  /** Optional start point for a NEW branch (OpenChamber sourceBranch):
   *  the new branch is created from this local branch's head instead of the
   *  main checkout HEAD. Ignored for existing branches. */
  readonly startRef?: string
}

export interface PreviewCreateResult {
  readonly previewToken: string
  readonly expiresAt: number
  readonly repoId: string
  readonly commonDir: string
  readonly mainPath: string
  readonly targetPath: string
  readonly branch: string
  readonly baseHead: string
}

export interface CreateInput {
  readonly previewToken: string
  readonly operationId: string
}

export interface CreateResult {
  readonly operationId: string
  readonly created: true
  readonly replayed: boolean
  readonly repoId: string
  readonly worktreeId: string
  readonly commonDir: string
  readonly path: string
  readonly branch: string
  readonly head: string
  /** True only after this process observed `git worktree add` exit zero. */
  readonly rollbackAuthorized: boolean
  readonly branchCreated: boolean
}

export interface RollbackCreateInput {
  readonly operationId: string
}

export interface RollbackCreateResult {
  readonly operationId: string
  readonly removed: true
  readonly replayed: boolean
  readonly repoId: string
  readonly worktreeId: string
  readonly commonDir: string
  readonly path: string
  readonly branch: string
  readonly head: string
  readonly branchPreserved: true
}

export interface RemoveInput {
  readonly operationId: string
  /** Optional: an UNREGISTERED worktree (no dsh workspace) is removed with
   *  this absent — the git-first removal then returns `next: 'none'` and the
   *  client skips workspace.delete (design 08 §11, Plan A). */
  readonly workspaceId?: string
  /** Required when `workspaceId` is absent (UNREGISTERED removal): the exact
   *  worktree path — the workspace-based discovery cannot derive it. */
  readonly path?: string
  readonly expected: {
    readonly repoId: string
    readonly worktreeId: string
    readonly branch: string | null
    readonly head: string
  }
  /** Optional local branch to delete AFTER the worktree removal (design 08
   *  §11 user decision): best-effort — a failure is reported honestly on the
   *  result and never rolls back the (already gone) worktree. */
  readonly deleteBranch?: string
}

export interface RemoveResult {
  readonly operationId: string
  readonly removed: true
  readonly replayed: boolean
  /** Absent when the removed worktree was UNREGISTERED. */
  readonly workspaceId?: string
  readonly repoId: string
  readonly worktreeId: string
  readonly commonDir: string
  readonly path: string
  readonly branch: string | null
  readonly head: string
  /** Fresh membership captured immediately before Git-first removal. */
  readonly sessionIds: readonly string[]
  /** The caller may now delete only this durable workspace registration.
   *  'none' when the removed worktree was UNREGISTERED (no workspace). */
  readonly next: 'delete-workspace' | 'none'
  /** The host never deletes a branch on its own: `branchPreserved` means
   *  "preserved unless the caller explicitly requested deletion" — when
   *  `deleteBranch` was requested, the branchDelete* flags below report the
   *  outcome of that explicit best-effort step. */
  readonly branchPreserved: true
  /** Set when `deleteBranch` was requested and deleted successfully. */
  readonly branchDeleted?: boolean
  /** Set when `deleteBranch` was requested but the branch delete failed —
   *  the worktree removal still stands. */
  readonly branchDeleteFailed?: boolean
}

export interface SnapshotError {
  readonly code: string
  readonly operation: 'discover' | 'list' | 'status' | 'associate'
  readonly message: string
  readonly path?: string
  readonly workspaceId?: string
}

export type GitWorktreeState = 'ready' | 'missing' | 'invalid' | 'not-a-repo'

export type GitAttentionReason = 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect'

export interface SnapshotWorktree {
  readonly worktreeId: string
  readonly path: string
  readonly head: string
  readonly branch: string | null
  readonly isMain: boolean
  readonly dirty: boolean | null
  readonly locked: boolean
  /** Path/repository health: ready | missing | invalid | not-a-repo. */
  readonly status: GitWorktreeState
  /** Git HEAD classification: branch | detached | unborn. */
  readonly headState: 'branch' | 'detached' | 'unborn'
  /** Local-ref upstream facts from the status branch header (`## b...u [ahead
   *  N, behind M]`); null/0 when there is no upstream or the status failed. */
  readonly upstream: string | null
  readonly ahead: number
  readonly behind: number
  /** In-progress Git operations detected in the worktree git dir (best-effort). */
  readonly attention: readonly GitAttentionReason[]
  readonly workspaceId: string | null
  readonly sessionIds: readonly string[]
  readonly runningSessionIds: readonly string[]
}

export interface SnapshotRepository {
  readonly repoId: string
  readonly commonDir: string
  readonly mainPath: string
  readonly worktrees: readonly SnapshotWorktree[]
  /** Local branch names (`git show-ref --heads`); a convenience for the
   *  create dialog's existing-branch picker. Empty on failure — never a
   *  snapshot error. */
  readonly branches: readonly string[]
}

export interface SnapshotResult {
  readonly repos: readonly SnapshotRepository[]
  readonly errors: readonly SnapshotError[]
  readonly sourceError?: {
    readonly code: 'state-source-unavailable' | 'state-source-capacity'
      | 'git-unavailable' | 'snapshot-capacity' | 'snapshot-deadline'
    readonly message: string
  }
}

export interface GitWorktreeDomainError {
  readonly code: string
  readonly message: string
  readonly retryable?: boolean
  readonly details?: Readonly<Record<string, unknown>>
}

/** Explicit business carrier: the dsh gateway does not preserve thrown error fields. */
export type GitWorktreeDomainResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: GitWorktreeDomainError }

/** Stable action error code; Typert transports the Error message to clients. */
export class GitWorktreeError extends Error {
  readonly code: string
  readonly retryable?: boolean
  readonly details?: Readonly<Record<string, unknown>>

  constructor(
    code: string,
    message: string,
    options: {
      readonly retryable?: boolean
      readonly details?: Readonly<Record<string, unknown>>
    } = {},
  ) {
    super(message)
    this.name = 'GitWorktreeError'
    this.code = code
    this.retryable = options.retryable
    this.details = options.details
  }
}

const RETRYABLE_CODES = new Set([
  'git-timeout',
  'git-output-limit',
  'git-spawn-failed',
  'git-command-failed',
  'git-protocol-error',
  'path-unavailable',
  'path-check-failed',
  'postcondition-failed',
  'operation-busy',
  'state-source-unavailable',
  'state-source-invalid',
  'state-source-capacity',
  'snapshot-deadline',
  'workspace-path-unavailable',
  'running-agent-cwd-unavailable',
])

/** Convert only known domain failures; unexpected programming failures remain internal throws. */
export async function domainResult<T>(operation: () => Promise<T>): Promise<GitWorktreeDomainResult<T>> {
  try {
    return { ok: true, value: await operation() }
  } catch (error) {
    if (!(error instanceof GitWorktreeError)) throw error
    const retryable = error.retryable ?? RETRYABLE_CODES.has(error.code)
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        ...(retryable ? { retryable: true } : {}),
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    }
  }
}

const nodeFileSystem: WorktreeFileSystem = {
  realpath,
  lstat,
  mkdir: async path => { await mkdir(path, { recursive: true }) },
  exists: async path => {
    try {
      await access(path)
      return true
    } catch {
      return false
    }
  },
  // Bounded read: a hostile or corrupt `.git` pointer file must never be read
  // whole into memory (gitdir lines are tiny; nothing beyond the prefix is
  // used by worktreeGitDir's parse).
  readFile: async path => {
    const handle = await open(path, 'r')
    try {
      const buffer = Buffer.alloc(GIT_DIR_POINTER_MAX_BYTES)
      const { bytesRead } = await handle.read(buffer, 0, GIT_DIR_POINTER_MAX_BYTES, 0)
      return buffer.subarray(0, bytesRead).toString('utf8')
    } finally {
      await handle.close()
    }
  },
}

function fail(code: string, message: string): never {
  throw new GitWorktreeError(code, message)
}

function safeErrorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.replace(/[\r\n\t]+/g, ' ').slice(0, 512)
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('invalid-input', `${label} must be an object`)
  }
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const allowed = new Set(keys)
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail('invalid-input', `${label} contains unsupported field '${key}'`)
  }
  for (const key of keys) {
    if (!(key in value)) fail('invalid-input', `${label}.${key} is required`)
  }
}

function requiredString(value: unknown, label: string, max = 1024): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail('invalid-input', `${label} must be a non-empty bounded string without control characters`)
  }
  return value
}

function operationId(value: unknown): string {
  const id = requiredString(value, 'operationId', 128)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(id)) {
    fail('invalid-input', 'operationId contains unsupported characters')
  }
  return id
}

function previewToken(value: unknown): string {
  const token = requiredString(value, 'previewToken', 128)
  if (!/^[A-Za-z0-9-]+$/u.test(token)) fail('invalid-input', 'previewToken is malformed')
  return token
}

function safeBasename(value: unknown): string {
  const name = requiredString(value, 'basename', 255)
  if (name !== name.trim() || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    fail('unsafe-path', 'basename must be one trimmed path segment')
  }
  if (Buffer.byteLength(name, 'utf8') > 255) fail('unsafe-path', 'basename is too long')
  return name
}

function safeBranchName(value: unknown, label = 'branch.name'): string {
  const name = requiredString(value, label, 1024)
  if (name.startsWith('-') || name.startsWith('/') || name.endsWith('/') || name.includes('\\')) {
    fail('invalid-branch', `${label} is not a safe local branch name`)
  }
  return name
}

function absoluteExpectedPath(value: unknown, label: string): string {
  const path = requiredString(value, label, 4096)
  if (!isAbsolute(path) || resolve(path) !== path) {
    fail('unsafe-path', `${label} must be a normalized absolute path`)
  }
  return path
}

function objectFingerprint(value: unknown): string {
  return JSON.stringify(value)
}

function opaqueId(kind: 'repo' | 'worktree', ...parts: readonly string[]): string {
  const digest = createHash('sha256')
  digest.update(kind)
  for (const part of parts) {
    digest.update('\0')
    digest.update(part)
  }
  return `${kind}_${digest.digest('hex')}`
}

function expectedOpaqueId(value: unknown, kind: 'repo' | 'worktree'): string {
  const id = requiredString(value, `input.expected.${kind}Id`, 80)
  if (!new RegExp(`^${kind}_[0-9a-f]{64}$`, 'u').test(id)) {
    fail('invalid-input', `input.expected.${kind}Id is malformed`)
  }
  return id
}

function parsePreviewInput(value: PreviewCreateInput): PreviewCreateInput {
  assertRecord(value, 'input')
  // startRef is OPTIONAL (assertExactKeys requires presence, so the allowed
  // set + the required subset are checked inline, like deleteBranch in remove).
  {
    const allowed = new Set(['sourceWorkspaceId', 'basename', 'branch', 'startRef'])
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) fail('invalid-input', `input contains unsupported field '${key}'`)
    }
    for (const key of ['sourceWorkspaceId', 'basename', 'branch']) {
      if (!(key in value)) fail('invalid-input', `input.${key} is required`)
    }
  }
  const sourceWorkspaceId = requiredString(value.sourceWorkspaceId, 'sourceWorkspaceId', 256)
  const basename = safeBasename(value.basename)
  assertRecord(value.branch, 'input.branch')
  assertExactKeys(value.branch, ['kind', 'name'], 'input.branch')
  if (value.branch.kind !== 'existing' && value.branch.kind !== 'new') {
    fail('invalid-input', "input.branch.kind must be 'existing' or 'new'")
  }
  const name = safeBranchName(value.branch.name)
  return {
    sourceWorkspaceId,
    basename,
    branch: { kind: value.branch.kind, name },
    // Same validation as the branch name: a control character or leading
    // dash must never reach the localBranchHead argv (the allowlist would
    // reject a leading dash, but input-layer validation is fail-closed).
    ...(value.startRef === undefined ? {} : { startRef: safeBranchName(value.startRef, 'input.startRef') }),
  }
}

function parseCreateInput(value: CreateInput): CreateInput {
  assertRecord(value, 'input')
  assertExactKeys(value, ['previewToken', 'operationId'], 'input')
  return { previewToken: previewToken(value.previewToken), operationId: operationId(value.operationId) }
}

function parseRollbackInput(value: RollbackCreateInput): RollbackCreateInput {
  assertRecord(value, 'input')
  assertExactKeys(value, ['operationId'], 'input')
  return { operationId: operationId(value.operationId) }
}

function parseRemoveInput(value: RemoveInput): RemoveInput {
  assertRecord(value, 'input')
  // deleteBranch is OPTIONAL (assertExactKeys requires presence, so the
  // allowed set + the required subset are checked inline).
  {
    const allowed = new Set(['operationId', 'workspaceId', 'path', 'expected', 'deleteBranch'])
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) fail('invalid-input', `input contains unsupported field '${key}'`)
    }
    for (const key of ['operationId', 'expected']) {
      if (!(key in value)) fail('invalid-input', `input.${key} is required`)
    }
  }
  assertRecord(value.expected, 'input.expected')
  assertExactKeys(value.expected, ['repoId', 'worktreeId', 'branch', 'head'], 'input.expected')
  const head = requiredString(value.expected.head, 'input.expected.head', 128)
  if (!/^[0-9a-fA-F]{40,64}$/u.test(head)) fail('invalid-input', 'input.expected.head is not an object id')
  return {
    operationId: operationId(value.operationId),
    workspaceId: value.workspaceId === undefined
      ? undefined
      : requiredString(value.workspaceId, 'workspaceId', 256),
    expected: {
      repoId: expectedOpaqueId(value.expected.repoId, 'repo'),
      worktreeId: expectedOpaqueId(value.expected.worktreeId, 'worktree'),
      branch: value.expected.branch === null
        ? null
        : safeBranchName(value.expected.branch, 'input.expected.branch'),
      head: head.toLowerCase(),
    },
    deleteBranch: value.deleteBranch === undefined
      ? undefined
      : safeBranchName(value.deleteBranch, 'input.deleteBranch'),
    path: value.path === undefined
      ? undefined
      : (value.workspaceId !== undefined
          ? fail('invalid-input', "input.path and input.workspaceId are mutually exclusive")
          : absoluteExpectedPath(value.path, 'input.path')),
  }
}

function sameArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function sameMembership(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  return sameArray([...left].sort(), [...right].sort())
}

/**
 * Defense in depth for the injected/default runner boundary. Any new Git
 * capability must be reviewed and added as an exact grammar here; network
 * verbs, arbitrary config, shell fragments, and caller-shaped flags cannot
 * pass through accidentally.
 */
export function assertSafeGitArgv(args: readonly string[]): void {
  const [verb, ...rest] = args
  const allStrings = args.every(arg => typeof arg === 'string' && !arg.includes('\0'))
  if (!allStrings) fail('unsafe-git-argv', 'Git argv contains a non-string or NUL')

  const exact = (...expected: string[]) => sameArray(rest, expected)
  if (verb === 'rev-parse' && (exact('--show-toplevel') || exact('--path-format=absolute', '--git-common-dir'))) return
  if (verb === 'check-ref-format' && rest.length === 2 && rest[0] === '--branch' && !rest[1]!.startsWith('-')) return
  if (verb === 'show-ref' && rest.length === 3 && rest[0] === '--hash' && rest[1] === '--verify'
    && rest[2]!.startsWith('refs/heads/') && !rest[2]!.slice('refs/heads/'.length).startsWith('-')) return
  // Branch enumeration for the create dialog's existing-branch picker: a
  // fixed flag only, no user input in argv.
  if (verb === 'show-ref' && exact('--heads')) return
  // Optional branch deletion after worktree removal (design 08 §11 user
  // decision): fixed flags + a validated local branch name (no leading dash).
  if (verb === 'branch' && rest.length === 2 && rest[0] === '-D'
    && !rest[1]!.startsWith('-') && !rest[1]!.startsWith('/')) return
  if (verb === 'status' && exact('--porcelain=v1', '-z', '--untracked-files=normal')) return
  // Snapshot status with the branch header: local-ref upstream/ahead/behind
  // facts (no network verb — the numbers reflect local refs only).
  if (verb === 'status' && exact('--porcelain=v1', '-z', '--branch', '--untracked-files=normal')) return
  if (verb === 'worktree' && exact('list', '--porcelain', '-z')) return
  // Newline-delimited --porcelain fallback (Git < 2.47, which predates `-z`).
  if (verb === 'worktree' && exact('list', '--porcelain')) return
  if (verb === 'worktree' && rest.length === 4 && rest[0] === 'add' && rest[1] === '--'
    && isAbsolute(rest[2]!) && !rest[3]!.startsWith('-')) return
  if (verb === 'worktree' && rest.length === 6 && rest[0] === 'add' && rest[1] === '-b'
    && !rest[2]!.startsWith('-') && rest[3] === '--' && isAbsolute(rest[4]!)
    && /^[0-9a-fA-F]{40,64}$/u.test(rest[5]!)) return
  if (verb === 'worktree' && rest.length === 3 && rest[0] === 'remove' && rest[1] === '--'
    && isAbsolute(rest[2]!)) return

  fail('unsafe-git-argv', `Git command '${verb ?? '<empty>'}' is outside the worktree allowlist`)
}

/** Default bounded, shell-free local Git runner. */
export function createLocalGitRunner(spawnGit: GitSpawner = spawn as unknown as GitSpawner): GitRunner {
  return request => new Promise<GitCommandResult>((resolvePromise, rejectPromise) => {
    try {
      if (!isAbsolute(request.cwd)) fail('unsafe-git-cwd', 'Git cwd must be absolute')
      if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > 60_000) {
        fail('unsafe-git-limit', 'Git timeout is outside the supported range')
      }
      if (!Number.isSafeInteger(request.maxOutputBytes) || request.maxOutputBytes < 1
        || request.maxOutputBytes > 4 * 1024 * 1024) {
        fail('unsafe-git-limit', 'Git output cap is outside the supported range')
      }
      assertSafeGitArgv(request.args)
    } catch (error) {
      rejectPromise(error)
      return
    }

    // Ambient GIT_DIR/GIT_WORK_TREE/etc. must not redirect an operation away
    // from the freshly validated cwd. Retain the ordinary process environment
    // but rebuild Git-specific variables from this gateway's policy. Required
    // mutation locks remain available: GIT_OPTIONAL_LOCKS only suppresses locks
    // Git itself documents as optional for read-mostly commands.
    const environment = { ...process.env }
    for (const key of Object.keys(environment)) {
      if (key.startsWith('GIT_')) delete environment[key]
    }
    Object.assign(environment, {
      GIT_TERMINAL_PROMPT: '0',
      GIT_NO_LAZY_FETCH: '1',
      GIT_OPTIONAL_LOCKS: '0',
      // `worktree add` normally runs post-checkout. A wire lifecycle action
      // must not become a caller-triggered hook execution surface. This does
      // not disable repository-configured clean/smudge/process filters: those
      // remain inside the host OS user's trusted repository-config boundary.
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: process.platform === 'win32' ? 'NUL' : '/dev/null',
      GCM_INTERACTIVE: 'never',
      LC_ALL: 'C',
    })

    let child: GitChildProcess
    try {
      child = spawnGit('git', [...request.args], {
        cwd: request.cwd,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: environment,
      })
    } catch (error) {
      rejectPromise(new GitWorktreeError('git-spawn-failed', safeErrorMessage(error)))
      return
    }
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let bytes = 0
    let settled = false
    let terminationError: unknown
    let timer: NodeJS.Timeout | undefined

    const rejectImmediately = (error: unknown): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      rejectPromise(error)
    }
    const terminateThenReject = (error: unknown): void => {
      if (settled || terminationError !== undefined) return
      terminationError = error
      if (timer !== undefined) clearTimeout(timer)
      // Do not release the caller's common-dir mutex until close proves the
      // Git process exited. Repository filters may have descendants which Git
      // cannot portably process-group-kill; that remains a trusted-config edge,
      // but overlapping a second chamber mutation with the parent is avoidable.
      try {
        child.kill('SIGKILL')
      } catch {
        // Keep waiting for close: releasing the repo lock while the process may
        // still run is less safe than retaining an uncertain operation.
      }
    }
    const append = (target: Buffer[], chunk: Buffer): void => {
      if (settled || terminationError !== undefined) return
      bytes += chunk.byteLength
      if (bytes > request.maxOutputBytes) {
        terminateThenReject(new GitWorktreeError('git-output-limit', 'Git output exceeded the bounded response limit'))
        return
      }
      target.push(chunk)
    }
    child.stdout.on('data', (chunk: Buffer) => append(stdout, chunk))
    child.stderr.on('data', (chunk: Buffer) => append(stderr, chunk))
    // A spawn error may not be followed by close, and proves no Git operation
    // was admitted, so it is the sole immediate-rejection path.
    child.on('error', (error) => {
      if (terminationError !== undefined) return
      rejectImmediately(new GitWorktreeError('git-spawn-failed', safeErrorMessage(error)))
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      if (terminationError !== undefined) {
        rejectPromise(terminationError)
        return
      }
      resolvePromise({
        exitCode: code ?? -1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      })
    })
    timer = setTimeout(() => {
      terminateThenReject(new GitWorktreeError('git-timeout', `Git command exceeded ${request.timeoutMs}ms`))
    }, request.timeoutMs)
    timer.unref()
  })
}

interface SourceSnapshot {
  readonly workspaces: readonly WorkspaceFact[]
  readonly runningSessionIds: ReadonlySet<string>
  readonly runningAgents: readonly AgentFact[]
}

interface SnapshotRunningLocation {
  readonly sessionId: string
  readonly paths: readonly string[]
}

interface RawWorktree {
  path: string
  head: string
  branch: string | null
  locked: boolean
  prunable: boolean
  bare: boolean
}

interface WorktreeTopology {
  readonly commonDir: string
  readonly mainPath: string
  readonly worktrees: readonly RawWorktree[]
}

interface PreviewRecord extends PreviewCreateResult {
  readonly branchMode: CreateBranch['kind']
  /** The chosen start point for a NEW branch (undefined = main checkout HEAD). */
  readonly startRef?: string
  readonly sourceWorkspaceId: string
  readonly basename: string
  readonly createdAt: number
}

interface CreatedFacts {
  readonly repoId: string
  readonly worktreeId: string
  readonly commonDir: string
  readonly mainPath: string
  readonly path: string
  readonly branch: string
  readonly head: string
  readonly branchCreated: boolean
}

interface CreateOperationRecord {
  readonly previewToken: string
  readonly preview: PreviewRecord
  state: 'ready' | 'creating' | 'uncertain' | 'created'
    | 'rolling-back' | 'rollback-uncertain' | 'rolled-back'
  updatedAt: number
  attemptedCreate: boolean
  /** Provenance boundary: only an observed zero exit may authorize rollback. */
  gitAccepted: boolean
  attemptedRollback: boolean
  createPromise?: Promise<CreateResult>
  createResult?: CreateResult
  facts?: CreatedFacts
  rollbackPromise?: Promise<RollbackCreateResult>
  rollbackResult?: RollbackCreateResult
}

interface RemoveIntent {
  /** Absent for an UNREGISTERED worktree removal (next: 'none'). */
  readonly workspaceId?: string
  /** Exact normalized registry path captured before the first mutation. */
  readonly workspacePath?: string
  readonly repoId: string
  readonly worktreeId: string
  readonly commonDir: string
  readonly mainPath: string
  readonly path: string
  readonly branch: string | null
  readonly head: string
  readonly sessionIds: readonly string[]

  /** Optional local branch to delete after removal (design 08 §11). */
  readonly deleteBranch?: string
  branchDeleted?: boolean
  branchDeleteFailed?: boolean
}

interface RemoveOperationRecord {
  readonly fingerprint: string
  state: 'ready' | 'removing' | 'uncertain' | 'removed'
  updatedAt: number
  attemptedRemove: boolean
  /** Optional branch delete was attempted once (design 08 §11). */
  branchDeleteAttempted: boolean
  intent?: RemoveIntent
  promise?: Promise<RemoveResult>
  result?: RemoveResult
}

class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>()

  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>(resolvePromise => { release = resolvePromise })
    const tail = previous.then(() => current)
    this.tails.set(key, tail)
    await previous
    try {
      return await operation()
    } finally {
      release()
      if (this.tails.get(key) === tail) this.tails.delete(key)
    }
  }
}

/** Parse the `--branch` status header (`## branch...upstream [ahead N, behind
 *  M]`). The numbers come from LOCAL refs — honest, never fetched. */
export function parseBranchLine(line: string): { upstream: string | null; ahead: number; behind: number } {
  if (!line.startsWith('## ')) return { upstream: null, ahead: 0, behind: 0 }
  const rest = line.slice(3)
  let ahead = 0
  let behind = 0
  const bracket = rest.lastIndexOf(' [')
  const namePart = bracket >= 0 ? rest.slice(0, bracket) : rest
  if (bracket >= 0) {
    const meta = rest.slice(bracket + 2, rest.length - 1)
    const aheadMatch = /ahead (\d+)/u.exec(meta)
    const behindMatch = /behind (\d+)/u.exec(meta)
    if (aheadMatch !== null) ahead = Number(aheadMatch[1])
    if (behindMatch !== null) behind = Number(behindMatch[1])
  }
  // Git rejects ref names containing '..', so '...' cannot appear inside a
  // branch name — the separator is unambiguous (review P3-2; do not "fix").
  const sep = namePart.indexOf('...')
  return {
    upstream: sep >= 0 ? (namePart.slice(sep + 3) || null) : null,
    ahead,
    behind,
  }
}

/**
 * Parse `git worktree list --porcelain` output in either NUL-delimited
 * (`-z`, Git 2.47+) or newline-delimited form. The record grammar is
 * identical across both: fields are delimiter-separated and a blank field
 * closes the current record.
 */
function parseWorktreePorcelain(output: string, delimiter: '\0' | '\n' = '\0'): RawWorktree[] {
  const records: RawWorktree[] = []
  let current: RawWorktree | undefined
  const flush = (): void => {
    if (current === undefined) return
    if (current.path.length === 0 || current.path.length > MAX_PATH_LENGTH
      || /[\0\r\n]/u.test(current.path) || !isAbsolute(current.path)) {
      fail('git-protocol-error', 'Git returned an invalid or overlong worktree path')
    }
    if (!/^[0-9a-fA-F]{40,64}$/u.test(current.head)) fail('git-protocol-error', 'Git returned an invalid worktree HEAD')
    current.head = current.head.toLowerCase()
    records.push(current)
    current = undefined
  }

  for (const field of output.split(delimiter)) {
    if (field === '') {
      flush()
      continue
    }
    if (field.startsWith('worktree ')) {
      flush()
      current = {
        path: field.slice('worktree '.length),
        head: '',
        branch: null,
        locked: false,
        prunable: false,
        bare: false,
      }
      continue
    }
    if (current === undefined) fail('git-protocol-error', 'Git worktree output did not begin with a worktree field')
    if (field.startsWith('HEAD ')) current.head = field.slice('HEAD '.length)
    else if (field.startsWith('branch refs/heads/')) current.branch = field.slice('branch refs/heads/'.length)
    else if (field === 'locked' || field.startsWith('locked ')) current.locked = true
    else if (field === 'prunable' || field.startsWith('prunable ')) current.prunable = true
    else if (field === 'bare') current.bare = true
    else if (field === 'detached') current.branch = null
  }
  flush()
  if (records.length === 0) fail('git-protocol-error', 'Git returned no worktrees')
  return records
}

const ZERO_HEAD = /^0+$/u

/** Bounded read for the worktree `.git` pointer; gitdir lines are tiny. */
const GIT_DIR_POINTER_MAX_BYTES = 4096

/** git-dir state files that mark an in-progress Git operation (best-effort). */
const ATTENTION_PROBES: ReadonlyArray<{ readonly name: string; readonly reason: GitAttentionReason }> = [
  { name: 'MERGE_HEAD', reason: 'merge' },
  { name: 'REBASE_HEAD', reason: 'rebase' },
  { name: 'rebase-merge', reason: 'rebase' },
  { name: 'rebase-apply', reason: 'rebase' },
  { name: 'CHERRY_PICK_HEAD', reason: 'cherry-pick' },
  { name: 'REVERT_HEAD', reason: 'revert' },
  { name: 'BISECT_LOG', reason: 'bisect' },
]

function isNotARepositoryError(error: unknown): boolean {
  return error instanceof GitWorktreeError && /not a git repository/i.test(error.message)
}

/**
 * The worktree's git dir: `<path>/.git` when it is a directory (main
 * checkout), otherwise the target of its `gitdir:` pointer file (linked
 * worktrees). Resolved against the worktree path when relative.
 */
async function worktreeGitDir(path: string, fs: WorktreeFileSystem): Promise<string | null> {
  const dotGit = join(path, '.git')
  try {
    const stat = await fs.lstat(dotGit)
    if (stat.isDirectory()) return dotGit
  } catch {
    // fall through to the pointer-file read
  }
  try {
    const pointer = (await fs.readFile(dotGit)).slice(0, GIT_DIR_POINTER_MAX_BYTES)
    const match = /^gitdir:\s*(.+)$/u.exec(pointer.trim())
    if (match === null) return null
    const target = match[1]!.trim()
    return isAbsolute(target) ? target : resolve(path, target)
  } catch {
    return null
  }
}

/** Best-effort in-progress operation detection; failures yield no attention. */
async function detectAttention(
  gitDir: string,
  fs: WorktreeFileSystem,
  withinBudget: () => boolean,
): Promise<GitAttentionReason[]> {
  const found: GitAttentionReason[] = []
  for (const probe of ATTENTION_PROBES) {
    if (!withinBudget()) break
    if (await fs.exists(join(gitDir, probe.name))) found.push(probe.reason)
  }
  return [...new Set(found)]
}

/** Host-independent lifecycle implementation; tests inject both Git and state. */
export class GitWorktreeCore {
  private readonly source: WorktreeStateSource
  private readonly git: GitRunner
  private readonly fs: WorktreeFileSystem
  private readonly now: () => number
  private readonly nextToken: () => string
  private readonly operationCapacity: number
  private readonly snapshotWallTimeoutMs: number
  private readonly worktreesRoot: string
  private readonly mutex = new KeyedMutex()
  private readonly previews = new Map<string, PreviewRecord>()
  private readonly createOperations = new Map<string, CreateOperationRecord>()
  private readonly removeOperations = new Map<string, RemoveOperationRecord>()
  private readonly workspaceDiscoverCache = new Map<string, { commonDir: string; topLevel: string; at: number }>()
  private readonly repoTopologyCache = new Map<string, {
    listedRaw: readonly RawWorktree[]
    branches: readonly string[]
    at: number
  }>()
  private lastWorkspaceSignature = ''
  private snapshotInFlight?: Promise<SnapshotResult>

  constructor(options: GitWorktreeCoreOptions) {
    this.source = options.source
    this.git = options.git ?? createLocalGitRunner()
    this.fs = options.fs ?? nodeFileSystem
    this.now = options.now ?? Date.now
    this.nextToken = options.token ?? randomUUID
    this.operationCapacity = options.operationCapacity ?? MAX_OPERATIONS
    if (!Number.isSafeInteger(this.operationCapacity)
      || this.operationCapacity < 1
      || this.operationCapacity > MAX_OPERATIONS) {
      fail('invalid-core-option', `operationCapacity must be between 1 and ${MAX_OPERATIONS}`)
    }
    this.snapshotWallTimeoutMs = options.snapshotWallTimeoutMs ?? SNAPSHOT_WALL_TIMEOUT_MS
    const worktreesRoot = options.worktreesRoot ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'worktrees')
    if (!isAbsolute(worktreesRoot)) {
      fail('invalid-config', 'worktreesRoot must be an absolute path')
    }
    this.worktreesRoot = worktreesRoot
    if (!Number.isSafeInteger(this.snapshotWallTimeoutMs)
      || this.snapshotWallTimeoutMs < 1
      || this.snapshotWallTimeoutMs > SNAPSHOT_WALL_TIMEOUT_MS) {
      fail('invalid-core-option', `snapshotWallTimeoutMs must be between 1 and ${SNAPSHOT_WALL_TIMEOUT_MS}`)
    }
  }

  /** Coalesce overlapping polls so a slow old snapshot cannot pile up behind the next tick. */
  snapshot(): Promise<SnapshotResult> {
    if (this.snapshotInFlight !== undefined) return this.snapshotInFlight
    const scan = this.collectSnapshot()
    let timer: NodeJS.Timeout
    const responseDeadline = new Promise<SnapshotResult>((resolvePromise) => {
      timer = setTimeout(() => resolvePromise({
        repos: [],
        errors: [],
        sourceError: {
          code: 'snapshot-deadline',
          message: `snapshot did not settle within ${this.snapshotWallTimeoutMs}ms; the old scan remains single-flight`,
        },
      }), this.snapshotWallTimeoutMs)
      // NOT unref'd on purpose: an uncancellable hung scan is kept observable by
      // this deadline timer, which is the only handle that guarantees the
      // single-flight settles. Unref'ing lets a quiet process drain before the
      // deadline fires, turning a bounded response into a leaked promise.
    })
    const response = Promise.race([scan, responseDeadline])
    this.snapshotInFlight = response
    const clear = (): void => {
      clearTimeout(timer)
      // A timed-out filesystem/state read cannot be cancelled safely. Retain
      // its settled deadline response as the single-flight value until the old
      // scan actually exits, so later polls never start overlapping scans.
      if (this.snapshotInFlight === response) this.snapshotInFlight = undefined
    }
    void scan.then(clear, clear)
    return response
  }

  /** Best-effort per-repository projection. State-source failure is not an empty snapshot. */
  private async collectSnapshot(): Promise<SnapshotResult> {
    const deadline = this.now() + SNAPSHOT_DEADLINE_MS
    let state: SourceSnapshot
    try {
      state = await this.readSource()
    } catch (error) {
      const code = error instanceof GitWorktreeError && error.code === 'state-source-capacity'
        ? 'state-source-capacity'
        : 'state-source-unavailable'
      return {
        repos: [],
        errors: [],
        sourceError: { code, message: safeErrorMessage(error) },
      }
    }

    const errors: SnapshotError[] = []
    let sourceError: SnapshotResult['sourceError']
    // Registry-change invalidation: any workspace id/path change clears the
    // discovery caches so new/adopted workspaces are always discovered.
    const signature = state.workspaces.map(workspace => `${workspace.workspaceId}:${workspace.path}`).sort().join('|')
    if (signature !== this.lastWorkspaceSignature) {
      this.clearDiscoveryCaches()
      this.lastWorkspaceSignature = signature
    }
    const canonicalWorkspaces: Array<WorkspaceFact & { canonicalPath: string }> = []
    for (const workspace of state.workspaces) {
      if (this.now() >= deadline) {
        sourceError = {
          code: 'snapshot-deadline',
          message: `snapshot exceeded its ${SNAPSHOT_DEADLINE_MS}ms probe budget during workspace association`,
        }
        break
      }
      try {
        canonicalWorkspaces.push({ ...workspace, canonicalPath: await this.existingPath(workspace.path) })
      } catch (error) {
        errors.push({
          code: error instanceof GitWorktreeError ? error.code : 'workspace-path-failed',
          operation: 'discover',
          message: safeErrorMessage(error),
          path: workspace.path,
          workspaceId: workspace.workspaceId,
        })
      }
    }
    const runningLocationsResult = await this.snapshotRunningLocations(state, deadline, errors)
    const runningLocations = runningLocationsResult.locations
    if (runningLocationsResult.deadlineExceeded) {
      sourceError ??= {
        code: 'snapshot-deadline',
        message: `snapshot exceeded its ${SNAPSHOT_DEADLINE_MS}ms probe budget during agent association`,
      }
    }

    const groups = new Map<string, { cwd: string; workspaces: Array<WorkspaceFact & { canonicalPath: string }> }>()
    let gitSpawnFailures = 0
    for (const workspace of canonicalWorkspaces) {
      try {
        let discovered: { commonDir: string; topLevel: string }
        const cachedDiscover = this.workspaceDiscoverCache.get(workspace.canonicalPath)
        if (cachedDiscover !== undefined && this.now() - cachedDiscover.at < DISCOVERY_TTL_MS) {
          discovered = { commonDir: cachedDiscover.commonDir, topLevel: cachedDiscover.topLevel }
        } else {
          discovered = await this.snapshotDiscover(workspace.canonicalPath, deadline)
          this.workspaceDiscoverCache.set(workspace.canonicalPath, { ...discovered, at: this.now() })
        }
        const group = groups.get(discovered.commonDir)
        if (group === undefined) {
          if (groups.size >= MAX_REPOSITORIES) {
            errors.push({
              code: 'snapshot-repository-limit',
              operation: 'discover',
              message: `snapshot exceeded the ${MAX_REPOSITORIES} repository limit`,
              path: workspace.path,
              workspaceId: workspace.workspaceId,
            })
            sourceError = {
              code: 'snapshot-capacity',
              message: `snapshot stopped after ${MAX_REPOSITORIES} repositories`,
            }
            break
          }
          groups.set(discovered.commonDir, { cwd: discovered.topLevel, workspaces: [workspace] })
        } else {
          group.workspaces.push(workspace)
        }
      } catch (error) {
        if (error instanceof GitWorktreeError && error.code === 'git-spawn-failed') {
          gitSpawnFailures += 1
        }
        errors.push({
          code: error instanceof GitWorktreeError ? error.code : 'git-discovery-failed',
          operation: 'discover',
          message: safeErrorMessage(error),
          path: workspace.path,
          workspaceId: workspace.workspaceId,
        })
        if (error instanceof GitWorktreeError && error.code === 'snapshot-deadline') {
          sourceError = { code: 'snapshot-deadline', message: error.message }
          break
        }
      }
    }

    // Git executable absence belongs to the whole dsh source, not to every
    // workspace row. Do not probe with a broader `git --version` command: only
    // promote when every real workspace discovery failed at the spawn boundary.
    // A normal non-Git workspace fails later as `git-command-failed` and must
    // remain a local error rather than poisoning the source.
    if (canonicalWorkspaces.length > 0
      && groups.size === 0
      && gitSpawnFailures === canonicalWorkspaces.length) {
      return {
        repos: [],
        errors,
        sourceError: {
          code: 'git-unavailable',
          message: 'Git executable is unavailable for this dsh instance',
        },
      }
    }

    const repos: SnapshotRepository[] = []
    let remainingWorktrees = MAX_TOTAL_WORKTREES
    for (const [commonDir, group] of groups) {
      if (remainingWorktrees === 0) {
        errors.push({
          code: 'snapshot-total-worktree-limit',
          operation: 'list',
          message: `snapshot stopped after ${MAX_TOTAL_WORKTREES} worktrees`,
          path: group.cwd,
        })
        sourceError ??= {
          code: 'snapshot-capacity',
          message: `snapshot stopped after ${MAX_TOTAL_WORKTREES} total worktrees`,
        }
        break
      }
      try {
        let raw: readonly RawWorktree[]
        let branches: readonly string[]
        const cachedTopology = this.repoTopologyCache.get(commonDir)
        if (cachedTopology !== undefined && this.now() - cachedTopology.at < DISCOVERY_TTL_MS) {
          raw = cachedTopology.listedRaw
          branches = cachedTopology.branches
        } else {
          raw = await this.listWorktrees(group.cwd, deadline)
          branches = await this.listBranches(group.cwd, deadline)
          this.repoTopologyCache.set(commonDir, { listedRaw: raw, branches, at: this.now() })
        }
        if (raw.length > MAX_WORKTREES_PER_REPOSITORY) {
          errors.push({
            code: 'snapshot-worktree-limit',
            operation: 'list',
            message: `repository exceeds the ${MAX_WORKTREES_PER_REPOSITORY} worktree snapshot limit`,
            path: group.cwd,
          })
          sourceError ??= {
            code: 'snapshot-capacity',
            message: 'one or more repositories exceeded the worktree snapshot limit',
          }
        }
        const perRepository = Math.min(raw.length, MAX_WORKTREES_PER_REPOSITORY)
        const allowedWorktrees = Math.min(perRepository, remainingWorktrees)
        if (perRepository > remainingWorktrees) {
          errors.push({
            code: 'snapshot-total-worktree-limit',
            operation: 'list',
            message: `snapshot stopped after ${MAX_TOTAL_WORKTREES} total worktrees`,
            path: group.cwd,
          })
          sourceError ??= {
            code: 'snapshot-capacity',
            message: `snapshot stopped after ${MAX_TOTAL_WORKTREES} total worktrees`,
          }
        }
        const worktrees: SnapshotWorktree[] = []
        const associated = new Set<string>()
        let statusDeadlineReported = false

        const boundedRaw = raw.slice(0, allowedWorktrees)
        remainingWorktrees -= boundedRaw.length
        for (let index = 0; index < boundedRaw.length; index += 1) {
          const entry = boundedRaw[index]!
          let path = resolve(entry.path)
          let pathAvailable = false
          if (this.now() < deadline) {
            try {
              path = await this.existingPath(entry.path)
              pathAvailable = true
            } catch (error) {
              errors.push({
                code: error instanceof GitWorktreeError ? error.code : 'worktree-path-failed',
                operation: 'list',
                message: safeErrorMessage(error),
                path: entry.path,
              })
            }
          } else if (!statusDeadlineReported) {
            statusDeadlineReported = true
            sourceError ??= {
              code: 'snapshot-deadline',
              message: `snapshot exceeded its ${SNAPSHOT_DEADLINE_MS}ms probe budget`,
            }
            errors.push({
              code: 'snapshot-deadline',
              operation: 'associate',
              message: 'remaining filesystem and dirty associations were skipped after the snapshot deadline',
              path,
            })
          }

          const matches = group.workspaces.filter(workspace => workspace.canonicalPath === path)
          if (matches.length > 1) {
            errors.push({
              code: 'duplicate-workspace-path',
              operation: 'associate',
              message: `multiple workspace records own '${path}'`,
              path,
            })
          }
          let workspace: WorkspaceFact | undefined = matches[0]
          if (workspace === undefined && pathAvailable === false) {
            // A worktree whose directory no longer exists (externally deleted
            // worktree with surviving git metadata) cannot canonical-match —
            // the workspace at that path also failed realpath and is NOT in
            // the canonical group. Fall back to a RAW registry-path
            // comparison so the orphan stays associated with its workspace
            // row instead of leaking into the unregistered block
            // (cross-review P1-1: it would otherwise show twice — as an
            // orphan workspace AND as an unregistered 'missing' row — and the
            // badge delete could not converge).
            workspace = state.workspaces.find(candidate => candidate.path === entry.path)
          }
          if (workspace !== undefined) associated.add(workspace.workspaceId)

          let dirty: boolean | null = null
          let upstream: string | null = null
          let ahead = 0
          let behind = 0
          let statusUnhealthy: Extract<GitWorktreeState, 'not-a-repo' | 'invalid'> | null = null
          if (pathAvailable && !entry.bare) {
            if (this.now() >= deadline) {
              if (!statusDeadlineReported) {
                statusDeadlineReported = true
                sourceError ??= {
                  code: 'snapshot-deadline',
                  message: `snapshot exceeded its ${SNAPSHOT_DEADLINE_MS}ms Git probe budget`,
                }
                errors.push({
                  code: 'snapshot-deadline',
                  operation: 'status',
                  message: 'remaining dirty checks were skipped after the snapshot deadline',
                  path,
                  ...(workspace === undefined ? {} : { workspaceId: workspace.workspaceId }),
                })
              }
            } else {
              try {
                const statusOutput = (await this.snapshotGitChecked(path, [
                  'status', '--porcelain=v1', '-z', '--branch', '--untracked-files=normal',
                ], deadline, SNAPSHOT_STATUS_TIMEOUT_MS)).stdout
                // With --branch the first NUL-terminated field is the header;
                // anything after it is a real porcelain entry (dirty).
                const nul = statusOutput.indexOf('\0')
                const headerLine = nul >= 0 ? statusOutput.slice(0, nul) : statusOutput
                // INVARIANT: `--branch` always emits the header NUL-terminated
                // (verified against git 2.50.1: clean = `## main\0`). A
                // header without a trailing NUL is therefore treated as clean
                // (a lone bare header), never dirty — fail in the safe
                // direction (review P2-1).
                dirty = nul >= 0 && statusOutput.length > nul + 1
                const branchFacts = parseBranchLine(headerLine)
                upstream = branchFacts.upstream
                ahead = branchFacts.ahead
                behind = branchFacts.behind
              } catch (error) {
                if (error instanceof GitWorktreeError && error.code === 'snapshot-deadline') {
                  statusDeadlineReported = true
                  sourceError ??= { code: 'snapshot-deadline', message: error.message }
                }
                errors.push({
                  code: error instanceof GitWorktreeError ? error.code : 'git-status-failed',
                  operation: 'status',
                  message: safeErrorMessage(error),
                  path,
                  ...(workspace === undefined ? {} : { workspaceId: workspace.workspaceId }),
                })
                statusUnhealthy = isNotARepositoryError(error) ? 'not-a-repo' : 'invalid'
              }
            }
          }

          const status: GitWorktreeState = !pathAvailable
            ? 'missing'
            : statusUnhealthy ?? 'ready'
          const headState: 'branch' | 'detached' | 'unborn' = entry.branch === null
            ? 'detached'
            : ZERO_HEAD.test(entry.head)
              ? 'unborn'
              : 'branch'
          let attention: GitAttentionReason[] = []
          if (pathAvailable && !entry.bare && this.now() < deadline) {
            try {
              const gitDir = await worktreeGitDir(path, this.fs)
              if (gitDir !== null) {
                attention = await detectAttention(gitDir, this.fs, () => this.now() < deadline)
              }
            } catch {
              // Attention is best-effort; a probe failure must not fail the row.
            }
          }

          const sessionIds = workspace === undefined ? [] : [...workspace.sessionIds]
          const runningSessionIds = sessionIds.filter(id => state.runningSessionIds.has(id))
          for (const id of this.runningAtSnapshotPath(path, runningLocations)) {
            if (!runningSessionIds.includes(id)) runningSessionIds.push(id)
          }
          worktrees.push({
            worktreeId: opaqueId('worktree', commonDir, path),
            path,
            head: entry.head,
            branch: entry.branch,
            isMain: index === 0,
            dirty,
            locked: entry.locked,
            status,
            headState,
            upstream,
            ahead,
            behind,
            attention,
            workspaceId: workspace?.workspaceId ?? null,
            sessionIds,
            runningSessionIds,
          })
        }

        for (const workspace of group.workspaces) {
          if (!associated.has(workspace.workspaceId)) {
            errors.push({
              code: 'workspace-not-worktree-root',
              operation: 'associate',
              message: `workspace '${workspace.workspaceId}' is inside the repository but is not a worktree root`,
              path: workspace.path,
              workspaceId: workspace.workspaceId,
            })
          }
        }

        repos.push({
          repoId: opaqueId('repo', commonDir),
          commonDir,
          mainPath: worktrees[0]!.path,
          worktrees,
          branches,
        })
      } catch (error) {
        errors.push({
          code: error instanceof GitWorktreeError ? error.code : 'git-list-failed',
          operation: 'list',
          message: safeErrorMessage(error),
          path: group.cwd,
        })
        if (error instanceof GitWorktreeError && error.code === 'snapshot-deadline') {
          sourceError ??= { code: 'snapshot-deadline', message: error.message }
          break
        }
      }
    }

    return { repos, errors, ...(sourceError === undefined ? {} : { sourceError }) }
  }

  /** Issue a short-lived, in-memory preview after a coherent repository read. */
  async previewCreate(untrusted: PreviewCreateInput): Promise<PreviewCreateResult> {
    const input = parsePreviewInput(untrusted)
    const initial = await this.readSource()
    const initialWorkspace = this.workspace(initial, input.sourceWorkspaceId)
    const discovered = await this.discover(initialWorkspace.path)

    return await this.mutex.run(discovered.commonDir, async () => {
      const state = await this.readSource()
      const workspace = this.workspace(state, input.sourceWorkspaceId)
      const topology = await this.topology(workspace.path)
      if (topology.commonDir !== discovered.commonDir) {
        fail('repository-changed', 'the source workspace changed repositories during preview')
      }
      const main = topology.worktrees[0]!
      if (main.bare) fail('bare-repository', 'bare repositories cannot own linked worktrees')

      const targetRoot = this.worktreeRootFor(topology.mainPath, topology.commonDir)
      const targetPath = resolve(targetRoot, input.basename)
      if (!targetPath.startsWith(`${targetRoot}${sep}`)) fail('unsafe-path', 'target escaped the unified worktree root')
      await this.assertPathAbsent(targetPath)
      await this.assertBranchFormat(topology.mainPath, input.branch.name)

      const branchHead = await this.localBranchHead(topology.mainPath, input.branch.name)
      let startHead: string
      if (input.branch.kind === 'existing') {
        if (branchHead === null) fail('branch-not-found', `local branch '${input.branch.name}' does not exist`)
        if (topology.worktrees.some(worktree => worktree.branch === input.branch.name)) {
          fail('branch-checked-out', `local branch '${input.branch.name}' is already checked out`)
        }
        startHead = branchHead
      } else {
        if (branchHead !== null) fail('branch-exists', `local branch '${input.branch.name}' already exists`)
        // OpenChamber sourceBranch: the new branch starts from the chosen
        // local branch's head (pinned as an exact commit), defaulting to the
        // main checkout HEAD.
        if (input.startRef !== undefined) {
          const startHeadOf = await this.localBranchHead(topology.mainPath, input.startRef)
          if (startHeadOf === null) fail('branch-not-found', `source branch '${input.startRef}' does not exist`)
          startHead = startHeadOf
        } else {
          startHead = main.head
        }
      }

      this.pruneCaches()
      if (this.previews.size >= MAX_PREVIEWS) fail('preview-capacity', 'too many live worktree previews')
      const token = this.uniquePreviewToken()
      const createdAt = this.now()
      const preview: PreviewRecord = {
        previewToken: token,
        expiresAt: createdAt + PREVIEW_TTL_MS,
        repoId: opaqueId('repo', topology.commonDir),
        commonDir: topology.commonDir,
        mainPath: topology.mainPath,
        targetPath,
        branch: input.branch.name,
        branchMode: input.branch.kind,
        baseHead: startHead,
        startRef: input.branch.kind === 'new' ? input.startRef : undefined,
        sourceWorkspaceId: input.sourceWorkspaceId,
        basename: input.basename,
        createdAt,
      }
      this.previews.set(token, preview)
      return this.publicPreview(preview)
    })
  }

  /** Create exactly the previewed worktree, with bounded same-process TTL idempotency. */
  async create(untrusted: CreateInput): Promise<CreateResult> {
    const input = parseCreateInput(untrusted)
    this.clearDiscoveryCaches()
    this.pruneCaches()
    const existing = this.createOperations.get(input.operationId)
    let preview: PreviewRecord
    if (existing !== undefined) {
      if (existing.previewToken !== input.previewToken) {
        fail('operation-conflict', 'operationId is already bound to another preview')
      }
      preview = existing.preview
      if (existing.state === 'creating') {
        const result = await existing.createPromise!
        return { ...result, replayed: true }
      }
      if (existing.state === 'created') return await this.verifyCreatedReplay(existing)
      if (existing.state === 'rolling-back'
        || existing.state === 'rollback-uncertain'
        || existing.state === 'rolled-back') {
        fail('operation-rolled-back', 'the create operation has already been rolled back')
      }
    } else {
      const candidate = this.previews.get(input.previewToken)
      if (candidate === undefined) fail('preview-not-found', 'preview token is unknown or expired')
      if (candidate.expiresAt <= this.now()) {
        this.previews.delete(input.previewToken)
        fail('preview-expired', 'preview token has expired')
      }
      this.evictOldestCreateOperationIfFull()
      if (this.createOperations.size >= this.operationCapacity) {
        fail('operation-capacity', 'too many retained worktree operations')
      }
      preview = candidate
    }
    const record: CreateOperationRecord = existing ?? {
      previewToken: input.previewToken,
      preview,
      state: 'ready',
      updatedAt: this.now(),
      attemptedCreate: false,
      gitAccepted: false,
      attemptedRollback: false,
    }
    this.createOperations.set(input.operationId, record)
    record.state = 'creating'
    record.updatedAt = this.now()
    const promise = this.performCreate(input.operationId, preview, record, existing !== undefined)
    record.createPromise = promise
    try {
      const result = await promise
      record.state = 'created'
      record.updatedAt = this.now()
      record.createResult = result
      if (result.rollbackAuthorized) {
        record.facts = {
          repoId: result.repoId,
          worktreeId: result.worktreeId,
          commonDir: result.commonDir,
          mainPath: preview.mainPath,
          path: result.path,
          branch: result.branch,
          head: result.head,
          branchCreated: result.branchCreated,
        }
      }
      return result
    } catch (error) {
      // Once a mutation was admitted, timeout/output overflow/non-zero exit
      // and postcondition read failures all have uncertain commit outcome.
      // The same operation id must reconcile topology before another add.
      record.state = record.attemptedCreate ? 'uncertain' : 'ready'
      record.updatedAt = this.now()
      record.createPromise = undefined
      throw error
    }
  }

  /**
   * Compensate only a worktree proven to have been created by this operation.
   * No force and no branch deletion are ever available.
   */
  async rollbackCreate(untrusted: RollbackCreateInput): Promise<RollbackCreateResult> {
    const input = parseRollbackInput(untrusted)
    this.clearDiscoveryCaches()
    this.pruneCaches()
    const record = this.createOperations.get(input.operationId)
    if (record === undefined) fail('operation-not-found', 'no create operation can authorize this rollback')
    if (record.state === 'creating') fail('operation-busy', 'create operation is still running')
    if (record.state === 'ready') fail('operation-not-created', 'create operation did not create a worktree')
    if (record.state === 'rolling-back') {
      const result = await record.rollbackPromise!
      return { ...result, replayed: true }
    }
    if (record.state === 'rolled-back') return { ...record.rollbackResult!, replayed: true }
    if (!record.gitAccepted || record.facts === undefined) {
      fail('rollback-not-authorized', 'Git add success was not observed; automatic rollback has no provenance')
    }

    const stateBeforeRollback = record.state
    record.state = 'rolling-back'
    record.updatedAt = this.now()
    const promise = this.performRollback(
      input.operationId,
      record.facts,
      record,
      stateBeforeRollback === 'rollback-uncertain',
    )
    record.rollbackPromise = promise
    try {
      const result = await promise
      record.state = 'rolled-back'
      record.updatedAt = this.now()
      record.rollbackResult = result
      return result
    } catch (error) {
      record.state = record.attemptedRollback ? 'rollback-uncertain' : stateBeforeRollback
      record.updatedAt = this.now()
      record.rollbackPromise = undefined
      throw error
    }
  }

  /** Git-first removal; the durable workspace registration remains for the caller's next step. */
  async remove(untrusted: RemoveInput): Promise<RemoveResult> {
    const input = parseRemoveInput(untrusted)
    const fingerprint = objectFingerprint(input)
    this.clearDiscoveryCaches()
    this.pruneCaches()
    const existing = this.removeOperations.get(input.operationId)
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) fail('operation-conflict', 'operationId is bound to another removal')
      if (existing.state === 'removing') {
        const result = await existing.promise!
        return { ...result, replayed: true }
      }
      if (existing.state === 'removed') return await this.verifyRemovedReplay(existing)
    }

    if (existing === undefined) {
      this.evictOldestRemoveOperationIfFull()
      if (this.removeOperations.size >= this.operationCapacity) {
        fail('operation-capacity', 'too many retained worktree operations')
      }
    }
    const record: RemoveOperationRecord = existing ?? {
      fingerprint,
      state: 'ready',
      updatedAt: this.now(),
      attemptedRemove: false,
      branchDeleteAttempted: false,
    }
    this.removeOperations.set(input.operationId, record)
    record.state = 'removing'
    record.updatedAt = this.now()
    const promise = this.performRemove(input, record, existing !== undefined)
    record.promise = promise
    try {
      const result = await promise
      record.state = 'removed'
      record.updatedAt = this.now()
      record.result = result
      return result
    } catch (error) {
      record.state = record.attemptedRemove ? 'uncertain' : 'ready'
      record.updatedAt = this.now()
      record.promise = undefined
      throw error
    }
  }

  /** A terminal result is a receipt, not a substitute for current Git facts. */
  private async verifyCreatedReplay(record: CreateOperationRecord): Promise<CreateResult> {
    const result = record.createResult
    if (result === undefined) throw new Error('created operation is missing its terminal result')
    return await this.mutex.run(result.commonDir, async () => {
      const topology = await this.topology(record.preview.mainPath)
      if (topology.commonDir !== result.commonDir
        || topology.commonDir !== record.preview.commonDir
        || topology.mainPath !== record.preview.mainPath
        || opaqueId('repo', topology.commonDir) !== result.repoId) {
        fail('operation-conflict', 'created operation repository changed before terminal replay')
      }
      const target = topology.worktrees.find(worktree => worktree.path === result.path)
      if (target === undefined
        || target === topology.worktrees[0]
        || target.bare
        || result.path !== record.preview.targetPath
        || target.branch !== result.branch
        || target.branch !== record.preview.branch
        || target.head !== result.head
        || target.head !== record.preview.baseHead
        || opaqueId('worktree', topology.commonDir, target.path) !== result.worktreeId) {
        fail('operation-conflict', 'created worktree no longer has the terminal operation identity')
      }
      return { ...result, replayed: true }
    })
  }

  /** Verify the Git-first receipt again before a client retries workspace.delete. */
  private async verifyRemovedReplay(record: RemoveOperationRecord): Promise<RemoveResult> {
    const intent = record.intent
    const result = record.result
    if (intent === undefined || result === undefined) {
      throw new Error('removed operation is missing its terminal receipt')
    }
    return await this.mutex.run(intent.commonDir, async () => {
      const topology = await this.topology(intent.mainPath)
      if (topology.commonDir !== intent.commonDir
        || topology.mainPath !== intent.mainPath
        || opaqueId('repo', topology.commonDir) !== intent.repoId) {
        fail('operation-conflict', 'removed operation repository changed before terminal replay')
      }
      if (topology.worktrees.some(worktree => worktree.path === intent.path)) {
        fail('operation-conflict', 'removed worktree path reappeared before terminal replay')
      }

      const state = await this.readSource()
      await this.assertRemovedWorkspaceReceipt(intent, state)
      return { ...result, replayed: true }
    })
  }

  private async assertRemovedWorkspaceReceipt(intent: RemoveIntent, state: SourceSnapshot): Promise<void> {
    const workspace = state.workspaces.find(candidate => candidate.workspaceId === intent.workspaceId)
    if (workspace === undefined) return
    if (workspace.path !== intent.workspacePath
      || !sameMembership(workspace.sessionIds, intent.sessionIds)) {
      fail('operation-conflict', 'workspace receipt changed after Git-first removal')
    }
    this.assertNoRunningSessions(workspace, state.runningSessionIds)
    await this.assertNoRunningAtPath(intent.path, state)
  }

  private async performCreate(
    id: string,
    preview: PreviewRecord,
    operation: CreateOperationRecord,
    replayed: boolean,
  ): Promise<CreateResult> {
    return await this.mutex.run(preview.commonDir, async () => {
      const state = await this.readSource()
      const workspace = this.workspace(state, preview.sourceWorkspaceId)
      const topology = await this.topology(workspace.path)
      if (topology.commonDir !== preview.commonDir || topology.mainPath !== preview.mainPath) {
        fail('preview-stale', 'repository identity changed after preview')
      }
      const targetRoot = this.worktreeRootFor(topology.mainPath, topology.commonDir)
      const targetPath = resolve(targetRoot, preview.basename)
      if (targetPath !== preview.targetPath || !targetPath.startsWith(`${this.worktreesRoot}${sep}`)) {
        fail('preview-stale', 'target identity changed after preview')
      }

      const reconciled = topology.worktrees.find(worktree => worktree.path === targetPath)
      if (reconciled !== undefined) {
        if (!operation.attemptedCreate) {
          fail('target-exists', `target path '${targetPath}' was not created by this operation`)
        }
        if (reconciled.bare
          || reconciled.branch !== preview.branch
          || reconciled.head !== preview.baseHead) {
          fail('operation-conflict', 'operation target exists with a different branch or HEAD')
        }
        const facts: CreatedFacts = {
          repoId: opaqueId('repo', topology.commonDir),
          worktreeId: opaqueId('worktree', topology.commonDir, reconciled.path),
          commonDir: topology.commonDir,
          mainPath: topology.mainPath,
          path: reconciled.path,
          branch: preview.branch,
          head: reconciled.head,
          branchCreated: preview.branchMode === 'new' && operation.gitAccepted,
        }
        if (operation.gitAccepted) operation.facts = facts
        return {
          operationId: id,
          created: true,
          replayed: true,
          repoId: facts.repoId,
          worktreeId: facts.worktreeId,
          commonDir: facts.commonDir,
          path: facts.path,
          branch: facts.branch,
          head: facts.head,
          rollbackAuthorized: operation.gitAccepted,
          branchCreated: facts.branchCreated,
        }
      }

      await this.assertPathAbsent(targetPath)
      await this.assertBranchFormat(topology.mainPath, preview.branch)
      const branchHead = await this.localBranchHead(topology.mainPath, preview.branch)

      if (preview.branchMode === 'existing') {
        if (branchHead !== preview.baseHead) fail('preview-stale', 'existing branch moved after preview')
        if (topology.worktrees.some(worktree => worktree.branch === preview.branch)) {
          fail('branch-checked-out', `local branch '${preview.branch}' is already checked out`)
        }
      } else {
        if (branchHead !== null) {
          fail(
            'operation-conflict',
            operation.gitAccepted && branchHead === preview.baseHead
              ? 'the confirmed worktree disappeared while its preserved branch remains'
              : 'new branch now exists without confirmed operation provenance',
          )
        } else if (preview.startRef !== undefined) {
          const startHead = await this.localBranchHead(topology.mainPath, preview.startRef)
          if (startHead !== preview.baseHead) fail('preview-stale', 'source branch moved after preview')
        } else if (topology.worktrees[0]!.head !== preview.baseHead) {
          fail('preview-stale', 'main checkout moved after preview')
        }
      }

      // Re-read the registry immediately before mutation. This cannot make Git
      // and dsh storage transactional, but it closes ordinary UI races.
      const latest = await this.readSource()
      const latestWorkspace = this.workspace(latest, preview.sourceWorkspaceId)
      if (await this.existingPath(latestWorkspace.path) !== await this.existingPath(workspace.path)) {
        fail('preview-stale', 'source workspace path changed after preview')
      }

      const expectedFacts: CreatedFacts = {
        repoId: opaqueId('repo', topology.commonDir),
        worktreeId: opaqueId('worktree', topology.commonDir, targetPath),
        commonDir: topology.commonDir,
        mainPath: topology.mainPath,
        path: targetPath,
        branch: preview.branch,
        head: preview.baseHead,
        branchCreated: preview.branchMode === 'new',
      }
      operation.attemptedCreate = true

      await this.ensureWorktreeRoot(targetRoot)
      const args = preview.branchMode === 'existing'
        ? ['worktree', 'add', '--', targetPath, preview.branch]
        : ['worktree', 'add', '-b', preview.branch, '--', targetPath, preview.baseHead]
      try {
        await this.gitChecked(topology.mainPath, args, true)
      } catch (error) {
        // A spawn failure proves Git never accepted the operation. Timeout,
        // output overflow and non-zero exit remain ambiguous and are reconciled
        // by identity, but can never grant rollback provenance.
        if (error instanceof GitWorktreeError && error.code === 'git-spawn-failed') {
          operation.attemptedCreate = false
        }
        throw error
      }
      operation.gitAccepted = true
      operation.facts = expectedFacts

      const after = await this.topology(topology.mainPath)
      const created = after.worktrees.find(worktree => worktree.path === targetPath)
      if (after.commonDir !== topology.commonDir
        || created === undefined
        || created.branch !== preview.branch
        || created.head !== preview.baseHead
        || created.bare) {
        fail('postcondition-failed', 'Git did not publish the expected worktree identity')
      }
      return {
        operationId: id,
        created: true,
        replayed,
        repoId: opaqueId('repo', after.commonDir),
        worktreeId: opaqueId('worktree', after.commonDir, created.path),
        commonDir: after.commonDir,
        path: created.path,
        branch: preview.branch,
        head: created.head,
        rollbackAuthorized: true,
        branchCreated: preview.branchMode === 'new',
      }
    })
  }

  private async performRollback(
    id: string,
    facts: CreatedFacts,
    operation: CreateOperationRecord,
    replayed: boolean,
  ): Promise<RollbackCreateResult> {
    return await this.mutex.run(facts.commonDir, async () => {
      const state = await this.readSource()
      if (await this.anyWorkspaceOwnsPath(state, facts.path)) {
        fail('rollback-has-workspace', 'rollback is forbidden after a workspace registration exists')
      }
      await this.assertNoRunningAtPath(facts.path, state)
      const topology = await this.topology(facts.mainPath)
      if (topology.commonDir !== facts.commonDir) fail('repository-changed', 'created repository identity changed')
      const target = topology.worktrees.find(worktree => worktree.path === facts.path)
      if (target === undefined) {
        // A prior rollback may have committed before its response/post-read
        // failed. Proven create ownership plus authoritative absence is the
        // idempotent success condition; the preserved branch is untouched.
        return {
          operationId: id,
          removed: true,
          replayed: true,
          repoId: facts.repoId,
          worktreeId: facts.worktreeId,
          commonDir: facts.commonDir,
          path: facts.path,
          branch: facts.branch,
          head: facts.head,
          branchPreserved: true,
        }
      }
      if (target === topology.worktrees[0]) fail('main-worktree', 'the main checkout can never be rolled back')
      if (target.locked) fail('worktree-locked', 'locked worktrees cannot be rolled back')
      if (target.branch !== facts.branch) fail('worktree-changed', 'the operation-created worktree changed branch')
      if (target.head !== facts.head) fail('worktree-changed', 'the operation-created worktree changed HEAD')
      if (await this.isDirty(target.path)) fail('worktree-dirty', 'dirty worktrees cannot be rolled back')

      // Fresh workspace check immediately before Git removal. Never force.
      const latest = await this.readSource()
      if (await this.anyWorkspaceOwnsPath(latest, facts.path)) {
        fail('rollback-has-workspace', 'workspace registration appeared during rollback')
      }
      await this.assertNoRunningAtPath(facts.path, latest)
      const finalTopology = await this.topology(facts.mainPath)
      if (finalTopology.commonDir !== facts.commonDir || finalTopology.mainPath !== facts.mainPath) {
        fail('repository-changed', 'created repository identity changed immediately before rollback')
      }
      const finalTarget = finalTopology.worktrees.find(worktree => worktree.path === facts.path)
      if (finalTarget === undefined) {
        return {
          operationId: id,
          removed: true,
          replayed: true,
          repoId: facts.repoId,
          worktreeId: facts.worktreeId,
          commonDir: facts.commonDir,
          path: facts.path,
          branch: facts.branch,
          head: facts.head,
          branchPreserved: true,
        }
      }
      if (finalTarget === finalTopology.worktrees[0]
        || finalTarget.locked
        || finalTarget.branch !== facts.branch
        || finalTarget.head !== facts.head) {
        fail('worktree-changed', 'operation-created worktree identity changed immediately before rollback')
      }
      if (await this.isDirty(finalTarget.path)) {
        fail('worktree-dirty', 'worktree became dirty immediately before rollback')
      }
      operation.attemptedRollback = true
      await this.gitChecked(finalTopology.mainPath, ['worktree', 'remove', '--', facts.path], true)
      const after = await this.topology(finalTopology.mainPath)
      if (after.worktrees.some(worktree => worktree.path === facts.path)) {
        fail('postcondition-failed', 'Git still reports the rolled-back worktree')
      }
      return {
        operationId: id,
        removed: true,
        replayed,
        repoId: facts.repoId,
        worktreeId: facts.worktreeId,
        commonDir: facts.commonDir,
        path: facts.path,
        branch: facts.branch,
        head: target.head,
        branchPreserved: true,
      }
    })
  }

  private async performRemove(
    input: RemoveInput,
    operation: RemoveOperationRecord,
    replayed: boolean,
  ): Promise<RemoveResult> {
    if (operation.intent !== undefined) {
      return await this.mutex.run(operation.intent.commonDir, async () => {
        return await this.reconcileBoundRemove(input, operation, operation.intent!, true)
      })
    }

    // UNREGISTERED removal (Plan A): the worktree has no dsh workspace —
    // discover from the explicit path, keep every git-level guard, skip the
    // workspace preflight/session guards and return next: 'none'.
    if (input.workspaceId === undefined) {
      const unregisteredPath = input.path
      if (unregisteredPath === undefined) fail('invalid-input', 'input.path is required for an unregistered removal')
      const discovered = await this.discover(unregisteredPath)
      return await this.mutex.run(discovered.commonDir, async () => {
        const state = await this.readSource()
        const canonicalPath = await this.existingPath(unregisteredPath)
        await this.assertNoRunningAtPath(canonicalPath, state)
        // Fail-closed mirror of the registered branch (P1-3): the target must
        // NOT be registered as a workspace — a workspace AT the path or
        // INSIDE it blocks the unregistered removal (an adoption between the
        // snapshot and this action must not be silently deleted).
        for (const candidate of state.workspaces) {
          const candidatePath = await this.existingPath(candidate.path).catch(() => null)
          if (candidatePath === null) continue
          if (candidatePath === canonicalPath || candidatePath.startsWith(`${canonicalPath}${sep}`)) {
            fail('workspace-registered', 'the target worktree is already registered as a workspace')
          }
        }
        const topology = await this.topology(canonicalPath)
        if (topology.commonDir !== discovered.commonDir) fail('expected-mismatch', 'worktree changed repositories')
        const repoId = opaqueId('repo', topology.commonDir)
        if (repoId !== input.expected.repoId) fail('expected-mismatch', 'repository identity changed')
        const target = topology.worktrees.find(worktree => worktree.path === canonicalPath)
        if (target === undefined) fail('worktree-not-found', 'path is not an exact worktree root')
        const worktreeId = opaqueId('worktree', topology.commonDir, target.path)
        if (worktreeId !== input.expected.worktreeId) fail('expected-mismatch', 'worktree identity changed')
        if (target === topology.worktrees[0]) fail('main-worktree', 'the main checkout cannot be removed')
        if (target.locked) fail('worktree-locked', 'locked worktrees cannot be removed')
        if (target.branch !== input.expected.branch) fail('expected-mismatch', 'worktree branch changed')
        if (target.head !== input.expected.head) fail('expected-mismatch', 'worktree HEAD changed')
        if (await this.isDirty(target.path)) fail('worktree-dirty', 'dirty worktrees cannot be removed')
        const intent: RemoveIntent = {
          repoId,
          worktreeId,
          commonDir: topology.commonDir,
          mainPath: topology.mainPath,
          path: target.path,
          branch: target.branch,
          head: target.head,
          sessionIds: [],
          deleteBranch: input.deleteBranch,
        }
        operation.intent = intent
        return await this.commitBoundRemove(input.operationId, operation, intent, replayed)
      })
    }

    // Registered branch: workspaceId is present (narrowed for the checks).
    const registeredWorkspaceId = input.workspaceId
    const initialState = await this.readSource()
    const initialWorkspace = this.workspace(initialState, registeredWorkspaceId)
    const discovered = await this.discover(initialWorkspace.path)
    return await this.mutex.run(discovered.commonDir, async () => {
      let state = await this.readSource()
      let workspace = this.workspace(state, registeredWorkspaceId)
      const workspacePath = await this.existingPath(workspace.path)
      await this.assertNoOtherWorkspaceWithin(state, workspacePath, registeredWorkspaceId)
      this.assertNoRunningSessions(workspace, state.runningSessionIds)
      await this.assertNoRunningAtPath(workspacePath, state)

      const topology = await this.topology(workspace.path)
      if (topology.commonDir !== discovered.commonDir) fail('expected-mismatch', 'workspace changed repositories')
      const repoId = opaqueId('repo', topology.commonDir)
      if (repoId !== input.expected.repoId) fail('expected-mismatch', 'repository identity changed')
      const target = topology.worktrees.find(worktree => worktree.path === workspacePath)
      if (target === undefined) fail('worktree-not-found', 'workspace is not an exact worktree root')
      const worktreeId = opaqueId('worktree', topology.commonDir, target.path)
      if (worktreeId !== input.expected.worktreeId) fail('expected-mismatch', 'worktree identity changed')
      if (target === topology.worktrees[0]) fail('main-worktree', 'the main checkout cannot be removed')
      if (target.locked) fail('worktree-locked', 'locked worktrees cannot be removed')
      if (target.branch !== input.expected.branch) fail('expected-mismatch', 'worktree branch changed')
      if (target.head !== input.expected.head) fail('expected-mismatch', 'worktree HEAD changed')
      if (await this.isDirty(target.path)) fail('worktree-dirty', 'dirty worktrees cannot be removed')

      // Git-first protocol: capture the final durable membership, reject a
      // running associated agent, remove only Git state, and return enough
      // identity for the client to perform workspace.delete next.
      state = await this.readSource()
      workspace = this.workspace(state, registeredWorkspaceId)
      if (await this.existingPath(workspace.path) !== workspacePath) {
        fail('expected-mismatch', 'workspace path changed during removal')
      }
      await this.assertNoOtherWorkspaceWithin(state, workspacePath, registeredWorkspaceId)
      this.assertNoRunningSessions(workspace, state.runningSessionIds)
      await this.assertNoRunningAtPath(workspacePath, state)
      const sessionIds = [...workspace.sessionIds]

      const intent: RemoveIntent = {
        workspaceId: input.workspaceId,
        workspacePath: workspace.path,
        repoId,
        worktreeId,
        commonDir: topology.commonDir,
        mainPath: topology.mainPath,
        path: target.path,
        branch: target.branch,
        head: target.head,
        sessionIds,
        deleteBranch: input.deleteBranch,
      }
      operation.intent = intent
      return await this.commitBoundRemove(input.operationId, operation, intent, replayed)
    })
  }

  /** Best-effort optional branch deletion after a removal, once per
   *  operation (design 08 §11 user decision). Called from every terminal
   *  removal path — including the target-absent replay paths — so a removal
   *  that committed before a failure still reports the branch outcome
   *  honestly (branchDeleted / branchDeleteFailed on the result). */
  private async attemptBranchDelete(
    operation: RemoveOperationRecord,
    intent: RemoveIntent,
    mainPath: string,
  ): Promise<void> {
    if (intent.deleteBranch === undefined || operation.branchDeleteAttempted) return
    operation.branchDeleteAttempted = true
    try {
      await this.assertBranchFormat(mainPath, intent.deleteBranch)
      await this.gitChecked(mainPath, ['branch', '-D', intent.deleteBranch], true)
      intent.branchDeleted = true
    } catch {
      intent.branchDeleteFailed = true
    }
  }

  /** Reconcile a removal whose Git subprocess may have committed before failure. */
  private async reconcileBoundRemove(
    input: RemoveInput,
    operation: RemoveOperationRecord,
    intent: RemoveIntent,
    replayed: boolean,
  ): Promise<RemoveResult> {
    const topology = await this.topology(intent.mainPath)
    if (topology.commonDir !== intent.commonDir || topology.mainPath !== intent.mainPath) {
      fail('operation-conflict', 'bound removal repository identity changed')
    }
    const target = topology.worktrees.find(worktree => worktree.path === intent.path)
    if (target === undefined) {
      // Git-first success may precede both the response and the postcondition
      // read. Re-read the registry so a recycled workspace id cannot make the
      // client delete a different durable record.
      const state = await this.readSource()
      await this.assertRemovedWorkspaceReceipt(intent, state)
      await this.attemptBranchDelete(operation, intent, topology.mainPath)
      return this.removeResult(input.operationId, intent, true)
    }

    const repoId = opaqueId('repo', topology.commonDir)
    const worktreeId = opaqueId('worktree', topology.commonDir, target.path)
    if (repoId !== intent.repoId
      || worktreeId !== intent.worktreeId
      || target.branch !== intent.branch
      || target.head !== intent.head) {
      fail('operation-conflict', 'bound removal target changed while its outcome was uncertain')
    }
    if (target === topology.worktrees[0]) fail('operation-conflict', 'bound linked worktree became the main checkout')
    if (target.locked) fail('worktree-locked', 'locked worktrees cannot be removed')
    if (await this.isDirty(target.path)) fail('worktree-dirty', 'dirty worktrees cannot be removed')

    if (input.workspaceId === undefined) {
      // UNREGISTERED replay: no workspace — skip the registry/workspace
      // guards, keep the path-level running check and the identity checks.
      const state = await this.readSource()
      const canonicalPath = await this.existingPath(intent.path)
      await this.assertNoRunningAtPath(canonicalPath, state)
      operation.intent = intent
      return await this.commitBoundRemove(input.operationId, operation, intent, replayed)
    }

    const state = await this.readSource()
    const workspace = this.workspace(state, input.workspaceId)
    const workspacePath = await this.existingPath(workspace.path)
    if (workspacePath !== intent.path) fail('operation-conflict', 'workspace path changed during removal recovery')
    await this.assertNoOtherWorkspaceWithin(state, workspacePath, input.workspaceId)
    this.assertNoRunningSessions(workspace, state.runningSessionIds)
    await this.assertNoRunningAtPath(workspacePath, state)
    const refreshed: RemoveIntent = {
      ...intent,
      workspacePath: workspace.path,
      sessionIds: [...workspace.sessionIds],
    }
    operation.intent = refreshed
    return await this.commitBoundRemove(input.operationId, operation, refreshed, replayed)
  }

  private async commitBoundRemove(
    operationIdValue: string,
    operation: RemoveOperationRecord,
    intent: RemoveIntent,
    replayed: boolean,
  ): Promise<RemoveResult> {
    // Close the controllable TOCTOU window left by registry/agent scans. The
    // common-dir mutex serializes this plugin, not an external Git process, so
    // identity and cleanliness are checked again immediately before mutation.
    const finalTopology = await this.topology(intent.mainPath)
    if (finalTopology.commonDir !== intent.commonDir || finalTopology.mainPath !== intent.mainPath) {
      fail('operation-conflict', 'removal repository changed immediately before mutation')
    }
    const finalTarget = finalTopology.worktrees.find(worktree => worktree.path === intent.path)
    if (finalTarget === undefined) {
      // An external Git actor may have removed the target after our registry
      // preflight. Goal convergence is safe only if the workspace receipt did
      // not gain membership or liveness during that window.
      const state = await this.readSource()
      await this.assertRemovedWorkspaceReceipt(intent, state)
      await this.attemptBranchDelete(operation, intent, finalTopology.mainPath)
      return this.removeResult(operationIdValue, intent, true)
    }
    if (finalTarget === finalTopology.worktrees[0]
      || finalTarget.locked
      || opaqueId('worktree', finalTopology.commonDir, finalTarget.path) !== intent.worktreeId
      || finalTarget.branch !== intent.branch
      || finalTarget.head !== intent.head) {
      fail('operation-conflict', 'removal target changed immediately before mutation')
    }
    if (await this.isDirty(finalTarget.path)) {
      fail('worktree-dirty', 'worktree became dirty immediately before removal')
    }
    operation.attemptedRemove = true
    await this.gitChecked(finalTopology.mainPath, ['worktree', 'remove', '--', intent.path], true)
    const after = await this.topology(finalTopology.mainPath)
    if (after.commonDir !== intent.commonDir
      || after.worktrees.some(worktree => worktree.path === intent.path)) {
      fail('postcondition-failed', 'Git still reports the removed worktree or repository identity changed')
    }
    // Optional branch deletion (design 08 §11 user decision): best-effort,
    // once per operation. A failure is honest (the worktree removal stands).
    await this.attemptBranchDelete(operation, intent, finalTopology.mainPath)
    return this.removeResult(operationIdValue, intent, replayed)
  }

  private removeResult(operationIdValue: string, intent: RemoveIntent, replayed: boolean): RemoveResult {
    return {
      operationId: operationIdValue,
      removed: true,
      replayed,
      ...(intent.workspaceId === undefined ? {} : { workspaceId: intent.workspaceId }),
      repoId: intent.repoId,
      worktreeId: intent.worktreeId,
      commonDir: intent.commonDir,
      path: intent.path,
      branch: intent.branch,
      head: intent.head,
      sessionIds: [...intent.sessionIds],
      next: intent.workspaceId === undefined ? 'none' : 'delete-workspace',
      branchPreserved: true,
      ...(intent.branchDeleted === true ? { branchDeleted: true } : {}),
      ...(intent.branchDeleteFailed === true ? { branchDeleteFailed: true } : {}),
    }
  }

  /** Repo-specific worktree subdirectory: `<root>/<repo-name>-<hash12>` — a
   *  unified location keyed by the repository identity (common dir), so two
   *  same-named repositories never block each other, and never inside a
   *  working tree (git status stays clean). */
  private worktreeRootFor(mainPath: string, commonDir: string): string {
    const repoName = basename(mainPath) || 'repo'
    const digest = createHash('sha256').update(commonDir).digest('hex').slice(0, 12)
    return join(this.worktreesRoot, `${repoName}-${digest}`)
  }

  /** Ensure the unified worktree root exists before `git worktree add`
   *  (git requires the parent directory; mkdir is recursive + idempotent). */
  private async ensureWorktreeRoot(root: string): Promise<void> {
    try {
      await this.fs.mkdir(root)
    } catch {
      // mkdir failure surfaces at the actual git worktree add; the root may
      // legitimately exist already (recursive mkdir is idempotent).
    }
  }

  private clearDiscoveryCaches(): void {
    this.workspaceDiscoverCache.clear()
    this.repoTopologyCache.clear()
  }

  private async readSource(): Promise<SourceSnapshot> {
    let rawWorkspaces: readonly WorkspaceFact[]
    let rawAgents: readonly AgentFact[]
    try {
      [rawWorkspaces, rawAgents] = await Promise.all([
        this.source.listWorkspaces(),
        this.source.listAgents(),
      ])
    } catch (error) {
      if (error instanceof GitWorktreeError) throw error
      fail('state-source-unavailable', `host state source is unavailable: ${safeErrorMessage(error)}`)
    }
    if (!Array.isArray(rawWorkspaces) || !Array.isArray(rawAgents)) {
      fail('state-source-invalid', 'host state source returned a non-array')
    }
    if (rawWorkspaces.length > MAX_WORKSPACES) {
      fail('state-source-capacity', `host returned more than ${MAX_WORKSPACES} workspaces`)
    }
    if (rawAgents.length > MAX_AGENTS) {
      fail('state-source-capacity', `host returned more than ${MAX_AGENTS} agents`)
    }
    let totalSessionMemberships = 0
    const workspaces = rawWorkspaces.map((raw, index): WorkspaceFact => {
      assertRecord(raw, `workspaces[${index}]`)
      const workspaceId = requiredString(raw.workspaceId, `workspaces[${index}].workspaceId`, 256)
      const path = absoluteExpectedPath(raw.path, `workspaces[${index}].path`)
      if (!Array.isArray(raw.sessionIds) || raw.sessionIds.some(id => typeof id !== 'string')) {
        fail('state-source-invalid', `workspaces[${index}].sessionIds is invalid`)
      }
      if (raw.sessionIds.length > MAX_SESSIONS_PER_WORKSPACE) {
        fail(
          'state-source-capacity',
          `workspace '${workspaceId}' has more than ${MAX_SESSIONS_PER_WORKSPACE} sessions`,
        )
      }
      totalSessionMemberships += raw.sessionIds.length
      if (totalSessionMemberships > MAX_TOTAL_SESSION_MEMBERSHIPS) {
        fail(
          'state-source-capacity',
          `host returned more than ${MAX_TOTAL_SESSION_MEMBERSHIPS} total workspace/session memberships`,
        )
      }
      const sessionIds = raw.sessionIds.map((id, sessionIndex) => requiredString(
        id,
        `workspaces[${index}].sessionIds[${sessionIndex}]`,
        256,
      ))
      return { workspaceId, path, sessionIds }
    })
    const runningSessionIds = new Set<string>()
    const runningAgents: AgentFact[] = []
    for (let index = 0; index < rawAgents.length; index += 1) {
      const raw = rawAgents[index]
      assertRecord(raw, `agents[${index}]`)
      const sessionId = requiredString(raw.sessionId, `agents[${index}].sessionId`, 256)
      if (raw.status !== 'idle' && raw.status !== 'running') {
        fail('state-source-invalid', `agents[${index}].status is invalid`)
      }
      const cwd = raw.cwd === undefined
        ? undefined
        : absoluteExpectedPath(raw.cwd, `agents[${index}].cwd`)
      if (raw.status === 'running') {
        runningSessionIds.add(sessionId)
        runningAgents.push({ sessionId, status: 'running', ...(cwd === undefined ? {} : { cwd }) })
      }
    }
    return { workspaces, runningSessionIds, runningAgents }
  }

  private workspace(state: SourceSnapshot, id: string): WorkspaceFact {
    const workspace = state.workspaces.find(candidate => candidate.workspaceId === id)
    if (workspace === undefined) fail('workspace-not-found', `workspace '${id}' does not exist`)
    return workspace
  }

  private assertNoRunningSessions(workspace: WorkspaceFact, running: ReadonlySet<string>): void {
    const blocked = workspace.sessionIds.filter(id => running.has(id))
    if (blocked.length > 0) {
      fail('running-agent', `worktree has running associated session(s): ${blocked.join(', ')}`)
    }
  }

  /** Canonicalize each distinct live cwd at most once for the whole snapshot. */
  private async snapshotRunningLocations(
    state: SourceSnapshot,
    deadline: number,
    errors: SnapshotError[],
  ): Promise<{ locations: SnapshotRunningLocation[]; deadlineExceeded: boolean }> {
    const canonicalByCwd = new Map<string, string | null>()
    const locations: SnapshotRunningLocation[] = []
    let deadlineExceeded = false
    for (const agent of state.runningAgents) {
      if (agent.cwd === undefined) continue
      const paths = [resolve(agent.cwd)]
      if (this.now() >= deadline) {
        deadlineExceeded = true
      } else {
        let canonical = canonicalByCwd.get(agent.cwd)
        if (canonical === undefined && !canonicalByCwd.has(agent.cwd)) {
          try {
            canonical = await this.existingPath(agent.cwd)
            canonicalByCwd.set(agent.cwd, canonical)
          } catch (error) {
            canonical = null
            canonicalByCwd.set(agent.cwd, null)
            errors.push({
              code: error instanceof GitWorktreeError ? error.code : 'running-agent-path-failed',
              operation: 'associate',
              message: `cannot canonicalize running session '${agent.sessionId}': ${safeErrorMessage(error)}`,
              path: agent.cwd,
            })
          }
        }
        if (canonical !== null && canonical !== undefined && !paths.includes(canonical)) paths.push(canonical)
      }
      locations.push({ sessionId: agent.sessionId, paths })
    }
    return { locations, deadlineExceeded }
  }

  private runningAtSnapshotPath(
    target: string,
    locations: readonly SnapshotRunningLocation[],
  ): string[] {
    const matches = new Set<string>()
    for (const location of locations) {
      if (location.paths.some(path => this.containsPath(target, path))) matches.add(location.sessionId)
    }
    return [...matches]
  }

  private async runningAtPath(
    target: string,
    state: SourceSnapshot,
    strict: boolean,
  ): Promise<string[]> {
    const matches = new Set<string>()
    for (const agent of state.runningAgents) {
      if (agent.cwd === undefined) continue
      if (this.containsPath(target, agent.cwd)) {
        matches.add(agent.sessionId)
        continue
      }
      try {
        const canonical = await this.existingPath(agent.cwd)
        if (this.containsPath(target, canonical)) matches.add(agent.sessionId)
      } catch (error) {
        if (strict) {
          fail(
            'running-agent-cwd-unavailable',
            `cannot safely resolve running session '${agent.sessionId}' cwd: ${safeErrorMessage(error)}`,
          )
        }
      }
    }
    return [...matches]
  }

  private async assertNoRunningAtPath(target: string, state: SourceSnapshot): Promise<void> {
    const blocked = await this.runningAtPath(target, state, true)
    if (blocked.length > 0) {
      fail('running-agent', `worktree contains running session cwd(s): ${blocked.join(', ')}`)
    }
  }

  private containsPath(root: string, candidate: string): boolean {
    const suffix = relative(root, candidate)
    return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`))
  }

  private async anyWorkspaceOwnsPath(state: SourceSnapshot, target: string): Promise<boolean> {
    for (const workspace of state.workspaces) {
      if (this.containsPath(target, resolve(workspace.path))) return true
      let canonical: string
      try {
        canonical = await this.existingPath(workspace.path)
      } catch (error) {
        fail(
          'workspace-path-unavailable',
          `cannot prove workspace '${workspace.workspaceId}' is unrelated to rollback target: ${safeErrorMessage(error)}`,
        )
      }
      if (this.containsPath(target, canonical)) return true
    }
    return false
  }

  private async assertNoOtherWorkspaceWithin(
    state: SourceSnapshot,
    target: string,
    allowedWorkspaceId: string,
  ): Promise<void> {
    for (const workspace of state.workspaces) {
      if (workspace.workspaceId === allowedWorkspaceId) continue
      let canonical: string
      try {
        canonical = await this.existingPath(workspace.path)
      } catch {
        // A VANISHED workspace (externally deleted worktree left a ghost
        // registration) can neither contain the target nor be contained by
        // it — skip it instead of failing the whole removal. One failed
        // entity must not block unrelated ones (AGENTS); the unregistered
        // removal branch already tolerates this exact case (review 2026-08:
        // an orphan workspace was blocking EVERY registered removal on the
        // source, and the retryable error wedged the source in recovery).
        continue
      }
      if (this.containsPath(target, canonical)) {
        fail('nested-workspace', `worktree contains workspace '${workspace.workspaceId}'`)
      }
    }
  }

  private async existingPath(path: string): Promise<string> {
    if (path.length === 0 || path.length > MAX_PATH_LENGTH || /[\0\r\n]/u.test(path) || !isAbsolute(path)) {
      fail('unsafe-path', 'filesystem path must be a bounded absolute path')
    }
    let canonical: string
    try {
      canonical = await this.fs.realpath(path)
    } catch (error) {
      fail('path-unavailable', `cannot resolve '${path}': ${safeErrorMessage(error)}`)
    }
    if (canonical.length === 0 || canonical.length > MAX_PATH_LENGTH
      || /[\0\r\n]/u.test(canonical) || !isAbsolute(canonical)) {
      fail('unsafe-path', 'realpath returned an invalid or overlong absolute path')
    }
    return resolve(canonical)
  }

  private async assertPathAbsent(path: string): Promise<void> {
    try {
      await this.fs.lstat(path)
    } catch (error) {
      if (this.isNotFound(error)) return
      fail('path-check-failed', `cannot inspect target path: ${safeErrorMessage(error)}`)
    }
    fail('target-exists', `target path '${path}' already exists`)
  }

  private isNotFound(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'code' in error
      && (error as { code?: unknown }).code === 'ENOENT'
  }

  private async discover(cwd: string): Promise<{ commonDir: string; topLevel: string }> {
    const canonicalCwd = await this.existingPath(cwd)
    const [topLevelResult, commonResult] = await Promise.all([
      this.gitChecked(canonicalCwd, ['rev-parse', '--show-toplevel']),
      this.gitChecked(canonicalCwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
    ])
    const topLevel = await this.existingPath(this.singleLine(topLevelResult.stdout, 'worktree root'))
    const commonDir = await this.existingPath(this.singleLine(commonResult.stdout, 'Git common directory'))
    return { commonDir, topLevel }
  }

  private async snapshotDiscover(
    cwd: string,
    deadline: number,
  ): Promise<{ commonDir: string; topLevel: string }> {
    if (this.now() >= deadline) {
      fail('snapshot-deadline', `snapshot exceeded its ${SNAPSHOT_DEADLINE_MS}ms Git probe budget`)
    }
    const canonicalCwd = await this.existingPath(cwd)
    const [topLevelResult, commonResult] = await Promise.all([
      this.snapshotGitChecked(canonicalCwd, ['rev-parse', '--show-toplevel'], deadline),
      this.snapshotGitChecked(
        canonicalCwd,
        ['rev-parse', '--path-format=absolute', '--git-common-dir'],
        deadline,
      ),
    ])
    const topLevel = await this.existingPath(this.singleLine(topLevelResult.stdout, 'worktree root', MAX_PATH_LENGTH))
    const commonDir = await this.existingPath(this.singleLine(
      commonResult.stdout,
      'Git common directory',
      MAX_PATH_LENGTH,
    ))
    return { commonDir, topLevel }
  }

  private async topology(cwd: string): Promise<WorktreeTopology> {
    const discovered = await this.discover(cwd)
    const parsed = await this.listWorktreesWith(async args => this.gitCommand(discovered.topLevel, args, false))
    const worktrees: RawWorktree[] = []
    const paths = new Set<string>()
    for (const entry of parsed) {
      const path = await this.existingPath(entry.path)
      if (paths.has(path)) fail('git-protocol-error', `Git returned duplicate worktree path '${path}'`)
      paths.add(path)
      worktrees.push({ ...entry, path })
    }
    if (worktrees[0]!.bare) fail('bare-repository', 'bare repositories cannot own this lifecycle')
    if (!paths.has(discovered.topLevel)) fail('git-protocol-error', 'Git omitted the current worktree from its topology')
    return { commonDir: discovered.commonDir, mainPath: worktrees[0]!.path, worktrees }
  }

  private singleLine(output: string, label: string, maxLength = 4_096): string {
    const value = output.replace(/\r?\n$/u, '')
    if (value.length === 0 || value.length > maxLength || /[\r\n\0]/u.test(value)) {
      fail('git-protocol-error', `Git returned an invalid or overlong ${label}`)
    }
    return value
  }

  private async assertBranchFormat(cwd: string, branch: string): Promise<void> {
    const result = await this.gitCommand(cwd, ['check-ref-format', '--branch', branch])
    if (result.exitCode !== 0) fail('invalid-branch', `Git rejected local branch '${branch}'`)
  }

  /** Local branch head, or null when the branch does not exist. Git versions
   *  disagree on the missing-ref exit code (`show-ref --verify` exits 1 in
   *  some, 128 with `fatal: ... not a valid ref` in others) — ANY non-zero
   *  exit means "branch absent" for this fixed invocation; a genuinely broken
   *  git would have failed the earlier rev-parse/worktree reads already.
   *  (2026-08 fix: exit 128 was misreported as a hard git-command-failed.) */
  private async localBranchHead(cwd: string, branch: string): Promise<string | null> {
    const result = await this.gitCommand(cwd, ['show-ref', '--hash', '--verify', `refs/heads/${branch}`])
    if (result.exitCode !== 0) return null
    const head = this.singleLine(result.stdout, 'local branch head').toLowerCase()
    if (!/^[0-9a-f]{40,64}$/u.test(head)) fail('git-protocol-error', 'Git returned an invalid local branch head')
    return head
  }

  private async isDirty(path: string): Promise<boolean> {
    const result = await this.gitChecked(path, ['status', '--porcelain=v1', '-z', '--untracked-files=normal'])
    return result.stdout.length > 0
  }

  private async gitChecked(cwd: string, args: readonly string[], mutation = false): Promise<GitCommandResult> {
    const result = await this.gitCommand(cwd, args, mutation)
    if (result.exitCode !== 0) this.gitExitError(result, args[0] ?? 'unknown')
    return result
  }

  private async snapshotGitChecked(
    cwd: string,
    args: readonly string[],
    deadline: number,
    perCommandLimit = READ_TIMEOUT_MS,
  ): Promise<GitCommandResult> {
    const remaining = deadline - this.now()
    if (remaining <= 0) {
      fail('snapshot-deadline', `snapshot exceeded its ${SNAPSHOT_DEADLINE_MS}ms Git probe budget`)
    }
    const result = await this.gitCommand(cwd, args, false, Math.max(1, Math.min(perCommandLimit, remaining)))
    if (result.exitCode !== 0) this.gitExitError(result, args[0] ?? 'unknown')
    return result
  }

  /** List a repository's worktrees from the snapshot path, honoring the probe
   *  deadline. Delegates to the shared `-z`/newline fallback below. */
  private async listWorktrees(cwd: string, deadline: number): Promise<RawWorktree[]> {
    return this.listWorktreesWith(async args => {
      const remaining = deadline - this.now()
      if (remaining <= 0) {
        fail('snapshot-deadline', `snapshot exceeded its ${SNAPSHOT_DEADLINE_MS}ms Git probe budget`)
      }
      return this.gitCommand(cwd, args, false, Math.max(1, Math.min(READ_TIMEOUT_MS, remaining)))
    })
  }

  /**
   * Read `git worktree list --porcelain`, preferring the NUL-delimited `-z`
   * form and falling back to the newline-delimited form when the running Git
   * predates `-z` (added in Git 2.47). An older Git rejects the unknown
   * `-z` switch with a usage error — exit 129 — which is unambiguous here
   * because the `-z` invocation is valid on every Git that recognizes it.
   */
  private async listWorktreesWith(
    run: (args: readonly string[]) => Promise<GitCommandResult>,
  ): Promise<RawWorktree[]> {
    const withZ = await run(['worktree', 'list', '--porcelain', '-z'])
    if (withZ.exitCode === 129) {
      const withoutZ = await run(['worktree', 'list', '--porcelain'])
      if (withoutZ.exitCode !== 0) this.gitExitError(withoutZ, 'worktree')
      return parseWorktreePorcelain(withoutZ.stdout, '\n')
    }
    if (withZ.exitCode !== 0) this.gitExitError(withZ, 'worktree')
    return parseWorktreePorcelain(withZ.stdout, '\0')
  }

  /** Local branch names for the existing-branch picker (`show-ref --heads`).
   *  A convenience read: any failure (git down, budget exhausted) yields an
   *  empty list and must never fail or stall the snapshot. */
  private async listBranches(cwd: string, deadline: number): Promise<string[]> {
    if (this.now() >= deadline) return []
    let result: GitCommandResult
    try {
      result = await this.gitCommand(cwd, ['show-ref', '--heads'], false, READ_TIMEOUT_MS)
    } catch {
      return []
    }
    if (result.exitCode !== 0) return []
    const branches: string[] = []
    for (const line of result.stdout.split('\n')) {
      const match = /^[0-9a-fA-F]{40,64}\s+refs\/heads\/(.+)$/u.exec(line)
      if (match !== null && match[1] !== '' && !match[1]!.startsWith('-')) branches.push(match[1]!)
    }
    return branches
  }

  private async gitCommand(
    cwd: string,
    args: readonly string[],
    mutation = false,
    readTimeoutMs = READ_TIMEOUT_MS,
  ): Promise<GitCommandResult> {
    if (!isAbsolute(cwd)) fail('unsafe-git-cwd', 'Git cwd must be absolute')
    assertSafeGitArgv(args)
    const maxOutputBytes = mutation ? MUTATION_OUTPUT_CAP : READ_OUTPUT_CAP
    const result = await this.git({
      cwd,
      args: [...args],
      timeoutMs: mutation ? MUTATION_TIMEOUT_MS : readTimeoutMs,
      maxOutputBytes,
    })
    if (!Number.isInteger(result.exitCode) || typeof result.stdout !== 'string' || typeof result.stderr !== 'string') {
      fail('git-runner-invalid', 'Git runner returned an invalid result')
    }
    if (Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) > maxOutputBytes) {
      fail('git-output-limit', 'Git runner exceeded the bounded response limit')
    }
    return result
  }

  private gitExitError(result: GitCommandResult, operation: string): never {
    const detail = result.stderr.trim() || result.stdout.trim()
    fail('git-command-failed', `Git ${operation} failed with exit ${result.exitCode}${detail ? `: ${safeErrorMessage(detail)}` : ''}`)
  }

  private uniquePreviewToken(): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const token = previewToken(this.nextToken())
      if (!this.previews.has(token)) return token
    }
    fail('token-collision', 'could not allocate a unique preview token')
  }

  private publicPreview(preview: PreviewRecord): PreviewCreateResult {
    return {
      previewToken: preview.previewToken,
      expiresAt: preview.expiresAt,
      repoId: preview.repoId,
      commonDir: preview.commonDir,
      mainPath: preview.mainPath,
      targetPath: preview.targetPath,
      branch: preview.branch,
      baseHead: preview.baseHead,
    }
  }

  private evictOldestCreateOperationIfFull(): void {
    if (this.createOperations.size < this.operationCapacity) return
    let oldest: { id: string; updatedAt: number } | undefined
    for (const [id, record] of this.createOperations) {
      // Capacity pressure may discard only a proven no-admission failure. An
      // uncertain/created/rolled-back record is an idempotency tombstone and/or
      // rollback provenance; evicting it early would permit ABA mutation.
      if (record.state !== 'ready'
        || record.attemptedCreate
        || record.attemptedRollback
        || record.facts !== undefined
        || record.createResult !== undefined
        || record.rollbackResult !== undefined) continue
      if (oldest === undefined || record.updatedAt < oldest.updatedAt) {
        oldest = { id, updatedAt: record.updatedAt }
      }
    }
    if (oldest !== undefined) this.createOperations.delete(oldest.id)
  }

  private evictOldestRemoveOperationIfFull(): void {
    if (this.removeOperations.size < this.operationCapacity) return
    let oldest: { id: string; updatedAt: number } | undefined
    for (const [id, record] of this.removeOperations) {
      // A bound intent or attempted removal is a safety tombstone until TTL;
      // only a pre-admission ready failure is safe to forget early.
      if (record.state !== 'ready'
        || record.attemptedRemove
        || record.intent !== undefined
        || record.result !== undefined) continue
      if (oldest === undefined || record.updatedAt < oldest.updatedAt) {
        oldest = { id, updatedAt: record.updatedAt }
      }
    }
    if (oldest !== undefined) this.removeOperations.delete(oldest.id)
  }

  private pruneCaches(): void {
    const now = this.now()
    for (const [token, preview] of this.previews) {
      if (preview.expiresAt <= now) this.previews.delete(token)
    }
    const terminalCutoff = now - OPERATION_TTL_MS
    for (const [id, record] of this.createOperations) {
      if (record.state !== 'creating'
        && record.state !== 'rolling-back'
        && record.updatedAt <= terminalCutoff) {
        this.createOperations.delete(id)
      }
    }
    for (const [id, record] of this.removeOperations) {
      if (record.state !== 'removing' && record.updatedAt <= terminalCutoff) {
        this.removeOperations.delete(id)
      }
    }
  }
}
