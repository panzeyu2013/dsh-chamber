/**
 * 通知 / 未读投影簇：App.tsx 的 5 个投影回调原样抽出。规则本体全部在既有纯模块
 * （unread-derivation / unread-store / notification-projection / complete-ledger /
 * notification-ledger）里；本 hook 只做装配：读 refs → 推进读水位 → 派生未读 →
 * 写回 refs/state → 节流落盘 / 通知唯一组装点。
 */
import { useCallback, useMemo, useRef } from 'react'
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
import { notificationLedger, publishNotificationInstrument } from '../notification-ledger.ts'
import type { NotificationTitleId } from '../notification-projection.ts'
import { isFactsUsable, type SessionFactsSnapshot, type SessionFactsSource } from '../session-facts-source.ts'
import {
  advanceReadMark,
  createUnreadSaveCoalescer,
  mergeReadMarks,
  saveUnread,
  type UnreadSaveCoalescer,
  type UnreadStorageLike,
} from '../unread-store.ts'
import { deriveSourceUnread, viewingReadWatermark } from '../unread-derivation.ts'

/**
 * 通知组装请求（唯一组装点 emitSessionNotification 的入参）：watermark 是 host 域内容水位，
 * 进 renderer 身份键（主进程 claim 键的第五元组）；origin 是收敛器 ¤origin¤ 诊断；title 是
 * 标题身份（v5 §3.4/§4：goal-completed / goal-blocked / goal-stopped 各有独立 locale 键，
 * 缺省 = 会话已完成）；pendingAge 是 pending 存续毫秒诊断（随主进程回执入账）。
 */
export type SessionNotificationRequest = {
  sourceId: string
  sourceFingerprint: string
  sessionId: string
  kind: 'complete' | 'ask' | 'request'
  watermark?: number
  title?: NotificationTitleId
  origin?: string
  pendingAge?: number
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
  emitSessionNotification: (request: SessionNotificationRequest) => void
  applySessionFacts: (sourceId: string, snapshot: SessionFactsSnapshot | undefined) => void
  /** reconcile 批次的落盘出口（immediate ⇒ 微任务合并，否则 1s 节流）。 */
  persistCompletionLedger: (immediate: boolean) => void
  /** 关键路径 flush（pagehide / hidden / unmount）：取消待办并同步落最新状态。 */
  unreadImmediateSave: UnreadSaveCoalescer
}

export function useUnreadNotifications(deps: UnreadNotificationsDeps): UnreadNotifications {
  const {
    aggregates, serverLabels, viewStore, factsStore, liveServerIdsRef,
    sessionFactsSourcesRef, sourceLifecyclesRef, prevRunningRef,
    completedStore, readMarksRef, completeLedgerRef, completionObservationRef,
    unreadStorageRef, unreadSaveTimerRef, flushUnreadRef, clientInstallIdRef,
    bootToken, bootVerdict,
  } = deps

  // 通知事件组装镜像（设计 19）：onRuntimeReport effect（依赖 []）经 ref 读取最新
  // aggregates/serverLabels——effect 闭包拿不到 state/useMemo（与 commit 同步，
  // 微任务/事件回调安全；注册表投影已由 host/remotes-store.ts 承担同一职责）。
  const aggregatesRef = useRef(aggregates)
  aggregatesRef.current = aggregates
  const serverLabelsRef = useRef(serverLabels)
  serverLabelsRef.current = serverLabels

  /**
   * 读标记 / 退避账本写盘（≤1 次/秒节流；pagehide/hidden 立即 flush）。内存是权威，
   * v2 只是缓存，服务端是跨端权威。never-throw。
   */
  const flushUnread = useCallback((): void => {
    if (unreadSaveTimerRef.current !== null) {
      clearTimeout(unreadSaveTimerRef.current)
      unreadSaveTimerRef.current = null
    }
    saveUnread(unreadStorageRef.current, {
      v: 2,
      read: readMarksRef.current,
      edge: completedStore.getSnapshot(),
      notified: completeLedgerRef.current.notifiedTable(),
      pending: completeLedgerRef.current.pendingTable(),
      outcomes: completeLedgerRef.current.outcomesTable(),
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
   * 一个来源的未读派生（唯一入口）：判定规则全部来自 unread-derivation.ts。
   * 本函数只负责 读 refs → 读动作推进 → 派生 → 写回 refs/state → 落盘/ack。
   */
  const recomputeSourceUnread = useCallback((sourceId: string): void => {
    if (sourceId !== LOCAL_INSTANCE_ID && !liveServerIdsRef.current.has(sourceId)) return
    const factsSnapshot = factsStore.getSnapshot().session[sourceId]
    const usableFacts = factsSnapshot !== undefined && isFactsUsable(factsSnapshot) ? factsSnapshot : undefined
    const factsRows = usableFacts?.rows
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
    const result = deriveSourceUnread({
      facts: factsRows,
      channel: report?.sessions,
      // 只有权威完整列表（listComplete === true）才允许剪枝；缺省/未证明 = 不剪。
      listComplete: report?.listComplete === true,
      prevRunning: prevRunningRef.current[sourceId] ?? {},
      prevLedger: completedStore.getSnapshot()[sourceId] ?? {},
      readMarks: readMarksRef.current[sourceId] ?? {},
      readingSessionId: readingCurrent,
      // 无 facts = channel-only 照常派生；有 facts 但 serviceable=false ⇒ 原样保留。
      // 注意 stale 不在此闸内：断连未读照常呈现。
      factsVerified: usableFacts !== undefined ? usableFacts.serviceable !== false : true,
    }, { deriveUnread, reconcileCompletedFacts })
    prevRunningRef.current[sourceId] = result.nextRunning
    completedStore.setSource(sourceId, result.unread)
    if (!result.changed) return
    schedulePersistUnread()
  }, [schedulePersistUnread])

  /** 通知组装的**唯一**入口：壳通道边沿与 watcher 完成边沿都走这里；bridge.notify( 全文件只允许一次。 */
  const emitSessionNotification = useCallback((request: SessionNotificationRequest): void => {
    const bridge = window.dshChamber?.notifications
    if (bridge === undefined) {
      // 没有通知桥本身就是一次决定（什么都没投递）——否则「通道坏掉」与「正确地没有通知」无法区分。
      notificationLedger.record({
        at: Date.now(),
        sourceId: request.sourceId,
        sessionId: request.sessionId,
        kind: request.kind,
        ...(request.watermark === undefined ? {} : { watermark: request.watermark }),
        requireHidden: false,
        decision: 'skipped',
        error: 'no-notification-bridge',
        // ¤origin¤/pendingAge 诊断随决定入账（与有桥路径同形，负断言仍可回读处置来源）。
        ...(request.origin === undefined ? {} : { origin: request.origin }),
        ...(request.pendingAge === undefined ? {} : { pendingAge: request.pendingAge }),
      })
      publishNotificationInstrument()
      return
    }
    try {
      const copyLocale = readDocumentLocale()
      const label = serverLabelsRef.current[request.sourceId] ?? request.sourceId
      const aggregate = aggregatesRef.current[request.sourceId]
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
        request.title === 'goal-completed' ? frameText(copyLocale, 'notification.goalCompleted')
        : request.title === 'goal-blocked' ? frameText(copyLocale, 'notification.goalBlocked')
        : request.title === 'goal-stopped' ? frameText(copyLocale, 'notification.goalStopped')
        : frameText(copyLocale, 'notification.sessionComplete')
      const title =
        request.kind === 'complete' ? completeTitle
        : request.kind === 'ask' ? frameText(copyLocale, 'notification.awaitingAnswer')
        : frameText(copyLocale, 'notification.awaitingApproval')
      const body = label + ' · ' + sessionTitle(request.sessionId)
      // 屏上来源（paintedView，不是选择）∩ 该来源 current ∩ 焦点；主进程再查一次窗口焦点作权威豁免。
      const requireHidden = viewStore.getSnapshot().painted === request.sourceId
        && factsStore.getSnapshot().runtime[request.sourceId]?.current === request.sessionId
        && document.hasFocus()
      // 账本记的是主进程回执（shown / suppressed + error 原文），不是「我们调用了通知」。
      const ledgerBase = {
        at: Date.now(),
        sourceId: request.sourceId,
        sessionId: request.sessionId,
        kind: request.kind,
        ...(request.watermark === undefined ? {} : { watermark: request.watermark }),
        requireHidden,
        // 收敛器诊断（¤origin¤ + pendingAge）随主进程回执入账：held/flushed 的来源与暂存时长
        // 可在仪器上直接读，不靠日志推断。
        ...(request.origin === undefined ? {} : { origin: request.origin }),
        ...(request.pendingAge === undefined ? {} : { pendingAge: request.pendingAge }),
      } as const
      void bridge.notify({
        sourceId: request.sourceId,
        sourceFingerprint: request.sourceFingerprint,
        sessionId: request.sessionId,
        kind: request.kind,
        title,
        body,
        requireHidden,
        ...(request.watermark !== undefined ? { watermark: request.watermark } : {}),
        ...(request.origin === undefined ? {} : { origin: request.origin }),
        ...(request.pendingAge === undefined ? {} : { pendingAge: request.pendingAge }),
      }).then(result => {
        notificationLedger.record({
          ...ledgerBase,
          decision: result.shown ? 'sent' : 'suppressed',
          ...(result.error === undefined ? {} : { error: result.error }),
        })
      }).catch(err => {
        notificationLedger.record({ ...ledgerBase, decision: 'skipped', error: String(err) })
        console.warn('[notifications] 发送失败:', err)
      })
      publishNotificationInstrument()
    } catch (error) {
      console.warn('[notifications] 事件组装失败:', error)
    }
  }, [])

  /**
   * 完成观测组装 + 收敛（facts 轨的唯一入口；壳轨在桥的 onRuntimeReport 里用同一对纯函数，
   * 壳行经 factsStore.runtime 同步镜像可见）。每份观测都跑 reconcile（§3.3）；每次处置/清
   * pending/撤回都按 §3.5 落盘。
   */
  const reconcileCompletions = useCallback((sourceId: string): void => {
    const owner = sourceLifecyclesRef.current?.capture(sourceId)
    if (owner === null || owner === undefined) return
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
          emitSessionNotification({
            sourceId,
            sourceFingerprint: owner.fingerprint,
            sessionId: notification.sessionId,
            kind: notification.kind,
            ...(notification.watermark === undefined ? {} : { watermark: notification.watermark }),
            ...(notification.title === undefined ? {} : { title: notification.title }),
            ...(notification.origin === undefined ? {} : { origin: notification.origin }),
            ...(result.pendingAge === undefined ? {} : { pendingAge: result.pendingAge }),
          })
        },
        countDisposition: outcome => notificationLedger.countReconcile(outcome),
        persist: immediate => persistCompletionLedger(immediate),
      },
    })
  }, [emitSessionNotification, persistCompletionLedger, factsStore, completionObservationRef, completeLedgerRef, sourceLifecyclesRef, bootToken, bootVerdict])

  /** facts 快照到达（probe / SSE delta / resync 共用）：先合服务端读水位，再走同一观测组装 + reconcile，最后重算未读。 */
  const applySessionFacts = useCallback((sourceId: string, snapshot: SessionFactsSnapshot | undefined): void => {
    if (snapshot === undefined) {
      factsStore.dropSession(sourceId)
      // facts 通道消失 = 一次观测（running 权威回落壳行，goal 回落壳行/unknown）；不 emit，
      // 只让收敛器看到最新事实。
      reconcileCompletions(sourceId)
      recomputeSourceUnread(sourceId)
      return
    }
    const usable = isFactsUsable(snapshot)
    if (usable && snapshot.read !== null) {
      const local = readMarksRef.current[sourceId] ?? {}
      const merged = mergeReadMarks(local, snapshot.read.marks)
      if (merged !== local) {
        readMarksRef.current = { ...readMarksRef.current, [sourceId]: merged }
        schedulePersistUnread()
      }
    }
    factsStore.setSession(prev => (prev[sourceId] === snapshot ? prev : { ...prev, [sourceId]: snapshot }))
    // 同一观测组装缝：facts 候选（observed + 播种 + 水位严格前进）与壳行 goal 的结算都在
    // reconcile 里裁决——App 侧不再有第二 planner。
    reconcileCompletions(sourceId)
    recomputeSourceUnread(sourceId)
  }, [reconcileCompletions, recomputeSourceUnread, schedulePersistUnread])

  return {
    schedulePersistUnread, recomputeSourceUnread, emitSessionNotification, applySessionFacts,
    persistCompletionLedger, unreadImmediateSave,
  }
}
