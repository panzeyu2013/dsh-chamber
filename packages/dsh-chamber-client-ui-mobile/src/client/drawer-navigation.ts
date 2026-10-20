/**
 * Drawer navigation close (touch tier): the mobile sidebar is a drawer, but the
 * official sidebar is written for a persistent desktop column — selecting a
 * main panel or a session changes the centre view WITHOUT collapsing it. On a
 * phone that leaves the destination behind a 280px opaque drawer and an inert
 * conversation, so the user has to tap the backdrop/toggle a second time.
 *
 * Two navigation signals are consumed, both official:
 *  - a click on a sidebar PANEL ROW: the row button contains its glyph's
 *    [data-slot="sidebar.panellist"] outlet (the official SidebarRoot renders
 *    the slot inside the row). The close is deferred to a microtask so the
 *    row's own React onClick (selectPanel) runs first.
 *  - the officially PRESENTED session id (session-presentation.ts): a session
 *    switch, a new-session clear/replace, or leaving a panel back to the
 *    conversation changes it. The id — not a DOM node or a localized label — is
 *    the stable identity, and streaming/status notifications keep it equal.
 *
 * New-session buttons that REUSE the same blank session are deliberately not a
 * third signal: no navigation happened, so the drawer state is unchanged.
 */
import { INSTALL_KEYS, installOnce } from './composer.ts'
import {
  presentedSessionId,
  type SessionListSnapshotLoose,
} from './session-presentation.ts'

const SIDEBAR_SELECTOR = '[data-mobile-role="sidebar"]'
/** The official panel-row outlet; every panel row renders this inside its glyph. */
export const PANEL_ROW_SLOT = '[data-slot="sidebar.panellist"]'

/** The sessions-list face this module reads (the official rc.2 store shape). */
export interface SessionsListLike {
  getSnapshot?(): { byId?: Record<string, unknown> } | undefined
  subscribe?(listener: () => void): (() => void) | void
}

export interface DrawerNavigationOptions {
  /** The touch tier is live. */
  active(): boolean
  /** The drawer is currently open (narrow + expanded). */
  isOpen(): boolean
  /** Close the official sidebar (the plugin's toggle action). */
  close(): void
  /** Official sessions service, when present. */
  sessions?: { readonly list?: SessionsListLike | undefined } | undefined
}

/**
 * Is this click a sidebar panel-row activation? Pure and structural: a button
 * inside the mobile sidebar whose subtree carries the official panellist slot.
 * Localized labels and hashed row classes are never read.
 */
export function isPanelRowClick(target: unknown): boolean {
  if (typeof Element === 'undefined' || !(target instanceof Element)) return false
  const button = target.closest('button')
  if (button === null) return false
  if (button.closest(SIDEBAR_SELECTOR) === null) return false
  return button.querySelector(PANEL_ROW_SLOT) !== null
}

/**
 * Install the drawer-navigation close. Single-seat per window (installOnce);
 * the disposer removes the click listener and the list subscription.
 */
export function installDrawerNavigationClose(options: DrawerNavigationOptions): () => void {
  if (typeof document === 'undefined') return () => {}
  return installOnce(INSTALL_KEYS.drawerNavigation, () => installInner(options))
}

function installInner(options: DrawerNavigationOptions): () => void {
  const closeIfOpen = (): void => {
    try {
      if (!options.active() || !options.isOpen()) return
      options.close()
    } catch {
      // A navigation watcher must never throw into the shell it watches.
    }
  }

  const onClick = (event: MouseEvent): void => {
    if (!isPanelRowClick(event.target)) return
    // Let the row's React onClick (selectPanel) run before the drawer starts
    // its 0.3s slide-out; the row stays mounted (the drawer hides by
    // visibility/transform), so the activation is never lost.
    queueMicrotask(closeIfOpen)
  }
  document.addEventListener('click', onClick, true)

  let unsubscribe: (() => void) | null = null
  const list = options.sessions?.list
  if (typeof list?.getSnapshot === 'function' && typeof list.subscribe === 'function') {
    try {
      let previous = presentedSessionId(list.getSnapshot() as SessionListSnapshotLoose | undefined)
      const result = list.subscribe(() => {
        const next = presentedSessionId(list.getSnapshot?.() as SessionListSnapshotLoose | undefined)
        if (next === previous) return
        previous = next
        closeIfOpen()
      })
      if (typeof result === 'function') unsubscribe = result
    } catch {
      // Fail closed: a hostile/unavailable store only disables the session leg;
      // the panel-row arm above still works.
      unsubscribe = null
    }
  }

  return () => {
    document.removeEventListener('click', onClick, true)
    unsubscribe?.()
  }
}
