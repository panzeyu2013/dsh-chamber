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
export function createLayoutFactSource(): LayoutFactSource {
  const tier = window.matchMedia(TOUCH_TIER_QUERY)
  const listeners = new Set<() => void>()
  const notify = (): void => { for (const listener of listeners) listener() }
  let frame: Element | null = findFrame()
  const frameObserver = new MutationObserver(notify)
  const attach = (): void => {
    const next = findFrame()
    if (next === frame) return
    if (frame !== null) frameObserver.disconnect()
    frame = next
    if (frame !== null) {
      // data-rightbar-collapsed rides along for forward use; getCollapsed() reads
      // only the sidebar flag.
      frameObserver.observe(frame, { attributes: true, attributeFilter: ['data-sidebar-collapsed', 'data-rightbar-collapsed'] })
    }
    notify()
  }
  attach()
  // Structural guard: only childList mutations that ADD a root-slot or frame
  // candidate can change the frame identity — streaming must not re-query.
  const isStructuralTarget = (node: Node): boolean =>
    node instanceof Element
    && (node.matches('[data-slot="root"]')
      || node.parentElement?.matches('[data-slot="root"]') === true)
  const bodyObserver = new MutationObserver(mutations => {
    if (mutations.some(mutation => mutation.type === 'childList'
      && Array.from(mutation.addedNodes).some(node => isStructuralTarget(node)))) {
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
      bodyObserver.disconnect()
      tier.removeEventListener('change', onTierChange)
    },
  }
}
