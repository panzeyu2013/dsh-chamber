/**
 * Document-level theme projection, scoped to the ACTIVE view (design 06).
 *
 * The vendor ThemePresenter writes document-global state (html color-scheme,
 * body palette token, font-size variable, theme-color meta) and dispose()
 * retracts it unconditionally — correct for one shell per document, but the
 * chamber shell mounts N views into one document, so a hidden view's
 * apply/teardown would repaint or strip the visible view's palette.
 * Rules: only the active view's instance writes the document; teardown never
 * retracts it; an unknown active source (single-shell boot, unpublished
 * renderer) fails OPEN to the unconditional projection.
 */
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import { decidePrime, type SourceThemeCache } from './theme-cache.ts'

/** One resolved snapshot from `ctx.theme.getTheme()`; opaque because the vendor type is not reachable through the loose declaration. */
export type DocumentThemeSnapshot = unknown

/** Page-wide facts the projector reads; the production wiring is chamberBridge. */
export interface DocumentThemeEnvironment {
  /** Source id of the view currently on screen, or undefined when unpublished. */
  getActiveSource(): string | undefined
  /** Subscribe to active-view changes; returns the unsubscribe. */
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
 * Optional page-wide priming. Without `cache` the projector only re-projects
 * its OWN remembered snapshot on activation, so a cold target boots on
 * whatever palette the previous view left behind.
 */
export interface DocumentThemeProjectorOptions {
  /** Page-wide per-source snapshot cache (see theme-cache.ts). */
  cache?: SourceThemeCache
  /**
   * Cache-admission gate: only SETTLED snapshots may be remembered, so a
   * provisional system-default snapshot never becomes a source palette.
   * Defaults to admitting every snapshot.
   */
  isSettled?: (snapshot: DocumentThemeSnapshot) => boolean
}

/**
 * Build one instance's projector over a page-wide environment.
 * @param instanceId - this boot's chamber source id, or undefined outside the chamber shell.
 * @param env - page-wide active-view fact and document writer.
 * @param options - optional page-wide priming; omitted = no priming.
 */
export function createDocumentThemeProjector(
  instanceId: string | undefined,
  env: DocumentThemeEnvironment,
  options?: DocumentThemeProjectorOptions,
): DocumentThemeProjector {
  const cache = options?.cache
  const isSettled = options?.isSettled ?? ((): boolean => true)
  let latest: DocumentThemeSnapshot | undefined
  // Fail open on either unknown side (unpublished source, no chamber instance id).
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
        // The active view is authoritative: a fresh own-snapshot supersedes any cold-boot prime.
        cache?.clearPrimed()
        env.apply(snapshot)
      }
    },
    dispose: () => {
      unsubscribe()
      // Keep the remembered palette (it primes the next cold open) but stop counting as mounted.
      if (cache !== undefined && instanceId !== undefined) cache.setMounted(instanceId, false)
    },
  }
}
