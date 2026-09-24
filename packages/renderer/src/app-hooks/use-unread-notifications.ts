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
import { useCallback, useRef } from 'react'
import {
  deriveUnread,
  reconcileCompletedFacts,
  type InstanceAggregate,
} from '@dsh-chamber/dsh-chamber-client-core'
import type { CompletedStore } from '../host/completed-store.ts'
import type { ViewStore } from '../host/view-store.ts'
import type { FactsStore } from '../host/facts-store.ts'
import type { CompleteLedger } from '../complete-ledger.ts'
import type { SourceOwnershipRegistry } from '../deep-link-activation.ts'
import { LOCAL_INSTANCE_ID } from '../local-instance.ts'
import { frameText, readDocumentLocale } from '../locales.ts'
import { notificationLedger, publishNotificationInstrument } from '../notification-ledger.ts'
import { planFactsNotifications } from '../notification-projection.ts'
import type { SessionFactsSnapshot, SessionFactsSource } from '../session-facts-source.ts'
import {
  advanceReadMark,
  mergeReadMarks,
  saveUnread,
  type UnreadStorageLike,
} from '../unread-store.ts'
import { deriveSourceUnread, viewingReadWatermark } from '../unread-derivation.ts'

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
}

export interface UnreadNotificationsDeps {
  /** 通知组装镜像（设计 19）：onRuntimeReport effect（依赖 []）经 ref 读取最新值。 */
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
  factsSeededRef: { current: Set<string> }
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
}

export function useUnreadNotifications(deps: UnreadNotificationsDeps): UnreadNotifications {
  const {
    aggregates, serverLabels, viewStore, factsStore, liveServerIdsRef,
    sessionFactsSourcesRef, sourceLifecyclesRef, prevRunningRef,
    completedStore, readMarksRef, completeLedgerRef, factsSeededRef,
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
   * 读标记 / 退避账本写盘（≤1 次/秒节流；pagehide/hidden 立即 flush）。内存是
   * 权威，v2 只是缓存，服务端是跨端权威。never-throw。
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
    const factsSnapshot = factsStore.getSnapshot().session[sourceId]
    const usableFacts = factsSnapshot !== undefined && factsSnapshot.verdict === 'ok' ? factsSnapshot : undefined
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
      // 只有权威完整列表（listComplete === true）才允许剪枝；缺省/未证明
      // = 不剪（默认不剪——列表短暂收缩不得假清）。
      listComplete: report?.listComplete === true,
      prevRunning: prevRunningRef.current[sourceId] ?? {},
      prevLedger: completedStore.getSnapshot()[sourceId] ?? {},
      readMarks: readMarksRef.current[sourceId] ?? {},
      readingSessionId: readingCurrent,
      // 无 facts = channel-only 照常派生；有 facts 但 serviceable=false（host
      // 停机）⇒ 原样保留（不 clobber、不假清）。注意 stale 不在此闸内：
      // 断连未读照常呈现。
      factsVerified: usableFacts !== undefined ? usableFacts.serviceable !== false : true,
    }, { deriveUnread, reconcileCompletedFacts })
    prevRunningRef.current[sourceId] = result.nextRunning
    completedStore.setSource(sourceId, result.unread)
    if (!result.changed) return
    schedulePersistUnread()
  }, [schedulePersistUnread])

  /**
   * 通知组装的**唯一**入口：壳通道边沿与 watcher
   * 完成边沿两个入口都走这里；bridge.notify( 全文件只允许出现一次（接线锁）。
   */
  const emitSessionNotification = useCallback((request: SessionNotificationRequest): void => {
    const bridge = window.dshChamber?.notifications
    if (bridge === undefined) {
      // 没有通知桥本身就是一次决定（什么都没投递）——负断言必须看得见它，
      // 否则「通知路径整体坏掉」与「正确地没有通知」在账本上无法区分。
      notificationLedger.record({
        at: Date.now(),
        sourceId: request.sourceId,
        sessionId: request.sessionId,
        kind: request.kind,
        ...(request.watermark === undefined ? {} : { watermark: request.watermark }),
        requireHidden: false,
        decision: 'skipped',
        error: 'no-notification-bridge',
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
      const title =
        request.kind === 'complete' ? frameText(copyLocale, 'notification.sessionComplete')
        : request.kind === 'ask' ? frameText(copyLocale, 'notification.awaitingAnswer')
        : frameText(copyLocale, 'notification.awaitingApproval')
      const body = label + ' · ' + sessionTitle(request.sessionId)
      // 正在屏幕上查看的会话豁免：**屏上**来源（paintedView，
      // 不是选择——持有窗内 active 已是目标而屏上仍是旧视图）∩ 该来源 current
      // ∩ 焦点；主进程再查一次窗口焦点作权威豁免。
      const requireHidden = viewStore.getSnapshot().painted === request.sourceId
        && factsStore.getSnapshot().runtime[request.sourceId]?.current === request.sessionId
        && document.hasFocus()
      // 账本记的是**主进程回执**（shown / suppressed + error 原文），不是「我们调用了
      // 通知」——这是正对照能成立的前提。
      const ledgerBase = {
        at: Date.now(),
        sourceId: request.sourceId,
        sessionId: request.sessionId,
        kind: request.kind,
        ...(request.watermark === undefined ? {} : { watermark: request.watermark }),
        requireHidden,
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
   * facts 快照到达（probe / SSE delta / resync 共用）：先合服务端读水位
   * （跨端收敛），再喂通知第二入口（只 observed，首帧只播种），最后重算。
   */
  const applySessionFacts = useCallback((sourceId: string, snapshot: SessionFactsSnapshot | undefined): void => {
    if (snapshot === undefined) {
      factsStore.dropSession(sourceId)
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
    factsStore.setSession(prev => (prev[sourceId] === snapshot ? prev : { ...prev, [sourceId]: snapshot }))
    if (usable) {
      // 单入口：facts 证据走同一投影。reconstructed 只出未读、不通知；
      // 首份快照只播种水位（桌面关闭期间的完成不得补发通知）。水位轨是跨重挂的
      // durable 去重依据，武装位只做本轮即时去重。
      const seeded = factsSeededRef.current.has(sourceId)
      const lifecycle = sourceLifecyclesRef.current!.capture(sourceId)
      const watermarks: Record<string, number | undefined> = {}
      for (const row of Object.values(snapshot.rows)) {
        watermarks[row.sessionId] = completeLedgerRef.current.notifiedWatermark(sourceId, row.sessionId, 'complete')
      }
      const plan = planFactsNotifications({
        rows: snapshot.rows,
        seeded,
        watermarks,
        armed: completeLedgerRef.current.armed(sourceId),
      })
      for (const [sessionId, watermark] of Object.entries(plan.watermarks)) {
        if (completeLedgerRef.current.notifiedWatermark(sourceId, sessionId, 'complete') !== watermark) {
          completeLedgerRef.current.setNotifiedWatermark(sourceId, sessionId, 'complete', watermark)
        }
      }
      completeLedgerRef.current.setArmed(sourceId, plan.armed)
      if (lifecycle !== null) {
        for (const edge of plan.edges) {
          emitSessionNotification({
            sourceId,
            sourceFingerprint: lifecycle.fingerprint,
            sessionId: edge.sessionId,
            kind: edge.kind,
            ...(edge.watermark === undefined ? {} : { watermark: edge.watermark }),
          })
        }
      }
      factsSeededRef.current.add(sourceId)
    }
    recomputeSourceUnread(sourceId)
  }, [emitSessionNotification, recomputeSourceUnread, schedulePersistUnread])

  return { schedulePersistUnread, recomputeSourceUnread, emitSessionNotification, applySessionFacts }
}
