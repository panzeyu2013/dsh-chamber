/**
 * 通知 / 未读投影簇：App.tsx 的投影回调原样抽出（含步骤 guard 与立即落盘出入口，共 7 个成员）。
 * 规则本体全部在既有纯模块
 * （unread-derivation / unread-store / notification-projection / complete-ledger /
 * notification-ledger）里；本 hook 只做装配：读 refs → 推进读水位 → 派生未读 →
 * 写回 store → 节流落盘。
 *
 * 完成通知：生产脊柱是 reconcile（完成观测组装 → applyObservationBatch）；native 投递
 * 只有一个出口——durable outbox（run 身份 key + 稳定 eventKey）：观测先入 journal，
 * host 的 shown/suppressed 回执才出队，失败按退避重放。无 host 身份的壳边沿在回执后记
 * runtimeSettled 待归属标记，facts 侧同一次完成按 host updatedAt 锚点认领运行身份、
 * 绝不二次发横幅。
 */
import { useCallback, useEffect, useMemo, useRef } from 'react'
import {
  deriveUnread,
  reconcileCompletedFacts,
  type InstanceAggregate,
} from '@dsh-chamber/dsh-chamber-client-core'
import type { CompletedStore } from '../host/completed-store.ts'
import type { ViewStore } from '../host/view-store.ts'
import type { FactsStore } from '../host/facts-store.ts'
import type { CompleteLedger } from '../complete-ledger.ts'
import {
  applyObservationBatch,
  completionIdentity,
  factsChannelOf,
  observeSource,
  type SourceObservationState,
} from '../completion-observation.ts'
import type { SourceOwnershipRegistry } from '../deep-link-activation.ts'
import { LOCAL_INSTANCE_ID } from '../local-instance.ts'
import { frameText, readDocumentLocale } from '../locales.ts'
import { notificationIdentityOf, notificationRunId } from '../notification-identity.ts'
import { notificationLedger, publishNotificationInstrument } from '../notification-ledger.ts'
import type { DeliveryOutcome, NotificationOutbox, PendingNotification } from '../notification-outbox.ts'
import type { NotificationTitleId } from '../notification-projection.ts'
import { completionWatermark } from '../watermark.ts'
import { factsDecisionInput, isFactsDecisionUsable, type SessionFactsSnapshot, type SessionFactsSource } from '../session-facts-source.ts'
import {
  advanceReadMark,
  createUnreadSaveCoalescer,
  maxWatermark,
  mergeReadMarks,
  saveUnread,
  saveUnreadShadow,
  type UnreadSaveCoalescer,
  type UnreadStorageLike,
  type UnreadV4Payload,
  createUnreadStepGate,
  type UnreadStepGate,
} from '../unread-store.ts'
import { createFactsHealthRecorder, createFactsStepGuard, type FactsHealthRecorder, type FactsStepGuard } from '../facts-health.ts'
import { recordUnreadShadowReport } from '../unread-instrument.ts'
import { publishUnreadInstrument, sampleUnreadRows, unreadInstrument } from '../unread-instrument.ts'
import { deriveSourceUnread, factsBaselineSeed, viewingReadWatermark } from '../unread-derivation.ts'

/**
 * 通知组装请求（唯一组装点 emitSessionNotification 的入参）：watermark 是 host 域内容
 * 水位，进 renderer 身份键（主进程 claim 键的第五元组）；runId 是运行身份（facts 入口
 * 与 reconcile 出口带上）；origin 是收敛器诊断；title 是标题身份（goal-completed /
 * goal-blocked / goal-stopped 各有独立 locale 键，缺省 = 会话已完成）；pendingAge 是
 * pending 存续毫秒诊断；hostObservedAt 是该边沿观测到的 host updatedAt（outbox 的
 * 跨通道关联锚点，facts 入口 = row.updatedAt）。
 */
export type SessionNotificationRequest = {
  sourceId: string
  sourceFingerprint: string
  sessionId: string
  kind: 'complete' | 'ask' | 'request'
  watermark?: number
  completionSeq?: number
  /** 运行身份：facts / reconcile 入口带上；壳边沿缺省时由 outbox 解析。 */
  runId?: string
  title?: NotificationTitleId
  origin?: string
  pendingAge?: number
  hostObservedAt?: number
}

export interface UnreadNotificationsDeps {
  /** 通知组装镜像：onRuntimeReport effect（依赖 []）经 ref 读取最新值。 */
  aggregates: Record<string, InstanceAggregate>
  serverLabels: Record<string, string>
  /** 唯一「正在阅读」谓词的屏上来源（paintedView 的渲染期镜像）。 */
  viewStore: ViewStore
  /** 已挂载来源的运行时事实（渲染期镜像）。 */
  liveServerIdsRef: { current: ReadonlySet<string> }
  factsStore: FactsStore
  sessionFactsSourcesRef: { current: Map<string, SessionFactsSource> }
  sourceLifecyclesRef: { current: SourceOwnershipRegistry | null }
  /** 每来源每会话的上一份 channel running 位（蓝点机边沿记忆）。 */
  prevRunningRef: { current: Record<string, Record<string, boolean>> }
  completedStore: CompletedStore
  readMarksRef: { current: Record<string, Record<string, number>> }
  completeLedgerRef: { current: CompleteLedger }
  /** native 投递 journal（唯一 native 调用层的队列；durable）。 */
  notificationOutboxRef: { current: NotificationOutbox }
  /** 完成观测状态（v5 §3.2；与桥侧 onRuntimeReport 共用同一份 Map）。 */
  completionObservationRef: { current: Map<string, SourceObservationState> }
  /** 页代 token 与判定（§3.5；identity 与 reconcile 的 boot 都读它）。 */
  bootToken: string
  bootVerdict: 'same' | 'fresh'
  unreadStorageRef: { current: UnreadStorageLike | undefined }
  unreadSaveTimerRef: { current: ReturnType<typeof setTimeout> | null }
  /** 读标记落盘入口：hook 把最新 flushUnread 写进它（App 的 pagehide effect 读）。 */
  flushUnreadRef: { current: () => void }
  clientInstallIdRef: { current: string }
}

export interface UnreadNotifications {
  schedulePersistUnread: () => void
  recomputeSourceUnread: (sourceId: string) => void
  emitSessionNotification: (request: SessionNotificationRequest) => boolean
  applySessionFacts: (sourceId: string, snapshot: SessionFactsSnapshot | undefined) => void
  /** reconcile 批次的落盘出口（immediate ⇒ 微任务合并，否则 1s 节流）。 */
  persistCompletionLedger: (immediate: boolean) => void
  /** 关键路径 flush（pagehide / hidden / unmount）：取消待办并同步落最新状态。 */
  unreadImmediateSave: UnreadSaveCoalescer
  /** 步骤级 never-throw 包装：桥面 runtime 上报等外部 listener 的失败面（同环 + 同 loud 纪律）。 */
  guardUnreadStep: FactsStepGuard
}

/** outbox 行在运行时携带的瞬时诊断/文案字段（类型面之外，随行 JSON 往返）。 */
type QueuedNotification = PendingNotification & {
  readonly title?: NotificationTitleId
  readonly origin?: string
  readonly pendingAge?: number
}

export function useUnreadNotifications(deps: UnreadNotificationsDeps): UnreadNotifications {
  const {
    aggregates, serverLabels, viewStore, factsStore, liveServerIdsRef,
    sessionFactsSourcesRef, sourceLifecyclesRef, prevRunningRef,
    completedStore, readMarksRef, completeLedgerRef, notificationOutboxRef,
    completionObservationRef, bootToken, bootVerdict,
    unreadStorageRef, unreadSaveTimerRef, flushUnreadRef, clientInstallIdRef,
  } = deps

  // 通知事件组装镜像（设计 19）：onRuntimeReport effect（依赖 []）经 ref 读取最新
  // aggregates/serverLabels——effect 闭包拿不到 state/useMemo（与 commit 同步，
  // 微任务/事件回调安全；注册表投影已由 host/remotes-store.ts 承担同一职责）。
  const aggregatesRef = useRef(aggregates)
  aggregatesRef.current = aggregates
  const serverLabelsRef = useRef(serverLabels)
  serverLabelsRef.current = serverLabels

  /**
   * 本拍由 outbox 待发壳边沿认领的会话（associateCompletion 返回 true）。facts 组装与
   * reconcile 在同一个同步调用里先后发生：认领过的完成由 pending 边沿投递，reconcile
   * 的 facts 候选必须让行（否则同一次完成会以两条身份各入一次 journal）。消费即清。
   */
  const pendingOutboxClaimsRef = useRef<ReadonlySet<string>>(new Set())

  /**
   * 首见基线播种标记（每来源**化身**一次，值 = 播种时的化身身份 = owner token 对象）：
   * 语义、化身判据与被否决的近似全部在 unread-derivation.ts `factsBaselineSeed`（design 19 §3.7.1）；
   * 本 hook 只负责 refs 与落盘。
   */
  const factsBaselineSeedRef = useRef<Record<string, unknown>>({})

  /** 事实健康环（本 hook 的记录点：派生异常写它，never-throw；观察者不可判由生命周期 hook 采样）。 */
  const factsHealthRef = useRef<FactsHealthRecorder | null>(null)
  factsHealthRef.current ??= createFactsHealthRecorder()
  /** 步骤级 never-throw 包装：派生 / 收敛 / facts 应用与 runtime 上报的唯一失败面。 */
  const factsStepGuardRef = useRef<FactsStepGuard | null>(null)
  factsStepGuardRef.current ??= createFactsStepGuard(factsHealthRef.current)
  const factsStepGuard = factsStepGuardRef.current

  /**
   * 读标记 / 退避账本写盘（≤1 次/秒节流；pagehide/hidden 立即 flush）。内存是权威，
   * v4 只是缓存，服务端是跨端权威。never-throw。
   */
  const flushUnread = useCallback((): void => {
    if (unreadSaveTimerRef.current !== null) {
      clearTimeout(unreadSaveTimerRef.current)
      unreadSaveTimerRef.current = null
    }
    const payload: UnreadV4Payload = {
      v: 4,
      read: readMarksRef.current,
      edge: completedStore.getSnapshot(),
      notifiedRuns: completeLedgerRef.current.notifiedRunTable(),
      pending: completeLedgerRef.current.pendingTable(),
      outcomes: completeLedgerRef.current.outcomesTable(),
    }
    saveUnread(unreadStorageRef.current, payload)
    // W3 影子写：同一意图投影成 v5 写另一个键（只写不读；失败绝不影响 v4 权威），
    // 并记录读回净化后的等价性报告（`__dshChamberUnread.shadow()`）——ok=false 时不得切权威。
    const shadow = saveUnreadShadow(unreadStorageRef.current, payload)
    recordUnreadShadowReport({
      phase: 'write',
      written: shadow.written,
      ok: shadow.parity?.ok ?? false,
      differences: shadow.parity?.differences ?? (shadow.written ? [] : ['shadow-not-written']),
    })
  }, [])
  flushUnreadRef.current = flushUnread
  /**
   * immediate 落盘的微任务合并器（OPT P1 热路径）：voided/dropped/flushed 常一波到达，逐次全量
   * prune+stringify（208KB 实测约 6.5ms）会阻塞主线程；同一 tick 的多次 immediate 只落一次盘，
   * 仍远早于下面 1s 节流。pagehide/hidden/unmount 走 flushUnread 同步关键路径——取消待办 + 立即
   * 落最新状态，不丢也不重复。
   */
  const unreadImmediateSave = useMemo(
    () => createUnreadSaveCoalescer(() => flushUnreadRef.current()),
    [],
  )
  const schedulePersistUnread = useCallback((): void => {
    if (unreadSaveTimerRef.current !== null) return
    unreadSaveTimerRef.current = setTimeout(() => {
      unreadSaveTimerRef.current = null
      flushUnreadRef.current()
    }, 1_000)
  }, [])
  /** reconcile 批次的落盘出口（immediate ⇒ 微任务合并，否则 1s 节流）。 */
  const persistCompletionLedger = useCallback((immediate: boolean): void => {
    if (immediate) unreadImmediateSave.request()
    else schedulePersistUnread()
  }, [schedulePersistUnread, unreadImmediateSave])

  /**
   * 一个来源的未读派生（唯一出口的实体）：判定规则全部来自 unread-derivation.ts。
   * 本体只负责 读 refs → 读动作推进 → 派生 → 写回 refs/state → 落盘/ack；异常兜底在
   * recomputeSourceUnread 的 never-throw 包装里。
   */
  const deriveSourceUnreadNow = useCallback((sourceId: string): void => {
    if (sourceId !== LOCAL_INSTANCE_ID && !liveServerIdsRef.current.has(sourceId)) return
    const factsSnapshot = factsStore.getSnapshot().session[sourceId]
    // 可判 facts = 唯一判据元组（session-facts-source 拥有）：行键与 verified 同源同拍。
    // 渲染用 isFactsUsable 更宽（含 stale）；判定面必须用这一支（stale 快照的行不得当证据）。
    const factsDecision = factsDecisionInput(factsSnapshot)
    const factsRows = factsDecision.rows
    const report = factsStore.getSnapshot().runtime[sourceId]
    // 唯一「正在阅读」谓词：paintedView（屏上是谁，不是选择）
    // ∩ 该来源 current ∩ document.hasFocus()。失焦即视为未读。
    const readingCurrent = viewStore.getSnapshot().painted === sourceId && document.hasFocus()
      ? report?.current
      : undefined
    if (readingCurrent !== undefined && factsRows !== undefined) {
      const watermark = viewingReadWatermark(factsRows[readingCurrent])
      if (watermark !== undefined) {
        const table = readMarksRef.current[sourceId] ?? {}
        const advanced = advanceReadMark(table[readingCurrent], watermark)
        if (advanced !== undefined && advanced !== table[readingCurrent]) {
          readMarksRef.current = { ...readMarksRef.current, [sourceId]: { ...table, [readingCurrent]: advanced } }
          schedulePersistUnread()
          sessionFactsSourcesRef.current.get(sourceId)?.ackRead(clientInstallIdRef.current, readingCurrent, advanced)
        }
      }
    }
    // W0 读数（只读旁路）：播种输入水位与保护集规模——「read 为空」的第一现场。
    const factsRead = { through: 0, consumed: false, keepUnread: 0 }
    if (factsRows !== undefined) {
      factsRead.through = maxWatermark(factsRows)
      factsRead.keepUnread = Object.keys(completedStore.getSnapshot()[sourceId] ?? {}).length
      const seed = factsBaselineSeed({
        factsRows,
        // 化身身份 = owner token 的**对象身份**（SourceOwnershipRegistry 的唯一权威）；
        // 无 owner 时回落页代 token（与旧实现的 fallback 同一形状，但判据是身份而非指纹）。
        incarnation: sourceLifecyclesRef.current?.capture(sourceId) ?? bootToken,
        seededIncarnation: factsBaselineSeedRef.current[sourceId],
        readMarks: readMarksRef.current[sourceId] ?? {},
        keepUnread: completedStore.getSnapshot()[sourceId] ?? {},
      })
      if (seed.seeded) {
        factsRead.consumed = true
        // 有界化：清理**只在播种那一拍**（seed.seeded）执行，真实上界 = 曾播种来源数，下一次播种拍
        // 才收敛到当时的 roster（liveServerIdsRef 是既有的挂载输入，不引入第二套身份判据）。
        for (const id of Object.keys(factsBaselineSeedRef.current)) {
          if (!liveServerIdsRef.current.has(id)) delete factsBaselineSeedRef.current[id]
        }
        factsBaselineSeedRef.current[sourceId] = seed.incarnation
        readMarksRef.current = { ...readMarksRef.current, [sourceId]: seed.readMarks }
        schedulePersistUnread()
      }
      // W0 判词语义：consumed = **本化身的基线镜像是否已落地**（本拍播种，或此前拍已播种且化身未换）。
      // 只在「刚播种那一拍」置 true 会把健康稳态误判成 M2：实测（隔离实例 + 真实 renderer）在播种后的
      // 每一拍都报 m2-seed-not-consumed，而水位与 unread 都已就位。判据下沉到纯模块的 alreadySeeded。
      factsRead.consumed = seed.seeded || seed.alreadySeeded
    }
    const result = deriveSourceUnread({
      facts: factsRows,
      channel: report?.sessions,
      // 只有权威完整列表（listComplete === true 且通道在场）才允许剪枝；缺省/未证明 = 不剪。
      listComplete: report?.listComplete === true,
      prevRunning: prevRunningRef.current[sourceId] ?? {},
      prevLedger: completedStore.getSnapshot()[sourceId] ?? {},
      readMarks: readMarksRef.current[sourceId] ?? {},
      readingSessionId: readingCurrent,
      // 规则 0（判定闸）：快照缺席 = channel-only 照常派生；在场但不可判只冻 facts 的结论
      // （不结算/剪枝/clobber，通道边沿照常），只有通道也缺席才原样返回 prevLedger。全文见 design 19 §3.7.1。
      factsVerified: factsDecision.verified,
    }, { deriveUnread, reconcileCompletedFacts })
    prevRunningRef.current[sourceId] = result.nextRunning
    completedStore.setSource(sourceId, result.unread)
    // W0 仪表（只读；unread-instrument.ts）：每次派生留一条——分支 / 行数 / 最大水位 / 行样本 /
    // 读表规模 / 播种读数 / 结果计数。使「read 为空」当场可判：M1 = 水位为 0；M2 = 水位可用而写入未发生。
    publishUnreadInstrument()
    unreadInstrument.record({
      at: Date.now(),
      sourceId,
      branch: factsRows !== undefined ? 'facts' : report?.sessions !== undefined ? 'channel' : 'freeze',
      factsVerified: factsDecision.verified,
      rows: factsRows === undefined ? 0 : Object.keys(factsRows).length,
      maxWatermark: factsRead.through,
      sample: sampleUnreadRows(factsRows),
      readMarks: Object.keys(readMarksRef.current[sourceId] ?? {}).length,
      seed: factsRead,
      ...(unreadStepGateRef.current === null ? {} : { gate: unreadStepGateRef.current.stats() }),
      unread: Object.keys(result.unread).length,
      running: Object.values(result.nextRunning).filter(Boolean).length,
      changed: result.changed,
    })
    if (!result.changed) return
    schedulePersistUnread()
  }, [schedulePersistUnread])

  /**
   * 一个来源的未读派生（唯一入口）：never-throw —— 派生/接线异常不得打死未读面与账本
   * （保持上一拍状态），loud 一次并落进事实健康环（createFactsStepGuard）：诊断不破账本链，
   * 异常也不许静默（静默异常正是「账本 8 小时为空而外面什么都看不到」的成因形状）。
   */
  /**
   * 派生步骤的**重入闸**（W1 M2，见 `createUnreadStepGate`）：派生体末尾写 `completedStore`
   * （`useSyncExternalStore` 订阅面）。实机证据：该写入触发的 React 同步更新再回调派生 ⇒
   * 「派生 → 写 store → 同步渲染 → 派生」嵌套环，React 以 #185 中止、被步骤守卫吞掉后**整拍作废**
   * ⇒ `read`/`edge` 永不落盘（9 天 18 份存储全空 + `unread-derive-error`）。闸把重入请求按 id 去重、
   * 排到微任务：派生体永不嵌套，非重入路径（桥事件/effect）保持同步执行、行为不变。
   */
  const unreadStepGateRef = useRef<UnreadStepGate | null>(null)
  // 经 ref 转发，闸始终调用最新的派生闭包（useCallback 依赖变化时不持有旧状态）。
  const deriveGuardedRef = useRef<(sourceId: string) => void>(() => {})
  deriveGuardedRef.current = (sourceId: string): void => {
    factsStepGuard.guard(sourceId, 'derive-unread', () => deriveSourceUnreadNow(sourceId))
  }
  unreadStepGateRef.current ??= createUnreadStepGate(sourceId => { deriveGuardedRef.current(sourceId) })
  const recomputeSourceUnread = useCallback((sourceId: string): void => {
    unreadStepGateRef.current?.request(sourceId)
  }, [])

  const pumpNotificationsRef = useRef<() => void>(() => {})
  const notificationRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (notificationRetryTimerRef.current !== null) clearTimeout(notificationRetryTimerRef.current)
  }, [])

  /** One native call site. The outbox owns the event until an honest host result arrives. */
  const sendPending = (entry: QueuedNotification): boolean => {
    const lifecycle = sourceLifecyclesRef.current?.capture(entry.sourceId)
    if (lifecycle === null || lifecycle === undefined) return false
    if (lifecycle.fingerprint !== entry.sourceFingerprint) {
      notificationOutboxRef.current.forget(entry.key)
      return true
    }
    const attempt = notificationOutboxRef.current.begin(entry.key)
    if (attempt === null) return true
    // 遮挡/隐藏证据门：hasFocus 在窗口被遮挡/最小化的平台上仍可能为 true，
    // 只有「本文档可见」才能诚实地宣称用户正在看这个会话；否则不抑制横幅。
    const requireHidden = viewStore.getSnapshot().painted === entry.sourceId
      && factsStore.getSnapshot().runtime[entry.sourceId]?.current === entry.sessionId
      && document.hasFocus()
      && document.visibilityState === 'visible'
    const ledgerBase = {
      at: Date.now(), sourceId: entry.sourceId, sessionId: entry.sessionId, kind: entry.kind,
      ...(entry.watermark === undefined ? {} : { watermark: entry.watermark }), requireHidden,
      // 收敛器诊断随主进程回执入账（held/flushed 的来源与暂存时长可直接回读）。
      ...(entry.origin === undefined ? {} : { origin: entry.origin }),
      ...(entry.pendingAge === undefined ? {} : { pendingAge: entry.pendingAge }),
    } as const
    /** W2 身份诊断：本条 complete 回执所用的身份与来源（无回执载荷时 undefined）。 */
    let identityDiagnostic: { runId: string; source: string } | undefined
    const settle = (outcome: DeliveryOutcome, error?: string): void => {
      const result = notificationOutboxRef.current.settle(attempt, outcome)
      if (!result.accepted) return
      const delivered = result.delivered
      if (delivered?.kind === 'complete') {
        // One durable write: the run identity the facts projection will compute for
        // this completion. A runtime edge without any host-domain evidence has no
        // identity yet - mark it pending so the next facts snapshot adopts its run
        // id through the runtimeSettled branch without notifying again.
        // W2 身份诊断：同一次计算既用于持久写，也进台账（identitySource 让「哪条分支产出的身份」可读）。
        const diagnosed = notificationIdentityOf({
          sourceFingerprint: delivered.sourceFingerprint,
          sessionId: delivered.sessionId,
          ...(delivered.completionSeq === undefined ? {} : { completionSeq: delivered.completionSeq }),
          ...(delivered.watermark === undefined ? {} : { watermark: delivered.watermark }),
        })
        identityDiagnostic = diagnosed
        const identity = delivered.watermark === undefined && delivered.completionSeq === undefined
          ? undefined
          : diagnosed.runId
        if (identity === undefined) {
          completeLedgerRef.current.markRuntimeSettled(delivered.sourceId, delivered.sessionId, delivered.hostObservedAt)
        } else {
          completeLedgerRef.current.setNotifiedRun(delivered.sourceId, delivered.sessionId, identity)
          schedulePersistUnread()
        }
      }
      notificationLedger.record({
        ...ledgerBase,
        decision: outcome === 'shown' ? 'sent' : outcome === 'suppressed' ? 'suppressed' : 'skipped',
        ...(error === undefined ? {} : { error }),
        ...(identityDiagnostic === undefined
          ? {}
          : { identity: identityDiagnostic.runId, identitySource: identityDiagnostic.source }),
      })
      publishNotificationInstrument()
      pumpNotificationsRef.current()
    }
    const bridge = window.dshChamber?.notifications
    if (bridge === undefined) {
      settle('retryable', 'no-notification-bridge')
      return true
    }
    try {
      const copyLocale = readDocumentLocale()
      const label = serverLabelsRef.current[entry.sourceId] ?? entry.sourceId
      const aggregate = aggregatesRef.current[entry.sourceId]
      const sessionTitle = (sessionId: string): string => {
        const row = aggregate?.sessions.find(session => session.sessionId === sessionId)
        const display = row?.displayTitle
        if (display !== undefined && display !== '') return display
        if (row?.title !== undefined && row.title !== '') return row.title
        return frameText(copyLocale, 'session.untitled')
      }
      // 标题身份（v5 §3.4/§4）：complete 的缺省标题是「会话已完成」（onComplete 语义不变）；
      // 目标标题每个 goalId 至多一次，由收敛器的 outcomes 一次性身份决定。ask/request 文案不变。
      const completeTitle =
        entry.title === 'goal-completed' ? frameText(copyLocale, 'notification.goalCompleted')
        : entry.title === 'goal-blocked' ? frameText(copyLocale, 'notification.goalBlocked')
        : entry.title === 'goal-stopped' ? frameText(copyLocale, 'notification.goalStopped')
        : frameText(copyLocale, 'notification.sessionComplete')
      const title =
        entry.kind === 'complete' ? completeTitle
        : entry.kind === 'ask' ? frameText(copyLocale, 'notification.awaitingAnswer')
        : frameText(copyLocale, 'notification.awaitingApproval')
      const native = bridge.notify({
        sourceId: entry.sourceId, sourceFingerprint: entry.sourceFingerprint,
        sessionId: entry.sessionId, kind: entry.kind, title,
        body: label + ' · ' + sessionTitle(entry.sessionId), requireHidden,
        eventKey: entry.key,
        ...(entry.watermark === undefined ? {} : { watermark: entry.watermark }),
        ...(entry.origin === undefined ? {} : { origin: entry.origin }),
        ...(entry.pendingAge === undefined ? {} : { pendingAge: entry.pendingAge }),
      })
      // The host owns an earlier deadline, but a broken IPC hop must not hold
      // this outbox entry in flight forever. The stable eventKey lets a retry
      // recognize an already shown banner at the host.
      let timer: ReturnType<typeof setTimeout> | undefined
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('notification reply deadline')), 60_000)
      })
      void Promise.race([native, deadline])
        .then(result => settle(result.outcome, result.error), error => settle('retryable', String(error)))
        .finally(() => { if (timer !== undefined) clearTimeout(timer) })
    } catch (error) {
      settle('retryable', String(error))
    }
    return true
  }

  pumpNotificationsRef.current = (): void => {
    if (notificationRetryTimerRef.current !== null) clearTimeout(notificationRetryTimerRef.current)
    notificationRetryTimerRef.current = null
    let waitingForLifecycle = false
    for (const entry of notificationOutboxRef.current.due() as QueuedNotification[]) {
      if (!sendPending(entry)) waitingForLifecycle = true
    }
    const nextAt = notificationOutboxRef.current.nextDueAt()
    if (nextAt !== null) {
      const delay = waitingForLifecycle ? Math.max(5_000, nextAt - Date.now()) : Math.max(1, nextAt - Date.now())
      notificationRetryTimerRef.current = setTimeout(() => pumpNotificationsRef.current(), delay)
    }
  }
  // A reload may restore pending delivery without producing a fresh edge.
  // Start the journal pump independently of facts/runtime callbacks; it waits
  // for source lifecycle ownership when the roster has not hydrated yet.
  useEffect(() => { pumpNotificationsRef.current() }, [])

  /** Both runtime and facts edges enter the same durable delivery journal. */
  const emitSessionNotification = useCallback((request: SessionNotificationRequest): boolean => {
    if (request.kind === 'complete' && request.runId !== undefined) {
      // One identity check: this exact run is already accounted for (a sentinel is
      // never equal to a live run id, so a migrated session still emits once).
      if (completeLedgerRef.current.notifiedRun(request.sourceId, request.sessionId) === request.runId) return true
    }
    if (notificationOutboxRef.current.enqueue(request) === null) {
      notificationLedger.record({
        at: Date.now(), sourceId: request.sourceId, sessionId: request.sessionId,
        kind: request.kind, requireHidden: false, decision: 'skipped', error: 'notification-outbox-full',
      })
      publishNotificationInstrument()
      return false
    }
    pumpNotificationsRef.current()
    return true
  }, [])

  /**
   * 完成观测组装 + 收敛的**实体**（facts 轨的唯一入口；壳轨在桥的 onRuntimeReport 里用同一
   * 对纯函数，壳行经 factsStore.runtime 同步镜像可见）。每份观测都跑 reconcile（§3.3）；
   * 每次处置/清 pending/撤回都按 §3.5 落盘。never-throw 出口是同名的 reconcileCompletions。
   *
   * D1 移植（身份门 / settleFence 等价门）：reconcile 出口的 complete 先算运行身份——
   * 已交付过的 run 不再发；被本拍 pending 壳边沿认领的会话让行；无 host 身份的运行时
   * 完成已获原生回执（runtimeSettled）且 facts 行不晚于锚点 ⇒ 只认领身份不重发。
   */
  const reconcileCompletionsNow = useCallback((sourceId: string): void => {
    const owner = sourceLifecyclesRef.current?.capture(sourceId)
    if (owner === null || owner === undefined) return
    const pendingClaims = pendingOutboxClaimsRef.current
    pendingOutboxClaimsRef.current = new Set()
    const snapshot = factsStore.getSnapshot()
    const report = snapshot.runtime[sourceId]
    const batch = observeSource({
      state: completionObservationRef.current.get(sourceId),
      sourceId,
      identity: completionIdentity(owner.fingerprint, bootToken),
      pageBoot: bootVerdict,
      ...(report === undefined
        ? {}
        : { shell: { rows: report.sessions, ...(report.stale === true ? { stale: true } : {}) } }),
      facts: factsChannelOf(snapshot.session[sourceId]),
    })
    completionObservationRef.current.set(sourceId, batch.state)
    applyObservationBatch({
      ledger: completeLedgerRef.current,
      sourceId,
      batch,
      sink: {
        emitNotification: (notification, result) => {
          const runId = notification.kind !== 'complete' ? undefined : notificationRunId({
            sourceFingerprint: owner.fingerprint,
            sessionId: notification.sessionId,
            ...(notification.completionSeq === undefined ? {} : { completionSeq: notification.completionSeq }),
            ...(notification.watermark === undefined ? {} : { watermark: notification.watermark }),
          })
          if (notification.kind === 'complete' && runId !== undefined) {
            // 身份门：同一运行已经交付过（迁移哨兵绝不等值于活身份，迁移会话仍发一次）。
            if (completeLedgerRef.current.notifiedRun(sourceId, notification.sessionId) === runId) return
            // 本拍 pending 壳边沿已认领这次完成：它自己会投递（同 key 幂等），facts 侧让行。
            if (pendingClaims.has(notification.sessionId)) return
            const settled = completeLedgerRef.current.runtimeSettled(sourceId)
            if (settled.has(notification.sessionId)) {
              const anchor = settled.get(notification.sessionId)
              // 刻意的**原始行**读（不经 factsDecisionInput）：这一处只做「同一次完成的抑制」，
              // 既不能武装也不能推进任何账本，可判性门对它没有语义（缺行/不可判时 factsRow
              // undefined ⇒ 早退条件为假 ⇒ 让行，与 suppress-only 的方向一致）。任何会**武装**
              // 分叉的读必须走 session-facts-source 的判据元组。
              const factsRow = snapshot.session[sourceId]?.rows[notification.sessionId]
              // 锚点缺失（无 host 时间）或 facts 行不晚于锚点 = 同一次完成：认领不重发。
              // 行严格更新 ⇒ 属于下一轮运行，照常通知。
              if (anchor === undefined || (factsRow !== undefined && factsRow.updatedAt <= anchor)) {
                completeLedgerRef.current.setNotifiedRun(sourceId, notification.sessionId, runId)
                persistCompletionLedger(true)
                return
              }
            }
          }
          emitSessionNotification({
            sourceId,
            sourceFingerprint: owner.fingerprint,
            sessionId: notification.sessionId,
            kind: notification.kind,
            ...(notification.watermark === undefined ? {} : { watermark: notification.watermark }),
            ...(notification.completionSeq === undefined ? {} : { completionSeq: notification.completionSeq }),
            ...(notification.title === undefined ? {} : { title: notification.title }),
            ...(notification.origin === undefined ? {} : { origin: notification.origin }),
            ...(result.pendingAge === undefined ? {} : { pendingAge: result.pendingAge }),
            ...(runId === undefined ? {} : { runId }),
          })
        },
        countDisposition: outcome => notificationLedger.countReconcile(outcome),
        persist: immediate => persistCompletionLedger(immediate),
      },
    })
  }, [emitSessionNotification, persistCompletionLedger, factsStore, completionObservationRef, completeLedgerRef, sourceLifecyclesRef, bootToken, bootVerdict])

  /** never-throw 出口：收敛异常落环 + loud 一次，控制流交给调用方继续（apply 出口仍会重算派生）。 */
  const reconcileCompletions = useCallback((sourceId: string): void => {
    factsStepGuard.guard(sourceId, 'reconcile-completions', () => reconcileCompletionsNow(sourceId))
  }, [reconcileCompletionsNow, factsStepGuard])

  /** facts 快照到达的**实体**（probe / SSE delta / resync 共用）：先合服务端读水位，再走同一观测组装 + reconcile，最后重算未读。 */
  const applySessionFactsNow = useCallback((sourceId: string, snapshot: SessionFactsSnapshot | undefined): void => {
    if (snapshot === undefined) {
      factsStore.dropSession(sourceId)
      // facts 通道消失 = 一次观测（running 权威回落壳行，goal 回落壳行/unknown）；不 emit，
      // 只让收敛器看到最新事实。
      reconcileCompletions(sourceId)
      recomputeSourceUnread(sourceId)
      return
    }
    // 同一可判谓词：read 水位合并与完成证据关联都只认可判快照（stale 的 read 是旧读数）。
    const usable = isFactsDecisionUsable(snapshot)
    if (usable && snapshot.read !== null) {
      const local = readMarksRef.current[sourceId] ?? {}
      const merged = mergeReadMarks(local, snapshot.read.marks)
      if (merged !== local) {
        readMarksRef.current = { ...readMarksRef.current, [sourceId]: merged }
        schedulePersistUnread()
      }
    }
    factsStore.setSession(prev => (prev[sourceId] === snapshot ? prev : { ...prev, [sourceId]: snapshot }))
    if (usable) {
      // 关联锚点：给待发的壳完成补上 facts 证据（内容水位 + 事件序 + host updatedAt），
      // 让 outbox 的同一次完成只有一个 key；被认领的会话交给 pending 边沿投递。
      const lifecycle = sourceLifecyclesRef.current?.capture(sourceId)
      const pendingSessions = new Set<string>()
      for (const row of Object.values(snapshot.rows)) {
        if (lifecycle === null || lifecycle === undefined
            || row.completedAtSource !== 'observed' || row.completedAt === null) continue
        const watermark = completionWatermark(row)
        if (watermark === undefined) continue
        const seq = row.lastTurnEnd?.seq
        const completionSeq = typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 0 ? seq : undefined
        // One evidence object: the content watermark plus the facts row's own host
        // updatedAt anchor. The outbox never compares completedAt against the
        // runtime edge's updatedAt - that cross-domain fence refused the same
        // run's frame and let this projection enqueue a second banner.
        const observed = {
          watermark,
          ...(completionSeq === undefined ? {} : { completionSeq }),
          hostUpdatedAt: row.updatedAt,
        }
        // One call answers both halves: claim/stamp the pending runtime edge AND gate
        // this facts edge, so the two can never disagree about one completion.
        if (notificationOutboxRef.current.associateCompletion(
          sourceId, lifecycle.fingerprint, row.sessionId, observed,
        )) pendingSessions.add(row.sessionId)
      }
      pendingOutboxClaimsRef.current = pendingSessions
    }
    // 同一观测组装缝：facts 候选（observed + 播种 + 水位严格前进）与壳行 goal 的结算都在
    // reconcile 里裁决——接线层不再有第二 planner。
    reconcileCompletions(sourceId)
    recomputeSourceUnread(sourceId)
  }, [reconcileCompletions, recomputeSourceUnread, schedulePersistUnread])

  /**
   * facts 快照的**唯一入口**（gateway 订阅 / 无壳观察者 / dropSession 共用）：never-throw ——
   * 应用/收敛异常落环 + loud 一次；listener 因此不可能把异常抛进 session-facts-source /
   * source-mux-facts 的 emit 环（SSE/WS 泵不被 listener 打死，也无法逃成 unhandled rejection）。
   */
  const applySessionFacts = useCallback((sourceId: string, snapshot: SessionFactsSnapshot | undefined): void => {
    factsStepGuard.guard(sourceId, 'apply-session-facts', () => applySessionFactsNow(sourceId, snapshot))
  }, [applySessionFactsNow, factsStepGuard])

  return {
    schedulePersistUnread, recomputeSourceUnread, emitSessionNotification, applySessionFacts,
    persistCompletionLedger, unreadImmediateSave, guardUnreadStep: factsStepGuard,
  }
}
