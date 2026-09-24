/**
 * 未读徽标推送的 effect 簇。输入只有 completedBySource / runtimeFacts 与 LISTENER_READY 重试
 * 预算；桥面经 window.dshChamber 读取（页面级单例）。
 */
import { useCallback, useEffect, useRef } from 'react'
import { projectBadgeCount } from '../badge-count.ts'
import { publishBadgeCount } from '../notification-ledger.ts'
import type { InstanceRuntimeReport } from '@dsh-chamber/dsh-chamber-client-core'

export interface BadgeCountDeps {
  /** 完成未读蓝点集（每来源每会话布尔）。 */
  completedBySource: Record<string, Record<string, boolean>>
  /** 运行时事实（子代理压制与计数归零都读它）。 */
  runtimeFacts: Record<string, InstanceRuntimeReport | undefined>
  /** LISTENER_READY 重试间隔（与通知就绪 handshake 同源常量）。 */
  retryMs: number
  /** LISTENER_READY 重试预算。 */
  retryLimit: number
}

export function useBadgeCount(deps: BadgeCountDeps): void {
  const { completedBySource, runtimeFacts, retryMs, retryLimit } = deps

  // 未读徽标：completedBySource 是唯一事实源，跨来源投影（projectBadgeCount）推给主进程
  // 呈现 Dock/任务栏红气泡；计数与蓝点同源同规则，永不分叉，0 = 清除。
  // 子代理压制：父回合结束但 runningSubagents > 0 的会话虽已武装也不计，否则 Dock 会在
  // 「闲置等子代理」期间误亮。runtimeFacts 在依赖里，计数归零时无须蓝点变化也要重推。
  // 通道-only 变化可能重推相同值——主进程 setBadgeCount 幂等，无副作用。
  // 桥未就绪时静默跳过（首个真实计数不会丢，重载复位兜底见下方挂载 effect）；reject 时按
  // LISTENER_READY 预算有界重推当前计数，预算耗尽 loud 一次。
  const badgeCountRef = useRef(0)
  const badgeRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pushBadgeWithRetry = useCallback((attemptsLeft: number): void => {
    const badge = window.dshChamber?.badge
    // typeof 守卫：版本偏斜（旧主进程 + 新渲染端）下 badge 面可能缺失 set 方法。
    if (badge === undefined || typeof badge.set !== 'function') return
    void badge.set(badgeCountRef.current).catch(error => {
      if (attemptsLeft <= 0) {
        console.warn('[badge] 徽标计数推送失败：', error)
        return
      }
      badgeRetryTimerRef.current = setTimeout(
        () => pushBadgeWithRetry(attemptsLeft - 1),
        retryMs,
      )
    })
  }, [retryMs])
  useEffect(() => {
    const count = projectBadgeCount(completedBySource, runtimeFacts)
    badgeCountRef.current = count
    // 发布 renderer 派发的计数为只读回读值，便于比对「徽标数 == 蓝点集合大小」。
    publishBadgeCount(count)
    pushBadgeWithRetry(retryLimit)
  }, [completedBySource, runtimeFacts, pushBadgeWithRetry, retryLimit])

  // 桥迟到的兜底：窗口重载后 completedBySource 复位为 {}，必须推 0 清除遗留徽标；桥异步暴露，
  // 可能晚于首个 effect 提交。有界重试直至桥出现，推一次当前计数后停止；预算耗尽静默放弃。
  useEffect(() => {
    if (window.dshChamber?.badge !== undefined) return
    let attempts = 0
    const timer = setInterval(() => {
      attempts += 1
      const badge = window.dshChamber?.badge
      if (badge !== undefined && typeof badge.set === 'function') {
        clearInterval(timer)
        pushBadgeWithRetry(retryLimit)
        return
      }
      if (attempts >= retryLimit) clearInterval(timer)
    }, retryMs)
    return () => clearInterval(timer)
  }, [pushBadgeWithRetry, retryLimit, retryMs])

  // reject 重推计时器的卸载清理（挂载期内可能由 pushBadgeWithRetry 排入）。
  useEffect(() => () => {
    if (badgeRetryTimerRef.current !== null) clearTimeout(badgeRetryTimerRef.current)
  }, [])
}
