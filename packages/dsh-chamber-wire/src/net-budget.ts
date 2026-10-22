/**
 * Proxy ⇄ client network-budget contract (design 27 §3.4/§3.5).
 *
 * WHY THIS IS A WIRE CONTRACT: the control plane derives the upstream
 * request-body flush budget from the buffered body size; the page client derives
 * its mutation call budget so the proxy's `details.phase='after-body'`
 * classification can still reach it. The two derivations form ONE inequality —
 * client budget ≥ proxy worst case + cushion. Two hand-written copies broke that
 * inequality once (the client floor was 50s while the proxy floor was 60s
 * *before* a 45s header window), and neither side can see the other. Both
 * derivations therefore live here, next to each other, and a test asserts the
 * ordering over a size grid.
 */

export const NET_BUDGET = {
  /** Slow-link floor shared by both derivations (bytes per second). */
  minUploadBytesPerSec: 128 * 1024,
  /** A buffered body always gets at least this long to flush upstream. */
  uploadFloorMs: 60_000,
  /** Hard cap on the upload budget; at the floor rate it is reached at ~225MiB, so a
   *  300MiB body is budget-bounded (not rate-bounded) by this cap. */
  uploadMaxMs: 30 * 60_000,
  /** Ordinary upstream header window (non-SSE); it starts only AFTER the flush. */
  upstreamHeaderWindowMs: 45_000,
  /** Extra time the client keeps waiting so the proxy's classified error wins the race. */
  outcomeCushionMs: 5_000,
} as const

/** Test seams: production reads the table; a test may shrink the scale. */
export interface ProxyUploadBudgetOptions {
  readonly minBytesPerSec?: number
  readonly maxMs?: number
}

function bufferedBytes(bytes: number): number {
  return Number.isFinite(bytes) && bytes > 0 ? Math.ceil(bytes) : 0
}

/** Upstream request-body flush budget for an already-buffered body. */
export function proxyUploadBudgetMs(bytes: number, options: ProxyUploadBudgetOptions = {}): number {
  const rate = Math.max(1, options.minBytesPerSec ?? NET_BUDGET.minUploadBytesPerSec)
  const sizeBudget = Math.ceil((bufferedBytes(bytes) / rate) * 1_000)
  return Math.min(options.maxMs ?? NET_BUDGET.uploadMaxMs, Math.max(NET_BUDGET.uploadFloorMs, sizeBudget))
}

/**
 * The longest the proxy may legitimately take to produce its classified answer
 * for a request that carried this body: the flush budget, then the header window.
 * A failed flush is answered earlier (504 without the after-body marker).
 */
export function proxyWorstCaseMs(bytes: number, options: ProxyUploadBudgetOptions = {}): number {
  return proxyUploadBudgetMs(bytes, options) + NET_BUDGET.upstreamHeaderWindowMs
}

/**
 * The page client's per-call budget for a mutation that carries this body. It
 * must outlive `proxyWorstCaseMs` so the proxy's after-body classification wins
 * the race; the cap is the proxy's own cap plus the cushion.
 */
export function mutationCallBudgetMs(bytes: number): number {
  return proxyWorstCaseMs(bytes) + NET_BUDGET.outcomeCushionMs
}
