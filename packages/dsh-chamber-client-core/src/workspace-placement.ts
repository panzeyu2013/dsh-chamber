/**
 * Workspace placement intent — the PRE-CREATE half of "新建工作区应立刻可见" (design 05 §2.2
 * revision), the earlier sibling of workspace-echo.ts.
 *
 * WHY: the host `workspace.create` PREPENDS into the registry order — vendor
 * `packages/workspace/workspace/src/index.ts` writes `workspaceIds: [id, ...state.workspaceIds]` —
 * and the create request is only `{ path }` (api/workspace-controller types), so no position can be
 * asked for; the client's only lever is a follow-up `workspace.insertBefore`. On a MOUNTED source
 * the authoritative push that carries the new row therefore reaches the projection BEFORE the
 * create answers, i.e. before any id-keyed echo can exist (workspace-echo.ts starts at the host
 * id). A creation that belongs somewhere else in the list — the Git plugin's worktree, which the
 * continuous-family invariant pins directly below its main checkout — would render at the HEAD of
 * the list for that window and slide down a few RPCs later: the entrance animation starts from the
 * very top and pushes the whole list, which is exactly what the family placement must not do.
 *
 * The intent is keyed by the CANONICAL PATH the creation asked for: before the host answers, the
 * path is the only identity that exists. `createWorkspaceForSource` (the single funnel, see
 * workspace-mutations.ts) publishes it before the wire call, so every creation site is covered;
 * the App upgrades the same entry with the host `workspaceId` + the host-canonical path the moment
 * the create funnels its echo (`onWorkspaceCreated`), which makes the match exact from then on.
 *
 * NOT a second source of truth: the projection only MOVES a row the authority already lists — it
 * never invents one (that is the echo's job) — and only while that row sits at the list HEAD, which
 * is the create-prepend transient itself. The moment the authoritative order puts the row anywhere
 * else (the reposition landed, an append landed, the user dragged it somewhere) the intent has no
 * job left and retires. When the reposition never lands, the row WOULD stay parked on the head
 * (until the TTL expiry moves it back — a late, unexplained jump), so the failure side publishes a
 * void fact (`reportWorkspacePlacementFailed`) and the row follows the host's order at once: the
 * two `insertBefore` catches and the two saga abort catches (create and adopt — a saga can die
 * before its reposition step, which is exactly as final for the row; the host id comes from the
 * `session-create` recovery record when there is one, else the request path keys it). The TTL is then only the leak guard for
 * "no signal at all" (a lost fact, or a page that never reached the failure), and source leave
 * retires the rest. The ledger is renderer-local App state (never persisted, never polled).
 */
import type { InstanceAggregate, WorkspaceRow } from './instance-api.ts'
import { canonicalPathKey } from './derive.ts'
import { filterLedgerRows, forgetLedgerSources, setLedgerRows, sweepLedger } from './ledger.ts'
import { assertSingletonModule } from './singleton.ts'

assertSingletonModule('workspace-placement')

/** 第一条真实行（合成"未分组"桶除外）——"列表头部"这条位置规则的唯一判定基准，
 *  reconcile 与投影两处共用，避免同一规则两份实现。 */
function firstRealRow(rows: readonly WorkspaceRow[]): WorkspaceRow | undefined {
  return rows.find(row => row.synthetic !== true)
}

/** One pre-registered placement intent (see the module header). */
export interface PendingWorkspacePlacement {
  /** The path as REQUESTED (`createWorkspaceForSource`'s argument) — the ledger key. */
  path: string
  /** Host workspace id this row must render immediately AFTER too. */
  afterWorkspaceId: string
  /**
   * Host workspace id. Absent until the create answers: the pre-create record can only be keyed by
   * path, and the App's echo handler upgrades the entry with the id (and the host's canonical path)
   * so the row match stops depending on path spelling.
   */
  workspaceId?: string
  at: number
}

/** Pending placement intents keyed by source id. Absent key = nothing pending. */
export type WorkspacePlacementLedger = Readonly<Record<string, readonly PendingWorkspacePlacement[]>>

/**
 * How long an intent may hold a row. The window it covers is one user action's worth of RPCs
 * (create → insertBefore, both AWAITED in the Git coordinator), so two minutes is far beyond any
 * realistic saga — including a slow SSH source — while staying short enough that an intent whose
 * "never landed" signal is lost heals inside the same session instead of pinning a row for the echo
 * ledger's own ten-minute horizon. (An `insertBefore` that FAILS does not wait for it: the Git
 * coordinator voids the intent on the spot.)
 */
export const PENDING_PLACEMENT_TTL_MS = 120_000

/**
 * Record one placement intent. Idempotent per canonical path AND per host id: the pre-create record
 * is UPGRADED IN PLACE by the create's own echo (same action, second identity), and a re-recorded
 * intent refreshes its TTL anchor instead of stacking a second hold on the same row. (Only a create
 * whose host path differs from the requested one — symlink resolution, say — can leave two entries
 * for one row: the id-upgraded one holds the row and retires positionally, while the path-keyed twin
 * is a projection NO-OP that only the TTL (or ANY later no-anchor create of that source — see
 * `removeUnclaimedPlacements`, which drops every unclaimed entry, not just the same path) retires.)
 * Identity is NOT promised: a re-record refreshes `at`, so it returns a new ledger — at most one
 * extra publish per create, never a render storm.
 */
export function recordWorkspacePlacement(
  ledger: WorkspacePlacementLedger,
  sourceId: string,
  placement: { path: string; afterWorkspaceId: string; workspaceId?: string },
  now: number,
): WorkspacePlacementLedger {
  const rows = ledger[sourceId] ?? []
  const key = canonicalPathKey(placement.path)
  const next: PendingWorkspacePlacement = {
    path: placement.path,
    afterWorkspaceId: placement.afterWorkspaceId,
    at: now,
    ...(placement.workspaceId === undefined ? {} : { workspaceId: placement.workspaceId }),
  }
  const kept = rows.filter(row =>
    canonicalPathKey(row.path) !== key
    && (placement.workspaceId === undefined || row.workspaceId !== placement.workspaceId))
  return setLedgerRows(ledger, sourceId, [...kept, next])
}

/** Drop intents older than the TTL (identity-preserving when nothing expired). */
export function sweepPendingPlacements(ledger: WorkspacePlacementLedger, now: number): WorkspacePlacementLedger {
  return sweepLedger(ledger, row => now - row.at >= PENDING_PLACEMENT_TTL_MS)
}

/**
 * Retire the intent of one DELETED workspace — matching by host id or canonical path. A create →
 * delete inside the window has nothing left to place, and waiting for the TTL would keep a dead
 * entry (and a sweep per push) alive for no reason.
 */
export function removePendingPlacement(
  ledger: WorkspacePlacementLedger,
  sourceId: string,
  key: { workspaceId?: string; path?: string },
): WorkspacePlacementLedger {
  const pathKey = key.path === undefined || key.path === '' ? undefined : canonicalPathKey(key.path)
  return filterLedgerRows(ledger, sourceId, row =>
    (key.workspaceId === undefined || row.workspaceId !== key.workspaceId)
    && (pathKey === undefined || canonicalPathKey(row.path) !== pathKey))
}

/**
 * Drop every intent of a source that no host id has claimed yet — called when a create ANSWERS
 * WITHOUT an anchor: the host's own order is then final (PREPEND, or the adopt append), nothing will
 * ever move that row, and the hold has no job left. It is also the robust half of the
 * "spelling divergence" boundary: such a pre-create entry carries no id and a REQUEST path the host
 * may canonicalize differently (`/var` vs `/private/var`), so neither the id upgrade, the delete
 * fact nor a path match can retire it — and left alive it could CLAIM a later no-anchor creation at
 * the same path and park that row under a stale anchor.
 *
 * "Unclaimed" cannot be PROVEN inert: the Git plugin's `runBusy` admits one action per source, but
 * the sidebar's "add workspace" create uses the same funnel WITHOUT that gate, so a concurrent
 * no-anchor create on the same source can also drop another still-in-flight path-keyed intent. The
 * cost is a degradation only (that row then renders at the host's own position instead of its anchor
 * = the pre-intent behavior). Matching by canonical path cannot retire the divergent-spelling twin
 * at all, and that twin is what could claim a later row.
 */
export function removeUnclaimedPlacements(
  ledger: WorkspacePlacementLedger,
  sourceId: string,
): WorkspacePlacementLedger {
  return filterLedgerRows(ledger, sourceId, row => row.workspaceId !== undefined)
}

/**
 * Drop every intent whose row the AUTHORITATIVE list has already moved off the head — the
 * create-prepend transient is the only state this ledger corrects, so a row listed anywhere else
 * means the host order has moved on (reposition landed, append landed, user dragged it). An intent
 * whose anchor is gone has nothing to hold the row below and retires too. A row that is not listed
 * YET (the push/fetch carrying it has not arrived) keeps its intent: its whole job is still ahead,
 * and the TTL bounds the wait. Identity-preserving when nothing retires.
 */
export function reconcilePendingPlacements(
  ledger: WorkspacePlacementLedger,
  sourceId: string,
  authoritative: readonly WorkspaceRow[],
): WorkspacePlacementLedger {
  const real = authoritative.filter(row => row.synthetic !== true)
  // 没有真实行（空列表/部分瞬时基线）不是"锚点消失"的证据：判不了就保留，TTL 兜底。
  const head = firstRealRow(authoritative)
  if (head === undefined) return ledger
  const realIds = new Set(real.map(row => row.workspaceId))
  const realPaths = new Set(real.map(row => canonicalPathKey(row.path)))
  return filterLedgerRows(ledger, sourceId, (entry) => {
    if (!realIds.has(entry.afterWorkspaceId)) return false
    const pathKey = canonicalPathKey(entry.path)
    const listed = entry.workspaceId === undefined ? realPaths.has(pathKey) : realIds.has(entry.workspaceId)
    if (!listed) return true
    // 上面已排除空列表：head 必然存在（"保留"只有一个理由 = 行仍在头部）。
    return entry.workspaceId === undefined
      ? canonicalPathKey(head.path) === pathKey
      : entry.workspaceId === head.workspaceId
  })
}

/** Retire the intents of sources that left the registry (same-id re-add = new generation). */
export function forgetPendingPlacements(
  ledger: WorkspacePlacementLedger,
  retired: ReadonlySet<string>,
): WorkspacePlacementLedger {
  return forgetLedgerSources(ledger, retired)
}

/**
 * Project one aggregate WITH its placement intents applied. Pure — the aggregate is never mutated.
 * Only a row the authority ALREADY lists is moved, and only while it is the head of the real
 * workspace list (the create-prepend transient): the row is lifted out and re-inserted immediately
 * after its anchor, which is where the client's follow-up `workspace.insertBefore` is about to put
 * it — so the rendered order never shows the transient at all. An intent whose row or anchor the
 * projection does not carry is a no-op (it degrades to today's append/prepend behavior, never to a
 * lost row), and identity is preserved when no intent applies.
 */
export function withWorkspacePlacements(
  aggregate: InstanceAggregate,
  pending: readonly PendingWorkspacePlacement[] | undefined,
): InstanceAggregate {
  if (pending === undefined || pending.length === 0) return aggregate
  // Only a committed ok aggregate carries a real workspace list; error and not-connected render
  // their own state.
  if (aggregate.state !== 'ok') return aggregate
  const rows = aggregate.workspaces
  const head = firstRealRow(rows)
  if (head === undefined) return aggregate
  let next: WorkspaceRow[] | undefined
  for (const entry of pending) {
    const current = next ?? rows
    // One lookup, not find + findIndex: the target is either in this list (by host id once the
    // create answered, by canonical path before that) or this entry is a no-op.
    const fromIndex = entry.workspaceId === undefined
      ? current.findIndex(row => row.synthetic !== true && canonicalPathKey(row.path) === canonicalPathKey(entry.path))
      : current.findIndex(row => row.workspaceId === entry.workspaceId)
    if (fromIndex === -1) continue
    const target = current[fromIndex]
    // The head test uses the ORIGINAL list: one create produces one transient row, and after it has
    // been lifted the remaining entries must not start chasing rows the authority placed normally.
    if (target.workspaceId !== head.workspaceId) continue
    // Already placed: return the aggregate untouched (the publish is signature-gated, so an
    // unnecessary rebuild costs a full sidebar re-render).
    if (fromIndex === current.findIndex(row => row.workspaceId === entry.afterWorkspaceId) + 1) continue
    const withoutTarget = [...current.slice(0, fromIndex), ...current.slice(fromIndex + 1)]
    // Anchor lookup happens in the REDUCED list, so the insertion index cannot be skewed by the
    // lift; an anchor that is not in the projection is a no-op (today's order, never a lost row).
    const anchorIndex = withoutTarget.findIndex(row => row.workspaceId === entry.afterWorkspaceId)
    if (anchorIndex === -1) continue
    withoutTarget.splice(anchorIndex + 1, 0, target)
    next = withoutTarget
  }
  return next === undefined ? aggregate : { ...aggregate, workspaces: next }
}
