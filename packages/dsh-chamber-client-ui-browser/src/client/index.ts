/**
 * Register the HTTP(S) Browser tab type in the right Sidebar (design 28 v3).
 *
 * The carrier is the Swift shell's native guest: one child WKWebView per tab,
 * acquired through the Swift-only `browser` bridge and driven by
 * `NativeGuestImpl`. The iframe carrier is retired — a page without that bridge
 * registers NOTHING (fail-closed, no iframe fallback).
 *
 * FORK SURFACE (design 28 v3 / ADR-0004; upstream UI fidelity unchanged):
 *   1. apply() keeps the chamber source gate: only the local instance and
 *      SSH-reached dsh/gateway sources register the tab, and the boot-bound
 *      source fingerprint is required for the forward leg;
 *   2. the native carrier gate: no `browser` bridge → no tab;
 *   3. the readiness wait (registry-wait.ts) keeps the deferred-chunk ordering
 *      fix: the right-sidebar services may apply after this page-cached chunk;
 *   4. the page factory composes the per-tab `ForwardFrameResolver` (logical
 *      target → forward recordRef for a remote loopback target; direct URL
 *      otherwise).
 * Everything else — the tab type, shortcut, store, keyed body/title seats and
 * the 8-locale registration — is upstream verbatim.
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
import { createNativeGuestPage } from './pages.ts'
import type { BrowserPageFactory } from './browser/BrowserPage.ts'
import { BROWSER_ID, browserDefinition } from './definition.tsx'
import { en, ja, es, fr, de, ru, pt, zh } from './locales.ts'
import { createBrowserStore } from './browser/store.ts'
import { asBrowserBridge, type BrowserBridge } from './browser/BrowserBridge.ts'
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
export type { BrowserFrame, BrowserFrameState, BrowserLoadError } from './browser/BrowserFrame.ts'
export type { BrowserPage, BrowserPageFactory, BrowserPageOptions } from './browser/BrowserPage.ts'
export type { BrowserPresentation } from './view/BrowserPresentation.ts'
export type { BrowserFailure, BrowserHistoryEntry, BrowserNavigationStatus, BrowserTabState } from './browser/BrowserPersistence.ts'
export type { SidebarBrowserKey } from './locales.ts'
export type { BrowserState } from './browser/store.ts'
export type { BrowserAddressFailure, BrowserAddressResult, BrowserTarget } from './browser/url.ts'
export type { BrowserBridge, BrowserGuestFrame, BrowserGuestState, BrowserGuestTarget, NativeGuestCarrier } from './browser/BrowserBridge.ts'
import type { NativeGuestCarrier } from './browser/BrowserBridge.ts'
export type { BrowserTargetRef, BrowserTargetRefResolver } from './browser/ForwardFrameResolver.ts'

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
  // FORK DIFF 2: native carrier gate (fail-closed; the iframe carrier is retired).
  const carrier = probeBrowserBridge(ctx)
  if (carrier === null) {
    console.warn('[chamber-browser] ' + source.sourceId + ' has no browser guest bridge; the Browser tab stays absent')
    return
  }

  const t = ctx.locale.bind(NAMESPACE) as BrowserTranslate
  ctx.effect(() => ctx.locale.register(NAMESPACE, { zh, en, ja, es, fr, de, ru, pt }), 'ui-sidebar-browser.copy')

  // FORK DIFF 3: the right-sidebar services are host-graph rows that may apply
  // after this page-cached deferred chunk (the missing-Browser-button race).
  waitForSidebarHost(ctx, (host) => { install(host, t, source, sourceFingerprint, carrier) })
}

/**
 * The upstream registration body, run on the context where the right-sidebar
 * services are available.
 *
 * @param ctx - context where `sidebarRight` / `sidebarRightTabs` exist.
 * @param t - bound dictionary for the `sidebarBrowser` namespace.
 * @param source - the parsed boot source (gates the forward leg).
 * @param sourceFingerprint - immutable boot proof the forward leg carries.
 * @param bridge - the native guest carrier (probed before registration).
 */
function install(
  ctx: Context,
  t: BrowserTranslate,
  source: BrowserSource,
  sourceFingerprint: string,
  bridge: BrowserBridge,
): void {
  const forward = probeForwardBridge(ctx)
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
  // Upstream registration; keepMounted is always true for the native guest
  // (switching tabs / sessions / collapsing the sidebar must not destroy it).
  ctx.effect(() => ctx.sidebarRightTabs.register({ ...browserDefinition(t), keepMounted: true }), 'ui-sidebar-browser.type')
  const installFrames = (scope: Context): void => {
    const controllers = new Map<BrowserBodyProps['sessionId'], BrowserInjected>()
    scope.effect(() => async () => {
      const pending = [...controllers.values()].map((controller: BrowserInjected) => controller.dispose())
      controllers.clear()
      await Promise.all(pending)
    }, 'ui-sidebar-browser.frames')
    // FORK DIFF 4: the native guest carrier identity, with the per-tab resolver.
    const carrierFor = (sessionId: string): NativeGuestCarrier => ({
      bridge,
      sessionId,
      sourceId: source.sourceId,
      sourceFingerprint,
      // Fallback partition key when the ctx has no Workspace list.
      workspaceKey: sessionId,
      // Design 28 §4.4: the partition key is the session's workspace CWD, read
      // from the per-entry Workspace controller (host-authoritative list).
      resolveWorkspaceKey: workspaceKeyResolver(scope, sessionId),
    })
    const pageFactory: BrowserPageFactory = (options) => createNativeGuestPage(
      options,
      options.carrier,
      createForwardFrameResolver({ source, sourceFingerprint, bridge: forward }),
    )
    scope.effect(() => scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
      name: 'sidebar.right.pane.tab', key: BROWSER_ID, locale: NAMESPACE, store,
      inject: (sessionId: BrowserBodyProps['sessionId'], actions: unknown) => {
        const existing = controllers.get(sessionId)
        if (existing !== undefined) {
          existing.rebind(actions as never)
          return existing
        }
        const controller = createBrowserControllers(actions as never, pageFactory, tabId =>
          openTabs.getSnapshot().some((tab: { sessionId: string; tabId: string }) =>
            tab.sessionId === sessionId && tab.tabId === tabId), carrierFor(sessionId))
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
 * Probe the trusted native guest bridge.
 *
 * The renderer adapter installs `chamberBrowser` before deferred rows mount; the
 * page-global fallback (`window.dshChamber.browser`, owned by the Swift shim)
 * stays last so the carrier works before that adapter wiring lands. A page
 * without the bridge registers no row (fail-closed).
 */
/**
 * Build the authoritative workspace-partition reader (design 28 §4.4).
 *
 * The per-entry ctx carries the Workspace controller (`ctx.workspaces.list`); the
 * key is the CWD of the workspace that owns this Session. Readiness is bounded: a
 * list that never reaches `ready` falls back to the static key, never hangs the
 * guest acquire.
 *
 * @param ctx - context where the Workspace controller may be provided.
 * @param sessionId - owning Session.
 * @returns a resolver, or undefined when this entry has no Workspace list.
 */
function workspaceKeyResolver(ctx: Context, sessionId: string): (() => Promise<string>) | undefined {
  let owner: unknown
  try { owner = ctx.get('workspaces') } catch { owner = undefined }
  if (typeof owner !== 'object' || owner === null) return undefined
  const list = (owner as { list?: unknown }).list
  if (typeof list !== 'object' || list === null) return undefined
  const read = (list as { getSnapshot?: () => unknown }).getSnapshot
  const subscribe = (list as { subscribe?: (listener: () => void) => () => void }).subscribe
  if (typeof read !== 'function') return undefined
  return () => new Promise<string>((resolve) => {
    const snapshot = (): { phase?: unknown; items?: unknown } => {
      try { return (read.call(list) as { phase?: unknown; items?: unknown }) ?? {} } catch { return {} }
    }
    const pick = (): string | undefined => {
      const current = snapshot()
      if (!Array.isArray(current.items)) return undefined
      for (const item of current.items) {
        if (typeof item !== 'object' || item === null) continue
        const row = item as { sessionIds?: unknown; path?: unknown }
        if (Array.isArray(row.sessionIds) && row.sessionIds.includes(sessionId) && typeof row.path === 'string' && row.path !== '') return row.path
      }
      return undefined
    }
    const immediate = pick()
    if (immediate !== undefined || typeof subscribe !== 'function') { resolve(immediate ?? sessionId); return }
    let done = false
    let stop: (() => void) | undefined
    const finish = (value: string): void => {
      if (done) return
      done = true
      if (stop !== undefined) stop()
      resolve(value)
    }
    const off = subscribe.call(list, () => {
      const found = pick()
      if (found !== undefined) finish(found)
    })
    stop = typeof off === 'function' ? off : undefined
    // Bounded: the Workspace list is a boot fact; never block the lease on it.
    setTimeout(() => { finish(pick() ?? sessionId) }, 1500)
  })
}

function probeBrowserBridge(ctx: Context): BrowserBridge | null {
  const fromCtx = asBrowserBridge((ctx as { chamberBrowser?: unknown }).chamberBrowser)
    ?? asBrowserBridge(ctx.get('chamberBrowser'))
  if (fromCtx !== null) return fromCtx
  const global = (globalThis as { dshChamber?: { browser?: unknown } }).dshChamber
  try {
    return asBrowserBridge(global?.browser)
  } catch {
    return null
  }
}

/**
 * Probes the trusted forward bridge for the SSH reverse-proxy diff.
 *
 * The renderer adapter installs the `chamberForward` service before deferred
 * rows mount; the document-global fallback stays last. A page without the
 * carrier leaves the resolver direct-only (a remote loopback target then shows
 * the upstream failure bar instead of a fake page).
 */
function probeForwardBridge(ctx: Context): BrowserForwardBridge | null {
  const fromCtx = asBrowserForwardBridge((ctx as { chamberForward?: unknown }).chamberForward)
    ?? asBrowserForwardBridge(ctx.get('chamberForward'))
  if (fromCtx !== null) return fromCtx
  return asBrowserForwardBridge((globalThis as typeof globalThis & { chamberForward?: unknown }).chamberForward)
}
