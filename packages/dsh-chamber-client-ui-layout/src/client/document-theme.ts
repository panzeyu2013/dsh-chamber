/**
 * Document-level theme projection, scoped to the ACTIVE view (design 06).
 *
 * The vendor ThemePresenter writes DOCUMENT-global state — `html{color-scheme}`
 * (native widget chrome), `body[data-ds-dark-theme]` (the token palette), the
 * content font-size variable, one theme-color meta — and its `dispose()`
 * retracts all of it unconditionally. That is correct for the official
 * single-shell deployment, where one shell owns the document. The chamber
 * desktop mounts N instance shells into ONE document, so every mounted view
 * boots its own ui-layout fiber and N presenters compete for the same globals:
 * a hidden view's apply (idle prewarm) repaints the visible one, and its
 * teardown (retention reclaim) strips the visible view's palette — leaving
 * dsh's light default palette (`design-platform.css` `body` block, no
 * `data-ds-dark-theme`) next to the chamber shell's dark `:root{color-scheme}`
 * fallback, i.e. dark native checkboxes on a light UI until some later
 * theme/change or remount re-applied.
 *
 * Rules enforced here:
 *  - only the active view's instance writes the document;
 *  - teardown never retracts the document (the page-wide presenter is reused by
 *    whichever view is active next), so unmounting one view cannot repaint
 *    another;
 *  - an unknown active source fails OPEN to the unconditional
 *    projection (official single-shell boot, a boot without a chamber instance
 *    id, or a renderer that has not published yet).
 */
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import { decidePrime, type SourceThemeCache } from './theme-cache.ts'

/**
 * One resolved theme snapshot, as produced by `ctx.theme.getTheme()`. Opaque
 * here by construction: the projector only forwards it to the vendor
 * ThemePresenter, and this fork's vendor module declaration is a loose face
 * (see `vendor-modules.d.ts`), so the vendor `ThemeSnapshot` type is not
 * reachable from this package.
 */
export type DocumentThemeSnapshot = unknown

/** Page-wide facts the projector reads; the production wiring is chamberBridge. */
export interface DocumentThemeEnvironment {
  /** Source id of the view currently on screen, or undefined when unpublished. */
  getActiveSource(): string | undefined
  /** Subscribe to active-view changes (change-only notifications); returns the unsubscribe. */
  onActiveSource(listener: (sourceId: string | undefined) => void): () => void
  /** Write one resolved snapshot onto the document (the vendor ThemePresenter.apply). */
  apply(snapshot: DocumentThemeSnapshot): void
}

/** One instance's handle on the shared document projection. */
export interface DocumentThemeProjector {
  /** Record a resolved snapshot and project it when this instance is the active view. */
  project(snapshot: DocumentThemeSnapshot): void
  /** Stop tracking active-view changes. Deliberately never retracts the document. */
  dispose(): void
}

/**
 * Optional page-wide priming. Omitting `cache` keeps the no-cache behavior
 * byte-for-byte (the unit tests lock that shape): without a cache the projector
 * only re-projects its OWN remembered snapshot on activation,
 * so a cold target boots on whatever palette the previous view left behind.
 */
export interface DocumentThemeProjectorOptions {
  /** Page-wide per-source snapshot cache (see theme-cache.ts). */
  cache?: SourceThemeCache
  /**
   * Cache-admission gate. Only SETTLED snapshots may be remembered: a provisional
   * snapshot (theme runtime using the system default before the settings scope
   * hydrates, per the locale-ownership.ts:127-150 discipline) must never become a
   * source palette. Defaults to admitting every snapshot.
   */
  isSettled?: (snapshot: DocumentThemeSnapshot) => boolean
}

/**
 * Build one instance's projector over a page-wide environment.
 * @param instanceId - This boot's chamber source id, or undefined outside the chamber shell.
 * @param env - Page-wide active-view fact and document writer.
 * @param options - Optional page-wide priming; omitted = no priming.
 * @returns The projector; `dispose` only unsubscribes (and releases the mount mark).
 */
export function createDocumentThemeProjector(
  instanceId: string | undefined,
  env: DocumentThemeEnvironment,
  options?: DocumentThemeProjectorOptions,
): DocumentThemeProjector {
  const cache = options?.cache
  const isSettled = options?.isSettled ?? ((): boolean => true)
  let latest: DocumentThemeSnapshot | undefined
  // Fail open on either unknown side: an unpublished active source or a boot
  // without a chamber instance id keeps the vendor's unconditional behavior.
  const owns = (): boolean => {
    if (instanceId === undefined) return true
    const active = env.getActiveSource()
    return active === undefined || active === instanceId
  }
  if (cache !== undefined && instanceId !== undefined) cache.setMounted(instanceId, true)
  const unsubscribe = env.onActiveSource(sourceId => {
    if (cache === undefined) {
      if (latest !== undefined && owns()) env.apply(latest)
      return
    }
    const decision = decidePrime({
      active: sourceId,
      self: instanceId,
      hasCached: sourceId !== undefined && cache.snapshotOf(sourceId) !== undefined,
      activeMounted: sourceId !== undefined && cache.isMounted(sourceId),
      primedFor: cache.primedFor(),
      hasFallback: cache.lastSettled() !== undefined,
    })
    if (decision === 'self') {
      if (latest !== undefined) env.apply(latest)
      return
    }
    if (decision === 'none' || sourceId === undefined) return
    const snapshot = decision === 'cached' ? cache.snapshotOf(sourceId) : cache.lastSettled()
    if (snapshot === undefined) return
    env.apply(snapshot)
    cache.markPrimed(sourceId)
  })
  return {
    project: snapshot => {
      latest = snapshot
      if (cache !== undefined && instanceId !== undefined && isSettled(snapshot)) {
        cache.remember(instanceId, snapshot)
      }
      if (owns()) {
        // The active view is authoritative: a fresh own-snapshot supersedes any
        // cold-boot prime, so the next activation may prime again.
        cache?.clearPrimed()
        env.apply(snapshot)
      }
    },
    dispose: () => {
      unsubscribe()
      // Keep the remembered palette (that is what primes the next cold open) but
      // stop counting as mounted, so a hidden instance may prime this source.
      if (cache !== undefined && instanceId !== undefined) cache.setMounted(instanceId, false)
    },
  }
}
