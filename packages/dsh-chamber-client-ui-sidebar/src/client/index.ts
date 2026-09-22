/** Registers the chamber sidebar shell (design 05 §2) into the layout-owned slot. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { indexSubagentDescendants } from '../shared/subagent-lineage.ts'
import type { SidebarRootInjected } from './contract/slots.ts'
import { SidebarRoot } from './SidebarRoot.tsx'
import { resolveInstanceListFace } from './instance-list-face.ts'
import {
  getOpenIntent,
} from '../shared/open-intent.ts'
import { startEarlyOpenArm } from './early-open.ts'
import { en, zh, type SidebarKey } from './locales.ts'
import { chamberBridge, isValidProducerSourceFingerprint } from '../shared/aggregate-store.ts'
import {
  instanceSnapshotSignature,
  projectInstanceSnapshot,
  projectRuntimeFacts,
} from '../shared/derive.ts'
import { createPanelSource } from './panel-source.ts'
import { createPurgeTracker } from '../shared/purged-tracker.ts'
import { publishSessionCreationInstrument } from '../shared/session-create-ledger.ts'
import {
  SessionAuthorityReconciler,
  writeBackTargets,
  type AuthorityOfficialRead,
} from '../shared/session-fact-reconcile.ts'
import { appendAuthorityLog, authorityLogStorage } from '../shared/authority-log-store.ts'
// P2 单一权威链：reducer 的输入类型（reducer 本体在纯包，策略不在本包）。
import type { AuthorityOfficialRow, AuthorityRead } from '@dsh-chamber/dsh-stream-state'
import { fetchInstanceSnapshot, getInstanceClient } from '../shared/instance-api.ts'
import {
  classifySettingsSeatOccupant, settingsSeatTakeoverMessage,
} from '../shared/settings-shell.ts'

export type {
  SidebarBrandMarkOwnerProps, SidebarBrandNameOwnerProps, SidebarFooterActionOwnerProps,
  SidebarPanelIconOwnerProps, SidebarPanelMetadata, SidebarRootComponentProps, SidebarRootInjected,
  SidebarSettingsOwnerProps, SidebarWorkspaceGitOwnerProps,
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

  // 把会话创建归因的只读仪表挂到页面全局**一次**——验收
  // 脚本/CDP 直接读按标签聚合的 blank 计数与「无标签外来源」断言，不需要 IPC。
  ctx.effect(() => { publishSessionCreationInstrument() }, 'dsh-chamber: session-creation instrument')

  // chamber: `workspaces.startSession` lives on the
  // ui-workspace cross-Controller navigation service (official sidebar shape).
  const workspaceNavigation = ctx.get('uiWorkspace') as unknown as {
    startSession(workspaceId?: Parameters<SidebarRootInjected['startSession']>[0]): void
  }
  // Global panel axis: mirror `sidebar.panellist` registrations into a
  // serializable snapshot the shell renders, and forward row clicks to
  // `ctx.layout.selectPanel` (present in every supported layout: both the
  // chamber fork and the official ui-layout declare it).
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
    // Select the global main panel addressed by a sidebar row. Direct
    // call: a layout without `selectPanel` is a misconfiguration (the sidebar
    // shell only ever loads beside the chamber layout fork, and the official
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
  // The parent declaration gate: `'sidebar'` is declared by
  // the layout's 'root' entry, whose apply order against this plugin is not
  // fixed — a bare `ctx.slots.register` into it throws whenever the layout has
  // not registered yet, and the sidebar shell would simply be missing. Upstream
  // waits for the declaration instead (`ui-sidebar/src/client/index.ts:73`,
  // `ui-conversation/src/client/apply.ts:388`,
  // `ui-settings-general/src/client/index.ts:146` — all
  // `ctx.slots.inject(key, () => ctx.slots.register(…))`), which also removes
  // the contribution when the parent declaration collapses and re-runs it after
  // a redeclaration (HMR). The effect keeps owning the wait.
  // The runtime children declaration below stays CHAMBER-OWNED instead
  // of being imported from the upstream client entry. Two independent reasons:
  // (1) the official bundle never loads in a chamber boot — the chamber
  // composite builds this package's own entry, so upstream's `apply`/children
  // table cannot be executed here, and importing it for its data alone would
  // pull a whole client plugin (its apply, its inject list, its registrations)
  // into this bundle; (2) upstream's `LocaleNamespaceMap` declares `sidebar:
  // SidebarKey` from ITS locales module, and this package declares the same map
  // entry from its OWN key union — the two unions are different by design (the
  // chamber shell carries multi-source copy upstream never has), so a second
  // declaration in one program is a type collision. The declaration is
  // therefore duplicated here, deliberately, and the divergence is exactly the
  // chamber list's own holes (`sidebar.workspace.git`).
  ctx.effect(
    () => ctx.slots.inject('sidebar', () => ctx.slots.register({
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
    }, SidebarRoot)),
    'dsh-chamber: sidebar slot registration',
  )
  // Upstream order: publish the (possibly already populated) panel list after
  // the registration exists, so the first render sees it.
  syncPanels()

  // chamber: the chamber settings shell
  // owns `sidebar.settings` at the RESERVED shadow priority (sidebar shared
  // face settings-shell.ts). The slot rule renders the lowest-priority winner,
  // so a registrant BELOW that range would silently replace the whole settings
  // surface — the only renderer of the connections/general pages and of every
  // per-source plugin settings section. Detection only (console.error, the
  // assertSingletonModule precedent): the sidebar cannot safely re-pin a slot
  // cell, and a takeover must not pass unnoticed. The official SettingsRoot at
  // priority 0 (the deferred-cluster window before the chamber shell registers)
  // is NOT a takeover — classifySettingsSeatOccupant only reports registrants
  // that went below the reserved range.
  ctx.effect(() => {
    const check = (): void => {
      const winner = ctx.slots.entriesOfSlot('sidebar.settings')[0]
      if (classifySettingsSeatOccupant(winner) !== 'taken-over') return
      console.error(settingsSeatTakeoverMessage(winner?.options.id ?? 'unknown'))
    }
    check()
    return ctx.slots.subscribe('sidebar.settings', check)
  }, 'dsh-chamber: settings shell seat watchdog')

  // chamber patch (06 §4.3/§4.5): the runtime-facts channel's producer end.
  // Every boot is its own ctx with its own sessions store, so this plugin —
  // mounted in every ctx — reports THIS instance's runtime facts (current
  // session, pending interactions, completions, every session's live
  // `running` bit, and per-parent RUNNING subagent counts from the vendor
  // lineage index) to the chamber bridge. The App layer merges the report
  // into the multi-source projection (server.runtime) and derives the
  // completed-but-unread dots itself (it owns the active view and every open
  // request — see App.tsx); the sidebar renders dots/highlights from the
  // projection for every source. The component does not subscribe to the
  // store itself; boot frames before the first report simply render no
  // highlight (06 §4.3). zustand subscribe does not fire on mount, so the
  // snapshot is reported immediately. The producer keeps exactly ONE piece of
  // its own state: the purged-row suppression set + its verified convergence
  // chain (design 24 §12 — purge 后官方 summaries 不刷新，生产端因此过滤掉
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
    // Both list faces are read through the same guarded
    // path as the `refresh()` seam below — a ctx that carries the services
    // without their observables (or whose proxy throws for the member) must
    // WARN and skip the whole producer registration, never register producers
    // that can never report or die on the first snapshot read.
    const sessionsList = resolveInstanceListFace<SessionListState>(
      chamberInstanceId, 'sessions', () => ctx.sessions)
    const workspacesList = resolveInstanceListFace<WorkspaceSnapshot>(
      chamberInstanceId, 'workspaces', () => ctx.workspaces)
    if (sessionsList === undefined || workspacesList === undefined) return () => {}
    // 代际事实由 shell 的 configureContext 注入：页面的 producer 注册表按注册
    // 顺序授权，挂死后恢复的老 boot 会夺走生产权。
    const bootGeneration = (ctx as any).chamberBootGeneration as number | undefined
    const runtimeProducer = chamberBridge.registerInstanceRuntimeProducer(
      chamberInstanceId, chamberSourceFingerprint, bootGeneration)
    const snapshotProducer = chamberBridge.registerInstanceSnapshotProducer(
      chamberInstanceId, chamberSourceFingerprint, bootGeneration)
    // design 24 §12 (archive-cleanup convergence): this ctx's OFFICIAL session
    // client (`ctx.sessions` — ClientSessions) is requested to re-run its
    // session-list refresh. The
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
    // The App-side convergence machine (see shared/purged-rows.ts) is a
    // ONE-SHOT transition detector — it can only
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
     * `TypeError: Cannot read properties of undefined`, silently making the
     * §12 convergence seam a no-op.
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
        // 同步抛错是**可重试**的瞬时失败（代理/客户端状态窗口），与「方法不存在」
        // 的永久失败必须区分：返回 rejected promise 让对账链走有界重试，而不是
        // 被当成「seam 缺失」直接结算失败。
        console.warn(`[chamber] session list refresh for ${chamberInstanceId} threw synchronously:`,
          error instanceof Error ? error.message : String(error))
        return Promise.reject(error instanceof Error ? error : new Error(String(error)))
      }
    }

    /** Ids still listed by the OFFICIAL summaries (the convergence probe). */
    const listedSummaryIds = (): Set<string> => {
      const byId = (sessionsList.getSnapshot() as { byId?: Record<string, unknown> }).byId ?? {}
      return new Set(Object.keys(byId))
    }

    /** 官方 store 的 byId 投影（本轮判定与写回共用的唯一事实读）。 */
    const readStoreRunning = (): Record<string, { running?: boolean; origin?: string }> =>
      (sessionsList.getSnapshot() as {
        byId?: Record<string, { running?: boolean; origin?: string }>
      }).byId ?? {}

    /**
     * 权威读（单一权威链，design 14 §D4）：控制面 HTTP 代理上的一次独立 unary
     * `session.list` —— 与被守卫的 WS 事实通道是**两条载体**，因此一次 502/代理重启
     * 不会误伤事实判定。返回 `complete: true`：宿主 unary list 是全量列表，缺席因此
     * 是证据；「缺席作证」由 reducer 的 N=2（两次独立读一致）把关。
     */
    const readAuthorityRunning = async (): Promise<AuthorityRead | undefined> => {
      try {
        const snapshot = await fetchInstanceSnapshot(getInstanceClient(chamberInstanceId))
        const rows: Record<string, boolean> = {}
        for (const row of snapshot.sessions) rows[row.sessionId] = row.running
        return { ok: true, complete: true, rows }
      } catch (error) {
        console.warn(`[chamber] authority probe failed for ${chamberInstanceId} (no verdict this round):`,
          error instanceof Error ? error.message : String(error))
        return undefined
      }
    }

    /** 官方 store 的投影（reducer 每轮 tick 的输入；子代理行由 reducer 忽略）。 */
    const readOfficialProjection = (): AuthorityOfficialRead => {
      const byId = readStoreRunning()
      const rows: Record<string, AuthorityOfficialRow> = {}
      for (const [sessionId, row] of Object.entries(byId)) {
        rows[sessionId] = {
          running: row?.running === true,
          ...(row?.origin === 'subagent' ? { subagent: true } : {}),
        }
      }
      const snapshot = sessionsList.getSnapshot() as { phase?: string }
      return { rows, listComplete: snapshot.phase === 'ready' }
    }

    /**
     * tier-3 写回（design 14 §D4）：把独立权威读的**正面证伪**写进
     * 官方 store 自己的公开写路径（`ClientSessions.handleSessionStatus`）——一次调用
     * 同时改侧栏摘要、物化 Session 的 `running`（聊天面「深度求索中」）与子代理
     * activity，并让完成蓝点/通知边沿照常武装。
     *
     * 纪律：
     *  - **只写 false，从不写 true**；只写权威已确认证伪、且此刻 store 仍 claiming
     *    running 的 id（幂等、最小写面）；
     *  - **写后自校验**：store 是 manager 通知的微任务投影，等一个宏任务再读；投影迟一
     *    拍时再等一拍，之后仍非全部掉落才算失败（失败 ⇒ 执行器记 stuck 证据，允许升级）；
     *  - **能力守卫**：`handleSessionStatus` 是上游公开但**非 `ISessions` 契约**的方法面
     *    （`contract/sessions.ts` 只暴露 `refresh()`），缺席时 WARN 一次并降级到升级
     *    阶梯，绝不静默；
     *  - **host 永远赢**：后续任何成功的官方基线与状态事件都能覆盖写入，无 TTL、无 latch。
     */
    const correctAuthorityRunning = async (sessionIds: readonly string[]): Promise<boolean> => {
      const targets = writeBackTargets(new Set(sessionIds), readStoreRunning())
      if (targets.length === 0) return true
      const service = ctx.sessions as unknown as {
        handleSessionStatus?: (sessionId: string, running: boolean) => void
      }
      if (typeof service.handleSessionStatus !== 'function') {
        if (!warnedMissingHandleSessionStatus) {
          warnedMissingHandleSessionStatus = true
          console.warn(`[chamber] official session client exposes no handleSessionStatus() (${chamberInstanceId}) — `
            + 'authoritative running-bit write-back is unavailable; falling back to the reconnect/reload ladder')
        }
        return false
      }
      try {
        for (const id of targets) service.handleSessionStatus(id, false)
      } catch (error) {
        console.warn(`[chamber] authoritative write-back threw for ${chamberInstanceId}:`,
          error instanceof Error ? error.message : String(error))
        return false
      }
      // 自校验：等一个宏任务覆盖官方 manager 的微任务投影；投影再迟一拍时重试一次，
      // 免得把「尚未 flush」记成失败而误升级。
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await new Promise(resolve => { setTimeout(resolve, 0) })
        const after = readStoreRunning()
        if (targets.every(id => after[id]?.running !== true)) return true
      }
      return false
    }

    /**
     * INDEPENDENT authoritative row source (design 24 §12 terminal step): the
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
     * §12, state machine in shared/purged-tracker.ts): observes the
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
    // pending（审批/提问/plan-review）的权威源是官方 ui-session 的
    // pending-interaction 注册表（官方 ui-workspace 侧边栏同一来源，经
    // useSessionPendingInteraction 消费）；chamber 插件经 uiSession 服务直接
    // 订阅该注册表，把每会话 pending 状态并入运行时事实通道——侧边栏琥珀点/
    // 等待分类与 design-19 的 ask/request 通知边沿由它驱动。
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
    // 会话事实单一权威的执行端（P2）：策略在包内 reducer + ladder，本类只做 I/O。
    // 先声明后装配：sync() 要读它的快照，而它的 onSettled 又要回调 sync()。
    let sessionFacts: SessionAuthorityReconciler | undefined
    /** 写回能力缺失只告警一次（永久性失败，不重试）。 */
    let warnedMissingHandleSessionStatus = false

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
      // F1 (design 24 §12): an authoritative archive-set shrink is the
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
      const baseReport = projectRuntimeFacts(snapshot, subagentRunning, pendingInteractions.getSnapshot())
      // listComplete：官方 session list 的 arrival phase 就是
      // 「本列表是否完整」的权威事实——listPhase 初值 'pending'，首次列表成功时置
      // 'ready'，此后出错不回退（vendor
      // dsh-api-session-controller/lib/types/client/sessions/manager.js:41,387）。
      // 只有 ready 才允许 App 把「缺席」当删除剪掉未读；pending 恒 false ⇒ 不剪枝
      // （否则一次尚未完成的列表会把未读假清）。它是判定输入，不进侧边栏渲染。
      baseReport.listComplete = snapshot.phase === 'ready'
      // 运行位活性守卫的回执与事实同源上报：守卫据它区分「宿主确实还在跑」
      // 与「对账拿不到结论」（只有后者允许升级 reconnect）。
      const authority = sessionFacts?.snapshot()
      const report = authority === undefined
        ? baseReport
        : { ...baseReport, sessionAuthority: authority }
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
    // The host-description producer is deliberately absent: the connection
    // handle does not expose `hostDescription` (host.describe is deleted
    // upstream), and the chamberBridge host channel does not exist. The LOCAL
    // instance's dsh version flows from the desktop bridge
    // (`window.dshChamber.dshVersion` → renderer hostFacts); remote versions
    // stay hidden until the control-plane `dsh --version` facts land.
    // 执行端装配 + tick 通道订阅（与 sync 同批：它的 onSettled 需要 sync()，而
    // sync() 需要读它的快照，二者互为闭包）。App 每 30s 发一次 tick，执行端的 probe
    // ladder 决定这一拍是否真的读权威（60s 门槛/200s 节拍/10min ≤3 次）。
    sessionFacts = new SessionAuthorityReconciler({
      now: () => Date.now(),
      // 代际指纹：变化即重置所有 episode（代际围栏由 reducer 持有）。
      generation: () => chamberSourceFingerprint ?? chamberInstanceId ?? '',
      readOfficial: readOfficialProjection,
      readAuthority: readAuthorityRunning,
      // tier-3 写回：权威正面证伪而契约内纠正不了时，把结论写进官方 store 自己的
      // 公开写路径（design 14 §D4）。
      correct: correctAuthorityRunning,
      // P5：每个动作一份机内持久证据（Local Storage 有界环，跨重载可回读）；
      // 诊断写入失败绝不影响权威链（appendAuthorityLog 内部 fail-soft）。
      record: (entry) => {
        const storage = authorityLogStorage()
        if (storage !== undefined) appendAuthorityLog(storage, chamberInstanceId, entry)
      },
      warn: (message) => { console.warn(`[chamber] ${message} (${chamberInstanceId})`) },
      onSettled: () => { sync() },
    })
    const unsubscribeSessionListRefresh = chamberBridge.onRequestSessionListRefresh((sourceId) => {
      if (sourceId !== chamberInstanceId) return
      // P2：本通道现在是 App 的 30s tick（probe 的真实 cadence 由执行端 ladder 决定），
      // 所以归档收敛只在**确有被抑制的行**时启动——否则每拍都会白跑一次官方 refresh
      // （宿主 disk walk）。归档收缩自身的 converge 在 `observeArchive` 内启动，
      // 不受本闸影响；无抑制集时也没有可收敛的对象。
      if (purgedRows.suppressed().size > 0) purgedRows.converge()
      // 运行位活性守卫的 L1 对账复用同一条广播通道（App 侧看不到官方 store，
      // 只能通过它请求重跑官方 session.list）。
      sessionFacts?.request()
    })
    sync()
    queueSnapshot()
    const unsubscribeSessions = sessionsList.subscribe(sync)
    const unsubscribeWorkspaces = workspacesList.subscribe(queueSnapshot)
    // pending 注册表变化只影响运行时事实（琥珀点/通知边沿），不影响分组快照；
    // sync() 里 queueSnapshot 有签名去重兜底，重复触发无副作用。
    const unsubscribePending = pendingInteractions.subscribe(sync)
    return () => {
      disposed = true
      sessionFacts?.dispose()
      purgedRows.dispose()
      unsubscribeSessions()
      unsubscribeWorkspaces()
      unsubscribePending()
      unsubscribeSessionListRefresh()
      snapshotProducer.clear()
      runtimeProducer.clear()
    }
  }, 'dsh-chamber: sidebar runtime facts report')

  // chamber patch (design 05 §2.2): the BOOT-TIME early-open arm. The decision
  // logic (deadline,
  // give-up, refused-open handling, live-intent read) lives in
  // ./early-open.ts and is unit-tested there; this effect only supplies the
  // ctx-bound seams and ties the arm's life to the ctx.
  ctx.effect(() => {
    const chamberInstanceId = (ctx as any).chamberInstanceId as string | undefined
    if (typeof chamberInstanceId !== 'string' || chamberInstanceId === '') return () => {}
    // This arm MUTATES the host (`sessions.open`) on a
    // page-wide, sourceId-KEYED intent, so it must prove the source identity
    // exactly like the runtime-facts producer above (the same immutable Context
    // proof shell.ts binds, `isValidProducerSourceFingerprint`): without the
    // guard, an intent slot naming this source id from a previous incarnation —
    // or from a wholly unrelated boot that happens to share the id — would be
    // opened inside whichever shell is mounted here now.
    const chamberSourceFingerprint = (ctx as any).chamberSourceFingerprint as string | undefined
    if (!isValidProducerSourceFingerprint(chamberInstanceId, chamberSourceFingerprint)) return () => {}
    return startEarlyOpenArm({
      instanceId: chamberInstanceId,
      readIntent: () => getOpenIntent(chamberInstanceId),
      /** An absent/hostile face retires the arm silently: the same ctx's
       *  runtime-facts producer already warns loudly for that defect, and this
       *  arm is best-effort by contract. `false` (face readable, id absent)
       *  keeps the arm polling. */
      isAddressable: (sessionId) => {
        try {
          const snapshot = ctx.sessions.list.getSnapshot() as { byId?: Record<string, unknown> } | undefined
          // An ABSENT face (no service list observable, or
          // a snapshot without a `byId` map) ⇒ `undefined` = "retire silently",
          // which is this arm's contract. Deliberately NOT routed through
          // `resolveInstanceListFace`: that helper WARNS loudly, and the same
          // ctx's runtime-facts producer already runs it (and warns) for the
          // service-face defect, while the arm is best-effort/silent by contract
          // — do not "fix" this into the helper. A readable-but-EMPTY face
          // (`byId: {}`) is `false` (keep polling), handled by the next line.
          if (snapshot?.byId === undefined) return undefined
          return snapshot.byId[sessionId] !== undefined
        } catch {
          return undefined
        }
      },
      // Method call on the service object, never a detached reference (same
      // discipline as the official refresh() seam in the producer above).
      open: (sessionId) => { ctx.sessions.open(sessionId) },
      warn: (message) => { console.warn(`[chamber] ${message}`) },
    })
  }, 'dsh-chamber: boot-time session open intent')
}
