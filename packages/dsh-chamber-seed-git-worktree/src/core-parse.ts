/**
 * Git output parsing, attention probes and DSH_HOME resolution.
 */
import { GIT_DIR_POINTER_MAX_BYTES, MAX_PATH_LENGTH } from './core-constants.ts'
import { GitWorktreeError } from './core-errors.ts'
import type { RawWorktree } from './core-internals.ts'
import type { GitAttentionReason, WorktreeFileSystem } from './core-types.ts'
import { fail } from './core-validation.ts'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

/** Parse the `--branch` status header; numbers come from LOCAL refs - honest, never fetched. */
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
  // Git rejects ref names containing '..', so '...' cannot appear inside a branch name.
  const sep = namePart.indexOf('...')
  return {
    upstream: sep >= 0 ? (namePart.slice(sep + 3) || null) : null,
    ahead,
    behind,
  }
}

/**
 * Parse `git worktree list --porcelain` in either NUL-delimited (`-z`, Git 2.47+) or
 * newline-delimited form. The record grammar is identical: fields are delimiter-separated
 * and a blank field closes the current record.
 */
export function parseWorktreePorcelain(output: string, delimiter: '\0' | '\n' = '\0'): RawWorktree[] {
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
        missing: false,
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

export const ZERO_HEAD = /^0+$/u

/** git-dir state files that mark an in-progress Git operation (best-effort). */
export const ATTENTION_PROBES: ReadonlyArray<{ readonly name: string; readonly reason: GitAttentionReason }> = [
  { name: 'MERGE_HEAD', reason: 'merge' },
  { name: 'REBASE_HEAD', reason: 'rebase' },
  { name: 'rebase-merge', reason: 'rebase' },
  { name: 'rebase-apply', reason: 'rebase' },
  { name: 'CHERRY_PICK_HEAD', reason: 'cherry-pick' },
  { name: 'REVERT_HEAD', reason: 'revert' },
  { name: 'BISECT_LOG', reason: 'bisect' },
]

export function isNotARepositoryError(error: unknown): boolean {
  return error instanceof GitWorktreeError && /not a git repository/i.test(error.message)
}

/**
 * The worktree's git dir: `<path>/.git` when it is a directory, otherwise the target of
 * its `gitdir:` pointer file (linked worktrees), resolved against the worktree path when
 * relative.
 */
export async function worktreeGitDir(path: string, fs: WorktreeFileSystem): Promise<string | null> {
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
export async function detectAttention(
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

/** Environment variable naming the single DeepSeek Harness home. */
export const DSH_HOME_ENV = 'DSH_HOME'

/** The default harness home under the OS home (`~/.dsh`). */
export function defaultDshHome(): string {
  return join(homedir(), '.dsh')
}

/** Expand `~`, `~/` and `~\\` against the OS home; anything else is returned unchanged. */
export function expandHomePath(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/** Local mirror of upstream `resolveDshHome` (it ships as one esbuild bundle, so this
 *  in-instance plugin cannot import it). Precedence: explicit `configured`, then
 *  `$DSH_HOME`, then `~/.dsh`; an empty/whitespace-only `$DSH_HOME` counts as UNSET.
 *  LOCKSTEP: keep this behavior identical to the upstream function. */
export function resolveDshHome(configured?: string, env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env[DSH_HOME_ENV]
  const selected = configured ?? (fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : defaultDshHome())
  return resolve(expandHomePath(selected))
}
