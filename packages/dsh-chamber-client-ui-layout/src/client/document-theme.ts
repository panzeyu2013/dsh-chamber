/**
 * Document-level theme projection, scoped to the ACTIVE view (design 06, N-ctx
 * hardening 2026-12).
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
 *  - an unknown active source fails OPEN to the previous unconditional
 *    projection (official single-shell boot, a boot without a chamber instance
 *    id, or a renderer that has not published yet).
 */
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'

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
 * Build one instance's projector over a page-wide environment.
 * @param instanceId - This boot's chamber source id, or undefined outside the chamber shell.
 * @param env - Page-wide active-view fact and document writer.
 * @returns The projector; `dispose` only unsubscribes.
 */
export function createDocumentThemeProjector(
  instanceId: string | undefined,
  env: DocumentThemeEnvironment,
): DocumentThemeProjector {
  let latest: DocumentThemeSnapshot | undefined
  // Fail open on either unknown side: an unpublished active source or a boot
  // without a chamber instance id keeps the vendor's unconditional behavior.
  const owns = (): boolean => {
    if (instanceId === undefined) return true
    const active = env.getActiveSource()
    return active === undefined || active === instanceId
  }
  const unsubscribe = env.onActiveSource(() => {
    if (latest !== undefined && owns()) env.apply(latest)
  })
  return {
    project: snapshot => {
      latest = snapshot
      if (owns()) env.apply(snapshot)
    },
    dispose: () => { unsubscribe() },
  }
}
