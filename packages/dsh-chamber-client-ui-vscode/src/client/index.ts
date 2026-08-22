/**
 * Chamber VS Code deep-link client plugin (design 16): the `shell.overlay`
 * top-right button that opens the current source's workspace in local VS Code
 * Remote-SSH.
 *
 * The overlay entry is root-scoped per instance ctx, so the visible button in
 * the active shell IS the active source's button — no chamberBridge
 * "current source" concept is needed (design 16 P2-1). The source id rides
 * `ctx.chamberInstanceId` (provided by chamber-entry); the current workspace
 * path is read from this ctx's own runtime stores (see OpenInVscodeButton).
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only import activates the locale service's Context merge.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { OpenInVscodeButton, type OpenInVscodeProps } from './OpenInVscodeButton.tsx'
import { en, zh, type VscodeKey } from '../locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'dsh-chamber.vscode': VscodeKey
  }
}

export const VSCODE_OVERLAY_SLOT = 'shell.overlay' as const
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

  // The slot inject factory closes over ctx (same pattern as the git plugin's
  // workspace occupant): it hands the component this ctx's source id and the
  // two runtime observable lists it needs for the current-workspace gate.
  const injected = (): OpenInVscodeProps => ({
    sourceId,
    t,
    sessionsList: (ctx.sessions as unknown as { list: OpenInVscodeProps['sessionsList'] }).list,
    workspacesList: (ctx.workspaces as unknown as { list: OpenInVscodeProps['workspacesList'] }).list,
  })

  ctx.slots.inject(VSCODE_OVERLAY_SLOT, () => ctx.slots.register({
    name: VSCODE_OVERLAY_SLOT,
    id: 'vscode-open',
    label: () => t('title'),
    inject: injected,
  }, OpenInVscodeButton))
}
