/**
 * Chamber mobile adaptation plugin, browser half (design 17 §18): adapts the
 * OFFICIAL dsh web shell to touch/narrow viewports. Zero code copied from
 * community plugins — the mechanisms (attribute stamping, enter-to-newline,
 * editability recovery, layout-source-driven drawer) are re-implemented
 * against the empirical 0.1.2-alpha.3 DOM on the chamber base:
 *  - panel state comes from the two-tier layout source (layout-facts.ts):
 *    the chamber layout fork's `layoutFacts` service when present, the
 *    official `data-sidebar-collapsed` attribute observation otherwise —
 *    the gateway-hosted instance runs the OFFICIAL ui-layout (design 17
 *    §18.4 项 3 deployment-matrix exception);
 *  - frame stamping is per instance root (`[data-slot="root"]`),
 *    idempotent and remount-safe (项 2); the behavior effects are
 *    document-level single-instance BY DESIGN (the gateway deployment is
 *    single-shell; a future multi-shell renderer mount must scope them);
 *  - the mobile tier activates on `(max-width:1023px) and (pointer:coarse)`
 *    (项 5) — the CSS is fully media-query scoped, desktop untouched.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { en, zh, type MobileKey } from './locales.ts'
import { MOBILE_CSS, PLUGIN_STYLE_TAG, VIEWPORT_TOKENS } from './styles.ts'
import { stampFrame } from './markup.ts'
import { createLayoutFactSource } from './layout-facts.ts'
import {
  installComposerSelfHeal, installEditabilityRecovery, installEnterToNewline,
  installImeLadder, installKeyboardPinning, TOUCH_TIER_QUERY,
} from './composer.ts'
import { MobileNavToggle, type MobileNavToggleInjected } from './MobileNavToggle.tsx'

export type { MobileNavToggleInjected } from './MobileNavToggle.tsx'
export type { MobileKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'dsh-chamber.mobile': MobileKey
  }
}

const NS = 'dsh-chamber.mobile'
const ROOT_SLOT_SELECTOR = '[data-slot="root"]'

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

    const meta = document.querySelector('meta[name="viewport"]')
    if (meta instanceof HTMLMetaElement) {
      const content = meta.content
      const missing = VIEWPORT_TOKENS.filter(token => !content.includes(token))
      if (missing.length > 0) meta.content = [content, ...missing].filter(Boolean).join(', ')
    } else {
      const created = document.createElement('meta')
      created.name = 'viewport'
      created.content = `width=device-width, initial-scale=1, ${VIEWPORT_TOKENS.join(', ')}`
      document.head.appendChild(created)
      disposers.push(() => created.remove())
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
  // content mutations (P2-4): only childList changes whose target IS a
  // root slot / frame / column candidate can affect the stamping — chat
  // streaming and typing commit thousands of deep childList batches.
  ctx.effect(() => {
    const stamped = new WeakSet<object>()
    const stamp = (): void => {
      for (const root of document.querySelectorAll(ROOT_SLOT_SELECTOR)) {
        const frame = stampFrame(root)
        if (frame !== null && !stamped.has(frame)) stamped.add(frame)
      }
    }
    const isStructuralTarget = (target: Node): boolean =>
      target instanceof Element
      && (target.matches(ROOT_SLOT_SELECTOR)
        || target.matches('[data-mobile-frame]')
        || target.matches('[data-mobile-role]')
        || target.parentElement?.matches(ROOT_SLOT_SELECTOR) === true
        // A column container newly mounted directly under the stamped
        // frame (e.g. the details column appearing with a session) — the
        // frame is already stamped, so it alone would not retrigger.
        || target.parentElement?.matches('[data-mobile-frame]') === true)
    const onMutations = (mutations: MutationRecord[]): void => {
      if (mutations.some(mutation => mutation.type === 'childList'
        && Array.from(mutation.addedNodes).some(node => isStructuralTarget(node)))) {
        stamp()
      }
    }
    stamp()
    const observer = new MutationObserver(onMutations)
    observer.observe(document.body, { childList: true, subtree: true })
    return () => observer.disconnect()
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
      if (!layoutSource.getCollapsed()) ctx.layout.toggleSidebar()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, 'dsh-chamber: mobile drawer escape close')

  // The shared layout source is released when the ctx dies.
  ctx.effect(() => () => layoutSource.dispose(), 'dsh-chamber: mobile layout source')

  // ---- composer behavior (touch tier only — the "PC leak" guard applies
  // to JS too: desktop must keep the official Enter=send convention).
  // Installed/uninstalled dynamically as the tier matches/unmatches. ----
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
