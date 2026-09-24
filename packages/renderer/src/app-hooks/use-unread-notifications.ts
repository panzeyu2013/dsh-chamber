/**
 * 通知 / 未读投影簇（design 19）：App.tsx 的 5 个投影回调原样抽出。
 *
 * 规则本体全部在既有纯模块（unread-derivation / unread-store / notification-projection /
 * complete-ledger / notification-ledger）里；本 hook 只做装配：
 * 读 refs → 推进读水位 → 派生未读 → 写回 refs/state → 节流落盘 / 通知唯一组装点。
 * 依赖面显式类型化（无 any），App 只传入状态容器与 setter。
 *
 * 调用位置与 useCallback 依赖数组与抽出前逐字一致：
 *   flushUnread（[]）、schedulePersistUnread（[]）、recomputeSourceUnread（[schedulePersistUnread]）、
 *   emitSessionNotification（[]）、applySessionFacts（[emitSessionNotification, recomputeSourceUnread, schedulePersistUnread]）。
 */
import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from 'react'
import {
  deriveUnread,
  reconcileCompletedFacts,
  type InstanceAggregate,
  type InstanceRuntimeReport,
} from '@dsh-chamber/dsh-chamber-client-core'
import type { CompleteLedger } from '../complete-ledger.ts'
import type { SourceOwnershipRegistry } from '../deep-link-activation.ts'
import { LOCAL_INSTANCE_ID } from '../local-instance.ts'
import { frameText, readDocumentLocale } from '../locales.ts'
import { notificationRunId } from '../notification-identity.ts'
import { notificationLedger, publishNotificationInstrument } from '../notification-ledger.ts'
import type { NotificationOutbox, PendingNotification, DeliveryOutcome } from '../notification-outbox.ts'
import { planFactsNotifications } from '../notification-projection.ts'
import { completionWatermark } from '../watermark.ts'
import type { SessionFactsSnapshot, SessionFactsSource } from '../session-facts-source.ts'
import {
  advanceReadMark,
  mergeReadMarks,
  saveUnread,
  type UnreadStorageLike,
} from '../unread-store.ts'
import {
  deriveSourceUnread,
  sameBooleanMap as sameBooleanLedger,
  viewingReadWatermark,
} from '../unread-derivation.ts'

/**
 * 通知组装请求（唯一组装点 emitSessionNotification 的入参）：
 * origin 只是诊断（两个事实入口：壳通道边沿 / watcher 完成边沿）；watermark 是
 * host 域内容水位，进 renderer 身份键（主进程 claim 键的第五元组）。
 */
export type SessionNotificationRequest = {
  sourceId: string
  sourceFingerprint: string
  sessionId: string
  kind: 'complete' | 'ask' | 'request'
  watermark?: number
  completionSeq?: number
  /** 运行身份：facts 入口直接带上；壳边沿缺省时由 outbox 解析。 */
  runId?: string
}

export interface UnreadNotificationsDeps {
  /** 通知组装镜像（设计 19）：onRuntimeReport effect（依赖 []）经 ref 读取最新值。 */
  aggregates: Record<string, InstanceAggregate>
  serverLabels: Record<string, string>
  /** 唯一「正在阅读」谓词的屏上来源（paintedView 的渲染期镜像）。 */
  paintedViewRef: { current: string }
  /** 已挂载来源的运行时事实（渲染期镜像）。 */
  runtimeFactsRef: { current: Record<string, InstanceRuntimeReport | undefined> }
  liveServerIdsRef: { current: ReadonlySet<string> }
  sessionFactsRef: { current: Record<string, SessionFactsSnapshot | undefined> }
  sessionFactsSourcesRef: { current: Map<string, SessionFactsSource> }
  sourceLifecyclesRef: { current: SourceOwnershipRegistry | null }
  /** 每来源每会话的上一份 channel running 位（蓝点机边沿记忆）。 */
  prevRunningRef: { current: Record<string, Record<string, boolean>> }
  edgeLedgerRef: { current: Record<string, Record<string, boolean>> }
  readMarksRef: { current: Record<string, Record<string, number>> }
  completeLedgerRef: { current: CompleteLedger }
  notificationOutboxRef: { current: NotificationOutbox }
  factsSeededRef: { current: Set<string> }
  unreadStorageRef: { current: UnreadStorageLike | undefined }
  unreadSaveTimerRef: { current: ReturnType<typeof setTimeout> | null }
  /** 读标记落盘入口：hook 把最新 flushUnread 写进它（App 的 pagehide effect 读）。 */
  flushUnreadRef: { current: () => void }
  clientInstallIdRef: { current: string }
  setCompletedBySource: Dispatch<SetStateAction<Record<string, Record<string, boolean>>>>
  setSessionFacts: Dispatch<SetStateAction<Record<string, SessionFactsSnapshot | undefined>>>
}

export interface UnreadNotifications {
  schedulePersistUnread: () => void
  recomputeSourceUnread: (sourceId: string) => void
  emitSessionNotification: (request: SessionNotificationRequest) => boolean
  applySessionFacts: (sourceId: string, snapshot: SessionFactsSnapshot | undefined) => void
}

export function useUnreadNotifications(deps: UnreadNotificationsDeps): UnreadNotifications {
  const {
    aggregates, serverLabels, paintedViewRef, runtimeFactsRef, liveServerIdsRef,
    sessionFactsRef, sessionFactsSourcesRef, sourceLifecyclesRef, prevRunningRef,
    edgeLedgerRef, readMarksRef, completeLedgerRef, notificationOutboxRef, factsSeededRef,
    unreadStorageRef, unreadSaveTimerRef, flushUnreadRef, clientInstallIdRef,
    setCompletedBySource, setSessionFacts,
  } = deps

  // 通知事件组装镜像（设计 19）：onRuntimeReport effect（依赖 []）经 ref 读取最新
  // aggregates/serverLabels——effect 闭包拿不到 state/useMemo，渲染期镜像纪律同
  // remoteStatusRef（与 commit 同步，微任务/事件回调安全）。
  const aggregatesRef = useRef(aggregates)
  aggregatesRef.current = aggregates
  const serverLabelsRef = useRef(serverLabels)
  serverLabelsRef.current = serverLabels

  /**
   * 读标记 / 退避账本写盘（≤1 次/秒节流；pagehide/hidden 立即 flush）。内存是
   * 权威，v4 只是缓存，服务端是跨端权威。never-throw。
   */
  const flushUnread = useCallback((): void => {
    if (unreadSaveTimerRef.current !== null) {
      clearTimeout(unreadSaveTimerRef.current)
      unreadSaveTimerRef.current = null
    }
    saveUnread(unreadStorageRef.current, {
      v: 4,
      read: readMarksRef.current,
      edge: edgeLedgerRef.current,
      notifiedRuns: completeLedgerRef.current.notifiedRunTable(),
    })
  }, [])
  flushUnreadRef.current = flushUnread
  const schedulePersistUnread = useCallback((): void => {
    if (unreadSaveTimerRef.current !== null) return
    unreadSaveTimerRef.current = setTimeout(() => {
      unreadSaveTimerRef.current = null
      flushUnreadRef.current()
    }, 1_000)
  }, [])

  /**
   * 一个来源的未读派生（唯一入口）。判定规则与输入全部来自纯模块
   * unread-derivation.ts（其 deriveUnread 就是 client-core 的 4 参导出，
   * ABSENT/degraded turn-end 的武装分支不在此重实现）。本函数只负责：
   * 读 refs → 读动作推进 → 派生 → 写回 refs/state → 落盘/ack。
   */
  const recomputeSourceUnread = useCallback((sourceId: string): void => {
    if (sourceId !== LOCAL_INSTANCE_ID && !liveServerIdsRef.current.has(sourceId)) return
    const factsSnapshot = sessionFactsRef.current[sourceId]
    const usableFacts = factsSnapshot !== undefined && factsSnapshot.verdict === 'ok' ? factsSnapshot : undefined
    const factsRows = usableFacts?.rows
    const report = runtimeFactsRef.current[sourceId]
    // 唯一「正在阅读」谓词：paintedView（屏上是谁，不是选择）
    // ∩ 该来源 current ∩ document.hasFocus()。失焦即视为未读。
    const readingCurrent = paintedViewRef.current === sourceId && document.hasFocus()
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
      // 只有权威完整列表（listComplete === true）才允许剪枝；缺省/未证明
      // = 不剪（默认不剪——列表短暂收缩不得假清）。
      listComplete: report?.listComplete === true,
      prevRunning: prevRunningRef.current[sourceId] ?? {},
      prevLedger: edgeLedgerRef.current[sourceId] ?? {},
      readMarks: readMarksRef.current[sourceId] ?? {},
      readingSessionId: readingCurrent,
      // 无 facts = channel-only 照常派生；有 facts 但 serviceable=false（host
      // 停机）⇒ 原样保留（不 clobber、不假清）。注意 stale 不在此闸内：
      // 断连未读照常呈现。
      factsVerified: usableFacts !== undefined ? usableFacts.serviceable !== false : true,
    }, { deriveUnread, reconcileCompletedFacts })
    prevRunningRef.current[sourceId] = result.nextRunning
    edgeLedgerRef.current[sourceId] = result.unread
    if (!result.changed) return
    schedulePersistUnread()
    setCompletedBySource(prev => {
      const existing = prev[sourceId] ?? {}
      if (sameBooleanLedger(existing, result.unread)) return prev
      return { ...prev, [sourceId]: result.unread }
    })
  }, [schedulePersistUnread])

  const pumpNotificationsRef = useRef<() => void>(() => {})
  const notificationRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (notificationRetryTimerRef.current !== null) clearTimeout(notificationRetryTimerRef.current)
  }, [])

  /** One native call site. The outbox owns the event until an honest host result arrives. */
  const sendPending = (entry: PendingNotification): boolean => {
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
    const requireHidden = paintedViewRef.current === entry.sourceId
      && runtimeFactsRef.current[entry.sourceId]?.current === entry.sessionId
      && document.hasFocus()
      && document.visibilityState === 'visible'
    const ledgerBase = {
      at: Date.now(), sourceId: entry.sourceId, sessionId: entry.sessionId, kind: entry.kind,
      ...(entry.watermark === undefined ? {} : { watermark: entry.watermark }), requireHidden,
    } as const
    const settle = (outcome: DeliveryOutcome, error?: string): void => {
      const result = notificationOutboxRef.current.settle(attempt, outcome)
      if (!result.accepted) return
      const delivered = result.delivered
      if (delivered?.kind === 'complete') {
        // One durable write: the run identity the facts projection will compute for
        // this completion. A runtime edge without any host-domain evidence has no
        // identity yet - mark it pending so the next facts snapshot adopts its run
        // id through the runtimeSettled branch without notifying again.
        const identity = delivered.watermark === undefined && delivered.completionSeq === undefined
          ? undefined
          : notificationRunId({
            sourceFingerprint: delivered.sourceFingerprint,
            sessionId: delivered.sessionId,
            ...(delivered.completionSeq === undefined ? {} : { completionSeq: delivered.completionSeq }),
            ...(delivered.watermark === undefined ? {} : { watermark: delivered.watermark }),
          })
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
      const row = aggregate?.sessions.find(session => session.sessionId === entry.sessionId)
      const sessionTitle = row?.displayTitle || row?.title || frameText(copyLocale, 'session.untitled')
      const title = entry.kind === 'complete' ? frameText(copyLocale, 'notification.sessionComplete')
        : entry.kind === 'ask' ? frameText(copyLocale, 'notification.awaitingAnswer')
        : frameText(copyLocale, 'notification.awaitingApproval')
      const native = bridge.notify({
        sourceId: entry.sourceId, sourceFingerprint: entry.sourceFingerprint,
        sessionId: entry.sessionId, kind: entry.kind, title,
        body: label + ' · ' + sessionTitle, requireHidden,
        eventKey: entry.key,
        ...(entry.watermark === undefined ? {} : { watermark: entry.watermark }),
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
    for (const entry of notificationOutboxRef.current.due()) {
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
   * facts 快照到达（probe / SSE delta / resync 共用）：先合服务端读水位
   * （跨端收敛），再喂通知第二入口（只 observed，首帧只播种），最后重算。
   */
  const applySessionFacts = useCallback((sourceId: string, snapshot: SessionFactsSnapshot | undefined): void => {
    if (snapshot === undefined) {
      setSessionFacts(prev => {
        if (prev[sourceId] === undefined) return prev
        const next = { ...prev }
        delete next[sourceId]
        return next
      })
      delete sessionFactsRef.current[sourceId]
      recomputeSourceUnread(sourceId)
      return
    }
    const usable = snapshot.verdict === 'ok'
    if (usable && snapshot.read !== null) {
      const local = readMarksRef.current[sourceId] ?? {}
      const merged = mergeReadMarks(local, snapshot.read.marks)
      if (merged !== local) {
        readMarksRef.current = { ...readMarksRef.current, [sourceId]: merged }
        schedulePersistUnread()
      }
    }
    setSessionFacts(prev => (prev[sourceId] === snapshot ? prev : { ...prev, [sourceId]: snapshot }))
    sessionFactsRef.current = { ...sessionFactsRef.current, [sourceId]: snapshot }
    if (usable) {
      // 单入口：facts 证据走同一投影。reconstructed 只出未读、不通知；
      // 首份快照只播种水位（桌面关闭期间的完成不得补发通知）。水位轨是跨重挂的
      // durable 去重依据，武装位只做本轮即时去重。
      const seeded = factsSeededRef.current.has(sourceId)
      const lifecycle = sourceLifecyclesRef.current!.capture(sourceId)
      const notifiedRuns: Record<string, string | undefined> = {}
      const pendingSessions = new Set<string>()
      for (const row of Object.values(snapshot.rows)) {
        notifiedRuns[row.sessionId] = completeLedgerRef.current.notifiedRun(sourceId, row.sessionId)
        if (lifecycle === null || row.completedAtSource !== 'observed' || row.completedAt === null) continue
        const watermark = completionWatermark(row)
        if (watermark === undefined) continue
        const seq = row.lastTurnEnd?.seq
        const completionSeq = typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 0 ? seq : undefined
        // One evidence object: the content watermark plus the facts row's own host
        // `updatedAt` anchor. The outbox never compares `completedAt` against the
        // runtime edge's `updatedAt` - that cross-domain fence refused the same
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
      const plan = planFactsNotifications({
        rows: snapshot.rows,
        sourceFingerprint: lifecycle?.fingerprint ?? sourceId,
        seeded,
        notifiedRuns,
        armed: completeLedgerRef.current.armed(sourceId),
        pendingSessions,
        runtimeSettled: completeLedgerRef.current.runtimeSettled(sourceId),
      })
      let ledgerChanged = false
      for (const [sessionId, runId] of Object.entries(plan.runs)) {
        if (completeLedgerRef.current.notifiedRun(sourceId, sessionId) !== runId) {
          completeLedgerRef.current.setNotifiedRun(sourceId, sessionId, runId)
          ledgerChanged = true
        }
      }
      if (ledgerChanged) schedulePersistUnread()
      const armed = new Set(plan.armed)
      if (lifecycle !== null) {
        for (const edge of plan.edges) {
          if (!emitSessionNotification({
            sourceId,
            sourceFingerprint: lifecycle.fingerprint,
            sessionId: edge.sessionId,
            kind: edge.kind,
            ...(edge.watermark === undefined ? {} : { watermark: edge.watermark }),
            ...(edge.completionSeq === undefined ? {} : { completionSeq: edge.completionSeq }),
            ...(edge.runId === undefined ? {} : { runId: edge.runId }),
          })) armed.delete(edge.sessionId)
        }
      } else {
        for (const edge of plan.edges) armed.delete(edge.sessionId)
      }
      completeLedgerRef.current.setArmed(sourceId, armed)
      factsSeededRef.current.add(sourceId)
    }
    pumpNotificationsRef.current()
    recomputeSourceUnread(sourceId)
  }, [emitSessionNotification, recomputeSourceUnread, schedulePersistUnread])

  return { schedulePersistUnread, recomputeSourceUnread, emitSessionNotification, applySessionFacts }
}
