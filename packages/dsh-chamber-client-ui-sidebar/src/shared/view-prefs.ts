/**
 * Sidebar view preferences persisted in page-wide localStorage under one
 * versioned key (design 06 §3). All instance ctxs share ONE live in-memory
 * store (see getViewPrefs/subscribeViewPrefs/updateViewPrefs below); writes
 * persist + notify every subscriber. Every read/write is guarded —
 * corrupt JSON, a version mismatch or a wrong shape falls back to defaults,
 * and storage failures never throw. The default storage is resolved lazily
 * inside the call (never in a default-argument), so an accessor that throws
 * on opaque origins / sandboxed webviews degrades to defaults / no-op.
 */
import { chamberBridge } from './aggregate-store.ts'
import { assertSingletonModule } from './singleton.ts'
import type { SessionOrderBy } from './derive.ts'

assertSingletonModule('view-prefs')

export interface ChamberSidebarViewPrefs {
  v: 1
  /** key: `${sourceId}/${workspaceId}` */
  folded: Record<string, boolean>
  /** key: sourceId */
  ungroupedOrder: Record<string, string[]>
  /**
   * Per-source session ordering preference (design 06 §3.1 orderBy): key =
   * sourceId ('local', '<kind>-<id>'), value = SessionOrderBy. OPTIONAL — kept
   * so old persisted payloads (and any external literal constructor) stay
   * valid without a version bump (v stays 1: re-seeding on a version change
   * would drop folded/ungroupedOrder for data written by a mixed fleet).
   * Sanitization falls back to {} when the field is missing or holds illegal
   * values, and the write-time prune drops entries of sources that were seen
   * this session and vanished from the projection (same rule as
   * ungroupedOrder).
   */
  orderBy?: Record<string, SessionOrderBy>
  /**
   * Updated-mode session order accounts (design 06 §3.1; mirrors the official
   * ui-workspace sessionOrderByAccount): key = `${sourceId}/${workspaceId}` —
   * real workspaces AND the synthetic ungrouped bucket (its id is
   * UNGROUPED_WORKSPACE_ID). Each account holds the updated-mode display
   * baseline: seeded from the wire order on the first observation, mutated by
   * in-mode drags (persisted locally, no wire commit — official「updated 下
   * 拖拽只落 account」) and by the activity promotion (`nextUpdatedOrder`).
   * manual mode ignores it (wire/stored orders take over). OPTIONAL — absent
   * for sources that never entered updated mode; pruned by the same safe
   * source-vanished rule as orderBy/ungroupedOrder.
   */
  updatedOrder?: Record<string, string[]>
  /**
   * Updated-mode activity bookkeeping (official sessionUpdatedAtByAccount
   * mirror): key = the same `${sourceId}/${workspaceId}` account key, value =
   * sessionId → last observed updatedAt. The promotion derives from it
   * ("updated since the last observation → pinned to top"); the sidebar's
   * setOrderBy clears a source's entries when entering updated, which makes
   * the next derivation do ONE full recency sort (official
   * switchedToUpdated). Written together with updatedOrder by the derivation
   * effect. OPTIONAL; pruned with the account keys.
   */
  sessionUpdatedAtByAccount?: Record<string, Record<string, number>>
  /**
   * Source-level fold (06 §2.4): key = sourceId, value = the source's
   * workspace LIST is collapsed (every workspace group hidden).
   * Deliberately SEPARATE from `folded` — collapsing a server must NOT touch
   * each workspace's own conversation fold state (explicit user rule), so
   * expanding the server restores every workspace with its conversations
   * exactly as they were. OPTIONAL — absent = no source collapsed; kept so
   * old persisted payloads stay valid without a version bump (v stays 1).
   */
  sourceFolded?: Record<string, boolean>
  /**
   * Source display order (06 §2.4): sourceIds in the user's sidebar order.
   * DISPLAY-ONLY view preference — the App's N-ctx residency/prewarm order
   * and the instance registry are untouched (navigation is id-keyed, never
   * order-keyed). OPTIONAL — absent = projection order (local first, then
   * registry order); ids unknown to the projection are skipped by the
   * renderer, and unlisted ids trail in projection order (a newly added
   * source appears at the bottom until dragged). Kept so old persisted
   * payloads stay valid without a version bump (v stays 1).
   */
  serverOrder?: string[]
  /**
   * Page-wide sidebar width preference in px (design 06, chamber ui-layout
   * fork): the chamber layout store persists every drag (clamped into the
   * vendor [SIDEBAR_MIN, SIDEBAR_MAX] drag range, columns.ts) here, and
   * EVERY boot's layout store seeds from it — so dragging the resizer in one
   * shell is reflected in every other shell live, and the width survives
   * restarts (the vendor store is a per-boot unpersisted preference). The
   * sidebar (the only 'sidebar' slot occupant) is closed when its store
   * value is 0; the width PREFERENCE only ever records an OPEN drag — every
   * finite value clamps into [SIDEBAR_MIN, SIDEBAR_MAX] (a corrupt 0 clamps
   * up to the floor, never persists "closed"). OPTIONAL —
   * absent = never dragged (boots fall back to SIDEBAR_DEFAULT); kept so old
   * persisted payloads stay valid without a version bump (same rule as
   * orderBy).
   */
  sidebarWidth?: number
  /**
   * Internal bookkeeping (not user-facing): source ids observed in a
   * projection during THIS page session. The write-time prune only drops
   * keys whose source was SEEN (this session) and is now absent —
   * distinguishing "source deleted" (prune) from "projection not fully
   * loaded yet" (keep; the roster arrives after the local-only projection,
   * which must never wipe ssh sources' prefs). SESSION-ONLY memory: never
   * restored from storage — a persisted roster from a previous session would
   * make the FIRST write after restart prune against a still-unready
   * projection and permanently wipe remote prefs in the startup window (the
   * exact loss safe-pruning exists to prevent). Sources deleted in an
   * earlier session without any write this session leave harmless ghost keys
   * (the renderer's reconciledSessionOrder skips unknown ids).
   */
  seenSources: string[]
}

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export const VIEW_PREFS_KEY = 'dsh-chamber.sidebar.v1'

/**
 * Fresh default prefs — every fallback gets its OWN nested objects. A shared
 * module-level default object would let one caller's in-place mutation of a
 * returned prefs value permanently pollute every later default load and every
 * post-reset cache.
 */
function defaults(): ChamberSidebarViewPrefs {
  return { v: 1, folded: {}, ungroupedOrder: {}, orderBy: {}, updatedOrder: {}, sessionUpdatedAtByAccount: {}, seenSources: [] }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Lenient structural validation: drop malformed entries, keep valid ones. */
function sanitizePrefs(raw: unknown): ChamberSidebarViewPrefs {
  if (!isPlainObject(raw) || raw.v !== 1) return defaults()
  const folded: Record<string, boolean> = {}
  if (isPlainObject(raw.folded)) {
    for (const [key, value] of Object.entries(raw.folded)) {
      if (typeof value === 'boolean') folded[key] = value
    }
  }
  const ungroupedOrder: Record<string, string[]> = {}
  if (isPlainObject(raw.ungroupedOrder)) {
    for (const [key, value] of Object.entries(raw.ungroupedOrder)) {
      if (Array.isArray(value)) ungroupedOrder[key] = value.filter((entry): entry is string => typeof entry === 'string')
    }
  }
  // orderBy：丢弃非法值（非 'manual'/'updated'）条目；缺失字段（旧数据）
  // 回退空对象——v 保持 1，不因新增字段重播种。
  const orderBy: Record<string, SessionOrderBy> = {}
  if (isPlainObject(raw.orderBy)) {
    for (const [key, value] of Object.entries(raw.orderBy)) {
      if (value === 'manual' || value === 'updated') orderBy[key] = value
    }
  }
  // updatedOrder：account 键（`${sourceId}/${workspaceId}`）→ string[]；
  // 非数组/含非字符串条目丢弃，与 ungroupedOrder 同规则。
  const updatedOrder: Record<string, string[]> = {}
  if (isPlainObject(raw.updatedOrder)) {
    for (const [key, value] of Object.entries(raw.updatedOrder)) {
      if (Array.isArray(value)) updatedOrder[key] = value.filter((entry): entry is string => typeof entry === 'string')
    }
  }
  // sessionUpdatedAtByAccount：account 键 → sessionId → 有限数值时间戳，
  // 嵌套逐层校验。
  const sessionUpdatedAtByAccount: Record<string, Record<string, number>> = {}
  if (isPlainObject(raw.sessionUpdatedAtByAccount)) {
    for (const [key, value] of Object.entries(raw.sessionUpdatedAtByAccount)) {
      if (!isPlainObject(value)) continue
      const timestamps: Record<string, number> = {}
      for (const [id, at] of Object.entries(value)) {
        if (typeof at === 'number' && Number.isFinite(at)) timestamps[id] = at
      }
      sessionUpdatedAtByAccount[key] = timestamps
    }
  }
  // sourceFolded：键为 sourceId，布尔值过滤同 folded；缺失（旧数据）时不
  // 产出该键（v 保持 1），写入路径带空对象则保留。
  let hasSourceFolded = false
  const sourceFolded: Record<string, boolean> = {}
  if (isPlainObject(raw.sourceFolded)) {
    hasSourceFolded = true
    for (const [key, value] of Object.entries(raw.sourceFolded)) {
      if (typeof value === 'boolean') sourceFolded[key] = value
    }
  }
  // serverOrder：sourceId 有序数组——仅保留字符串条目并去重（首个位置胜出，
  // 防御损坏载荷）；非数组（含缺失）不产出该键（v 保持 1）。
  let serverOrder: string[] | undefined
  if (Array.isArray(raw.serverOrder)) {
    const seen = new Set<string>()
    serverOrder = raw.serverOrder.filter((entry): entry is string => {
      if (typeof entry !== 'string' || seen.has(entry)) return false
      seen.add(entry)
      return true
    })
  }
  // sidebarWidth：仅接受有限数值，钳制到厂商侧边栏拖动范围 [264, 420]
  // （@deepseek-ai/dsh-client-ui-layout columns.ts 的 SIDEBAR_MIN/SIDEBAR_MAX
  // 契约固定点，取整与 vendor clampWidth 一致）；非数值/非有限值（NaN、
  // Infinity、字符串等）一律丢弃，回退 SIDEBAR_DEFAULT。越界数值不丢弃而
  // 是钳制（与 vendor clampWidth 一致：0 也钳到下限 264——宽度偏好只记录
  // 「打开的拖动宽度」，「折叠」是 store 自己的 0 状态，不会持久化）。
  // v 保持 1：旧数据无该字段，不因新增字段重播种。
  let sidebarWidth: number | undefined
  if (typeof raw.sidebarWidth === 'number' && Number.isFinite(raw.sidebarWidth)) {
    sidebarWidth = Math.min(420, Math.max(264, Math.round(raw.sidebarWidth)))
  }
  // seenSources 保留 raw 里的数组值（写入路径经 sanitize 时须携带会话内
  // 簿记）；「绝不从存储恢复」由 loadViewPrefs 载入后归零保证（见下）。
  const seenSources = Array.isArray(raw.seenSources)
    ? raw.seenSources.filter((entry): entry is string => typeof entry === 'string')
    : []
  return {
    v: 1,
    folded,
    ungroupedOrder,
    orderBy,
    updatedOrder,
    sessionUpdatedAtByAccount,
    ...(hasSourceFolded ? { sourceFolded } : {}),
    ...(serverOrder !== undefined ? { serverOrder } : {}),
    ...(sidebarWidth !== undefined ? { sidebarWidth } : {}),
    seenSources,
  }
}

/**
 * Resolve the default page storage lazily; returns null when the accessor
 * itself throws or yields a falsy value (opaque origins, blocked storage,
 * sandboxed webviews, non-browser runs).
 */
function safeLocalStorage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

/** Read + sanitize the persisted prefs; never throws. */
export function loadViewPrefs(storage?: StorageLike): ChamberSidebarViewPrefs {
  const store = storage ?? safeLocalStorage()
  if (store == null) return defaults()
  let raw: unknown
  try {
    const text = store.getItem(VIEW_PREFS_KEY)
    if (text === null) return defaults()
    raw = JSON.parse(text)
  } catch {
    return defaults()
  }
  const prefs = sanitizePrefs(raw)
  // seenSources 是**会话内内存簿记**——载入时一律从空集开始：恢复上一会话
  // 持久化的 roster 会让重启后首个写周期在投影仅 local 的启动窗口把远程
  // 来源误判为「已删除」而永久抹掉其偏好。首个写周期因此不裁剪任何键
  // （安全）；源真正删除后、本会话内再有写入时才被裁。
  prefs.seenSources = []
  return prefs
}

/** Persist the prefs; never throws (storage failure is non-fatal). */
export function saveViewPrefs(prefs: ChamberSidebarViewPrefs, storage?: StorageLike): void {
  const store = storage ?? safeLocalStorage()
  if (store === null) return
  try {
    store.setItem(VIEW_PREFS_KEY, JSON.stringify(prefs))
  } catch {
    // non-fatal
  }
}

// ---------------------------------------------------------------------------
// Shared live store (design 06 §3 — cross-ctx live sync).
//
// One module-level cache is the SINGLE source of truth for every ctx's
// sidebar (this module rides the vite shared chunk, same instance across all
// boots): reads/writes go through it, writes persist and notify every
// subscriber, so a fold toggle in one source propagates live to all of them.
// A per-ctx in-memory copy read at mount would leave toggles invisible across
// sources until a refresh, and a later write could resurrect a stale value
// over the newer one another ctx persisted. localStorage stays the durable
// backing (reloads pick the latest state); the sanitized load and
// non-throwing storage fallbacks are unchanged.
// ---------------------------------------------------------------------------

type ViewPrefsListener = () => void
const listeners = new Set<ViewPrefsListener>()
let cache: ChamberSidebarViewPrefs | null = null

/** The shared prefs (lazily loaded + cached for the page lifetime). */
export function getViewPrefs(): ChamberSidebarViewPrefs {
  if (cache === null) cache = loadViewPrefs()
  return cache
}

/** Subscribe to shared-prefs changes (any ctx's write); returns the unsubscribe. */
export function subscribeViewPrefs(listener: ViewPrefsListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Prune stale entries against the CURRENT projection. SAFE rules only:
 * - an empty projection (not yet published, or nothing configured) is left
 *   untouched — user prefs must never be wiped against a transiently unready
 *   projection;
 * - keys are pruned only when their source was SEEN in an earlier projection
 *   of THIS session (seenSources — session-only memory, never restored from
 *   storage) and is absent from the current one, distinguishing "source
 *   deleted" from "projection not fully loaded yet". This matters because
 *   deriveServers always pushes `local` (servers.length is never 0 in the
 *   app), and the roster arrives AFTER the local-only projection: pruning on
 *   mere absence — or on a previous session's roster — would wipe every ssh
 *   source's prefs during the startup window;
 * - a disconnected source keeps its folds and ungrouped order (they return on
 *   reconnect; the renderer's reconciledSessionOrder already skips unknown
 *   ids).
 */
function prunePrefs(prefs: ChamberSidebarViewPrefs): ChamberSidebarViewPrefs {
  const servers = chamberBridge.getServers()
  if (servers.length === 0) return prefs
  const projectionIds = servers.map(server => server.id)
  const inProjection = new Set(projectionIds)
  // 本次投影见过的来源记入 seenSources——只可能在它们真正消失后被裁，
  // 绝不会在「尚未加载」的窗口被误裁。
  const seenSources = new Set(prefs.seenSources)
  for (const id of projectionIds) seenSources.add(id)
  const seen = [...seenSources]
  const knownGone = (sourceId: string | undefined): boolean =>
    sourceId !== undefined && !inProjection.has(sourceId) && seenSources.has(sourceId)
  const folded = { ...prefs.folded }
  const ungroupedOrder = { ...prefs.ungroupedOrder }
  const orderBy = { ...prefs.orderBy }
  const updatedOrder = { ...prefs.updatedOrder }
  const sessionUpdatedAtByAccount = { ...prefs.sessionUpdatedAtByAccount }
  // sourceFolded / serverOrder 同为可选字段：undefined 保持 undefined
  // （重建分支按原样携带，绝不把缺失变成空对象写回）。
  const sourceFolded = prefs.sourceFolded === undefined ? undefined : { ...prefs.sourceFolded }
  let serverOrder = prefs.serverOrder === undefined ? undefined : [...prefs.serverOrder]
  let changed = false
  for (const key of Object.keys(folded)) {
    const slash = key.indexOf('/')
    const sourceId = slash === -1 ? undefined : key.slice(0, slash)
    if (knownGone(sourceId)) {
      delete folded[key]
      changed = true
    }
  }
  for (const sourceId of Object.keys(ungroupedOrder)) {
    if (knownGone(sourceId)) {
      delete ungroupedOrder[sourceId]
      changed = true
    }
  }
  // orderBy 同 ungroupedOrder（sourceId 键）：裁掉「本会话见过、现已消失」
  // 来源的条目；断连来源保留（重连后仍按原偏好渲染）。
  for (const sourceId of Object.keys(orderBy)) {
    if (knownGone(sourceId)) {
      delete orderBy[sourceId]
      changed = true
    }
  }
  // updatedOrder / sessionUpdatedAtByAccount 同 folded（`${sourceId}/
  // ${workspaceId}` 键）：只裁「本会话见过、现已消失」的来源；断连来源的
  // 更新模式序/簿记保留（重连后 promotion 继续，不重播种）。
  for (const key of Object.keys(updatedOrder)) {
    const slash = key.indexOf('/')
    const sourceId = slash === -1 ? undefined : key.slice(0, slash)
    if (knownGone(sourceId)) {
      delete updatedOrder[key]
      changed = true
    }
  }
  for (const key of Object.keys(sessionUpdatedAtByAccount)) {
    const slash = key.indexOf('/')
    const sourceId = slash === -1 ? undefined : key.slice(0, slash)
    if (knownGone(sourceId)) {
      delete sessionUpdatedAtByAccount[key]
      changed = true
    }
  }
  // sourceFolded 同 orderBy（sourceId 键）：只裁「本会话见过、现已消失」的
  // 来源；断连来源保留。
  if (sourceFolded !== undefined) {
    for (const sourceId of Object.keys(sourceFolded)) {
      if (knownGone(sourceId)) {
        delete sourceFolded[sourceId]
        changed = true
      }
    }
  }
  // serverOrder（sourceId 有序数组）：裁掉「见过、已消失」的 id，其余保持
  // 相对顺序（渲染侧跳过未知 id，裁剪只是防死键堆积）。
  if (serverOrder !== undefined) {
    const kept = serverOrder.filter(id => !knownGone(id))
    if (kept.length !== serverOrder.length) {
      serverOrder = kept
      changed = true
    }
  }
  if (!changed && prefs.seenSources.length === seen.length && prefs.seenSources.every((id, i) => id === seen[i])) {
    return prefs
  }
  // The rebuild reconstructs from a fixed field list — carry sidebarWidth
  // (and any other optional field) explicitly so a write that prunes or
  // records a seen source never drops the persisted width preference.
  return {
    v: 1, folded, ungroupedOrder, orderBy, updatedOrder, sessionUpdatedAtByAccount,
    ...(sourceFolded !== undefined ? { sourceFolded } : {}),
    ...(serverOrder !== undefined ? { serverOrder } : {}),
    sidebarWidth: prefs.sidebarWidth, seenSources: seen,
  }
}

/**
 * Drop one source's activity-bookkeeping entries (updated-mode promotion
 * bookkeeping, keyed `${sourceId}/…`). PURE — returns the SAME reference when
 * nothing was removed (the caller can skip the write) and `undefined` for an
 * absent map. Used by the sidebar's setOrderBy on entering updated mode so the
 * next derivation does ONE full recency sort (official switchedToUpdated)
 * while the retained updatedOrder accounts are re-sorted, not re-seeded.
 */
export function clearSourceBookkeeping(
  bookkeeping: Readonly<Record<string, Record<string, number>>> | undefined,
  sourceId: string,
): Record<string, Record<string, number>> | undefined {
  if (bookkeeping === undefined) return undefined
  const prefix = `${sourceId}/`
  let touched = false
  const next: Record<string, Record<string, number>> = {}
  for (const [key, value] of Object.entries(bookkeeping)) {
    if (key.startsWith(prefix)) {
      touched = true
      continue
    }
    next[key] = value
  }
  return touched ? next : bookkeeping
}

/**
 * Write through the shared store: apply the mutator to the CURRENT shared
 * prefs, prune against the projection, persist (re-sanitized so the stored
 * shape is always the validated one), and notify every subscriber. A throwing
 * subscriber must not starve the others. The cache stores the SANITIZED
 * output — the mutator never gets to alias the live cached object into the
 * store, and an in-place-mutating mutator cannot corrupt the persisted shape.
 *
 * Equal writes do NOT notify: the recomputed result is compared to the cache
 * under a canonical encoding (recursively sorted key order, arrays in order)
 * first — identical values skip persistence and notification. The debounced
 * activity flush's final write can be exactly what another shell already
 * persisted; notifying on such an equal write would drive a needless
 * full-shell re-render.
 */
export function updateViewPrefs(mutator: (prev: ChamberSidebarViewPrefs) => ChamberSidebarViewPrefs): void {
  const prev = getViewPrefs()
  const next = sanitizePrefs(prunePrefs(mutator(prev)))
  if (canonicalEquals(prev, next)) return
  cache = next
  saveViewPrefs(cache)
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch (error) {
      console.error('[dsh-chamber] view-prefs subscriber threw:', error)
    }
  }
}

/** 规范化：递归输出键序稳定的对象图（数组保序）。值限 JSON 纯数据。 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key])
    return out
  }
  return value
}

function canonicalEquals(a: ChamberSidebarViewPrefs, b: ChamberSidebarViewPrefs): boolean {
  try {
    return JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b))
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// 置顶写回防抖 — updated 模式的 promotion 簿记写回是「观察会话 updatedAt
// 推进 → 置顶」的副作用：会话流式更新期间每个投影 tick 都会推进 updatedAt，
// 若每个 tick 各自 updateViewPrefs，写盘（整份 prefs JSON.stringify）+ 全壳
// 通知会随更新频率放大（跨 shell 共享 store，任何来源的流式会话都会驱动
// 全部侧栏重渲染）。防抖把同一固定窗内的多次派生合并为一次写回（首 arm 起
// VIEW_PREFS_ACTIVITY_DEBOUNCE_MS，非逐次重置的 true trailing——持续流下
// 每 ~250ms 一刷而非每 tick）：
//   - 每账户键保留**最新**派生意图：末 tick 自窗基态重派生、结果自洽，且
//     恰好等于 flush 时刻单个官方 tick 的输出；与逐 tick 落盘在交错突发/
//     首观察窗存在**排序级**差异（无数据丢失）；
//   - 固定窗结束统一经 updateViewPrefs 合并落盘一次；
//   - 页面隐藏/卸载时立即终刷（pagehide），防抖窗内未落盘的 promotion
//     簿记不丢（丢了会退化为官方首次观察的全量 recency 排序）。
// 离散写（拖拽提交/排序切换，SidebarRoot）在写前先 flushScheduledActivity
// Writes()——窗末终刷不得用旧派生覆盖更新的用户手势。
// 可视侧：防抖后置顶/固定顺序的可视更新最多滞后一个防抖窗（250ms）——
// 显示延迟而非数据丢失；渲染路径直接读持久账户
// （updatedOrder/sessionUpdatedAtByAccount），无 render-time promotion 之类
// 的中间派生面。
// ---------------------------------------------------------------------------

/** 置顶写回防抖窗（固定窗：首 arm 起 250ms）。突发流式 tick 收敛为 ≤1 次
 *  写回/窗。 */
export const VIEW_PREFS_ACTIVITY_DEBOUNCE_MS = 250

interface PendingActivity {
  order: string[]
  timestamps: Record<string, number>
}

let activityPending = new Map<string, PendingActivity>()
let activityTimer: ReturnType<typeof setTimeout> | null = null

/** 置顶写回（updated-mode promotion 簿记）按账户并入防抖窗。 */
export function scheduleUpdatedOrderWrite(
  accountKey: string,
  order: string[],
  timestamps: Record<string, number>,
): void {
  // 每账户最新意图胜出（末 tick 自窗基态重派生，结果自洽）。
  activityPending.set(accountKey, { order, timestamps })
  if (activityTimer === null) {
    activityTimer = setTimeout(() => flushScheduledActivityWrites(), VIEW_PREFS_ACTIVITY_DEBOUNCE_MS)
  }
}

/** 立即落盘所有防抖窗内 pending 的置顶写回（幂等；无 pending 为 no-op）。
 *  陈旧守卫：合并前逐账户检查——若**缓存**中同一账户存在某会话的 TS 严格
 *  大于 pending 对应 TS（另一 shell 已落盘更新观测），说明本 pending 派生
 *  自更旧的投影，整条跳过（不覆盖新 promotion/簿记；该账户由持有新投影的
 *  shell 的下一次派生重新武装，≤1 轮自愈）。比较按 pending 内**已知会话**
 *  逐条做（见下方循环）：若陈旧派生整体缺失某会话（其投影过期、从未含该
 *  会话），该账户不会因缺条而判 stale——整条覆盖会短暂抹掉该会话的簿记；
 *  同样由持有新投影的 shell 下一次派生重新武装。 */
export function flushScheduledActivityWrites(): void {
  if (activityTimer !== null) {
    clearTimeout(activityTimer)
    activityTimer = null
  }
  const pending = activityPending
  activityPending = new Map()
  if (pending.size === 0) return
  const orderMerge: Record<string, string[]> = {}
  const timestampsMerge: Record<string, Record<string, number>> = {}
  const cached = getViewPrefs().sessionUpdatedAtByAccount ?? {}
  for (const [key, activity] of pending) {
    const cachedTimestamps = cached[key]
    let stale = false
    if (cachedTimestamps !== undefined) {
      for (const [sessionId, timestamp] of Object.entries(activity.timestamps)) {
        const cachedTs = cachedTimestamps[sessionId]
        if (cachedTs !== undefined && cachedTs > timestamp) {
          stale = true
          break
        }
      }
    }
    if (stale) continue
    orderMerge[key] = activity.order
    timestampsMerge[key] = activity.timestamps
  }
  if (Object.keys(orderMerge).length === 0) return
  updateViewPrefs(prev => ({
    ...prev,
    updatedOrder: { ...prev.updatedOrder, ...orderMerge },
    sessionUpdatedAtByAccount: { ...prev.sessionUpdatedAtByAccount, ...timestampsMerge },
  }))
}

if (typeof globalThis.addEventListener === 'function') {
  globalThis.addEventListener('pagehide', () => flushScheduledActivityWrites())
}

/**
 * Test-only: reset the shared store (cache + subscribers) AND the projection
 * (prunePrefs' input — chamberBridge.getServers()) for isolation, and drop
 * any pending debounced activity writes. Without the projection reset, a
 * test's "first write sees an empty projection" assumption would depend on
 * declaration order (any earlier publish would make it a non-empty-projection
 * write and the assertions fail loudly — not a false green, but not a
 * self-contained isolation contract).
 */
export function __resetViewPrefsForTests(): void {
  if (activityTimer !== null) {
    clearTimeout(activityTimer)
    activityTimer = null
  }
  activityPending = new Map()
  cache = null
  listeners.clear()
  chamberBridge.publish([])
}
