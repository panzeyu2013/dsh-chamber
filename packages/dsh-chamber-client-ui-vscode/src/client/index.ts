/**
 * Chamber VS Code deep-link client plugin (design 16): a header utility
 * button that opens the current session's workspace in local VS Code
 * Remote-SSH.
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
 * (see OpenInVscodeButton).
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only import activates the locale service's Context merge.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { OpenInVscodeButton, type OpenInVscodeInjected } from './OpenInVscodeButton.tsx'
import { en, zh, type VscodeKey } from '../locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'dsh-chamber.vscode': VscodeKey
  }
}

/** The official conversation header utilities slot (beside "Session log"). */
export const VSCODE_HEADER_SLOT = 'conversation.session.header.utilities' as const
const NS = 'dsh-chamber.vscode'

export const inject = ['slots', 'locale']

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-chamber: VS Code deep-link dictionaries')

  // Per-boot instance id provided by chamber-entry; loose cast (the sidebar
  // plugin uses the same `as any` seam — the vendor cordis face stays loose).
  // Bail on an absent id (frontend-review P2-4): without it the gate-2 local
  // check would let a bogus '' source render a button that can only fail.
  const sourceId = (ctx as { chamberInstanceId?: string }).chamberInstanceId
  if (sourceId === undefined) return

  const t = ctx.locale.bind(NS)

  // The slot inject factory closes over ctx (same pattern as the vendor
  // session-log entry): it hands the component this ctx's source id and the
  // bound translator; the per-header session id and the workspace rows come
  // from the framework standard kit (see OpenInVscodeButton props).
  const injected = (): OpenInVscodeInjected => ({ sourceId, t })

  ctx.slots.inject(VSCODE_HEADER_SLOT, () => ctx.slots.register({
    name: VSCODE_HEADER_SLOT,
    id: 'vscode-open',
    label: () => t('title'),
    inject: injected,
  }, OpenInVscodeButton))
}
