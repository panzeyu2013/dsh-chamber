/** Registers the chamber sidebar shell (design 05 §2) into the layout-owned slot. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { indexSubagentDescendants } from '@dsh-chamber/dsh-chamber-client-core/subagent-lineage'
import type { SidebarRootInjected } from './contract/slots.ts'
import { SidebarRoot } from './SidebarRoot.tsx'
import { SidebarLeadingControls } from './SidebarLeadingControls.tsx'
import { resolveInstanceListFace } from './instance-list-face.ts'
import {
  getOpenIntent,
} from '@dsh-chamber/dsh-chamber-client-core/open-intent'
import { startEarlyOpenArm } from './early-open.ts'
import { en, zh, type SidebarKey } from './locales.ts'
import { chamberBridge, isValidProducerSourceFingerprint } from '@dsh-chamber/dsh-chamber-client-core/aggregate-store'
import {
  advanceRunIdentities,
  applyGoalActivation,
  instanceSnapshotSignature,
  projectInstanceSnapshot,
  projectRuntimeFacts,
  retainGoalFacts,
  type RunIdentityObservation,
} from '@dsh-chamber/dsh-chamber-client-core/derive'
import type { GoalFact } from '@dsh-chamber/dsh-chamber-client-core/session-row-state'
import { createGoalActivationTracker } from './goal-activation.ts'
import { createPanelSource, type SlotsReader } from './panel-source.ts'
import { createPurgeTracker } from '@dsh-chamber/dsh-chamber-client-core/purged-tracker'
import { publishSessionCreationInstrument } from '@dsh-chamber/dsh-chamber-client-core/session-create-ledger'
import {
  SessionAuthorityReconciler,
  writeBackTargets,
  type AuthorityOfficialRead,
} from '@dsh-chamber/dsh-chamber-client-core/session-fact-reconcile'
import { appendAuthorityLog, authorityLogStorage } from '@dsh-chamber/dsh-chamber-client-core/authority-log-store'
// 单一权威链：reducer 的输入类型；reducer 本体与策略都在纯包。
import type { AuthorityOfficialRow, AuthorityRead } from '@dsh-chamber/dsh-stream-state'
import { fetchInstanceSnapshot, getInstanceClient } from '@dsh-chamber/dsh-chamber-client-core/instance-api'
import {
  classifySettingsSeatOccupant, settingsSeatTakeoverMessage,
} from '@dsh-chamber/dsh-chamber-client-core/settings-shell'

export type {
  SidebarBrandMarkOwnerProps, SidebarBrandNameOwnerProps, SidebarFooterActionOwnerProps,
  SidebarPanelIconOwnerProps, SidebarPanelMetadata, SidebarRootComponentProps, SidebarRootInjected,
  SidebarSettingsOwnerProps, SidebarWorkspaceGitOwnerProps,
} from './contract/slots.ts'
export type { SidebarKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    sidebar: SidebarKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'sidebar'

/**
 * Producer-lifetime identity nonce (I1). Module scope survives a ctx remount, so a
 * new lifetime never re-mints a previous lifetime's run ids; the ms clock makes a
 * page reload's first lifetime distinct as well. Multiplying by 1000 leaves room
 * for the per-page-load registration counter without ever re-using a value
 * (a reload cannot happen inside the same millisecond as the previous module load).
 */
const PRODUCER_GENERATION_BASE = Date.now() * 1_000
let producerGenerationCounter = 0

/** Services required by the sidebar plugin. */
export const inject = ['slots', 'layout', 'sessions', 'workspaces', 'uiSession', 'uiWorkspace', 'locale', 'shortcuts']

/**
 * Registers the sidebar shell and its service callbacks. `sidebar.workspaces` stays
 * declared (as in the official shell) so ui-workspace's registration does not fail —
 * the chamber shell renders its own multi-source list in that region instead.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-chamber: sidebar dictionaries')

  // 会话创建归因的只读仪表：挂到页面全局一次（幂等）；无 IPC 即可按标签读取 blank 计数。
  ctx.effect(() => { publishSessionCreationInstrument() }, 'dsh-chamber: session-creation instrument')

  // 导航都在 ui-workspace 的跨 Controller 视图所有者服务上（官方侧边栏形态）。
  // rc.2：presentation 归视图所有者——`openSession` 用 `mainView` retain 目标并释放被替换
  // 的 reference（另写持久选择）；chamber 自己不再持有第二个 mainView reference。
  const workspaceNavigation = ctx.get('uiWorkspace') as unknown as {
    startSession(workspaceId?: Parameters<SidebarRootInjected['startSession']>[0]): void
    openSession(target: string): void
  }
  // 全局面板轴：把 `sidebar.panellist` 注册镜像成可序列化快照供壳渲染，
  // 行点击转发到 `ctx.layout.selectPanel`（两种受支持布局都声明了它）。
  const panels = createPanelSource()
  const syncPanels = (): void => { panels.sync(ctx.slots as unknown as SlotsReader) }
  ctx.effect(() => ctx.slots.subscribe('sidebar.panellist', syncPanels), 'dsh-chamber: sidebar panel entries')
  // The loose vendor Context face declares only register/bind; the real locale face is observable.
  const localeFace = ctx.locale as unknown as { subscribe(listener: () => void): () => void }
  ctx.effect(() => localeFace.subscribe(syncPanels), 'dsh-chamber: sidebar panel labels')

  const injectProps = (): SidebarRootInjected => ({
    // New Session 走本 ctx 的 Workspace UI 共享动作（当前会话工作区 → 最近工作区），始终作用于当前来源。
    startSession: (workspaceId) => { workspaceNavigation.startSession(workspaceId) },
    toggleSidebar: () => { ctx.layout.toggleSidebar() },
    // 直调：没有 `selectPanel` 的布局属配置错误（本壳只与声明了该方法的布局同载），
    // 必须响亮失败而不是静默丢点击。
    selectPanel: (id) => { ctx.layout.selectPanel(id) },
    hooks: {
      panels: panels.source,
      // Page shortcut catalog: the layout fork registers `sidebar.left.toggle`,
      // ui-workspace registers `session.new`; the seat shows each effective binding.
      shortcuts: (ctx as ClientContext & {
        shortcuts: { catalog: SidebarRootInjected['hooks']['shortcuts'] }
      }).shortcuts.catalog,
    },
    // renderer 壳在任何插件物化前装好的不可变 per-entry 事实。
    chamberInstanceId: (ctx as any).chamberInstanceId as string | undefined,
    // 应用内目录浏览器对话框文案：由 directory-picker 包（每次 boot 都挂载）拥有该命名空间。
    directoryBrowserT: ctx.locale.bind('directory-browser'),
  })
  // `'sidebar'` 由 layout 的 'root' 条目声明，其 apply 顺序相对本插件不确定：直接
  // `ctx.slots.register` 会在声明尚未注册时抛错，侧边栏壳就此缺失。因此等待声明
  // （`ctx.slots.inject(key, () => ctx.slots.register(…))`），父声明撤销时移除贡献、
  // 重新声明（HMR）后重跑；等待由 effect 持有。
  // 子声明表由 chamber 自持而非 import 上游 client 入口：(1) 官方 bundle 从不进入 chamber
  // boot，本包自建入口，上游的 apply/子表无法在此执行，仅为数据 import 会把整个客户端插件
  // 拉进本 bundle；(2) 上游 `LocaleNamespaceMap` 用它自己的 locales 声明 `sidebar: SidebarKey`，
  // 本包用自身 key 并集声明同一 map 项，两个并集按设计不同（chamber 多来源文案上游没有），
  // 同程序内二次声明即类型冲突。分歧恰是 chamber 列表自己的洞（`sidebar.workspace.git`）。
  ctx.effect(
    () => ctx.slots.inject('sidebar', () => ctx.slots.register({
      name: 'sidebar',
      locale: NS,
      children: {
        'sidebar.brand.mark': { kind: 'single', scope: 'root' },
        'sidebar.brand.name': { kind: 'single', scope: 'root' },
        'sidebar.panellist': { kind: 'list', scope: 'root' },
        'sidebar.workspaces': { kind: 'single', scope: 'root' },
        // 每工作区 Git 洞：slot 级 inject 工厂与 git 无关（只闭包 sidebar 持有的
        // occurrence context）；chamber Git 插件消费绑定的 `useWorkspaceGitContext`。
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
  // 顺序：在注册存在后发布（可能已填充的）面板列表，首帧即可见。
  syncPanels()

  // macOS 折叠（darwin + layout collapsed）下框架整列隐藏（宽 0 + `overflow:hidden`），
  // rail 的展开开关与 New Session 一起被裁掉，鼠标失去重开控件；rc.2 AppFrame 仅在该状态
  // 挂载 `shell.leading` 窗口 chrome 座（vendor AppFrame.tsx `darwin && sidebarCollapsed`）。
  // 官方 ui-sidebar 以同一 inject 面占座（HeaderLeadingControls），本 fork 走同形注册：
  // 等 `shell.leading` 声明（layout 的 root 注册提供），复用侧栏的 injectProps 与 `sidebar`
  // 命名空间，不写 id/order/priority（单席默认值，与官方一致）。
  ctx.effect(
    () => ctx.slots.inject('shell.leading', () => ctx.slots.register({
      name: 'shell.leading',
      locale: NS,
      inject: injectProps,
    }, SidebarLeadingControls)),
    'dsh-chamber: leading seat controls',
  )

  // chamber settings 壳以 RESERVED shadow 优先级占据 `sidebar.settings`；slot 规则渲染
  // 最低优先级胜者，低于该区间的注册者会静默替换整个设置面（它是连接/通用页与所有
  // per-source 插件设置段的唯一渲染者）。这里只检测（console.error）：sidebar 无法安全
  // 重钉 slot，抢占不得无声通过。官方 SettingsRoot 在优先级 0 的窗口不算抢占——
  // classifySettingsSeatOccupant 只上报低于保留区间的注册者。
  ctx.effect(() => {
    const check = (): void => {
      const winner = (ctx.slots as unknown as SlotsReader).entriesOfSlot('sidebar.settings')[0]
      if (classifySettingsSeatOccupant(winner) !== 'taken-over') return
      console.error(settingsSeatTakeoverMessage(winner?.options.id ?? 'unknown'))
    }
    check()
    return ctx.slots.subscribe('sidebar.settings', check)
  }, 'dsh-chamber: settings shell seat watchdog')

  // chamber patch (06 §4.3/§4.5): runtime-facts 通道的生产端。每次 boot 是独立 ctx 与
  // sessions store，本插件在每个 ctx 挂载、只上报本实例的事实（当前会话、pending 交互、
  // 完成、每会话 live `running`、按父 RUNNING 子代理数）；App 合并进多来源投影
  // （server.runtime）并自行派生完成未读点（它持有活动视图与全部开放请求），侧边栏从投影
  // 渲染。组件不订阅 store：首次 report 前的 boot 帧不渲染高亮。zustand subscribe 不在挂载时
  // 触发，故立即上报一次快照。生产端只保留一份自有状态：purged 行抑制集 + 校验式收敛链
  // （purge 后官方 summaries 不刷新，故过滤掉已离开归档集合的行，运行时事实通道同样只过滤
  // tombstoned id）；其余字段是源 store 的纯投影。
  // 子代理数逐字复用 vendor 的 indexSubagentDescendants（per-parent runningCount，与官方
  // ui-workspace 树同一数字），子代理运行环语义不会与官方 UI 漂移。
  ctx.effect(() => {
    const chamberInstanceId = (ctx as any).chamberInstanceId as string | undefined
    const chamberSourceFingerprint = (ctx as any).chamberSourceFingerprint as string | undefined
    if (typeof chamberInstanceId !== 'string'
      || !isValidProducerSourceFingerprint(chamberInstanceId, chamberSourceFingerprint)) return () => {}
    // 两个列表面都走与下方 `refresh()` seam 相同的守卫路径：ctx 带服务却没有 observable
    // （或代理取成员抛错）时必须 WARN 并跳过整个生产者注册——绝不注册永远无法上报、
    // 或在首次快照读就崩溃的生产者。
    const sessionsList = resolveInstanceListFace<SessionListState>(
      chamberInstanceId, 'sessions', () => ctx.sessions)
    const workspacesList = resolveInstanceListFace<WorkspaceSnapshot>(
      chamberInstanceId, 'workspaces', () => ctx.workspaces)
    if (sessionsList === undefined || workspacesList === undefined) return () => {}
    // 代际事实由 shell 的 configureContext 注入：producer 注册表按注册顺序授权，挂死后恢复的老 boot 会夺走生产权。
    const bootGeneration = (ctx as any).chamberBootGeneration as number | undefined
    const runtimeProducer = chamberBridge.registerInstanceRuntimeProducer(
      chamberInstanceId, chamberSourceFingerprint, bootGeneration)
    const snapshotProducer = chamberBridge.registerInstanceSnapshotProducer(
      chamberInstanceId, chamberSourceFingerprint, bootGeneration)
    // design 24 §12（归档清理收敛）：purge 对官方运行时不可见（宿主 session 事件是 no-op），被删
    // 会话的行滞留官方 summaries，并在 id 移出归档集后继续浮现，打开即 session/not-found。
    // `refresh()` 让 summaries 与服务端语料对账并丢弃已删行；App 侧收敛机是一次性跃迁检测器
    // （重新变脏的 push、提交态失去溯源的收缩都对它不可见），故生产端自担修复：
    //   - F1 抑制：权威收缩给被移除 id 立墓碑（宿主 `clearIds` 只含内容删除成功的树与无记录孤儿，
    //     故「离开归档集」⇔「内容已消失」）并滤出每个发出的快照，直到原始 summaries 不再列出它们；
    //   - F2 校验式收敛：同一次收缩（及每个桥请求）跑官方 refresh 后有界重试校验 id 确已离开
    //     summaries，并覆盖 refreshList 的单飞陈旧响应与瞬时错误；`refresh()` 是服务对象原型方法，
    //     必须以方法调用（分离引用会抛错并让收敛 seam 静默失效）。
    /** One official session-list refresh. */
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
     * 不会误伤事实判定。宿主目前不返回完整性标记，因此 proof = none：缺席不再作证据
     * （I5），显式 `running=false` 行仍是否定证据；等宿主给出 asOfSeq/游标后在此返回
     * 对应 proof，「缺席作证」再由 reducer 的 N=2 把关。
     */
    const readAuthorityRunning = async (): Promise<AuthorityRead | undefined> => {
      try {
        const snapshot = await fetchInstanceSnapshot(getInstanceClient(chamberInstanceId))
        const rows: Record<string, boolean> = {}
        for (const row of snapshot.sessions) rows[row.sessionId] = row.running
        return { ok: true, proof: { kind: 'none' }, rows }
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
     * tier-3 写回：把独立权威读的正面证伪写进官方 store 的公开写路径
     * （`ClientSessions.handleSessionStatus`）——一次调用同时改侧栏摘要、物化 Session 的
     * `running` 与子代理 activity，完成蓝点/通知边沿照常武装。纪律：只写 false、从不写 true，
     * 且只写权威已证伪而 store 仍 claiming running 的 id（幂等、最小写面）；写后自校验
     * （等一个宏任务再读，迟一拍重试一次）失败即记 stuck 证据、允许升级；`handleSessionStatus`
     * 非 `ISessions` 契约方法，缺席时 WARN 一次并降级到升级阶梯；host 永远赢，无 TTL、无 latch。
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
      // 等一个宏任务覆盖官方 manager 的微任务投影；再迟一拍重试一次，避免误升级。
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await new Promise(resolve => { setTimeout(resolve, 0) })
        const after = readStoreRunning()
        if (targets.every(id => after[id]?.running !== true)) return true
      }
      return false
    }

    /**
     * 独立权威行源：chamber 自己经实例代理的 unary `session.list`——每次调用重新扫盘，不受
     * 官方单飞与客户端缓存影响。仅在官方 refresh 链有界重试后仍不收敛时使用：仍列出的 id 是
     * 未被 purge 的活会话（释放抑制），省略的 id 无内容（保持抑制）。失败 ⇒ 保持抑制。
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
     * per-source purged 行抑制 + 校验式收敛（状态机在 shared/purged-tracker.ts）：观察权威
     * 归档集，给收缩移除的 id 立墓碑，滤出快照与运行时事实，并跑有界的官方 refresh 链。触发源
     * 含桥通道（App 收敛机/归档管理器）与生产端自己观察到的收缩——广播无人收到的请求仍被本地覆盖。
     */
    const purgedRows = createPurgeTracker({
      refresh: officialSessionRefresh,
      listedSummaryIds,
      probe: authoritativeListedIds,
      // 探针确认的释放必须重发两条通道：sync() 重报运行时事实（被抑制 id 的
      // running/pending/completed/current 事实已被丢弃）并排队快照。
      onRelease: () => { sync() },
      warn: (message) => { console.warn(`[chamber] ${message} (${chamberInstanceId})`) },
    })
    // pending（审批/提问/plan-review）的权威源是官方 ui-session 的 pending-interaction
    // 注册表（官方 ui-workspace 侧边栏同一来源）；此处经 uiSession 服务直接订阅，把每会话
    // pending 状态并入运行时事实通道，驱动琥珀点/等待分类与 ask/request 通知边沿。
    // 真实不变量：ui-session 是 chamber 复合 boot 的 first-screen 服务，每个 boot 必然存在；
    // 指纹守卫前置只是防御纵深，非 chamber boot 在访问服务前已返回。
    const pendingInteractions = (ctx.uiSession as unknown as {
      pendingInteractions: {
        getSnapshot(): ReadonlyMap<string, { kind?: string }>
        subscribe(listener: () => void): () => void
      }
    }).pendingInteractions
    let snapshotSignature = ''
    let snapshotQueued = false
    let disposed = false
    // I1：本生产者的运行身份记忆（sessionId → 观察到的运行 episode）。App 侧的
    // 通知边沿消费它，不再自行铸 run id。generation 是本 lifetime 独有的 nonce：
    // 重挂后 episode 重新从 1 开始，但身份不会与上一 lifetime 的 id 相同。
    const producerGeneration = PRODUCER_GENERATION_BASE + (producerGenerationCounter += 1)
    let runIdentities: ReadonlyMap<string, RunIdentityObservation> = new Map()
    // Episodes are lifetime high-water, not derived from the current snapshot: a
    // session that briefly leaves the list must not restart at episode 1 (two real
    // runs would share an id and the durable banner receipt would drop the second).
    let runEpisodes: ReadonlyMap<string, number> = new Map()
    // 会话事实单一权威的执行端：策略在包内 reducer + ladder，本类只做 I/O；先声明后装配（二者互为闭包）。
    let sessionFacts: SessionAuthorityReconciler | undefined
    /** 写回能力缺失只告警一次（永久性失败，不重试）。 */
    let warnedMissingHandleSessionStatus = false

    // design 19 §3.2.1/§3.2.2 (P1): the per-source-generation
    // last-known goal facts (unknown rows are restored from here) and the
    // event-only activation cache. Both live INSIDE this effect, so a ctx
    // remount / source-fingerprint change starts them empty — that is the
    // "generation/fingerprint 变化清空" half of the retention contract; the
    // tracker additionally clears on `connection/reset`.
    let lastKnownGoalFacts = new Map<string, GoalFact | null>()
    const goalActivation = createGoalActivationTracker({
      // NOT an added `inject` member: the service may be provided later than
      // this plugin (or throw through the cordis service proxy) — the tracker
      // try/catches and retries a bounded number of times.
      getRemote: () => (ctx as unknown as { get(name: string): unknown }).get('remote'),
      sync: () => { sync() },
      warn: (message) => { console.warn(`[chamber] ${message} (${chamberInstanceId})`) },
      onConnectionReset: (listener) => (ctx as unknown as {
        on(event: string, handler: () => void): () => void
      }).on('connection/reset', listener),
    })

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
      // F1：权威归档集收缩是「purge 完成、这些 id 离开集合」的客户端可见信号；tracker 给被
      // 移除 id 立墓碑（并跑校验式收敛链），这些 id 随后被滤出**发出的**快照，直到原始
      // summaries 不再列出它们。
      const armed = purgedRows.observeArchive(
        (workspacesSnapshot as { archivedSessionIds?: unknown }).archivedSessionIds,
      )
      if (armed.length > 0) {
        // 同一轮重报运行时事实（workspace 订阅不会调 sync()），被 purge 会话的
        // pending/completed 事实不能比它的行活得更久。
        sync()
      }
      if (purgedRows.suppressed().size > 0) {
        // 对**原始** summary id 对账（不是投影行：投影丢弃子代理行；墓碑要在官方 summaries
        // 不再列出该 id 时清除，而不是 chamber 投影恰好不渲染它时）。
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
      // per-parent RUNNING 子代理后代计数（稀疏：只出现至少一个运行中后代的父）。
      const subagentRunning = new Map<string, number>()
      for (const [parentId, summary] of indexSubagentDescendants(snapshot.byId)) {
        if (summary.runningCount > 0) subagentRunning.set(parentId, summary.runningCount)
      }
      // I1 运行身份：生产者是运行通道的唯一身份权威——每个「非运行 → 运行」的
      // 观察前沿铸一个新 episode，同一 run 的重复上报保持同一 id；运行结束的
      // 行保留最后 id（它的完成仍属于那次运行）。App 只消费，不再自己铸。
      const liveIds = new Set<string>()
      const runningIds = new Set<string>()
      const activity = new Map<string, number>()
      for (const [id, facts] of Object.entries(snapshot.byId ?? {})) {
        if (facts?.origin === 'subagent') continue
        liveIds.add(id)
        if (typeof facts?.updatedAt === 'number') activity.set(id, facts.updatedAt)
        if (facts?.running === true) runningIds.add(id)
      }
      const advancedIdentities = advanceRunIdentities({
        previous: runIdentities,
        running: runningIds,
        live: liveIds,
        sourceFingerprint: chamberSourceFingerprint,
        generation: producerGeneration,
        episodes: runEpisodes,
        activity,
      })
      runIdentities = advancedIdentities.identities
      runEpisodes = advancedIdentities.episodes
      const runIds = new Map<string, string>()
      for (const [id, observed] of runIdentities) runIds.set(id, observed.runId)
      const baseReport = projectRuntimeFacts(snapshot, subagentRunning, pendingInteractions.getSnapshot(), runIds)
      // listComplete：官方列表的 arrival phase（'pending' → 首次成功 'ready'，此后出错不回退）
      // 就是「列表是否完整」的权威事实；只有 ready 才允许 App 把缺席当删除剪掉未读（pending
      // 恒 false ⇒ 不剪枝，否则一次未完成的列表会假清未读）。它是判定输入，不进侧边栏渲染。
      baseReport.listComplete = snapshot.phase === 'ready'
      // 运行位活性守卫的回执与事实同源上报：只有「对账拿不到结论」才允许升级 reconnect。
      const authority = sessionFacts?.snapshot()
      const report = authority === undefined
        ? baseReport
        : { ...baseReport, sessionAuthority: authority }
      // F1 同纪律：tombstoned 会话不得进入运行时事实通道（否则完成未读蓝点/通知边沿/徽标
      // 计数会为一个已不存在的会话武装）；current 一并收敛，避免继续当成来源当前会话。
      const suppressed = purgedRows.suppressed()
      if (suppressed.size > 0) {
        for (const id of suppressed) delete report.sessions[id]
        if (report.current !== undefined && suppressed.has(report.current)) delete report.current
      }
      // design 19 §3.2.1/§3.2.2 (P1): restore the last-known goal
      // fact for rows whose projection key was absent (unknown), then refresh the
      // activation cache against this pass (running bidirectional / goal
      // projection changes are the tracker's refresh triggers — it prunes the
      // cache in place, so the merge below carries the pruned result) and merge
      // the event-cached activation into the known goal facts. All three are
      // no-ops for a report whose rows carry no goal facts.
      lastKnownGoalFacts = retainGoalFacts(report, lastKnownGoalFacts)
      goalActivation.observe(report, lastKnownGoalFacts)
      applyGoalActivation(report, sessionId => goalActivation.activationOf(sessionId))
      runtimeProducer.report(report)
      queueSnapshot()
    }
    // 宿主描述生产者有意缺席：连接句柄不暴露 `hostDescription`（上游已删 host.describe），
    // chamberBridge 也无该通道；本地实例的 dsh 版本走桌面桥，远程版本在控制面事实落地前保持隐藏。
    // 执行端装配 + tick 通道订阅（二者互为闭包）。App 每 30s 发 tick，probe ladder
    // 决定这一拍是否真的读权威。
    sessionFacts = new SessionAuthorityReconciler({
      now: () => Date.now(),
      // 代际指纹：变化即重置所有 episode（代际围栏由 reducer 持有）。
      generation: () => chamberSourceFingerprint ?? chamberInstanceId ?? '',
      readOfficial: readOfficialProjection,
      readAuthority: readAuthorityRunning,
      // tier-3 写回：契约内纠正不了时把权威结论写进官方 store 的公开写路径。
      correct: correctAuthorityRunning,
      // 每个动作一份机内持久证据（Local Storage 有界环，跨重载可回读）；写入失败 fail-soft，绝不影响权威链。
      record: (entry) => {
        const storage = authorityLogStorage()
        if (storage !== undefined) appendAuthorityLog(storage, chamberInstanceId, entry)
      },
      warn: (message) => { console.warn(`[chamber] ${message} (${chamberInstanceId})`) },
      onSettled: () => { sync() },
    })
    const unsubscribeSessionListRefresh = chamberBridge.onRequestSessionListRefresh((sourceId) => {
      if (sourceId !== chamberInstanceId) return
      // 本通道现在是 App 的 30s tick（真实 cadence 由执行端 ladder 决定），故归档收敛只在
      // 确有被抑制行时启动，否则每拍白跑一次官方 refresh（宿主 disk walk）；收缩自身的 converge
      // 在 `observeArchive` 内启动，不受本闸影响，无抑制集时也没有可收敛对象。
      if (purgedRows.suppressed().size > 0) purgedRows.converge()
      // L1 对账复用同一条广播通道（App 看不到官方 store，只能请求重跑官方 session.list）。
      sessionFacts?.request()
    })
    // The subscription is started AFTER `sync` exists (a synchronous remote
    // service can deliver before the const initializes otherwise), and before
    // the first report so an already-armed event can land on the first pass.
    goalActivation.start()
    sync()
    queueSnapshot()
    const unsubscribeSessions = sessionsList.subscribe(sync)
    const unsubscribeWorkspaces = workspacesList.subscribe(queueSnapshot)
    // pending 注册表变化只影响运行时事实（琥珀点/通知边沿）；sync() 内 queueSnapshot 有签名去重兜底，重复触发无副作用。
    const unsubscribePending = pendingInteractions.subscribe(sync)
    return () => {
      disposed = true
      goalActivation.dispose()
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

  // chamber patch (design 05 §2.2): BOOT-TIME early-open arm——决策逻辑（deadline、give-up、
  // refused-open、live-intent 读取）在 ./early-open.ts；这里只提供 ctx 绑定的 seam 并把 arm 绑给 ctx。
  ctx.effect(() => {
    const chamberInstanceId = (ctx as any).chamberInstanceId as string | undefined
    if (typeof chamberInstanceId !== 'string' || chamberInstanceId === '') return () => {}
    // 本 arm 在页面级、按 sourceId 键控的 intent 上**改动宿主**（官方视图所有者
    // `uiWorkspace.openSession`），因此必须与上面的 runtime-facts producer 一样证明来源身份
    //（同一个不可变 Context 证明）：否则旧化身、或恰好同 id 的另一 boot 的 intent，会在当前
    // 挂载的壳里被打开。
    const chamberSourceFingerprint = (ctx as any).chamberSourceFingerprint as string | undefined
    if (!isValidProducerSourceFingerprint(chamberInstanceId, chamberSourceFingerprint)) return () => {}
    return startEarlyOpenArm({
      instanceId: chamberInstanceId,
      readIntent: () => getOpenIntent(chamberInstanceId),
      /** 面缺席/敌意时静默退役 arm（同 ctx 的 runtime-facts producer 已为该缺陷响亮告警，
       *  本 arm 契约上 best-effort）；`false`（面可读、id 缺席）则继续轮询。 */
      isAddressable: (sessionId) => {
        try {
          const snapshot = ctx.sessions.list.getSnapshot() as { byId?: Record<string, unknown> } | undefined
          // ABSENT 面（无 list observable，或快照无 `byId`）⇒ `undefined` = 静默退役，本 arm 的
          // 契约。刻意不走 `resolveInstanceListFace`（该助手响亮 WARN，而同 ctx 的 producer 已为
          // 服务面缺陷告警）；可读但空的面（`byId: {}`）是 `false`（继续轮询），由下一行处理。
          if (snapshot?.byId === undefined) return undefined
          return snapshot.byId[sessionId] !== undefined
        } catch {
          return undefined
        }
      },
      // 服务对象上的方法调用，绝不用分离引用（同官方 refresh() seam 的纪律）。
      // rc.2：走官方视图所有者而不是裸 retain——只有 ui-workspace.openSession 会把
      // mainReference 立起来，官方初始导航策略因此看到「已有当前会话」并放弃新建 blank。
      open: (sessionId) => { workspaceNavigation.openSession(sessionId) },
      warn: (message) => { console.warn(`[chamber] ${message}`) },
    })
  }, 'dsh-chamber: boot-time session open intent')
}
