/**
 * Workspace creation echo — the local half of "新建工作区应立刻可见".
 * (design 05 §2.2 revision). The workspace-side sibling of session-echo.ts.
 *
 * WHY: the per-source project is authoritative only while that source's shell is
 * MOUNTED (the official `workspace/follow` baseline is the only wire source of
 * workspace identity). An unmounted source has only the unary fallback
 * (`session.list` + cwd-derived SYNTHETIC groups), and a workspace created a
 * moment ago has NO sessions — it appears in no session's cwd, so it is
 * structurally INVISIBLE until a mount; a previously-pushed source never
 * unary-polls its workspace set again.
 *
 * The echo closes that window with the fact the user's action produced: a
 * successful `workspace.create` returns the HOST workspace id, projected locally
 * while the authoritative baseline converges. NOT a second source of truth: an
 * authoritative row with the same `workspaceId` wins and drops the pending entry
 * ({@link reconcilePendingWorkspaces}); a cwd-derived SYNTHETIC row for the same
 * path is REPLACED in place (real id wins, its `sessionIds` carried over or the
 * directory's sessions would fall into 未分组 for the whole TTL) — the swap
 * changes the row identity, so per-workspace view prefs keyed
 * `sourceId/workspaceId` do not follow it (cosmetic, one-time); a real row with
 * the same path but another id wins and suppresses the echo. The sidebar's own
 * delete/rename of that workspace are echoed too ({@link removePendingWorkspace},
 * {@link renamePendingWorkspace}) — without them a create → delete leaves a GHOST
 * row no mount push could retire, and a rename looks like a no-op (an echo's
 * title is `basenameOf(path)`). Entries expire and retire with their source, so
 * a create whose convergence never arrives cannot pin a phantom row. The ledger
 * is renderer-local App state (never persisted, never polled).
 */
import type { InstanceAggregate, WorkspaceRow } from './instance-api.ts'
import { basenameOf } from './instance-api.ts'
import { canonicalPathKey } from './derive.ts'
import { filterLedgerRows, forgetLedgerSources, mapLedgerRows, setLedgerRows, sweepLedger } from './ledger.ts'
import { assertSingletonModule } from './singleton.ts'

assertSingletonModule('workspace-echo')

/** One echoed workspace creation (host id + path, plus its TTL anchor). */
export interface PendingWorkspace {
  workspaceId: string
  path: string
  /**
   * Display title — the producer's hint when it sent one (Git adopt: the branch
   * it is about to write), otherwise the path basename at record time. A later
   * rename replaces it, so it is NOT re-derivable from `path`.
   */
  title: string
  at: number
  /**
   * Optional placement anchor: the host workspace id this row sits immediately
   * AFTER in the projection. The Git plugin registers a new worktree directly
   * below its main checkout, and the continuous-family invariant is a
   * RENDERED-ORDER invariant — appending would render the row wrong and then make
   * it jump once the source mounts. Absent = append at the tail.
   */
  afterWorkspaceId?: string
}

/** Pending echoes keyed by source id. Absent key = nothing pending. */
export type WorkspaceEchoLedger = Readonly<Record<string, readonly PendingWorkspace[]>>

/**
 * How long an unconfirmed echo may stay in the projection. Convergence is a
 * MOUNT, which has no bounded deadline, so the TTL is a leak guard: a workspace
 * created elsewhere then deleted on the host would otherwise keep a dead row
 * until remount. Ten minutes is far beyond any realistic "click and look" delay.
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
 * Record one successful `workspace.create`. Idempotent per path: the host reuses
 * an existing registration at the same path (`created: false`) and may return the
 * same id twice, so an equal re-record replaces the previous entry instead of
 * stacking. The replacement always rebuilds the ledger — including a
 * byte-identical re-record, whose TTL anchor is refreshed — and runs once per
 * create, never per render or clock tick.
 */
export function recordPendingWorkspace(
  ledger: WorkspaceEchoLedger,
  sourceId: string,
  created: { workspaceId: string; path: string; afterWorkspaceId?: string; title?: string },
  now: number,
): WorkspaceEchoLedger {
  const rows = ledger[sourceId] ?? []
  const key = canonicalPathKey(created.path)
  const next: PendingWorkspace = {
    workspaceId: created.workspaceId,
    path: created.path,
    // Producer title hint wins (Git adopt renames to the branch right after the
    // saga); absent = the path-basename rule the cwd-derived groups use.
    // cwd-derived groups use.
    title: created.title ?? basenameOf(created.path),
    at: now,
    // Sparse on purpose: an anchor-less create keeps the entry shape byte-identical.
    // on identity).
    ...(created.afterWorkspaceId === undefined ? {} : { afterWorkspaceId: created.afterWorkspaceId }),
  }
  // The anchor is refreshed even when the entry is otherwise identical: this runs
  // once per create, and a stale anchor would make a fresh action's echo expire early.
  // seconds after the user asked for it.
  const kept = rows.filter(row => canonicalPathKey(row.path) !== key && row.workspaceId !== created.workspaceId)
  return setLedgerRows(ledger, sourceId, [...kept, next])
}

/** Drop echoes older than the TTL (identity-preserving when nothing expired). */
export function sweepPendingWorkspaces(ledger: WorkspaceEchoLedger, now: number): WorkspaceEchoLedger {
  return sweepLedger(ledger, row => now - row.at >= PENDING_WORKSPACE_TTL_MS)
}

/**
 * Drop every echo the given AUTHORITATIVE workspace list already covers: the same
 * `workspaceId`, or the same `path` under a real (non-synthetic) id. Once it
 * lists the workspace, the local echo must not survive as a duplicate.
 */
export function reconcilePendingWorkspaces(
  ledger: WorkspaceEchoLedger,
  sourceId: string,
  authoritative: readonly WorkspaceRow[],
): WorkspaceEchoLedger {
  if (ledger[sourceId] === undefined) return ledger
  const realIds = new Set<string>()
  const realPaths = new Set<string>()
  for (const row of authoritative) {
    if (row.synthetic === true) continue
    realIds.add(row.workspaceId)
    realPaths.add(canonicalPathKey(row.path))
  }
  return filterLedgerRows(ledger, sourceId, row =>
    !realIds.has(row.workspaceId) && !realPaths.has(canonicalPathKey(row.path)))
}

/**
 * Retire the echo of one DELETED workspace — the withdraw half. Matching is by
 * EITHER identity: the host `workspaceId` (primary key) or the same canonical
 * path. `key.path` is best-effort: it is empty when the mounted snapshot has not
 * reported the workspace, and an empty path never matches.
 * Identity-preserving when nothing matches, so the App's signature gate stays
 * quiet on a redundant fact.
 */
export function removePendingWorkspace(
  ledger: WorkspaceEchoLedger,
  sourceId: string,
  key: { workspaceId: string; path: string },
): WorkspaceEchoLedger {
  if (ledger[sourceId] === undefined) return ledger
  const pathKey = key.path === '' ? undefined : canonicalPathKey(key.path)
  return filterLedgerRows(ledger, sourceId, row =>
    row.workspaceId !== key.workspaceId
    && (pathKey === undefined || canonicalPathKey(row.path) !== pathKey))
}

/**
 * Patch the title of one echo after a successful `workspace.rename` — the patch
 * half. An echo row's title is its path basename, so this is the only way a
 * renamed workspace shows its new name before the source mounts.
 * Identity-preserving when the source/id is absent or the title already matches.
 */
export function renamePendingWorkspace(
  ledger: WorkspaceEchoLedger,
  sourceId: string,
  workspaceId: string,
  title: string,
): WorkspaceEchoLedger {
  return mapLedgerRows(ledger, sourceId, row =>
    row.workspaceId !== workspaceId || row.title === title ? row : { ...row, title })
}

/** Retire the echoes of sources that left the registry (same-id re-add = new generation). */
export function forgetPendingWorkspaces(
  ledger: WorkspaceEchoLedger,
  retired: ReadonlySet<string>,
): WorkspaceEchoLedger {
  return forgetLedgerSources(ledger, retired)
}

/**
 * Project one aggregate WITH its pending echoes merged in. Pure — the aggregate is
 * never mutated, so the echo disappears with the ledger entry;
 * identity-preserving when there is nothing to add or replace, which keeps the
 * sidebar publish signature stable across derive passes.
 *
 * Placement: a replaced synthetic group keeps its slot; brand-new echoes append at
 * the tail UNLESS the entry carries an `afterWorkspaceId` anchor (the Git plugin's
 * worktree create, which the host places below its main checkout) — then the row
 * is inserted right after that projected row, in ledger order for repeated
 * anchors, so the rendered order never jumps on mount.
 */
export function withWorkspaceEcho(
  aggregate: InstanceAggregate,
  pending: readonly PendingWorkspace[] | undefined,
): InstanceAggregate {
  if (pending === undefined || pending.length === 0) return aggregate
  // Only a committed ok aggregate carries a real workspace list; error and
  // not-connected render their own state.
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
    // A replaced group keeps its MEMBERSHIP. Sessions reach a group only through `workspace.sessionIds` (derive.ts), so an echo
    // row carrying `sessionIds: []` would drop every member of that directory into 未分组 for the echo's whole TTL; the
    // cwd-derived membership is the best local knowledge until mount.
    // TTL; the cwd-derived membership is the best local knowledge until mount.
    nextRows.push({ ...workspaceEchoRow(echo), sessionIds: row.sessionIds })
    replaced = true
  }
  const additions: PendingWorkspace[] = []
  for (const entry of pending) {
    const key = canonicalPathKey(entry.path)
    if (echoByPath.get(key) !== entry) continue
    additions.push(entry)
  }
  if (!replaced && additions.length === 0) return aggregate
  // Anchor-aware placement: group by anchor and insert each anchor's block with a
  // FRESH lookup, so insertions for one anchor cannot skew a later block's
  // position. An anchor not in the projection degrades to append-at-tail.
  const placed: WorkspaceRow[] = [...nextRows]
  const tail: WorkspaceRow[] = []
  const byAnchor = new Map<string, WorkspaceRow[]>()
  for (const entry of additions) {
    const row = workspaceEchoRow(entry)
    if (entry.afterWorkspaceId === undefined) {
      tail.push(row)
      continue
    }
    const block = byAnchor.get(entry.afterWorkspaceId)
    if (block === undefined) byAnchor.set(entry.afterWorkspaceId, [row])
    else block.push(row)
  }
  for (const [anchor, block] of byAnchor) {
    const anchorIndex = placed.findIndex(candidate => candidate.workspaceId === anchor)
    if (anchorIndex === -1) {
      tail.push(...block)
      continue
    }
    placed.splice(anchorIndex + 1, 0, ...block)
  }
  return { ...aggregate, workspaces: [...placed, ...tail] }
}
