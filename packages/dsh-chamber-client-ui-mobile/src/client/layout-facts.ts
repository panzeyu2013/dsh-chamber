/**
 * Layout fact source: the drawer/collapsed state drives the mobile behaviors on
 * the gateway-hosted instance, which runs the OFFICIAL ui-layout. The only
 * source is the official frame attribute `data-sidebar-collapsed` observed
 * directly: the chamber layout fork has no cross-plugin layout service (the
 * retired `ctx.layoutFacts` face), and this plugin never mounts on the desktop
 * renderer anyway. The inject list stays official-services-only, so the plugin
 * never stalls on an unmet chamber-only service.
 */
import { TOUCH_TIER_QUERY } from './composer.ts'

export interface LayoutFactSource {
  /** The AppFrame-derived collapsed flag (drawer closed). */
  getCollapsed(): boolean
  /** Narrow (below the auto-collapse breakpoint) per the touch tier. */
  getNarrow(): boolean
  /** Subscribe to changes; fires immediately with the current value. */
  subscribe(listener: () => void): () => void
  /** Release observers/listeners (called from the owning ctx.effect). */
  dispose(): void
}

/** The official frame element (first child of the root slot). */
function findFrame(): Element | null {
  const root = document.querySelector('[data-slot="root"]')
  if (root === null) return null
  for (const child of root.children) {
    if (child instanceof Element) return child
  }
  return null
}

/**
 * Build the DOM-observation source. The narrow flag comes from the touch tier
 * matchMedia (the store carries viewportWidth, not a narrow bit, and no pointer
 * guard): the tier query is the plugin's own activation contract.
 */
/**
 * Subscribe the drawer-open boolean to the official frame attribute, for
 * consumers that must keep a DERIVED state fresh across frame remounts (the
 * floating toggle's aria-expanded/aria-label). Re-resolving the frame is the
 * source's own job: it re-attaches on structural mounts and notifies, so the
 * callback always reads the CURRENT frame instead of an element that was
 * replaced. Returns the unsubscribe (and disposes the source).
 */
export function subscribeDrawerOpen(onChange: (open: boolean) => void): () => void {
  const source = createLayoutFactSource()
  const unsubscribe = source.subscribe(() => onChange(!source.getCollapsed()))
  return () => {
    unsubscribe()
    source.dispose()
  }
}

export function createLayoutFactSource(): LayoutFactSource {
  const tier = window.matchMedia(TOUCH_TIER_QUERY)
  const listeners = new Set<() => void>()
  const notify = (): void => { for (const listener of listeners) listener() }
  let frame: Element | null = findFrame()
  /** Is the attribute observer currently bound to `frame`? Seeding `frame`
   *  above must not skip the observation: a source created while the frame is
   *  ALREADY mounted still needs the attribute channel (otherwise the first
   *  collapsed flip notifies nobody and the drawer state goes stale). */
  let observing = false
  const frameObserver = new MutationObserver(notify)
  const attach = (): void => {
    const next = findFrame()
    if (next === frame && (next === null || observing)) return
    if (observing) {
      frameObserver.disconnect()
      observing = false
    }
    frame = next
    if (frame !== null) {
      // data-rightbar-collapsed/data-rightbar-fullscreen ride along for
      // consumers that mirror the right panel's shown state; getCollapsed()
      // reads only the sidebar flag.
      frameObserver.observe(frame, {
        attributes: true,
        attributeFilter: ['data-sidebar-collapsed', 'data-rightbar-collapsed', 'data-rightbar-fullscreen'],
      })
      observing = true
    }
    notify()
  }
  attach()
  // Structural guard: only childList mutations that ADD or REMOVE a root-slot
  // or frame candidate can change the frame identity — streaming must not
  // re-query. Additions are detected by the mount shape (a root slot, or a
  // node whose parent IS the root slot). Removals cannot read that parent
  // chain: a detached node has no parentElement left, so the candidates are
  // this source's own current frame (captured before attach() re-resolves)
  // plus any removed root slot / already-stamped frame, by their own
  // attributes. On a hit attach() re-resolves — a removed frame yields
  // frame === null, so getCollapsed() falls back to its fail-safe true — and
  // notify() keeps every consumer off the detached element.
  const isStructuralAddition = (node: Node): boolean =>
    node instanceof Element
    && (node.matches('[data-slot="root"]')
      || node.parentElement?.matches('[data-slot="root"]') === true)
  const isStructuralRemoval = (node: Node): boolean =>
    node === frame
    || (node instanceof Element
      && (node.matches('[data-slot="root"]') || node.matches('[data-mobile-frame]')))
  const bodyObserver = new MutationObserver(mutations => {
    if (mutations.some(mutation => mutation.type === 'childList'
      && (Array.from(mutation.addedNodes).some(node => isStructuralAddition(node))
        || Array.from(mutation.removedNodes).some(node => isStructuralRemoval(node))))) {
      attach()
    }
  })
  bodyObserver.observe(document.body, { childList: true, subtree: true })
  const onTierChange = (): void => notify()
  tier.addEventListener('change', onTierChange)
  return {
    // Fail-safe null: no frame yet reads as "collapsed" (no scroll lock),
    // which is the safe direction while the shell is still mounting.
    getCollapsed: () => frame === null || frame.hasAttribute('data-sidebar-collapsed'),
    getNarrow: () => tier.matches,
    subscribe: listener => {
      listeners.add(listener)
      listener()
      return () => { listeners.delete(listener) }
    },
    dispose: () => {
      frameObserver.disconnect()
      observing = false
      bodyObserver.disconnect()
      tier.removeEventListener('change', onTierChange)
    },
  }
}
