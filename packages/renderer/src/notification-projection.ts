/**
 * 通知边沿的单一投影（P3，docs/progress/todo/session-authority-refactor.md）。
 *
 * WHY THIS EXISTS. Complete 通知此前有两条独立入口（壳 running 边沿 + facts observed
 * 完成），加上 `usableFacts` 抑制分支与两套去重（武装位与水位），规则散在
 * notification-edges.ts / App.tsx / use-bridge-subscriptions.ts 三处。本模块把
 * **证据归一**为一个策略：
 *
 *  - 有可用 facts 的来源：完成事实由 facts 证据拥有（host 域水位，可跨端收敛）；
 *    壳 running 边沿只贡献 ask/request，不再发 complete（这就是原先的 useFacts 抑制）；
 *  - 无 facts 的来源：完成由壳 running true→false / vendor completed 边沿给出，
 *    以「武装位」去重（重新 running 即解除）；
 *  - facts 证据：`completedAtSource === 'observed'` 且水位严格前进才通知
 *    （reconstructed 只出未读）；首份快照只播种水位（design 19 §3.5），两轨共用
 *    complete-ledger 的键空间。
 *
 * 规则本体仍复用既有纯函数（detectNotificationEdges / dedupeCompleteEdges /
 * watermark.ts），本模块只做「哪条证据作数 + 统一去重」的裁决。
 */
import {
  detectNotificationEdges,
  dedupeCompleteEdges,
  type NotificationEdge,
  type NotificationKind,
  type SessionFacts,
} from './notification-edges.ts'
import { completionWatermark, nextNotifiedWatermark, shouldNotifyWatermark } from './watermark.ts'

/** 一条待发通知；facts 入口带 host 域水位（壳边沿没有水位）。 */
export interface PlannedNotification extends NotificationEdge {
  readonly watermark?: number
}

/** facts 行的判定输入（unread-derivation 的同形子集）。 */
export interface NotificationFactsRow {
  readonly completedAt: number | null
  readonly completedAtSource?: 'observed' | 'reconstructed' | null
  readonly updatedAt: number
  readonly subagentCount: number
}

export interface RuntimeNotificationPlan {
  readonly edges: readonly PlannedNotification[]
  /** 更新后的武装位（调用方写回 complete-ledger）。 */
  readonly armed: Set<string>
}

/**
 * 壳边沿证据。`factsUsable` = 该来源此刻有可判的 facts 快照：此时 complete 归
 * facts 入口，本入口只保留 ask/request（并且 complete 边沿**不以任何形式**记账，
 * 否则 facts 水位相同的一次完成会被两条轨道各发一次）。
 */
export function planRuntimeNotifications(input: {
  readonly prev: Readonly<Record<string, SessionFacts>> | undefined
  readonly next: Readonly<Record<string, SessionFacts>>
  readonly factsUsable: boolean
  readonly armed: ReadonlySet<string>
}): RuntimeNotificationPlan {
  const edges = detectNotificationEdges(
    input.prev as Record<string, SessionFacts> | undefined,
    input.next as Record<string, SessionFacts>,
  )
  const eligible = input.factsUsable
    ? edges.filter(edge => edge.kind !== 'complete')
    : edges.filter(edge =>
        !(edge.kind === 'complete'
          && (input.next[edge.sessionId]?.runningSubagents ?? 0) > 0))
  const runningIds = Object.entries(input.next)
    .filter(([, facts]) => facts?.running === true)
    .map(([sessionId]) => sessionId)
  const deduped = dedupeCompleteEdges(eligible, input.armed, runningIds)
  // 已离开列表的会话清除武装记忆（长活来源的记忆不得缓慢增长）。
  for (const sessionId of [...deduped.notified]) {
    if (input.next[sessionId] === undefined) deduped.notified.delete(sessionId)
  }
  return { edges: deduped.edges, armed: deduped.notified }
}

export interface FactsNotificationPlan {
  readonly edges: readonly PlannedNotification[]
  /** 单调推进后的水位（每个 observed 行都记录，含首份播种）。 */
  readonly watermarks: Readonly<Record<string, number>>
  readonly armed: Set<string>
}

/**
 * facts 证据：每行单次裁决。水位轨是**唯一**的跨重挂去重依据；武装位用于
 * 「本轮已发」的即时去重（重新 running 时由壳入口解除）。
 */
export function planFactsNotifications(input: {
  readonly rows: Readonly<Record<string, NotificationFactsRow>>
  /** false = 首份快照：只播种水位，绝不发事件（桌面关闭期间的完成不补发）。 */
  readonly seeded: boolean
  readonly watermarks: Readonly<Record<string, number | undefined>>
  readonly armed: ReadonlySet<string>
}): FactsNotificationPlan {
  const watermarks: Record<string, number> = {}
  const armed = new Set(input.armed)
  const edges: PlannedNotification[] = []
  for (const sessionId of Object.keys(input.rows).sort()) {
    const row = input.rows[sessionId]
    if (row === undefined || row.subagentCount > 0) continue
    if (row.completedAtSource !== 'observed' || row.completedAt === null) continue
    const watermark = completionWatermark(row)
    if (watermark === undefined) continue
    const previous = input.watermarks[sessionId]
    const next = nextNotifiedWatermark(previous, watermark)
    if (next !== undefined) watermarks[sessionId] = next
    if (!input.seeded) continue
    if (!shouldNotifyWatermark(previous, watermark)) continue
    if (armed.has(sessionId)) continue
    armed.add(sessionId)
    edges.push({ sessionId, kind: 'complete', watermark })
  }
  return { edges, watermarks, armed }
}

export type { NotificationKind }
