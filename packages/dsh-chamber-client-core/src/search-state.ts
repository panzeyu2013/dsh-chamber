/**
 * Shared per-source session search controller (cross-ctx live sync): owns BOTH
 * the source-keyed search UI state (expanded capsule / query / results) AND the
 * debounced fetch jobs (timers + AbortControllers) as ONE module-level
 * singleton seen by every ctx's sidebar through the vite shared chunk. State
 * cannot live per-shell (the visible sidebar is the ACTIVE shell's; one owner
 * arms the jobs; the wire fetch is INJECTED so the module stays testable).
 * Job semantics: one debounced job per expanded, connected, non-empty-query
 * source; a keystroke never aborts another source's in-flight search; the 30s
 * caller timeout distinguishes "timed out" (error) from "superseded" (silent);
 * disconnected sources drop their state (reconnect → clean capsule).
 */
import type { SearchRow } from './instance-api.ts'
import { chamberBridge } from './aggregate-store.ts'
import { sanitizeSearchQuery } from './derive.ts'
import { assertSingletonModule } from './singleton.ts'

assertSingletonModule('search-state')

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

/** Debounce between the latest keystroke and a Host content-search request. */
const SEARCH_DEBOUNCE_MS = 250
/** Caller-side search deadline (the wire merges its own 30s). */
const SEARCH_TIMEOUT_MS = 30_000

/** Snapshot cache: a fresh Map only when the state changed (identity-preserving for React). */
let snapshot: ReadonlyMap<string, SourceSearchState> | null = null

function notify(): void {
  snapshot = null
  for (const listener of [...listeners]) listener()
}

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

export function clearSearch(sourceId: string): void {
  collapseSearch(sourceId)
}

/**
 * Reconcile debounced jobs against current states + projection: abort jobs no
 * longer wanted, then arm newly-wanted ones. Only the CHANGED source is touched,
 * so sibling in-flight searches survive.
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
  // Arm new queries only: an existing same-query job stays in flight (re-creating it
  // would abort/restart every other source's search on each keystroke).
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
          // 所有权镜像（与 .catch 同构）：被替换（abort 且 job 已易主/删除）的旧结果静默丢弃；
          // 若 abort 只来自 30s 超时而 wire 仍成功返回，仍提交结果——绝不把来源留在 loading。
          if (controller.signal.aborted && jobs.get(sourceId)?.controller !== controller) return
          const current = states.get(sourceId)
          if (current === undefined) return
          states.set(sourceId, { ...current, status: 'ready', items: result.items, hasMore: result.hasMore })
          // 结果已落地，停掉本 job 的超时定时器；job 条目保留到下次 query 变更/收起/断连
          // 由 reconcileJobs 清理——在此删除会导致下次 reconcile 对同一 query 重复 arm。
          const job = jobs.get(sourceId)
          if (job !== undefined) globalThis.clearTimeout(job.timeout)
          notify()
        })
        .catch(() => {
          // 30s caller timeout aborts: if THIS job still owns the controller it is a
          // timeout → 落 error 状态，绝不停留 pending；被替换的 job 静默退出，由新 job /
          // cleanup 接管其状态。
          if (controller.signal.aborted && jobs.get(sourceId)?.controller !== controller) return
          const current = states.get(sourceId)
          if (current === undefined) return
          states.set(sourceId, { ...current, status: 'error', items: [], hasMore: false })
          // 错误落地后同样停掉超时定时器（否则 30s 后会 abort 一个已 settled 的 promise——悬空定时器）。
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

// 断连来源丢弃搜索状态并中止其 in-flight job（重连从干净折叠胶囊开始）。
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
