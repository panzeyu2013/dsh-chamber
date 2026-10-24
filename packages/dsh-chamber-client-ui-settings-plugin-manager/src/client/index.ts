/** Places the full upstream plugin manager page inside Settings → Plugin management as its own section. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
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
import { createPluginNavigation, type PluginNavigationTarget } from './plugin-navigation.ts'
import { sectionLocales, type PluginManagerSectionLocaleKey } from './section-locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.pluginManagerSection': PluginManagerSectionLocaleKey
    pluginManager: PluginManagerLocaleKey
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Cross-plugin navigation to the Plugins page (upstream shape, rc.3 adds openList). */
    pluginNavigation: {
      openBundle(packageName: string): void
      openList(): void
    }
  }
}

const MANAGER_NS = 'pluginManager'
const SECTION_NS = 'settings.pluginManagerSection'

/** The `settings.section` id this page owns; plugin navigation targets it. */
const PLUGIN_SECTION_ID = 'plugin-manager'

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
  ctx.effect(() => ctx.locale.register(SECTION_NS, sectionLocales), 'settings-plugin-manager: section dictionary')

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
  const sectionLabel = ctx.locale.bind(SECTION_NS)
  const resolveText: PluginManagerFace['resolveText'] = text =>
    (ctx.locale as unknown as { resolveText: PluginManagerFace['resolveText'] }).resolveText(text)
  // Upstream's refresh toast is the plugin manager's own shell.overlay seat: the
  // face is hoisted so the settings section and the overlay toast share one
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
  // Navigation service (design 05 §5): the page's view half binds when its
  // `settings.section` declaration lands; the dialog half goes through the per-ctx
  // `chamberSettingsNavigation` seat the settings shell provides. Both peers are
  // deferred chunks and either may arrive first, so a request queues and the dynamic
  // inject flushes a queued open when the seat appears (a refused seat stays queued).
  const navigation = createPluginNavigation({
    openSection: () => {
      // ctx.get can throw while a service is being disposed (the cordis proxy's
      // documented edge; same guard as the sidebar's goal-activation read). A click
      // in that window must queue, not surface a TypeError.
      let seat: { open(sectionId: string): void } | undefined
      try {
        seat = ctx.get<{ open(sectionId: string): void } | undefined>('chamberSettingsNavigation')
      } catch {
        seat = undefined
      }
      if (seat === undefined) return false
      seat.open(PLUGIN_SECTION_ID)
      return true
    },
  })
  // Dynamic dependency: the callback runs now when the seat is already provided and
  // when it appears later (cordis keeps the child Fiber until this plugin ctx dies).
  ctx.inject(['chamberSettingsNavigation'], () => { navigation.retryOpen() })
  ctx.effect(() => ctx.reflect.provide('pluginNavigation', navigation.provider), 'settings-plugin-manager: navigation service')
  ctx.slots.inject('settings.section', function* () {
    const handle = createNavigationStore()
    const instance = handle.create()
    const store: typeof handle = { ...handle, create: () => instance }
    const applyNavigation = (target: PluginNavigationTarget): void => {
      // The page has tabs: any programmatic open lands on Installed first.
      instance.actions.setTab('installed')
      instance.actions.setView(target === 'list' ? { kind: 'list' } : { kind: 'package', name: target.name })
    }
    yield navigation.attach(applyNavigation)
    yield ctx.slots.register({
      name: 'settings.section',
      id: PLUGIN_SECTION_ID,
      order: 16,
      label: () => sectionLabel('nav'),
      locale: MANAGER_NS,
      store,
      inject: () => face as PluginManagerFace,
      children: MANAGER_CHILDREN,
    }, EmbeddedPluginManagerPage as never)
  })
}
