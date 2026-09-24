/**
 * Per-row state readers (label / pending / marker / dot) of the chamber sidebar
 * ServerSection subtree; the two-argument (server, session) reader shape is fixed.
 *
 * Single source (design 19 §3.2.1/§3.2.5): every reader below derives from ONE
 * {@link sessionRowState} result — the shared leaf that also owns the goal
 * presentation gate — so an active goal cannot leave one half of a row showing
 * "completed" while another suppresses it (R2-K/INV7).
 */
import type { ReactNode } from 'react'
import { IconChecklistOutline14, IconQuestionOutline14, IconWarningOutline16, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChamberServerAggregate } from '@dsh-chamber/dsh-chamber-client-core/aggregate-store'
import { runningRingVisible } from '@dsh-chamber/dsh-chamber-client-core/derive'
import { sessionRowState, type SessionRowStateResult } from '@dsh-chamber/dsh-chamber-client-core/session-row-state'
import { useSidebarSection } from './sidebar-context.ts'
import cc from './sidebar-chamber.module.css'

export function useServerSectionSessionState() {
  const { t } = useSidebarSection()
  // Per-row STATE indicator for the leading slot — NOT server identity (the source
  // header dot owns identity). Normal sessions show nothing; running shows the
  // official StateDot ongoing RING; completed-but-unread shows the chamber brand-blue
  // 6px dot (`.stateCompleted`), distinct from the connection green. Pending
  // (approval / plan-review / question) renders a 14px icon badge INSTEAD of the ring.
  // Priority: pending > runningSubagents > completed > running — a parent's running
  // bit goes false while background subagents still work, and the two reports may
  // land one commit apart, so the fixed priority keeps that skew from hiding state.
  // The one resolved input is handed to sessionRowState — the shared leaf that also
  // owns the goal gate — so label, pending, marker and dot can never drift.
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
        // 只有确证在跑才播报「N 个子代理运行中」；来源 stale 或索引缺席时读数 unknown，中性呈现（不宣称在跑，也不冒充已完成）。
        if (!row.state.startsWith('subagents:')) return undefined
        const runningSubagents = row.subagents ?? 0
        return t(runningSubagents === 1 ? 'status.subagentsRunning.one' : 'status.subagentsRunning.other', { n: runningSubagents })
      }
    }
  }
  /** Pending-interaction kind of the row, or undefined when not pending. */
  const sessionStatePending = (server: ChamberServerAggregate, session: { id: string }): 'approval' | 'plan-review' | 'question' | undefined =>
    sessionRowStateOf(server, session).pending
  /** 行状态读数的机器可读标记——与圆点同一优先级输入（同一个派生结果）。 */
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
        // 后者取色 `--dsw-alias-state-success-primary` 与来源头连接绿点（`.statusOk`）完全相同，
        // 会让“会话完成未读”与“服务器已连接”同色。蓝点与运行环同属品牌蓝（`--dsw-static-deepseek-450`），形状/动效不同。
        // 被 goal 门压制时 state 永不落 completed（sessionRowState 已保证），所以蓝点不会在目标活跃期间亮起。
        return <span className={cc.stateCompleted} />
      case 'running':
        return <StateDot state="ongoing" size={10} />
      default:
        // 后台子 agent 存活：父回合已结束但会话仍在工作中（子计数压过父 completed），蓝色完成点不得亮起。
        return row.state.startsWith('subagents:') ? <StateDot state="ongoing" size={10} /> : null
    }
  }
  return { sessionStateLabel, sessionStatePending, sessionStateMarker, sessionStateDot }
}
