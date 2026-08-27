/**
 * Per-server「dsh 运行时」section plugin for the CHILD cordis context
 * (design 18 §3.6, 2026-09 per-server 修订 + design 05 §5).
 *
 * Why a child-context plugin: the settings shell renders the SELECTED
 * server's section ledger from the child cordis context assembled by
 * mountBridgeSession — a registration in the app context (the bridge's own
 * apply) never reaches that ledger. Registering here, per session, also binds
 * the CORRECT canonical instance id ('local' | 'ssh-<id>' | 'gateway-<id>')
 * so the source branch is derived per selected server, not captured once.
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
  return {
    inject: ['slots', 'locale'],
    apply(ctx: ClientContext): void {
      // The child context has its own locale registry: register the bridge
      // dictionaries here too (the app-context registration does not reach it).
      ctx.effect(() => ctx.locale.register(RUNTIME_NS, { zh, en }), 'dsh-chamber: runtime section dictionaries')
      const t = ctx.locale.bind(RUNTIME_NS)
      const source = deriveRuntimeSource(instanceId)
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
