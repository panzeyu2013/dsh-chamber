/**
 * 完成未读账本的**派生投影**。
 * 唯一未读谓词来自 client-core 的 4 参 `deriveUnread`（本模块**不重实现**）；本模块只做两件事：
 *   1. 通道边沿机（`reconcileCompletedFacts`）在 channel-only / 事实缺席时承担 running→idle 武装；
 *   2. 有 facts 行时 facts 是该会话的**完成权威**（通道边沿被结算，aborted+user 不得假武装）。
 * `listComplete` 是**唯一剪枝门**：只有 `listComplete === true` 才允许缺席会话离开账本，
 * 缺省/undefined 一律保留 `prevLedger`（列表短暂收缩不得假清）。
 * 判定函数由调用方注入 client-core 的导出（零运行时 import），接线锁确保 App 喂的是共享导出。
 */
import type { TurnEndFact } from '@dsh-chamber/dsh-chamber-client-core'

/** facts 源的一行（session-state 判定输入；时间值全在 host/observer 域）。 */
export interface UnreadDerivationFactsRow {
  sessionId: string
  running: boolean
  updatedAt: number
  completedAt: number | null
  lastTurnEnd: TurnEndFact | null
  completedAtSource?: 'observed' | 'reconstructed' | null
  /**
   * completedAt 的**时间域**（无壳观察者内部标注，gateway 事实源不携带）：
   * 'host'（可并入 host 域读水位）或 'observer'（客户端观察者戳——只武装未读，
   * **绝不**推进读水位）；缺省 = host 域（含 gateway 的 reconstructed：其观察者就在 host 上）。
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
  /** 只有 true 才允许剪枝；缺省/undefined = 不剪。 */
  listComplete: boolean
  /** 易失 running 转移记忆（上一份）。 */
  prevRunning: Readonly<Record<string, boolean>>
  /** durable 未读回退账本（上一份投影；v4 edge 表）。 */
  prevLedger: Readonly<Record<string, boolean>>
  /** 该来源的 host 域读水位。 */
  readMarks: Readonly<Record<string, number>>
  /** 正在阅读的会话（paintedView ∩ current ∩ hasFocus，由 App 计算）。 */
  readingSessionId: string | undefined
  /**
   * facts 快照是否可判。**只有快照缺席**（通道 withdrawn / 未观察）才是 true 的 channel-only
   * 情形；快照在场但 `isFactsDecisionUsable` 为假（verdict≠ok / serviceable=false / **stale**）
   * ⇒ false ⇒ 原样保留 prevLedger（「冻结的未知」，不剪枝、不 clobber）。谓词唯一家见
   * `session-facts-source.ts`；接线锁 `test/wiring/session-authority-wiring.test.ts`。
   */
  factsVerified: boolean
}

export interface UnreadDerivationResult {
  /** 完成未读投影（写 completedBySource[source]，并作为 v4 edge 表落盘）。 */
  unread: Record<string, boolean>
  /** 写回的易失 running 记忆。 */
  nextRunning: Record<string, boolean>
  changed: boolean
}

/** 同形布尔表比较（账本 identity 闸）。 */
export function sameBooleanMap(
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
 * 读水位的组成：max(updatedAt, completedAt)，completedAt 只在 **host 域观测**时参与；
 * observer 域的降级戳（客户端墙钟）只武装未读，绝不推进 host 域读水位。
 * 代价（已评估、接受）：observer 域完成事实的未读无法被"只阅读"清掉——这是 fail-closed 的一侧，
 * 比用客户端墙钟把真正的 host 内容误判为已读安全；真正闭合需要 host 域完成游标。
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
  // 规则 0（判定闸）：事实不可判 ⇒ 原样保留 prevLedger/prevRunning，不 clobber、不剪枝。
  // 不可判 = 快照**在场**但 isFactsDecisionUsable 为假（verdict≠ok / serviceable=false /
  // **stale**：载体已断、行仍在）。此时**冻结**是刻意的：断连未读照常呈现靠的是「不动」，
  // 不是「按另一条通道重算」——重算会把已武装的完成点剪掉又在恢复时重新武装（闪）。
  // 快照**缺席**（断连撤回首报、来源未观察）是另一支：factsVerified=true，channel-only 照常派生。
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
    // 避免「用户停止被通道 running→idle 假武装」。
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
 * 正在阅读的会话水位推进：返回推进后的读水位（单调），undefined/0 不臆造。
 * 有 facts 行时取 max(updatedAt, completedAt)，但 completedAt 只在 **host 域**参与
 * （observer 降级戳只武装、不推进读水位）；无 facts 行返回 undefined（通道边沿轨结算）。
 */
export function viewingReadWatermark(
  row: UnreadDerivationFactsRow | undefined,
): number | undefined {
  if (row === undefined) return undefined
  const watermark = factsWatermark(row)
  return watermark > 0 ? watermark : undefined
}
