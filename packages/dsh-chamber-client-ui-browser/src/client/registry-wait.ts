/**
 * Wait for the official right-sidebar tab registry (`sidebarRightTabs`) and
 * diagnose a registry that never arrives.
 *
 * WHY A WAIT, NOT A PROBE. The registry is provided by the `ui-sidebar-right`
 * host-graph row. On every boot of the page but the FIRST, that row applies
 * AFTER the composite's deferred chunk: the chunk is page-cached, so its
 * `import()` resolves within a microtask while the row still has to be created
 * and satisfy its own inject faces. A one-shot `ctx.get('sidebarRightTabs')`
 * therefore registered the Browser tab only on the page's first boot (the local
 * instance, which pays the chunk fetch over the network) and silently lost on
 * every source opened later — the "no Browser button on another server" bug.
 *
 * `ctx.inject` runs the installer when the service appears and unloads it when
 * the provider goes away, so either ordering registers. The grace diagnostic
 * names a frontend that never provides the row at all; it stays silent whenever
 * any registry value exists at fire time (a present-but-malformed one is the
 * installer's diagnostic, not this one's).
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

/** Grace before the "registry never arrived" diagnostic (the required-service probe's window). */
export const REGISTRY_GRACE_MS = 5000

/**
 * Arm the installer for the registry, and name a registry that never arrives.
 *
 * @param ctx - the context to inject on (the entry's client context).
 * @param install - called with the context where the registry is available.
 */
export function waitForSidebarTabs<Host extends RegistryWaitContext>(
  ctx: Host,
  install: (host: Host) => void,
): void {
  ctx.inject(['sidebarRightTabs'], (host) => { install(host as Host) })
  ctx.effect(() => {
    const timer = setTimeout(() => {
      // Any provided value (even a rejected shape) was already handled by the
      // installer's own diagnostic; only a registry that never arrived is ours.
      if (ctx.get('sidebarRightTabs') !== undefined) return
      console.warn(
        '[chamber-browser] sidebarRightTabs is still absent after ' + String(REGISTRY_GRACE_MS)
        + 'ms; the Browser tab stays absent unless the ui-sidebar-right row registers',
      )
    }, REGISTRY_GRACE_MS)
    return () => { clearTimeout(timer) }
  }, 'dsh-chamber: remote browser registry diagnostic')
}
