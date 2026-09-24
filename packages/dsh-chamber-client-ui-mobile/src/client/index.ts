/**
 * Chamber mobile adaptation plugin, browser half: adapts the OFFICIAL dsh web
 * shell to touch/narrow viewports. The mechanisms (attribute stamping,
 * enter-to-newline, editability recovery, layout-source-driven drawer) are
 * re-implemented against the dsh DOM on the chamber base (centre column =
 * keyed main slot, right column = rightbar; see markup.ts ROLE_SLOT_KEYS).
 *  - panel state comes from the two-tier layout source (layout-facts.ts): the
 *    chamber layout fork's layoutFacts service when present, else the official
 *    data-sidebar-collapsed attribute (the gateway-hosted instance runs the
 *    OFFICIAL ui-layout).
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
import { MOBILE_CSS, PLUGIN_STYLE_TAG, VIEWPORT_TOKENS } from './styles.ts'
import {
  ROOT_SLOT_SELECTOR,
  shouldRestamp,
  stampFrame,
  type MutationLike,
} from './markup.ts'
import { createLayoutFactSource } from './layout-facts.ts'
import { installMobileReadWatermark } from './read-watermark.ts'
import {
  installComposerSelfHeal, installEditabilityRecovery, installEnterToNewline,
  installImeLadder, installComposerVisibilityGuard, PHONE_TIER_QUERY, TOUCH_TIER_QUERY,
} from './composer.ts'
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
// 同 main.tsx 的锚定赋值（同一套产物标记；未压缩的 committed bundle 也照此写）。
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
// fork, so layoutFacts must NOT be a hard inject (the layout source probes it
// at runtime; layout-facts.ts). sessions is the OFFICIAL session-list service:
// the mobile DOM carries no session-id anchor, so it is the only authoritative
// "which session is the reader on" source.
export const inject = ['slots', 'locale', 'layout', 'sessions']

export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-chamber: mobile dictionaries')

  // ---- read watermark: reading a session on the phone teaches the gateway
  // mirror the host-domain watermark, clearing the desktop unread dot.
  // Fail-closed: absent service / missing row / rejected fetch are silent
  // no-ops (read-watermark.ts). ----
  ctx.effect(() => installMobileReadWatermark(ctx), 'dsh-chamber: mobile read watermark')

  // ---- assets: viewport tokens + stylesheet (idempotent) ----
  ctx.effect(() => {
    const disposers: Array<() => void> = []

    // Viewport tokens are touch-tier concerns (interactive-widget for the
    // Android keyboard, viewport-fit for iOS safe areas); a desktop browser on
    // the gateway keeps the official viewport byte-identical (PC-leak invariant).
    const touchTier = window.matchMedia(TOUCH_TIER_QUERY)
    if (touchTier.matches) {
      const meta = document.querySelector('meta[name="viewport"]')
      if (meta instanceof HTMLMetaElement) {
        const content = meta.content
        const missing = VIEWPORT_TOKENS.filter(token => !content.includes(token))
        if (missing.length > 0) {
          meta.content = [content, ...missing].filter(Boolean).join(', ')
          disposers.push(() => { meta.content = content })
        }
      } else {
        const created = document.createElement('meta')
        created.name = 'viewport'
        created.content = `width=device-width, initial-scale=1, ${VIEWPORT_TOKENS.join(', ')}`
        document.head.appendChild(created)
        disposers.push(() => created.remove())
      }
    }

    if (document.querySelector(`style[data-plugin="${PLUGIN_STYLE_TAG}"]`) === null) {
      const style = document.createElement('style')
      style.setAttribute('data-plugin', PLUGIN_STYLE_TAG)
      style.textContent = MOBILE_CSS
      document.head.appendChild(style)
      disposers.push(() => style.remove())
    }

    // theme-color mirrors the official theme: re-sync when the theme presenter
    // flips the body attribute/dark class. The mobile surface has no theme of
    // its own — it mirrors the shell's light/dark state for the browser chrome.
    const existingThemeMeta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    const themeMeta = existingThemeMeta ?? document.createElement('meta')
    if (existingThemeMeta === null) {
      themeMeta.name = 'theme-color'
      document.head.appendChild(themeMeta)
      disposers.push(() => themeMeta.remove())
    }
    const syncThemeColor = (): void => {
      const surface = getComputedStyle(document.body).getPropertyValue('--dsw-alias-bg-base').trim()
      themeMeta.setAttribute('content', surface === '' ? '#ffffff' : surface)
    }
    syncThemeColor()
    const themeObserver = new MutationObserver(syncThemeColor)
    themeObserver.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme', 'class'] })
    disposers.push(() => themeObserver.disconnect())

    return () => { for (const dispose of disposers) dispose() }
  }, 'dsh-chamber: mobile assets')

  // ---- markup: stamp the frame and its columns (N-ctx: every instance root,
  // idempotent, survives frame remounts). The observer skips deep content
  // mutations: only structural childList changes can affect the stamp set
  // trigger a re-stamp (pure shouldRestamp, unit-tested); streaming/typing
  // churn never matches. The frame-attribute channel below covers
  // attribute-only state flips. ----
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
      if (shouldRestamp(mutations as unknown as MutationLike[])) stamp()
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
  const layoutSource = createLayoutFactSource(ctx)
  ctx.effect(() => {
    let lastLocked = false
    const lockScroll = (locked: boolean): void => {
      const containers = document.querySelectorAll('[data-conversation-scroll]')
      for (const container of containers) {
        if (container instanceof HTMLElement) {
          container.style.overflow = locked ? 'hidden' : ''
        }
      }
      document.body.style.overflow = locked ? 'hidden' : ''
    }
    const sync = (): void => {
      const locked = layoutSource.getNarrow() && !layoutSource.getCollapsed()
      if (locked === lastLocked) return
      lastLocked = locked
      lockScroll(locked)
    }
    const unsubscribe = layoutSource.subscribe(sync)
    return () => {
      unsubscribe()
      lockScroll(false)
    }
  }, 'dsh-chamber: mobile drawer scroll lock')

  // ---- Escape closes the open drawer (touch tier only: a desktop browser must
  // keep the official behavior, where Escape closes the settings dialog). ----
  ctx.effect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (!layoutSource.getNarrow()) return
      // A modal dialog (official settings opens inside the sidebar DOM, so
      // drawer + dialog coexist) owns Escape: closing the drawer underneath it
      // would double-close on one keypress.
      const modalOpen = document.querySelector('[role="dialog"][aria-modal="true"]') !== null
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
