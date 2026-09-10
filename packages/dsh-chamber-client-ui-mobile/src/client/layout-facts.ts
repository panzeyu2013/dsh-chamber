/**
 * Layout fact source (design 17 §18.4 项 3, B3 fix): the drawer/collapsed
 * state must drive the mobile behaviors, but the gateway-hosted instance
 * runs the OFFICIAL ui-layout — the chamber fork's `ctx.layoutFacts` service
 * only exists in the desktop renderer (N-ctx shells). The mobile plugin
 * therefore uses a two-tier source:
 *   1. `ctx.layoutFacts` when present (chamber fork — the store exposes the
 *      AppFrame derivation directly, so the plugin never restates the
 *      breakpoint constant);
 *   2. the official frame attribute `data-sidebar-collapsed` observed
 *      directly (gateway-hosted official ui-layout).
 * This keeps the `inject` list to official services only (['slots','locale','layout'])
 * so the plugin never stalls on an unmet chamber-only service.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
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
 * Build the two-tier source for a ctx. The narrow flag comes from the touch
 * tier matchMedia: the alpha.2 store carries `viewportWidth` (not a `narrow`
 * bit) and neither the store nor the DOM carries a pointer guard, so the tier
 * query is the plugin's own activation contract. `getCollapsed()` comes from
 * the fork's layoutFacts face (tier 1) or the frame attribute (tier 2).
 */
export function createLayoutFactSource(ctx: ClientContext): LayoutFactSource {
  // The official ctx is a cordis proxy: touching an un-provided property
  // THROWS ("cannot get property without inject"). The chamber fork's
  // layoutFacts is a chamber-only service — the probe must be exception-
  // safe (P2: the gateway-hosted official ui-layout is the plugin's PRIMARY
  // deployment target).
  interface LayoutFactsFace {
    /** AppFrame's derived sidebar-collapsed flag (the fork's own derivation). */
    getCollapsed(): boolean
    subscribeLayout(fn: () => void): () => void
  }
  let facts: LayoutFactsFace | undefined
  try {
    facts = (ctx as { layoutFacts?: LayoutFactsFace }).layoutFacts
  } catch {
    facts = undefined
  }
  const tier = window.matchMedia(TOUCH_TIER_QUERY)

  if (facts !== undefined) {
    // Tier 1: chamber fork store subscription.
    const listeners = new Set<() => void>()
    const notify = (): void => { for (const listener of listeners) listener() }
    const unsubscribeStore = facts.subscribeLayout(notify)
    const onTierChange = (): void => notify()
    tier.addEventListener('change', onTierChange)
    return {
      getCollapsed: () => facts.getCollapsed(),
      getNarrow: () => tier.matches,
      subscribe: listener => {
        listeners.add(listener)
        listener()
        return () => { listeners.delete(listener) }
      },
      dispose: () => {
        unsubscribeStore()
        tier.removeEventListener('change', onTierChange)
      },
    }
  }

  // Tier 2: official DOM attribute observation (gateway-hosted instance).
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
      // data-rightbar-collapsed rides along for forward use; getCollapsed()
      // reads only the sidebar flag.
      frameObserver.observe(frame, { attributes: true, attributeFilter: ['data-sidebar-collapsed', 'data-rightbar-collapsed'] })
    }
    notify()
  }
  attach()
  // Structural guard (S3): only childList mutations that ADD a root-slot or
  // frame candidate can change the frame identity — deep content mutations
  // (chat streaming, typing) must not re-query the document per batch.
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
