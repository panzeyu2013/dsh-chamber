/**
 * Per-server「dsh 运行时」section plugin for the CHILD cordis context
 * (design 18 §3.6, 2026-09 per-server 修订 + design 05 §5).
 *
 * Why a child-context plugin: the settings shell renders the SELECTED
 * server's section ledger from the child cordis context assembled by
 * mountBridgeSession — a registration in the app context (the bridge's own
 * apply) never reaches that ledger. Registering here, per session, also binds
 * the selected server's explicit target kind + transport, so the source
 * branch is derived from capability facts rather than an id prefix and is
 * never captured from another server.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { DshRuntimeSection } from './DshRuntimeSection.tsx'
import {
  deriveRuntimeSource,
  runtimeSectionIntentionallyAbsent,
  type RuntimeServerProjection,
} from './runtime-source.ts'
import { en, zh } from '../locales.ts'

/** Dictionary namespace owned by the settings bridge shell. */
export const RUNTIME_NS = 'dsh-chamber.settings.bridge'

export interface RuntimeSectionPlugin {
  inject: readonly string[]
  apply(ctx: ClientContext): void
}

export function createRuntimeSectionPlugin(server: RuntimeServerProjection): RuntimeSectionPlugin | null {
  // Fail-loud on unrecognized source ids (design 17 §3 / design 18 §3.6):
  // deriveRuntimeSource returns null for anything that is not a recognized
  // target/transport tuple — never 'local'. The throw rejects the whole
  // mountBridgeSession and the settings shell surfaces it as a visible mount
  // error; a silent 'local' fallback would render the FULL runtime management
  // surface against an unidentified target (e.g. a future kind added to the
  // server roster without this map).
  const source = deriveRuntimeSource(server)
  if (source === null) {
    // design 17 §3 / design 18 §3.6: a direct dsh target (ssh or http) has
    // neither a runtime management surface nor a /chamber channel, so the
    // ledger must not contain dsh-runtime at all.
    if (runtimeSectionIntentionallyAbsent(server)) return null
    throw new Error(
      `settings-bridge: invalid dsh runtime projection for instance '${server.id}' (refusing to mount)`,
    )
  }
  return {
    inject: ['slots', 'locale'],
    apply(ctx: ClientContext): void {
      // The child context has its own locale registry: register the bridge
      // dictionaries here too (the app-context registration does not reach it).
      ctx.effect(() => ctx.locale.register(RUNTIME_NS, { zh, en }), 'dsh-chamber: runtime section dictionaries')
      const t = ctx.locale.bind(RUNTIME_NS)
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'dsh-runtime',
        order: 31,
        label: () => t('runtimeNav'),
        locale: RUNTIME_NS,
        inject: () => ({
          t,
          instanceSource: source,
          chamberInstanceId: server.id,
        }),
      }, DshRuntimeSection))
    },
  }
}
