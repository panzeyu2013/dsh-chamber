/**
 * Pure sidebar workspace-list derivation from a per-instance snapshot. Mirrors
 * the official dsh workspace browser rules (vendor ui-workspace tree.ts):
 * subagent-origin and archived sessions never surface, blank rows surface only
 * while current (the active source's provisional New Session row), real
 * workspaces keep wire membership order, and stray sessions trail in one
 * synthetic ungrouped bucket.
 * Deliberate mutable exceptions, single-instance via assertSingletonModule:
 * the blank-row ghost grace (`armBlankGhost` / `sessionVisible`, swept on
 * read), the create membership grace, and the fork first-observation grace.
 * All only ever SUPPRESS a row placement; derives stay deterministic for a
 * given (snapshot, current, now) plus the grace maps.
 */
import { chamberRunId } from '@dsh-chamber/dsh-stream-state'
import type { InstanceSnapshot, SearchRow, SessionRow, WorkspaceRow } from './instance-api.ts'
import type { GoalFact, SubagentActivity } from './session-row-state.ts'
import type { ChamberServerAggregate, ChamberServerWorkspace, InstanceRuntimeReport, ServerBootGap } from './aggregate-store.ts'
import { forgetMapSources } from './ledger.ts'
import { assertSingletonModule } from './singleton.ts'
import type { ArchivedSessionMetaRow } from './aggregate-types.ts'
import { basenameOf, hasActiveScheduleOf, sessionDisplayTitle } from './session-display.ts'

export { basenameOf, hasActiveScheduleOf, sessionDisplayTitle } from './session-display.ts'
export type { ArchivedSessionMetaRow } from './aggregate-types.ts'

// `blankGhostUntil` is CROSS-BOUNDARY shared state — armed by the sidebar
// bundle, read by the App's derive. Register it so a bundling drift that
// duplicates the module surfaces as a diagnostic, not split state per shell.
assertSingletonModule('derive')

/** Synthetic id of the trailing group that collects sessions outside every workspace. */
export const UNGROUPED_WORKSPACE_ID = '__ungrouped__'

/**
 * One-shot diagnostic flag for a malformed `goal` projection value (design 19
 * §3.2.1): the value repeats on every store notification while the host stays
 * broken, so the warning fires once per page lifetime (same discipline as
 * warnedCwdMembershipFallback below).
 */
let warnedGoalProjectionShape = false

/** goal 相位白名单（wire 词表；未知词 = 形状不符）。 */
const GOAL_PHASES = new Set<GoalFact['phase']>(['active', 'paused', 'blocked', 'complete'])

/**
 * Parse one row's `projectionValues.goal` into the three-valued goal fact
 * (design 19 §3.2.1). The wire value is NESTED:
 * `{ goal: { id, revision, phase }, roundsStarted, updatedAt } | null`.
 *
 * Three values, NOT interchangeable: `undefined` = unknown (absent key, absent
 * value or malformed shape — never folded into "no goal", and the parse stays
 * sparse so the producer can restore the last known fact); `null` = the
 * projection explicitly said "no goal"; object = the projected goal
 * (id/revision/phase/updatedAt only — objective and blockedReason are
 * deliberately never read). Malformed shapes warn once per page lifetime and
 * stay unknown, never a fabricated `null` (which would settle a pending
 * completion).
 */
export function parseGoalFact(
  projectionValues: Readonly<Record<string, unknown>> | undefined,
): GoalFact | null | undefined {
  if (projectionValues === undefined) return undefined
  if (!Object.hasOwn(projectionValues, 'goal')) return undefined
  const value = projectionValues.goal
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) return warnGoalShape()
  const record = value as Record<string, unknown>
  const nested = record.goal
  if (nested === null || typeof nested !== 'object' || Array.isArray(nested)) return warnGoalShape()
  const goal = nested as Record<string, unknown>
  const goalId = goal.id
  const revision = goal.revision
  const phase = goal.phase
  if (typeof goalId !== 'string' || goalId === '') return warnGoalShape()
  // 严格度与 P2a/P2b 对齐（source-mux-facts / control-plane 的 parseProjectedGoalFact）：
  // revision 是安全整数且 >= 1，updatedAt 是安全整数且 >= 0；浮点/负数/不安全整数
  // = 形状不符（unknown）。
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) return warnGoalShape()
  if (typeof phase !== 'string' || !GOAL_PHASES.has(phase as GoalFact['phase'])) return warnGoalShape()
  const fact: GoalFact = { goalId, revision, phase: phase as GoalFact['phase'] }
  const updatedAt = record.updatedAt
  if (typeof updatedAt === 'number' && Number.isSafeInteger(updatedAt) && updatedAt >= 0) fact.updatedAt = updatedAt
  return fact
}

/** Warn once, then keep returning `undefined` (unknown) — never a fake `null`. */
function warnGoalShape(): undefined {
  if (!warnedGoalProjectionShape) {
    warnedGoalProjectionShape = true
    console.warn(
      '[chamber] session goal projection has an unexpected shape — treating it as UNKNOWN '
      + '(not as "no goal"); last-known goal facts stay in force',
    )
  }
  return undefined
}

/** Test-only: re-arm the one-shot goal-shape warning (node tests share the module instance). */
export function __resetGoalProjectionWarningForTests(): void {
  warnedGoalProjectionShape = false
}

/** Canonical-path equality key: trailing separators normalized only. No
 *  fs.realpath in the browser, so symlinked spellings (e.g. macOS /tmp →
 *  /private/tmp) can still miss — unmatched sessions fall back to the
 *  ungrouped bucket. Exported for the workspace echo's host-canonical create
 *  path comparison. */
export function canonicalPathKey(value: string): string {
  return value.replace(/[\\/]+$/, '')
}

/**
 * One-shot diagnostic flag for the cwd-membership wire-degradation fallback:
 * the degenerate cross-section repeats on every store notification, so the
 * console warning fires once per page lifetime.
 */
let warnedCwdMembershipFallback = false

/** Wire search query clamp: at most 500 UTF-16 code units. */
export const SEARCH_QUERY_MAX_CODE_UNITS = 500

/**
 * Stable per-workspace icon accent: a deterministic color from the workspace
 * identity — no customization, no persistence, no selection state. Hue is a
 * golden-angle spread of the (serverId, family seed) hash; a second hash
 * jitters lightness (56/61/66%) so near-hue pairs stay distinguishable;
 * saturation is soft (34%, or 21% for derived worktrees).
 * Derived worktrees inherit their repository's family hue — the family seed is
 * the repoKey, shared by the main checkout and every worktree, stable even
 * when the main is unregistered; `mainWorkspaceId` is the repoKey-less
 * fallback. The ungrouped bucket gets NO accent (CSS default ink); selection
 * is deliberately not encoded here (`WorkspaceAccentSeed` is a structural
 * subset of the git plugin's `WorkspaceGitFlag`, keeping this module git-free).
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
 * Golden-angle hue step: hue = (hash × 137.508) mod 360. 137.508 = 34377/250,
 * so two hashes share an exact hue only when they differ by a multiple of
 * 30000; the lightness jitter breaks any remaining visual tie.
 */
const WORKSPACE_HUE_STEP = 137.508

/** Deterministic 32-bit string hash (the sidebar sourceHue arithmetic). */
function hashString(input: string): number {
  let hash = 0
  for (let i = 0; i < input.length; i += 1) hash = (hash * 31 + input.charCodeAt(i)) >>> 0
  return hash
}

/**
 * Deterministic per-source accent color: remote sources hash their source id,
 * the LOCAL source omits the accent (undefined) and falls back to the default
 * ink. THE single palette definition for every surface.
 */
export function sourceAccentColor(sourceId: string): string | undefined {
  return sourceId === 'local' ? undefined : `hsl(${hashString(sourceId) % 360} 34% 61%)`
}

/** Per-workspace accent CSS variable for the workspace header row; undefined
 *  for the ungrouped bucket so the CSS fallback chain keeps its visuals. */
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
  // One-decimal hue normalized into [0, 360): 359.96 rounds to 360.0.
  const hue = (Math.round(rawHue * 10) % 3600) / 10
  // Soft palette: saturation 34% (21% for worktrees) + lightness 56/61/66%,
  // pastel-calm while keeping the family/main-vs-derived hierarchy.
  const saturation = seed?.isWorktree === true ? 21 : 34
  const lightness = 56 + (hashString(workspaceId) % 3) * 5
  return { '--chamber-workspace-accent': `hsl(${hue} ${saturation}% ${lightness}%)` }
}

/**
 * Search input normalization: strip NULs, clamp to SEARCH_QUERY_MAX_CODE_UNITS
 * UTF-16 code units without splitting a surrogate pair, trim; '' when empty.
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
 * How long a just-created session stays out of the synthetic ungrouped bucket
 * while its workspace membership has not landed. The host commits creation and
 * workspace attach as TWO ordered frames, so a snapshot pushed between them
 * would flash the new session ungrouped for one frame.
 * Armed ONLY by the create path (which always carries an explicit
 * workspaceId), so it can never hide a genuinely ungrouped session; the FORK
 * path uses its own first-observation grace (see deriveServerWorkspaces). 3s
 * covers the mutation-triggered aggregate pull's round trip, even over a slow
 * SSH tunnel.
 */
export const MEMBERSHIP_GRACE_MS = 3_000

/**
 * Module-level membership-grace map: `${serverId}:${sessionId}` -> expiry
 * epoch-ms. Source-scoped because host session ids are per-process counters on
 * some minting paths. Written only by `armMembershipGrace`, read only by the
 * SAME source's stray filter; lazy sweeps on write (all expired entries) and
 * read (the queried id) bound it.
 */
const membershipGraceUntil = new Map<string, number>()

/**
 * Source-scoped fork grace, armed on the first snapshot where a fork child is
 * unaccounted while its parent is workspace-accounted. An expired entry is
 * retained while the candidate remains present so repeated derives cannot
 * re-arm it forever; removed once the child is accounted, disappears, or stops
 * qualifying.
 */
const forkMembershipGraceByServer = new Map<string, Map<string, number>>()

/**
 * Arm (or refresh) the membership grace for a session the sidebar just created
 * under `serverId`, synchronously after the create mutation resolves and
 * BEFORE requesting the App-layer refresh, so the App's next derive skips the
 * session's ungrouped placement; refreshing overwrites the expiry.
 */
export function armMembershipGrace(serverId: string, sessionId: string, now = Date.now()): void {
  for (const [key, expiry] of membershipGraceUntil) {
    if (expiry <= now) membershipGraceUntil.delete(key)
  }
  membershipGraceUntil.set(`${serverId}:${sessionId}`, now + MEMBERSHIP_GRACE_MS)
}

/**
 * Whether the session's ungrouped placement is suppressed by an active
 * membership grace for the same source (expired entries swept on read). The
 * grace ONLY affects stray placement — a session listed in a workspace's
 * sessionIds renders there regardless.
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

/** Converge grace state with the live server registry: a removed source never
 *  derives again, so candidate pruning alone cannot reclaim it; a same-id
 *  re-add must start with a fresh generation. */
export function retainMembershipGraceSources(liveServerIds: ReadonlySet<string>): void {
  forgetMapSources(membershipGraceUntil, (key) => {
    const separator = key.indexOf(':')
    return separator === -1 ? key : key.slice(0, separator)
  }, liveServerIds)
  forgetMapSources(forkMembershipGraceByServer, key => key, liveServerIds)
}

/** Test-only: clear both membership-grace maps (node tests share the module instance). */
export function __resetMembershipGracesForTests(): void {
  membershipGraceUntil.clear()
  forkMembershipGraceByServer.clear()
}

/**
 * Merge a stored ungrouped order with the wire order: wire-known ids come in
 * stored order first, then the remaining wire ids in wire order; ids unknown
 * to the wire are skipped.
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
 * Source display order: stored order first for ids known to the projection,
 * then the remaining projection ids in projection order (a new source appears
 * at the bottom until dragged; unknown stored ids are skipped, so a deleted
 * source leaves no ghost group). `undefined` returns the projection order
 * unchanged — the same reference, so callers can skip re-renders.
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
 * Server-group drop order math: the display order from inserting
 * `draggedSourceId` at `over`'s boundary of the CURRENT rendered order. `null`
 * = NO-OP (the target or dragged source vanished, the dragged source IS the
 * anchor, or the position did not move); the anchor math mirrors the workspace
 * commit (before -> over.id, after -> next id, undefined = append).
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
 * machine. PURE — called inside a functional state updater so batched reports
 * compose without losing earlier arms.
 *
 * "Being read" is the ACTIVE view's current session (the App's fact), not this
 * ctx's possibly-stale `selected`: a running→idle edge arms unless the session
 * is being read; re-running, leaving the list, or starting to read disarms.
 * `prevRunning` is the source's last-observed bits — a per-report snapshot,
 * never a shared ref. @returns the next armed set (identity when unchanged).
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
      // Re-run disarms.
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
 * Turn-end classification of a completion edge: `completed` arms, and so does
 * an UNREADABLE tail (the degraded marker, `lastTurnEnd: null` +
 * `degraded`). `aborted` + cause `user` is a user stop; every other known kind
 * (blocked/error/max-tokens/interrupted) is neutral, i.e. suppresses the arm.
 * Kept as the wire vocabulary so a future kind cannot silently count as a
 * completion.
 */
export interface TurnEndFact {
  kind?: 'completed' | 'aborted' | 'blocked' | 'error' | 'max-tokens' | 'interrupted'
  cause?: 'user' | 'parent' | 'hook' | 'disposed' | 'legacy'
  /** Host-domain timestamp of the edge (wire diagnostics; the predicate reads only `kind`). */
  at?: number
  /** Monotonic completion seq of the edge (wire diagnostics; read mark cursors use it separately). */
  seq?: number
}

/**
 * THE unread predicate: unread ⟺ max(updatedAt, completedAt) > readThrough.
 * `updatedAt` (host domain) is valid however the turn ended, so a user stop
 * still leaves the user's own prompt unread. `completedAt` counts when the
 * classification is `completed` OR ABSENT — absent is the watcher's degraded
 * marker for an unreadable tail, where the edge has already armed, so
 * fail-closed here would LOSE a real completion; a known non-completion
 * (aborted incl. `user`, blocked, error, max-tokens, interrupted) suppresses
 * the arm. `readThrough` is the host-domain watermark (absent/0 = nothing
 * read); comparisons are strictly `>` and use ONLY the integer inputs — no
 * client wall clock, no ledger state.
 */
export function deriveUnread(
  completedAt: number | undefined,
  lastTurnEnd: TurnEndFact | null | undefined,
  readThrough: number | undefined,
  updatedAt: number | undefined,
): boolean {
  const kind = lastTurnEnd === undefined || lastTurnEnd === null ? undefined : lastTurnEnd.kind
  const knownNonCompletion = kind !== undefined && kind !== 'completed'
  const completedWatermark = completedAt !== undefined && !knownNonCompletion ? completedAt : 0
  const watermark = Math.max(updatedAt ?? 0, completedWatermark)
  return watermark > (readThrough ?? 0)
}

/**
 * Project one ctx's sessions snapshot into the chamber runtime-facts report.
 * Pure pass-through: every listed session carries its live `running` bit;
 * `completed`/`pending` ride the vendor runtime's armed state as sparse extras.
 * The App derives the completed-but-unread dot from running→idle edges itself —
 * it owns the active view, so it alone knows what "being read" means.
 * `subagentRunning` (running descendant count per parent) and
 * `pendingInteractions` are INJECTED by the plugin — this module stays free of
 * unbuilt vendor packages. The pending kind mapping mirrors the official
 * `visiblePendingKind`: unknown kinds stay undefined. The loose ReadonlyMap
 * avoids importing runtime store types.
 *
 * The goal fact (design 19 §3.2.1) is parsed HERE from the row's
 * projection bag and rides SPARSELY: a row whose `projectionValues.goal` parsed
 * (object or explicit null) carries `goal`; an absent key means UNKNOWN and
 * carries nothing — the PRODUCER (client/index.ts) restores the last known fact
 * per source generation and merges the event-cached activation there.
 */
export function projectRuntimeFacts(
  snapshot: {
    current?: string
    byId?: Record<string, {
      running?: boolean
      completed?: boolean
      origin?: 'subagent'
      updatedAt?: number
      /**
       * The mounted store's `SessionSummary.projectionValues` — read for the
       * `goal` projection value (and, on the snapshot path above, schedule).
       */
      projectionValues?: Readonly<Record<string, unknown>>
    }>
  },
  subagentRunning?: ReadonlyMap<string, number>,
  pendingInteractions?: ReadonlyMap<string, { kind?: string }>,
  runIds?: ReadonlyMap<string, string>,
): InstanceRuntimeReport {
  const sessions: InstanceRuntimeReport['sessions'] = {}
  for (const [id, facts] of Object.entries(snapshot.byId ?? {})) {
    // subagent 行不进入运行时事实（与 projectInstanceSnapshot 的 origin 过滤同规）：
    // 导航不呈现子会话，通知边沿也不得对子代理完成/提问发通知。
    // 子代理完成是高频事件，漏入会刷屏。
    if (facts?.origin === 'subagent') continue
    const row: {
      running?: boolean
      completed?: boolean
      pending?: 'approval' | 'plan-review' | 'question'
      runningSubagents?: number
      subagentActivity?: SubagentActivity
      runId?: string
      updatedAt?: number
      goal?: GoalFact | null
    } = {
      running: facts?.running === true,
    }
    if (typeof facts?.updatedAt === 'number' && Number.isSafeInteger(facts.updatedAt) && facts.updatedAt >= 0) {
      row.updatedAt = facts.updatedAt
    }
    if (facts?.completed === true) row.completed = true
    // v5 §2.1 三值事实：解析成功（对象/null）才写字段；键缺席/形状不符 = unknown，
    // 保持稀疏（生产者按来源代回填最后已知值）。
    const goal = parseGoalFact(facts?.projectionValues)
    if (goal !== undefined) row.goal = goal
    // pending rides the official ui-session registry; unknown kinds stay
    // undefined so a future upstream kind cannot leak into the UI.
    const pending = pendingKindOf(pendingInteractions?.get(id)?.kind)
    if (pending !== undefined) row.pending = pending
    // 索引缺席 = unknown（不是「没有运行中的子代理」）；索引在场且计数为零 = none。
    // 计数保持稀疏（>0 才写字段）。
    const runningSubagents = subagentRunning === undefined ? undefined : (subagentRunning.get(id) ?? 0)
    if (runningSubagents !== undefined && runningSubagents > 0) row.runningSubagents = runningSubagents
    row.subagentActivity = subagentRunning === undefined
      ? 'unknown'
      : (runningSubagents !== undefined && runningSubagents > 0 ? 'running' : 'none')
    const runId = runIds?.get(id)
    if (runId !== undefined) row.runId = runId
    sessions[id] = row
  }
  const report: InstanceRuntimeReport = { sessions }
  if (snapshot.current !== undefined) report.current = snapshot.current
  return report
}

/** One observed run episode of a session (the producer's identity memory). */
export interface RunIdentityObservation {
  /** Host activity time of the LAST observed completion. The run's identity is
   *  minted at the completion tick, where the run's own prompt time is available:
   *  the host emits running=true BEFORE the prompt's activity frame, so a start-time
   *  mint would anchor on the PREVIOUS run's timestamp and fold the next run. A
   *  replayed completion with the same activity keeps the existing identity, which
   *  is what lets the durable receipt suppress the duplicate. */
  readonly completedActivityAt?: number
  /** Episode counter, monotonic per session within the producer's lifetime. */
  readonly episode: number
  /** The chamber-family run id minted for this episode. */
  readonly runId: string
  /** Whether the row was running at the last observation. */
  readonly running: boolean
}

/**
 * Advance the producer's per-session run identities from the current store rows.
 *
 * - a row already running keeps its minted id (reports inside one run agree);
 * - a row observed running after a non-running observation mints a NEW episode;
 * - a row that stopped keeps its last id (its completion still belongs to it);
 * - ids absent from `live` are dropped (bounded growth).
 *
 * The minting rule is the shared resolver's chamber fallback, executed by the one
 * authority for this channel, so the App never mints a competing id (I1).
 *
 * `generation` MUST be unique per producer registration (see the sidebar's
 * PRODUCER_GENERATION_BASE): episodes restart at 1 in every lifetime, so a shared
 * generation would let two REAL runs of one session carry the same run id - the
 * native receipt then treats the second completion as already shown (missed
 * notification). A generation change is a new lifetime, never a stale episode.
 */
export interface RunIdentityAdvance {
  readonly identities: Map<string, RunIdentityObservation>
  /**
   * Producer-lifetime episode high-water (sessionId → last minted episode). Callers
   * MUST feed it back. Rebuilding episodes only from `live` let a session that left
   * the snapshot restart at episode 1 in the SAME lifetime, so two real runs shared
   * a run id and the native receipt suppressed the second banner.
   *
   * NEVER PRUNE this map inside a lifetime: dropping an entry is exactly the bug -
   * a session that returns would re-mint an episode already used. It is bounded by
   * the number of distinct session ids one page lifetime ever observed.
   */
  readonly episodes: Map<string, number>
}

export function advanceRunIdentities(input: {
  readonly previous: ReadonlyMap<string, RunIdentityObservation>
  readonly running: ReadonlySet<string>
  readonly live: ReadonlySet<string>
  readonly sourceFingerprint: string
  /** Lifetime nonce from the producer; never re-used across registrations. */
  readonly generation: number
  /** Previous high-water, fed back from the last call. */
  readonly episodes?: ReadonlyMap<string, number>
  /** Host `updatedAt` per session; the run-start ordering key. */
  readonly activity?: ReadonlyMap<string, number>
}): RunIdentityAdvance {
  const episodes = new Map(input.episodes ?? [])
  const next = new Map<string, RunIdentityObservation>()
  for (const sessionId of input.live) {
    const previous = input.previous.get(sessionId)
    const activityAt = input.activity?.get(sessionId)
    if (input.running.has(sessionId)) {
      if (previous !== undefined) {
        // Carry the last completion anchor: the identity is minted on the completion
        // tick, never at the start (the host emits running before the prompt).
        next.set(sessionId, { ...previous, running: true })
        continue
      }
      // First observed mid-run: a provisional identity so the row has a run id; the
      // completion tick mints the one it notifies with.
      const episode = Math.max(episodes.get(sessionId) ?? 0, 0) + 1
      episodes.set(sessionId, episode)
      next.set(sessionId, {
        episode,
        running: true,
        runId: chamberRunId({
          sourceFingerprint: input.sourceFingerprint,
          generation: input.generation,
          sessionId,
          episode,
        }),
      })
      continue
    }
    const lastCompleted = previous?.completedActivityAt
    // With a completion anchor and a host time the ordering is exact. Without one of
    // them only a real run transition (first observation or running->false) mints:
    // repeated no-activity snapshots must not churn a new episode every tick.
    const newCompletion = lastCompleted !== undefined && activityAt !== undefined
      ? activityAt > lastCompleted
      : previous === undefined || previous.running === true
    if (!newCompletion && previous !== undefined) {
      // A replay of the completion this identity already belongs to: keeping the id
      // is what makes the durable receipt suppress the duplicate banner.
      next.set(sessionId, { ...previous, running: false })
      continue
    }
    // A live drop is not a new namespace: the episode must clear the high-water
    // even when `previous` was already discarded.
    const episode = Math.max(previous?.episode ?? 0, episodes.get(sessionId) ?? 0) + 1
    episodes.set(sessionId, episode)
    next.set(sessionId, {
      episode,
      running: false,
      ...(activityAt === undefined ? {} : { completedActivityAt: activityAt }),
      runId: chamberRunId({
        sourceFingerprint: input.sourceFingerprint,
        generation: input.generation,
        sessionId,
        episode,
      }),
    })
  }
  return { identities: next, episodes }
}

/** Official `visiblePendingKind` mirror: the three presentation kinds chamber
 *  renders, anything else stays invisible. */
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
 * Project the two already-live ctx stores into the same chamber snapshot shape
 * as the unary fallback. `undefined` means either reconnect baseline is
 * incomplete; callers must invalidate the push snapshot and let the bounded
 * fallback pull take over. Subagent rows are deliberately excluded because
 * chamber navigation never renders them.
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
      /** The mounted vendor store resolves the official display label itself —
       *  carried verbatim into the snapshot row. */
      displayTitle?: string
      cwd?: string
      parentId?: string
      origin?: 'subagent'
      running?: boolean
      blank?: boolean
      updatedAt?: number
      /** The row's projection bag; read for the active-Schedule fact only. */
      projectionValues?: Readonly<Record<string, unknown>>
    }>
    phase?: string
  },
): InstanceSnapshot | undefined {
  // Both arrival phases are sticky after their first success. The workspace
  // store also projects its pull-activity `state` (loading/error during a
  // reconnect while `phase` stays ready), so a loading/error workspace
  // withdraws here — clearing the producer's content signature so an identical
  // recovered baseline is emitted again instead of being suppressed forever.
  // The session store projects only `phase`; its baseline refreshes with the
  // workspace baseline on reconnect, so the workspace `state` is the single
  // completeness authority there (arrival = state 'idle' + both phases ready;
  // upstream has no `baselinesReady` field).
  if (workspaces.state !== 'idle'
    || workspaces.phase !== 'ready' || sessions.phase !== 'ready') return undefined
  const byId = sessions.byId ?? {}
  // Wire-degradation defense: the host projects `WorkspaceView.sessionIds`
  // through a canonical-cwd header index built at registry init; when that
  // index is incomplete (legacy headers without cwd, cwd not resolving), the
  // baseline carries workspace rows with EMPTY sessionIds while sessions
  // exist — the sidebar would sink every session into the ungrouped bucket.
  // Detect that degenerate cross-section (ready + non-empty items + non-empty
  // sessions + zero accounted members + a cwd match) and synthesize membership
  // from the session cwd facts, keeping the store's workspace
  // identity/order/title; the cwd-match guard keeps genuinely-empty workspaces
  // untouched.
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
  // the browser): compare with trailing separators normalized only. Symlinked
  // spellings (e.g. macOS /tmp → /private/tmp) can still miss; unmatched
  // sessions stay in the ungrouped bucket.
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
        // Sparse — the fact rides the row only when the session actually owns
        // an active schedule, so every other row's snapshot bytes stay untouched.
        ...(hasActiveScheduleOf(row.projectionValues) ? { hasActiveSchedule: true as const } : {}),
        // Official display label: the mounted vendor store already resolved it;
        // the resolver's cwd/id ladder applies only if a producer drops it.
        displayTitle: sessionDisplayTitle({
          displayTitle: row.displayTitle,
          title: row.title,
          ...(row.cwd === undefined ? {} : { cwdBasename: basenameOf(row.cwd) }),
          sessionId: String(row.id),
        }),
        ...(row.cwd !== undefined ? { cwd: row.cwd } : {}),
        ...(row.title !== undefined ? { title: row.title } : {}),
        ...(row.parentId !== undefined ? { parentSessionId: String(row.parentId) } : {}),
      }]
    }),
    archivedSessionIds: (workspaces.archivedSessionIds ?? []).map(String),
    // The mounted ctx store's workspace baseline IS the authoritative
    // archive-set source — even an empty set is a true "nothing archived" fact.
    archiveSetKnown: true,
  }
}

/**
 * Narrow RENDER-FIELD overlay of one session row (facts-injection projection):
 * the headless-observer / SessionFactsSource contribution that must reach the
 * sidebar even when the source's shell is not mounted. ONLY rendered fields
 * ride it — `updatedAt`/`completedAt` deliberately never enter the projection.
 */
export interface RuntimeFactsOverlayRow {
  pending?: 'approval' | 'plan-review' | 'question'
  runningSubagents?: number
  /** 观察者刷新这一行事实的 host 域毫秒（渲染字段，不参与任何判定）。 */
  factAt?: number
  /**
   * Goal 三值事实（design 19 §3.2.1 P2a/§3.5）：**无壳来源**（facts-only）
   * 的 goal 行事实经 overlay 进投影——mounted 源的 goal 由它自己的生产者经通道
   * 行给出，此处缺席 = unknown（绝不伪造 null）。null = 明确无 goal（可覆盖通道
   * 行的 unknown）。
   */
  goal?: GoalFact | null
}

/** One source's render-field overlay, keyed by session id (see {@link RuntimeFactsOverlayRow}). */
export type RuntimeFactsOverlay = Readonly<Record<string, RuntimeFactsOverlayRow>>

/**
 * Merge one source's live runtime-facts report with the App-owned
 * completed-but-unread dots: the UNION of the channel's vendor-armed completed
 * rows and the App-derived dots (the App's running→idle edge machine is
 * authoritative for background sources; the vendor's completed is a fallback),
 * preserving the current session and every other live row. PURE; returns
 * undefined when there is nothing to attach.
 *
 * `overlay` supplies render fields when the shell channel is absent: pending —
 * channel wins, overlay fills an absent kind; runningSubagents — channel ??
 * overlay; `current` and the running bit never come from the overlay. `stale`
 * marks a DISCONNECTED source's rows (consumers label, never present them as
 * live); it needs attachable content, so stale alone returns undefined.
 * The input report's own `stale` bit is OR-ed in (callers forward it on the
 * channel); dropping it would let the six-face guards read a disconnected
 * source's retained facts as live.
 */
export function mergeRuntimeFacts(
  runtime: InstanceRuntimeReport | undefined,
  completedBySource: Record<string, boolean> | undefined,
  overlay?: RuntimeFactsOverlay,
  stale?: boolean,
): InstanceRuntimeReport | undefined {
  const chamberCompleted = completedBySource
  const hasArmed = chamberCompleted !== undefined && Object.values(chamberCompleted).some(value => value === true)
  const hasOverlay = overlay !== undefined && Object.keys(overlay).length > 0
  // The report's own stale bit (channel) counts exactly like the explicit arg.
  const hasStale = stale === true || runtime?.stale === true
  // `stale` alone is not content: with no report, no armed dot and no overlay
  // row there is nothing to attach, so the two-argument early return is
  // preserved verbatim (compatibility lock).
  if (runtime === undefined && !hasArmed && !hasOverlay) {
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
  if (hasOverlay) {
    for (const [sessionId, extra] of Object.entries(overlay)) {
      if (extra === undefined) continue
      const row = sessions[sessionId] ?? {}
      let next = row
      // pending: the channel's authoritative kind wins; the overlay only fills
      // an absent one.
      if (row.pending === undefined && extra.pending !== undefined) next = { ...next, pending: extra.pending }
      // runningSubagents stays sparse (absent = 0) so an overlay 0 never adds a
      // signature key.
      if (next.runningSubagents === undefined && extra.runningSubagents !== undefined && extra.runningSubagents > 0) {
        next = { ...next, runningSubagents: extra.runningSubagents }
      }
      // I5 时间戳只随观察者走，overlay 直接写；它是渲染字段，不参与判定。
      if (extra.factAt !== undefined && extra.factAt > 0) next = { ...next, factAt: extra.factAt }
      // goal（P2a）：通道行已给出（对象或显式 null）即权威；absent = unknown 由
      // overlay 的已知值（含显式 null）填补——无壳来源的呈现门/徽标/待办读它。
      if (next.goal === undefined && extra.goal !== undefined) next = { ...next, goal: extra.goal }
      sessions[sessionId] = next
    }
  }
  // 断连来源上残留的子代理计数不是「正在干活」的证据——running 降为 unknown（计数本身
  // 保留给诊断）；overlay 合并后通道补进来的计数同样受守卫，不留旁路。
  // 的计数同样受守卫，不留旁路。
  if (hasStale) {
    for (const [sessionId, row] of Object.entries(sessions)) {
      if (row.subagentActivity === 'running' || (row.subagentActivity === undefined && (row.runningSubagents ?? 0) > 0)) {
        sessions[sessionId] = { ...row, subagentActivity: 'unknown' }
      }
    }
  }
  // 刻意的形状收敛：`sessionAuthority` 不进投影（侧边栏不渲染、投影签名按此去重）；
  // 升级 ladder 读 App 原始 runtimeFacts，不是 server.runtime。
  // 读原始事实，不要以为投影里有。
  const report: InstanceRuntimeReport = { current: runtime?.current, sessions }
  if (hasStale) report.stale = true
  return report
}

/**
 * v5 §2.1 last-known goal retention — the PRODUCER-side merge (client/index.ts
 * owns one map per source generation): a parsed object/null wins and enters the
 * map, an unknown row gets the previous fact written back, and a session absent
 * from THIS report leaves the map (行消失即 drop ⇒ the map stays bounded by the
 * current report). PURE except for the write-back on the passed report.
 */
export function retainGoalFacts(
  report: InstanceRuntimeReport,
  previous: ReadonlyMap<string, GoalFact | null>,
): Map<string, GoalFact | null> {
  const next = new Map<string, GoalFact | null>()
  for (const [sessionId, row] of Object.entries(report.sessions)) {
    if (row.goal !== undefined) {
      next.set(sessionId, row.goal)
      continue
    }
    const lastKnown = previous.get(sessionId)
    if (lastKnown === undefined) continue
    row.goal = lastKnown
    next.set(sessionId, lastKnown)
  }
  return next
}

/**
 * Merge the event-cached activation (design 19 §2.2) into known OBJECT goal
 * facts only, and only when the value changes (an unchanged pass keeps the goal
 * object identity — no churn). The cache belongs to client/goal-activation.ts;
 * this is the pure merge seam.
 */
export function applyGoalActivation(
  report: InstanceRuntimeReport,
  activationOf: (sessionId: string) => GoalFact['activation'],
): void {
  for (const [sessionId, row] of Object.entries(report.sessions)) {
    const goal = row.goal
    if (goal === undefined || goal === null) continue
    const activation = activationOf(sessionId)
    if (activation === undefined || goal.activation === activation) continue
    row.goal = { ...goal, activation }
  }
}

/**
 * Content signature of one instance snapshot (workspaces + sessions + archived
 * ids). The App layer uses it to keep aggregate state identity-preserving: an
 * update whose rows are byte-identical must NOT mint a new state object (it
 * would re-derive servers, re-publish the chamber bridge and re-render every
 * sidebar on every fallback tick). Key order is fixed by the wire row
 * constructors, so JSON.stringify is deterministic across updates.
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
      // The display label MUST ride the signature: it lands asynchronously, so
      // a label-only change has to republish or the dedupe gate freezes the row
      // at its first-seen label.
      d: row.displayTitle,
      b: row.blank,
      // The schedule fact MUST ride the signature: otherwise a session gaining
      // or losing its schedule republishes identical bytes and the dedupe gate
      // suppresses the update. `undefined` serializes away, so schedule-less
      // rows keep their bytes.
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
 * Sidebar running-ring visibility: the ring shows ONLY from the complete
 * aggregate snapshot field; the channel's running bit is deliberately IGNORED
 * (`channelRunning` is accepted so the contract stays testable).
 * Runtime facts and the structural snapshot are never OR/precedence merged:
 * one rendered field has one authority.
 */
export function runningRingVisible(_channelRunning: boolean | undefined, polledRunning: boolean | undefined): boolean {
  return polledRunning === true
}

/**
 * Content signature of one runtime-facts report (current + per-session facts;
 * every listed session carries its live `running` bit, with `completed`/
 * `pending`/`runningSubagents` as sparse extras).
 *
 * `onlyIds` restricts the signature to the sessions actually rendered: a
 * hidden session flipping its bits must NOT re-render the list, while the
 * App's identity check needs the full report. `includeRunning=false` is the
 * PROJECTION signature — the ring renders from the polled wire bit, so a
 * channel-only running flip must not re-publish. `listComplete` is a JUDGMENT
 * input, but it must move the App's identity signature too, or a "facts
 * unchanged, list became authoritative" report is deduplicated away and the
 * pruning gate freezes.
 *
 * GOAL RIDES THE ROW ENCODING — OUTSIDE the `includeRunning` branch: every goal
 * field (goalId/revision/phase/activation/updatedAt) is encoded by
 * `goalFactSignature` for BOTH consumers — the projection path must re-publish on
 * a goal move (the row suppresses its completed dot from it), and the App
 * identity path must see every activation transition, including a
 * durable-state-free `armed` landing. Unknown (absent), explicit `null` and an
 * object are three DISTINCT encodings.
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
      `${id}:${includeRunning && facts.running === true ? 'r' : ''}${facts.completed === true ? 'c' : ''}${facts.pending ?? ''}:${facts.runningSubagents ?? 0}:${facts.subagentActivity ?? ''}${goalFactSignature(facts.goal)}`)
  // L1 对账回执也是事实内容的一部分，必须进签名——App 的运行时事实提交按本签名
  // 去重：回执若不入签名，一次「事实没变、只有回执结算」的上报会被整个丢弃，守卫
  // 随后误判「对账通道无回执」并升级 reconnect/L3。只签在 `includeRunning` 路径；
  // **投影**签名不得因回执变化而重发布（侧边栏不渲染回执，回执变化对它是 churn）。
  const authority = report.sessionAuthority
  const receipt = !includeRunning || authority === undefined
    ? ''
    : `#a:${authority.settledAt === undefined ? 'p' : String(authority.settledAt)}:${authority.ok ? '1' : '0'}:${String(authority.progressStamp)}:${authority.stuckSince === undefined ? '-' : String(authority.stuckSince)}`
  // listComplete：官方 session list 的 arrival phase（pending → ready 后不回退）
  // 是「缺席即删除」的权威门，属判定输入；只签在 includeRunning（App 身份校验）
  // 路径，投影签名不得因它单独翻转而重发布，否则一次「事实未变、只有 listComplete
  // 翻到 ready」的上报会被去重吞掉，派生层永远看不到权威缺席门。
  // 去重吞掉，派生层永远看不到权威缺席门（同 832-845 的签名教训）。
  const listComplete = !includeRunning || report.listComplete === undefined
    ? ''
    : `#l:${report.listComplete ? '1' : '0'}`
  // `stale` 是**渲染事实**（侧栏 `server.runtime?.stale` → data-chamber-stale /
  // sessionStateLabel 的离线读数；mergeRuntimeFacts 把它 OR 进合并报告并把残留
  // 子代理计数降为 unknown），与回执/listComplete 这两类"只签在身份路径"的判定
  // 输入不同：两条签名路径都必须签它——投影路径漏签会让「行不变、仅 stale 翻转」
  // 的上报不重发布，身份路径漏签会让 App 的去重（use-bridge-subscriptions 的
  // runtimeReportSignature 守卫）直接吞掉它，mergeRuntimeFacts 的 stale OR 永远
  // 失效（断连来源的残留事实被当成 live）。false 与缺席同义（no-op 旗标），只签 true。
  const stale = report.stale === true ? '#s:1' : ''
  // A report whose only rows were filtered out (no visible session, no current)
  // is indistinguishable from "no runtime attached" unless it carries a
  // receipt, listComplete or a stale bit — 回执/权威门/断连标记本身就是内容，
  // 不得被去重吞掉（会话清空那一瞬的回执结算与首份 ready 列表同理）。
  if (rows.length === 0 && current === '' && receipt === '' && listComplete === '' && stale === '') return ''
  return `${current}|${rows.join(',')}${receipt}${listComplete}${stale}`
}

/**
 * Goal row encoding of {@link runtimeReportSignature} (v5 §2.1): unknown
 * (absent field), explicit `null` and an object are three distinct encodings,
 * and every durable AND volatile field participates (a state-free `armed`
 * landing must move the signature or the App identity freezes it).
 */
function goalFactSignature(goal: GoalFact | null | undefined): string {
  if (goal === undefined) return ''
  if (goal === null) return '|g:n'
  return `|g:${JSON.stringify([goal.goalId, goal.revision, goal.phase, goal.activation ?? null, goal.updatedAt ?? null])}`
}

/**
 * Field-GENERIC identity of a settled-boot gap for publish signatures: every
 * payload field takes part (so a field added to the fact later cannot freeze a
 * subscription), fields are order-normalized, array order is preserved — and
 * "no payload" is one thing (an absent field, an empty array, `null` and an
 * empty string all encode to nothing), so a producer that omits vs
 * materializes an empty field cannot churn the gate.
 */
export function gapSignature(gap: ServerBootGap | undefined): string | null {
  return gap === undefined ? null : factRecordSignature(gap)
}

function encodeFactValue(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null
  if (Array.isArray(value)) return value.length === 0 ? null : `[${value.map(item => String(item)).join('\u0000')}]`
  return JSON.stringify(value)
}

/**
 * The `key=value` identity of a fact record: components sorted, `\u0001`-joined,
 * empty values dropped, and `omit` keys never entering. The single encoder for
 * every settled-boot signature.
 */
export function factRecordSignature(record: object, omit: readonly string[] = []): string {
  return Object.entries(record)
    .filter(([key]) => !omit.includes(key))
    .flatMap(([key, value]) => {
      const encoded = encodeFactValue(value)
      return encoded === null ? [] : [`${key}=${encoded}`]
    })
    .sort()
    .join('\u0001')
}

/**
 * Render-relevant projection signature of the merged multi-source projection:
 * everything the sidebar (and the settings bridge) renders or uses as a
 * lifecycle boundary, and nothing else.
 * - sourceFingerprint is not visible UI, but a same-id replacement must
 *   publish so source-owned child contexts retire synchronously;
 * - `updatedAt` is part of the session row (updated = manual order + activity
 *   promotion), so a last-activity tick re-publishes the projection;
 * - the runtime portion is restricted to sessions visible in the projection;
 * - the per-session active-Schedule marker can flip ALONE, so the row carries
 *   it.
 * The App layer gates chamberBridge.publish on this signature, and the sidebar
 * subscription re-checks it as defense in depth.
 */

export function serversProjectionSignature(servers: readonly ChamberServerAggregate[]): string {
  // JSON encoding (not delimiter concatenation): titles/labels are
  // user-controlled and could otherwise make two projections collide.
  // change.
  return JSON.stringify(servers.map(server => {
    const visibleSessionIds = new Set<string>()
    for (const workspace of server.workspaces) {
      for (const session of workspace.sessions) visibleSessionIds.add(session.id)
    }
    // The runtime signature string is collision-free in its domain
    // (machine-generated ids, fixed enums, numeric counts), so embedding it as
    // a JSON string value is unambiguous. A report whose rows were all filtered
    // out normalizes to null. includeRunning=false is the projection: the ring
    // renders from the polled wire bit.
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
      // Render-relevant: the source header's managed-down note branches on it.
      managedRuntimeDown: server.managedRuntimeDown === true,
      dshVersion: server.dshVersion ?? null,
      aggregateError: server.aggregateError ?? null,
      // pluginDiagnostic STAYS in the publish gate: the sidebar no longer
      // renders it, but the settings-bridge derives the connections page's
      // pluginDiagnostics from the same chamberBridge channel, so a
      // diagnostic-only flip must still re-publish.
      // block would regress it.
      pluginDiagnostic: server.pluginDiagnostic === undefined ? null : {
        state: server.pluginDiagnostic.state,
        message: server.pluginDiagnostic.message ?? null,
        pluginId: server.pluginDiagnostic.pluginId ?? null,
      },
      // bootGap is RENDERED (the source row's warning line) AND consumed by the
      // settings-bridge, and is encoded field-generically so a payload field
      // added later cannot silently freeze the sidebar.
      // field added later freeze the sidebar silently).
      bootGap: gapSignature(server.bootGap),
      runtime: runtime === '' ? null : runtime,
      workspaces: server.workspaces.map(w => ({
        id: w.id,
        title: w.title,
        ungrouped: w.ungrouped === true,
        // Synthetic rows disable their mutation affordances in the sidebar.
        synthetic: w.synthetic === true,
        // "+" reads this RENDERED-BEHAVIOUR fact to decide between reopening the
        // existing blank row and creating one; a candidate appearing or
        // disappearing alone must republish, or both publish gates drop it and
        // "+" mints the very empty session this field prevents.
        // very empty session this field exists to prevent.
        reusableBlankSessionId: w.reusableBlankSessionId ?? null,
        sessions: w.sessions.map(x => ({
          id: x.id,
          title: x.title,
          // The resolved label is what the row RENDERS, so it must move this
          // signature: a healed predecessor row can flip id -> directory name
          // with no durable-title change, and that flip must republish.
          // change, and that label flip must republish.
          displayTitle: x.displayTitle,
          running: x.running === true,
          blank: x.blank === true,
          // Render-relevant: updated-mode ordering derives from it.
          updatedAt: x.updatedAt ?? null,
          // The active-Schedule marker is RENDERED right after the row title and
          // can flip while nothing else changes, so it must move this signature;
          // non-sparse on purpose — this row is a change detector, never
          // persisted.
          // detector, never persisted, so a stable false is free.
          hasActiveSchedule: x.hasActiveSchedule === true,
        })),
      })),
      // Archived rows ride the publish gate too (an open manager dialog derives
      // from them). Change detection needs only identity + recency: a row's
      // title/cwd/workspace cannot change through any UI surface, and every
      // host-side archive/purge/content path also moves the workspace block. The
      // archive-set PROVENANCE flag rides along — a mounted↔fallback transition
      // must re-publish, since the dialog's degraded branch depends on it.
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
 * non-interactive GHOST. Without it a double click below the blank row
 * mis-targets: click1 opens the session, the blank row disappears, rows shift
 * up, and click2 hits the row that was BELOW the target. Must exceed the
 * 350ms double-click window; 450ms covers it plus re-derive latency.
 */
export const BLANK_GHOST_GRACE_MS = 450

/**
 * Module-level ghost grace map: departed blank `sourceId:sessionId` -> expiry
 * epoch-ms. Source-scoped, because cloned instances can carry the SAME session
 * UUID and a bare sessionId key would cross sources. Written by `armBlankGhost`
 * (the sidebar, at the transition click) and read by `sessionVisible`; the row
 * keeps its slot until expiry so the list never shifts inside the double-click
 * window, and the sidebar stops RENDERING the ghost at the same expiry so the
 * placeholder cannot linger. Expired entries are lazily swept on write and
 * read — bounded either way.
 */
const blankGhostUntil = new Map<string, number>()

/**
 * Arm (or refresh) the ghost-slot grace for a blank session that just stopped
 * being current. The sidebar calls this SYNCHRONOUSLY in a row onClick, BEFORE
 * requesting the open, so the App's next derive keeps the row; refreshing
 * overwrites the expiry, so a later real transition always wins over an
 * earlier stale arm. Expired entries are swept lazily (at most one blank row
 * per source).
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
 * blank rows follow the official rule (!blank || current), plus the ghost-slot
 * exception — a blank row that stopped being current within
 * BLANK_GHOST_GRACE_MS stays visible (non-interactively) so the list cannot
 * shift inside the double-click-to-rename window. Only the ACTIVE source
 * passes a current session id, so no other source's provisional blank row
 * ever enters the projection.
 */
function sessionVisible(
  serverId: string,
  session: { sessionId: string; blank: boolean; origin?: 'subagent' },
  currentSessionId: string | undefined,
  archived: ReadonlySet<string>,
  now: number,
): boolean {
  // Lazy SWEEP on read: an expired ghost entry is dropped the first time a
  // derive consults it; the currentness branch keeps a CURRENT blank row
  // visible regardless. At most one blank row per source, so this stays O(1);
  // the source-scoped key keeps cloned UUIDs from sharing grace.
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
 * Relative time for session rows as a structured, localizable bucket
 * ("now"/"5min"/"3h"/"2d"/"4mo"/"1y"): mirrors the official relativeTime()
 * exactly — 60s/60min/24h/30d/365d thresholds, n floored, diff clamped at
 * >=0, unit 'now' with n=0.
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
 * tiebreak; a missing wire updatedAt sorts as 0.
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

/** Per-workspace session ordering preference (orderBy). */
export type SessionOrderBy = 'manual' | 'updated'

/**
 * Recency-sort an id array by updatedAt (newest first, id ascending
 * tiebreak; missing updatedAt sorts as 0). PURE.
 */
function sortIdsByRecency<T extends { id: string; updatedAt?: number }>(
  ids: readonly string[],
  byId: ReadonlyMap<string, T>,
): string[] {
  return [...ids].sort((a, b) => compareRecency(a, byId.get(a)?.updatedAt, b, byId.get(b)?.updatedAt))
}

/**
 * One session order account's next updated-mode derivation — the official
 * `nextSessionOrderAccount` port (updated = manual order + activity promotion,
 * not a pure recency re-sort). Stored order and last-observed timestamps are
 * written back together: baseline = stored order reconciled with the current
 * membership (new wire ids appended), or the wire order when never observed.
 * With no bookkeeping (first observation, or just switched in) it is ONE full
 * recency sort; otherwise sessions whose updatedAt increased (or was never
 * observed) are PROMOTED to the top, recency-sorted, and stay pinned until a
 * newer promotion or a manual drag. PURE. `changed` = stored order or
 * timestamps differ from the given state.
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
    // First observation / just switched in: full recency sort.
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
 * goes through `nextUpdatedOrder`): stored ids first via
 * reconciledSessionOrder, unknown ids appended in wire order; the wire order
 * copy when no stored order exists.
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
 * Local-metadata search hits (the official deriveSearchResults local segment):
 * a session matches when its title OR the title of a workspace it belongs to
 * contains the query substring (case-insensitive). Blank / archived /
 * subagent-origin rows never match; a missing session title can still hit via
 * a workspace title. Hits are recency-ordered with an empty snippet (the
 * remote merge overlays the content snippet).
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
    // The DISPLAY label is what the user reads, so search matches it: a row
    // labeled by its project directory must be findable by that directory.
    // that directory, not only by its durable title.
    const title = sessionDisplayTitle({
      displayTitle: session.displayTitle,
      title: session.title,
      ...(session.cwd === undefined ? {} : { cwdBasename: basenameOf(session.cwd) }),
      sessionId: session.sessionId,
    })
    const workspaceTitle = workspaceTitleBySession.get(session.sessionId)
    const titleHit = title.toLowerCase().includes(q)
    const workspaceHit = workspaceTitle !== undefined && workspaceTitle.toLowerCase().includes(q)
    if (!titleHit && !workspaceHit) continue
    matches.push(session)
  }
  matches.sort(byRecency)
  return matches.map(session => ({ sessionId: session.sessionId, snippet: '' }))
}

/**
 * Merge local metadata hits with the remote content-search page: local rows
 * lead in their recency order, then remote rows not already covered by a local
 * hit keep the backend order; duplicate sessionIds collapse to one row, and a
 * locally-hit session that also matched remotely carries the remote snippet.
 * hasMore = remote hasMore OR the merged result exceeds the limit.
 *
 * Remote items are filtered against the caller's visible-session set first:
 * when the projection is READY that set is authoritative and an empty set
 * filters ALL remote hits (hidden sessions must never resurface in clickable
 * results); only a not-ready projection degrades to no filtering, so a
 * temporarily absent snapshot never wipes out remote hits.
 */
export function mergeSearchResults(
  local: readonly SearchRow[],
  remote: { items: readonly SearchRow[]; hasMore: boolean },
  limit: number,
  visibleIds: ReadonlySet<string>,
  projectionReady: boolean,
): { items: SearchRow[]; hasMore: boolean } {
  // 投影 READY 后可见集是权威：空集 = 合法空；未就绪时降级为不过滤。
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
 * Fork-child title increment — VERBATIM port of the official
 * `increasedForkTitle`: a trailing half-width or full-width parenthesized
 * number increments (BigInt, no precision loss), any other title starts at
 * ` (1)`. The wire `session/fork` accepts only `{ sessionId, atSeq? }`, so the
 * client renames the child itself.
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


/**
 * Archived-session metadata for the archive manager. The archived SET is the
 * authoritative membership gate: a row classifies as archived only when its id
 * is in snapshot.archivedSessionIds. Subagent rows never enter the snapshot,
 * so only top-level sessions are listed (their descendants are deleted with
 * the tree by host purge semantics). Rows sort by recency. The unary fallback
 * has NO archive-set wire source (known degradation) and carries an empty set —
 * except when the App substitutes its remembered authoritative set on a
 * degraded commit, while `archiveSetKnown` stays false as the provenance gate.
 * Workspace attribution: authoritative membership first, then a canonical
 * cwd==path fallback, otherwise no workspace.
 */
export function deriveArchivedSessions(snapshot: InstanceSnapshot): ArchivedSessionMetaRow[] {
  // Fast paths: the derive runs on the render path for every connected source,
  // so empty results must cost nothing — no Set build, no scan, no sort, no
  // attribution index.
  // option; these guards remove the common-case cost).
  if (snapshot.archivedSessionIds.length === 0) return []
  const archived = new Set(snapshot.archivedSessionIds)
  // Both snapshot producers keep session ids unique, so the filter cannot yield
  // duplicates; row order = snapshot order, then a stable recency sort below.
  // row order = snapshot order, then stable recency sort below.
  const rows = snapshot.sessions.filter(session => archived.has(session.sessionId))
  if (rows.length === 0) return []
  rows.sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
  // Attribution indexes over the SNAPSHOT's workspace rows (the full membership
  // view, not the nav projection, which drops archived rows); synthetic
  // cwd-derived groups only coexist with an empty archive set, so attribution
  // never resolves through them in practice. Built only when rows exist.
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
      // NOTE: the running bit is deliberately NOT carried — the host purge skips
      // running subtrees whole (skippedRunning); a per-row delete of a running
      // archived session is a safe post-hoc skip surfaced by the result note.
      // safe post-hoc skip, surfaced by the result note.
    }
  })
}

/** One workspace group of the manager's collapsible listing: the header facts
 *  plus its archived rows. */
export interface ArchivedSessionGroup {
  /** The workspace's registry id, or UNGROUPED_WORKSPACE_ID for rows with no
   *  attribution. */
  key: string
  /** Display title of real workspace groups ('' for the ungrouped bucket). */
  title: string
  /** Present only for real workspace groups (folder/accent chrome). */
  workspace?: { id: string; title: string }
  rows: ArchivedSessionMetaRow[]
}

/**
 * Split archived rows into ordered workspace groups: groups by their NEWEST
 * member (updatedAt desc, stable ties), rows within a group by recency desc;
 * the UNGROUPED bucket trails LAST, mirroring the nav's trailing group. PURE.
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
    // Defensive per-group re-sort: older callers may not pre-sort (the only
    // in-tree caller already returns global-recency rows, so this is a no-op).
    // fast paths above keep the common no-rows case free).
    entry.group.rows.sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
  }
  return entries.map(entry => entry.group)
}

/**
 * The official reuse-or-create predicate for one workspace ("+"/boot): the
 * FIRST session that is blank, belongs to this workspace, lives in the
 * workspace's own directory and is not archived; only when none exists is one
 * created. The chamber's "+" resolves the same way instead of issuing an
 * unconditional session/create, one of the paths that mint invisible empty
 * sessions.
 * Readings come from the RAW snapshot, never the visibility-filtered derived
 * rows: a blank row is visible only while it is current, so a derived-row
 * search could never find the reusable row the predicate is about. Hardening
 * on top of upstream: subagent and fork children are never reusable.
 */
export function findReusableBlankSession(
  workspace: Pick<WorkspaceRow, 'path' | 'sessionIds'>,
  sessions: readonly SessionRow[],
  archived: ReadonlySet<string>,
): string | undefined {
  for (const session of sessions) {
    if (session.blank !== true) continue
    if (session.cwd !== workspace.path) continue
    if (session.origin === 'subagent' || session.parentSessionId !== undefined) continue
    if (!workspace.sessionIds.includes(session.sessionId)) continue
    if (archived.has(session.sessionId)) continue
    return session.sessionId
  }
  return undefined
}

/**
 * Compute the sidebar workspace list for one instance snapshot.
 *
 * `serverId` scopes the membership-grace lookup (grace entries are
 * source-keyed — host session ids mint from per-process counters and could
 * collide). `currentSessionId` is the source's current session, which is what
 * makes a blank row surface. `now` is the derive clock: ghost-slot and
 * membership graces are measured against it, so an injected `now` makes the
 * derive deterministic. Fork children of workspace-accounted parents get a
 * bounded first-observation grace and surface ungrouped if membership never
 * lands. @returns real workspaces in wire order, plus one synthetic trailing
 * ungrouped group when visible strays exist; [] for an empty snapshot.
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
        // Official display label: project directory name when no title.
        displayTitle: sessionDisplayTitle({
          displayTitle: session.displayTitle,
          title: session.title,
          ...(session.cwd === undefined ? {} : { cwdBasename: basenameOf(session.cwd) }),
          sessionId,
        }),
        running: session.running,
        updatedAt: session.updatedAt,
        // Sparse: only blank (provisional new-session) rows carry it, so the
        // sidebar can render the localized New Session label.
        ...(session.blank ? { blank: true } : {}),
        // The active-Schedule fact rides into the row the sidebar renders (sparse).
        // hasActiveScheduleOf).
        ...(session.hasActiveSchedule === true ? { hasActiveSchedule: true } : {}),
      })
    }
    // Requires an AUTHORITATIVE archive set: with the unary fallback's unknown
    // set an archived blank row would look reusable, so degrade to create.
    const reusableBlankSessionId = snapshot.archiveSetKnown === true && workspace.synthetic !== true
      ? findReusableBlankSession(workspace, snapshot.sessions, archivedIds)
      : undefined
    workspaces.push({
      id: workspace.workspaceId,
      title: workspace.title,
      sessions,
      ...(reusableBlankSessionId === undefined ? {} : { reusableBlankSessionId }),
      // Display-only cwd-derived fallback groups keep their marker, so the
      // sidebar disables their mutation affordances.
      ...(workspace.synthetic === true ? { synthetic: true as const } : {}),
    })
  }
  const forkCandidates = new Set<string>()
  const stray = snapshot.sessions.filter(session => {
    if (accounted.has(session.sessionId)) return false
    if (!sessionVisible(serverId, session, currentSessionId, archivedIds, now)) return false

    // Fork responses can arrive after the host's session-added frame, so the UI
    // cannot pre-arm a child-id grace: arm it on first observation instead,
    // bounded — an attach failure after publication surfaces the child at expiry.
    // case the still-unaccounted child surfaces when the grace expires.
    const parentAccounted = session.parentSessionId !== undefined && accounted.has(session.parentSessionId)
    if (parentAccounted) {
      forkCandidates.add(session.sessionId)
      if (forkMembershipGraceActive(serverId, session.sessionId, now)) return false
    }

    // Armed only by create-with-workspaceId, so genuine strays are unaffected.
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
        // Same official display-label rule as the workspace-member rows above.
        displayTitle: sessionDisplayTitle({
          displayTitle: session.displayTitle,
          title: session.title,
          ...(session.cwd === undefined ? {} : { cwdBasename: basenameOf(session.cwd) }),
          sessionId: session.sessionId,
        }),
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
