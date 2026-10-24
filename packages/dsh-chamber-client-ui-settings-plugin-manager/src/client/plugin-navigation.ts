/**
 * Cross-plugin navigation to the embedded plugin-manager settings page.
 *
 * The service (`pluginNavigation`) is consumed by the upstream entry-customization row
 * (and by any other registrant): `openList`/`openBundle` must select the page's view
 * AND surface the settings dialog. The dialog is owned by the settings shell, so the
 * view half lives here (the page store, bound when the `settings.section` declaration
 * lands) while the open half goes through the per-ctx `chamberSettingsNavigation`
 * seat. Both peers are deferred chunks, so either half can arrive first: a request
 * queues until its consumer exists instead of being dropped.
 */

/** Where the plugin page should land. */
export type PluginNavigationTarget = 'list' | { readonly kind: 'package'; readonly name: string }

/** The service shape other plugins consume (upstream's `pluginNavigation`). */
export interface PluginNavigationProvider {
  /**
   * Select the Plugins list. The chamber has no main Plugins panel, so this also
   * surfaces the settings shell at the plugin-manager section (no install dialog,
   * no Session change).
   */
  openList(): void
  /**
   * Open a bundle's details in the settings shell without changing the current
   * Session; an absent bundle displays the plugin list after loading.
   * @param packageName - npm package name of the bundle.
   */
  openBundle(packageName: string): void
}

/** Wiring face for the page store and for a late settings-navigation seat. */
export interface PluginNavigation {
  /** The service object other plugins resolve through `ctx.pluginNavigation`. */
  readonly provider: PluginNavigationProvider
  /**
   * Bind the page's navigation store once its slot declaration exists; returns the detach.
   * @param navigate - applies one target to the page store.
   */
  attach(navigate: (target: PluginNavigationTarget) => void): () => void
  /** Retry a queued open once the settings-navigation seat appears. */
  retryOpen(): void
}

/** Dependencies owned by the plugin body (ctx lookups stay there, not in this module). */
export interface PluginNavigationDeps {
  /** Ask the shell to open the plugin-manager section; false when the seat is absent. */
  readonly openSection: () => boolean
}

/**
 * Create the navigation state machine. Pure: no ctx, no timers, no stores.
 * @param deps - the shell-open callback.
 * @returns the provider plus its two wiring hooks.
 */
export function createPluginNavigation(deps: PluginNavigationDeps): PluginNavigation {
  let navigate: ((target: PluginNavigationTarget) => void) | undefined
  let pending: PluginNavigationTarget | undefined
  let openPending = false

  const request = (target: PluginNavigationTarget): void => {
    if (navigate !== undefined) navigate(target)
    else pending = target
    // A refused/absent seat keeps the open queued for the inject flush, but the page
    // target above is still applied so a later manual open lands on the right view.
    // A later successful request clears the queued open (no stale re-open on a flap).
    openPending = !deps.openSection()
  }

  return {
    provider: {
      openList: () => { request('list') },
      openBundle: (packageName) => { request({ kind: 'package', name: packageName }) },
    },
    attach: (next) => {
      navigate = next
      if (pending !== undefined) {
        const target = pending
        pending = undefined
        next(target)
      }
      return () => { if (navigate === next) navigate = undefined }
    },
    retryOpen: () => {
      if (openPending && deps.openSection()) openPending = false
    },
  }
}
