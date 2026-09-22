/**
 * core-validation.ts — Untrusted-input validation helpers and the node filesystem adapter.
 *
 */
import { GitWorktreeError } from './core-errors.ts'
import { GIT_DIR_POINTER_MAX_BYTES } from './core-parse.ts'
import type { CreateInput, PreviewCreateInput, RemoveInput, RollbackCreateInput, WorktreeFileSystem } from './core-types.ts'
import { createHash } from 'node:crypto'
import { access, lstat, mkdir, open, realpath } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'

export const nodeFileSystem: WorktreeFileSystem = {
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

export function fail(code: string, message: string): never {
  throw new GitWorktreeError(code, message)
}

export function safeErrorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.replace(/[\r\n\t]+/g, ' ').slice(0, 512)
}

export function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('invalid-input', `${label} must be an object`)
  }
}

export function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const allowed = new Set(keys)
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail('invalid-input', `${label} contains unsupported field '${key}'`)
  }
  for (const key of keys) {
    if (!(key in value)) fail('invalid-input', `${label}.${key} is required`)
  }
}

export function requiredString(value: unknown, label: string, max = 1024): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail('invalid-input', `${label} must be a non-empty bounded string without control characters`)
  }
  return value
}

export function operationId(value: unknown): string {
  const id = requiredString(value, 'operationId', 128)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(id)) {
    fail('invalid-input', 'operationId contains unsupported characters')
  }
  return id
}

export function previewToken(value: unknown): string {
  const token = requiredString(value, 'previewToken', 128)
  if (!/^[A-Za-z0-9-]+$/u.test(token)) fail('invalid-input', 'previewToken is malformed')
  return token
}

export function safeBasename(value: unknown): string {
  const name = requiredString(value, 'basename', 255)
  if (name !== name.trim() || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    fail('unsafe-path', 'basename must be one trimmed path segment')
  }
  if (Buffer.byteLength(name, 'utf8') > 255) fail('unsafe-path', 'basename is too long')
  return name
}

export function safeBranchName(value: unknown, label = 'branch.name'): string {
  const name = requiredString(value, label, 1024)
  if (name.startsWith('-') || name.startsWith('/') || name.endsWith('/') || name.includes('\\')) {
    fail('invalid-branch', `${label} is not a safe local branch name`)
  }
  return name
}

export function absoluteExpectedPath(value: unknown, label: string): string {
  const path = requiredString(value, label, 4096)
  if (!isAbsolute(path) || resolve(path) !== path) {
    fail('unsafe-path', `${label} must be a normalized absolute path`)
  }
  return path
}

export function objectFingerprint(value: unknown): string {
  return JSON.stringify(value)
}

export function opaqueId(kind: 'repo' | 'worktree', ...parts: readonly string[]): string {
  const digest = createHash('sha256')
  digest.update(kind)
  for (const part of parts) {
    digest.update('\0')
    digest.update(part)
  }
  return `${kind}_${digest.digest('hex')}`
}

export function expectedOpaqueId(value: unknown, kind: 'repo' | 'worktree'): string {
  const id = requiredString(value, `input.expected.${kind}Id`, 80)
  if (!new RegExp(`^${kind}_[0-9a-f]{64}$`, 'u').test(id)) {
    fail('invalid-input', `input.expected.${kind}Id is malformed`)
  }
  return id
}

export function parsePreviewInput(value: PreviewCreateInput): PreviewCreateInput {
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

export function parseCreateInput(value: CreateInput): CreateInput {
  assertRecord(value, 'input')
  assertExactKeys(value, ['previewToken', 'operationId'], 'input')
  return { previewToken: previewToken(value.previewToken), operationId: operationId(value.operationId) }
}

export function parseRollbackInput(value: RollbackCreateInput): RollbackCreateInput {
  assertRecord(value, 'input')
  assertExactKeys(value, ['operationId'], 'input')
  return { operationId: operationId(value.operationId) }
}

export function parseRemoveInput(value: RemoveInput): RemoveInput {
  assertRecord(value, 'input')
  // deleteBranch / discardChanges are OPTIONAL (assertExactKeys requires
  // presence, so the allowed set + the required subset are checked inline).
  {
    const allowed = new Set(['operationId', 'workspaceId', 'path', 'expected', 'deleteBranch', 'discardChanges'])
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
    discardChanges: value.discardChanges === undefined
      ? undefined
      : (typeof value.discardChanges === 'boolean'
          ? value.discardChanges
          : fail('invalid-input', 'input.discardChanges must be a boolean')),
    path: value.path === undefined
      ? undefined
      : (value.workspaceId !== undefined
          ? fail('invalid-input', "input.path and input.workspaceId are mutually exclusive")
          : absoluteExpectedPath(value.path, 'input.path')),
  }
}

export function sameArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

export function sameMembership(left: readonly string[], right: readonly string[]): boolean {
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
  // Optional branch deletion after worktree removal (design 08 §5.3 user
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
  // Explicit discard of uncommitted state (design 08 §5.3 amendment):
  // `worktree remove --force` is authorized only by the
  // `discardChanges` input flag — the fixed grammar here is the last line of
  // defense (the git runner itself never passes --force otherwise).
  if (verb === 'worktree' && rest.length === 4 && rest[0] === 'remove' && rest[1] === '--force'
    && rest[2] === '--' && isAbsolute(rest[3]!)) return

  fail('unsafe-git-argv', `Git command '${verb ?? '<empty>'}' is outside the worktree allowlist`)
}

/**
 * Fixed `-c core.hooksPath=<nul>` guard prepended to every plugin git spawn.
 * Command-line `-c` is the highest-precedence config source, so a repository's
 * own `core.hooksPath` (which would otherwise re-enable `post-checkout` on
 * `worktree add`) cannot override it. Read commands ignore hooksPath.
 */
