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
import { UNGROUPED_WORKSPACE_ID, type ArchivedFilter, type SessionGroupBy, type SessionOrderBy } from './derive.ts'
import { flatAccountKey } from './flat-account.ts'

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
   * Per-source session grouping preference (upstream SessionGroupBy): key =
   * sourceId, value = 'workspace' | 'workspace-tree' | 'flat'. OPTIONAL — old
   * persisted payloads stay valid without a version bump (v stays 1); readers
   * fall back to 'workspace', and the write-time prune drops entries of sources
   * seen this session that vanished from the projection. Mirrors orderBy.
   */
  groupBy?: Record<string, SessionGroupBy>
  /**
   * Per-source archived-row visibility (upstream ArchivedFilter): key =
   * sourceId, value = 'default' | 'show' | 'only'. OPTIONAL; same v=1 rules as
   * orderBy. When a source's archive set is unknown (archiveSetKnown !== true)
   * the stored value is kept, the render falls back to 'default', and the WHOLE
   * filter axis is disabled (design 06 §3.4 honesty rule: clicking the default
   * entry would write 'default' back and destroy the stored preference).
   */
  archivedFilter?: Record<string, ArchivedFilter>
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
   * Per-source FLAT order account (the chamber twin of the official
   * FLAT_SESSION_ORDER_KEY): key = sourceId, value = member ids in display
   * order. Single-list mode's manual baseline — seeded from the composed
   * workspace order on first observation, reconciled against membership, and
   * mutated by in-mode drags (persisted locally, no wire commit). Manual
   * workspace order is untouched by it; the updated-mode twin lives in
   * `updatedOrder` under the synthetic flatAccountKey(sourceId) key (a NUL sentinel —
   * see flat-account.ts; a real workspace id can never contain NUL).
   */
  flatOrder?: Record<string, string[]>
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
  return { v: 1, folded: {}, ungroupedOrder: {}, orderBy: {}, groupBy: {}, archivedFilter: {}, updatedOrder: {}, flatOrder: {}, sessionUpdatedAtByAccount: {}, seenSources: [] }
}

/** 宽松结构校验的四个值形状（v=1）：非法条目静默丢弃，缺失字段回退空对象。 */
function booleanRecord(raw: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  if (!isRecord(raw)) return out
  for (const [key, value] of Object.entries(raw)) if (typeof value === 'boolean') out[key] = value
  return out
}

function stringArrayRecord(raw: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  if (!isRecord(raw)) return out
  for (const [key, value] of Object.entries(raw)) {
    if (Array.isArray(value)) out[key] = value.filter((entry): entry is string => typeof entry === 'string')
  }
  return out
}

function enumRecord<T extends string>(raw: unknown, allowed: readonly T[]): Record<string, T> {
  const out: Record<string, T> = {}
  if (!isRecord(raw)) return out
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) out[key] = value as T
  }
  return out
}

function numberRecord(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  if (!isRecord(raw)) return out
  for (const [key, value] of Object.entries(raw)) if (typeof value === 'number' && Number.isFinite(value)) out[key] = value
  return out
}

/** 原地裁掉谓词判定的键；返回是否发生删除（裁剪写入的 changed 记账）。 */
function pruneKeys(record: Record<string, unknown>, gone: (key: string) => boolean): boolean {
  let changed = false
  for (const key of Object.keys(record)) {
    if (gone(key)) {
      delete record[key]
      changed = true
    }
  }
  return changed
}

/** `<sourceId>/<workspaceId>` 形态的账号键 → 来源 id。 */
function slashSource(key: string): string | undefined {
  const slash = key.indexOf('/')
  return slash === -1 ? undefined : key.slice(0, slash)
}

/** Lenient structural validation: drop malformed entries, keep valid ones. */
function sanitizePrefs(raw: unknown): ChamberSidebarViewPrefs {
  if (!isRecord(raw) || raw.v !== 1) return defaults()
  const folded = booleanRecord(raw.folded)
  const ungroupedOrder = stringArrayRecord(raw.ungroupedOrder)
  // orderBy：丢弃非法值条目；缺失字段（旧数据）回退空对象——v 保持 1。
  const orderBy = enumRecord(raw.orderBy, ['manual', 'updated'] as const)
  // groupBy / archivedFilter：枚举过滤，同 orderBy（缺失字段回退空对象，v 保持 1）。
  const groupBy = enumRecord(raw.groupBy, ['workspace', 'workspace-tree', 'flat'] as const)
  const archivedFilter = enumRecord(raw.archivedFilter, ['default', 'show', 'only'] as const)
  // updatedOrder：account 键 → string[]；非数组/非字符串条目丢弃，同 ungroupedOrder。
  const updatedOrder = stringArrayRecord(raw.updatedOrder)
  // flatOrder：sourceId 键 → string[]，逐条校验同 ungroupedOrder。
  const flatOrder = stringArrayRecord(raw.flatOrder)
  // sessionUpdatedAtByAccount：嵌套逐层校验。
  const sessionUpdatedAtByAccount: Record<string, Record<string, number>> = {}
  if (isRecord(raw.sessionUpdatedAtByAccount)) {
    for (const [key, value] of Object.entries(raw.sessionUpdatedAtByAccount)) {
      if (!isRecord(value)) continue
      sessionUpdatedAtByAccount[key] = numberRecord(value)
    }
  }
  // sourceFolded：sourceId 键，布尔过滤同 folded；缺失时不产出该键（v 保持 1）。
  const hasSourceFolded = isRecord(raw.sourceFolded)
  const sourceFolded = booleanRecord(raw.sourceFolded)
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
    groupBy,
    archivedFilter,
    updatedOrder,
    flatOrder,
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
  const groupBy = { ...prefs.groupBy }
  const archivedFilter = { ...prefs.archivedFilter }
  const updatedOrder = { ...prefs.updatedOrder }
  const flatOrder = { ...prefs.flatOrder }
  const sessionUpdatedAtByAccount = { ...prefs.sessionUpdatedAtByAccount }
  // sourceFolded / serverOrder 同为可选字段：undefined 保持 undefined（绝不把缺失变成空对象写回）。
  const sourceFolded = prefs.sourceFolded === undefined ? undefined : { ...prefs.sourceFolded }
  let serverOrder = prefs.serverOrder === undefined ? undefined : [...prefs.serverOrder]
  let changed = false
  changed = pruneKeys(folded, key => knownGone(slashSource(key))) || changed
  changed = pruneKeys(ungroupedOrder, id => knownGone(id)) || changed
  // orderBy 同 ungroupedOrder：裁掉「本会话见过、现已消失」的来源；断连来源保留。
  changed = pruneKeys(orderBy, id => knownGone(id)) || changed
  // groupBy / archivedFilter 同 orderBy：只裁「本会话见过、现已消失」的来源。
  changed = pruneKeys(groupBy, id => knownGone(id)) || changed
  changed = pruneKeys(archivedFilter, id => knownGone(id)) || changed
  // flatOrder 同 ungroupedOrder：sourceId 键，裁见过且已消失的来源。
  changed = pruneKeys(flatOrder, id => knownGone(id)) || changed
  // updatedOrder / sessionUpdatedAtByAccount 同 folded：只裁见过且已消失的来源；断连来源的序/簿记保留。
  changed = pruneKeys(updatedOrder, key => knownGone(slashSource(key))) || changed
  changed = pruneKeys(sessionUpdatedAtByAccount, key => knownGone(slashSource(key))) || changed
  // 工作区级账号裁剪：来源在场且工作区集合非空时，已被删除的工作区账号（updatedOrder 与
  // 提升簿记）不得永久驻留 localStorage。断连/未加载来源（无工作区）一律保留；合成账号
  // （未分组桶、flat 哨兵）不是真实工作区 id，永不裁。
  const liveWorkspaceIds = new Map<string, Set<string>>()
  for (const server of servers) {
    if (server.workspaces.length === 0) continue
    // 只在**权威且未过滤**的投影上裁剪（第四轮 F1）：三态筛选会让没有归档成员的工作区整体
    // 从投影消失，降级/未挂载兜底则会把工作区换成 __cwd__ 合成组——把"投影里没有"当成
    // "已删除"会静默清掉活账号与提升簿记（updated 模式切换筛选后 250ms 即落盘）。
    if ((prefs.archivedFilter?.[server.id] ?? 'default') !== 'default') continue
    if (server.archiveSetKnown !== true) continue
    if (server.aggregateReady !== true) continue
    if (server.workspaces.some(workspace => workspace.synthetic === true)) continue
    liveWorkspaceIds.set(server.id, new Set(server.workspaces.map(workspace => workspace.id)))
  }
  const workspaceAccountGone = (key: string): boolean => {
    const slash = key.indexOf('/')
    if (slash === -1) return false
    const sourceId = key.slice(0, slash)
    const live = liveWorkspaceIds.get(sourceId)
    if (live === undefined) return false
    const workspaceId = key.slice(slash + 1)
    if (workspaceId === UNGROUPED_WORKSPACE_ID) return false
    if (key === flatAccountKey(sourceId)) return false
    return !live.has(workspaceId)
  }
  changed = pruneKeys(updatedOrder, workspaceAccountGone) || changed
  changed = pruneKeys(sessionUpdatedAtByAccount, workspaceAccountGone) || changed
  // sourceFolded 同 orderBy：只裁见过且已消失的来源。
  if (sourceFolded !== undefined) changed = pruneKeys(sourceFolded, id => knownGone(id)) || changed
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
    v: 1, folded, ungroupedOrder, orderBy, groupBy, archivedFilter, updatedOrder, flatOrder, sessionUpdatedAtByAccount,
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
 * re-render). The comparison memoizes the cache side's canonical JSON (validated
 * only on a successful replacement or a test reset), so an idempotent write costs
 * ONE canonicalization + stringify instead of two.
 */
export function updateViewPrefs(mutator: (prev: ChamberSidebarViewPrefs) => ChamberSidebarViewPrefs): void {
  const prev = getViewPrefs()
  const next = sanitizePrefs(prunePrefs(mutator(prev)))
  const prevJson = canonicalJsonOf(prev)
  const nextJson = canonicalJsonOf(next)
  if (prevJson !== null && prevJson === nextJson) return
  cache = next
  // Memoize the just-computed result; a failed serialization leaves the memo
  // empty so the next comparison falls back to recomputing both sides.
  if (nextJson !== null) {
    canonicalMemoPrefs = next
    canonicalMemoJson = nextJson
  }
  // 落盘沿用原序列化（插入序，存储键序不变）——memo 只服务比较，不改变字节形状。
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

// Canonical-serialization memo. The cache object changes identity ONLY on a
// successful replacement (and on the test reset), so the previous side of the
// next comparison is already known — no need to re-traverse and re-stringify it.
let canonicalMemoPrefs: ChamberSidebarViewPrefs | null = null
let canonicalMemoJson = ''
let canonicalSerializationCount = 0

/** Test-only: non-memoized canonical serializations (canonicalize + JSON.stringify) since the last reset. */
export function __canonicalSerializationCountForTests(): number {
  return canonicalSerializationCount
}

/**
 * Canonical JSON of the prefs, memoized by object identity. Returns null when the
 * value cannot be serialized (the old canonicalEquals treated that as "not equal",
 * so the write still proceeds).
 */
function canonicalJsonOf(prefs: ChamberSidebarViewPrefs): string | null {
  if (canonicalMemoPrefs === prefs) return canonicalMemoJson
  canonicalSerializationCount += 1
  try {
    return JSON.stringify(canonicalize(prefs))
  } catch {
    return null
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

/** 读口：防抖窗内 pending 的账户意图（渲染侧判等守卫用它避免旧 intent 赢过新派生）。 */
export function peekScheduledActivityWrites(): {
  updatedOrder: Record<string, string[]>
  sessionUpdatedAtByAccount: Record<string, Record<string, number>>
} {
  const updatedOrder: Record<string, string[]> = {}
  const sessionUpdatedAtByAccount: Record<string, Record<string, number>> = {}
  for (const [accountKey, activity] of activityPending) {
    updatedOrder[accountKey] = activity.order
    sessionUpdatedAtByAccount[accountKey] = activity.timestamps
  }
  return { updatedOrder, sessionUpdatedAtByAccount }
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
  canonicalMemoPrefs = null
  canonicalMemoJson = ''
  canonicalSerializationCount = 0
  listeners.clear()
  chamberBridge.publish([])
}
