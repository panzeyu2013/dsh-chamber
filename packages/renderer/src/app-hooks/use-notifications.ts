/**
 * 通知投影 / 完成点装配簇：App.tsx 的投影回调原样抽出（含步骤 guard 与立即落盘出入口）。
 * 通知规则本体在既有纯模块（notification-projection / complete-ledger / notification-outbox /
 * notification-ledger）里；完成未读规则本体在 client-core（completion-arm.ts +
 * projectRuntimeFacts / mergeRuntimeFacts），官方 sessionStatus.completionUnread 是唯一权威。
 *
 * 本 hook 只做装配：读 refs → 步进 N-ctx 修正臂（写内存 store）→ 节流落盘通知三表。
 *
 * 完成通知：生产脊柱是 reconcile（完成观测组装 → applyObservationBatch）；native 投递
 * 只有一个出口——durable outbox（run 身份 key + 稳定 eventKey）：观测先入 journal，
 * host 的 shown/suppressed 回执才出队，失败按退避重放。无 host 身份的壳边沿在回执后记
 * runtimeSettled 待归属标记，facts 侧同一次完成按 host updatedAt 锚点认领运行身份、
 * 绝不二次发横幅。
 */
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { stepCompletionArm, type InstanceAggregate } from '@dsh-chamber/dsh-chamber-client-core'
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
import { isFactsDecisionUsable, type SessionFactsSnapshot } from '../session-facts-source.ts'
import {
  createNotificationSaveCoalescer,
  saveNotifications,
  type NotificationPayload,
  type NotificationSaveCoalescer,
  type NotificationStorageLike,
} from '../notification-store.ts'
import { createStepGate, type StepGate } from '../step-gate.ts'
import { createFactsHealthRecorder, createFactsStepGuard, type FactsHealthRecorder, type FactsStepGuard } from '../facts-health.ts'

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

export interface NotificationsDeps {
  /** 通知组装镜像：onRuntimeReport effect（依赖 []）经 ref 读取最新值。 */
  aggregates: Record<string, InstanceAggregate>
  serverLabels: Record<string, string>
  /** 唯一「正在阅读」谓词的屏上来源（paintedView 的渲染期镜像）。 */
  viewStore: ViewStore
  /** 已挂载来源的运行时事实（渲染期镜像）。 */
  liveServerIdsRef: { current: ReadonlySet<string> }
  factsStore: FactsStore
  sourceLifecyclesRef: { current: SourceOwnershipRegistry | null }
  /** 每来源每会话的上一份 channel running 位（修正臂的边沿记忆）。 */
  prevRunningRef: { current: Record<string, Record<string, boolean>> }
  /** App 的完成点 store：官方位之外只放修正臂（内存、行键控、不扫描）。 */
  completedStore: CompletedStore
  completeLedgerRef: { current: CompleteLedger }
  /** native 投递 journal（唯一 native 调用层的队列；durable）。 */
  notificationOutboxRef: { current: NotificationOutbox }
  /** 完成观测状态（v5 §3.2；与桥侧 onRuntimeReport 共用同一份 Map）。 */
  completionObservationRef: { current: Map<string, SourceObservationState> }
  /** 页代 token 与判定（§3.5；identity 与 reconcile 的 boot 都读它）。 */
  bootToken: string
  bootVerdict: 'same' | 'fresh'
  notificationStorageRef: { current: NotificationStorageLike | undefined }
  notificationSaveTimerRef: { current: ReturnType<typeof setTimeout> | null }
  /** 通知落盘入口：hook 把最新 flush 写进它（App 的 pagehide effect 读）。 */
  flushNotificationsRef: { current: () => void }
}

export interface NotificationsProjection {
  schedulePersistNotifications: () => void
  /** 完成点步进（唯一入口）：官方位在通道行上，这里只推进 N-ctx 修正臂。 */
  stepCompletionArmFor: (sourceId: string) => void
  emitSessionNotification: (request: SessionNotificationRequest) => boolean
  applySessionFacts: (sourceId: string, snapshot: SessionFactsSnapshot | undefined) => void
  /** reconcile 批次的落盘出口（immediate ⇒ 微任务合并，否则 1s 节流）。 */
  persistCompletionLedger: (immediate: boolean) => void
  /** 关键路径 flush（pagehide / hidden / unmount）：取消待办并同步落最新状态。 */
  notificationImmediateSave: NotificationSaveCoalescer
  /** 步骤级 never-throw 包装：桥面 runtime 上报等外部 listener 的失败面（同环 + 同 loud 纪律）。 */
  guardStep: FactsStepGuard
}

/** outbox 行在运行时携带的瞬时诊断/文案字段（类型面之外，随行 JSON 往返）。 */
type QueuedNotification = PendingNotification & {
  readonly title?: NotificationTitleId
  readonly origin?: string
  readonly pendingAge?: number
}

export function useNotifications(deps: NotificationsDeps): NotificationsProjection {
  const {
    aggregates, serverLabels, viewStore, factsStore, liveServerIdsRef,
    sourceLifecyclesRef, prevRunningRef,
    completedStore, completeLedgerRef, notificationOutboxRef,
    completionObservationRef, bootToken, bootVerdict,
    notificationStorageRef, notificationSaveTimerRef, flushNotificationsRef,
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

  /** 事实健康环（本 hook 的记录点：派生异常写它，never-throw；观察者不可判由生命周期 hook 采样）。 */
  const factsHealthRef = useRef<FactsHealthRecorder | null>(null)
  factsHealthRef.current ??= createFactsHealthRecorder()
  /** 步骤级 never-throw 包装：派生 / 收敛 / facts 应用与 runtime 上报的唯一失败面。 */
  const factsStepGuardRef = useRef<FactsStepGuard | null>(null)
  factsStepGuardRef.current ??= createFactsStepGuard(factsHealthRef.current)
  const factsStepGuard = factsStepGuardRef.current

  /**
   * 通知三表写盘（≤1 次/秒节流；pagehide/hidden 立即 flush）。内存是权威，键只是缓存。
   * never-throw。修正臂是纯内存，不在这里落盘。
   */
  const flushNotifications = useCallback((): void => {
    if (notificationSaveTimerRef.current !== null) {
      clearTimeout(notificationSaveTimerRef.current)
      notificationSaveTimerRef.current = null
    }
    const payload: NotificationPayload = {
      v: 1,
      notifiedRuns: completeLedgerRef.current.notifiedRunTable(),
      pending: completeLedgerRef.current.pendingTable(),
      outcomes: completeLedgerRef.current.outcomesTable(),
    }
    saveNotifications(notificationStorageRef.current, payload)
  }, [])
  flushNotificationsRef.current = flushNotifications
  /**
   * immediate 落盘的微任务合并器（OPT P1 热路径）：voided/dropped/flushed 常一波到达，逐次全量
   * prune+stringify（208KB 实测约 6.5ms）会阻塞主线程；同一 tick 的多次 immediate 只落一次盘，
   * 仍远早于下面 1s 节流。pagehide/hidden/unmount 走 flushNotifications 同步关键路径——取消待办 + 立即
   * 落最新状态，不丢也不重复。
   */
  const notificationImmediateSave = useMemo(
    () => createNotificationSaveCoalescer(() => flushNotificationsRef.current()),
    [],
  )
  const schedulePersistNotifications = useCallback((): void => {
    if (notificationSaveTimerRef.current !== null) return
    notificationSaveTimerRef.current = setTimeout(() => {
      notificationSaveTimerRef.current = null
      flushNotificationsRef.current()
    }, 1_000)
  }, [])
  /** reconcile 批次的落盘出口（immediate ⇒ 微任务合并，否则 1s 节流）。 */
  const persistCompletionLedger = useCallback((immediate: boolean): void => {
    if (immediate) notificationImmediateSave.request()
    else schedulePersistNotifications()
  }, [schedulePersistNotifications, notificationImmediateSave])

  /**
   * 一个来源的完成点步进（唯一出口的实体）：官方位经通道行呈现，本步只补 N-ctx 修正臂
   * （隐藏来源 mainView 持有的 current 行）。规则本体在 client-core completion-arm.ts；
   * "谁在阅读" 是 paintedView（屏上），不是桥发布的 activeView（选择）。
   */
  const stepArmNow = useCallback((sourceId: string): void => {
    if (sourceId !== LOCAL_INSTANCE_ID && !liveServerIdsRef.current.has(sourceId)) return
    const report = factsStore.getSnapshot().runtime[sourceId]
    const next = stepCompletionArm(
      completedStore.getSnapshot()[sourceId] ?? {},
      prevRunningRef.current[sourceId] ?? {},
      {
        current: report?.current,
        rows: report?.sessions,
        painted: viewStore.getSnapshot().painted === sourceId,
        listComplete: report?.listComplete === true,
        stale: report?.stale === true,
      },
    )
    if (!next.changed) return
    prevRunningRef.current[sourceId] = next.running
    completedStore.setSource(sourceId, next.arms)
  }, [])
  /**
   * 步进的 never-throw 出口：异常落环 + loud 一次（同旧纪律），控制流交给调用方。
   * 重入闸：本步末尾写 completedStore（useSyncExternalStore 订阅面），写入触发的同步渲染
   * 若再回调本步即成 React #185 嵌套环；闸按 id 去重、排到微任务（见 step-gate.ts）。
   */
  const stepGateRef = useRef<StepGate | null>(null)
  const stepArmGuardedRef = useRef<(sourceId: string) => void>(() => {})
  stepArmGuardedRef.current = (sourceId: string): void => {
    factsStepGuard.guard(sourceId, 'completion-arm', () => stepArmNow(sourceId))
  }
  stepGateRef.current ??= createStepGate(sourceId => { stepArmGuardedRef.current(sourceId) })
  const stepCompletionArmFor = useCallback((sourceId: string): void => {
    stepGateRef.current?.request(sourceId)
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
        // durable 身份用**投递载荷里的 host 域判别符**（host:turn/N 或水位 id），不是 outbox
        // 行自己的 runId：行可以先无锚入队、事后被 associateCompletion 补上锚，此时行身份仍是
        // 页内 nonce——写进 notifiedRuns 就永远不会被后续 facts 观察命中（身份门失效 ⇒ 重复）。
        // 行身份只用于 journal/receipt 键（宿主回执的 eventKey）；两种用途分离，不得合并。
        identityDiagnostic = diagnosed
        const identity = delivered.watermark === undefined && delivered.completionSeq === undefined
          ? undefined
          : diagnosed.runId
        if (identity === undefined) {
          completeLedgerRef.current.markRuntimeSettled(delivered.sourceId, delivered.sessionId, delivered.hostObservedAt)
        } else {
          completeLedgerRef.current.setNotifiedRun(delivered.sourceId, delivered.sessionId, identity)
          schedulePersistNotifications()
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

  /** facts 快照到达的**实体**（probe / SSE delta / resync 共用）：先按可判快照补通知证据，再走同一观测组装 + reconcile，最后推进完成点（修正臂）。 */
  const applySessionFactsNow = useCallback((sourceId: string, snapshot: SessionFactsSnapshot | undefined): void => {
    if (snapshot === undefined) {
      factsStore.dropSession(sourceId)
      // facts 通道消失 = 一次观测（running 权威回落壳行，goal 回落壳行/unknown）；不 emit，
      // 只让收敛器看到最新事实。
      reconcileCompletions(sourceId)
      return
    }
    // 完成证据关联只认可判快照（stale 快照不作证据）。
    const usable = isFactsDecisionUsable(snapshot)
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
  }, [reconcileCompletions, schedulePersistNotifications])

  /**
   * facts 快照的**唯一入口**（gateway 订阅 / 无壳观察者 / dropSession 共用）：never-throw ——
   * 应用/收敛异常落环 + loud 一次；listener 因此不可能把异常抛进 session-facts-source /
   * source-mux-facts 的 emit 环（SSE/WS 泵不被 listener 打死，也无法逃成 unhandled rejection）。
   */
  const applySessionFacts = useCallback((sourceId: string, snapshot: SessionFactsSnapshot | undefined): void => {
    factsStepGuard.guard(sourceId, 'apply-session-facts', () => applySessionFactsNow(sourceId, snapshot))
  }, [applySessionFactsNow, factsStepGuard])

  return {
    schedulePersistNotifications, stepCompletionArmFor, emitSessionNotification, applySessionFacts,
    persistCompletionLedger, notificationImmediateSave, guardStep: factsStepGuard,
  }
}
