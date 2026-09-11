/**
 * Chamber settings shell plugin (design discussion 2026-08), browser half:
 * registers the「设置 / Settings」shell into the `sidebar.settings` slot at a
 * LOWER priority than the official SettingsRoot registration, so the
 * official shell is shadowed (never conflicts — the official entry stays on
 * the ledger and its settings.* children declarations remain valid). The
 * shell itself (SettingsShell.tsx) mounts a child cordis context per selected
 * server and renders the chamber-global connections surface as a fixed nav
 * entry — no chamber-side persistence, no new control-plane API; every
 * configuration fact stays on the target host.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the slot registry face (ctx.slots) and the sidebar seat
// ('sidebar.settings') into this program.
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import {
  SETTINGS_SHELL_ENTRY_ID, SETTINGS_SHELL_SHADOW_PRIORITY,
  chamberBridge, isValidProducerSourceFingerprint,
} from '@dsh-chamber/dsh-chamber-client-ui-sidebar/shared'
import { SettingsShell } from './SettingsShell.tsx'
import type { SettingsShellInjected } from './SettingsShell.tsx'
import {
  publishSettingsSourceRuntime, type SettingsSourceLocale, type SettingsSourceSlots,
} from './settings-source-face.ts'
import { DshRuntimeSection } from './DshRuntimeSection.tsx'
import { deriveRuntimeSource, runtimeSectionIntentionallyAbsent, runtimeServerProjectionKey } from './runtime-source.ts'
import { en, zh, type SettingsBridgeKey } from '../locales.ts'

export type { SettingsShellInjected, SettingsShellProps } from './SettingsShell.tsx'
export type { SettingsBridgeKey } from '../locales.ts'
export type { DshRuntimeSectionProps, DshRuntimeSource } from './DshRuntimeSection.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The chamber settings shell copy. */
    'dsh-chamber.settings.bridge': SettingsBridgeKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'dsh-chamber.settings.bridge'

/** The embedded connections section's dictionary namespace (owned by dsh-client-ui-settings-connections). */
const CONNECTIONS_NS = 'dsh-chamber.settings.connections'

/**
 * Shadow priority: the official SettingsRoot registers at the default 0; the
 * slot core's shadowing rule renders the LOWEST priority winner, so a lower
 * value replaces the official shell without touching its ledger entry. 2026-12:
 * the value is the documented RESERVED range (sidebar shared face
 * `settings-shell.ts`) — the chamber sidebar watchdog reports any registrant
 * that goes below it, because the shell is the only renderer of the
 * connections/general pages and of every per-source plugin settings section.
 */
const SHADOW_PRIORITY = SETTINGS_SHELL_SHADOW_PRIORITY

/** Required services: the slot registry and the locale face. */
export const inject = ['slots', 'locale']

/**
 * Register the chamber settings shell once the `sidebar.settings` declaration
 * is on the ledger.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-chamber: settings shell dictionaries')

  const t = ctx.locale.bind(NS)
  const connectionsT = ctx.locale.bind(CONNECTIONS_NS)
  const chamberInstanceId = (ctx as ClientContext & { chamberInstanceId?: string }).chamberInstanceId
  const sourceFingerprint = (ctx as ClientContext & { chamberSourceFingerprint?: string }).chamberSourceFingerprint
  // Complete-bridge face publication (design 05 §5, 2026-12 修订): this plugin
  // runs once per instance boot ctx, so it is the ONE place that can hand the
  // panel that source's own settings ledger and locale face. An invalid or
  // absent instance id keeps the plugin inert (a ctx without the chamber boot
  // fact is not a source).
  const validBinding = chamberInstanceId !== undefined
    && isValidProducerSourceFingerprint(chamberInstanceId, sourceFingerprint)
  if (validBinding) {
    // The ambient cordis face this package compiles against declares only the
    // WRITE half of these two services; the read halves the face publishes are
    // the real registry/locale faces (same objects the plugins use).
    const slots = ctx.slots as unknown as SettingsSourceSlots
    const localeFace = ctx.locale as unknown as SettingsSourceLocale
    ctx.effect(() => publishSettingsSourceRuntime(chamberInstanceId, {
      slots,
      locale: localeFace,
      sourceFingerprint,
    }), 'dsh-chamber: settings source face')
    registerRuntimeSection(ctx, chamberInstanceId, localeFace)
  }

  const injected = (): SettingsShellInjected => ({ t, connectionsT, chamberInstanceId })

  ctx.slots.inject('sidebar.settings', () => ctx.slots.register({
    name: 'sidebar.settings',
    id: SETTINGS_SHELL_ENTRY_ID,
    priority: SHADOW_PRIORITY,
    label: () => t('trigger'),
    inject: injected,
  }, SettingsShell))
}

/**
 * Register this instance's own「dsh 运行时」settings section into its OWN
 * ledger (design 18 §3.6 修订 / design 05 §5, 2026-12 完整桥接修订).
 *
 * WHY here and not per panel target: the panel renders the selected source's
 * own boot-ctx ledger, so a section that only exists because the CHAMBER adds
 * it must be registered by the ctx it belongs to. The capability matrix is
 * unchanged — local and gateway sources carry the section, a direct dsh target
 * carries none (no `/chamber` channel, no management surface).
 *
 * Failure policy: this now runs INSIDE a source's own frontend boot, so a
 * malformed projection is reported and skipped instead of throwing — a
 * settings-section derivation must never take down the instance's UI. The
 * projection is reconciled on every roster publish, so a source that becomes
 * identifiable later still gets its section.
 * @param ctx - the instance's own client context.
 * @param instanceId - that instance's source id.
 */
function registerRuntimeSection(
  ctx: ClientContext,
  instanceId: string,
  localeFace: SettingsSourceLocale,
): void {
  ctx.slots.inject('settings.section', () => {
    let dispose: (() => void) | undefined
    let lastKey: string | undefined
    const reconcile = (): void => {
      const row = chamberBridge.getServers().find(server => server.id === instanceId)
      const projection = row === undefined ? undefined : {
        id: row.id,
        sourceFingerprint: row.sourceFingerprint,
        kind: row.kind,
        transport: row.transport,
        ...(row.rawId === undefined ? {} : { rawId: row.rawId }),
        ...(row.dshVersion === undefined ? {} : { dshVersion: row.dshVersion }),
      }
      const key = projection === undefined ? undefined : runtimeServerProjectionKey(projection)
      if (key === lastKey) return
      lastKey = key
      dispose?.()
      dispose = undefined
      if (projection === undefined) return
      const source = deriveRuntimeSource(projection)
      if (source === null) {
        if (!runtimeSectionIntentionallyAbsent(projection)) {
          console.error(`[dsh-chamber] invalid dsh runtime projection for instance '${instanceId}': `
            + 'the dsh-runtime settings section is not mounted')
        }
        return
      }
      dispose = ctx.slots.register({
        name: 'settings.section',
        id: 'dsh-runtime',
        order: 31,
        label: () => localeFace.bind(NS)('runtimeNav'),
        locale: NS,
        inject: () => ({
          t: localeFace.bind(NS),
          instanceSource: source,
          chamberInstanceId: instanceId,
        }),
      }, DshRuntimeSection) as () => void
    }
    reconcile()
    const unsubscribe = chamberBridge.subscribe(reconcile)
    return () => {
      unsubscribe()
      dispose?.()
    }
  })
}
