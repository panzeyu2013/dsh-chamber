/**
 * Register the HTTP(S) Browser tab type in the right Sidebar.
 *
 * FORK SURFACE (the chamber deviations from upstream
 * `@deepseek-ai/dsh-client-ui-sidebar-browser`, 0.2.2-rc.1; the sole behavior
 * difference is the SSH reverse proxy below):
 *   1. apply() keeps the chamber source gate: only the local instance and
 *      SSH-reached dsh/gateway sources register the tab (plain-http sources have
 *      no tunnel and must stay absent), and the boot-bound source fingerprint is
 *      required for the forward leg;
 *   2. the readiness wait (registry-wait.ts) keeps the deferred-chunk ordering
 *      fix: the right-sidebar services may apply after this page-cached chunk;
 *   3. the iframe page factory wraps the upstream `createIframePage` with the
 *      per-tab `ForwardFrameResolver` (logical target → main-composed frameUrl
 *      for a remote 127.0.0.1 target; local/direct otherwise).
 * Everything else — the tab type, shortcut, store, keyed body/title seats and
 * the 8-locale registration — is upstream verbatim. The official Electron
 * webview carrier is intentionally not forked (the chamber shell has no such
 * bridge; both flavors use the iframe path, design 28 §16.8).
 */
import type { ShortcutCommandId } from '@deepseek-ai/dsh-client-shortcuts/client'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import { BrowserBody, type BrowserBodyProps } from './view/BrowserBody.tsx'
import { BrowserTitle } from './view/BrowserTitle.tsx'
import { createBrowserControllers } from './browser/BrowserController.ts'
import type { BrowserInjected } from './browser/BrowserController.ts'
import { createIframePage } from './pages.ts'
import type { BrowserPageFactory } from './browser/BrowserPage.ts'
import { BROWSER_ID, browserDefinition } from './definition.tsx'
import { en, ja, es, fr, de, ru, pt, zh } from './locales.ts'
import { createBrowserStore } from './browser/store.ts'
import { asBrowserForwardBridge, type BrowserForwardBridge } from '../shared/forward-bridge.ts'
import {
  parseBrowserSourceFingerprint,
  resolveBrowserEntry,
  type BrowserSource,
} from '../shared/source.ts'
import { createForwardFrameResolver } from './browser/ForwardFrameResolver.ts'
import { waitForSidebarHost } from './registry-wait.ts'

export type { BrowserBodyProps } from './view/BrowserBody.tsx'
export type { BrowserControllerState, BrowserInjected, BrowserMountRequest } from './browser/BrowserController.ts'
export type { BrowserFrame, BrowserFrameState, BrowserLoadError, BrowserSandboxControl } from './browser/BrowserFrame.ts'
export type { BrowserPage, BrowserPageFactory, BrowserPageOptions } from './browser/BrowserPage.ts'
export type { BrowserPresentation } from './view/BrowserPresentation.ts'
export type { BrowserFailure, BrowserHistoryEntry, BrowserNavigationStatus, BrowserTabState } from './browser/BrowserPersistence.ts'
export type { SidebarBrowserKey } from './locales.ts'
export type { BrowserState } from './browser/store.ts'
export type { BrowserAddressFailure, BrowserAddressResult, BrowserTarget } from './browser/url.ts'

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightTabParamsMap {
    /** Optional initial Browser URL. */
    browser: { readonly url?: string }
  }
}

/**
 * Required Browser services. `sidebarRight` / `sidebarRightTabs` are awaited
 * through `ctx.inject` inside apply instead: a plain-http source must not
 * report a missing service for a tab it intentionally never registers.
 */
export const inject = ['slots', 'locale']

/** The locale namespace this fork registers (upstream value, verbatim). */
const NAMESPACE = 'sidebarBrowser'

/** Bound translate face of this plugin's `sidebarBrowser` namespace. */
type BrowserTranslate = (key: string, params?: Record<string, unknown>) => string

/** Register the Browser type, localized guide entry, body, and title. */
export function apply(ctx: Context): void {
  // FORK DIFF 1: chamber source gate BEFORE any registration/locale/copy write.
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

  const t = ctx.locale.bind(NAMESPACE) as BrowserTranslate
  ctx.effect(() => ctx.locale.register(NAMESPACE, { zh, en, ja, es, fr, de, ru, pt }), 'ui-sidebar-browser.copy')

  // FORK DIFF 2: the right-sidebar services are host-graph rows that may apply
  // after this page-cached deferred chunk (the missing-Browser-button race).
  waitForSidebarHost(ctx, (host) => { install(host, t, source, sourceFingerprint) })
}

/**
 * The upstream registration body, run on the context where the right-sidebar
 * services are available.
 *
 * @param ctx - context where `sidebarRight` / `sidebarRightTabs` exist.
 * @param t - bound dictionary for the `sidebarBrowser` namespace.
 * @param source - the parsed boot source (gates the iframe page factory).
 * @param sourceFingerprint - immutable boot proof the forward leg carries.
 */
function install(
  ctx: Context,
  t: BrowserTranslate,
  source: BrowserSource,
  sourceFingerprint: string,
): void {
  const bridge = probeForwardBridge(ctx)
  // Upstream verbatim: the `browser.new` command, its regions and its resolve.
  ctx.inject(['shortcuts'], (ctx: Context) => {
    ctx.effect(() => ctx.shortcuts.register({
      id: 'browser.new' as ShortcutCommandId, label: () => t('guide.title'), aliases: ['browser', 'new browser tab'],
      defaults: {
        'desktop:macos': { code: 'KeyT', modifiers: ['primary'] },
        'desktop:windows': { code: 'KeyT', modifiers: ['primary'] },
        'desktop:linux': { code: 'KeyT', modifiers: ['primary'] },
        'web:macos': { code: 'KeyT', modifiers: ['primary', 'alt'] },
        'web:windows': { code: 'KeyT', modifiers: ['primary', 'alt'] },
      },
      // Each tab plugin owns its command's availability, localized refusal, and tab kind.
      /* jscpd:ignore-start */
      regions: ['page', 'editable', 'terminal'], modals: [],
      resolve: ({ target: element }: { target: Element }) => {
        const target = ctx.sidebarRight.commandTarget(element)
        if (target === undefined) return { status: 'blocked', reason: t('shortcut.noSession') }
        return { status: 'handled', run: () => { ctx.sidebarRight.openTabFromTarget('browser', target) } }
      },
      /* jscpd:ignore-end */
    }), 'ui-sidebar-browser: shortcut')
  })
  const store = createBrowserStore()
  const openTabs = ctx.sidebarRight.openTabs
  // Upstream registration; keepMounted is always true for the chamber iframe
  // (upstream sets it only when its Electron webview carrier exists; the
  // chamber decision keeps the visited body mounted on both flavors).
  ctx.effect(() => ctx.sidebarRightTabs.register({ ...browserDefinition(t), keepMounted: true }), 'ui-sidebar-browser.type')
  const installFrames = (scope: Context): void => {
    const controllers = new Map<BrowserBodyProps['sessionId'], BrowserInjected>()
    scope.effect(() => async () => {
      const pending = [...controllers.values()].map((controller: BrowserInjected) => controller.dispose())
      controllers.clear()
      await Promise.all(pending)
    }, 'ui-sidebar-browser.frames')
    // FORK DIFF 3: the upstream iframe factory, with the per-tab forward resolver.
    const pageFactory = (): BrowserPageFactory => (options) => createIframePage(
      options,
      createForwardFrameResolver({ source, sourceFingerprint, bridge }),
    )
    scope.effect(() => scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
      name: 'sidebar.right.pane.tab', key: BROWSER_ID, locale: NAMESPACE, store,
      inject: (sessionId: BrowserBodyProps['sessionId'], actions: unknown) => {
        const existing = controllers.get(sessionId)
        if (existing !== undefined) {
          existing.rebind(actions as never)
          return existing
        }
        const controller = createBrowserControllers(actions as never, pageFactory(), tabId =>
          openTabs.getSnapshot().some((tab: { sessionId: string; tabId: string }) =>
            tab.sessionId === sessionId && tab.tabId === tabId))
        controllers.set(sessionId, controller)
        return controller
      },
    }, BrowserBody)), 'ui-sidebar-browser.body')
  }
  installFrames(ctx)
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab.title', key: BROWSER_ID, store,
  }, BrowserTitle)), 'ui-sidebar-browser.title')
}

/**
 * Probes the trusted forward bridge for the SSH reverse-proxy diff.
 *
 * The renderer adapter installs the `chamberForward` service before deferred
 * rows mount; the document-global fallback stays last so a future carrier can
 * supply it without changing this plugin. A page without the carrier leaves the
 * resolver direct-only (a remote 127.0.0.1 target then shows the upstream
 * failure bar instead of a fake page).
 */
function probeForwardBridge(ctx: Context): BrowserForwardBridge | null {
  const fromCtx = asBrowserForwardBridge((ctx as { chamberForward?: unknown }).chamberForward)
    ?? asBrowserForwardBridge(ctx.get('chamberForward'))
  if (fromCtx !== null) return fromCtx
  return asBrowserForwardBridge((globalThis as typeof globalThis & { chamberForward?: unknown }).chamberForward)
}
