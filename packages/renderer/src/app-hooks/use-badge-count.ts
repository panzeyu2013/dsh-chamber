/**
 * 未读徽标推送的 effect 簇（design 19 §3.7）。
 *
 * 输入只有两个事实源（completedBySource / **合并后** runtimeFacts）与
 * LISTENER_READY 重试预算；桥面经 window.dshChamber 读取（页面级单例）。
 * App 只传当前事实与预算常量——**合并投影**（含 facts overlay 与 stale）保证
 * 徽标与侧栏六面（sessionRowState）消费同一份事实。
 */
import { useEffect, useRef } from 'react'
import { projectBadgeCount, type BadgeSuppressionFacts } from '../badge-count.ts'
import { publishBadgeCount } from '../notification-ledger.ts'
import {
  sessionRowState,
  subagentActivityOf,
  type InstanceRuntimeReport,
} from '@dsh-chamber/dsh-chamber-client-core'

export interface BadgeCountDeps {
  /** 完成未读蓝点集（每来源每会话布尔）。 */
  completedBySource: Record<string, Record<string, boolean>>
  /**
   * **合并后**的运行时事实（App 的 servers[].runtime：通道报告 ∪ 蓝点 ∪ facts
   * overlay ∪ stale）。子代理压制、goal 压制与计数归零都读它——与侧栏六面同源，
   * 而不是原始通道报告（无壳来源的 goal 只在 facts overlay 里）。
   */
  runtimeFacts: Record<string, InstanceRuntimeReport | undefined>
  /** LISTENER_READY 重试间隔（与通知就绪 handshake 同源常量）。 */
  retryMs: number
  /** LISTENER_READY 重试预算。 */
  retryLimit: number
}

/**
 * 合并投影 → 徽标压制输入（纯映射，语义由 sidebar 的单源谓词给出）：
 *  - `goalActive` = `goalSuppressesPresentation(row.goal)`（active 相位即压制，含
 *    activation unknown）——badge-count.ts 保持零 import，只消费这个布尔；
 *  - `subagentActivity` = `subagentActivityOf(row, stale)`（stale 的 running 降
 *    unknown：断连来源的残留计数不是「正在干活」）。
 * 行只带渲染/压制相关的布尔与三值，判定字段（updatedAt/completedAt）不过桥；stale
 * 不单独过桥——它只在上面这一步把残留 running 降为 unknown。
 */
function badgeSuppressionFacts(
  runtimeFacts: Record<string, InstanceRuntimeReport | undefined>,
): Record<string, BadgeSuppressionFacts | undefined> {
  const facts: Record<string, BadgeSuppressionFacts | undefined> = {}
  for (const [sourceId, report] of Object.entries(runtimeFacts)) {
    if (report === undefined) continue
    const stale = report.stale === true
    const sessions: NonNullable<BadgeSuppressionFacts['sessions']> = {}
    for (const [sessionId, row] of Object.entries(report.sessions)) {
      sessions[sessionId] = {
        ...(row.completed === true ? { completed: true } : {}),
        // goal 呈现门走 sessionRowState 的单一谓词（goalSuppressesPresentation 未进 client-core
        // barrel；sessionRowState().goalActive 就是它的结果），徽标与侧栏六面同源。
        goalActive: sessionRowState({ goal: row.goal }).goalActive,
        subagentActivity: subagentActivityOf(row, stale),
      }
    }
    facts[sourceId] = { sessions }
  }
  return facts
}

/** 有界重推链的注入缝（与 React/DOM 解耦，node:test 可用 fake timer 直驱）。 */
export interface BadgePushRetryOptions {
  /**
   * 推送一次计数并返回桥面的 promise；`undefined` = 桥面缺席/版本偏斜，
   * 没有可重试的调用。
   */
  push: (count: number) => Promise<unknown> | undefined
  setTimer: (callback: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
  /** 预算耗尽时 loud 一次（该链不再继续）。 */
  warn: (error: unknown) => void
}

/** 一次徽标推送的有界重推链（见 {@link createBadgePushRetry}）。 */
export interface BadgePushRetry {
  /**
   * 立即推送一次；reject 时按 `retryMs` 重推，最多再试 `attemptsLeft` 次。
   * 每次调度前清掉上一条 pending timer（任意时刻至多一条），且新一次 start
   * 取代整条旧链——旧链在途 reject 迟到时不得再排 timer。返回**是否真的派发**（badge 面缺失/
   * 版本偏斜时 false）：调用方的「计数变化才推」闸据此决定是否提交。
   */
  start(count: number, attemptsLeft: number, retryMs: number): boolean
  /** 卸载/拆除：清掉 pending timer，并让在途 reject 不再续链。 */
  cancel(): void
}

/**
 * 建一条有界重推链。旧实现的 reject 回调直接 `badgeRetryTimerRef.current =
 * setTimeout(...)`：effect 重跑叠加在途链时会产生第二条 timer，而卸载清理只清
 * 最后一条，漏下的 timer 在卸载后仍会推送；这里用 generation token 让「取代」与
 * 「卸载」都作废整条旧链，pending timer 先清后排。
 */
export function createBadgePushRetry(options: BadgePushRetryOptions): BadgePushRetry {
  let pending: unknown = null
  let generation = 0
  const clearPending = (): void => {
    if (pending === null) return
    options.clearTimer(pending)
    pending = null
  }
  /** 返回**是否真的派发**（badge 面缺失/版本偏斜返回 false）：调用方的计数变化闸据此提交。 */
  const attempt = (token: number, count: number, attemptsLeft: number, retryMs: number): boolean => {
    if (token !== generation) return false
    const result = options.push(count)
    if (result === undefined) return false
    void result.catch(error => {
      if (token !== generation) return
      if (attemptsLeft <= 0) {
        options.warn(error)
        return
      }
      clearPending()
      pending = options.setTimer(() => {
        pending = null
        attempt(token, count, attemptsLeft - 1, retryMs)
      }, retryMs)
    })
    return true
  }
  return {
    start(count, attemptsLeft, retryMs): boolean {
      generation += 1
      clearPending()
      return attempt(generation, count, attemptsLeft, retryMs)
    },
    cancel() {
      generation += 1
      clearPending()
    },
  }
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
  // 子代理全部结束后 armed 蓝点正常浮现计入（与侧边栏同语义）；断连/stale 来源的
  // 残留计数不再算「在跑」（与 subagentActivityOf 同拍）。goal 压制（v5 §4 呈现门）：
  // goal 相位 active 的已武装完成不计入——否则 Dock 会为一个用户看不到的蓝点亮红气泡。
  // runtimeFacts
  // 在依赖里：子代理计数归零（事实行变化）时无需蓝点变化也要重推当前计数。
  // 通道-only 变化会重算但不再重推相同计数值（见 pushedCountRef 的计数变化闸）。
  // 桥未就绪（window.dshChamber 异步 expose）时静默跳过
  // ——计数变化发生在运行时上报之后（远晚于桥暴露），首个真实计数不会丢；
  // 重载后复位为 0 的兜底推送由下方挂载 effect 负责。reject 兜底：
  // 同进程 IPC 偶发拒绝不得让徽标停滞到下一次计数变化——按 LISTENER_READY 预算
  // 有界重推当前计数（badgeCountRef 始终最新），预算耗尽 loud 一次。
  const badgeCountRef = useRef(0)
  /**
   * 上一次真正推给主进程的计数。**只有计数变化才推 IPC**：runtimeFacts/completedBySource
   * 换身份（别的来源账本变化、子代理计数归零、goal 压制翻转）会把同一个计数重复推上去——
   * 实测 Swift 包里 4.8 Hz 的冗余 IPC，而 Dock 视觉完全没变。
   * 首个计数（含重载后复位为 0）必须推；被拒后的有界重推链在 badgeRetry.start 内部，
   * 与本闸无关（预算耗尽仍以「下一次计数变化」为自愈点，loud 一次）。
   */
  const pushedCountRef = useRef<number | null>(null)
  const badgeRetryRef = useRef<BadgePushRetry | null>(null)
  if (badgeRetryRef.current === null) {
    badgeRetryRef.current = createBadgePushRetry({
      push: count => {
        // typeof 守卫：与设置页 testNotifySurface 同款版本偏斜防护——
        // 旧主进程 + 新渲染端的窗口重建窗口内 badge 面可能缺失 set 方法。
        const badge = window.dshChamber?.badge
        if (badge === undefined || typeof badge.set !== 'function') return undefined
        return badge.set(count)
      },
      setTimer: (callback, ms) => setTimeout(callback, ms),
      clearTimer: handle => { clearTimeout(handle as ReturnType<typeof setTimeout>) },
      warn: error => { console.warn('[badge] 徽标计数推送失败：', error) },
    })
  }
  const badgeRetry = badgeRetryRef.current
  useEffect(() => {
    const count = projectBadgeCount(completedBySource, badgeSuppressionFacts(runtimeFacts))
    badgeCountRef.current = count
    // 把 renderer 派发的计数发布成只读回读值，可在测试中比对
    // 「徽标数 == 蓝点集合大小」，无需 IPC 或读主进程状态。
    publishBadgeCount(count)
    if (pushedCountRef.current === count) return
    // 只有真的派发出去才提交闸：没推出去（桥缺失/版本偏斜）时不提交，下一次 effect 提交
    // 同一计数还会再试（首个计数含重载复位的 0 永不丢）。
    if (badgeRetry.start(count, retryLimit, retryMs)) pushedCountRef.current = count
  }, [completedBySource, runtimeFacts, badgeRetry, retryLimit, retryMs])

  // 桥迟到的兜底（同 LISTENER_READY 重试纪律，见通知就绪 handshake）：窗口重载/
  // 重建后 completedBySource 复位为 {}，必须向主进程推 0 清除遗留徽标——桥经
  // requestAppInfo 异步暴露，可能晚于首个 [completedBySource, runtimeFacts]
  // effect 的提交时机（该 effect 在挂载帧即推 0，此时桥大概率未就绪）。有界重试
  // 直至桥出现，推一次当前计数（0）后停止；预算耗尽静默放弃（dev 无桥场景的
  // 正常路径）。
  useEffect(() => {
    // 判据是 set 是否真的在（版本偏斜时 badge 面可能已存在但还没有 set）：否则首推/重载复位
    let attempts = 0
    const timer = setInterval(() => {
      attempts += 1
      const badge = window.dshChamber?.badge
      if (badge !== undefined && typeof badge.set === 'function') {
        clearInterval(timer)
        badgeRetry.start(badgeCountRef.current, retryLimit, retryMs)
        return
      }
      if (attempts >= retryLimit) clearInterval(timer)
    }, retryMs)
    return () => clearInterval(timer)
  }, [badgeRetry, retryLimit, retryMs])

  // 卸载清理：清 pending 重推 timer，并作废在途 reject 的续链（不只是一条 timer）。
  useEffect(() => () => { badgeRetry.cancel() }, [badgeRetry])
}
