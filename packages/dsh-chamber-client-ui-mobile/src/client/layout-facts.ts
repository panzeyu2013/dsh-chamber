/**
 * Layout fact source (design 17 §18.4 项 3, B3 fix): the drawer/collapsed
 * state must drive the mobile behaviors, but the gateway-hosted instance
 * runs the OFFICIAL ui-layout — the chamber fork's `ctx.layoutFacts` service
 * only exists in the desktop renderer (N-ctx shells). The mobile plugin
 * therefore uses a two-tier source:
 *   1. `ctx.layoutFacts` when present (chamber fork — store subscription);
 *   2. the official frame attribute `data-sidebar-collapsed` observed
 *      directly (gateway-hosted official ui-layout).
 * This keeps the `inject` list to official services only (['slots','locale','layout'])
 * so the plugin never stalls on an unmet chamber-only service.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { TOUCH_TIER_QUERY } from './composer.ts'
import { deriveCollapsed } from './markup.ts'

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
 * tier matchMedia (the official store `narrow` — and the DOM — carry no
 * pointer guard; the tier query is the plugin's own activation contract).
 */
export function createLayoutFactSource(ctx: ClientContext): LayoutFactSource {
  // The official ctx is a cordis proxy: touching an un-provided property
  // THROWS ("cannot get property without inject"). The chamber fork's
  // layoutFacts is a chamber-only service — the probe must be exception-
  // safe (P2: the gateway-hosted official ui-layout is the plugin's PRIMARY
  // deployment target).
  interface LayoutFactsFace {
    getLayoutSnapshot(): { narrow: boolean; narrowExpanded: boolean; sidebar: number }
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
      getCollapsed: () => deriveCollapsed(facts.getLayoutSnapshot()),
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
      // data-details-collapsed is observed for forward use (the details
      // overlay state); getCollapsed() today reads only the sidebar flag.
      frameObserver.observe(frame, { attributes: true, attributeFilter: ['data-sidebar-collapsed', 'data-details-collapsed'] })
    }
    notify()
  }
  attach()
  const bodyObserver = new MutationObserver(attach)
  bodyObserver.observe(document.body, { childList: true, subtree: true })
  const onTierChange = (): void => notify()
  tier.addEventListener('change', onTierChange)
  return {
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
