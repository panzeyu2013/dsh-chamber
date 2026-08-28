/**
 * Per-server「dsh 运行时」section plugin for the CHILD cordis context
 * (design 18 §3.6, 2026-09 per-server 修订 + design 05 §5).
 *
 * Why a child-context plugin: the settings shell renders the SELECTED
 * server's section ledger from the child cordis context assembled by
 * mountBridgeSession — a registration in the app context (the bridge's own
 * apply) never reaches that ledger. Registering here, per session, also binds
 * the CORRECT canonical instance id ('local' | 'ssh-<id>' | 'gateway-<id>' |
 * 'dsh-<id>') so the source branch is derived per selected server, not
 * captured once.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { DshRuntimeSection } from './DshRuntimeSection.tsx'
import { deriveRuntimeSource } from './runtime-source.ts'
import { en, zh } from '../locales.ts'

/** Dictionary namespace owned by the settings bridge shell. */
export const RUNTIME_NS = 'dsh-chamber.settings.bridge'

export interface RuntimeSectionPlugin {
  inject: readonly string[]
  apply(ctx: ClientContext): void
}

export function createRuntimeSectionPlugin(instanceId: string): RuntimeSectionPlugin {
  // Fail-loud on unrecognized source ids (design 17 §3 / design 18 §3.6):
  // deriveRuntimeSource returns null for anything that is not a recognized
  // canonical prefix — never 'local'. The throw rejects the whole
  // mountBridgeSession and the settings shell surfaces it as a visible mount
  // error; a silent 'local' fallback would render the FULL runtime management
  // surface against an unidentified target (e.g. a future kind added to the
  // server roster without this map).
  const source = deriveRuntimeSource(instanceId)
  if (source === null) {
    throw new Error(
      `settings-bridge: unrecognized dsh runtime source for instance id '${instanceId}' (refusing to mount)`,
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
        inject: () => ({ t, instanceSource: source, chamberInstanceId: instanceId }),
      }, DshRuntimeSection))
    },
  }
}
