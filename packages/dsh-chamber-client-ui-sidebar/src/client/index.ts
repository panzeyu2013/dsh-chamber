/** Registers the chamber sidebar shell (design 05 §2) into the layout-owned slot. */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { indexSubagentDescendants } from '@deepseek-ai/dsh-client-runtime/client'
import type { ObservableSnapshot, SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import type { SidebarRootInjected } from './contract/slots.ts'
import { SidebarRoot } from './SidebarRoot.tsx'
import { en, zh, type SidebarKey } from './locales.ts'
import { chamberBridge } from '../shared/aggregate-store.ts'
import { projectRuntimeFacts } from '../shared/derive.ts'

export type {
  SidebarFooterActionOwnerProps, SidebarRootComponentProps, SidebarRootInjected,
  SidebarGitOwnerProps, SidebarSectionOwnerProps, SidebarSettingsOwnerProps,
} from './contract/slots.ts'
export type { SidebarKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Sidebar shell controls copy. */
    sidebar: SidebarKey
  }
}

/** Dictionary namespace owned by this plugin (shell controls copy). */
const NS = 'sidebar'

/** Services required by the sidebar plugin. */
export const inject = ['slots', 'layout', 'sessions', 'workspaces', 'locale']

/**
 * Registers the sidebar shell and its service callbacks. The hole
 * declarations match the official shell (ui-settings / footer actions render
 * in the foot; `sidebar.workspaces` stays declared so ui-workspace's
 * registration does not fail — the chamber shell renders its own multi-source
 * list in the region instead, 05 §2).
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-chamber: sidebar dictionaries')

  const injectProps = (): SidebarRootInjected => ({
    // The shell's New Session button rides the runtime's shared action
    // (current Session Workspace, then recent Workspace) — of THIS ctx, so it
    // always acts on the current source.
    startSession: (workspaceId) => { ctx.workspaces.startSession(workspaceId) },
    toggleSidebar: () => { ctx.layout.toggleSidebar() },
    // chamber patch (05 §4): the renderer shell sets the per-boot instance id
    // through the chamber knob while the boot owns the base-path window knob.
    chamberInstanceId: (ctx as any).chamberInstanceId as string | undefined,
    // chamber (05 §4): the in-app directory-browser dialog copy — the browse
    // directory-picker package (mounted in every boot) owns this namespace.
    directoryBrowserT: ctx.locale.bind('directory-browser'),
  })
  ctx.effect(
    () => ctx.slots.register({
      name: 'sidebar',
      locale: NS,
      children: {
        'sidebar.workspaces': { kind: 'single', scope: 'root' },
        'sidebar.git': { kind: 'single', scope: 'root' },
        'sidebar.settings': { kind: 'single', scope: 'root' },
        'sidebar.footer.action': { kind: 'list', scope: 'root' },
      },
      inject: injectProps,
    }, SidebarRoot),
    'dsh-chamber: sidebar slot registration',
  )

  // chamber patch (06 §4.3/§4.5): the runtime-facts channel's producer end.
  // Every boot is its own ctx with its own sessions store, so this plugin —
  // mounted in every ctx — reports THIS instance's runtime facts (current
  // session, pending interactions, completions, every session's live
  // `running` bit, and per-parent RUNNING subagent counts from the vendor
  // lineage index) to the chamber bridge. The App layer merges the report
  // into the multi-source projection (server.runtime) and derives the
  // completed-but-unread dots itself (it owns the active view and every open
  // request — see App.tsx); the sidebar renders dots/highlights from the
  // projection for every source. The component no longer subscribes to the
  // store itself; boot frames before the first report simply render no
  // highlight (06 §4.3). zustand subscribe does not fire on mount, so the
  // snapshot is reported immediately. This producer keeps NO state of its own
  // — the report is a pure pass-through of the source's own list snapshot,
  // and the subagent counts reuse the vendor's indexSubagentDescendants
  // verbatim (runningCount per parent through uninterrupted subagent-origin
  // lineage — the same number the official ui-workspace tree renders, so the
  // subagent-live ring semantics can never drift from the official UI).
  ctx.effect(() => {
    const chamberInstanceId = (ctx as any).chamberInstanceId as string | undefined
    if (chamberInstanceId === undefined) return () => {}
    const list = (ctx.sessions as unknown as { list: ObservableSnapshot<SessionListState> }).list
    // 会话列表结构签名 = id 集合 + 每会话 blank 标志。结构变化（新建/归档/
    // blank→real 翻转）意味着多来源侧边栏的导航列表可能已变化，立即请求
    // App 层重拉该来源聚合（不等 10s 轮询）——壳内新建会话（New Session
    // 按钮、startSession 等 ctx 内入口）与首条消息后的 blank 翻转都要马上
    // 反映到侧边栏。running/completed/pending/current 变化不刷新（事实通道
    // 与高亮已覆盖）。初始同步不上报刷新（避免 boot 期无谓重拉）。
    let signature = ''
    let initialized = false
    const sync = (): void => {
      const snapshot = list.getSnapshot()
      // 06 §4.5: per-parent RUNNING subagent descendant counts (sparse — only
      // parents with at least one running descendant appear).
      const subagentRunning = new Map<string, number>()
      for (const [parentId, summary] of indexSubagentDescendants(snapshot.byId)) {
        if (summary.runningCount > 0) subagentRunning.set(parentId, summary.runningCount)
      }
      chamberBridge.reportInstanceRuntime(chamberInstanceId, projectRuntimeFacts(snapshot, subagentRunning))
      // 结构签名只覆盖**导航可见**行——subagent 起源行（官方 tree 渲染层隐藏、
      // 永不出现在多来源导航列表）必须排除：后台子 agent 每次生/灭都会改变
      // ids，若计入签名，`requestRefresh` 会在 10s 轮询之外叠加无节流的高频
      // 聚合重拉（子 agent 密集生灭的会话一次生命周期事件一次）。blank 翻转
      // 已由 blankKey 覆盖。
      const ids = (snapshot.ids ?? []).filter(
        (id: string) => (snapshot.byId as Record<string, { origin?: string }> | undefined)?.[id]?.origin !== 'subagent',
      )
      const byId = snapshot.byId ?? {}
      const blankKey = ids.map((id: string) => String(id) + ':' + String(byId[id]?.blank === true)).join(',')
      const next = ids.join(',') + '|' + blankKey
      if (next !== signature) {
        signature = next
        if (initialized) chamberBridge.requestRefresh(chamberInstanceId)
      }
      initialized = true
    }
    sync()
    const unsubscribe = list.subscribe(sync)
    return () => {
      unsubscribe()
      chamberBridge.clearInstanceRuntime(chamberInstanceId)
    }
  }, 'dsh-chamber: sidebar runtime facts report')
}
