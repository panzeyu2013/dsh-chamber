/**
 * Chamber mobile adaptation plugin, browser half: adapts the OFFICIAL dsh web
 * shell to touch/narrow viewports. The mechanisms (attribute stamping,
 * enter-to-newline, editability recovery, layout-source-driven drawer) are
 * re-implemented against the dsh DOM on the chamber base (centre column =
 * keyed main slot, right column = rightbar; see markup.ts ROLE_SLOT_KEYS).
 *  - panel state comes from the layout source (layout-facts.ts): the official
 *    frame's data-sidebar-collapsed attribute (the gateway-hosted instance runs
 *    the OFFICIAL ui-layout; the chamber layout fork has no cross-plugin layout
 *    service, and this plugin never mounts on the desktop renderer).
 *  - frame stamping is per instance root and remount-safe; the behavior
 *    effects are document-level single-instance BY DESIGN (the gateway
 *    deployment is single-shell; a future multi-shell renderer mount must
 *    scope them).
 *  - mobile tier = (max-width:1023px) and (pointer:coarse); CSS is fully
 *    media-query scoped, desktop untouched.
 *  - anchors (and ROLE_SLOT_KEYS) must be re-audited when the vendored dsh pin
 *    moves.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { installSvgResourceScope } from '@dsh-chamber/dsh-chamber-client-core/svg-resource-scope'
import { en, zh, type MobileKey } from './locales.ts'
import { MOBILE_CSS, PLUGIN_STYLE_TAG } from './styles.ts'
import {
  ROOT_SLOT_SELECTOR,
  shouldRestamp,
  stampFrame,
  type MutationLike,
} from './markup.ts'
import { createLayoutFactSource } from './layout-facts.ts'
import { applyBackgroundInert } from './drawer-a11y.ts'
import {
  installComposerSelfHeal, installComposerVisibilityGuard,
  installEditabilityRecovery, installEnterToNewline, installImeLadder,
  PHONE_TIER_QUERY, TOUCH_TIER_QUERY,
} from './composer.ts'
import { createViewportAssets, type ViewportDocumentLike } from './viewport-assets.ts'
import { installDrawerTapHeal } from './drawer-taps.ts'
import { installSettingsSheetScrollReset } from './settings-sheet.ts'
import {
  COARSE_NO_HOVER_QUERY, installStrandedHoverCardWatchdog,
} from './official-hover-card.ts'
import { installSessionStallNotice, sessionStallFace } from './session-stall.ts'
import { MobileNavToggle, type MobileNavToggleInjected } from './MobileNavToggle.tsx'

// The OFFICIAL shell's icon components hard-code their Figma resource ids and
// url(#id) resolves DOCUMENT-wide, so an icon whose clipper/mask lands in a
// not-laid-out subtree is dropped at paint time on WebKit and stays blank.
// Installing the same scoper before the shell applies (module scope, before
// createRoot()/first paint; ONE implementation imported from the renderer
// source, never copied) renames the ids document-wide.
// 同 main.tsx 的锚定赋值（同一套产物标记；未压缩的 build-time bundle 也照此写）。
;(globalThis as unknown as { __chamberSvgScopeInstalled?: unknown }).__chamberSvgScopeInstalled =
  installSvgResourceScope()

export type { MobileNavToggleInjected } from './MobileNavToggle.tsx'
export type { MobileKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'dsh-chamber.mobile': MobileKey
  }
}

const NS = 'dsh-chamber.mobile'

// Official services only — the gateway-hosted instance has NO chamber layout
// fork, and the layout source observes the official frame attribute directly
// (layout-facts.ts). sessions is the OFFICIAL session-list service:
// the mobile DOM carries no session-id anchor, so it is the only authoritative
// "which session is the reader on" source.
export const inject = ['slots', 'locale', 'layout', 'sessions']

export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-chamber: mobile dictionaries')

  // ---- assets: viewport tokens + stylesheet (idempotent) ----
  ctx.effect(() => {
    const disposers: Array<() => void> = []

    // Viewport tokens are touch-tier concerns (interactive-widget for the
    // Android keyboard, viewport-fit for iOS safe areas); a desktop browser on
    // the gateway keeps the official viewport byte-identical (PC-leak
    // invariant). The tier is a LIVE state (rotate / attach a mouse), so the
    // matchMedia change event drives the sync and LEAVING the tier retracts
    // exactly what the plugin added, by key — never a one-shot stamp. The
    // keyed surgery and the theme-color mirror live in viewport-assets.ts
    // (runnable without a browser): leaving restores the values that were
    // there before entry, a meta replaced mid-tier is re-queried, and the
    // newest observed official theme baseline wins over an older snapshot.
    const touchTier = window.matchMedia(TOUCH_TIER_QUERY)
    const assets = createViewportAssets(
      document as unknown as ViewportDocumentLike,
      () => getComputedStyle(document.body).getPropertyValue('--dsw-alias-bg-base').trim(),
    )
    /** Body-attribute observer: a theme flip re-mirrors theme-color. */
    let themeObserver: MutationObserver | null = null

    const syncAssets = (): void => {
      if (!touchTier.matches) {
        themeObserver?.disconnect()
        themeObserver = null
        assets.release()
        return
      }
      assets.sync()
      if (themeObserver === null) {
        themeObserver = new MutationObserver(() => assets.syncTheme())
        themeObserver.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme', 'class'] })
      }
    }
    syncAssets()
    touchTier.addEventListener('change', syncAssets)
    disposers.push(() => {
      touchTier.removeEventListener('change', syncAssets)
      themeObserver?.disconnect()
      themeObserver = null
      assets.release()
    })

    if (document.querySelector(`style[data-plugin="${PLUGIN_STYLE_TAG}"]`) === null) {
      const style = document.createElement('style')
      style.setAttribute('data-plugin', PLUGIN_STYLE_TAG)
      style.textContent = MOBILE_CSS
      document.head.appendChild(style)
      disposers.push(() => style.remove())
    }

    return () => { for (const dispose of disposers) dispose() }
  }, 'dsh-chamber: mobile assets')

  // ---- markup: stamp the frame and its columns (N-ctx: every instance root,
  // idempotent, survives frame remounts). The observer skips deep content
  // mutations: only structural childList changes can affect the stamp set
  // trigger a re-stamp (pure shouldRestamp, unit-tested); streaming/typing
  // churn never matches. The frame-attribute channel below covers
  // attribute-only state flips. ----
  // Structural convergence fan-out: the childList observer below is the ONE
  // document-level structural consumer. The drawer lock subscribes to the same
  // signal, because a REPLACED column or [data-conversation-scroll] box never
  // saw the previous lock pass — while the drawer is open the new nodes would
  // stay scrollable/reachable behind it. No second body observer.
  const structuralListeners = new Set<() => void>()
  ctx.effect(() => {
    // stampFrame is idempotent (setAttribute on stable anchors): repeated
    // stamps on remounts are harmless and need no dedup bookkeeping.
    let frameAttributeObserver: MutationObserver | null = null
    const stamp = (): void => {
      const roots = document.querySelectorAll(ROOT_SLOT_SELECTOR)
      for (const root of roots) stampFrame(root)
      // (b) Frame state attributes can flip on attribute-only paths the
      // childList observer never sees; re-attach after every stamp so a
      // remounted frame is observed. stampFrame never writes them — no loop.
      frameAttributeObserver?.disconnect()
      frameAttributeObserver = null
      const frames: Element[] = []
      for (const root of roots) {
        const frame = root.firstElementChild
        if (frame instanceof Element) frames.push(frame)
      }
      if (frames.length === 0) return
      frameAttributeObserver = new MutationObserver(() => stamp())
      for (const frame of frames) {
        frameAttributeObserver.observe(frame, {
          attributes: true,
          attributeFilter: ['data-sidebar-collapsed', 'data-rightbar-collapsed'],
        })
      }
    }
    const onMutations = (mutations: MutationRecord[]): void => {
      if (!shouldRestamp(mutations as unknown as MutationLike[])) return
      stamp()
      for (const listener of structuralListeners) listener()
    }
    stamp()
    const childListObserver = new MutationObserver(onMutations)
    childListObserver.observe(document.body, { childList: true, subtree: true })
    return () => {
      childListObserver.disconnect()
      frameAttributeObserver?.disconnect()
    }
  }, 'dsh-chamber: mobile frame stamping')

  // ---- drawer body scroll lock — the official conversation scroll happens
  // inside [data-conversation-scroll] (the AppFrame itself is overflow:hidden),
  // so locking document.body alone does not stop iOS background scrolling: lock
  // the scroll containers, body as an overscroll backstop. The drawer state
  // comes from the shared layout source (created ONCE per apply). ----
  const layoutSource = createLayoutFactSource()
  ctx.effect(() => {
    let lastLocked = false
    /** The right panel's shown state the last lock ran against (a shown panel
     *  keeps its own column live — see drawer-a11y.ts). Compared separately:
     *  a panel open/close while the drawer stays open must still re-apply. */
    let lastPanelShown: boolean | null = null
    /** Is a right panel SHOWN? The same two yield arms the stylesheet uses:
     *  upstream's track flag (absent = shown) and the fullscreen report. */
    const panelShownNow = (): boolean => {
      const frame = document.querySelector('[data-mobile-frame]')
      return frame !== null
        && (frame.hasAttribute('data-rightbar-fullscreen') || !frame.hasAttribute('data-rightbar-collapsed'))
    }
    const lockScroll = (locked: boolean, panelShown: boolean): void => {
      const containers = document.querySelectorAll('[data-conversation-scroll]')
      for (const container of containers) {
        if (container instanceof HTMLElement) {
          container.style.overflow = locked ? 'hidden' : ''
        }
      }
      // Background accessibility lock: the open drawer covers the conversation
      // and details columns, so neither may stay reachable while it is open
      // (drawer-a11y.ts owns the settings-dialog body-portal relationship and
      // the shown-panel yield).
      applyBackgroundInert(document, locked, panelShown)
      document.body.style.overflow = locked ? 'hidden' : ''
    }
    /** Write the lock for a state. Unconditional: the structural signal below
     *  re-applies it for REPLACED nodes, which the dedup in sync() would skip
     *  while the state itself is unchanged. */
    const publish = (locked: boolean, panelShown: boolean): void => {
      lastLocked = locked
      lastPanelShown = panelShown
      lockScroll(locked, panelShown)
    }
    /** The current drawer/panel state pair, read fresh from the DOM. */
    const currentLock = (): { locked: boolean; panelShown: boolean } => ({
      locked: layoutSource.getNarrow() && !layoutSource.getCollapsed(),
      panelShown: panelShownNow(),
    })
    const sync = (): void => {
      const { locked, panelShown } = currentLock()
      if (locked === lastLocked && panelShown === lastPanelShown) return
      publish(locked, panelShown)
    }
    /** Structural convergence (markup re-stamp): re-apply while locked so the
     *  new columns/scroll boxes are covered, and retract if a replacement
     *  removed the last locked node. */
    const onStructural = (): void => {
      const state = currentLock()
      if (state.locked || lastLocked) publish(state.locked, state.panelShown)
    }
    structuralListeners.add(onStructural)
    const unsubscribe = layoutSource.subscribe(sync)
    return () => {
      structuralListeners.delete(onStructural)
      unsubscribe()
      lockScroll(false, false)
    }
  }, 'dsh-chamber: mobile drawer scroll lock')

  // ---- Escape closes the open drawer (touch tier only: a desktop browser must
  // keep the official behavior, where Escape closes the settings dialog). ----
  ctx.effect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (!layoutSource.getNarrow()) return
      // A foreground modal owns Escape: the official ui-primitives
      // modalSelector is ':is([role="dialog"][aria-modal="true"], [role="menu"])'
      // and the official shortcut/modal layer treats BOTH as keyboard owners
      // (settings opens inside the sidebar DOM, so drawer + dialog coexist; an
      // open menu closes itself on Escape). Closing the drawer underneath any
      // of them would double-close on one keypress.
      const modalOpen = document.querySelector(':is([role="dialog"][aria-modal="true"], [role="menu"])') !== null
      if (modalOpen) return
      if (!layoutSource.getCollapsed()) ctx.layout.toggleSidebar()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, 'dsh-chamber: mobile drawer escape close')

  // The shared layout source is released when the ctx dies.
  ctx.effect(() => () => layoutSource.dispose(), 'dsh-chamber: mobile layout source')

  // ---- composer + drawer behavior (touch tier only — the PC-leak guard
  // applies to JS too: desktop keeps the official Enter=send convention and
  // native click delivery). Installed/uninstalled as the tier flips. ----
  ctx.effect(() => {
    const touchTier = window.matchMedia(TOUCH_TIER_QUERY)
    // The settings sheet is PHONE-tier CSS; its scroll-reset behavior gates on
    // the same tier (a 769-1023px touch tablet keeps the official modal
    // geometry and cross-section scroll behavior).
    const phoneTier = window.matchMedia(PHONE_TIER_QUERY)
    let disposers: Array<() => void> = []
    const sync = (): void => {
      if (touchTier.matches) {
        if (disposers.length === 0) {
          const ladder = installImeLadder()
          disposers = [
            installEnterToNewline(),
            installEditabilityRecovery(),
            installComposerVisibilityGuard(),
            installComposerSelfHeal(),
            // iOS suppresses the compatibility click for drawer taps: heal the
            // lost activation so one tap switches sessions (drawer-taps.ts).
            installDrawerTapHeal(() => touchTier.matches),
            // Phone-tier settings sheet: switching section chips resets the
            // shared options scroller (settings-sheet.ts).
            installSettingsSheetScrollReset(() => phoneTier.matches),
            ladder.attach(),
          ]
        }
      } else {
        for (const dispose of disposers) dispose()
        disposers = []
      }
    }
    sync()
    touchTier.addEventListener('change', sync)
    return () => {
      touchTier.removeEventListener('change', sync)
      for (const dispose of disposers) dispose()
    }
  }, 'dsh-chamber: mobile composer behavior')

  // ---- stranded OFFICIAL hover-card watchdog ----: this tier loads the
  // official HoverCard (the chamber RowHoverCard exists only on the composite
  // page); the watchdog drives the atom's own onPointerLeave through one
  // bubbling pointerout — see official-hover-card.ts for the mechanism and
  // every guard. It rides the coarse-pointer chrome tier, NOT the width-capped
  // touch tier. Installed/uninstalled as the tier flips. ----
  ctx.effect(() => {
    const coarseNoHover = window.matchMedia(COARSE_NO_HOVER_QUERY)
    let disposeWatchdog: (() => void) | null = null
    const sync = (): void => {
      if (coarseNoHover.matches) {
        disposeWatchdog ??= installStrandedHoverCardWatchdog(() => coarseNoHover.matches)
      } else {
        disposeWatchdog?.()
        disposeWatchdog = null
      }
    }
    sync()
    coarseNoHover.addEventListener('change', sync)
    return () => {
      coarseNoHover.removeEventListener('change', sync)
      disposeWatchdog?.()
      disposeWatchdog = null
    }
  }, 'dsh-chamber: stranded official hover-card watchdog')

  // ---- session-load stall notice ----: the official chat view can park on
  // its loading-history face forever and offers no way out; this notice is the
  // page's only recovery lever. Runs on the touch tier, installed/uninstalled
  // dynamically; see session-stall.ts for shape, threshold and guards. ----
  ctx.effect(() => {
    const touchTier = window.matchMedia(TOUCH_TIER_QUERY)
    let disposeNotice: (() => void) | null = null
    const sync = (): void => {
      if (touchTier.matches) {
        disposeNotice ??= installSessionStallNotice(t, sessionStallFace(ctx))
      } else {
        disposeNotice?.()
        disposeNotice = null
      }
    }
    sync()
    touchTier.addEventListener('change', sync)
    return () => {
      touchTier.removeEventListener('change', sync)
      disposeNotice?.()
      disposeNotice = null
    }
  }, 'dsh-chamber: session-load stall notice')

  // ---- shell.overlay: the floating drawer toggle (additive list slot) ----
  const injected = (): MobileNavToggleInjected => ({
    toggleSidebar: () => ctx.layout.toggleSidebar(),
    t,
  })
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'mobile-nav-toggle',
    label: () => t('dsh-chamber.mobile.title'),
    locale: NS,
    inject: injected,
  }, MobileNavToggle))
}
