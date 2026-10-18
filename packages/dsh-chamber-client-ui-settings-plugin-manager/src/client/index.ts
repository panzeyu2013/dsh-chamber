/** Places the full upstream plugin manager page inside Settings → Built-in plugins. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import { configLedgerSource } from '@deepseek-ai/dsh-client-ui-plugin-manager/src/client/config-ledger.ts'
import { tabLedgerSource } from '@deepseek-ai/dsh-client-ui-plugin-manager/src/client/tab-ledger.ts'
import { en, zh } from '@deepseek-ai/dsh-client-ui-plugin-manager/src/client/locales.ts'
import { PluginManagerController, isInstallPending } from '@deepseek-ai/dsh-client-ui-plugin-manager/src/client/manager-store.ts'
import { PluginRefreshToast, type PluginRefreshToastFace } from '@deepseek-ai/dsh-client-ui-plugin-manager/src/client/PluginRefreshToast.tsx'
import { createNavigationStore } from '@deepseek-ai/dsh-client-ui-plugin-manager/src/client/navigation-store.ts'
import type { PluginManagerFace } from '@deepseek-ai/dsh-client-ui-plugin-manager/src/client/manager-store.ts'
import type { PluginManagerLocaleKey } from '@deepseek-ai/dsh-client-ui-plugin-manager/src/client/locales.ts'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/src/client/slot-contract.ts'
import { EmbeddedPluginManagerPage } from './EmbeddedPluginManagerPage.tsx'
import { createPluginActionTracker } from './plugin-action-tracker.ts'
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

/**
 * The per-instance control face the chamber shell provides on the boot ctx
 * (`ctx.chamberPluginRefresh`, renderer/src/shell.ts). Structural on purpose: this
 * package stays free of a chamber package dependency, exactly like the
 * `chamberInstanceId` seam; absent on non-chamber shells, where the trigger no-ops.
 */
interface ChamberPluginRefreshControl {
  /**
   * One settled plugin/bundle change of this instance: resync the graph, watch for the
   * reload fact. `startedAt` is the action's start on the page wall clock — the shell
   * needs it because the host's graph frame (and the restart fact) usually lands before
   * the RPC answer that settles this action.
   */
  requestRefresh(startedAt: number): void
  /** A new action began: the shell closes any open restart window mid-flight. */
  actionStarted(): void
}

const MANAGER_CHILDREN = {
  // v0.2.1-alpha.1: the upstream page renders this seat in the add-plugin menu
  // (PluginManagerPage AddPluginMenu); we embed the page without its apply(),
  // so our registration MUST declare every upstream child or renderSlot throws
  // SlotOwnershipError. Locked by test/dom-seam/vendor-page-dom-seam.test.ts.
  'plugins.add.actions': { kind: 'list', scope: 'root' },
  'plugins.tab': { kind: 'list', scope: 'root' },
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
  // Upstream's refresh toast is the plugin manager's own shell.overlay seat: the
  // face is hoisted so the settings page and the overlay toast share one
  // controller face (upstream registers the same pair from one place).
  const face = controller.inject(configLedger, tabLedgerSource(ctx), resolveText)
  // 插件刷新收敛触发（design 09 §3.7 / design 15 §6）：本页控制器的一次
  // 「动作在途 → 结算」边沿 = 一次用户发起的插件/组合包变更，通知所属实例的壳做
  // client 图重同步 + 有界 restart 窗口。控制面缺席（测试夹具/非 chamber 壳）即 no-op。
  const pluginRefresh = (ctx as ClientContext & { chamberPluginRefresh?: ChamberPluginRefreshControl }).chamberPluginRefresh
  if (pluginRefresh !== undefined) {
    ctx.effect(() => {
      // The vendor predicate travels in: this plugin already imports the manager store,
      // and a pin that adds a pending phase must reach the tracker, not be mirrored.
      const tracker = createPluginActionTracker(isInstallPending)
      const unsubscribe = face.hooks.pluginManager.subscribe(() => {
        const transition = tracker.observe(face.hooks.pluginManager.getSnapshot())
        if (transition?.kind === 'started') pluginRefresh.actionStarted()
        else if (transition?.kind === 'settled') pluginRefresh.requestRefresh(transition.startedAt)
      })
      return () => { unsubscribe() }
    }, 'settings-plugin-manager: plugin refresh convergence')
  } else if ((ctx as ClientContext & { chamberInstanceId?: unknown }).chamberInstanceId !== undefined) {
    // A chamber shell lacking the seam would silently stop converging (the 2026-10 fix is
    // wired by string key + structural type across packages): stay loud, like other
    // missing-seat diagnostics in this package.
    console.warn('[dsh-chamber] settings-plugin-manager: chamberPluginRefresh control missing; plugin refresh will not converge')
  }
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'plugin-manager.refresh-toast',
    locale: MANAGER_NS,
    inject: (): PluginRefreshToastFace => ({
      hooks: { pluginManager: face.hooks.pluginManager },
      dismissNotice: face.dismissNotice,
    }),
  }, PluginRefreshToast as never))
  let openPackage: ((packageName: string) => void) | undefined
  ctx.effect(() => ctx.reflect.provide('pluginNavigation', {
    openBundle: (packageName: string) => { openPackage?.(packageName) },
  }), 'settings-plugin-manager: navigation service')
  ctx.slots.inject('settings.plugins.tab', function* () {
    const handle = createNavigationStore()
    const instance = handle.create()
    const store: typeof handle = { ...handle, create: () => instance }
    const navigate = (packageName: string): void => {
      // The page now has tabs: a bundle opened from another tab must land on Installed.
      instance.actions.setTab('installed')
      instance.actions.setView({ kind: 'package', name: packageName })
    }
    openPackage = navigate
    yield () => { if (openPackage === navigate) openPackage = undefined }
    yield ctx.slots.register({
      name: 'settings.plugins.tab',
      id: 'manager',
      order: 0,
      label: () => label('tab'),
      locale: MANAGER_NS,
      store,
      inject: () => face as PluginManagerFace,
      children: MANAGER_CHILDREN,
    }, EmbeddedPluginManagerPage as never)
  })
}
