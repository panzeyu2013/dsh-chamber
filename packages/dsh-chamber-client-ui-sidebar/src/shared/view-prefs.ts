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
   * sourceId ('local', 'ssh-<id>'), value = SessionOrderBy. OPTIONAL — kept
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
   * Updated-mode session order accounts (design 06 §3.1, 2026-08 alignment
   * with the official ui-workspace sessionOrderByAccount): key =
   * `${sourceId}/${workspaceId}` — real workspaces AND the synthetic
   * ungrouped bucket (its id is UNGROUPED_WORKSPACE_ID). Each account holds
   * the updated-mode display baseline: seeded from the wire order on the
   * first observation, mutated by in-mode drags (persisted locally, no wire
   * commit — official「updated 下拖拽只落 account」) and by the activity
   * promotion (`nextUpdatedOrder`). manual mode ignores it (wire/stored
   * orders take over). OPTIONAL — absent for sources that never entered
   * updated mode; pruned by the same safe source-vanished rule as
   * orderBy/ungroupedOrder.
   */
  updatedOrder?: Record<string, string[]>
  /**
   * Updated-mode activity bookkeeping (2026-08 alignment, official
   * sessionUpdatedAtByAccount): key = the same `${sourceId}/${workspaceId}`
   * account key, value = sessionId → last observed updatedAt. The promotion
   * derives from it ("updated since the last observation → pinned to top");
   * the sidebar's setOrderBy clears a source's entries when entering
   * updated, which makes the next derivation do ONE full recency sort
   * (official switchedToUpdated). Written together with updatedOrder by the
   * derivation effect. OPTIONAL; pruned with the account keys.
   */
  sessionUpdatedAtByAccount?: Record<string, Record<string, number>>
  /**
   * Page-wide sidebar width preference in px (design 06, chamber ui-layout
   * fork — 2026-08): the chamber layout store persists every drag (clamped
   * into the vendor [SIDEBAR_MIN, SIDEBAR_MAX] drag range, columns.ts) here,
   * and EVERY boot's layout store seeds from it — so dragging the resizer in
   * one shell is reflected in every other shell live, and the width survives
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
 * post-reset cache (2026-08 audit nit).
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
  // orderBy：缺失或含非法值（不是 'manual'/'updated'）的条目一律丢弃；
  // 旧数据（无该字段）回退空对象——v 保持 1，不因新增字段重播种。
  const orderBy: Record<string, SessionOrderBy> = {}
  if (isPlainObject(raw.orderBy)) {
    for (const [key, value] of Object.entries(raw.orderBy)) {
      if (value === 'manual' || value === 'updated') orderBy[key] = value
    }
  }
  // updatedOrder：account 键（`${sourceId}/${workspaceId}`）→ string[]；
  // 非法条目（非数组/含非字符串）丢弃，与 ungroupedOrder 同规则。
  const updatedOrder: Record<string, string[]> = {}
  if (isPlainObject(raw.updatedOrder)) {
    for (const [key, value] of Object.entries(raw.updatedOrder)) {
      if (Array.isArray(value)) updatedOrder[key] = value.filter((entry): entry is string => typeof entry === 'string')
    }
  }
  // sessionUpdatedAtByAccount：account 键 → sessionId → 有限数值时间戳；
  // 嵌套层逐级校验，非法条目丢弃。
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
  // sidebarWidth：仅接受有限数值，钳到厂商侧边栏拖动范围 [264, 420]（即
  // @deepseek-ai/dsh-client-ui-layout columns.ts 的 SIDEBAR_MIN/SIDEBAR_MAX
  // 契约固定点，含与 vendor clampWidth 一致的取整）；非数值/非有限值
  // （NaN、Infinity、字符串等）一律丢弃，回退 SIDEBAR_DEFAULT。越界数值不
  // 丢弃而是钳制（与 vendor clampWidth 一致：0 也钳到下限 264——宽度偏好只
  // 记录「打开的拖动宽度」，「折叠」是 store 自己的 0 状态，不会持久化）。
  // v 保持 1：旧数据无该字段，不因新增字段重播种。
  let sidebarWidth: number | undefined
  if (typeof raw.sidebarWidth === 'number' && Number.isFinite(raw.sidebarWidth)) {
    sidebarWidth = Math.min(420, Math.max(264, Math.round(raw.sidebarWidth)))
  }
  // seenSources 保留 raw 里的数组值（写入路径经 sanitize 时须携带会话内
  // 簿记）；「绝不从存储恢复」由 loadViewPrefs 在载入后归零保证（见下）。
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
  // seenSources 是**会话内内存簿记**——载入时一律从空集开始（持久化的
  // seenSources 来自上一会话；恢复它会让重启后首个写周期在 roster 未到、
  // 投影仅 local 的启动窗口把远程来源误判为「已删除」而永久抹掉其偏好，
  // 2026-08 复查修复）。首个写周期因此不裁剪任何键（安全）；源真正删除
  // 后、本会话内再有写入时才被裁。
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
// Shared live store (design 06 §3, 2026-08 — cross-ctx live sync).
//
// Every instance ctx's sidebar previously kept its OWN in-memory copy, read
// once at mount and written back with a merge — a fold toggle in source A's
// sidebar was invisible in source B's sidebar until a refresh, and B's next
// write could resurrect A's stale fold value (the merge assumed the local copy
// was newer than the persisted value, which is false after another ctx wrote).
// The store below is the SINGLE source of truth shared by every ctx's sidebar
// (this module rides the vite shared chunk, same instance across all boots):
// reads/writes go through one cache, writes persist and notify every
// subscriber, so toggles propagate live to all sources. localStorage stays the
// durable backing (reloads pick the latest state); the sanitized load and
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
 *   storage) and is absent from the current one — distinguishing "source
 *   deleted" from "projection not fully loaded yet". This matters because
 *   deriveServers always pushes `local` (servers.length is never 0 in the
 *   app), and the roster arrives AFTER the local-only projection: pruning on
 *   mere absence — or on a previous session's roster — would wipe every ssh
 *   source's prefs during the startup window (2026-08 复查修复：seenSources
 *   不得持久化);
 * - a disconnected source keeps its folds and ungrouped order (they return on
 *   reconnect; the renderer's reconciledSessionOrder already skips unknown
 *   ids).
 */
function prunePrefs(prefs: ChamberSidebarViewPrefs): ChamberSidebarViewPrefs {
  const servers = chamberBridge.getServers()
  if (servers.length === 0) return prefs
  const projectionIds = servers.map(server => server.id)
  const inProjection = new Set(projectionIds)
  // 本次投影见过的来源记入 seenSources（部分投影窗口内也照记——它们真正
  // 消失后才可能被裁，绝不会在「尚未加载」的窗口被误裁）。
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
  // orderBy 与 ungroupedOrder 同为 sourceId 键：本会话见过、现已消失的来源
  // 其排序偏好一并裁剪；断连来源的偏好保留（重连后仍按原偏好渲染）。
  for (const sourceId of Object.keys(orderBy)) {
    if (knownGone(sourceId)) {
      delete orderBy[sourceId]
      changed = true
    }
  }
  // updatedOrder / sessionUpdatedAtByAccount 与 folded 同为
  // `${sourceId}/${workspaceId}` 键：同样只裁「本会话见过、现已消失」的来源；
  // 断连来源的更新模式序/簿记保留（重连后 promotion 继续，不重播种）。
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
  if (!changed && prefs.seenSources.length === seen.length && prefs.seenSources.every((id, i) => id === seen[i])) {
    return prefs
  }
  // The rebuild reconstructs from a fixed field list — carry sidebarWidth
  // (and any other optional field) explicitly so a write that prunes or
  // records a seen source never drops the persisted width preference.
  return {
    v: 1, folded, ungroupedOrder, orderBy, updatedOrder, sessionUpdatedAtByAccount,
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
 */
export function updateViewPrefs(mutator: (prev: ChamberSidebarViewPrefs) => ChamberSidebarViewPrefs): void {
  const next = prunePrefs(mutator(getViewPrefs()))
  cache = sanitizePrefs(next)
  saveViewPrefs(cache)
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch (error) {
      console.error('[dsh-chamber] view-prefs subscriber threw:', error)
    }
  }
}

/**
 * Test-only: reset the shared store (cache + subscribers) AND the projection
 * (prunePrefs' input — chamberBridge.getServers()) for isolation. Without the
 * projection reset, a test's "first write sees an empty projection" assumption
 * would depend on declaration order (any earlier publish would make it a
 * non-empty-projection write and the assertions fail loudly — not a false
 * green, but not a self-contained isolation contract).
 */
export function __resetViewPrefsForTests(): void {
  cache = null
  listeners.clear()
  chamberBridge.publish([])
}
