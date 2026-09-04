/**
 * Chamber mobile adaptation plugin, browser half (design 17 §18): adapts the
 * OFFICIAL dsh web shell to touch/narrow viewports. Zero code copied from
 * community plugins — the mechanisms (attribute stamping, enter-to-newline,
 * editability recovery, layout-source-driven drawer) are re-implemented
 * against the empirical 0.1.2-alpha.4 DOM on the chamber base (the alpha.4
 * anchor audit re-verified the anchors; the ui-layout AppFrame is
 * byte-identical with the alpha.3 pin):
 *  - panel state comes from the two-tier layout source (layout-facts.ts):
 *    the chamber layout fork's `layoutFacts` service when present, the
 *    official `data-sidebar-collapsed` attribute observation otherwise —
 *    the gateway-hosted instance runs the OFFICIAL ui-layout (design 17
 *    §18.4 项 3 deployment-matrix exception);
 *  - frame stamping is per instance root (`[data-slot="root"]`),
 *    idempotent and remount-safe (项 2); the session-header chrome stamps
 *    (the "Session 日志" export capsule compact mark, markup.ts) ride the
 *    same re-stamp channels; the behavior effects are
 *    document-level single-instance BY DESIGN (the gateway deployment is
 *    single-shell; a future multi-shell renderer mount must scope them);
 *  - the mobile tier activates on `(max-width:1023px) and (pointer:coarse)`
 *    (项 5) — the CSS is fully media-query scoped, desktop untouched.
 *
 *  Anchor-version note: the alpha.4 anchor audit (2026-09) describes the DOM
 *  shapes the mechanisms were built against; the vendored base is now
 *  0.1.2-rc.1 and the anchors were re-verified against the rc.1 source
 *  (2026-12 review). The dsh version actually injected into a gateway
 *  instance is decided by the dsh-runtime on the serving desktop/gateway —
 *  anchors must be re-audited when the vendored pin moves (markup.ts pins
 *  the stamped dictionary copy at rc.1 separately).
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { en, zh, type MobileKey } from './locales.ts'
import { MOBILE_CSS, PLUGIN_STYLE_TAG, VIEWPORT_TOKENS } from './styles.ts'
import {
  ROOT_SLOT_SELECTOR,
  shouldRestamp,
  stampFrame,
  stampSessionLogDismiss,
  type MutationLike,
} from './markup.ts'
import { createLayoutFactSource } from './layout-facts.ts'
import {
  installComposerSelfHeal, installEditabilityRecovery, installEnterToNewline,
  installImeLadder, installKeyboardPinning, TOUCH_TIER_QUERY,
} from './composer.ts'
import { installDrawerTapHeal } from './drawer-taps.ts'
import { MobileNavToggle, type MobileNavToggleInjected } from './MobileNavToggle.tsx'

export type { MobileNavToggleInjected } from './MobileNavToggle.tsx'
export type { MobileKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'dsh-chamber.mobile': MobileKey
  }
}

const NS = 'dsh-chamber.mobile'

// Official services only — the gateway-hosted instance has NO chamber layout
// fork, so `layoutFacts` (a chamber-only service) must NOT be a hard inject;
// the layout source abstraction probes it at runtime and falls back to the
// official frame attribute (layout-facts.ts).
export const inject = ['slots', 'locale', 'layout']

export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-chamber: mobile dictionaries')

  // ---- assets: viewport tokens + stylesheet (idempotent) ----
  ctx.effect(() => {
    const disposers: Array<() => void> = []

    // Viewport tokens are touch-tier concerns only (interactive-widget for
    // the Android keyboard, viewport-fit for iOS safe areas): a desktop
    // browser on the gateway must keep the official viewport byte-identical
    // (the PC-leak invariant applies to the meta surface too).
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

    // theme-color follows the official theme (F4): read the alias surface
    // token, re-synced when the official theme presenter flips the body
    // attribute. The mobile surface has no theme of its own — it must
    // mirror the shell's light/dark state for the browser chrome.
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

  // ---- markup: stamp the frame and its columns (N-ctx: every instance
  // root, idempotent, survives frame remounts). The observer skips deep
  // content mutations (P2-4): only childList changes that can affect the
  // stamp set (root slot / frame / column shell / session-gated slot outlet
  // mounting inside a resident column shell — see isStructuralTarget in
  // markup.ts) trigger a re-stamp; chat streaming and typing commit
  // thousands of deep childList batches that never match. The batch
  // decision is a pure function (shouldRestamp), unit-tested without a DOM.
  //
  // alpha.4 anchor audit (2026-09): the official AppFrame renders the
  // details column SHELL from first paint while its [data-slot="details"]
  // outlet is session-gated (a3/a4 ui-layout byte-identical) — the old
  // "details column appearing with a session" model was a with-session
  // snapshot. The childList channel below (a) covers the outlet mounting
  // into the resident shell; a separate frame-attribute channel (b) covers
  // attribute-only state flips and any deeper drift. The two channels are
  // deliberately independent: attribute records never reach the childList
  // batch decision.
  ctx.effect(() => {
    // stampFrame is idempotent (setAttribute on stable anchors), so repeated
    // stamps on remounts are harmless and need no dedup bookkeeping.
    let frameAttributeObserver: MutationObserver | null = null
    const stamp = (): void => {
      const roots = document.querySelectorAll(ROOT_SLOT_SELECTOR)
      for (const root of roots) {
        const frame = stampFrame(root)
        // Session-header chrome stamps (late-mounting, idempotent): the
        // "Session 日志" export capsule gets the phone-tier compact mark.
        // Runs on every structural/attribute re-stamp — it simply finds no
        // header before a session mounts.
        if (frame !== null) stampSessionLogDismiss(frame)
      }
      // (b) Frame state attributes (collapsed flags) drive the drawer/overlay
      // geometry and can flip in the same commit as a session activation, or
      // on attribute-only paths the childList observer never sees. Re-attach
      // after every stamp so a remounted frame is observed; stampFrame never
      // writes these attributes, so there is no self-trigger loop. Frequency
      // is user-action level (drawer open/close, details open) — zero
      // streaming noise. NOTE: this observer channel is wiring-only and has
      // no unit test (no DOM/MutationObserver test base in this package) —
      // verified on device (§18.6); the pure batch decision below is the
      // unit-tested part.
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
          attributeFilter: ['data-sidebar-collapsed', 'data-details-collapsed'],
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

  // ---- drawer body scroll lock (layout-source-driven; design 17 §18.4
  // 项 3) — the official conversation scroll happens inside
  // [data-conversation-scroll] (the AppFrame itself is overflow:hidden), so
  // locking document.body does not stop the background from scrolling on
  // iOS — the scroll containers are locked instead, plus body as an
  // overscroll backstop. The drawer state comes from the two-tier layout
  // source (chamber layoutFacts when present, official frame attribute
  // otherwise) — the gateway-hosted official ui-layout has no layoutFacts.
  // The source is created ONCE per apply and shared with the Escape effect
  // (P1.5: no duplicated observers/matchMedia). ----
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

  // ---- Escape closes the open drawer (touch tier only — the PC-leak
  // invariant applies to JS too: a desktop browser must keep the official
  // behavior, where Escape closes the settings dialog, never the sidebar) ----
  ctx.effect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (!layoutSource.getNarrow()) return
      // A modal dialog (official settings opens inside the sidebar DOM, so
      // drawer + dialog coexist) owns Escape: closing the drawer underneath
      // an open modal would double-close on one keypress (the dialog's own
      // handler fires right after ours). Yield to the modal.
      const modalOpen = document.querySelector('[role="dialog"][aria-modal="true"]') !== null
      if (modalOpen) return
      if (!layoutSource.getCollapsed()) ctx.layout.toggleSidebar()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, 'dsh-chamber: mobile drawer escape close')

  // The shared layout source is released when the ctx dies.
  ctx.effect(() => () => layoutSource.dispose(), 'dsh-chamber: mobile layout source')

  // ---- composer + drawer behavior (touch tier only — the "PC leak" guard
  // applies to JS too: desktop must keep the official Enter=send convention
  // and its native click delivery). Installed/uninstalled dynamically as
  // the tier matches/unmatches. ----
  ctx.effect(() => {
    const touchTier = window.matchMedia(TOUCH_TIER_QUERY)
    let disposers: Array<() => void> = []
    const sync = (): void => {
      if (touchTier.matches) {
        if (disposers.length === 0) {
          const ladder = installImeLadder()
          disposers = [
            installEnterToNewline(),
            installEditabilityRecovery(),
            installKeyboardPinning(),
            installComposerSelfHeal(),
            // iOS suppresses the compatibility click for drawer taps (the
            // hover-reveal layout shift) — heal the lost activation so one
            // tap switches sessions (drawer-taps.ts).
            installDrawerTapHeal(() => touchTier.matches),
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
