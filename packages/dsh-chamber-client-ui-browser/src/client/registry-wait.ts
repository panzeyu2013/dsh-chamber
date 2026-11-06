/**
 * Wait for the official right-sidebar host services (`sidebarRight` and the
 * `sidebarRightTabs` tab-type registry) and diagnose services that never
 * arrive.
 *
 * WHY A WAIT, NOT A PROBE. Both services are provided by the
 * `ui-sidebar-right` host-graph row. On every boot of the page but the FIRST,
 * that row applies AFTER the composite's deferred chunk: the chunk is
 * page-cached, so its `import()` resolves within a microtask while the row still
 * has to be created and satisfy its own inject faces. A one-shot
 * `ctx.get('sidebarRightTabs')` therefore registered the Browser tab only on the
 * page's first boot (the local instance, which pays the chunk fetch over the
 * network) and silently lost on every source opened later — the "no Browser
 * button on another server" bug.
 *
 * `ctx.inject` runs the installer when the services appear and unloads it when
 * the provider goes away, so either ordering registers. The grace diagnostic
 * names services that never arrive; it stays silent when they are all present
 * (a present-but-malformed one is the installer's own diagnostic, not this
 * one's).
 *
 * Framework-free and Node-runnable (no React, no DOM, no Node APIs beyond the
 * `setTimeout`/console globals): test/registration pins the wait and the
 * diagnostic with a fake context.
 */

/** The client-context slice this module needs (structural, so tests can fake it). */
export interface RegistryWaitContext {
  get(name: string): unknown
  inject(deps: string[], callback: (host: RegistryWaitContext) => void): unknown
  effect(body: () => void | (() => void), label?: string): unknown
}

/** The right-sidebar host services the upstream registration body reads. */
export const SIDEBAR_HOST_SERVICES = Object.freeze(['sidebarRight', 'sidebarRightTabs'] as const)

/** Grace before the "services never arrived" diagnostic (the required-service probe's window). */
export const REGISTRY_GRACE_MS = 5000

/**
 * Arm the installer for the right-sidebar services, and name services that never arrive.
 *
 * @param ctx - the context to inject on (the entry's client context).
 * @param install - called with the context where the services are available.
 */
export function waitForSidebarHost<Host extends RegistryWaitContext>(
  ctx: Host,
  install: (host: Host) => void,
): void {
  ctx.inject([...SIDEBAR_HOST_SERVICES], (host) => { install(host as Host) })
  ctx.effect(() => {
    const timer = setTimeout(() => {
      const missing = SIDEBAR_HOST_SERVICES.filter((name) => ctx.get(name) === undefined)
      if (missing.length === 0) return
      console.warn(
        '[chamber-browser] ' + missing.join(', ') + ' still absent after ' + String(REGISTRY_GRACE_MS)
        + 'ms; the Browser tab stays absent unless the ui-sidebar-right row registers',
      )
    }, REGISTRY_GRACE_MS)
    return () => { clearTimeout(timer) }
  }, 'dsh-chamber: remote browser sidebar diagnostic')
}
