/**
 * 完成未读账本的**派生投影**（主计划 §3.3-2 / R2；蓝图
 * notes/desktop-facts-wiring-blueprint.md §2-接线 2、§3.1-3.2）。
 *
 * 唯一未读谓词来自 sidebar shared 的 4 参 deriveUnread(completedAt,
 * lastTurnEnd, readThrough, updatedAt)（ABSENT/degraded turn-end 的武装分支由
 * Lead 修在那边，本模块**不重实现**）；本模块只做两件事：
 *   1. 通道边沿机（reconcileCompletedFacts，现行语义）在 channel-only / 事实
 *      缺席时继续承担 running→idle 武装（一套规则，不新写第二套）；
 *   2. 有 facts 行时 facts 是**该会话的完成权威**：deriveUnread 说未读才未读，
 *      通道边沿该会话即被事实结算（R12：aborted+user 不得因通道边沿假武装）。
 *
 * listComplete 是**唯一剪枝门**（R13）：只有 report.listComplete === true 才允许
 * 缺席会话离开账本；缺省/undefined 一律保留 prevLedger（列表短暂收缩不得假清）。
 *
 * 依赖注入：两个判定函数由调用方（App）传入 sidebar shared 的导出，
 * 使本模块保持零运行时 import——本地无 node_modules 的纯测试可直接 import 本
 * 模块，同时接线锁看得见 App 真的把共享导出喂进来了（R2 反作弊：不得自造一套）。
 */
import type { TurnEndFact } from '@dsh-chamber/dsh-chamber-client-ui-sidebar/shared'

/** facts 源的一行（session-state 判定输入；时间值全在 host/observer 域）。 */
export interface UnreadDerivationFactsRow {
  sessionId: string
  running: boolean
  updatedAt: number
  completedAt: number | null
  lastTurnEnd: TurnEndFact | null
  completedAtSource?: 'observed' | 'reconstructed' | null
  /**
   * B5：completedAt 的**时间域**（无壳观察者内部标注，gateway 事实源不携带）：
   *   - 'host'     = host 的 turn/end.time（epoch ms）——可并入 host 域读水位；
   *   - 'observer' = 客户端观察者戳（拿不到 host 时间时的降级）——只用于武装未读，
   *                  **绝不**推进读水位（客户端墙钟会污染 host 域水位，plan §5-13）。
   * 缺省/undefined = host 域（含 gateway 的 reconstructed：那里的观察者就在 host 上，
   * 其时间戳是 host 域——所以这里不能用 completedAtSource 当域判据）。
   */
  completedAtDomain?: 'host' | 'observer' | null
}

export interface UnreadDerivationDeps {
  deriveUnread: (
    completedAt: number | undefined,
    lastTurnEnd: TurnEndFact | null | undefined,
    readThrough: number | undefined,
    updatedAt: number | undefined,
  ) => boolean
  reconcileCompletedFacts: (params: {
    sessions: Record<string, { running?: boolean }>
    nextRunning: Record<string, boolean>
    prevRunning: Record<string, boolean>
    prevCompleted: Record<string, boolean>
    readingCurrent: string | undefined
  }) => { completed: Record<string, boolean>; changed: boolean }
}

export interface UnreadDerivationInput {
  /** gateway facts 行；undefined = channel-only / legacy / degraded。 */
  facts?: Readonly<Record<string, UnreadDerivationFactsRow>> | undefined
  /** 通道上报的 sessions（running 位）；undefined = 无挂载上报。 */
  channel?: Readonly<Record<string, { running?: boolean }>> | undefined
  /** R13：只有 true 才允许剪枝；缺省/undefined = 不剪。 */
  listComplete: boolean
  /** 易失 running 转移记忆（上一份）。 */
  prevRunning: Readonly<Record<string, boolean>>
  /** durable 未读回退账本（上一份投影；v2 edge 表）。 */
  prevLedger: Readonly<Record<string, boolean>>
  /** 该来源的 host 域读水位。 */
  readMarks: Readonly<Record<string, number>>
  /** 正在阅读的会话（paintedView ∩ current ∩ hasFocus，由 App 计算）。 */
  readingSessionId: string | undefined
  /** facts 快照是否可判（serviceable=false / 断连未知时 false ⇒ 原样保留 prevLedger）。 */
  factsVerified: boolean
}

export interface UnreadDerivationResult {
  /** 完成未读投影（写 completedBySource[source]，并作为 v2 edge 表落盘）。 */
  unread: Record<string, boolean>
  /** 写回的易失 running 记忆。 */
  nextRunning: Record<string, boolean>
  changed: boolean
}

function sameBooleanMap(
  left: Readonly<Record<string, boolean>>,
  right: Readonly<Record<string, boolean>>,
): boolean {
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) return false
  for (const key of leftKeys) {
    if ((left[key] === true) !== (right[key] === true)) return false
  }
  return true
}

/**
 * 读水位的组成（B5）：max(updatedAt, completedAt)。
 * completedAt 只在它是 **host 域观测**时参与；observer 域的降级戳（客户端观察者时钟）
 * 只用于武装未读，绝不推进 host 域读水位——plan §5-13「禁止客户端墙钟」/ W2 的
 * 「时钟 +1h 零假未读」判据。
 * 代价（已评估，接受）：observer 域完成事实的未读无法被「只阅读」清掉（读水位最多走到
 * updatedAt，完成事实仍高于它）——这是 fail-closed 的一侧，比用客户端墙钟把真正的
 * host 内容误判为已读安全。真正闭合需要 host 域的完成游标（plan §5-13 的 completion
 * seq），属判据级改动，本模块不动 deriveUnread 的四参判据。
 */
function factsWatermark(row: UnreadDerivationFactsRow): number {
  const updated = row.updatedAt > 0 ? row.updatedAt : 0
  const hostDomainCompletion = row.completedAtDomain === 'observer'
    ? 0
    : row.completedAt !== null && row.completedAt > 0 ? row.completedAt : 0
  return Math.max(updated, hostDomainCompletion)
}

export function deriveSourceUnread(
  input: UnreadDerivationInput,
  deps: UnreadDerivationDeps,
): UnreadDerivationResult {
  // 规则 0（R20/R14 的判定闸）：事实不可判 ⇒ 原样保留，不 clobber、不剪枝。
  // 注意 stale（断连但事实仍在）**不**在此闸内——R14 要求断连未读照常呈现。
  if (!input.factsVerified) {
    return {
      unread: { ...input.prevLedger },
      nextRunning: { ...input.prevRunning },
      changed: false,
    }
  }
  const channel = input.channel ?? {}
  const facts = input.facts ?? {}
  // 1. running 转移记忆：通道位 + （非权威列表时）保留缺席会话的旧记忆。
  const nextRunning: Record<string, boolean> = {}
  for (const [sessionId, row] of Object.entries(channel)) {
    nextRunning[sessionId] = row?.running === true
  }
  if (!input.listComplete) {
    for (const [sessionId, wasRunning] of Object.entries(input.prevRunning)) {
      if (nextRunning[sessionId] === undefined) nextRunning[sessionId] = wasRunning
    }
  }
  // 2. 通道边沿机（现行 arm/disarm/阅读解除/离表清扫规则，一套不改）。
  const edgeStep = deps.reconcileCompletedFacts({
    sessions: channel,
    nextRunning,
    prevRunning: input.prevRunning,
    prevCompleted: input.prevLedger,
    readingCurrent: input.readingSessionId,
  })
  const unread: Record<string, boolean> = {}
  const edge: Record<string, boolean> = { ...edgeStep.completed }
  const allIds = new Set<string>([...Object.keys(channel), ...Object.keys(facts)])
  for (const sessionId of [...allIds].sort()) {
    const fact = facts[sessionId]
    if (fact === undefined) {
      if (edge[sessionId] === true) unread[sessionId] = true
      continue
    }
    // 事实是该会话的完成权威（含 aborted+user 的抑制）；通道边沿在此结算，
    // 避免 R12 的「用户停止被通道 running→idle 假武装」。
    delete edge[sessionId]
    const viewing = sessionId === input.readingSessionId
    const factUnread = !viewing
      && deps.deriveUnread(
        fact.completedAt ?? undefined,
        fact.lastTurnEnd,
        input.readMarks[sessionId],
        fact.updatedAt,
      )
    if (factUnread) unread[sessionId] = true
  }
  // 3. 非权威列表（listComplete !== true）：缺席会话保留 prevLedger 的未读。
  if (!input.listComplete) {
    for (const [sessionId, wasUnread] of Object.entries(input.prevLedger)) {
      if (wasUnread !== true || allIds.has(sessionId) || unread[sessionId] === true) continue
      unread[sessionId] = true
    }
  }
  return { unread, nextRunning, changed: !sameBooleanMap(unread, input.prevLedger) }
}

/**
 * 正在阅读的会话水位推进：返回推进后的读水位（单调），供 App 在同一拍
 * 落盘 + ack + 重算；undefined/0 不臆造（蓝图 §3.4）。
 * 有 facts 行时取 max(updatedAt, completedAt)——但 completedAt 只在**host 域**时参与
 * （B5：completedAtDomain === 'observer' 的降级戳只武装、不推进读水位；见 factsWatermark）；
 * 无 facts 行时返回 undefined（通道边沿轨由 readingCurrent 结算）。
 */
export function viewingReadWatermark(
  row: UnreadDerivationFactsRow | undefined,
): number | undefined {
  if (row === undefined) return undefined
  const watermark = factsWatermark(row)
  return watermark > 0 ? watermark : undefined
}
