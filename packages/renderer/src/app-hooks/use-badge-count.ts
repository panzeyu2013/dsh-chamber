/**
 * 未读徽标推送的 effect 簇（design 19 §3.7）。
 *
 * 输入只有两个事实源（completedBySource / runtimeFacts）与 LISTENER_READY 重试预算；
 * 桥面经 window.dshChamber 读取（页面级单例）。App 只传当前事实与预算常量。
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

  // 未读徽标（design 19 §3.7）：completedBySource（完成未读蓝点集）是徽标计数的
  // 唯一事实源——跨来源求未读会话数（projectBadgeCount，纯函数），推给主进程
  // 呈现 Dock/任务栏红气泡。计数与蓝点同源同规则（武装/解除同一状态机），两面
  // 永不分叉；0 = 清除。子代理压制（06 §4.5 同规）：父回合结束
  // 但后台子代理仍存活（runningSubagents > 0）的会话虽然已武装蓝点，窗口内点
  // 被运行环压制、complete 通知被过滤，徽标同样不计——投影须读最新运行时事实
  // （runtimeFacts 行），否则 Dock 会在「主分支闲置等子代理」期间误亮红气泡。
  // 子代理全部结束后 armed 蓝点正常浮现计入（与侧边栏同语义）。runtimeFacts
  // 在依赖里：子代理计数归零（事实行变化）时无需蓝点变化也要重推当前计数。
  // 通道-only 变化可能重推相同计数值——主进程 setBadgeCount 幂等，无副作用。
  // 桥未就绪（window.dshChamber 异步 expose）时静默跳过
  // ——计数变化发生在运行时上报之后（远晚于桥暴露），首个真实计数不会丢；
  // 重载后复位为 0 的兜底推送由下方挂载 effect 负责。reject 兜底：
  // 同进程 IPC 偶发拒绝不得让徽标停滞到下一次计数变化——按 LISTENER_READY 预算
  // 有界重推当前计数（badgeCountRef 始终最新），预算耗尽 loud 一次。
  const badgeCountRef = useRef(0)
  const badgeRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pushBadgeWithRetry = useCallback((attemptsLeft: number): void => {
    const badge = window.dshChamber?.badge
    // typeof 守卫：与设置页 testNotifySurface 同款版本偏斜防护——
    // 旧主进程 + 新渲染端的窗口重建窗口内 badge 面可能缺失 set 方法。
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
    // 把 renderer 派发的计数发布成只读回读值，可在测试中比对
    // 「徽标数 == 蓝点集合大小」，无需 IPC 或读主进程状态。
    publishBadgeCount(count)
    pushBadgeWithRetry(retryLimit)
  }, [completedBySource, runtimeFacts, pushBadgeWithRetry, retryLimit])

  // 桥迟到的兜底（同 LISTENER_READY 重试纪律，见通知就绪 handshake）：窗口重载/
  // 重建后 completedBySource 复位为 {}，必须向主进程推 0 清除遗留徽标——桥经
  // requestAppInfo 异步暴露，可能晚于首个 [completedBySource, runtimeFacts]
  // effect 的提交时机（该 effect 在挂载帧即推 0，此时桥大概率未就绪）。有界重试
  // 直至桥出现，推一次当前计数（0）后停止；预算耗尽静默放弃（dev 无桥场景的
  // 正常路径）。
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
