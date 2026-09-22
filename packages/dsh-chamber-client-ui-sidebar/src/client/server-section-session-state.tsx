/**
 * Per-row state readers (label / pending / marker / dot) of the chamber sidebar
 * ServerSection subtree. Consumers call the hook so the two-argument reader
 * shapes pinned by the dashboard source locks stay unchanged.
 */
import type { ReactNode } from 'react'
import { IconChecklistOutline14, IconQuestionOutline14, IconWarningOutline16, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChamberServerAggregate } from '../shared/aggregate-store.ts'
import { runningRingVisible } from '../shared/derive.ts'
import { sessionRowState } from '../shared/session-row-state.ts'
import { useSidebarSection } from './sidebar-context.ts'
import cc from './sidebar-chamber.module.css'

export function useServerSectionSessionState() {
  const { t } = useSidebarSection()
  // chamber (06 §4.3/§4.5): per-row STATE indicator — the leading slot is NOT
  // a server-identity marker (the source header dot owns identity). Normal
  // sessions show nothing; running sessions show the official StateDot
  // ongoing RING; completed-but-unread sessions show the chamber brand-blue
  // 6px dot (`.stateCompleted`) so completion never shares the connection
  // dot's green (see the completed branch below).
  // Pending interactions (approval / plan-review / question) render a
  // distinguishable 14px icon badge INSTEAD of the running ring — a session
  // waiting for the user must be recognizable at a glance. The caller wraps
  // the result in the fixed 10px slot so titles stay aligned (pending rows
  // widen the slot to 14px). Priority (both functions below): pending >
  // runningSubagents > completed > running. A parent's own running bit goes
  // false the moment its round returns even while BACKGROUND subagents still
  // work (official sessionStatuses: runningSubagentCount outranks completed),
  // so `runningSubagents` (live channel) must outrank the completed dot and
  // the running ring; both reports derive from the same sessions store and
  // can land one commit apart, and the fixed priority keeps that transient
  // skew from hiding a user-relevant state.
  const sessionStateLabel = (server: ChamberServerAggregate, session: { id: string; running?: boolean }): string | undefined => {
    const facts = server.runtime?.sessions[session.id]
    const pending = facts?.pending
    if (pending !== undefined) {
      return pending === 'approval' ? t('status.waitingApproval')
        : pending === 'plan-review' ? t('status.planReview')
        : t('status.waitingAnswer')
    }
    const runningSubagents = facts?.runningSubagents ?? 0
    if (runningSubagents > 0) {
      return t(runningSubagents === 1 ? 'status.subagentsRunning.one' : 'status.subagentsRunning.other', { n: runningSubagents })
    }
    if (facts?.completed === true) return t('status.completed')
    // 运行环只信完整聚合 snapshot 的 running 字段；runtime facts 不参与
    // OR/优先级合并，避免同一渲染事实出现双权威。已挂载来源的 snapshot 由
    // ctx store 在 host-frame 事件上即时上报，未挂载来源走 30s unary 兜底。
    const running = runningRingVisible(facts?.running, session.running)
    if (running === true) return t('status.running')
    return undefined
  }
  /** Pending-interaction kind of the row, or undefined when not pending. */
  const sessionStatePending = (server: ChamberServerAggregate, session: { id: string }): 'approval' | 'plan-review' | 'question' | undefined =>
    server.runtime?.sessions[session.id]?.pending
  /** 仪表 I1/I13：行状态读数的机器可读标记——与圆点同一优先级输入。 */
  const sessionStateMarker = (server: ChamberServerAggregate, session: { id: string; running?: boolean }) => {
    const facts = server.runtime?.sessions[session.id]
    return sessionRowState({
      running: runningRingVisible(facts?.running, session.running),
      completed: facts?.completed,
      pending: facts?.pending,
      runningSubagents: facts?.runningSubagents,
      stale: server.runtime?.stale,
    })
  }
  const sessionStateDot = (server: ChamberServerAggregate, session: { id: string; running?: boolean }): ReactNode => {
    const facts = server.runtime?.sessions[session.id]
    const pending = facts?.pending
    const runningSubagents = facts?.runningSubagents ?? 0
    // 运行环只信完整 snapshot（runningRingVisible，见 sessionStateLabel）。
    const running = runningRingVisible(facts?.running, session.running)
    if (pending === undefined && runningSubagents === 0 && facts?.completed !== true && running !== true) return null
    if (pending === 'approval') {
      return <IconWarningOutline16 className={cc.statePendingApproval} />
    }
    if (pending === 'plan-review') {
      return <IconChecklistOutline14 className={cc.statePendingPlan} />
    }
    if (pending === 'question') {
      return <IconQuestionOutline14 className={cc.statePendingQuestion} />
    }
    if (runningSubagents > 0) {
      // 后台子 agent 存活：父回合虽已结束，会话仍处工作中（官方语义——
      // 子 agent 计数压过父 completed），绝不让蓝色完成点在此阶段亮起。
      return <StateDot state="ongoing" size={10} />
    }
    if (facts?.completed === true) {
      // 完成未读用 chamber 品牌蓝点（.stateCompleted，6px），而非官方 StateDot `done`：
      // 后者的取色 `--dsw-alias-state-success-primary` 与来源头连接状态
      // 绿点（`.statusOk` 同一 token）完全相同，"会话完成未读"与"服务器已连接"
      // 在同一侧栏里同色。蓝点与运行中的官方 ongoing 环同属品牌蓝
      // （`--dsw-static-deepseek-450`），但静态实心点 vs 8 格动画环形状/动效不同。
      return <span className={cc.stateCompleted} />
    }
    return <StateDot state="ongoing" size={10} />
  }
  return { sessionStateLabel, sessionStatePending, sessionStateMarker, sessionStateDot }
}
