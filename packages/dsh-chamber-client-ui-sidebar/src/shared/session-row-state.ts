/**
 * Session-row state marker（仪表 I1/I13，plan §10 与
 * `notes/residual-verifiability-review.md` §5）：把行尾状态**读数的出处**变成可
 * 查询的 DOM 事实，让验收判据不再依赖文案、哈希类名或"看起来对"。
 *
 * 两个属性由调用方发出：
 *   `data-chamber-session-state` = none | running | subagents:N | pending:approval |
 *     pending:plan-review | pending:question | completed
 *   `data-chamber-state-source`  = wire | channel | derived | stale
 *
 * 优先级与行尾圆点**同一套**（pending > 子代理 > completed > running > 空槽），
 * 否则仪表会与用户看到的状态互相矛盾。
 *
 * SOURCE 是「这个读数从哪来」，四值各有确切含义（验收要据此区分"显示的是刚发生
 * 的事实"还是"断连后残留的旧事实"）：
 *   - stale   断连来源上仍附加的只读事实（R14）——**最优先报出**，因为它是"这一个
 *             读数可能过期"的唯一机器信号；
 *   - channel vendor 经 chamberBridge 运行时通道武装的位（pending/completed）；
 *   - derived chamber 自己的派生量（子代理后代计数，来自 vendor 谱系索引）；
 *   - wire    直读 wire 的运行位（调用方按 `runningRingVisible` 解决快照/通道之争后
 *             传入的布尔）。
 * 纯函数、零依赖：node 直跑。
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
  /** 该来源的运行时事实是否 stale（断连/主机不可达时仍可附加，R14）。 */
  stale?: boolean
}

export function sessionRowState(facts: SessionRowStateFacts | undefined): {
  state: SessionRowStateKind
  source: SessionRowStateSource
} {
  const pending = facts?.pending
  const subagents = facts?.runningSubagents ?? 0
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
