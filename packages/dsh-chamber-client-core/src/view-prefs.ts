/**
 * Sidebar view preferences persisted in page-wide localStorage under one
 * versioned key. All instance ctxs share ONE live in-memory store; writes
 * persist + notify every subscriber. Every read/write is guarded: corrupt JSON,
 * a version mismatch or a wrong shape falls back to defaults, and storage
 * failures never throw. The default storage is resolved lazily inside the call
 * (never in a default-argument), so a throwing accessor degrades to defaults.
 */
import { chamberBridge } from './aggregate-store.ts'
import { assertSingletonModule } from './singleton.ts'
import { isRecord } from './wire-common.ts'
import type { SessionOrderBy } from './derive.ts'

assertSingletonModule('view-prefs')

export interface ChamberSidebarViewPrefs {
  v: 1
  /** key: `${sourceId}/${workspaceId}` */
  folded: Record<string, boolean>
  /** key: sourceId */
  ungroupedOrder: Record<string, string[]>
  /**
   * Per-source session ordering preference: key = sourceId ('local',
   * '<kind>-<id>'), value = SessionOrderBy. OPTIONAL — old persisted payloads
   * stay valid without a version bump (v stays 1; re-seeding would drop
   * folded/ungroupedOrder for data written by a mixed fleet). Missing/illegal
   * values fall back to {}, and the write-time prune drops entries of sources
   * seen this session that vanished from the projection.
   */
  orderBy?: Record<string, SessionOrderBy>
  /**
   * Updated-mode session order accounts (mirrors the official
   * ui-workspace sessionOrderByAccount): key = `${sourceId}/${workspaceId}` —
   * real workspaces AND the synthetic ungrouped bucket. Each account holds the
   * updated-mode display baseline: seeded from the wire order on first
   * observation, mutated by in-mode drags (persisted locally, no wire commit)
   * and by activity promotion (`nextUpdatedOrder`). manual mode ignores it.
   * OPTIONAL; pruned by the same safe source-vanished rule.
   */
  updatedOrder?: Record<string, string[]>
  /**
   * Updated-mode activity bookkeeping (official sessionUpdatedAtByAccount
   * mirror): account key → sessionId → last observed updatedAt. The promotion
   * derives from it ("updated since last observation → pinned to top"); the
   * sidebar clears a source's entries on entering updated, making the next
   * derivation do ONE full recency sort. Written together with updatedOrder.
   */
  sessionUpdatedAtByAccount?: Record<string, Record<string, number>>
  /**
   * Source-level fold: key = sourceId, value = the source's workspace LIST is
   * collapsed. SEPARATE from `folded` on purpose — collapsing a server must not
   * touch each workspace's own conversation fold state, so expanding restores
   * every workspace exactly as it was. OPTIONAL (v stays 1).
   */
  sourceFolded?: Record<string, boolean>
  /**
   * Source display order: sourceIds in the user's sidebar order. DISPLAY-ONLY —
   * the App's N-ctx residency/prewarm order is untouched. OPTIONAL: absent =
   * projection order; unknown ids are skipped by the renderer and unlisted ids
   * trail in projection order. (v stays 1.)
   */
  serverOrder?: string[]
  /**
   * Page-wide sidebar width preference in px: the layout store persists every
   * drag (clamped into the vendor [SIDEBAR_MIN, SIDEBAR_MAX] range) here, and
   * EVERY boot's layout store seeds from it — so a drag in one shell is live in
   * every other shell and the width survives restarts (the vendor store is
   * per-boot unpersisted). The width PREFERENCE only ever records an OPEN drag:
   * every finite value clamps into range (a corrupt 0 clamps up to the floor,
   * never persists "closed"; "closed" is the store's own 0 state). Absent =
   * never dragged (boots fall back to SIDEBAR_DEFAULT).
   */
  sidebarWidth?: number
  /**
   * Internal bookkeeping (not user-facing): source ids observed in a projection
   * during THIS page session. The write-time prune only drops keys whose source
   * was SEEN this session and is now absent — distinguishing "source deleted"
   * from "projection not fully loaded yet" (the roster arrives after the
   * local-only projection, which must never wipe ssh sources' prefs).
   * SESSION-ONLY: never restored from storage — a persisted roster would make
   * the first write after restart prune against a still-unready projection and
   * permanently wipe remote prefs. Ghost keys from earlier sessions are
   * harmless (the renderer skips unknown ids).
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
 * module-level default would let one caller's in-place mutation pollute every
 * later default load and post-reset cache.
 */
function defaults(): ChamberSidebarViewPrefs {
  return { v: 1, folded: {}, ungroupedOrder: {}, orderBy: {}, updatedOrder: {}, sessionUpdatedAtByAccount: {}, seenSources: [] }
}

/** Lenient structural validation: drop malformed entries, keep valid ones. */
function sanitizePrefs(raw: unknown): ChamberSidebarViewPrefs {
  if (!isRecord(raw) || raw.v !== 1) return defaults()
  const folded: Record<string, boolean> = {}
  if (isRecord(raw.folded)) {
    for (const [key, value] of Object.entries(raw.folded)) {
      if (typeof value === 'boolean') folded[key] = value
    }
  }
  const ungroupedOrder: Record<string, string[]> = {}
  if (isRecord(raw.ungroupedOrder)) {
    for (const [key, value] of Object.entries(raw.ungroupedOrder)) {
      if (Array.isArray(value)) ungroupedOrder[key] = value.filter((entry): entry is string => typeof entry === 'string')
    }
  }
  // orderBy：丢弃非法值条目；缺失字段（旧数据）回退空对象——v 保持 1。
  const orderBy: Record<string, SessionOrderBy> = {}
  if (isRecord(raw.orderBy)) {
    for (const [key, value] of Object.entries(raw.orderBy)) {
      if (value === 'manual' || value === 'updated') orderBy[key] = value
    }
  }
  // updatedOrder：account 键 → string[]；非数组/非字符串条目丢弃，同 ungroupedOrder。
  const updatedOrder: Record<string, string[]> = {}
  if (isRecord(raw.updatedOrder)) {
    for (const [key, value] of Object.entries(raw.updatedOrder)) {
      if (Array.isArray(value)) updatedOrder[key] = value.filter((entry): entry is string => typeof entry === 'string')
    }
  }
  // sessionUpdatedAtByAccount：嵌套逐层校验。
  const sessionUpdatedAtByAccount: Record<string, Record<string, number>> = {}
  if (isRecord(raw.sessionUpdatedAtByAccount)) {
    for (const [key, value] of Object.entries(raw.sessionUpdatedAtByAccount)) {
      if (!isRecord(value)) continue
      const timestamps: Record<string, number> = {}
      for (const [id, at] of Object.entries(value)) {
        if (typeof at === 'number' && Number.isFinite(at)) timestamps[id] = at
      }
      sessionUpdatedAtByAccount[key] = timestamps
    }
  }
  // sourceFolded：sourceId 键，布尔过滤同 folded；缺失时不产出该键（v 保持 1）。
  let hasSourceFolded = false
  const sourceFolded: Record<string, boolean> = {}
  if (isRecord(raw.sourceFolded)) {
    hasSourceFolded = true
    for (const [key, value] of Object.entries(raw.sourceFolded)) {
      if (typeof value === 'boolean') sourceFolded[key] = value
    }
  }
  // serverOrder：仅保留字符串条目并去重（首个位置胜出）；非数组不产出该键。
  let serverOrder: string[] | undefined
  if (Array.isArray(raw.serverOrder)) {
    const seen = new Set<string>()
    serverOrder = raw.serverOrder.filter((entry): entry is string => {
      if (typeof entry !== 'string' || seen.has(entry)) return false
      seen.add(entry)
      return true
    })
  }
  // sidebarWidth：仅接受有限数值，钳制到厂商侧边栏拖动范围（取整与 vendor
  // clampWidth 一致）；非数值一律丢弃并回退 SIDEBAR_DEFAULT；越界是钳制而非丢弃，
  // 0 也钳到下限 264——宽度偏好只记录「打开的拖动宽度」。v 保持 1。
  let sidebarWidth: number | undefined
  if (typeof raw.sidebarWidth === 'number' && Number.isFinite(raw.sidebarWidth)) {
    sidebarWidth = Math.min(420, Math.max(264, Math.round(raw.sidebarWidth)))
  }
  // seenSources 保留 raw 数组值；载入后归零保证「绝不从存储恢复」（见 loadViewPrefs）。
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
 * Resolve the default page storage lazily; null when the accessor itself throws
 * or yields a falsy value (opaque origins, blocked storage, sandboxed webviews,
 * non-browser runs).
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
  // seenSources 是**会话内内存簿记**：载入时从空集开始。恢复上一会话的 roster 会
  // 让重启后首个写周期在投影仅 local 的启动窗口把远程来源误判为「已删除」而抹掉。
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

// Shared live store (cross-ctx live sync): one module-level cache is the SINGLE
// source of truth for every ctx's sidebar (this module rides the vite shared
// chunk, same instance across boots). Reads/writes go through it; writes persist
// and notify every subscriber, so a fold toggle in one source propagates live.
// A per-ctx copy read at mount would leave toggles invisible across sources and
// could resurrect a stale value over a newer write; localStorage stays durable.
// non-throwing storage fallbacks are unchanged.

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
 * Prune stale entries against the CURRENT projection. SAFE rules only: an empty
 * projection is left untouched (user prefs must never be wiped against a
 * transiently unready projection); keys are pruned only when their source was
 * SEEN in an earlier projection of THIS session and is absent from the current
 * one. This matters because deriveServers always pushes `local` and the roster
 * arrives AFTER the local-only projection: pruning on mere absence — or on a
 * previous session's roster — would wipe every ssh source's prefs during the
 * startup window. A disconnected source keeps its folds and ungrouped order
 * (they return on reconnect).
 */
function prunePrefs(prefs: ChamberSidebarViewPrefs): ChamberSidebarViewPrefs {
  const servers = chamberBridge.getServers()
  if (servers.length === 0) return prefs
  const projectionIds = servers.map(server => server.id)
  const inProjection = new Set(projectionIds)
  // 本次投影见过的来源记入 seenSources——只可能在它们真正消失后被裁。
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
  // sourceFolded / serverOrder 同为可选字段：undefined 保持 undefined（绝不把缺失变成空对象写回）。
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
  // orderBy 同 ungroupedOrder：裁掉「本会话见过、现已消失」的来源；断连来源保留。
  for (const sourceId of Object.keys(orderBy)) {
    if (knownGone(sourceId)) {
      delete orderBy[sourceId]
      changed = true
    }
  }
  // updatedOrder / sessionUpdatedAtByAccount 同 folded：只裁见过且已消失的来源；断连来源的序/簿记保留。
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
  // sourceFolded 同 orderBy：只裁见过且已消失的来源。
  if (sourceFolded !== undefined) {
    for (const sourceId of Object.keys(sourceFolded)) {
      if (knownGone(sourceId)) {
        delete sourceFolded[sourceId]
        changed = true
      }
    }
  }
  // serverOrder：裁掉见过且已消失的 id，其余保持相对顺序。
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
  // 重建自固定字段表——显式携带 sidebarWidth 等可选字段，裁剪写入不得丢掉宽度偏好。
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
 * nothing was removed (the caller can skip the write). Used by the sidebar's
 * setOrderBy on entering updated mode so the next derivation does ONE full
 * recency sort while retained updatedOrder accounts are re-sorted, not re-seeded.
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
 * Write through the shared store: apply the mutator to the CURRENT shared prefs,
 * prune against the projection, persist (re-sanitized so the stored shape is
 * always the validated one), and notify every subscriber. A throwing subscriber
 * must not starve the others. The cache stores the SANITIZED output, so an
 * in-place-mutating mutator cannot corrupt the persisted shape.
 *
 * Equal writes do NOT notify: the result is compared to the cache under a
 * canonical encoding (recursively sorted keys, arrays in order) first —
 * identical values skip persistence and notification (a needless full-shell
 * re-render).
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
  if (isRecord(value)) {
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

// 置顶写回防抖 — updated 模式的 promotion 簿记写回是「观察 updatedAt 推进 → 置顶」
// 的副作用：每个投影 tick 都推进 updatedAt，逐 tick updateViewPrefs 会把写盘 + 全壳
// 通知放大到更新频率（跨 shell 共享 store）。固定窗（首 arm 起 250ms，非逐次重置的
// true trailing）把同窗派生合并为一次写回；末 tick 自窗基态重派生，结果自洽，与逐
// tick 落盘只在交错突发/首观察窗存在排序级差异（无数据丢失）；离散写先
// flushScheduledActivityWrites()，防止窗末终刷用旧派生覆盖新用户手势；可视更新最多
// 滞后一个防抖窗（显示延迟，非数据丢失），渲染路径直接读持久账户。

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

/** 立即落盘所有防抖窗内 pending 的置顶写回（幂等；无 pending 为 no-op）。陈旧
 *  守卫：合并前逐账户比较——若缓存中同一账户存在某会话的 TS 严格大于 pending
 *  对应 TS（另一 shell 已落盘更新观测），整条跳过（该账户由持有新投影的 shell
 *  下一次派生重新武装，≤1 轮自愈）。比较按 pending 内已知会话逐条做：陈旧派生
 *  整体缺失某会话时不会判 stale，覆盖会短暂抹掉该会话簿记，同样自愈。 */
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
 * Test-only: reset the shared store (cache + subscribers), the projection
 * (prunePrefs' input — chamberBridge.getServers()), and any pending debounced
 * activity writes. Resetting the projection keeps a test's "first write sees an
 * empty projection" assumption independent of declaration order.
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
