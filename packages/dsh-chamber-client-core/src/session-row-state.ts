/**
 * Session-row state marker（仪表 I1/I13）：
 * 把行尾状态**读数的出处**变成可
 * 查询的 DOM 事实，让验收判据不依赖文案、哈希类名或"看起来对"。
 *
 * 两个属性由调用方发出：
 *   `data-chamber-session-state` = none | running | subagents:N | pending:approval |
 *     pending:plan-review | pending:question | completed
 *   `data-chamber-state-source`  = wire | channel | derived | stale
 *
 * 优先级与行尾圆点**同一套**（pending > 子代理 > completed > running > 空槽），
 * 否则仪表会与用户看到的状态互相矛盾。P5：子代理档要求**确证在跑**（stale 或
 * 索引不可用时读数是 `unknown`，中性呈现，见 {@link subagentActivityOf}）。
 *
 * SOURCE 是「这个读数从哪来」，四值各有确切含义（验收要据此区分"显示的是刚发生
 * 的事实"还是"断连后残留的旧事实"）：
 *   - stale   断连来源上仍附加的只读事实——**最优先报出**，因为它是"这一个
 *             读数可能过期"的唯一机器信号；
 *   - channel chamberBridge 运行时通道提供的位：pending 来自官方 sessionStatus，
 *             completed 只来自 App 账本（通道自身永不携带 completed，见 mergeRuntimeFacts）；
 *   - derived chamber 自己的派生量（子代理后代计数，来自 vendor 谱系索引）；
 *   - wire    运行位：调用方传入的布尔——它已由生产者按官方规则
 *             `status?.running ?? row.running` 解析（resolveSessionRunning），
 *             `runningRingVisible` 只负责拒绝渲染面再长出第二个权威。
 * 纯函数、零依赖：node 直跑。
 *
 * goal 呈现门（design 19 §3.2.1/§3.2.5，2026-12）：本模块同时是 goal
 * 三值事实与该门的**零依赖叶模块**——{@link GoalFact}、{@link
 * goalSuppressesPresentation}、{@link goalHoldsCompletion} 都从这里导出，供
 * derive.ts（解析/签名）、todo-attention.ts（待办压制）与客户端呈现面共用；徽标
 * 计数（renderer 的 badge-count.ts，保持零 import）只消费谓词语义，不 import。
 * 压制时 `state` 必须落 running/none（**不得为 completed**），否则仪表与用户看到的
 * 点会互相撒谎（R2-K）。
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

/**
 * 一个会话行的 goal 三值事实（v5 §2.1）。
 *
 * 行字段的缺席/空值语义：`goal === undefined`（字段缺席）= **unknown**（投影还没给出
 * goal 键）；`goal === null` = **明确无 goal**；对象 = 有 goal。unknown 与 null 都
 * 不压制呈现（只有 active 相位压制），但通知层对 unknown 与 null 的裁决不同——形状
 * 保真地传下去，绝不在解析期折叠。
 */
export interface GoalFact {
  goalId: string
  revision: number
  phase: 'active' | 'paused' | 'blocked' | 'complete'
  /**
   * §2.2 事件缓存（`goal/activation-changed`）：armed/disarmed；**缺席 = unknown**。
   * unknown 绝不自动降级为 disarmed（那会假报「目标未继续运行」）；呈现门只读相位，
   * activation 只属于通知门。
   */
  activation?: 'armed' | 'disarmed'
  /** goal 投影值的 host 域毫秒（诊断与身份签名；不参与任何门判定）。 */
  updatedAt?: number
}

/**
 * 呈现门（v5 §2.3）：相位 active 即压制可见的「完成」，**含 activation unknown**
 * ——用户不得先看到一次假完成再等解析自愈（R2-J）；解析为 disarmed 后呈现自愈重现
 * （呈现不因 disarmed 而消失：门只看相位，见 §2.3 的刻意分叉）。
 */
export function goalSuppressesPresentation(goal: GoalFact | null | undefined): boolean {
  return goal?.phase === 'active'
}

/**
 * 通知门（v5 §2.3）：更窄——只有 active + armed 才「hold 完成通知」。
 * active + unknown 走通知层自己的未知分支 hold（§3.4 #5/#8），不在这里冒充 armed，
 * 也不自动降级 disarmed（unknown 的确定性出口只有 activation 事件或相位离开 active）。
 */
export function goalHoldsCompletion(goal: GoalFact | null | undefined): boolean {
  return goal?.phase === 'active' && goal.activation === 'armed'
}

export interface SessionRowStateFacts {
  /** 已解析的运行位（调用方用与圆点相同的规则解决快照/通道之争）。 */
  running?: boolean
  /** App 账本注入的完成位（经 `mergeRuntimeFacts` 合并后的事实行；通道自身永不携带）。 */
  completed?: boolean
  /** 等待输入的种类（运行时通道）。 */
  pending?: 'approval' | 'plan-review' | 'question'
  /** 运行中的子代理后代数（稀疏；>0 才覆盖 completed/running）。 */
  runningSubagents?: number
  /**
   * 子代理活动的可呈现性三值。`none` = 谱系索引可用且没有运行中的后代；
   * `running` = 确有运行中的后代；`unknown` = 索引不可用，或事实 stale
   * （断连来源上残留的计数不是「正在干活」的证据）。unknown 中性呈现：不点亮
   * 子代理读数，也不据此压制别的读数。
   */
  subagentActivity?: SubagentActivity
  /** 该来源的运行时事实是否 stale（断连/主机不可达时仍可附加）。 */
  stale?: boolean
  /**
   * v5 §2.1 行事实：缺席 = unknown，`null` = 明确无 goal，对象 = 有 goal。
   * {@link goalSuppressesPresentation} 是唯一的呈现裁决入口。
   */
  goal?: GoalFact | null
}

/** 子代理活动的三值（P5）。 */
export type SubagentActivity = 'none' | 'running' | 'unknown'

/**
 * 这一行实际的子代理活动。守卫只在这里：`stale` 的行（或显式 `unknown`）绝不
 * 报 `running`——断连来源上残留的计数不是「正在干活」的证据。行只带稀疏计数
 * （历史生产者/通道 overylay）时用同一守卫兜底，调用方不再各写一遍。
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

/**
 * 官方 `ctx.uiSession.sessionStatus` 投影收敛成运行位后的形状：`undefined` = 该会话
 * **尚无运行观测**（`publishStatus` 的 id 并集含「只因 pending 交互或完成提醒而存在」的
 * 行，且直接写 `this.running.get(id)`）。每来源每代一份。
 */
export type SessionRunningStatus = ReadonlyMap<string, boolean | undefined>

/**
 * 官方自己那条运行位解析规则的**唯一实现**
 * （`dsh-client-ui-workspace` 的 `sessionNode`：`running: status?.running ?? s.running`）：
 * ui-session 的实时 status 投影有观测就以它为准，会话列表行只是兜底。
 *
 * `false` 是一次**真实观测**，因此 `??` 是承重的：写成 `status || row` 会让一个
 * status=false 的行回落到陈旧行值（假运行环）。
 *
 * chamber 的每个运行位消费点都走这里——侧栏运行环、搜索行、驱动完成账本/通知边沿/未读/
 * 徽标的运行时事实通道、运行身份 mint、子代理谱系计数——一个渲染事实只有一条解析规则，
 * 且这条规则是**官方的**。
 *
 * 例外（**刻意**）：store 修复面（`readOfficialProjection` 与写回的自校验）读 store 自己
 * 的主张，因为它的职责是修 store，不是描述真相；两者分工在设计文档写明。
 */
export function resolveSessionRunning(
  statusRunning: SessionRunningStatus | undefined,
  sessionId: string,
  rowRunning: boolean | undefined,
): boolean {
  return statusRunning?.get(sessionId) ?? rowRunning === true
}

/**
 * `sessionRowState` 的完整读数——行尾点/文案、仪表属性、搜索行、待办条目与徽标
 * 计数共用这一个派生源（v5 §4 六面单源；徽标计数在 renderer 侧消费谓词）。
 */
export interface SessionRowStateResult {
  state: SessionRowStateKind
  source: SessionRowStateSource
  /** 行尾等待输入的 kind（消费方的 sessionStatePending 面）；缺席 = 不在等待输入。 */
  pending?: 'approval' | 'plan-review' | 'question'
  /** 确证在跑的子代理后代数（>0 才出现）；「N 个子代理运行中」文案读它。 */
  subagents?: number
  /** completed 位是否真正呈现为「完成」（未武装或被压制时为 false）。 */
  completedVisible: boolean
  /** goal 呈现门是否生效（可选落成 data-chamber-goal-active）。 */
  goalActive: boolean
  /**
   * 已武装的 completed 被哪个更高优先级事实挡住（仅 `completed === true` 且
   * `state !== 'completed'` 时出现）：
   *   - `subagents`：确证在跑的子代理后代（官方优先级 pending > subagents > completed）；
   *   - `goal`：goal 呈现门（相位 active，activation 已知）；
   *   - `unknown`：同一呈现门但 activation 仍未知（§2.2 静默窗口——通知层同态
   *     unknown-hold）。
   * pending 档不在本联合内：等待输入不是「压制」，故不标。
   */
  suppressedBy?: 'goal' | 'subagents' | 'unknown'
}

export function sessionRowState(facts: SessionRowStateFacts | undefined): SessionRowStateResult {
  const pending = facts?.pending
  const activity = subagentActivityOf(facts)
  // 只有「确证在跑」的子代理读数参与优先级；unknown 中性，不压 completed/running。
  const subagents = activity === 'running' ? (facts?.runningSubagents ?? 0) : 0
  const completed = facts?.completed === true
  const running = facts?.running === true
  const goal = facts?.goal
  const goalActive = goalSuppressesPresentation(goal)
  const source: SessionRowStateSource = facts?.stale === true
    ? 'stale'
    : pending !== undefined || completed
      ? 'channel'
      : subagents > 0
        ? 'derived'
        : 'wire'
  if (pending !== undefined) {
    return { state: `pending:${pending}`, source, pending, completedVisible: false, goalActive }
  }
  if (subagents > 0) {
    return {
      state: `subagents:${subagents}`,
      source,
      subagents,
      completedVisible: false,
      goalActive,
      ...(completed ? { suppressedBy: 'subagents' as const } : {}),
    }
  }
  if (completed) {
    if (goalActive) {
      // 压制时状态落 running/none（R2-K）：仪表绝不报一个用户看不到的 completed。
      return {
        state: running ? 'running' : 'none',
        source,
        completedVisible: false,
        goalActive,
        suppressedBy: goal?.activation === undefined ? 'unknown' : 'goal',
      }
    }
    return { state: 'completed', source, completedVisible: true, goalActive }
  }
  if (running) return { state: 'running', source, completedVisible: false, goalActive }
  return { state: 'none', source, completedVisible: false, goalActive }
}
