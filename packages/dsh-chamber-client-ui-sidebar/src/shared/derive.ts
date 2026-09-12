/**
 * Pure sidebar workspace-list derivation from a per-instance snapshot (design
 * 05 §2.3). Mirrors the official dsh workspace browser rules (vendor
 * dsh-client-ui-workspace/src/client/tree.ts sessionVisible/groupByWorkspace/
 * byRecency) into the chamber bridge shape: subagent-origin and archived
 * sessions never surface, blank rows surface only while current (the active
 * source's provisional New Session row), real workspaces keep wire
 * membership order, and sessions outside every workspace trail in one
 * synthetic ungrouped bucket.
 *
 * ONE deliberate mutable exception (design 06 §2.2): the module-level
 * blank-row GHOST grace map — written only by `armBlankGhost` (the sidebar,
 * when a click moves current away from a blank row), read only by
 * `sessionVisible`, which lazily sweeps expired entries on read. Two more
 * mutable exceptions of the same shape are the CREATE membership-grace map
 * (armed explicitly by the create action) and the bounded first-observation
 * FORK membership-grace map (armed by the first unaccounted snapshot,
 * retained only while that candidate remains unaccounted); both are read
 * only by `deriveServerWorkspaces`. All maps only ever suppress a row
 * placement; the derives stay deterministic for a given (snapshot, current,
 * now) triple plus the grace maps — tests inject `now`.
 *
 * No React, no DOM — plain-node unit-testable (see test/derive.test.ts).
 */
import type { InstanceSnapshot, SearchRow } from './instance-api.ts'
import type { ChamberServerAggregate, ChamberServerWorkspace, InstanceRuntimeReport, ServerBootGap } from './aggregate-store.ts'
import { assertSingletonModule } from './singleton.ts'

// `blankGhostUntil` below is CROSS-BOUNDARY shared state — armed by the
// sidebar bundle (armBlankGhost, at the transition click) and read by the
// App's derive (sessionVisible) — relying on the vite shared chunk for
// single-instance. Register in the singleton registry so a bundling drift
// that duplicates the module surfaces as a console diagnostic instead of
// silently splitting the state per shell.
assertSingletonModule('derive')

/** Synthetic id of the trailing group that collects sessions outside every workspace. */
export const UNGROUPED_WORKSPACE_ID = '__ungrouped__'

/**
 * Active-Schedule fact of one session (2026-09-11 upstream-alignment T7).
 *
 * Mirrors the official derivation verbatim — upstream reads the session's
 * registered `schedule` projection and asks whether anything is active:
 * `(session.projectionValues?.schedule?.length ?? 0) > 0`
 * (vendor ui-workspace/src/client/tree.ts:161-163, consumed by
 * `{row.hasActiveSchedule && <ActiveScheduleIndicator/>}` at Rows.tsx:468).
 * The value is unknown-typed here (a wire projection bag), so the array test
 * replaces upstream's optional chaining on a typed `readonly ScheduleRecord[]`:
 * absent / not-an-array / empty all mean "no active schedule" — never a claim
 * about the future, only about the projection the list row carried.
 * @param projectionValues - the row's `projectionValues` bag (mounted store) or `projections.values` (unary wire), or undefined.
 * @returns true when the bag carries a non-empty `schedule` array.
 */
export function hasActiveScheduleOf(
  projectionValues: Readonly<Record<string, unknown>> | undefined,
): boolean {
  const schedule = projectionValues?.schedule
  return Array.isArray(schedule) && schedule.length > 0
}

/** Canonical-path equality key: trailing separators normalized only. No
 *  fs.realpath in the browser, so symlinked spellings (e.g. macOS /tmp →
 *  /private/tmp) can still miss — documented limitation; unmatched sessions
 *  fall back to the ungrouped bucket, which remains the honest fallback.
 *
 *  Exported because the workspace echo must match a host-CANONICAL create path
 *  (`fs.realpath` on the host — `instance-mutation-values.ts`) against a
 *  cwd-derived synthetic group path: raw equality missed trailing-separator
 *  spellings and rendered one directory twice (workspace-echo.ts). */
export function canonicalPathKey(value: string): string {
  return value.replace(/[\\/]+$/, '')
}

/**
 * One-shot diagnostic flag for the cwd-membership wire-degradation fallback
 * (projectInstanceSnapshot): the degenerate cross-section repeats on every
 * store notification while the host index stays incomplete, so the console
 * warning fires once per page lifetime (module-level mutable;
 * assertSingletonModule guarantees one instance across bundles).
 */
let warnedCwdMembershipFallback = false

/** Wire search query schema clamp (design 06 §1.1): at most 500 UTF-16 code units. */
export const SEARCH_QUERY_MAX_CODE_UNITS = 500

/**
 * Stable per-workspace icon accent: a deterministic color from the workspace
 * identity — no user customization, no persistence, no selection state. The
 * hue is a golden-angle spread of the (serverId, family seed) hash, so
 * distinct seeds land far apart on the hue wheel; a SECOND hash jitters the
 * lightness per workspace (56/61/66%) so even near-hue pairs stay
 * eye-distinguishable. Saturation is soft — 34%, or 21% for derived
 * worktrees — pastel-calm in both light and dark themes.
 *
 * Derived (worktree) workspaces inherit their repository's family hue — the
 * family seed is the repoKey, shared by the MAIN checkout and every derived
 * worktree alike (stable even when the main is unregistered or later
 * renamed); `mainWorkspaceId` is only the fallback for a repoKey-less flag.
 * Derived members demote to the muted saturation while the MAIN checkout
 * keeps the full one, mirroring the folder/branch glyph + title-ink
 * hierarchy. The synthetic ungrouped bucket gets NO accent (undefined) — CSS
 * falls back to the default caption ink. Selection is deliberately NOT
 * encoded here: the current-session row carries its own official selected
 * tint.
 *
 * `WorkspaceAccentSeed` is a structural subset of the git plugin's
 * `WorkspaceGitFlag` (shared/workspace-git-flags.ts) — this module stays
 * free of git types by design.
 */
export interface WorkspaceAccentSeed {
  /** True when this workspace IS a git worktree (derived workspace). */
  isWorktree?: boolean
  /** True when this workspace is the repository's MAIN checkout. */
  isMain?: boolean
  /** For a derived worktree: the MAIN checkout workspace id of the same repo. */
  mainWorkspaceId?: string
  /** The repository's opaque identity (repoKey) this workspace belongs to. */
  repoKey?: string
}

/**
 * Golden-angle hue step: hue = (hash × 137.508) mod 360. 137.508 =
 * 34377/250, and 90000/gcd(34377, 90000) = 30000, so two hashes land on the
 * exact same hue only when they differ by a multiple of 30000 — negligible
 * for real ids, and the lightness jitter breaks the visual tie anyway. All
 * other pairs spread ~137° apart on the wheel.
 */
const WORKSPACE_HUE_STEP = 137.508

/** Deterministic 32-bit string hash (the sidebar sourceHue arithmetic). */
export function hashString(input: string): number {
  let hash = 0
  for (let i = 0; i < input.length; i += 1) hash = (hash * 31 + input.charCodeAt(i)) >>> 0
  return hash
}

/**
 * Deterministic per-source accent color (05 §2): remote sources carry a hue
 * hash of their source id, the LOCAL source omits the accent and falls back
 * to the default ink (undefined). The single palette definition for every
 * surface (source header dot / rail dots / active insets, the session-todo
 * source dot) — never re-implemented in per-surface copies.
 */
export function sourceAccentColor(sourceId: string): string | undefined {
  return sourceId === 'local' ? undefined : `hsl(${hashString(sourceId) % 360} 34% 61%)`
}

/**
 * Per-workspace accent CSS variable for the workspace header row (the fold
 * toggle's folder/branch glyph inherits currentColor). `undefined` for the
 * ungrouped bucket, so the CSS fallback chain keeps today's visuals there.
 */
export function workspaceAccentStyle(
  serverId: string,
  workspaceId: string,
  seed?: WorkspaceAccentSeed,
): { '--chamber-workspace-accent': string } | undefined {
  if (workspaceId === UNGROUPED_WORKSPACE_ID) return undefined
  const family = seed !== undefined && (seed.isWorktree === true || seed.isMain === true)
    ? (seed.repoKey ?? seed.mainWorkspaceId ?? workspaceId)
    : workspaceId
  const rawHue = (hashString(`${serverId}/${family}`) * WORKSPACE_HUE_STEP) % 360
  // One-decimal hue normalized into [0, 360): 359.96 rounds to 360.0, which
  // would escape the format contract — map it back to 0.
  const hue = (Math.round(rawHue * 10) % 3600) / 10
  // Soft palette: saturation 34% (21% for derived worktrees) + lightness
  // 56/61/66% — pastel-calm while keeping the family/main-vs-derived
  // hierarchy and the near-hue jitter tie-break.
  const saturation = seed?.isWorktree === true ? 21 : 34
  const lightness = 56 + (hashString(workspaceId) % 3) * 5
  return { '--chamber-workspace-accent': `hsl(${hue} ${saturation}% ${lightness}%)` }
}

/**
 * Search input normalization (design 06 §1.1 wire schema): strip NULs, clamp
 * to SEARCH_QUERY_MAX_CODE_UNITS UTF-16 code units without splitting a
 * surrogate pair, trim; '' when empty. Mirrors the wire search query schema
 * (trim, non-empty, ≤500, no '\0').
 */
export function sanitizeSearchQuery(query: string): string {
  let cleaned = query.replace(/\0/g, '')
  if (cleaned.length > SEARCH_QUERY_MAX_CODE_UNITS) {
    const high = cleaned.charCodeAt(SEARCH_QUERY_MAX_CODE_UNITS - 1)
    const low = cleaned.charCodeAt(SEARCH_QUERY_MAX_CODE_UNITS)
    const end =
      high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff
        ? SEARCH_QUERY_MAX_CODE_UNITS - 1
        : SEARCH_QUERY_MAX_CODE_UNITS
    cleaned = cleaned.slice(0, end)
  }
  return cleaned.trim()
}

/**
 * How long a just-created session stays out of the synthetic ungrouped
 * bucket while its workspace membership has not landed yet (design 06 §2.2).
 * The host commits creation and workspace attach as TWO ordered frames
 * (`host/session-added` fires during `session.create`,
 * `host/workspace-changed` only after the attach commit), so a snapshot
 * pushed between them would flash the new session in the trailing ungrouped
 * bucket for one frame, then yank it into its workspace on the next push.
 * The sidebar arms this grace synchronously right after the CREATE mutation
 * resolves (before requesting the App-layer refresh/open), and
 * `deriveServerWorkspaces` skips the session's stray placement while the
 * grace holds: the row appears once membership lands — always in the right
 * workspace, never via the ungrouped bucket.
 *
 * The grace is armed ONLY by the create path (which always carries an
 * explicit workspaceId), so it can never hide a genuinely ungrouped session.
 * The FORK path uses a separate first-observation grace (see
 * deriveServerWorkspaces): the child id is host-minted and its session-added
 * frame may precede the mutation response, so the UI cannot arm it. That
 * grace is bounded by the same duration; if workspace attach fails after the
 * child was published, the child surfaces under ungrouped instead of
 * remaining hidden forever. 3s covers the mutation-triggered aggregate
 * pull's round trip (the App's refresh is guaranteed post-mutation), even
 * over a slow SSH tunnel.
 */
export const MEMBERSHIP_GRACE_MS = 3_000

/**
 * Module-level membership-grace map: `${serverId}:${sessionId}` -> expiry
 * epoch-ms. Source-scoped: host session ids are per-process counters on some
 * minting paths (`session-<n>` in dsh-session's SessionStore), so a
 * sessionId-only key could suppress another source's same-id stray for the
 * grace duration. Written only by `armMembershipGrace` (the sidebar,
 * synchronously after a successful create) and read only by the SAME
 * source's stray filter in `deriveServerWorkspaces`; the arming shell and
 * the App's derive share one map (same vite shared chunk as the blank-ghost
 * grace — see assertSingletonModule above). Lazy sweeps on write AND read
 * bound the map: the write-side sweep clears every expired entry per arm,
 * the read-side sweep only drops the queried id.
 */
const membershipGraceUntil = new Map<string, number>()

/**
 * Source-scoped fork grace, armed on the first snapshot where a fork child is
 * unaccounted while its parent is workspace-accounted. An expired entry is
 * deliberately retained while the candidate remains present, so repeated
 * derives cannot re-arm it forever; it is removed once the child is
 * accounted, disappears, or stops being a qualifying candidate — the map is
 * bounded by the current snapshot's candidate set.
 */
const forkMembershipGraceByServer = new Map<string, Map<string, number>>()

/**
 * Arm (or refresh) the membership grace for a session the sidebar just
 * created under `serverId`. Called synchronously after the create mutation
 * resolves and BEFORE requesting the App-layer refresh — the App's next
 * derive (when the refresh pull lands) then consults the grace and skips the
 * session's ungrouped placement until its workspace membership arrives.
 * Refreshing overwrites the expiry, so a later re-arm always wins.
 * @param now - epoch-ms; injected in tests, Date.now() in the app.
 */
export function armMembershipGrace(serverId: string, sessionId: string, now = Date.now()): void {
  for (const [key, expiry] of membershipGraceUntil) {
    if (expiry <= now) membershipGraceUntil.delete(key)
  }
  membershipGraceUntil.set(`${serverId}:${sessionId}`, now + MEMBERSHIP_GRACE_MS)
}

/**
 * Whether the session's ungrouped placement is suppressed by an active
 * membership grace for the same source (expired entries lazily swept on
 * read, mirroring the blank-ghost sweep). The grace ONLY affects the
 * stray/ungrouped placement — a session already listed in a workspace's
 * sessionIds renders normally in that workspace regardless of the map.
 */
function membershipGraceActive(serverId: string, sessionId: string, now: number): boolean {
  const key = `${serverId}:${sessionId}`
  const expiry = membershipGraceUntil.get(key)
  if (expiry === undefined) return false
  if (expiry <= now) {
    membershipGraceUntil.delete(key)
    return false
  }
  return true
}

function forkMembershipGraceActive(serverId: string, sessionId: string, now: number): boolean {
  let source = forkMembershipGraceByServer.get(serverId)
  if (source === undefined) {
    source = new Map<string, number>()
    forkMembershipGraceByServer.set(serverId, source)
  }
  const existing = source.get(sessionId)
  if (existing !== undefined) return now < existing
  source.set(sessionId, now + MEMBERSHIP_GRACE_MS)
  return true
}

function retainForkMembershipCandidates(serverId: string, candidates: ReadonlySet<string>): void {
  const source = forkMembershipGraceByServer.get(serverId)
  if (source === undefined) return
  for (const sessionId of source.keys()) {
    if (!candidates.has(sessionId)) source.delete(sessionId)
  }
  if (source.size === 0) forkMembershipGraceByServer.delete(serverId)
}

/** Converge grace state with the live server registry: a removed source
 * never derives another snapshot, so candidate-based pruning alone cannot
 * reclaim it; same-id re-adds must start with a fresh generation. */
export function retainMembershipGraceSources(liveServerIds: ReadonlySet<string>): void {
  for (const key of membershipGraceUntil.keys()) {
    const separator = key.indexOf(':')
    const serverId = separator === -1 ? key : key.slice(0, separator)
    if (!liveServerIds.has(serverId)) membershipGraceUntil.delete(key)
  }
  for (const serverId of forkMembershipGraceByServer.keys()) {
    if (!liveServerIds.has(serverId)) forkMembershipGraceByServer.delete(serverId)
  }
}

/** Test-only: clear both membership-grace maps (node tests share the module instance). */
export function __resetMembershipGracesForTests(): void {
  membershipGraceUntil.clear()
  forkMembershipGraceByServer.clear()
}

/**
 * Merge a stored ungrouped order with the wire order (design 06 §2/§3.2,
 * official reconciledSessionOrder/orderedUngrouped port): ids known to the
 * wire list come in stored order first, then the remaining wire ids in wire
 * order; ids unknown to the wire are skipped.
 */
export function reconciledSessionOrder(stored: readonly string[], wireIds: readonly string[]): string[] {
  const wire = new Set(wireIds)
  const seen = new Set<string>()
  const ordered: string[] = []
  for (const id of stored) {
    if (!wire.has(id) || seen.has(id)) continue
    seen.add(id)
    ordered.push(id)
  }
  for (const id of wireIds) {
    if (seen.has(id)) continue
    seen.add(id)
    ordered.push(id)
  }
  return ordered
}

/**
 * Source display order (06 §2.4): the sidebar's server groups render in the
 * user's stored order when one exists — ids known to the projection come in
 * stored order first, then the remaining projection ids in projection order
 * (a newly added source appears at the bottom until dragged). Unknown stored
 * ids are skipped, so a source deleted from the registry cannot leave a
 * ghost group. `undefined` (no preference yet) returns the projection order
 * unchanged — the same reference, so callers can skip re-renders on absent
 * prefs.
 */
export function orderServersForDisplay(
  servers: readonly ChamberServerAggregate[],
  stored: readonly string[] | undefined,
): ChamberServerAggregate[] {
  if (stored === undefined || stored.length === 0) return servers as ChamberServerAggregate[]
  const byId = new Map(servers.map(server => [server.id, server]))
  const placed = new Set<string>()
  const ordered: ChamberServerAggregate[] = []
  for (const id of stored) {
    const server = byId.get(id)
    if (server === undefined || placed.has(id)) continue
    placed.add(id)
    ordered.push(server)
  }
  for (const server of servers) {
    if (placed.has(server.id)) continue
    placed.add(server.id)
    ordered.push(server)
  }
  return ordered
}

/**
 * Server-group drop order math (06 §2.4): the display order that results
 * from inserting `draggedSourceId` at `over`'s boundary of the CURRENT
 * rendered order. `null` = NO-OP — the drop leaves the order unchanged and
 * the caller skips the write: the target or the dragged source vanished from
 * the rendered order, the dragged source IS the anchor, or the position did
 * not actually move (inserting right after itself / already in place /
 * already last). The anchor math mirrors the workspace commit (anchor =
 * half === 'before' ? over.id : next id, undefined = append at the end).
 */
export function nextServerOrder(
  renderedOrder: readonly string[],
  draggedSourceId: string,
  over: { id: string; half: 'before' | 'after' },
): string[] | null {
  const targetIndex = renderedOrder.findIndex(id => id === over.id)
  if (targetIndex === -1) return null
  const anchor = over.half === 'before' ? over.id : renderedOrder[targetIndex + 1]
  if (anchor === draggedSourceId) return null
  const sourceIndex = renderedOrder.findIndex(id => id === draggedSourceId)
  if (sourceIndex === -1) return null
  const anchorIndex = anchor === undefined ? renderedOrder.length : renderedOrder.findIndex(id => id === anchor)
  if (anchorIndex === sourceIndex || anchorIndex === sourceIndex + 1) return null
  const nextOrder = renderedOrder.filter(id => id !== draggedSourceId)
  const insertAt = anchor === undefined ? nextOrder.length : nextOrder.indexOf(anchor)
  nextOrder.splice(insertAt === -1 ? nextOrder.length : insertAt, 0, draggedSourceId)
  return nextOrder
}

/**
 * One reconcile step of the App-owned "completed but unread" dot state
 * machine (design 06 §4.2). PURE — the App layer calls it inside a functional
 * state updater so batched reports compose without losing earlier arms.
 *
 * Rules mirror the vendor reminder, except "being read" is the ACTIVE view's
 * current session (the App's fact) instead of this ctx's possibly-stale
 * `selected`:
 * - arm: a running→idle edge (prevRunning true → now false) of a session the
 *   user is not reading right now (a background source has no reader, so
 *   every completion arms — the exact case the vendor's stale selection
 *   suppresses);
 * - disarm: the session re-runs (running true), leaves the list, or the user
 *   starts reading it (it becomes the active view's current session).
 *
 * @param sessions - the report's per-session rows (live running bits).
 * @param nextRunning - caller-computed pass-through of the new running bits
 *   (used for the leave-the-list sweep; the caller keeps its own ref in sync).
 * @param prevRunning - the source's last-observed running bits (per-report
 *   snapshot — never the shared ref, so batched updaters stay correctly
 *   paired with their own report).
 * @param prevCompleted - the source's armed set before this report.
 * @param readingCurrent - the session being read right now: the ACTIVE view's
 *   current session, or undefined for background sources (nothing is read).
 * @returns the next armed set (identity when unchanged) and whether it changed.
 */
export function reconcileCompletedFacts(params: {
  sessions: Record<string, { running?: boolean }>
  nextRunning: Record<string, boolean>
  prevRunning: Record<string, boolean>
  prevCompleted: Record<string, boolean>
  readingCurrent: string | undefined
}): { completed: Record<string, boolean>; changed: boolean } {
  const next = { ...params.prevCompleted }
  let changed = false
  for (const [sessionId, row] of Object.entries(params.sessions)) {
    if (row?.running === true) {
      // Re-run disarms (vendor same rule).
      if (next[sessionId] === true) {
        delete next[sessionId]
        changed = true
      }
      continue
    }
    // running → idle edge: arm unless the session is being read right now.
    if (params.prevRunning[sessionId] === true && sessionId !== params.readingCurrent && next[sessionId] !== true) {
      next[sessionId] = true
      changed = true
    }
    // Reading disarms: the active view's current session is on screen.
    if (sessionId === params.readingCurrent && next[sessionId] === true) {
      delete next[sessionId]
      changed = true
    }
  }
  // Sessions that left the list: drop their armed dots and edge memory.
  for (const sessionId of Object.keys(params.prevRunning)) {
    if (params.nextRunning[sessionId] !== undefined) continue
    if (next[sessionId] === true) {
      delete next[sessionId]
      changed = true
    }
  }
  return { completed: changed ? next : params.prevCompleted, changed }
}

/**
 * Project one ctx's sessions snapshot into the chamber runtime-facts report
 * (design 06 §4.2). Pure pass-through (the caller may drop tombstoned ids —
 * design 24 §12): every listed session carries its
 * live `running` bit (the App layer derives the completed-but-unread dot from
 * running→idle edges itself — it owns the active view and every open request,
 * so it is the single place that knows what "being read" means), while
 * `completed`/`pending` ride the vendor runtime's armed state as sparse
 * extras.
 *
 * `subagentRunning` (the vendor lineage index's RUNNING descendant count per
 * parent, 06 §4.5) is INJECTED by the plugin — this module stays a pure
 * controller with no unbuilt vendor package in its import graph — and the
 * plugin reuses the vendor's `indexSubagentDescendants` verbatim so the
 * aggregation semantics never drift.
 *
 * `pendingInteractions` (the per-session pending map of the official
 * ui-session registry — the same authoritative source the official
 * ui-workspace tree consumes via `useSessionPendingInteraction`) is injected
 * by the plugin as a LOOSE ReadonlyMap: the chamber sidebar's pending dots
 * and the design-19 ask/request notification edges read the registry fed by
 * the `approval/request` / `user-questions/request` remote-event waterfalls.
 * The kind mapping mirrors the official `visiblePendingKind` verbatim so the
 * presentation can never drift from the official tree. The loose param
 * avoids importing runtime store types.
 */
export function projectRuntimeFacts(
  snapshot: {
    current?: string
    byId?: Record<string, {
      running?: boolean
      completed?: boolean
      origin?: 'subagent'
    }>
  },
  subagentRunning?: ReadonlyMap<string, number>,
  pendingInteractions?: ReadonlyMap<string, { kind?: string }>,
): InstanceRuntimeReport {
  const sessions: InstanceRuntimeReport['sessions'] = {}
  for (const [id, facts] of Object.entries(snapshot.byId ?? {})) {
    // subagent 行不进入运行时事实（与 projectInstanceSnapshot 的 origin 过滤
    // 同规）：导航不呈现子会话，通知边沿也不得对子代理完成/提问发通知——
    // 子代理完成是高频事件，漏入会刷屏（design 19 §3.2）。
    if (facts?.origin === 'subagent') continue
    const row: {
      running?: boolean
      completed?: boolean
      pending?: 'approval' | 'plan-review' | 'question'
      runningSubagents?: number
    } = {
      running: facts?.running === true,
    }
    if (facts?.completed === true) row.completed = true
    // pending rides the official ui-session registry (see header doc); unknown
    // kinds stay undefined so a future upstream kind cannot leak into the UI.
    const pending = pendingKindOf(pendingInteractions?.get(id)?.kind)
    if (pending !== undefined) row.pending = pending
    const runningSubagents = subagentRunning?.get(id) ?? 0
    if (runningSubagents > 0) row.runningSubagents = runningSubagents
    sessions[id] = row
  }
  const report: InstanceRuntimeReport = { sessions }
  if (snapshot.current !== undefined) report.current = snapshot.current
  return report
}

/** Official `visiblePendingKind` mirror (ui-workspace tree.ts): the three
 *  presentation kinds chamber renders, anything else stays invisible. */
function pendingKindOf(kind: string | undefined): 'approval' | 'plan-review' | 'question' | undefined {
  switch (kind) {
    case 'approval':
    case 'plan-review':
    case 'question':
      return kind
    default:
      return undefined
  }
}

/**
 * Project the two already-live ctx stores into the same chamber snapshot
 * shape as the unary fallback. `undefined` means either reconnect baseline
 * is incomplete; callers must invalidate the push snapshot and let the
 * bounded fallback pull take over (the renderer App keeps the last pushed
 * view through the withdrawal window, so the sessions-only fallback never
 * replaces a mounted source's groups/archive/state). Subagent rows are
 * deliberately excluded because chamber navigation never renders them.
 */
export function projectInstanceSnapshot(
  workspaces: {
    items?: readonly {
      workspaceId: string
      path: string
      title: string
      sessionIds: readonly string[]
      createdAt: string
      updatedAt: string
    }[]
    archivedSessionIds?: readonly string[]
    state?: string
    phase?: string
    error?: unknown
  },
  sessions: {
    ids?: readonly string[]
    byId?: Record<string, {
      id: string
      title?: string
      cwd?: string
      parentId?: string
      origin?: 'subagent'
      running?: boolean
      blank?: boolean
      updatedAt?: number
      /**
       * The row's projection bag (2026-09-11 upstream-alignment T7): the
       * mounted store's `SessionSummary.projectionValues`. Read for the
       * active-Schedule fact only — the same field upstream's tree reads
       * (vendor ui-workspace tree.ts:161-163).
       */
      projectionValues?: Readonly<Record<string, unknown>>
    }>
    phase?: string
  },
): InstanceSnapshot | undefined {
  // Both arrival phases are sticky after their first success. The workspace
  // store also projects its pull-activity `state` (loading/error during a
  // reconnect, while `phase` stays ready), so a loading/error workspace
  // withdraws here — clearing the producer's content signature so an
  // identical recovered baseline is emitted again instead of being
  // suppressed forever (dropping the withdrawal would let the signature gate
  // suppress the post-reconnect rebaseline and leave the renderer on the
  // not-connected/unary view the ready-edge refresh installed; the App keeps
  // the last pushed view through the withdrawal window instead). The session
  // store projects only `phase` (the arrival lifecycle): its baseline
  // refreshes together with the workspace baseline on reconnect, so the
  // workspace `state` check is the single completeness authority there. The
  // arrival check is `state === 'idle'` + both phases `ready` only (the
  // upstream `baselinesReady` field no longer exists).
  if (workspaces.state !== 'idle'
    || workspaces.phase !== 'ready' || sessions.phase !== 'ready') return undefined
  const byId = sessions.byId ?? {}
  // Wire-degradation defense: the host projects `WorkspaceView.sessionIds`
  // through a canonical-cwd header index built at registry init (dsh-workspace
  // entity getter + index); when that index is incomplete (legacy headers
  // without cwd, cwd not resolving), the baseline carries workspace rows with
  // EMPTY sessionIds while sessions exist — the sidebar would sink every
  // session into the ungrouped bucket. Detect the degenerate cross-section
  // (ready + non-empty items + non-empty sessions + zero accounted members +
  // at least one session whose cwd matches a workspace path) and synthesize
  // membership from the session cwd facts, keeping the store's workspace
  // identity/order/title. The cwd-match guard keeps genuinely-empty
  // workspaces untouched (no false positives).
  const items = (workspaces.items ?? []).map(item => ({
    workspaceId: String(item.workspaceId),
    path: item.path,
    title: item.title,
    sessionIds: item.sessionIds.map(String),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  }))
  const zeroAccounted = items.length > 0 && items.every(item => item.sessionIds.length === 0)
  const cwdRows = (sessions.ids ?? []).flatMap(id => {
    const row = byId[id]
    return row !== undefined && row.origin !== 'subagent' && typeof row.cwd === 'string'
      ? [{ id: String(row.id), cwd: row.cwd }]
      : []
  })
  // Canonical-path equality is not available client-side (no fs.realpath in
  // the browser): compare with trailing separators normalized only
  // (canonicalPathKey — shared with the archive manager's cwd attribution).
  // Symlinked spellings (e.g. macOS /tmp → /private/tmp) can still miss —
  // documented limitation; unmatched sessions stay in the ungrouped bucket,
  // which remains the honest fallback.
  if (zeroAccounted && (sessions.ids ?? []).length > 0 && cwdRows.length > 0
    && items.some(item => cwdRows.some(row => canonicalPathKey(row.cwd) === canonicalPathKey(item.path)))) {
    // ONE diagnostic warning per page lifetime (module-level flag): the
    // degenerate cross-section repeats on every store notification while the
    // host index stays incomplete — the console must not flood.
    if (!warnedCwdMembershipFallback) {
      warnedCwdMembershipFallback = true
      console.warn(
        '[chamber] workspace baseline carries zero session membership while sessions exist — '
        + 'synthesizing membership from session cwd facts (host canonical-cwd index incomplete?)',
      )
    }
    const pathToItem = new Map(items.map(item => [canonicalPathKey(item.path), item]))
    for (const row of cwdRows) {
      const item = pathToItem.get(canonicalPathKey(row.cwd))
      if (item !== undefined) item.sessionIds.push(row.id)
    }
  }
  return {
    workspaces: items,
    sessions: (sessions.ids ?? []).flatMap(id => {
      const row = byId[id]
      if (row === undefined || row.origin === 'subagent') return []
      return [{
        sessionId: String(row.id),
        ...(typeof row.updatedAt === 'number' ? { updatedAt: row.updatedAt } : {}),
        running: row.running === true,
        blank: row.blank === true,
        // 2026-09-11 upstream-alignment T7: sparse — the fact rides the row only
        // when the session actually owns an active schedule, so every other
        // row's snapshot bytes (and the producer's signature gate) are
        // untouched (see instanceSnapshotSignature).
        ...(hasActiveScheduleOf(row.projectionValues) ? { hasActiveSchedule: true as const } : {}),
        ...(row.cwd !== undefined ? { cwd: row.cwd } : {}),
        ...(row.title !== undefined ? { title: row.title } : {}),
        ...(row.parentId !== undefined ? { parentSessionId: String(row.parentId) } : {}),
      }]
    }),
    archivedSessionIds: (workspaces.archivedSessionIds ?? []).map(String),
    // The mounted ctx store's workspace baseline IS the authoritative
    // archive-set source (registry-global archivedSessionIds) — even an
    // empty set is a true "nothing archived" fact (archiveSetKnown).
    archiveSetKnown: true,
  }
}

/**
 * Merge one source's live runtime-facts report with the App-owned
 * completed-but-unread dots (design 06 §4.2): the UNION of the channel's
 * vendor-armed completed rows and the App-derived dots (the App's
 * running→idle edge state machine is authoritative for background sources;
 * the vendor's completed stays as a fallback), preserving the current
 * session and every other live row (running / pending / runningSubagents).
 * PURE — extracted so the App's deriveServers merge is unit-testable.
 * Returns undefined when there is nothing to attach (no report and no armed
 * dots); the caller attaches runtime only for CONNECTED sources, so a
 * not-connected source never carries facts.
 */
export function mergeRuntimeFacts(
  runtime: InstanceRuntimeReport | undefined,
  completedBySource: Record<string, boolean> | undefined,
): InstanceRuntimeReport | undefined {
  const chamberCompleted = completedBySource
  const hasArmed = chamberCompleted !== undefined && Object.values(chamberCompleted).some(value => value === true)
  if (runtime === undefined && !hasArmed) {
    return undefined
  }
  const sessions: InstanceRuntimeReport['sessions'] = { ...(runtime?.sessions ?? {}) }
  if (chamberCompleted !== undefined) {
    for (const [sessionId, armed] of Object.entries(chamberCompleted)) {
      if (armed !== true) continue
      const row = sessions[sessionId] ?? {}
      sessions[sessionId] = { ...row, completed: true }
    }
  }
  return { current: runtime?.current, sessions }
}

/**
 * Content signature of one instance snapshot (workspaces + sessions +
 * archived ids). Used by the App layer to keep aggregate state
 * identity-preserving: an update whose rows are byte-identical must NOT mint
 * a new state object — that would re-derive servers, re-publish the chamber
 * bridge and re-render every shell's sidebar on every fallback tick (design
 * 05 §3). Key order is fixed (the wire row constructors in instance-api.ts
 * build fields in a stable order), so JSON.stringify is deterministic across
 * updates.
 */
export function instanceSnapshotSignature(
  snapshot: Pick<InstanceSnapshot, 'workspaces' | 'sessions' | 'archivedSessionIds' | 'archiveSetKnown'>,
): string {
  return JSON.stringify({
    w: snapshot.workspaces.map(w => ({
      id: w.workspaceId,
      path: w.path,
      title: w.title,
      createdAt: w.createdAt,
      updatedAt: w.updatedAt,
      s: w.sessionIds,
      y: w.synthetic === true,
    })),
    s: snapshot.sessions.map(row => ({
      id: row.sessionId,
      at: row.updatedAt,
      r: row.running,
      b: row.blank,
      // 2026-09-11 upstream-alignment T7: the schedule fact MUST ride the
      // signature — otherwise a session gaining/losing its active schedule
      // republishes identical bytes and the producer's dedupe gate suppresses
      // the row update (the marker would freeze at its first-seen value).
      // `undefined` serializes away, so schedule-less rows keep exactly the
      // bytes they had before this field existed.
      h: row.hasActiveSchedule,
      o: row.origin,
      t: row.title,
      c: row.cwd,
      p: row.parentSessionId,
    })),
    a: snapshot.archivedSessionIds,
    k: snapshot.archiveSetKnown === true,
  })
}

/**
 * Sidebar running-ring visibility (design 06 §4.3「running 点保留（snapshot
 * 权威）」): the ring shows ONLY from the complete aggregate snapshot field;
 * the channel's running bit is deliberately IGNORED — `channelRunning` is
 * accepted so the contract is testable (a future maintainer cannot silently
 * reintroduce channel participation without the regression test failing).
 *
 * Runtime facts and the structural snapshot are deliberately not OR/precedence
 * merged: one rendered field has one authority (mounted sources update the
 * snapshot from their ctx store; unmounted or reconnecting sources use the
 * bounded unary fallback).
 */
export function runningRingVisible(_channelRunning: boolean | undefined, polledRunning: boolean | undefined): boolean {
  return polledRunning === true
}

/**
 * Content signature of one runtime-facts report (current + per-session
 * facts). Every listed session carries its live `running` bit (the App's
 * completed-dot edge memory), with `completed`/`pending`/`runningSubagents`
 * as sparse extras.
 *
 * `onlyIds` optionally restricts the signature to a subset of session ids:
 * the projection signature (serversProjectionSignature) passes the set of
 * sessions actually rendered by the sidebar, so a hidden session
 * (subagent-origin / archived / blank-non-current) flipping its
 * running/completed bits does NOT re-render the list. The App's runtimeFacts
 * identity check calls without it — the state must track the full report,
 * while the completed-dot reconciliation runs on every report regardless.
 *
 * `includeRunning` separates the two consumers: the App's runtimeFacts
 * identity + completed-dot state machine read the report's running bits and
 * must keep them in the signature (default true); the PROJECTION signature
 * (serversProjectionSignature) passes false — the sidebar renders the
 * running ring from the polled wire bit (06 §4.3「running 点保留（wire
 * 权威）」, runningRingVisible), so a channel-only running flip must NOT
 * re-publish/re-render the sidebar (its rendered content — ring, dots,
 * pending badges, current highlight — is unchanged).
 */
export function runtimeReportSignature(
  report: InstanceRuntimeReport | undefined,
  onlyIds?: ReadonlySet<string>,
  includeRunning = true,
): string {
  if (report === undefined) return ''
  const current = report.current ?? ''
  const rows = Object.entries(report.sessions)
    .filter(([id]) => onlyIds === undefined || onlyIds.has(id))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([id, facts]) =>
      `${id}:${includeRunning && facts.running === true ? 'r' : ''}${facts.completed === true ? 'c' : ''}${facts.pending ?? ''}:${facts.runningSubagents ?? 0}`)
  // A report whose only rows were filtered out (no visible session, no
  // current) contributes nothing to the projection signature — it must be
  // indistinguishable from "no runtime attached".
  if (rows.length === 0 && current === '') return ''
  return `${current}|${rows.join(',')}`
}

/**
 * Field-GENERIC identity of a settled-boot gap for publish signatures: every
 * payload field takes part (so a field added to the fact later cannot freeze a
 * subscription), fields are order-normalized, array order is preserved (roster
 * order is meaningful) — and "no payload" is one thing: an absent field, an
 * empty array, `null` and an empty string all encode to nothing, so a producer
 * that omits vs materializes an empty field cannot churn the gate. The
 * producer's sentence is not part of the projection at all.
 */
function gapSignature(gap: ServerBootGap | undefined): string | null {
  if (gap === undefined) return null
  const encode = (value: unknown): string | null => {
    if (value === undefined || value === null || value === '') return null
    if (Array.isArray(value)) return value.length === 0 ? null : `[${value.map(item => String(item)).join('\u0000')}]`
    return JSON.stringify(value)
  }
  return Object.entries(gap)
    .flatMap(([key, value]) => {
      const encoded = encode(value)
      return encoded === null ? [] : [`${key}=${encoded}`]
    })
    .sort()
    .join('\u0001')
}

/**
 * Render-relevant projection signature of the merged multi-source
 * projection. Covers everything the sidebar (and the settings bridge)
 * renders or uses as a lifecycle boundary — and nothing else:
 * - sourceFingerprint is not visible UI, but a same-id replacement must
 *   publish so source-owned child contexts can be retired synchronously.
 * - `updatedAt` IS part of the session row since the updated-mode alignment
 *   (updated = manual order + activity promotion, design 06 §3.1): a
 *   session's last-activity tick re-publishes the projection and the
 *   sidebar's per-account derivation promotes the session — a pure recency
 *   re-sort is NOT materialized into the row order anymore, so the old
 *   exclusion rationale no longer holds.
 * - the runtime portion is restricted to sessions visible in the projection
 *   (hidden sessions' facts never re-render the list).
 * - 2026-09-11 review-fix finding 1: the per-session active-Schedule fact
 *   (hasActiveSchedule) is a rendered fact that can flip ALONE — the sidebar
 *   row renders the marker, and a schedule/change log record moves no other
 *   field in this signature — so the row below carries it.
 * The App layer gates chamberBridge.publish on this signature — a poll tick
 * whose rendered content did not change must not re-render every shell's
 * sidebar; the sidebar subscription re-checks it as defense in depth.
 */

export function serversProjectionSignature(servers: readonly ChamberServerAggregate[]): string {
  // JSON encoding (not delimiter concatenation): titles/labels are
  // user-controlled text (sidebar renameSession) and may contain any
  // separator — a joined string would let two different projections produce
  // the same signature, and the publish gate would silently skip a real
  // change.
  return JSON.stringify(servers.map(server => {
    const visibleSessionIds = new Set<string>()
    for (const workspace of server.workspaces) {
      for (const session of workspace.sessions) visibleSessionIds.add(session.id)
    }
    // The runtime signature string is collision-free within its domain
    // (machine-generated session ids, fixed enum values, numeric counts);
    // embedding it as a JSON string value is unambiguous. A report whose
    // rows were all filtered out (no visible session, no current) is
    // normalized to null — indistinguishable from "no runtime attached".
    // includeRunning=false: the sidebar renders the running ring from the
    // POLLED wire bit (runningRingVisible), never from the channel, so a
    // channel-only running flip must not re-publish the projection.
    const runtime = server.runtime === undefined ? '' : runtimeReportSignature(server.runtime, visibleSessionIds, false)
    return {
      id: server.id,
      sourceFingerprint: server.sourceFingerprint,
      kind: server.kind,
      transport: server.transport,
      rawId: server.rawId ?? null,
      label: server.label,
      connected: server.connected,
      phase: server.phase,
      // Render-relevant: the source header's managed-down note and the
      // settings panel's copy branch on this fact.
      managedRuntimeDown: server.managedRuntimeDown === true,
      dshVersion: server.dshVersion ?? null,
      aggregateError: server.aggregateError ?? null,
      // pluginDiagnostic STAYS in the publish gate even though the sidebar no
      // longer renders it: the settings-bridge consumes the SAME chamberBridge
      // publish channel and derives the connections page's pluginDiagnostics
      // from it (SettingsShell → ConnectionsSection), so a diagnostic-only
      // flip must still re-publish or that surface goes stale. Removing this
      // block would regress it.
      pluginDiagnostic: server.pluginDiagnostic === undefined ? null : {
        state: server.pluginDiagnostic.state,
        message: server.pluginDiagnostic.message ?? null,
        pluginId: server.pluginDiagnostic.pluginId ?? null,
      },
      // bootGap is RENDERED (the source row's warning line) AND consumed by the
      // settings-bridge's connections card, so a gap-only flip must move the
      // bytes: non-sparse, like pluginDiagnostic above. Field-GENERIC encoding —
      // see gapSignature (a hand-written field list here would let a payload
      // field added later freeze the sidebar silently).
      bootGap: gapSignature(server.bootGap),
      runtime: runtime === '' ? null : runtime,
      workspaces: server.workspaces.map(w => ({
        id: w.id,
        title: w.title,
        ungrouped: w.ungrouped === true,
        // Synthetic rows disable their mutation affordances in the sidebar.
        synthetic: w.synthetic === true,
        sessions: w.sessions.map(x => ({
          id: x.id,
          title: x.title,
          running: x.running === true,
          blank: x.blank === true,
          // Render-relevant: updated-mode ordering derives from it.
          updatedAt: x.updatedAt ?? null,
          // 2026-09-11 review-fix finding 1: the active-Schedule marker is a
          // RENDERED fact (SessionSection renders it right after the row title),
          // so it must move this signature — otherwise a schedule/change that
          // flips nothing else (a schedule log record does not touch the row's
          // updatedAt, which is max(createdAt, lastPromptAt)) republishes
          // byte-identical content, both publish gates drop it (App.tsx and
          // this shell's own subscription), and the marker can freeze at its
          // first-seen value. Non-sparse on purpose: this row is a change
          // detector, never persisted, so a stable false is free.
          hasActiveSchedule: x.hasActiveSchedule === true,
        })),
      })),
      // Archive-manager metadata rides the publish gate too: a purge while
      // the manager dialog is open must re-publish (the dialog list derives
      // from these rows) or it would go stale. Change detection only needs
      // identity + recency per row (review round 2026-09): an archived row's
      // title/cwd/workspace cannot change through any UI surface (archived
      // rows are invisible to rename; no UI can re-home or move an archived
      // row between workspaces — only host-side archive/purge/content
      // changes do, and every such path also moves the workspace block
      // below), so full metadata is omitted from the signature
      // — at a 65k archived-set scale this keeps each compare cheap. The
      // archive-set PROVENANCE flag rides along: a mounted↔fallback view
      // transition must also re-publish (the dialog's degraded branch
      // depends on it — deletion surfaces only from the listed view).
      archivedSessions: server.archivedSessions === undefined ? null : server.archivedSessions.map(row => ({
        sessionId: row.sessionId,
        updatedAt: row.updatedAt ?? null,
      })),
      archiveSetKnown: server.archiveSetKnown === undefined ? null : server.archiveSetKnown,
    }
  }))
}

/**
 * How long a departed blank "new session" row keeps its layout slot as a
 * non-interactive GHOST (design 06 §2.2). Without it, a double click on a
 * real session below the blank row mis-targets: click1 opens the session,
 * the blank row stops being current and disappears, every row below shifts
 * up ~30px, and click2 (within DOUBLE_CLICK_WINDOW_MS) hits the row that was
 * BELOW the target — opening a DIFFERENT session instead of renaming. The
 * grace must exceed the 350ms double-click window; 450ms covers it plus the
 * App's re-derive latency.
 */
export const BLANK_GHOST_GRACE_MS = 450

/**
 * Module-level ghost grace map: departed blank `sourceId:sessionId` -> expiry
 * epoch-ms. Source-scoped: cloned instances can carry the SAME session UUID,
 * and a bare sessionId key would let one source's ghost grace suppress
 * another source's blank row (or leak it). Written by `armBlankGhost` (the
 * sidebar, at the transition click) and read by `sessionVisible` during the
 * App's derive — the blank row keeps its slot in the projection (and
 * therefore in the sidebar's list) until the grace expires, so the list
 * never shifts inside the double-click window. The App drops the row on its
 * next derive after expiry; the sidebar additionally stops RENDERING the
 * ghost at the same expiry (its own clock), so the invisible placeholder
 * cannot linger until the next poll cycle. Expired entries are lazily swept
 * on write (armBlankGhost) and on read (sessionVisible) — the map is bounded
 * either way.
 */
const blankGhostUntil = new Map<string, number>()

/**
 * Arm (or refresh) the ghost-slot grace for a blank session that just stopped
 * being the source's current session. The sidebar calls this SYNCHRONOUSLY in
 * a session-row onClick, BEFORE requesting the open that transitions current
 * away from the blank row — the App's re-derive (a moment later, on the
 * runtime-facts report) then consults the grace via `sessionVisible` and
 * keeps the row. Refreshing overwrites the expiry, so a later real transition
 * always wins over an earlier stale arm (e.g. an earlier click on the blank
 * row itself). Lazy sweep drops expired entries (bounded: at most one blank
 * row per source). Source-scoped key: `sourceId:sessionId`.
 * @param now - epoch-ms; injected in tests, Date.now() in the app.
 */
export function armBlankGhost(sourceId: string, sessionId: string, now = Date.now()): void {
  for (const [id, expiry] of blankGhostUntil) {
    if (expiry <= now) blankGhostUntil.delete(id)
  }
  blankGhostUntil.set(`${sourceId}:${sessionId}`, now + BLANK_GHOST_GRACE_MS)
}

/** Test-only: clear the ghost grace map (node tests share the module instance). */
export function __resetBlankGhostsForTests(): void {
  blankGhostUntil.clear()
}

/**
 * Navigation visibility: subagent-origin and archived rows are always hidden;
 * blank rows follow the official rule (!blank || current) — a blank "new
 * session" provisional row shows only while it is the source's CURRENT
 * session (the one being viewed) — plus the ghost-slot exception: a blank row
 * that stopped being current within the last BLANK_GHOST_GRACE_MS stays
 * visible (non-interactively, see SidebarRoot) so the list cannot shift
 * inside the double-click-to-rename window. The App layer passes the current
 * session id only for the ACTIVE source (see App.tsx deriveServers), so no
 * other source's provisional blank row ever enters the projection (design 06
 * §4.3 single-selection discipline: current-session visuals belong to the
 * visible source alone).
 * @param now - epoch-ms; the caller injects its derive clock (testable).
 */
function sessionVisible(
  serverId: string,
  session: { sessionId: string; blank: boolean; origin?: 'subagent' },
  currentSessionId: string | undefined,
  archived: ReadonlySet<string>,
  now: number,
): boolean {
  // Lazy SWEEP on read: an expired ghost entry is dropped the first time a
  // derive consults it (armBlankGhost also sweeps on write). Deleting an
  // expired entry cannot change any derive result (the expiry predicate would
  // have failed anyway), and the currentness branch below keeps a CURRENT
  // blank row visible regardless of the map. At most one blank row per source
  // can be ghosted, so this stays O(1). Source-scoped key: cloned UUIDs
  // across sources must not share ghost grace.
  const ghostKey = `${serverId}:${session.sessionId}`
  const ghostExpiry = blankGhostUntil.get(ghostKey)
  if (ghostExpiry !== undefined && ghostExpiry <= now) blankGhostUntil.delete(ghostKey)
  return session.origin !== 'subagent'
    && !archived.has(session.sessionId)
    && (!session.blank
      || session.sessionId === currentSessionId
      || (ghostExpiry ?? 0) > now)
}

/**
 * Relative time for session rows as a structured bucket the UI localizes
 * ("now"/"5min"/"3h"/"2d"/"4mo"/"1y" in en). Mirrors the official
 * relativeTime() in vendor dsh-client-ui-workspace/src/client/tree.ts
 * exactly: 60s MIN, 60min HOUR, 24h DAY, 30d MONTH, 365d YEAR, n floor,
 * diff clamped at >=0, unit 'now' with n=0.
 * @param updatedAt - epoch ms of the session's last activity.
 * @param now - current epoch ms (injected for pure rendering).
 */
export interface RelativeTimeBucket {
  unit: 'now' | 'minutes' | 'hours' | 'days' | 'months' | 'years'
  n: number
}

export function relativeTimeBucket(updatedAt: number, now: number): RelativeTimeBucket {
  const MIN = 60_000
  const HOUR = 3_600_000
  const DAY = 86_400_000
  const diff = Math.max(0, now - updatedAt)
  if (diff < MIN) return { unit: 'now', n: 0 }
  if (diff < HOUR) return { unit: 'minutes', n: Math.floor(diff / MIN) }
  if (diff < DAY) return { unit: 'hours', n: Math.floor(diff / HOUR) }
  if (diff < 30 * DAY) return { unit: 'days', n: Math.floor(diff / DAY) }
  if (diff < 365 * DAY) return { unit: 'months', n: Math.floor(diff / (30 * DAY)) }
  return { unit: 'years', n: Math.floor(diff / (365 * DAY)) }
}

/**
 * Recency comparator core: newest first, key ascending as the deterministic
 * tiebreak. A missing wire updatedAt sorts as 0 (behavior identical to the
 * pre-optional coercion of absent wire values to 0).
 */
function compareRecency(aKey: string, aAt: number | undefined, bKey: string, bAt: number | undefined): number {
  const atA = aAt ?? 0
  const atB = bAt ?? 0
  if (atB !== atA) return atB - atA
  return aKey < bKey ? -1 : 1
}

/** Recency comparator for wire session rows (sessionId-keyed). */
function byRecency(
  a: { sessionId: string; updatedAt?: number },
  b: { sessionId: string; updatedAt?: number },
): number {
  return compareRecency(a.sessionId, a.updatedAt, b.sessionId, b.updatedAt)
}

/** Per-workspace session ordering preference (design 06 §3.1 orderBy). */
export type SessionOrderBy = 'manual' | 'updated'

/**
 * Recency-sort an id array by the sessions' updatedAt (newest first, id
 * ascending tiebreak; missing updatedAt sorts as 0). PURE.
 */
function sortIdsByRecency<T extends { id: string; updatedAt?: number }>(
  ids: readonly string[],
  byId: ReadonlyMap<string, T>,
): string[] {
  return [...ids].sort((a, b) => compareRecency(a, byId.get(a)?.updatedAt, b, byId.get(b)?.updatedAt))
}

/**
 * One session order account's next updated-mode derivation — the official
 * ui-workspace `nextSessionOrderAccount` port (design 06 §3.1: updated =
 * manual order + activity promotion, no longer a pure recency re-sort). The
 * account keeps a stored order (`updatedOrder[accountKey]`) plus
 * last-observed timestamps (`sessionUpdatedAtByAccount[accountKey]`), both
 * written back together:
 *
 * - baseline = stored order reconciled with the current membership (stored
 *   ids first, new wire ids appended in wire order), or the wire order when
 *   the account has never been observed;
 * - NO bookkeeping yet (first observation, or the user just switched into
 *   updated — the menu action clears the source's bookkeeping): ONE full
 *   recency sort;
 * - otherwise PROMOTE the sessions whose updatedAt increased since the last
 *   observation (or was never observed) to the top, recency-sorted among
 *   themselves, keeping every other session in baseline order — a promoted
 *   session stays pinned at its promoted position until a newer promotion or
 *   a manual drag supersedes it (official behavior, persisted through the
 *   account order).
 *
 * PURE. `changed` = the stored order or the timestamps differ from the given
 * stored state (the caller persists both together, diff-guarded).
 */
export function nextUpdatedOrder<T extends { id: string; updatedAt?: number }>({
  sessionIds,
  stored,
  previousUpdatedAt,
  byId,
}: {
  sessionIds: readonly string[]
  stored: readonly string[] | undefined
  previousUpdatedAt: Readonly<Record<string, number>> | undefined
  byId: ReadonlyMap<string, T>
}): { order: string[]; updatedAt: Record<string, number>; changed: boolean } {
  const baseline = stored === undefined
    ? [...sessionIds]
    : reconciledSessionOrder(stored, sessionIds)
  let order = baseline
  if (previousUpdatedAt === undefined) {
    // First observation / just switched in: full recency sort (official
    // `previousOrder === undefined || switchedToUpdated`).
    order = sortIdsByRecency(baseline, byId)
  } else {
    const promoted = sessionIds
      .filter((id) => {
        const session = byId.get(id)
        const previous = previousUpdatedAt[id]
        return session !== undefined && (previous === undefined || (session.updatedAt ?? 0) > previous)
      })
    if (promoted.length > 0) {
      const promotedSet = new Set(sortIdsByRecency(promoted, byId))
      order = [...promotedSet, ...baseline.filter(id => !promotedSet.has(id))]
    }
  }
  const updatedAt: Record<string, number> = {}
  for (const id of sessionIds) {
    const session = byId.get(id)
    if (session !== undefined && session.updatedAt !== undefined) updatedAt[id] = session.updatedAt
  }
  const orderChanged = stored === undefined
    || order.length !== stored.length
    || order.some((id, index) => id !== stored[index])
  const timestampsChanged = previousUpdatedAt === undefined
    || Object.keys(updatedAt).length !== Object.keys(previousUpdatedAt).length
    || Object.entries(updatedAt).some(([id, timestamp]) => previousUpdatedAt[id] !== timestamp)
  return { order, updatedAt, changed: orderChanged || timestampsChanged }
}

/**
 * Ungrouped-bucket order resolution (PURE, MANUAL mode only — updated mode
 * goes through the unified account path, `nextUpdatedOrder`): stored ids
 * first via reconciledSessionOrder, unknown ids appended in wire order; the
 * wire order copy when no stored order exists.
 */
export function orderUngroupedSessions<T extends { id: string; updatedAt?: number }>(
  wire: readonly T[],
  stored: readonly string[] | undefined,
): T[] {
  if (stored === undefined) return [...wire]
  const order = reconciledSessionOrder(stored, wire.map(session => session.id))
  const byId = new Map(wire.map(session => [session.id, session]))
  return order.flatMap(id => { const session = byId.get(id); return session === undefined ? [] : [session] })
}

/**
 * Local-metadata search hits (design 06 §1.1 local leg, aligned with the
 * official ui-workspace deriveSearchResults local segment): a session matches
 * when its title OR the title of a workspace it belongs to contains the query
 * substring (case-insensitive). Blank / archived / subagent-origin rows never
 * match. A session whose own title is missing cannot hit on title, but a
 * workspace-title hit still counts. Hits are recency-ordered (byRecency).
 * @param snapshot - the per-instance aggregate (workspaces/sessions/archived).
 * @param query - caller text; trimmed here defensively, empty → [].
 * @returns local rows with an empty snippet (the remote merge overlays the
 *   content snippet when the same session also hits remotely).
 */
export function deriveLocalSearchMatches(snapshot: InstanceSnapshot, query: string): SearchRow[] {
  const q = query.trim().toLowerCase()
  if (q === '') return []
  const archived = new Set(snapshot.archivedSessionIds)
  const workspaceTitleBySession = new Map<string, string>()
  for (const workspace of snapshot.workspaces) {
    for (const sessionId of workspace.sessionIds) {
      if (!workspaceTitleBySession.has(sessionId)) workspaceTitleBySession.set(sessionId, workspace.title)
    }
  }
  const matches: { sessionId: string; updatedAt?: number }[] = []
  for (const session of snapshot.sessions) {
    if (session.origin === 'subagent' || session.blank || archived.has(session.sessionId)) continue
    const title = session.title
    const workspaceTitle = workspaceTitleBySession.get(session.sessionId)
    const titleHit = title !== undefined && title.toLowerCase().includes(q)
    const workspaceHit = workspaceTitle !== undefined && workspaceTitle.toLowerCase().includes(q)
    if (!titleHit && !workspaceHit) continue
    matches.push(session)
  }
  matches.sort(byRecency)
  return matches.map(session => ({ sessionId: session.sessionId, snippet: '' }))
}

/**
 * Merge local metadata hits with the remote content-search page (design
 * 06 §1.1, aligned with the official deriveSearchResults merge): local rows
 * lead in their recency order, then remote rows not already covered by a
 * local hit keep the backend order; duplicate sessionIds (within either leg
 * or across both) collapse to one row, and a locally-hit session that also
 * matched remotely carries the remote snippet. hasMore = remote hasMore OR
 * the merged result exceeds the limit.
 *
 * The remote leg is filtered against the caller's visible-session set before
 * merging: the local leg already only matches projected rows (subagent /
 * archived / blank-non-current never enter the projection), so without the
 * same filter, content-search hits for hidden sessions would sneak into the
 * results (the official deriveSearchResults applies sessionVisible() to
 * every content item; the projection IS the chamber's visibility authority).
 * When the projection is READY the visible set is authoritative and an empty
 * set filters ALL remote hits (hidden sessions must never resurface in
 * clickable results); only a NOT-ready projection keeps the no-filter
 * degrade (never wipe out remote hits because the snapshot is temporarily
 * absent).
 * @param local - deriveLocalSearchMatches output (recency-ordered).
 * @param remote - the wire searchSessions page.
 * @param limit - protocol-owned maximum merged row count.
 * @param visibleIds - ids of sessions visible in the projection (the union of
 *   every workspace's session ids); remote items outside it are dropped when
 *   the projection is ready (empty ready set → nothing remote survives).
 * @param projectionReady - whether the projection has actually landed
 *   (aggregateReady); false = degrade to no filtering.
 */
export function mergeSearchResults(
  local: readonly SearchRow[],
  remote: { items: readonly SearchRow[]; hasMore: boolean },
  limit: number,
  visibleIds: ReadonlySet<string>,
  projectionReady: boolean,
): { items: SearchRow[]; hasMore: boolean } {
  // 投影 READY 后可见集是权威：空集 = 合法空（远程腿过滤为空，隐藏会话不
  // 回流）；未就绪时降级为不过滤（避免临时缺位清空全部命中）。
  const filterRemote = projectionReady
  const remoteBySession = new Map<string, string>()
  for (const item of remote.items) {
    if (filterRemote && !visibleIds.has(item.sessionId)) continue
    if (!remoteBySession.has(item.sessionId)) remoteBySession.set(item.sessionId, item.snippet)
  }
  const ordered: SearchRow[] = []
  const included = new Set<string>()
  const include = (row: SearchRow): void => {
    if (included.has(row.sessionId)) return
    included.add(row.sessionId)
    const snippet = remoteBySession.get(row.sessionId)
    ordered.push(snippet === undefined ? row : { sessionId: row.sessionId, snippet })
  }
  for (const row of local) include(row)
  for (const row of remote.items) {
    if (filterRemote && !visibleIds.has(row.sessionId)) continue
    include(row)
  }
  return {
    items: ordered.slice(0, limit),
    hasMore: remote.hasMore || ordered.length > limit,
  }
}

/**
 * Fork-child title increment — VERBATIM port of the official dsh client
 * runtime's `increasedForkTitle` (upstream
 * dsh-api-session-controller/src/client/sessions/service.ts). The wire
 * `session/fork` accepts only `{ sessionId, atSeq? }` — the official
 * `increaseTitle` flag is a client-side convenience (fork succeeds, then the
 * child is renamed) — so the chamber implements the same increment itself:
 * a trailing half-width or full-width parenthesized number increments
 * (BigInt, no precision loss), any other title starts at ` (1)`.
 * @param title - the source session's durable title.
 * @returns the title to assign to the fork child.
 */
export function increasedForkTitle(title: string): string {
  const ascii = /^(.*?)\((\d+)\)$/u.exec(title)
  if (ascii?.[1] !== undefined && ascii[2] !== undefined) {
    return `${ascii[1]}(${BigInt(ascii[2]) + 1n})`
  }
  const fullWidth = /^(.*?)（(\d+)）$/u.exec(title)
  if (fullWidth?.[1] !== undefined && fullWidth[2] !== undefined) {
    return `${fullWidth[1]}（${BigInt(fullWidth[2]) + 1n}）`
  }
  return `${title} (1)`
}

/** Archived-session metadata row carried to archive-manager surfaces
 *  (design 24 revision 2026-09: the manager lists WHAT is archived; 2026
 *  revision: rows carry their workspace attribution for the grouped
 *  collapsible listing). */
export interface ArchivedSessionMetaRow {
  sessionId: string
  /** Title projection when the session has one (untitled sessions omit it). */
  title?: string
  /** Canonical working directory (project label source). */
  cwd?: string
  /** Epoch ms of last activity; absent on the wire when unknown. */
  updatedAt?: number
  /** Workspace attribution (2026 revision): the host workspace whose
   *  registry membership contains this session — or, failing that, whose
   *  path equals the session's canonical cwd. Absent = the session is not
   *  accounted by any live workspace (deleted-workspace orphans etc.); the
   *  manager lists it in the trailing ungrouped bucket. */
  workspace?: { id: string; title: string }
}

/**
 * Archived-session metadata for the archive manager (design 24 revision
 * 2026-09). The archived SET is the authoritative membership gate: a session
 * row only classifies as archived when its id is in
 * snapshot.archivedSessionIds. Subagent-origin rows never enter
 * InstanceSnapshot.sessions (the projection drops them), so the manager
 * lists top-level archived sessions only — their subagent descendants are
 * deleted together with the tree (host purge semantics). Rows sort by
 * recency (updatedAt desc; stable for ties). The unary-fallback snapshot has
 * NO unary archive-set wire source (documented KNOWN DEGRADATION), so it
 * carries an empty set — EXCEPT when the App substitutes its remembered
 * authoritative set on a degraded commit (design 24 §12 F3(b)): rows are then
 * filtered exactly as in a pushed view while `archiveSetKnown` stays false.
 * `archiveSetKnown` remains the manager's provenance gate.
 *
 * Workspace attribution (2026 revision): each row carries the workspace that
 * accounts for it — authoritative membership first (snapshot workspace
 * sessionIds, the registry header index: archiving keeps the session in its
 * workspace, only content purge self-heals the accounting), then a canonical
 * cwd==path fallback (wire-degradation parity with projectInstanceSnapshot),
 * otherwise no workspace (manager ungrouped bucket).
 */
export function deriveArchivedSessions(snapshot: InstanceSnapshot): ArchivedSessionMetaRow[] {
  // Fast paths (2026 performance review): the derive runs on the render path
  // for every connected source on every input change, so empty results must
  // cost nothing — no Set build, no session scan, no sort, no attribution
  // index (M1 disposition: the aggregate-identity cache stays a deferred
  // renderer-side option; these guards remove the common-case cost).
  if (snapshot.archivedSessionIds.length === 0) return []
  const archived = new Set(snapshot.archivedSessionIds)
  // Both snapshot producers keep session ids unique (commitAggregatePull
  // replaces, never appends), so the filter cannot yield duplicates today;
  // row order = snapshot order, then stable recency sort below.
  const rows = snapshot.sessions.filter(session => archived.has(session.sessionId))
  if (rows.length === 0) return []
  rows.sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
  // Workspace attribution indexes over the SNAPSHOT's workspace rows (the
  // full membership view — NOT the nav projection, which drops archived
  // rows). Synthetic cwd-derived fallback groups (`__cwd__:` ids) only ever
  // coexist with an empty archive set (unary fallback → no rows at all), so
  // attribution never resolves through them in practice. Built only when
  // rows exist (the fast paths above returned already).
  const memberOf = new Map<string, { id: string; title: string }>()
  const byCwd = new Map<string, { id: string; title: string }>()
  for (const workspace of snapshot.workspaces) {
    const meta = { id: workspace.workspaceId, title: workspace.title }
    for (const sessionId of workspace.sessionIds) memberOf.set(sessionId, meta)
    byCwd.set(canonicalPathKey(workspace.path), meta)
  }
  return rows.map(session => {
    const workspace = memberOf.get(session.sessionId)
      ?? (session.cwd !== undefined ? byCwd.get(canonicalPathKey(session.cwd)) : undefined)
    return {
      sessionId: session.sessionId,
      ...(session.title !== undefined ? { title: session.title } : {}),
      ...(session.cwd !== undefined ? { cwd: session.cwd } : {}),
      ...(session.updatedAt !== undefined ? { updatedAt: session.updatedAt } : {}),
      ...(workspace !== undefined ? { workspace } : {}),
      // NOTE: the running bit is deliberately NOT carried — the host purge is
      // the running authority (it skips running subtrees whole and reports
      // skippedRunning); per-row delete of a running archived session is a
      // safe post-hoc skip, surfaced by the result note.
    }
  })
}

/** One workspace group of the manager's collapsible listing (2026
 *  revision): the header facts plus its archived rows. */
export interface ArchivedSessionGroup {
  /** The workspace's registry id, or UNGROUPED_WORKSPACE_ID for rows with no
   *  attribution. */
  key: string
  /** Display title of real workspace groups ('' for the ungrouped bucket —
   *  the manager localizes its title). */
  title: string
  /** Present only for real workspace groups (folder/accent chrome). */
  workspace?: { id: string; title: string }
  rows: ArchivedSessionMetaRow[]
}

/**
 * Split archived rows into ordered workspace groups for the manager's
 * collapsible listing (2026 revision). Ordering: groups by their NEWEST
 * member (updatedAt desc; stable for ties) — the dialog's delete-oriented
 * scan wants recent activity on top, mirroring the flat list's recency sort;
 * rows within a group by recency desc. The UNGROUPED bucket (rows without
 * workspace attribution) trails LAST, mirroring the nav's synthetic trailing
 * group. PURE — plain-node unit-testable.
 */
export function groupArchivedRows(rows: readonly ArchivedSessionMetaRow[]): ArchivedSessionGroup[] {
  const byKey = new Map<string, { group: ArchivedSessionGroup; newest: number }>()
  for (const row of rows) {
    const key = row.workspace?.id ?? UNGROUPED_WORKSPACE_ID
    let entry = byKey.get(key)
    if (entry === undefined) {
      entry = {
        group: {
          key,
          title: row.workspace?.title ?? '',
          ...(row.workspace !== undefined ? { workspace: row.workspace } : {}),
          rows: [],
        },
        newest: 0,
      }
      byKey.set(key, entry)
    }
    entry.group.rows.push(row)
    const at = row.updatedAt ?? 0
    if (at > entry.newest) entry.newest = at
  }
  const entries = [...byKey.values()].sort((left, right) => right.newest - left.newest)
  // Ungrouped trails last (nav trailing-bucket parity) regardless of recency.
  const ungroupedIndex = entries.findIndex(entry => entry.group.key === UNGROUPED_WORKSPACE_ID)
  if (ungroupedIndex !== -1 && ungroupedIndex !== entries.length - 1) {
    const [entry] = entries.splice(ungroupedIndex, 1)
    if (entry !== undefined) entries.push(entry)
  }
  for (const entry of entries) {
    // Self-contained: each group's rows sort newest-first even if the caller
    // did not pre-sort (the only in-tree caller, deriveArchivedSessions,
    // already returns global-recency rows, so this re-sort is a defensive
    // no-op there — kept so the pure function stays total for arbitrary
    // inputs, at the documented cost of one extra sort pass; the derive-side
    // fast paths above keep the common no-rows case free).
    entry.group.rows.sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
  }
  return entries.map(entry => entry.group)
}

/**
 * Compute the sidebar workspace list for one instance snapshot.
 * @param snapshot - one InstanceAggregate-like pull (workspaces/sessions).
 * @param serverId - the source id ('local' | 'ssh-<id>'); scopes the
 *   membership-grace lookup (grace entries are source-keyed — host session
 *   ids mint from per-process counters on some paths and could otherwise
 *   collide across sources).
 * @param ungroupedTitle - display title for the trailing ungrouped bucket;
 *   the sidebar overrides it when `ungrouped` is true; pass '' from App.
 * @param currentSessionId - the source's current session id (from the
 *   per-ctx runtime-facts channel), or undefined for non-active sources.
 *   Blank rows surface only when they carry this id (see sessionVisible).
 * @param now - epoch-ms of this derive (injected for tests; Date.now()
 *   otherwise). The ghost-slot grace and the membership grace are both
 *   measured against this clock, so an injected `now` makes the derive fully
 *   deterministic. Fork children of workspace-accounted parents receive a
 *   first-observation bounded grace; if membership still has not landed at
 *   expiry (including the host's documented publish-then-attach-failure
 *   path), they surface ungrouped.
 * @returns real workspaces in wire order (visible members in sessionIds
 *   order), plus one synthetic trailing ungrouped group when visible stray
 *   sessions exist; [] for an empty snapshot.
 */
export function deriveServerWorkspaces(
  snapshot: InstanceSnapshot,
  serverId: string,
  ungroupedTitle: string,
  currentSessionId?: string,
  now = Date.now(),
): ChamberServerWorkspace[] {
  const sessionsById = new Map(snapshot.sessions.map(session => [session.sessionId, session]))
  const archivedIds = new Set(snapshot.archivedSessionIds)
  const accounted = new Set<string>()
  const workspaces: ChamberServerWorkspace[] = []
  for (const workspace of snapshot.workspaces) {
    const sessions: ChamberServerWorkspace['sessions'] = []
    for (const sessionId of workspace.sessionIds) {
      const session = sessionsById.get(sessionId)
      if (session === undefined) continue
      accounted.add(sessionId)
      if (!sessionVisible(serverId, session, currentSessionId, archivedIds, now)) continue
      sessions.push({
        id: sessionId,
        title: session.title ?? '',
        running: session.running,
        updatedAt: session.updatedAt,
        // Sparse flag: only blank (provisional new-session) rows carry it, so
        // the sidebar can render the localized New Session label instead.
        ...(session.blank ? { blank: true } : {}),
        // 2026-09-11 upstream-alignment T7: the active-Schedule fact rides into
        // the row the sidebar renders (sparse, upstream name — see
        // hasActiveScheduleOf).
        ...(session.hasActiveSchedule === true ? { hasActiveSchedule: true } : {}),
      })
    }
    workspaces.push({
      id: workspace.workspaceId,
      title: workspace.title,
      sessions,
      // Display-only cwd-derived fallback groups (`__cwd__:` ids) keep their
      // marker so the sidebar can disable their mutation affordances.
      ...(workspace.synthetic === true ? { synthetic: true as const } : {}),
    })
  }
  const forkCandidates = new Set<string>()
  const stray = snapshot.sessions.filter(session => {
    if (accounted.has(session.sessionId)) return false
    if (!sessionVisible(serverId, session, currentSessionId, archivedIds, now)) return false

    // Fork responses can arrive after the host's session-added frame, so the
    // UI cannot pre-arm a child-id grace. Arm it on first observation instead.
    // Crucially this is bounded: attach can fail after publication, in which
    // case the still-unaccounted child surfaces when the grace expires.
    const parentAccounted = session.parentSessionId !== undefined && accounted.has(session.parentSessionId)
    if (parentAccounted) {
      forkCandidates.add(session.sessionId)
      if (forkMembershipGraceActive(serverId, session.sessionId, now)) return false
    }

    // A just-CREATED session whose workspace membership has not landed yet
    // must not flash through the ungrouped bucket. This map is explicitly
    // armed only by create-with-workspaceId, so genuine strays are unaffected.
    return !membershipGraceActive(serverId, session.sessionId, now)
  }).sort(byRecency)
  retainForkMembershipCandidates(serverId, forkCandidates)
  if (stray.length > 0) {
    workspaces.push({
      id: UNGROUPED_WORKSPACE_ID,
      title: ungroupedTitle,
      ungrouped: true,
      sessions: stray.map(session => ({
        id: session.sessionId,
        title: session.title ?? '',
        running: session.running,
        updatedAt: session.updatedAt,
        ...(session.blank ? { blank: true } : {}),
        // Same sparse active-Schedule carry as the workspace-member rows above.
        ...(session.hasActiveSchedule === true ? { hasActiveSchedule: true } : {}),
      })),
    })
  }
  return workspaces
}
