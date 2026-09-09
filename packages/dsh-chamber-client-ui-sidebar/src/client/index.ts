/** Registers the chamber sidebar shell (design 05 §2) into the layout-owned slot. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { indexSubagentDescendants } from '../shared/subagent-lineage.ts'
import type { SidebarRootInjected } from './contract/slots.ts'
import { SidebarRoot } from './SidebarRoot.tsx'
import { en, zh, type SidebarKey } from './locales.ts'
import { chamberBridge, isValidProducerSourceFingerprint } from '../shared/aggregate-store.ts'
import {
  instanceSnapshotSignature,
  projectInstanceSnapshot,
  projectRuntimeFacts,
} from '../shared/derive.ts'
import { createPanelSource } from './panel-source.ts'
import { createPurgeTracker } from '../shared/purged-tracker.ts'
import { fetchInstanceSnapshot, getInstanceClient } from '../shared/instance-api.ts'

export type {
  SidebarBrandMarkOwnerProps, SidebarBrandNameOwnerProps, SidebarFooterActionOwnerProps,
  SidebarPanelIconOwnerProps, SidebarPanelMetadata, SidebarRootComponentProps, SidebarRootInjected,
  SidebarSectionOwnerProps, SidebarSettingsOwnerProps, SidebarWorkspaceGitOwnerProps,
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
export const inject = ['slots', 'layout', 'sessions', 'workspaces', 'uiSession', 'uiWorkspace', 'locale']

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

  // chamber (v0.1.2-alpha.1): `workspaces.startSession` moved to the
  // ui-workspace cross-Controller navigation service (official sidebar shape).
  const workspaceNavigation = ctx.get('uiWorkspace') as unknown as {
    startSession(workspaceId?: Parameters<SidebarRootInjected['startSession']>[0]): void
  }
  // alpha.2 global panel axis: mirror `sidebar.panellist` registrations into a
  // serializable snapshot the shell renders, and forward row clicks to
  // `ctx.layout.selectPanel` (present in every supported layout: both the
  // chamber fork and the alpha.2 official ui-layout declare it).
  const panels = createPanelSource()
  const syncPanels = (): void => { panels.sync(ctx.slots as Parameters<typeof panels.sync>[0]) }
  ctx.effect(() => ctx.slots.subscribe('sidebar.panellist', syncPanels), 'dsh-chamber: sidebar panel entries')
  ctx.effect(() => ctx.locale.subscribe(syncPanels), 'dsh-chamber: sidebar panel labels')

  const injectProps = (): SidebarRootInjected => ({
    // The shell's New Session button rides the Workspace UI's shared action
    // (current Session Workspace, then recent Workspace) — of THIS ctx, so it
    // always acts on the current source.
    startSession: (workspaceId) => { workspaceNavigation.startSession(workspaceId) },
    toggleSidebar: () => { ctx.layout.toggleSidebar() },
    // alpha.2: select the global main panel addressed by a sidebar row. Direct
    // call: a layout without `selectPanel` is a misconfiguration (the sidebar
    // shell only ever loads beside the chamber layout fork, and the alpha.2
    // official layout declares the method too), so it must fail loud rather
    // than silently ignore the click.
    selectPanel: (id) => { ctx.layout.selectPanel(id) },
    hooks: { panels: panels.source },
    // chamber patch (05 §4): the renderer shell installs this immutable
    // per-entry fact before any plugin materializes.
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
        'sidebar.brand.mark': { kind: 'single', scope: 'root' },
        'sidebar.brand.name': { kind: 'single', scope: 'root' },
        'sidebar.panellist': { kind: 'list', scope: 'root' },
        'sidebar.workspaces': { kind: 'single', scope: 'root' },
        // chamber (08 §11): the per-workspace Git hole. The slot-level inject
        // factory is git-agnostic (closes over only the sidebar-owned
        // occurrence context); the chamber Git plugin consumes the bound
        // `useWorkspaceGitContext` hook.
        'sidebar.workspace.git': {
          kind: 'single',
          scope: 'root',
          inject: {
            hooks: {
              workspaceGitContext: (
                _standard: object,
                context: { sourceId: string; workspaceId: string; repoKey?: string },
              ) => () => ({ sourceId: context.sourceId, workspaceId: context.workspaceId, repoKey: context.repoKey }),
            },
          },
        },
        'sidebar.settings': { kind: 'single', scope: 'root' },
        'sidebar.footer.action': { kind: 'list', scope: 'root' },
      },
      inject: injectProps,
    }, SidebarRoot),
    'dsh-chamber: sidebar slot registration',
  )
  // Upstream order: publish the (possibly already populated) panel list after
  // the registration exists, so the first render sees it.
  syncPanels()

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
  // snapshot is reported immediately. The producer keeps exactly ONE piece of
  // its own state: the purged-row suppression set + its verified convergence
  // chain (design 24 §21 — purge 后官方 summaries 不刷新，生产端因此过滤掉
  // 离开归档集合的行并做校验式收敛；`purged-tracker.ts` 持有该状态机，其余
  // 字段仍是源 store 的纯投影，运行时事实通道同样只过滤 tombstoned id)。
  // The subagent counts reuse the vendor's indexSubagentDescendants
  // verbatim (runningCount per parent through uninterrupted subagent-origin
  // lineage — the same number the official ui-workspace tree renders, so the
  // subagent-live ring semantics can never drift from the official UI).
  ctx.effect(() => {
    const chamberInstanceId = (ctx as any).chamberInstanceId as string | undefined
    const chamberSourceFingerprint = (ctx as any).chamberSourceFingerprint as string | undefined
    if (typeof chamberInstanceId !== 'string'
      || !isValidProducerSourceFingerprint(chamberInstanceId, chamberSourceFingerprint)) return () => {}
    const sessionsList = (ctx.sessions as unknown as { list: ObservableSnapshot<SessionListState> }).list
    const workspacesList = (ctx.workspaces as unknown as { list: ObservableSnapshot<WorkspaceSnapshot> }).list
    // 代际事实由 shell 的 configureContext 注入：页面的 producer 注册表按注册
    // 顺序授权，挂死后恢复的老 boot 会夺走生产权（2026-12 复查 BLOCKER）。
    const bootGeneration = (ctx as any).chamberBootGeneration as number | undefined
    const runtimeProducer = chamberBridge.registerInstanceRuntimeProducer(
      chamberInstanceId, chamberSourceFingerprint, bootGeneration)
    const snapshotProducer = chamberBridge.registerInstanceSnapshotProducer(
      chamberInstanceId, chamberSourceFingerprint, bootGeneration)
    // design 24 §20 (archive-cleanup convergence) + 2026-09 修正轮 (purged-row
    // suppression): this ctx's OFFICIAL session client (`ctx.sessions` —
    // ClientSessions) is requested to re-run its session-list refresh. The
    // purge of archived content is invisible to the official runtime (host
    // session events are documented no-ops), so rows of purged sessions linger
    // in the official client summaries (refreshed only on connection
    // generations) and would keep resurfacing in the chamber sidebar after the
    // host removes their ids from the archived set — opening one then fails
    // with session/not-found. `refresh()` reconciles the summaries against the
    // server corpus (a per-call disk walk) and drops the deleted rows; the
    // notify then flows through queueSnapshot below and the producer pushes a
    // clean snapshot. Loose face + runtime guard: only act for THIS ctx's own
    // instance; a missing method is WARNED (an inert seam must never be
    // silent), and the invocation is try/catch-wrapped — the official
    // refreshList has no synchronous throw path in the pinned vendor, but a
    // bridge-listener throw would abort the rest of the App's push handling
    // for this notification.
    //
    // 2026-09 修正轮 (F1/F2, see shared/purged-rows.ts): the App-side
    // convergence machine is a ONE-SHOT transition detector — it can only
    // request this refresh while an archive-set shrink is newly observed
    // against an archive-set-authoritative previous aggregate, and its request
    // is a fire-and-forget page-wide broadcast. Two proven gaps let the ghosts
    // return indefinitely: (1) after a converged view, any later re-dirtied
    // push carries rows whose ids already left the set, so no shrink is ever
    // observed again; (2) a shrink observed while the committed aggregate lost
    // provenance is invisible to it forever. The producer therefore owns the
    // fix itself:
    //   - F1 suppression: an authoritative shrink tombstones the removed ids
    //     (host `clearIds` only ever contains trees whose content deletion
    //     SUCCEEDED plus no-record orphans, so "left the archive set" ⇔ "the
    //     content is gone") and they are filtered out of every emitted
    //     snapshot until the raw summaries stop listing them or they are
    //     re-archived — the ghosts can never render, not even during the
    //     refresh round-trip;
    //   - F2 verified convergence: the same shrink (and every bridge request)
    //     runs the official refresh and then VERIFIES the ids left the
    //     summaries, retrying a bounded number of times. That repairs the
    //     official client itself (no dead-end opens) and covers
    //     `refreshList()`'s single-flight stale-response and transient-error
    //     holes, which the App cannot see.
    /**
     * One official session-list refresh. CRITICAL: `refresh()` is a PROTOTYPE
     * method on the service object (`ClientSessions.refresh` reads
     * `this.manager`), so it MUST be invoked as a method — a detached
     * `const f = ctx.sessions.refresh; f()` throws
     * `TypeError: Cannot read properties of undefined` and silently made the
     * §20 convergence seam a no-op until the 2026-09 review caught it.
     */
    const officialSessionRefresh = (): Promise<unknown> | undefined => {
      const service = ctx.sessions as unknown as { refresh?: () => Promise<unknown> }
      if (typeof service.refresh !== 'function') {
        console.warn(`[chamber] session list refresh requested for ${chamberInstanceId} but the official ` +
          'session client exposes no refresh() method — ghost-row convergence is unavailable')
        return undefined
      }
      try {
        return Promise.resolve(service.refresh())
      } catch (error) {
        console.warn(`[chamber] session list refresh for ${chamberInstanceId} threw synchronously:`,
          error instanceof Error ? error.message : String(error))
        return undefined
      }
    }

    /** Ids still listed by the OFFICIAL summaries (the convergence probe). */
    const listedSummaryIds = (): Set<string> => {
      const byId = (sessionsList.getSnapshot() as { byId?: Record<string, unknown> }).byId ?? {}
      return new Set(Object.keys(byId))
    }

    /**
     * INDEPENDENT authoritative row source (design 24 §21 terminal step): the
     * chamber's own unary `session.list` over the instance proxy — a fresh
     * per-call disk rescan with neither the official single-flight nor its
     * client cache. Used only when the bounded official-refresh chain could
     * not converge: an id this still lists is a live session the shrink did
     * NOT purge (release the suppression); an id it omits has no content
     * (keep the suppression). Failures return undefined ⇒ keep suppression.
     */
    const authoritativeListedIds = async (): Promise<ReadonlySet<string> | undefined> => {
      try {
        const snapshot = await fetchInstanceSnapshot(getInstanceClient(chamberInstanceId))
        return new Set(snapshot.sessions.map(row => row.sessionId))
      } catch (error) {
        console.warn(`[chamber] authoritative session-list probe failed for ${chamberInstanceId}:`,
          error instanceof Error ? error.message : String(error))
        return undefined
      }
    }

    /**
     * Per-source purged-row suppression + verified convergence (design 24
     * §21, state machine in shared/purged-tracker.ts): observes the
     * authoritative archive set, tombstones the ids a shrink removed, filters
     * them out of the emitted snapshot/runtime facts, and runs the bounded
     * official refresh chain. Triggered by the bridge channel (App
     * convergence machine / archive manager) AND by the producer's own shrink
     * observation, so a request whose broadcast reached nobody is still
     * covered locally.
     */
    const purgedRows = createPurgeTracker({
      refresh: officialSessionRefresh,
      listedSummaryIds,
      probe: authoritativeListedIds,
      // A probe-confirmed release must re-publish BOTH channels: sync()
      // re-reports runtime facts (the suppressed id's running/pending/
      // completed/current facts were dropped) and queues the snapshot.
      onRelease: () => { sync() },
      warn: (message) => { console.warn(`[chamber] ${message} (${chamberInstanceId})`) },
    })
    const unsubscribeSessionListRefresh = chamberBridge.onRequestSessionListRefresh((sourceId) => {
      if (sourceId !== chamberInstanceId) return
      purgedRows.converge()
    })
    // 2026-09 beta 回归修复：pending（审批/提问/plan-review）的权威 0.1.2 源是
    // 官方 ui-session 的 pending-interaction 注册表（官方 ui-workspace 侧边栏
    // 同一来源，经 useSessionPendingInteraction 消费；上游在 0.1.2 移除了
    // SessionSummary.pendingInteraction）。chamber 插件经 uiSession 服务直接
    // 订阅该注册表，把每会话 pending 状态并入运行时事实通道——侧边栏琥珀点/
    // 等待分类与 design-19 的 ask/request 通知边沿由此恢复（此前恒为 undefined）。
    // Loose 面（vendor-modules.d.ts）：仅消费 getSnapshot/subscribe 观察面。
    // 真实不变量：ui-session 是 chamber 复合 boot 的 first-screen 服务（与
    // ui-approval/ui-chat 同族），每个 chamber boot 必然存在；此处访问必然
    // 可用。指纹守卫前置是防御纵深——非 chamber boot（无 chamberInstanceId）
    // 在访问前已返回，且避免了守卫分支前的任何服务读取。
    const pendingInteractions = (ctx.uiSession as unknown as {
      pendingInteractions: {
        getSnapshot(): ReadonlyMap<string, { kind?: string }>
        subscribe(listener: () => void): () => void
      }
    }).pendingInteractions
    let snapshotSignature = ''
    let snapshotQueued = false
    let disposed = false

    const syncSnapshot = (): void => {
      snapshotQueued = false
      if (disposed) return
      const workspacesSnapshot = workspacesList.getSnapshot()
      const sessionsSnapshot = sessionsList.getSnapshot()
      const projected = projectInstanceSnapshot(workspacesSnapshot, sessionsSnapshot)
      if (projected === undefined) {
        snapshotSignature = ''
        snapshotProducer.report(undefined)
        return
      }
      // F1 (design 24 §20/§21): an authoritative archive-set shrink is the
      // client-observable "a purge completed and those ids left the set"
      // signal. The tracker tombstones the removed ids (and runs the verified
      // convergence chain); the ids are then filtered out of the EMITTED
      // snapshot until the raw summaries stop listing them.
      const armed = purgedRows.observeArchive(
        (workspacesSnapshot as { archivedSessionIds?: unknown }).archivedSessionIds,
      )
      if (armed.length > 0) {
        // Re-report runtime facts in the SAME pass (the workspace
        // subscription does not call sync()), so a purged session's
        // pending/completed facts cannot outlive its row.
        sync()
      }
      if (purgedRows.suppressed().size > 0) {
        // Reconcile against the RAW summary ids (not the projected rows: the
        // projection drops subagent-origin rows, and a tombstone must clear
        // when the official summaries stop listing the id, not when the
        // chamber projection happens not to render it).
        purgedRows.reconcile(listedSummaryIds())
      }
      const filteredSessions = purgedRows.filter(projected.sessions)
      const emitted = filteredSessions === projected.sessions
        ? projected
        : { ...projected, sessions: [...filteredSessions] }
      const nextSignature = instanceSnapshotSignature(emitted)
      if (nextSignature === snapshotSignature) return
      snapshotSignature = nextSignature
      snapshotProducer.report(emitted)
    }
    const queueSnapshot = (): void => {
      if (snapshotQueued) return
      snapshotQueued = true
      queueMicrotask(syncSnapshot)
    }
    const sync = (): void => {
      const snapshot = sessionsList.getSnapshot()
      // 06 §4.5: per-parent RUNNING subagent descendant counts (sparse — only
      // parents with at least one running descendant appear).
      const subagentRunning = new Map<string, number>()
      for (const [parentId, summary] of indexSubagentDescendants(snapshot.byId)) {
        if (summary.runningCount > 0) subagentRunning.set(parentId, summary.runningCount)
      }
      const report = projectRuntimeFacts(snapshot, subagentRunning, pendingInteractions.getSnapshot())
      // F1 同纪律：tombstoned（内容已删）的会话不得进入运行时事实通道——
      // 否则完成未读蓝点/design-19 通知边沿/徽标计数会为一个已不存在的会话
      // 武装（行虽被过滤，计数与边沿是独立消费面）。current 一并收敛，避免
      // 把一个已删会话继续当成来源当前会话。
      const suppressed = purgedRows.suppressed()
      if (suppressed.size > 0) {
        for (const id of suppressed) delete report.sessions[id]
        if (report.current !== undefined && suppressed.has(report.current)) delete report.current
      }
      runtimeProducer.report(report)
      queueSnapshot()
    }
    // v0.1.2-alpha.1: the host-description producer is REMOVED — the
    // connection handle no longer exposes `hostDescription` (host.describe
    // deleted upstream). The chamberBridge host channel was removed entirely
    // (2026-09 cleanup): the LOCAL instance's dsh version flows from the
    // desktop bridge (`window.dshChamber.dshVersion` → renderer hostFacts);
    // remote versions stay hidden until the D2 wiring lands (control-plane
    // `dsh --version` facts, P1-7).
    sync()
    queueSnapshot()
    const unsubscribeSessions = sessionsList.subscribe(sync)
    const unsubscribeWorkspaces = workspacesList.subscribe(queueSnapshot)
    // pending 注册表变化只影响运行时事实（琥珀点/通知边沿），不影响分组快照；
    // sync() 里 queueSnapshot 有签名去重兜底，重复触发无副作用。
    const unsubscribePending = pendingInteractions.subscribe(sync)
    return () => {
      disposed = true
      purgedRows.dispose()
      unsubscribeSessions()
      unsubscribeWorkspaces()
      unsubscribePending()
      unsubscribeSessionListRefresh()
      snapshotProducer.clear()
      runtimeProducer.clear()
    }
  }, 'dsh-chamber: sidebar runtime facts report')
}
