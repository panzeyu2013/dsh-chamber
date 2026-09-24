/**
 * 通知边沿的单一投影（P3，design 14 §D4「会话事实单一权威」）。
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
import type { SessionRunId } from '@dsh-chamber/dsh-stream-state'
import { LEGACY_NOTIFIED_RUN_ID, isStaleRunIdentity, notificationRunId } from './notification-identity.ts'
import { completionWatermark } from './watermark.ts'

/** 一条待发通知；facts 入口带 host 域水位/事件序与运行身份（壳边沿可缺席）。 */
export interface PlannedNotification extends NotificationEdge {
  readonly watermark?: number
  readonly completionSeq?: number
  /** 本次完成所属的运行身份；缺省 = 调用方入队时解析（壳边沿无 facts）。 */
  readonly runId?: SessionRunId
}

/** facts 行的判定输入（unread-derivation 的同形子集）。 */
export interface NotificationFactsRow {
  readonly completedAt: number | null
  readonly completedAtSource?: 'observed' | 'reconstructed' | null
  readonly updatedAt: number
  readonly subagentCount: number
  readonly lastTurnEnd?: { readonly seq?: number | null } | null
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
  // A running flag fences the armed memory ONLY when it is provably newer than the
  // last observation: a late same-activity running=true (replayed after the run
  // completed) is not a new run and must not re-arm the completed edge.
  const runningIds = Object.entries(input.next)
    .filter(([sessionId, facts]) => facts?.running === true
      && activityAdvanced(input.prev?.[sessionId], facts))
    .map(([sessionId]) => sessionId)
  const deduped = dedupeCompleteEdges(eligible, input.armed, runningIds)
  // 已离开列表的会话清除武装记忆（长活来源的记忆不得缓慢增长）。
  for (const sessionId of [...deduped.notified]) {
    if (input.next[sessionId] === undefined) deduped.notified.delete(sessionId)
  }
  return { edges: deduped.edges, armed: deduped.notified }
}

/** Undefined on either side means the ordering cannot be proven: keep current behavior. */
function activityAdvanced(prev: SessionFacts | undefined, next: SessionFacts | undefined): boolean {
  if (prev === undefined || prev.updatedAt === undefined || next?.updatedAt === undefined) return true
  return next.updatedAt > prev.updatedAt
}

export interface FactsNotificationPlan {
  readonly edges: readonly PlannedNotification[]
  /** 本 tick 应记账的运行身份（首帧播种 / 迁移哨兵认领 / 已发边沿）。 */
  readonly runs: Readonly<Record<string, SessionRunId>>
  readonly armed: Set<string>
}

/**
 * facts 证据：每行单次裁决。水位轨是**唯一**的跨重挂去重依据；武装位用于
 * 「本轮已发」的即时去重（重新 running 时由壳入口解除）。
 */
export function planFactsNotifications(input: {
  readonly rows: Readonly<Record<string, NotificationFactsRow>>
  /** 身份解析需要；与 facts 通道同源的来源代际。 */
  readonly sourceFingerprint: string
  /** false = 首份快照：只播种身份，绝不发事件（桌面关闭期间的完成不补发）。 */
  readonly seeded: boolean
  /** 身份轨：该来源各会话最后一次已通知的运行身份（含迁移哨兵）。 */
  readonly notifiedRuns?: Readonly<Record<string, SessionRunId | undefined>>
  readonly armed: ReadonlySet<string>
  /** 正等待原生回执的会话；不能把运行时边沿当作已结算。 */
  readonly pendingSessions?: ReadonlySet<string>
  /** 无 host 身份的运行时完成已经获得原生 shown / policy suppressed 回执。 */
  readonly runtimeSettled?: ReadonlyMap<string, number | undefined>
}): FactsNotificationPlan {
  const runs: Record<string, SessionRunId> = {}
  const armed = new Set(input.armed)
  const edges: PlannedNotification[] = []
  for (const sessionId of Object.keys(input.rows).sort()) {
    const row = input.rows[sessionId]
    if (row === undefined || row.subagentCount > 0) continue
    if (row.completedAtSource !== 'observed' || row.completedAt === null) continue
    const watermark = completionWatermark(row)
    if (watermark === undefined) continue
    const seq = row.lastTurnEnd?.seq
    const completionSeq = typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 0 ? seq : undefined
    const runId = notificationRunId({ sourceFingerprint: input.sourceFingerprint, sessionId, completionSeq, watermark })
    if (!input.seeded && input.pendingSessions?.has(sessionId)) continue
    // Seeding (first snapshot after a boot): record the identity, never emit.
    if (!input.seeded) {
      runs[sessionId] = runId
      continue
    }
    // A runtime edge already got a native settlement; it may adopt this facts
    // completion ONLY when the facts row does not postdate the host state that edge
    // covered (the runtime row's updatedAt is the ordering anchor). Otherwise the
    // completion belongs to a LATER run and must notify - the old session-scoped
    // marker silently swallowed that run's banner.
    if (input.runtimeSettled?.has(sessionId) === true && !input.pendingSessions?.has(sessionId)) {
      const anchor = input.runtimeSettled.get(sessionId)
      // SAME-DOMAIN comparison: the anchor is the host `updatedAt` the runtime edge
      // observed, and the facts row carries the same host field. completedAt is a
      // DIFFERENT field and is normally LATER than the last message timestamp, so
      // comparing it here re-notified an already-receipted completion.
      if (anchor === undefined || row.updatedAt <= anchor) {
        runs[sessionId] = runId
        continue
      }
    }
    if (input.pendingSessions?.has(sessionId)) continue
    // IDENTITY IS THE TRIGGER (D1): one notification per run, however many
    // snapshots re-observe it.
    const previousRun = input.notifiedRuns?.[sessionId]
    if (previousRun === runId) continue
    // v4 migration: a pre-spine journal knew the session was notified but not the
    // run. Adopt the live identity WITHOUT notifying. The sentinel lives only
    // until this write (or the prune when the session leaves the list).
    if (previousRun === LEGACY_NOTIFIED_RUN_ID) {
      runs[sessionId] = runId
      continue
    }
    // A regressed observation (stale list, host clock correction) is not a new run:
    // monotonicity now derives from the persisted identity itself, not a table.
    if (previousRun !== undefined && isStaleRunIdentity(previousRun, runId)) continue
    armed.add(sessionId)
    edges.push({ sessionId, kind: 'complete', watermark, runId,
      ...(completionSeq === undefined ? {} : { completionSeq }) })
  }
  return { edges, runs, armed }
}

export type { NotificationKind }
