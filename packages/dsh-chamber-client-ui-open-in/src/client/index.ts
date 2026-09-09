/**
 * Chamber open-in client plugin (design 16 + open-in extension + Batch 3
 * Phase 2 unification): ONE header utility entry that opens the current
 * session's workspace in an installed app, over the per-source view-model —
 * the instance's own host catalog for LOCAL sources (absorbed official
 * channel) and the desktop main-process provider (VS Code, and the remote
 * deeplink carrier for SSH targets).
 *
 * Registered into the OFFICIAL conversation header utilities slot
 * (`conversation.session.header.utilities`, the same right-aligned row as the
 * vendor "Session log" action) — placement fix 2026-08: the original
 * `shell.overlay` top-right anchor was measured to overlap that row (details
 * column closed ⇒ the center column reaches the frame edge), so the button
 * now lays out inline beside the vendor utilities instead of floating on the
 * frame layer. The slot is session-scoped, so the component receives the
 * per-header `sessionId` and the framework's global `useWorkspaces` hook —
 * no direct ctx store access (inject face stays `['slots', 'locale']`).
 *
 * Per-entry facts ride this ctx (`chamberInstanceId`, `chamberBasePath`,
 * `chamberSourceFingerprint`, `chamberTransport`, all provided by
 * chamber-entry/shell.ts): the source id and transport decide the matrix, the
 * base path scopes the official host-catalog requests to this instance's
 * proxy prefix, and the fingerprint is the exact-boot proof the trusted main
 * process verifies before a launch.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only import activates the locale service's Context merge.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { OpenInButton, type OpenInInjected } from './OpenInButton.tsx'
import { createOfficialCatalog } from './official-catalog.ts'
import { getOpenInChoice, setOpenInChoice, subscribeOpenInChoice } from './choice-store.ts'
import { en, zh, type OpenInKey } from '../locales.ts'
import {
  buildOpenInLaunchRequest,
  describeOpenInError,
  parseOpenInResult,
  parseOpenInSource,
  parseOpenInSourceFingerprint,
  type OpenInApp,
  type OpenInResult,
} from '../shared/capabilities.ts'
import {
  bridgePlatform,
  getOpenInApps,
  refreshApps,
  subscribeOpenIn,
  type OpenInBridgeSurface,
  type Translate,
} from '../shared/coordinator.ts'
import {
  buildOpenInViewModel,
  type OpenInViewEntry,
  type OpenInViewModel,
} from '../shared/open-in-view-model.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'dsh-chamber.open-in': OpenInKey
  }
}

/** The official conversation header utilities slot (beside "Session log"). */
export const OPEN_IN_HEADER_SLOT = 'conversation.session.header.utilities' as const
const NS = 'dsh-chamber.open-in'

export const inject = ['slots', 'locale']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-chamber: open-in dictionaries')

  // Per-boot instance id provided by chamber-entry; loose cast (the sidebar
  // plugin uses the same `as any` seam — the vendor cordis face stays loose).
  // Bail on an absent id (frontend-review P2-4): without it the gate-2 local
  // check would let a bogus '' source render a button that can only fail.
  const source = parseOpenInSource(
    (ctx as { chamberInstanceId?: string }).chamberInstanceId,
    (ctx as { chamberTransport?: 'local' | 'ssh' | 'http' }).chamberTransport,
  )
  if (source === null) return
  const sourceFingerprint = parseOpenInSourceFingerprint(
    source,
    (ctx as { chamberSourceFingerprint?: string }).chamberSourceFingerprint,
  )
  if (sourceFingerprint === null) return

  const t = ctx.locale.bind(NS) as Translate

  // Per-ctx official channel (Batch 3 Phase 2): only a LOCAL source has the
  // instance's own host half; its routes are reached through THIS entry's
  // proxy prefix, so the catalog is per-ctx, never page-global.
  const basePath = (ctx as { chamberBasePath?: string }).chamberBasePath
  const catalog = source.local && typeof basePath === 'string'
    ? createOfficialCatalog({ basePath })
    : null

  let official: OpenInApp[] | null = null
  let officialProbe: Promise<void> | null = null
  const listeners = new Set<() => void>()
  const emit = (): void => {
    for (const listener of [...listeners]) listener()
  }
  const loadOfficial = (): Promise<void> => {
    if (catalog === null) return Promise.resolve()
    officialProbe ??= catalog.load().then((entries) => {
      official = entries
      emit()
    })
    return officialProbe
  }
  /** Re-probe both pools: the page-wide main provider and this ctx's catalog. */
  const refresh = async (): Promise<void> => {
    officialProbe = null
    await Promise.all([refreshApps(), loadOfficial()])
  }
  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }

  // Initial probe + change subscriptions. The main pool is page-wide (the
  // coordinator's single-flight probe); the catalog is this ctx's own.
  void refresh()
  const unsubscribeMain = subscribeOpenIn(emit)
  const unsubscribeChoice = subscribeOpenInChoice(emit)
  ctx.effect(() => () => {
    unsubscribeMain()
    unsubscribeChoice()
  }, 'dsh-chamber: open-in subscriptions')

  const getViewModel = (): OpenInViewModel => buildOpenInViewModel({
    source,
    official,
    main: getOpenInApps(),
  })

  /**
   * Launch one view-model entry through its channel: official entries POST to
   * the instance's own host route (the instance, not the control plane,
   * performs the launch); main entries ride the trusted preload IPC with the
   * exact boot-bound source proof. Never throws — the button renders the
   * error dress from the result.
   */
  const launch = async (entry: OpenInViewEntry, path: string): Promise<OpenInResult> => {
    if (entry.channel === 'official') {
      if (catalog === null) return { ok: false, error: 'official catalog unavailable' }
      try {
        await catalog.launch(entry.id, path)
        return { ok: true }
      } catch (error) {
        return { ok: false, error: describeOpenInError(error) }
      }
    }
    const bridge = (window as unknown as OpenInBridgeSurface).dshChamber?.openIn
    if (bridge === undefined) return { ok: false, error: t('bridgeUnavailable') }
    const request = buildOpenInLaunchRequest(entry.id, source, path, sourceFingerprint)
    try {
      const raw = await bridge.open(request.appId, request.instanceId, request.path, request.sourceFingerprint)
      const result = parseOpenInResult(raw)
      return result ?? { ok: false, error: t('invalidResponse') }
    } catch (error) {
      return { ok: false, error: describeOpenInError(error) }
    }
  }

  // The slot inject factory closes over ctx (same pattern as the vendor
  // session-log entry): it hands the component this ctx's source id, the
  // bound translator and the per-ctx model/launch faces; the per-header
  // session id and the workspace rows come from the framework standard kit
  // (see OpenInButton props).
  const injected = (): OpenInInjected => ({
    source,
    sourceFingerprint,
    t,
    getViewModel,
    subscribe,
    refresh,
    launch,
    getChoice: getOpenInChoice,
    choose: setOpenInChoice,
    iconUrl: appId => catalog?.iconUrl(appId) ?? null,
    platform: bridgePlatform(),
  })

  ctx.slots.inject(OPEN_IN_HEADER_SLOT, () => ctx.slots.register({
    name: OPEN_IN_HEADER_SLOT,
    id: 'open-in',
    // Row order is ascending by `order` (default 0): -1 keeps the vendor
    // "Session log" entry (order 0) pinned at the row's far RIGHT and places
    // this button to its left (2026-08 user requirement).
    order: -1,
    // Neutral entry label (slot registrant diagnostics — the user-facing
    // tooltip/aria-label comes from the component per app, see OpenInButton).
    label: () => t('titleOpen'),
    inject: injected,
  }, OpenInButton))
}
