/**
 * Dev-only page RENDER counters (design 05 §3 发布门与投影缓存的诊断面).
 *
 * WHY. The P2 work (sidebar context split, factAt quantization) is measured by
 * publish rate, per-publish changed-source count, signature-cache hit rate and
 * sidebar row derivations — today only the two END points of the publish storm
 * are known (27 publishes/s under the badge storm, ~0 at rest); the distribution
 * in between is unmeasurable. This module is that instrument: four numbers that
 * turn "structural upper bound" into measured numbers.
 *
 * SURFACE. One page-global read function ({@link RENDER_COUNTERS_GLOBAL_KEY}), the
 * same devtools-only channel as `globalThis.__dshChamberHttpBudget()` /
 * `__dshChamberSourceMux` (design 26 §D7 现场可读). It is NOT a user-visible UI,
 * carries no persistence, adds no HTTP/evidence read face, and only exists while
 * the page is open (a reload resets it). Reading it requires the Web Inspector /
 * automation console — i.e. the debug-mode profile (the Swift shell gates
 * isInspectable by the debug setting); a packed build exposes no UI and no
 * persisted trace of these numbers.
 *
 * COST. The hot path is number arithmetic only: no allocation, no string
 * concatenation, no object creation per event (the read view allocates its
 * frozen snapshot on demand only). `countChangedProjectionSources` walks the
 * two server arrays by identity with index-free loops (sources are a handful;
 * identity is preserved by the projection caches, so an unchanged source is the
 * SAME object).
 */
import { assertSingletonModule } from './singleton.ts'

assertSingletonModule('render-counters')

/** The page-global read view (devtools/inspector only; never rendered). */
export const RENDER_COUNTERS_GLOBAL_KEY = '__dshChamberRenderCounters'

/** One live reading of the counter set (allocation happens here, on read). */
export interface ChamberRenderCounters {
  /** Projection publishes that passed the App publish gate (equal signatures never count). */
  readonly publishes: number
  /** Servers whose identity changed in the LAST publish (new + replaced + removed). */
  readonly lastChangedSources: number
  /** Largest {@link lastChangedSources} seen in one publish. */
  readonly maxChangedSources: number
  /** Signature gate: the exact array already carried a remembered signature (O(1) hit). */
  readonly signatureRememberedHits: number
  /** Signature gate: one source fragment reused from the per-source identity cache. */
  readonly signatureFragmentHits: number
  /** Signature gate: one source fragment had to be serialized (cache miss). */
  readonly signatureFragmentMisses: number
  /** Sidebar rows derived by projection passes (changed sources only; cached sources count 0). */
  readonly sidebarRowDerivations: number
}

const counters = {
  publishes: 0,
  lastChangedSources: 0,
  maxChangedSources: 0,
  signatureRememberedHits: 0,
  signatureFragmentHits: 0,
  signatureFragmentMisses: 0,
  sidebarRowDerivations: 0,
}

/**
 * Changed-source count of one publish: a source counts when its identity moved
 * (replaced/new) or when it left the array. Zero allocation: the previous
 * array is scanned by id, and per-source identity is the projection caches'
 * documented contract (an unchanged source keeps its object).
 */
export function countChangedProjectionSources(
  previous: readonly { readonly id: string }[] | null | undefined,
  next: readonly { readonly id: string }[],
): number {
  if (previous === null || previous === undefined) return next.length
  let changed = 0
  for (const server of next) {
    let same = false
    for (const before of previous) {
      if (before.id !== server.id) continue
      same = before === server
      break
    }
    if (!same) changed += 1
  }
  for (const before of previous) {
    let present = false
    for (const server of next) {
      if (server.id === before.id) {
        present = true
        break
      }
    }
    if (!present) changed += 1
  }
  return changed
}

/** Record one publish that passed the App gate; `changedSources` rides it. */
export function recordProjectionPublish(changedSources: number): void {
  counters.publishes += 1
  counters.lastChangedSources = changedSources
  if (changedSources > counters.maxChangedSources) counters.maxChangedSources = changedSources
}

/** Signature gate: the exact array already carried a remembered signature (O(1)). */
export function recordSignatureRememberedHit(): void {
  counters.signatureRememberedHits += 1
}

/** Signature gate: one source fragment came from the identity cache. */
export function recordSignatureFragmentHit(): void {
  counters.signatureFragmentHits += 1
}

/** Signature gate: one source fragment had to be serialized (identity miss). */
export function recordSignatureFragmentMiss(): void {
  counters.signatureFragmentMisses += 1
}

/** Sidebar row derivations: the session rows one projection pass actually re-derived
 *  (deriveServerWorkspaces output rows of the changed sources; cached sources count 0). */
export function recordSidebarRowDerivations(count: number): void {
  counters.sidebarRowDerivations += count
}

/** Fresh frozen snapshot; the only allocation on the read path. */
function readChamberRenderCounters(): ChamberRenderCounters {
  return Object.freeze({ ...counters })
}

// 现场可读出口（Web Inspector / 自动化）；挂函数而不是快照，读数始终是最新值。
const countersGlobalHost = globalThis as { __dshChamberRenderCounters?: () => ChamberRenderCounters }
if (countersGlobalHost[RENDER_COUNTERS_GLOBAL_KEY] === undefined) {
  countersGlobalHost[RENDER_COUNTERS_GLOBAL_KEY] = () => readChamberRenderCounters()
}
