/** Places the full upstream plugin manager page inside Settings → Built-in plugins. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import { configLedgerSource } from '@deepseek-ai/dsh-client-ui-plugin-manager/src/client/config-ledger.ts'
import { en, zh } from '@deepseek-ai/dsh-client-ui-plugin-manager/src/client/locales.ts'
import { PluginManagerController } from '@deepseek-ai/dsh-client-ui-plugin-manager/src/client/manager-store.ts'
import { createNavigationStore } from '@deepseek-ai/dsh-client-ui-plugin-manager/src/client/navigation-store.ts'
import type { PluginManagerFace } from '@deepseek-ai/dsh-client-ui-plugin-manager/src/client/manager-store.ts'
import type { PluginManagerLocaleKey } from '@deepseek-ai/dsh-client-ui-plugin-manager/src/client/locales.ts'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/src/client/slot-contract.ts'
import { EmbeddedPluginManagerPage } from './EmbeddedPluginManagerPage.tsx'
import { tabLocales, type PluginManagerTabLocaleKey } from './tab-locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.pluginManagerTab': PluginManagerTabLocaleKey
    pluginManager: PluginManagerLocaleKey
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    pluginNavigation: { openBundle(packageName: string): void }
  }
}

const MANAGER_NS = 'pluginManager'
const TAB_NS = 'settings.pluginManagerTab'

export const inject = [
  'slots', 'locale', 'remote', 'remote.pluginManager', 'remote.pluginInventory',
  'remote.pluginRegistryProbe', 'configForms',
]

const MANAGER_CHILDREN = {
  'plugins.item': { kind: 'list', scope: 'root' },
  'plugins.bundle.activation': { kind: 'keyed', scope: 'root' },
  'plugins.bundle.config': { kind: 'keyed', scope: 'root' },
  'plugins.row.config': { kind: 'keyed', scope: 'root' },
  'plugins.detail.actions': { kind: 'list', scope: 'root' },
  'plugins.detail.badge': { kind: 'list', scope: 'root' },
  'plugins.detail.section': { kind: 'list', scope: 'root' },
} as const

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(MANAGER_NS, { zh, en }), 'settings-plugin-manager: manager dictionaries')
  ctx.effect(() => ctx.locale.register(TAB_NS, tabLocales), 'settings-plugin-manager: tab dictionaries')

  const controller = new PluginManagerController(ctx)
  ctx.effect(() => () => { controller.dispose() }, 'settings-plugin-manager: controller')

  ctx.effect(() => {
    const refresh = (): void => {
      if (controller.getSnapshot().status !== 'idle') void controller.load()
    }
    const disposers = [
      ctx.remote.$on('plugin-manager/changed', refresh),
      ctx.remote.$on('plugin-manager/install-log', (chunk: Parameters<PluginManagerController['appendLog']>[0]) => { controller.appendLog(chunk) }),
      ctx.remote.$on('plugin-manager/install-state', (progress: Parameters<PluginManagerController['installProgress']>[0]) => { controller.installProgress(progress) }),
      ctx.on('connection/reset', refresh),
    ]
    return () => { for (const dispose of disposers) dispose() }
  }, 'settings-plugin-manager: host invalidations')

  const configLedger = configLedgerSource(ctx)
  const label = ctx.locale.bind(TAB_NS)
  const resolveText: PluginManagerFace['resolveText'] = text =>
    (ctx.locale as unknown as { resolveText: PluginManagerFace['resolveText'] }).resolveText(text)
  let openPackage: ((packageName: string) => void) | undefined
  ctx.effect(() => ctx.reflect.provide('pluginNavigation', {
    openBundle: (packageName: string) => { openPackage?.(packageName) },
  }), 'settings-plugin-manager: navigation service')
  ctx.slots.inject('settings.plugins.tab', function* () {
    const handle = createNavigationStore()
    const instance = handle.create()
    const store: typeof handle = { ...handle, create: () => instance }
    const navigate = (packageName: string): void => { instance.actions.setView({ kind: 'package', name: packageName }) }
    openPackage = navigate
    yield () => { if (openPackage === navigate) openPackage = undefined }
    yield ctx.slots.register({
      name: 'settings.plugins.tab',
      id: 'manager',
      order: 0,
      label: () => label('tab'),
      locale: MANAGER_NS,
      store,
      inject: () => controller.inject(configLedger, resolveText) as PluginManagerFace,
      children: MANAGER_CHILDREN,
    }, EmbeddedPluginManagerPage as never)
  })
}
