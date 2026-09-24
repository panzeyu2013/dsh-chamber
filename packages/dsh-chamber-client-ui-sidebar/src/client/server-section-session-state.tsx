/**
 * Per-row state readers (label / pending / marker / dot) of the chamber sidebar
 * ServerSection subtree; the two-argument (server, session) reader shape is fixed.
 */
import type { ReactNode } from 'react'
import { IconChecklistOutline14, IconQuestionOutline14, IconWarningOutline16, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChamberServerAggregate } from '@dsh-chamber/dsh-chamber-client-core/aggregate-store'
import { runningRingVisible } from '@dsh-chamber/dsh-chamber-client-core/derive'
import { sessionRowState, subagentActivityOf } from '@dsh-chamber/dsh-chamber-client-core/session-row-state'
import { useSidebarSection } from './sidebar-context.ts'
import cc from './sidebar-chamber.module.css'

export function useServerSectionSessionState() {
  const { t } = useSidebarSection()
  // Per-row STATE indicator for the leading slot — NOT server identity (the source
  // header dot owns identity). Normal sessions show nothing; running shows the
  // official StateDot ongoing RING; completed-but-unread shows the chamber brand-blue
  // 6px dot (`.stateCompleted`), distinct from the connection green. Pending
  // (approval / plan-review / question) renders a 14px icon badge INSTEAD of the ring.
  // Priority (both functions below): pending > runningSubagents > completed > running —
  // a parent's running bit goes false while background subagents still work, and the
  // two reports may land one commit apart, so the fixed priority keeps that skew from hiding state.
  const sessionStateLabel = (server: ChamberServerAggregate, session: { id: string; running?: boolean }): string | undefined => {
    const facts = server.runtime?.sessions[session.id]
    const pending = facts?.pending
    if (pending !== undefined) {
      return pending === 'approval' ? t('status.waitingApproval')
        : pending === 'plan-review' ? t('status.planReview')
        : t('status.waitingAnswer')
    }
    // 只有确证在跑才播报「N 个子代理运行中」；来源 stale 或索引缺席时读数 unknown，中性呈现（不宣称在跑，也不冒充已完成）。
    if (subagentActivityOf(facts, server.runtime?.stale) === 'running') {
      const runningSubagents = facts?.runningSubagents ?? 0
      return t(runningSubagents === 1 ? 'status.subagentsRunning.one' : 'status.subagentsRunning.other', { n: runningSubagents })
    }
    if (facts?.completed === true) return t('status.completed')
    // 运行环只信完整聚合 snapshot 的 running 字段；runtime facts 不参与 OR/优先级合并，
    // 避免同一渲染事实双权威。已挂载来源由 ctx store 在 host-frame 事件上即时上报，未挂载走 30s unary 兜底。
    const running = runningRingVisible(facts?.running, session.running)
    if (running === true) return t('status.running')
    return undefined
  }
  /** Pending-interaction kind of the row, or undefined when not pending. */
  const sessionStatePending = (server: ChamberServerAggregate, session: { id: string }): 'approval' | 'plan-review' | 'question' | undefined =>
    server.runtime?.sessions[session.id]?.pending
  /** 行状态读数的机器可读标记——与圆点同一优先级输入。 */
  const sessionStateMarker = (server: ChamberServerAggregate, session: { id: string; running?: boolean }) => {
    const facts = server.runtime?.sessions[session.id]
    return sessionRowState({
      running: runningRingVisible(facts?.running, session.running),
      completed: facts?.completed,
      pending: facts?.pending,
      runningSubagents: facts?.runningSubagents,
      subagentActivity: facts?.subagentActivity,
      stale: server.runtime?.stale,
    })
  }
  const sessionStateDot = (server: ChamberServerAggregate, session: { id: string; running?: boolean }): ReactNode => {
    const facts = server.runtime?.sessions[session.id]
    const pending = facts?.pending
    // 子代理环只在确证在跑时点亮；unknown 中性（同 sessionStateLabel 的守卫）。
    const subagentsRunning = subagentActivityOf(facts, server.runtime?.stale) === 'running'
      && (facts?.runningSubagents ?? 0) > 0
    const running = runningRingVisible(facts?.running, session.running)
    if (pending === undefined && !subagentsRunning && facts?.completed !== true && running !== true) return null
    if (pending === 'approval') {
      return <IconWarningOutline16 className={cc.statePendingApproval} />
    }
    if (pending === 'plan-review') {
      return <IconChecklistOutline14 className={cc.statePendingPlan} />
    }
    if (pending === 'question') {
      return <IconQuestionOutline14 className={cc.statePendingQuestion} />
    }
    if (subagentsRunning) {
      // 后台子 agent 存活：父回合已结束但会话仍在工作中（子计数压过父 completed），蓝色完成点不得亮起。
      return <StateDot state="ongoing" size={10} />
    }
    if (facts?.completed === true) {
      // 完成未读用 chamber 品牌蓝点（.stateCompleted，6px），而非官方 StateDot `done`：
      // 后者取色 `--dsw-alias-state-success-primary` 与来源头连接绿点（`.statusOk`）完全相同，
      // 会让“会话完成未读”与“服务器已连接”同色。蓝点与运行环同属品牌蓝（`--dsw-static-deepseek-450`），形状/动效不同。
      return <span className={cc.stateCompleted} />
    }
    return <StateDot state="ongoing" size={10} />
  }
  return { sessionStateLabel, sessionStatePending, sessionStateMarker, sessionStateDot }
}
