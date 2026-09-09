/** Pure Git-topology derivations shared by the UI and coordinator tests. */
import type { GitRepoTopology, GitWorktreeInfo, GitWorktreeSnapshot } from './types.ts'

export interface CreateSourceOption {
  workspaceId: string
  repoId: string
  label: string
}

function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const parts = trimmed.split(/[\\/]/)
  return parts.at(-1) || path
}

/** One option per repository that currently has at least one registered
 *  workspace. The source is ALWAYS the repository's MAIN checkout (no
 *  second-level derivation — OpenChamber parity), falling back to the first
 *  registered workspace only when the main checkout has none. */
export function createSourceOptions(snapshot: GitWorktreeSnapshot): CreateSourceOption[] {
  const out: CreateSourceOption[] = []
  for (const repo of snapshot.repos) {
    const main = repo.worktrees.find((worktree): worktree is GitWorktreeInfo & { workspaceId: string } => (
      worktree.isMain && worktree.workspaceId !== null
    ))
    const source = main ?? repo.worktrees.find((worktree): worktree is GitWorktreeInfo & { workspaceId: string } => (
      worktree.workspaceId !== null
    ))
    if (source === undefined) continue
    out.push({ workspaceId: source.workspaceId, repoId: repo.repoId, label: basename(repo.mainPath) })
  }
  return out
}

export function findWorktree(
  snapshot: GitWorktreeSnapshot,
  repoId: string,
  worktreeId: string,
): { repo: GitRepoTopology; worktree: GitWorktreeInfo } | undefined {
  const repo = snapshot.repos.find(row => row.repoId === repoId)
  const worktree = repo?.worktrees.find(row => row.worktreeId === worktreeId)
  return repo === undefined || worktree === undefined ? undefined : { repo, worktree }
}

/**
 * Base-ref picker options for the create dialog: the host's branch list
 * (`git show-ref --heads`) when it has any, otherwise the selected
 * repository's own worktree branches, deduplicated in row order.
 *
 * The main checkout's branch is deliberately INCLUDED. The host accepts it as
 * `startRef` (`localBranchHead` resolves it to that branch's HEAD commit), and
 * the picker previously filtered it out because it is the implicit default —
 * which made it unreachable once any other branch had ever been chosen, and
 * left a single-branch repository with an empty picker (2026-12 user report:
 * "cannot use main / the main checkout as the base").
 * @param repoBranches - Host branch list for the selected repository.
 * @param worktreeBranches - The same repository's worktree branches (fallback; `null` = detached).
 * @returns The picker options, never filtered against the main checkout branch.
 */
export function sourceBranchChoices(
  repoBranches: readonly string[],
  worktreeBranches: readonly (string | null)[],
): string[] {
  if (repoBranches.length > 0) return [...repoBranches]
  const seen = new Set<string>()
  const out: string[] = []
  for (const branch of worktreeBranches) {
    if (branch !== null && !seen.has(branch)) {
      seen.add(branch)
      out.push(branch)
    }
  }
  return out
}

export interface WorktreeWithRepo {
  repoId: string
  worktree: GitWorktreeInfo
}

/** All git rows registered to one workspace (workspace-centric discovery). */
export function gitFactsForWorkspace(
  snapshot: GitWorktreeSnapshot,
  workspaceId: string,
): WorktreeWithRepo[] {
  const out: WorktreeWithRepo[] = []
  for (const repo of snapshot.repos) {
    for (const worktree of repo.worktrees) {
      if (worktree.workspaceId === workspaceId) out.push({ repoId: repo.repoId, worktree })
    }
  }
  return out
}

export type RemoveBlockReason =
  | 'main'
  | 'unregistered'
  | 'running'
  | 'current'
  | 'runtime-unknown'
  | 'locked'
  | 'unhealthy'
  | 'dirty'
  | 'status-unknown'
  | undefined

/**
 * Safe-remove guard: both fresh running facts and the aggregate current id
 * block removal. `runtimeKnown` is the fail-closed half (2026-09 scan): the
 * per-source `runtime` channel (which carries `current`) withdraws while its
 * shell reconnects/reloads — treating the resulting `undefined` current as
 * "not current" would silently open the removal of a worktree holding the
 * very session the user is viewing. When the runtime channel is absent AND
 * the worktree accounts sessions, removal is blocked ('runtime-unknown')
 * until the channel returns.
 *
 * The RUNNING reason reads the host's ARCHIVED-AWARE fact (design 08 §6
 * amendment, 2026-09 user decision): `blockingRunningSessionIds` names only
 * the running sessions that actually gate removal — archived sessions (and
 * sessions under an archived ancestor) are INERT and do not block. The field
 * is ABSENT on an older host, and the fallback to `runningSessionIds` keeps
 * that case conservative (any running session blocks). A removal never touches
 * a session either way.
 *
 * PRECEDENCE (2026-12 review G1-1): `current` and `runtime-unknown` are
 * evaluated BEFORE `running`. The RUNNING reason is NOT a hard client block —
 * the row deliberately keeps the delete control enabled for it (the dialog
 * explains the running facts and the host re-checks with its `running-agent`
 * guard) — so letting it win would shadow the two fail-closed refusals: a
 * worktree whose STALE snapshot still lists running sessions (or whose running
 * set is non-blocking/archived) would then bypass the current-session guard
 * and the runtime-absent fail-closed guard in `coordinator.ts`'s fresh
 * preflight, and the removal could proceed while the current session's cwd is
 * unknown.
 */
export function removeBlockReason(
  worktree: GitWorktreeInfo,
  currentSessionId?: string,
  currentSessionBlank = false,
  runtimeKnown = true,
): RemoveBlockReason {
  if (worktree.isMain) return 'main'
  if (worktree.workspaceId === null) return 'unregistered'
  // A BLANK (never-submitted) current session carries no content worth
  // protecting, so it must not block removal (2026-08 user report: clicking
  // "new session" on a worktree and removing it before typing).
  if (currentSessionId !== undefined && !currentSessionBlank && worktree.sessionIds.includes(currentSessionId)) return 'current'
  // Fail-closed: the runtime channel is absent (withdrawn/not-yet-ready), so
  // we cannot rule the current session out of this worktree. Blank-current
  // leniency cannot apply — blankness is unknown too.
  if (!runtimeKnown && worktree.sessionIds.length > 0) return 'runtime-unknown'
  const blockingRunning = worktree.blockingRunningSessionIds ?? worktree.runningSessionIds
  if (blockingRunning.length > 0) return 'running'
  if (worktree.locked) return 'locked'
  if (worktree.status !== 'ready') return 'unhealthy'
  if (worktree.dirty === true) return 'dirty'
  if (worktree.dirty === null) return 'status-unknown'
  return undefined
}

/** A new session can target a worktree only while the path is healthy. */
export function canTargetSession(worktree: GitWorktreeInfo): boolean {
  return worktree.status === 'ready'
}

/**
 * Session closure over `parentSessionId`: the roots plus every session
 * transitively parented under them (cycle-safe, order stable). Used to
 * enumerate the full session tree a worktree removal would orphan.
 *
 * This is the FORK closure over the VISIBLE (non-subagent) session rows: the
 * caller's row source is `fetchInstanceSnapshot`, which DROPS subagent-origin
 * rows upstream (`@dsh-chamber/dsh-client-ui-sidebar/shared` instance-api
 * filters `origin === 'subagent'`), so every edge this function can see is a
 * fork edge — and a fork IS a worktree session by construction, so it belongs
 * in the closure. Vendor evidence (dsh-api-session-controller/lib/index.js):
 * `fork()` copies the source header's cwd into the child
 * (`meta: { ...(source.header.cwd === undefined ? {} : { cwd: source.header.cwd }), parentSession: source.header.id, isSeeded: true }`,
 * ~:695-700) and attaches the child to the SOURCE's workspace through
 * `forkWorkspace(source.header)` (:683 → workspace lookup over
 * `workspaceRegistry.list()` by `sessionIds`, :872-883) plus
 * `workspace.attachSession(childId)` (:712-714). The fork therefore shares the
 * worktree cwd AND is a member of the same workspace, which is exactly why
 * archiving it is the intended semantics of 「归档工作区中会话」 (it is not an
 * unrelated session). Subagent-origin rows are NOT part of this closure by
 * construction; do NOT add an `origin === 'subagent'` filter here — it would
 * collapse the closure to the roots and silently drop the forks the option
 * must archive (2026-12 review correction; the subagent-only purge/stop
 * closure lives in the sidebar's `sessionPurgeClosure`, which reads the raw
 * `session/list` rows instead).
 */
export function collectSessionClosure(
  sessions: ReadonlyArray<{ readonly sessionId: string; readonly parentSessionId?: string }>,
  roots: ReadonlyArray<string>,
): string[] {
  const byParent = new Map<string, string[]>()
  for (const session of sessions) {
    if (session.parentSessionId === undefined) continue
    const siblings = byParent.get(session.parentSessionId)
    if (siblings === undefined) byParent.set(session.parentSessionId, [session.sessionId])
    else siblings.push(session.sessionId)
  }
  const seen = new Set<string>(roots)
  const queue = [...roots]
  while (queue.length > 0) {
    const parent = queue.shift()!
    for (const child of byParent.get(parent) ?? []) {
      if (!seen.has(child)) {
        seen.add(child)
        queue.push(child)
      }
    }
  }
  return [...seen]
}
