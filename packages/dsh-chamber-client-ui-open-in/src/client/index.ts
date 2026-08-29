/**
 * Chamber open-in client plugin (design 16 + open-in extension): a header
 * utility button that opens the current session's workspace in an installed
 * app — Finder (local sources) and/or VS Code (local + any SSH-transport
 * remote target, whether dsh or gateway).
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
 * The source id rides `ctx.chamberInstanceId` (provided by chamber-entry);
 * the workspace path for the header's session comes from the framework store
 * (see OpenInButton).
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only import activates the locale service's Context merge.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { OpenInButton, type OpenInInjected } from './OpenInButton.tsx'
import { en, zh, type OpenInKey } from '../locales.ts'
import { parseOpenInSource, parseOpenInSourceFingerprint } from '../shared/capabilities.ts'

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

  const t = ctx.locale.bind(NS)

  // The slot inject factory closes over ctx (same pattern as the vendor
  // session-log entry): it hands the component this ctx's source id and the
  // bound translator; the per-header session id and the workspace rows come
  // from the framework standard kit (see OpenInButton props).
  const injected = (): OpenInInjected => ({ source, sourceFingerprint, t })

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
