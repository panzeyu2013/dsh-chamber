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
import { createOpenInSourceAdapter } from './source-adapter.ts'
import { getOpenInChoice, setOpenInChoice, subscribeOpenInChoice } from './choice-store.ts'
import { en, zh, type OpenInKey } from '../locales.ts'
import {
  parseOpenInSource,
  parseOpenInSourceFingerprint,
} from '../shared/capabilities.ts'
import {
  bridgePlatform,
  getOpenInApps,
  refreshApps,
  subscribeOpenIn,
  type Translate,
} from '../shared/coordinator.ts'

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

  // Per-source adapter (Batch 3 Phase 2, plan §5.2): owns the dual-pool
  // selection (official host catalog for LOCAL sources + the page-wide main
  // pool), the per-entry base-path remapping of every official request/icon
  // URL, the per-entry channel routing (official → instance host route; main →
  // trusted preload IPC with the exact-boot proof) and the persisted choice.
  const adapter = createOpenInSourceAdapter({
    source,
    sourceFingerprint,
    translate: t,
    basePath: (ctx as { chamberBasePath?: string }).chamberBasePath,
    mainPool: { get: getOpenInApps, subscribe: subscribeOpenIn, refresh: refreshApps },
    choice: { get: getOpenInChoice, set: setOpenInChoice, subscribe: subscribeOpenInChoice },
    platform: bridgePlatform(),
  })
  ctx.effect(() => () => adapter.dispose(), 'dsh-chamber: open-in adapter')

  // The slot inject factory closes over ctx (same pattern as the vendor
  // session-log entry): it hands the component this ctx's source id, the
  // bound translator and the per-ctx model/launch faces; the per-header
  // session id and the workspace rows come from the framework standard kit
  // (see OpenInButton props).
  const injected = (): OpenInInjected => ({
    source,
    sourceFingerprint,
    t,
    getViewModel: adapter.getViewModel,
    subscribe: adapter.subscribe,
    refresh: adapter.refresh,
    launch: adapter.launch,
    getChoice: adapter.getChoice,
    choose: adapter.choose,
    iconUrl: adapter.iconUrl,
    platform: adapter.platform,
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
