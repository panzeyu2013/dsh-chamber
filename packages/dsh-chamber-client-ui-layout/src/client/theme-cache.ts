/**
 * Page-wide per-source document-theme snapshot cache (design 06).
 *
 * A cold-switch target has produced no snapshot yet, so the document keeps the
 * PREVIOUS view's palette — or dsh's light default, which makes a dark server
 * show a full-white boot veil reading `--dsw-alias-bg-base` from the document.
 * Priming the target with its own last-known palette (never-seen source: the
 * last palette applied anywhere) removes the mismatch without CSS color rules.
 * One cache per document in a page-global slot because every per-instance boot
 * evaluates this module separately.
 */

/** One snapshot forwarded verbatim to the vendor ThemePresenter. */
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
 * - `self`: unpublished active source, or this instance IS the active one.
 * - `cached`: target seen before and not mounted — prime its palette.
 * - `fallback`: target never produced a palette — prime the last known one.
 * - `none`: already primed, or a mounted target whose projector repaints itself.
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

const CACHE_SLOT = "__dshChamberSourceThemeCache__"

/** Page-scoped bag for the cache slot. */
const pageGlobal = globalThis as unknown as Record<string, unknown>

/** Accepts a cache installed by another evaluation of this module. */
function isSourceThemeCache(value: unknown): value is SourceThemeCache {
  if (typeof value !== "object" || value === null) return false
  const candidate = value as Partial<SourceThemeCache>
  return typeof candidate.remember === "function"
    && typeof candidate.snapshotOf === "function"
    && typeof candidate.markPrimed === "function"
}

/** The page cache, created on first use. */
export function resolveSourceThemeCache(): SourceThemeCache {
  const existing = pageGlobal[CACHE_SLOT]
  if (isSourceThemeCache(existing)) return existing
  const created = createSourceThemeCache()
  pageGlobal[CACHE_SLOT] = created
  return created
}
