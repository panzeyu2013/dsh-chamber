/**
 * Shared per-source session search controller (design 06 §1, 2026-08 —
 * cross-ctx live sync). Owns BOTH the source-keyed search UI state (expanded
 * capsule / query / results) AND the debounced fetch jobs (timers +
 * AbortControllers) as ONE module-level singleton — the same instance every
 * ctx's sidebar sees through the vite shared chunk.
 *
 * Previously this state lived per-shell in the SidebarRoot component: the
 * visible sidebar is the ACTIVE shell's, so a search started in source A's
 * sidebar for source B vanished the moment the user activated B (the new
 * shell's sidebar had no search state). Sharing the state fixes that — a
 * search capsule/query/results now survives view switches — and, because the
 * JOBS live here too, exactly one owner arms them (no duplicate fetches from
 * N shells reacting to the shared state).
 *
 * Job semantics are a faithful port of the previous component effect: one
 * debounced job per expanded, connected, non-empty-query source; a keystroke
 * in one source must not abort or restart another source's in-flight search
 * (re-arm guard, P2-6); the 30s caller timeout distinguishes "timed out"
 * (error state) from "superseded" (silent, P2-6 fix). Disconnected sources
 * drop their state so a reconnect starts from a clean collapsed capsule.
 *
 * The wire fetch is INJECTED (setSearchFetcher — the sidebar wires
 * instance-api's searchSessions at module scope) so this module stays a pure
 * controller: plain-node unit-testable (no unbuilt dsh package in the import
 * graph) and the job flow testable with a fake fetcher.
 */
import type { SearchRow } from './instance-api.ts'
import { chamberBridge, type ChamberServerAggregate } from './aggregate-store.ts'
import { sanitizeSearchQuery } from './derive.ts'
import { assertSingletonModule } from './singleton.ts'

assertSingletonModule('search-state')

/** One source's search UI state (capsule + debounced remote results). */
export interface SourceSearchState {
  expanded: boolean
  query: string
  status: 'idle' | 'loading' | 'ready' | 'error'
  items: SearchRow[]
  hasMore: boolean
}

/** The injected wire search call (sidebar wires instance-api's searchSessions). */
export type SearchFetcher = (
  sourceId: string,
  query: string,
  signal: AbortSignal,
) => Promise<{ items: SearchRow[]; hasMore: boolean }>

let searchFetcher: SearchFetcher = () => Promise.reject(new Error('search fetcher not configured'))

/** Wire the actual search call (idempotent; called once at sidebar module scope). */
export function setSearchFetcher(fetcher: SearchFetcher): void {
  searchFetcher = fetcher
}

type SearchListener = () => void
const listeners = new Set<SearchListener>()
const states = new Map<string, SourceSearchState>()

interface Job {
  query: string
  timer: ReturnType<typeof globalThis.setTimeout>
  timeout: ReturnType<typeof globalThis.setTimeout>
  controller: AbortController
}
const jobs = new Map<string, Job>()

/** Debounce between the latest keystroke and a Host content-search request (06 §1.2). */
const SEARCH_DEBOUNCE_MS = 250
/** Caller-side search deadline (06 §1.1 — the wire merges its own 30s). */
const SEARCH_TIMEOUT_MS = 30_000

/** Snapshot cache: a fresh Map only when the state changed (identity-preserving for React). */
let snapshot: ReadonlyMap<string, SourceSearchState> | null = null

function notify(): void {
  snapshot = null
  for (const listener of [...listeners]) listener()
}

/** Read-only per-source search states for rendering. */
export function getSearchStates(): ReadonlyMap<string, SourceSearchState> {
  if (snapshot === null) snapshot = new Map(states)
  return snapshot
}

/** Subscribe to search-state changes (any ctx's interaction); returns the unsubscribe. */
export function subscribeSearch(listener: SearchListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function setState(sourceId: string, next: SourceSearchState): void {
  states.set(sourceId, next)
  notify()
}

/** Open the capsule for a source (idempotent). */
export function expandSearch(sourceId: string): void {
  const prev = states.get(sourceId)
  if (prev !== undefined && prev.expanded) return
  setState(sourceId, { expanded: true, query: prev?.query ?? '', status: 'idle', items: [], hasMore: false })
  reconcileJobs()
}

/** Close the capsule for a source (idempotent; drops its query/results). */
export function collapseSearch(sourceId: string): void {
  if (!states.delete(sourceId)) return
  notify()
  reconcileJobs()
}

/** Set (sanitized) query of an expanded source; arms a fresh debounced job. */
export function setSearchQuery(sourceId: string, query: string): void {
  const sanitized = sanitizeSearchQuery(query)
  const prev = states.get(sourceId)
  if (prev === undefined || prev.query === sanitized) return
  setState(sourceId, { ...prev, query: sanitized, status: 'loading', items: [], hasMore: false })
  reconcileJobs()
}

/** Collapse + drop the state (Escape / clear button). */
export function clearSearch(sourceId: string): void {
  collapseSearch(sourceId)
}

/**
 * Reconcile the debounced fetch jobs against the current states + projection:
 * abort jobs that are no longer wanted (collapsed / disconnected / emptied /
 * re-queried — the CHANGED source only, so sibling in-flight searches survive,
 * P2-6), then arm jobs for newly-wanted queries.
 */
function reconcileJobs(): void {
  const wanted = new Map<string, string>()
  for (const server of chamberBridge.getServers()) {
    if (!server.connected) continue
    const state = states.get(server.id)
    if (state === undefined || !state.expanded) continue
    const query = sanitizeSearchQuery(state.query)
    if (query === '') continue
    wanted.set(server.id, query)
  }
  let changed = false
  // Abort stale jobs; reset sources that are no longer wanted at all to idle.
  for (const [sourceId, job] of [...jobs]) {
    if (wanted.get(sourceId) === job.query) continue
    globalThis.clearTimeout(job.timer)
    globalThis.clearTimeout(job.timeout)
    job.controller.abort()
    jobs.delete(sourceId)
    if (!wanted.has(sourceId)) {
      const state = states.get(sourceId)
      if (state !== undefined && state.status !== 'idle') {
        states.set(sourceId, { ...state, status: 'idle', items: [], hasMore: false })
        changed = true
      }
    }
  }
  // Arm jobs for new queries only — an existing same-query job is left in
  // flight (its own completion updates the state; re-creating it here would
  // abort and restart every other source's search on each keystroke).
  for (const [sourceId, query] of wanted) {
    if (jobs.has(sourceId)) continue
    const controller = new AbortController()
    const state = states.get(sourceId)
    if (state !== undefined && state.status !== 'loading') {
      states.set(sourceId, { ...state, status: 'loading', items: [], hasMore: false })
      changed = true
    }
    const timer = globalThis.setTimeout(() => {
      searchFetcher(sourceId, query, controller.signal)
        .then((result) => {
          // 所有权镜像（与 .catch 同构）：被替换（abort 且 job 已易主/删除）
          // 的旧结果静默丢弃；若 abort 只来自 30s 超时定时器而 wire 忽略
          // abort 仍成功返回（实际几乎不可达——unary client 走 fetch signal），
          // 仍提交结果——绝不把来源留在 loading（2026-08 复核）。
          if (controller.signal.aborted && jobs.get(sourceId)?.controller !== controller) return
          const current = states.get(sourceId)
          if (current === undefined) return
          states.set(sourceId, { ...current, status: 'ready', items: result.items, hasMore: result.hasMore })
          // 成功提交后即停掉本 job 的 30s 超时定时器（结果已落地，超时无意义；
          // 2026-08 复核）。job 条目保留到下次 query 变更/收起/断连由
          // reconcileJobs 清理——不可在此删除，否则下次 reconcile 会对同一
          // query 重新 arm 一次重复抓取。
          const job = jobs.get(sourceId)
          if (job !== undefined) globalThis.clearTimeout(job.timeout)
          notify()
        })
        .catch(() => {
          // 30s caller timeout (SEARCH_TIMEOUT_MS) aborts: if THIS job still
          // owns the controller (not superseded by a newer query or removed),
          // it is a timeout — land an error state, never linger on pending
          // (P2-6 race fix). A superseded job exits silently; the new job /
          // cleanup takes over its state.
          if (controller.signal.aborted && jobs.get(sourceId)?.controller !== controller) return
          const current = states.get(sourceId)
          if (current === undefined) return
          states.set(sourceId, { ...current, status: 'error', items: [], hasMore: false })
          // 错误落地后同样停掉超时定时器（网络错误路径：30s 定时器仍在挂起，
          // 会去 abort 一个已 settled 的 promise——无害但属悬空定时器）。
          const job = jobs.get(sourceId)
          if (job !== undefined) globalThis.clearTimeout(job.timeout)
          notify()
        })
    }, SEARCH_DEBOUNCE_MS)
    const timeout = globalThis.setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS)
    jobs.set(sourceId, { query, timer, timeout, controller })
  }
  if (changed) notify()
}

// Disconnected sources drop their search state (a reconnect starts from a
// clean collapsed capsule, R3), and their in-flight jobs are aborted.
chamberBridge.subscribe(() => {
  const live = new Set(
    chamberBridge.getServers().filter(server => server.connected).map(server => server.id),
  )
  let changed = false
  for (const sourceId of [...states.keys()]) {
    if (live.has(sourceId)) continue
    states.delete(sourceId)
    changed = true
  }
  for (const [sourceId, job] of [...jobs]) {
    if (live.has(sourceId)) continue
    globalThis.clearTimeout(job.timer)
    globalThis.clearTimeout(job.timeout)
    job.controller.abort()
    jobs.delete(sourceId)
  }
  if (changed) notify()
})
