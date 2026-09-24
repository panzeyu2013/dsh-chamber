/**
 * Session-row state marker：把行尾状态**读数的出处**变成可查询、可机器判定的 DOM 事实。
 * 两个属性：`data-chamber-session-state` = none | running | subagents:N |
 * pending:approval | pending:plan-review | pending:question | completed；
 * `data-chamber-state-source` = wire | channel | derived | stale。
 * 优先级与行尾圆点**同一套**（pending > 子代理 > completed > running > 空槽），
 * 否则仪表会与用户看到的状态互相矛盾。子代理档要求**确证在跑**（stale 或索引
 * 不可用读作 `unknown`，中性呈现）。SOURCE 四值：stale = 断连来源上仍附加的只读
 * 事实（最优先报出，是"可能过期"的唯一机器信号）；channel = vendor 经运行时通道
 * 武装的位；derived = chamber 派生量（子代理后代计数）；wire = 直读 wire 运行位
 * （`runningRingVisible` 解决快照/通道之争）。纯函数、零依赖。
 */

export type SessionRowStateKind =
  | 'none'
  | 'running'
  | `subagents:${number}`
  | 'pending:approval'
  | 'pending:plan-review'
  | 'pending:question'
  | 'completed'

export type SessionRowStateSource = 'wire' | 'channel' | 'derived' | 'stale'

export interface SessionRowStateFacts {
  /** 已解析的运行位（调用方用与圆点相同的规则解决快照/通道之争）。 */
  running?: boolean
  /** vendor 武装的完成位（运行时通道）。 */
  completed?: boolean
  /** 等待输入的种类（运行时通道）。 */
  pending?: 'approval' | 'plan-review' | 'question'
  /** 运行中的子代理后代数（稀疏；>0 才覆盖 completed/running）。 */
  runningSubagents?: number
  /**
   * 三值。`unknown` = 索引不可用或事实 stale（残留计数不是「正在干活」的证据），
   * 中性呈现：不点亮子代理读数，也不据此压制别的读数。
   */
  subagentActivity?: SubagentActivity
  /** 该来源的运行时事实是否 stale（断连/主机不可达时仍可附加）。 */
  stale?: boolean
}

/** 子代理活动的三值（P5）。 */
export type SubagentActivity = 'none' | 'running' | 'unknown'

/**
 * 守卫只在这里：`stale` 的行（或显式 `unknown`）绝不报 `running`——断连来源上残留的
 * 计数不是「正在干活」的证据；只带稀疏计数（历史生产者/通道 overlay）时用同一守卫兜底。
 */
export function subagentActivityOf(
  facts: SessionRowStateFacts | undefined,
  stale?: boolean,
): SubagentActivity {
  const guarded = stale === true || facts?.stale === true
  const declared = facts?.subagentActivity
  if (declared !== undefined) return guarded && declared === 'running' ? 'unknown' : declared
  if ((facts?.runningSubagents ?? 0) <= 0) return 'none'
  return guarded ? 'unknown' : 'running'
}

export function sessionRowState(facts: SessionRowStateFacts | undefined): {
  state: SessionRowStateKind
  source: SessionRowStateSource
} {
  const pending = facts?.pending
  const activity = subagentActivityOf(facts)
  // 只有「确证在跑」的子代理读数参与优先级；unknown 中性，不压 completed/running。
  const subagents = activity === 'running' ? (facts?.runningSubagents ?? 0) : 0
  const completed = facts?.completed === true
  const running = facts?.running === true
  const source: SessionRowStateSource = facts?.stale === true
    ? 'stale'
    : pending !== undefined || completed
      ? 'channel'
      : subagents > 0
        ? 'derived'
        : 'wire'
  if (pending !== undefined) return { state: `pending:${pending}`, source }
  if (subagents > 0) return { state: `subagents:${subagents}`, source }
  if (completed) return { state: 'completed', source }
  if (running) return { state: 'running', source }
  return { state: 'none', source }
}
