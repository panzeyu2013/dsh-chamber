/**
 * Workspace creation echo — the local half of "新建工作区应立刻可见"
 * (design 05 §2.2 revision 2026-12; problem 2 of the 2026-12 field report).
 *
 * WHY an echo exists at all. The sidebar's per-source project is authoritative
 * only while that source's shell is MOUNTED: the official `workspace/follow`
 * baseline plus its `upsert` increments are the ONLY wire source of workspace
 * identity (upstream deleted `workspace.list`). For a source with no live
 * shell the chamber only has the unary fallback — `session.list` plus
 * cwd-derived SYNTHETIC groups (`fetchInstanceSnapshot`). A workspace created a
 * moment ago has NO sessions yet, so it appears in no session's cwd and is
 * structurally INVISIBLE in that projection; the row only shows up after the
 * user clicks the server (mount → follow baseline). A previously-pushed source
 * is worse: a source that was pushed and is no longer mounted (reclaimed) never
 * unary-polls again — `planAggregateRefreshes` skips pushed sources — and the
 * 30s unary merge that does run for never-pushed sources replaces sessions only,
 * so its pushed workspace set stays frozen. The `requestRefresh` the sidebar
 * fires after a successful create therefore cannot surface the row either way.
 * (A source whose shell IS mounted needs no echo: its own follow push carries
 * the new workspace — the echo is merely redundant there.)
 *
 * The echo closes that window with a fact the user's own action already
 * produced: a successful `workspace.create` returns the HOST workspace id
 * (`CreateWorkspaceResult`). The row is projected locally and immediately,
 * while the authoritative baseline converges later (the user mounting the
 * source, or the next push). It is deliberately NOT a second source of truth:
 *
 * - an authoritative row with the same `workspaceId` always wins, and the
 *   pending entry is dropped as soon as the id appears in a mounted push
 *   ({@link reconcilePendingWorkspaces});
 * - a cwd-derived SYNTHETIC row covering the same path is REPLACED by the echo
 *   row in place (the real host id wins; keeping both would render the same
 *   directory twice as soon as a session lands in it). The replacement swaps the
 *   row's IDENTITY, so per-workspace view preferences keyed `sourceId/workspaceId`
 *   (fold state, ungrouped order) do not follow it: the old synthetic key stays
 *   in the store unused (render-side lookup skips unknown ids — the documented
 *   accepted residue) and the group can appear expanded once. Cosmetic,
 *   one-time, and strictly better than the duplicate row it prevents. The
 *   replacement carries the replaced row's `sessionIds` (2026-09-11 review B1):
 *   an echo with no membership would drop the directory's sessions into
 *   未分组 for the whole TTL;
 * - a REAL row with the same path but another id wins (host identity is
 *   authoritative) and the echo row is not rendered at all;
 * - the SIDEBAR's own later actions on that same workspace are echoed too, on
 *   the same one-way channel (2026-09-11 review S3): a successful
 *   `workspace.delete` retires the entry ({@link removePendingWorkspace}) and a
 *   successful `workspace.rename` patches its title
 *   ({@link renamePendingWorkspace}). Both are needed for exactly the unmounted
 *   source the echo exists for: without the removal fact a create → delete left
 *   a GHOST row that even an authoritative mount push could not retire
 *   (reconciliation only drops echoes the baseline already covers) and kept
 *   real-id actions enabled for the whole TTL, and without the rename fact the
 *   rename looked like a no-op because an echo's title is `basenameOf(path)`;
 * - entries expire ({@link PENDING_WORKSPACE_TTL_MS}) and retire with their
 *   source ({@link forgetPendingWorkspaces}), so a create whose convergence
 *   never arrives cannot pin a phantom row for the rest of the session.
 *
 * The ledger lives in the renderer App layer (never persisted, never polled):
 * it is renderer-local echo state, exactly like the aggregate it decorates.
 */
import type { InstanceAggregate, WorkspaceRow } from './instance-api.ts'
import { basenameOf } from './instance-api.ts'
import { canonicalPathKey } from './derive.ts'
import { assertSingletonModule } from './singleton.ts'

assertSingletonModule('workspace-echo')

/** One echoed workspace creation (host id + path, plus its TTL anchor). */
export interface PendingWorkspace {
  workspaceId: string
  path: string
  /**
   * Display title — the path basename at record time (the same rule the
   * cwd-derived groups use). A later successful rename replaces it with the
   * user's own title ({@link renamePendingWorkspace}), so it is NOT
   * re-derivable from `path`.
   */
  title: string
  /** Epoch ms the echo was recorded; the TTL anchor. */
  at: number
}

/** Pending echoes keyed by source id. Absent key = nothing pending. */
export type WorkspaceEchoLedger = Readonly<Record<string, readonly PendingWorkspace[]>>

/**
 * How long an unconfirmed echo may stay in the projection. The authoritative
 * convergence is a MOUNT (the user clicking that source), which has no bounded
 * deadline, so the TTL is a leak guard rather than a convergence budget: a
 * workspace created elsewhere and then deleted on the host would otherwise
 * keep a dead row until the source is remounted. Ten minutes is far beyond any
 * realistic "click the server and look" delay while still bounding the state.
 */
export const PENDING_WORKSPACE_TTL_MS = 600_000

/** Project one pending echo into the wire row shape the aggregate carries. */
export function workspaceEchoRow(pending: PendingWorkspace): WorkspaceRow {
  return {
    workspaceId: pending.workspaceId,
    path: pending.path,
    title: pending.title,
    sessionIds: [],
    createdAt: '',
    updatedAt: '',
  }
}

/**
 * Record one successful `workspace.create`. Idempotent per path: the host
 * reuses an existing registration at the same path (`created: false` in the
 * create result) and may return the same id twice, so an equal re-record
 * replaces the previous entry instead of stacking a duplicate row. The
 * replacement always rebuilds the ledger — including for a byte-identical
 * re-record, whose TTL anchor is refreshed (see the note below); only a create
 * reaches this entry point, never a render or a clock tick, so the rebuilt
 * identity costs one publish.
 */
export function recordPendingWorkspace(
  ledger: WorkspaceEchoLedger,
  sourceId: string,
  created: { workspaceId: string; path: string },
  now: number,
): WorkspaceEchoLedger {
  const rows = ledger[sourceId] ?? []
  const key = canonicalPathKey(created.path)
  const next: PendingWorkspace = {
    workspaceId: created.workspaceId,
    path: created.path,
    title: basenameOf(created.path),
    at: now,
  }
  // The anchor is refreshed even when the entry is otherwise identical: this
  // runs once per create (never per render), so identity preservation buys
  // nothing, while a stale anchor would make a fresh action's echo — a host
  // that reuses an existing registration returns `created: false` — expire
  // seconds after the user asked for it.
  const kept = rows.filter(row => canonicalPathKey(row.path) !== key && row.workspaceId !== created.workspaceId)
  return { ...ledger, [sourceId]: [...kept, next] }
}

/** Drop echoes older than the TTL (identity-preserving when nothing expired). */
export function sweepPendingWorkspaces(ledger: WorkspaceEchoLedger, now: number): WorkspaceEchoLedger {
  let changed = false
  const next: Record<string, readonly PendingWorkspace[]> = {}
  for (const [sourceId, rows] of Object.entries(ledger)) {
    const kept = rows.filter(row => now - row.at < PENDING_WORKSPACE_TTL_MS)
    if (kept.length === rows.length) {
      next[sourceId] = rows
      continue
    }
    changed = true
    if (kept.length > 0) next[sourceId] = kept
  }
  return changed ? next : ledger
}

/**
 * Drop every echo the given AUTHORITATIVE workspace list already covers: the
 * same `workspaceId`, or the same `path` under a real (non-synthetic) id. The
 * mounted push is the convergence signal — once it lists the workspace, the
 * local echo has no job left and must not survive as a duplicate.
 */
export function reconcilePendingWorkspaces(
  ledger: WorkspaceEchoLedger,
  sourceId: string,
  authoritative: readonly WorkspaceRow[],
): WorkspaceEchoLedger {
  const rows = ledger[sourceId]
  if (rows === undefined || rows.length === 0) return ledger
  const realIds = new Set<string>()
  const realPaths = new Set<string>()
  for (const row of authoritative) {
    if (row.synthetic === true) continue
    realIds.add(row.workspaceId)
    realPaths.add(canonicalPathKey(row.path))
  }
  const kept = rows.filter(row => !realIds.has(row.workspaceId) && !realPaths.has(canonicalPathKey(row.path)))
  if (kept.length === rows.length) return ledger
  const next: Record<string, readonly PendingWorkspace[]> = { ...ledger }
  if (kept.length === 0) delete next[sourceId]
  else next[sourceId] = kept
  return next
}

/**
 * Retire the echo of one DELETED workspace — the withdraw half of the echo
 * (2026-09-11 review S3). Matching is by EITHER identity: the host
 * `workspaceId` (the primary key — the create result returned it, and the row's
 * delete action carries it) or the same canonical path. The path is
 * best-effort: `key.path` is empty when the source's mounted snapshot has not
 * reported the workspace, and an empty path carries no path information at all,
 * so it never matches (only the id does).
 *
 * Identity-preserving: a ledger with nothing matching (unknown source, or no
 * row carrying the id/path) is returned by reference, so the App's publish
 * signature gate stays quiet on a redundant fact.
 */
export function removePendingWorkspace(
  ledger: WorkspaceEchoLedger,
  sourceId: string,
  key: { workspaceId: string; path: string },
): WorkspaceEchoLedger {
  const rows = ledger[sourceId]
  if (rows === undefined || rows.length === 0) return ledger
  const pathKey = key.path === '' ? undefined : canonicalPathKey(key.path)
  const kept = rows.filter(row =>
    row.workspaceId !== key.workspaceId
    && (pathKey === undefined || canonicalPathKey(row.path) !== pathKey))
  if (kept.length === rows.length) return ledger
  const next: Record<string, readonly PendingWorkspace[]> = { ...ledger }
  if (kept.length === 0) delete next[sourceId]
  else next[sourceId] = kept
  return next
}

/**
 * Patch the title of one echo after a successful `workspace.rename` — the patch
 * half of the echo (2026-09-11 review S3). An echo row's title is its path
 * basename, so this is the only way a renamed workspace shows its new name
 * before the source mounts. Identity-preserving when the source/id is absent or
 * the recorded title already matches.
 */
export function renamePendingWorkspace(
  ledger: WorkspaceEchoLedger,
  sourceId: string,
  workspaceId: string,
  title: string,
): WorkspaceEchoLedger {
  const rows = ledger[sourceId]
  if (rows === undefined || rows.length === 0) return ledger
  let changed = false
  const next = rows.map((row) => {
    if (row.workspaceId !== workspaceId || row.title === title) return row
    changed = true
    return { ...row, title }
  })
  return changed ? { ...ledger, [sourceId]: next } : ledger
}

/** Retire the echoes of sources that left the registry (same-id re-add = new generation). */
export function forgetPendingWorkspaces(
  ledger: WorkspaceEchoLedger,
  retired: ReadonlySet<string>,
): WorkspaceEchoLedger {
  let changed = false
  const next: Record<string, readonly PendingWorkspace[]> = { ...ledger }
  for (const sourceId of retired) {
    if (next[sourceId] === undefined) continue
    delete next[sourceId]
    changed = true
  }
  return changed ? next : ledger
}

/**
 * Project one aggregate WITH its pending echoes merged in.
 *
 * Pure projection only — the aggregate itself is never mutated, so the
 * authoritative commit paths stay untouched and the echo disappears the moment
 * the ledger entry does. Identity-preserving: an aggregate with nothing to add
 * (or nothing to replace) is returned by reference, which keeps the sidebar
 * publish signature stable across derive passes.
 *
 * Placement: a replaced synthetic group keeps its slot (the directory does not
 * jump); brand-new echoes append at the tail, which is also where the host's
 * own creation order puts a workspace created last.
 */
export function withWorkspaceEcho(
  aggregate: InstanceAggregate,
  pending: readonly PendingWorkspace[] | undefined,
): InstanceAggregate {
  if (pending === undefined || pending.length === 0) return aggregate
  // Only a committed ok aggregate carries a real workspace list; error and
  // not-connected aggregates render their own state and have none.
  if (aggregate.state !== 'ok') return aggregate
  const rows = aggregate.workspaces
  const realIds = new Set<string>()
  const realPaths = new Set<string>()
  for (const row of rows) {
    if (row.synthetic === true) continue
    realIds.add(row.workspaceId)
    realPaths.add(canonicalPathKey(row.path))
  }
  const echoByPath = new Map<string, PendingWorkspace>()
  for (const entry of pending) {
    if (realIds.has(entry.workspaceId)) continue
    const key = canonicalPathKey(entry.path)
    if (realPaths.has(key)) continue
    echoByPath.set(key, entry)
  }
  if (echoByPath.size === 0) return aggregate
  let replaced = false
  const nextRows: WorkspaceRow[] = []
  for (const row of rows) {
    const echo = row.synthetic === true ? echoByPath.get(canonicalPathKey(row.path)) : undefined
    if (echo === undefined) {
      nextRows.push(row)
      continue
    }
    echoByPath.delete(canonicalPathKey(row.path))
    // B1 (2026-09-11 review): a replaced group keeps its MEMBERSHIP. Sessions
    // reach a group only through `workspace.sessionIds` (derive.ts), so an echo
    // row carrying `sessionIds: []` dropped every member of that directory into
    // 未分组 for the echo's whole TTL (10 min), and each 30s unary pull
    // re-created the synthetic group only to be replaced again. The cwd-derived
    // membership is the best local knowledge until the mount push supplies the
    // host's own row, which carries exactly these members for that directory.
    nextRows.push({ ...workspaceEchoRow(echo), sessionIds: row.sessionIds })
    replaced = true
  }
  const appended: WorkspaceRow[] = []
  for (const entry of pending) {
    const key = canonicalPathKey(entry.path)
    if (!echoByPath.has(key)) continue
    if (echoByPath.get(key) !== entry) continue
    appended.push(workspaceEchoRow(entry))
  }
  if (!replaced && appended.length === 0) return aggregate
  return { ...aggregate, workspaces: [...nextRows, ...appended] }
}
