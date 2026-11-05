/**
 * Chamber remote-browser client plugin (design 28, W0 skeleton): the
 * right-sidebar "浏览器" tab type and its launcher.
 *
 * Entry discipline (report v4 §2, review round-2 B1/I5):
 *  - `apply` EARLY-RETURNS unless the boot context is a dsh-kind source over
 *    SSH. The kind is derived from the source id (no `chamberTargetKind` boot
 *    fact is added); `local`, `gateway-*` and `http` never register anything.
 *  - The exported `inject` face deliberately does NOT name `sidebarRightTabs`.
 *    The required-service probe reads exported inject arrays, so naming it here
 *    would make every local/gateway source report a missing service for an entry
 *    that is intentionally absent. The registry is probed with
 *    `ctx.get('sidebarRightTabs')` AFTER the source gate; when it is absent the
 *    tab is honestly absent and one warning is logged.
 *  - No shortcut is registered (report v4: 无 shortcut). Clicking the guide
 *    entry is ui-sidebar-right's own `openTab(entry.kind)` path.
 *  - Registration shape mirrors the pinned official
 *    `ui-sidebar-browser` type: `register({ id, kind, multiple, title, guide })`
 *    plus the keyed `sidebar.right.pane.tab` / `...title` seats with
 *    `key === type id`, and a zh/en locale namespace. TODO(W0/pin): re-check
 *    every field and slot name against 0.2.2-rc.1 (see sidebar-tabs.ts).
 *
 * The panel itself never opens a page: a public URL goes through the existing
 * system-browser link leg, and a remote loopback target asks the trusted main
 * process (chamberForward / openInBrowser) to build and open the URL.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { en, zh, type BrowserKey, type BrowserTranslate } from '../locales.ts'
import {
  parseBrowserSourceFingerprint,
  resolveBrowserEntry,
} from '../shared/source.ts'
import {
  asBrowserForwardBridge,
  type BrowserForwardBridge,
} from '../shared/forward-bridge.ts'
import {
  asSidebarRightTabs,
  type SidebarRightTabDefinition,
} from './sidebar-tabs.ts'
import { BrowserPanel, type BrowserPanelInjected } from './BrowserPanel.tsx'
import { BrowserTitle, type BrowserTitleInjected } from './BrowserTitle.tsx'

export type { BrowserPanelInjected } from './BrowserPanel.tsx'
export type { BrowserTitleInjected } from './BrowserTitle.tsx'
export type { BrowserSource } from '../shared/source.ts'
export type { BrowserKey } from '../locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'dsh-chamber.sidebar.browser': BrowserKey
  }
}

/** Tab-type registry identity (the definition id, the slot registration key, the fiber name). */
const TAB_ID = '@dsh-chamber/remote-browser'
/** The tab kind the sidebar opens; distinct from the official 'browser' kind. */
const TAB_KIND = 'chamber-remote-browser'
/** Locale namespace owned by this plugin. */
const NS = 'dsh-chamber.sidebar.browser'
const PANE_SLOT = 'sidebar.right.pane.tab' as const
const TITLE_SLOT = 'sidebar.right.pane.tab.title' as const

/**
 * Required services. `sidebarRightTabs` is intentionally absent: see the file
 * header. The audit that requires deferred-only services must keep seeing only
 * the official sidebar-right row name it.
 */
export const inject = ['slots', 'locale']

/**
 * Register the Browser tab type, its guide entry, body, title and dictionaries
 * — but only for a dsh-kind SSH source.
 *
 * @param ctx - the per-source client context (carries chamberInstanceId /
 *   chamberTransport / chamberSourceFingerprint).
 */
export function apply(ctx: ClientContext): void {
  // 1. Source gate BEFORE any registration or locale write: a non-ssh or
  //    gateway/local source must leave no visible or diagnostic trace.
  const source = resolveBrowserEntry(
    (ctx as { chamberInstanceId?: string }).chamberInstanceId,
    (ctx as { chamberTransport?: 'local' | 'ssh' | 'http' }).chamberTransport,
  )
  if (source === null) return

  const sourceFingerprint = parseBrowserSourceFingerprint(
    source,
    (ctx as { chamberSourceFingerprint?: string }).chamberSourceFingerprint,
  )
  if (sourceFingerprint === null) {
    console.warn('[chamber-browser] dsh+ssh source has no valid boot fingerprint; the Browser tab stays absent')
    return
  }

  // 2. Probe the right-sidebar tab registry without naming it in `inject`.
  //    ctx.get() returns undefined when no active provider exists (it never
  //    throws), so a graph without the sidebar-right row is an honest absence.
  const sidebarTabs = asSidebarRightTabs(ctx.get('sidebarRightTabs'))
  if (sidebarTabs === null) {
    console.warn('[chamber-browser] sidebarRightTabs is not provided by this frontend; the Browser tab stays absent')
    return
  }

  // 3. Copy, then the tab type, then the keyed seats.
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-chamber: remote browser dictionaries')
  const t = ctx.locale.bind(NS) as BrowserTranslate

  const definition: SidebarRightTabDefinition = {
    id: TAB_ID,
    kind: TAB_KIND,
    // One launcher per session is enough: the forward list is per SOURCE, and a
    // second tab would only duplicate the same rows.
    multiple: false,
    title: () => t('title'),
    guide: [
      {
        id: 'open',
        // After the official entries (browser 30 / terminal ...) and before the tail.
        order: 40,
        title: () => t('guide.title'),
        description: () => t('guide.description'),
      },
    ],
  }
  ctx.effect(() => sidebarTabs.register(definition), 'dsh-chamber: remote browser tab type')

  const bridge = probeForwardBridge(ctx)
  const panelInjected = (): BrowserPanelInjected => ({ t, source, sourceFingerprint, bridge })
  // Keyed by the TYPE ID (not the kind): ui-sidebar-right dispatches the body and
  // title through entryKey = definition.id, so the two must be byte-identical.
  ctx.effect(() => ctx.slots.inject(PANE_SLOT, () => ctx.slots.register({
    name: PANE_SLOT,
    key: TAB_ID,
    locale: NS,
    inject: panelInjected,
  }, BrowserPanel)), 'dsh-chamber: remote browser pane')

  ctx.effect(() => ctx.slots.inject(TITLE_SLOT, () => ctx.slots.register({
    name: TITLE_SLOT,
    key: TAB_ID,
    locale: NS,
    inject: (): BrowserTitleInjected => ({ t }),
  }, BrowserTitle)), 'dsh-chamber: remote browser title')
}

/**
 * Resolve the forward bridge.
 *
 * The renderer adapter installs the trusted `chamberForward` service before
 * deferred rows mount. Probe the ctx service (direct property + ctx.get) and
 * then the document-global fallback; both are validated structurally so a
 * partial object disables the remote section instead of throwing at render.
 */
function probeForwardBridge(ctx: ClientContext): BrowserForwardBridge | null {
  // Direct property first (Cordis service proxy); ctx.get() is the same lookup
  // through the public service API, which is also what a context inherited from
  // the composite root exposes. The document-global fallback stays last so a
  // future carrier can supply it without changing this plugin.
  const fromCtx = asBrowserForwardBridge((ctx as { chamberForward?: unknown }).chamberForward)
    ?? asBrowserForwardBridge(ctx.get('chamberForward'))
  if (fromCtx !== null) return fromCtx
  return asBrowserForwardBridge((globalThis as typeof globalThis & { chamberForward?: unknown }).chamberForward)
}
