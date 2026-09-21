/**
 * Page-wide per-source document-theme snapshot cache (design 06 §4.6, W3 切源体验).
 *
 * Why: on a cold switch the target view has not produced a theme snapshot yet, so
 * the document keeps the PREVIOUS view palette (or dsh light default) while the
 * target boots — the veil/`.instance-loading` background reads
 * `--dsw-alias-bg-base` from the document, which is exactly how a dark server
 * shows a full-white boot. Priming the target with its own last-known palette
 * (or, for a never-seen source, the last palette actually applied anywhere)
 * removes that mismatch without adding CSS color rules.
 *
 * Uniqueness: one cache per document, held in a page-global slot (the same
 * discipline as page-language.ts) because every per-instance boot evaluates this
 * module separately.
 */

/** One opaque theme snapshot, forwarded to the vendor ThemePresenter. */
export type CachedThemeSnapshot = unknown

/** The page-wide cache face. Bounded least-recently-remembered eviction. */
export interface SourceThemeCache {
  /** Remember a SETTLED snapshot for one source (moves it to most recent). */
  remember(sourceId: string, snapshot: CachedThemeSnapshot): void
  snapshotOf(sourceId: string): CachedThemeSnapshot | undefined
  /** The most recently remembered snapshot from any source (cold-boot fallback). */
  lastSettled(): CachedThemeSnapshot | undefined
  setMounted(sourceId: string, mounted: boolean): void
  isMounted(sourceId: string): boolean
  /** De-dup: the source whose known palette was already primed for this activation. */
  markPrimed(sourceId: string): void
  primedFor(): string | undefined
  clearPrimed(): void
}

/** Inputs of the pure priming decision. */
export interface PrimeInput {
  active: string | undefined
  self: string | undefined
  hasCached: boolean
  activeMounted: boolean
  primedFor: string | undefined
  hasFallback: boolean
}

export type PrimeDecision = "self" | "cached" | "fallback" | "none"

/**
 * Decide what one instance should project when the active source changes.
 * - `self`: unpublished active source, or this instance IS the active one — keep
 *   the vendor-equivalent behavior (re-project the remembered snapshot).
 * - `cached`: the target was seen before and is not mounted — prime its palette.
 * - `fallback`: the target is not mounted and never produced a palette — prime the
 *   last palette known to paint (never leave the document on an unknown state).
 * - `none`: nothing to do (already primed for this activation, or a mounted target
 *   whose own projector repaints on activation).
 */
export function decidePrime(input: PrimeInput): PrimeDecision {
  if (input.active === undefined || input.active === input.self) return "self"
  if (input.primedFor === input.active) return "none"
  if (input.activeMounted) return "none"
  if (input.hasCached) return "cached"
  if (input.hasFallback) return "fallback"
  return "none"
}

/** Default bound on remembered sources (one document, a handful of sources). */
export const SOURCE_THEME_CACHE_LIMIT = 12

/** Build one bounded cache (exported for tests; production uses the page slot). */
export function createSourceThemeCache(limit: number = SOURCE_THEME_CACHE_LIMIT): SourceThemeCache {
  const snapshots = new Map<string, CachedThemeSnapshot>()
  const mounted = new Set<string>()
  let latest: CachedThemeSnapshot | undefined
  let primed: string | undefined
  return {
    remember(sourceId, snapshot) {
      if (snapshots.has(sourceId)) snapshots.delete(sourceId)
      snapshots.set(sourceId, snapshot)
      while (snapshots.size > limit) {
        const oldest = snapshots.keys().next().value
        if (oldest === undefined) break
        snapshots.delete(oldest)
      }
      latest = snapshot
    },
    snapshotOf: sourceId => snapshots.get(sourceId),
    lastSettled: () => latest,
    setMounted: (sourceId, isMounted) => {
      if (isMounted) mounted.add(sourceId)
      else mounted.delete(sourceId)
    },
    isMounted: sourceId => mounted.has(sourceId),
    markPrimed: sourceId => { primed = sourceId },
    primedFor: () => primed,
    clearPrimed: () => { primed = undefined },
  }
}

/** Page-global slot holding the cache (one document, one cache). */
const CACHE_SLOT = "__dshChamberSourceThemeCache__"

/** The global object as a plain bag: the slot is intentionally page-scoped. */
const pageGlobal = globalThis as unknown as Record<string, unknown>

/** Structural check for a cache installed by another evaluation of this module. */
function isSourceThemeCache(value: unknown): value is SourceThemeCache {
  if (typeof value !== "object" || value === null) return false
  const candidate = value as Partial<SourceThemeCache>
  return typeof candidate.remember === "function"
    && typeof candidate.snapshotOf === "function"
    && typeof candidate.markPrimed === "function"
}

/** The page cache, whoever installed it (created on first use). */
export function resolveSourceThemeCache(): SourceThemeCache {
  const existing = pageGlobal[CACHE_SLOT]
  if (isSourceThemeCache(existing)) return existing
  const created = createSourceThemeCache()
  pageGlobal[CACHE_SLOT] = created
  return created
}
