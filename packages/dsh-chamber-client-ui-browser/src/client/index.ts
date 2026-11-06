/**
 * Chamber remote-browser client plugin (design 28, W0 skeleton): the
 * right-sidebar "浏览器" tab type and its launcher.
 *
 * Entry discipline (report v4 §2, review round-2 B1/I5, widened gate):
 *  - `apply` EARLY-RETURNS only for a plain-HTTP source. The local instance and
 *    every SSH-reached source (dsh or gateway) register the tab; the kind is
 *    derived from the source id (no `chamberTargetKind` boot fact is added).
 *    A source without an SSH tunnel has no forward leg — the launcher hides the
 *    remote section instead of refusing every address.
 *  - The exported `inject` face deliberately does NOT name `sidebarRightTabs`.
 *    The required-service probe reads exported inject arrays, so naming it here
 *    would make an http source report a missing service for an entry that is
 *    intentionally absent. `apply` instead arms the registry wait
 *    (registry-wait.ts) AFTER the source gate, so the type registers whenever that
 *    host-graph row appears — later than this deferred chunk on every boot but the
 *    page's FIRST (see installBrowserType). An absent registry stays an honest
 *    absence, named once after a short grace.
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
  type BrowserSource,
} from '../shared/source.ts'
import {
  asBrowserForwardBridge,
  type BrowserForwardBridge,
} from '../shared/forward-bridge.ts'
import {
  asSidebarRightTabs,
  type SidebarRightTabDefinition,
} from './sidebar-tabs.ts'
import { waitForSidebarTabs } from './registry-wait.ts'
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
 * — for the local instance and every SSH source (http sources never apply).
 *
 * The locale dictionaries land in apply itself (independent of the right
 * sidebar); the registry-dependent half runs from installBrowserType once the
 * tab-type registry exists.
 *
 * @param ctx - the per-source client context (carries chamberInstanceId /
 *   chamberTransport / chamberSourceFingerprint).
 */
export function apply(ctx: ClientContext): void {
  // 1. Source gate BEFORE any registration or locale write: an http source (or
  //    a malformed boot fact) must leave no visible or diagnostic trace.
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
    console.warn('[chamber-browser] ' + source.sourceId + ' has no valid boot fingerprint; the Browser tab stays absent')
    return
  }

  // 2. Copy first: it needs no registry, and both keyed seats resolve their
  //    labels through this namespace.
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-chamber: remote browser dictionaries')
  const t = ctx.locale.bind(NS) as BrowserTranslate

  // 3. Everything that needs the tab-type registry waits for it (registry-wait.ts
  //    owns the race rationale and the never-arrived diagnostic). The exported
  //    inject face stays ['slots', 'locale']: sidebarRightTabs is a host-graph
  //    service this package can legitimately live without (an http source never
  //    reads it), so it must not enter the required-service roster.
  waitForSidebarTabs(ctx, (host) => {
    installBrowserType(host, t, source, sourceFingerprint)
  })
}

/**
 * Register the tab type, its guide entry and both keyed seats on the context
 * where the registry appeared.
 *
 * Only registry-wait.ts calls this, after the injected fiber fired: the wait and
 * its race rationale live there (a one-shot probe loses on every source but the
 * page's first boot). This function owns the definition, the shape check and the
 * three keyed registrations.
 *
 * @param host - the context in which the registry appeared.
 * @param t - the bound dictionary for this plugin namespace.
 * @param source - the parsed boot source.
 * @param sourceFingerprint - the immutable boot proof every forward call carries.
 */
function installBrowserType(
  host: ClientContext,
  t: BrowserTranslate,
  source: BrowserSource,
  sourceFingerprint: string,
): void {
  const raw = host.get('sidebarRightTabs')
  const sidebarTabs = asSidebarRightTabs(raw)
  if (sidebarTabs === null) {
    // Undefined means the provider withdrew between the wait and this call — an
    // honest absence; a present but unreadable shape is wiring drift worth naming.
    if (raw !== undefined) {
      console.warn('[chamber-browser] sidebarRightTabs has an unexpected shape; the Browser tab stays absent')
    }
    return
  }

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
  host.effect(() => sidebarTabs.register(definition), 'dsh-chamber: remote browser tab type')

  const bridge = probeForwardBridge(host)
  const panelInjected = (): BrowserPanelInjected => ({ t, source, sourceFingerprint, bridge })
  // Keyed by the TYPE ID (not the kind): ui-sidebar-right dispatches the body and
  // title through entryKey = definition.id, so the two must be byte-identical.
  host.effect(() => host.slots.inject(PANE_SLOT, () => host.slots.register({
    name: PANE_SLOT,
    key: TAB_ID,
    locale: NS,
    inject: panelInjected,
  }, BrowserPanel)), 'dsh-chamber: remote browser pane')

  host.effect(() => host.slots.inject(TITLE_SLOT, () => host.slots.register({
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