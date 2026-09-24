/**
 * Per-row state readers (label / pending / marker / dot) of the chamber sidebar
 * ServerSection subtree. Consumers call the hook so the two-argument reader
 * shapes pinned by the dashboard source locks stay unchanged.
 *
 * SINGLE SOURCE (design 19 §3.2.1/§3.2.5): every reader below is derived
 * from ONE {@link sessionRowState} result — pending kind, subagent count,
 * label, dot and the machine-readable marker all come from the same
 * `sessionRowStateOf`. The goal presentation gate lives in that leaf module,
 * so an active goal (activation unknown included) can never leave one half of
 * the row showing "completed" while another suppresses it (R2-K/INV7).
 */
import type { ReactNode } from 'react'
import { IconChecklistOutline14, IconQuestionOutline14, IconWarningOutline16, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChamberServerAggregate } from '../shared/aggregate-store.ts'
import { runningRingVisible } from '../shared/derive.ts'
import { sessionRowState, type SessionRowStateResult } from '../shared/session-row-state.ts'
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
  // Running-ring authority is unchanged: the ring reads the complete aggregate
  // snapshot's `running` field only (runningRingVisible), never the channel.
  // The one resolved input is handed to sessionRowState — the shared leaf that
  // also owns the goal gate — so label, dot, marker and pending can never drift.
  const sessionRowStateOf = (server: ChamberServerAggregate, session: { id: string; running?: boolean }): SessionRowStateResult => {
    const facts = server.runtime?.sessions[session.id]
    return sessionRowState({
      running: runningRingVisible(facts?.running, session.running),
      completed: facts?.completed,
      pending: facts?.pending,
      runningSubagents: facts?.runningSubagents,
      subagentActivity: facts?.subagentActivity,
      stale: server.runtime?.stale,
      goal: facts?.goal,
    })
  }
  const sessionStateLabel = (server: ChamberServerAggregate, session: { id: string; running?: boolean }): string | undefined => {
    const row = sessionRowStateOf(server, session)
    switch (row.state) {
      case 'pending:approval':
        return t('status.waitingApproval')
      case 'pending:plan-review':
        return t('status.planReview')
      case 'pending:question':
        return t('status.waitingAnswer')
      case 'completed':
        return t('status.completed')
      case 'running':
        return t('status.running')
      default: {
        // P5：只有确证在跑才播报「N 个子代理运行中」；来源 stale 或索引缺席时读数是
        // unknown，中性呈现（不宣称在跑，也不冒充已完成）。
        if (!row.state.startsWith('subagents:')) return undefined
        const runningSubagents = row.subagents ?? 0
        return t(runningSubagents === 1 ? 'status.subagentsRunning.one' : 'status.subagentsRunning.other', { n: runningSubagents })
      }
    }
  }
  /** Pending-interaction kind of the row, or undefined when not pending. */
  const sessionStatePending = (server: ChamberServerAggregate, session: { id: string }): 'approval' | 'plan-review' | 'question' | undefined =>
    sessionRowStateOf(server, session).pending
  /** 仪表 I1/I13：行状态读数的机器可读标记——与圆点同一优先级输入（同一个派生结果）。 */
  const sessionStateMarker = (server: ChamberServerAggregate, session: { id: string; running?: boolean }): SessionRowStateResult =>
    sessionRowStateOf(server, session)
  const sessionStateDot = (server: ChamberServerAggregate, session: { id: string; running?: boolean }): ReactNode => {
    const row = sessionRowStateOf(server, session)
    switch (row.state) {
      case 'pending:approval':
        return <IconWarningOutline16 className={cc.statePendingApproval} />
      case 'pending:plan-review':
        return <IconChecklistOutline14 className={cc.statePendingPlan} />
      case 'pending:question':
        return <IconQuestionOutline14 className={cc.statePendingQuestion} />
      case 'completed':
        // 完成未读用 chamber 品牌蓝点（.stateCompleted，6px），而非官方 StateDot `done`：
        // 后者的取色 `--dsw-alias-state-success-primary` 与来源头连接状态
        // 绿点（`.statusOk` 同一 token）完全相同，"会话完成未读"与"服务器已连接"
        // 在同一侧栏里同色。蓝点与运行中的官方 ongoing 环同属品牌蓝
        // （`--dsw-static-deepseek-450`），但静态实心点 vs 8 格动画环形状/动效不同。
        // 被 goal 门压制时 state 永不落 completed（sessionRowState 已保证），所以
        // 蓝点不会在目标活跃期间亮起。
        return <span className={cc.stateCompleted} />
      case 'running':
        return <StateDot state="ongoing" size={10} />
      default:
        // 后台子 agent 存活：父回合虽已结束，会话仍处工作中（官方语义——
        // 子 agent 计数压过父 completed），绝不让蓝色完成点在此阶段亮起。
        return row.state.startsWith('subagents:') ? <StateDot state="ongoing" size={10} /> : null
    }
  }
  return { sessionStateLabel, sessionStatePending, sessionStateMarker, sessionStateDot }
}
