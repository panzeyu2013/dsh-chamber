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
 * is worse: its aggregate keeps the pushed workspace set frozen (the mounted
 * merge in `commitAggregatePull` replaces sessions only) and
 * `planAggregateRefreshes` never unary-polls a pushed source at all — so the
 * `requestRefresh` the sidebar fires after a successful create cannot surface
 * the row either way.
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
 *   one-time, and strictly better than the duplicate row it prevents;
 * - a REAL row with the same path but another id wins (host identity is
 *   authoritative) and the echo row is not rendered at all;
 * - entries expire ({@link PENDING_WORKSPACE_TTL_MS}) and retire with their
 *   source ({@link forgetPendingWorkspaces}), so a create whose convergence
 *   never arrives cannot pin a phantom row for the rest of the session.
 *
 * The ledger lives in the renderer App layer (never persisted, never polled):
 * it is renderer-local echo state, exactly like the aggregate it decorates.
 */
import type { InstanceAggregate, WorkspaceRow } from './instance-api.ts'
import { basenameOf } from './instance-api.ts'
import { assertSingletonModule } from './singleton.ts'

assertSingletonModule('workspace-echo')

/** One echoed workspace creation (host id + path, plus its TTL anchor). */
export interface PendingWorkspace {
  workspaceId: string
  path: string
  /** Display title (path basename — the same rule the cwd-derived groups use). */
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
 * replaces the previous entry instead of stacking a duplicate row. Returns the
 * input ledger unchanged when the recorded entry is already identical.
 */
export function recordPendingWorkspace(
  ledger: WorkspaceEchoLedger,
  sourceId: string,
  created: { workspaceId: string; path: string },
  now: number,
): WorkspaceEchoLedger {
  const rows = ledger[sourceId] ?? []
  const previous = rows.find(row => row.path === created.path || row.workspaceId === created.workspaceId)
  const next: PendingWorkspace = {
    workspaceId: created.workspaceId,
    path: created.path,
    title: basenameOf(created.path),
    at: now,
  }
  if (
    previous !== undefined
    && previous.workspaceId === next.workspaceId
    && previous.path === next.path
    && previous.title === next.title
  ) {
    return ledger
  }
  const kept = rows.filter(row => row.path !== created.path && row.workspaceId !== created.workspaceId)
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
    realPaths.add(row.path)
  }
  const kept = rows.filter(row => !realIds.has(row.workspaceId) && !realPaths.has(row.path))
  if (kept.length === rows.length) return ledger
  const next: Record<string, readonly PendingWorkspace[]> = { ...ledger }
  if (kept.length === 0) delete next[sourceId]
  else next[sourceId] = kept
  return next
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
    realPaths.add(row.path)
  }
  const echoByPath = new Map<string, PendingWorkspace>()
  for (const entry of pending) {
    if (realIds.has(entry.workspaceId)) continue
    if (realPaths.has(entry.path)) continue
    echoByPath.set(entry.path, entry)
  }
  if (echoByPath.size === 0) return aggregate
  let replaced = false
  const nextRows: WorkspaceRow[] = []
  for (const row of rows) {
    const echo = row.synthetic === true ? echoByPath.get(row.path) : undefined
    if (echo === undefined) {
      nextRows.push(row)
      continue
    }
    echoByPath.delete(row.path)
    nextRows.push(workspaceEchoRow(echo))
    replaced = true
  }
  const appended: WorkspaceRow[] = []
  for (const entry of pending) {
    if (!echoByPath.has(entry.path)) continue
    if (echoByPath.get(entry.path) !== entry) continue
    appended.push(workspaceEchoRow(entry))
  }
  if (!replaced && appended.length === 0) return aggregate
  return { ...aggregate, workspaces: [...nextRows, ...appended] }
}
