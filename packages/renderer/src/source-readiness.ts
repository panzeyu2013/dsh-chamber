/**
 * 来源就绪判定与遮罩动作决策。
 *
 * 背景：远程来源未就绪时点开会话，活动视图会停在全窗遮罩上——
 * 遮罩盖住整个窗口、多来源导航（侧栏）在壳内部，而 App 级失败覆盖层只在
 * 「已 settle 的失败」时出现。于是一个未 settle 的 boot 会形成一段**没有
 * 任何导航**的死区，最长由收割绝对放弃臂兜底（135s）。本模块把这段死区里
 * 需要的决策抽成纯逻辑（可被 node 单测直测，App/InstanceView 只做接线；
 * 另含推迟挂载的回收裁决与通道失败的上浮边界）：
 *
 *  1. `shouldDeferBootForSource`：手动断开（idle）的来源不启动 boot——不
 *     白烧一次注定 503 的 boot，也不把用户丢进加载态；遮罩直接呈现「未连接」
 *     +「连接」（显式用户意图，与设置页 Connect 同语义）。
 *  2. `decideServingGate`：来源相位感知的就绪门——只等 `ready` 会让
 *     `error`（快速重试耗尽）也烧满 60s 的 serving 预算；这里让 `error`
 *     在一个短宽限后立即判「不可服务」，把 60s 白等收敛到秒级；而
 *     `connecting`/`degraded`（恢复中）继续在预算内等。
 *  3. `veilState` / `veilShowsActions` / `shouldAnnounceRetryQueue`：遮罩何时从
 *     纯转圈升级为可操作态，以及重试在途时是否必须如实播报排队。
 *  4. `isDeferredReclaimDue`：被推迟（来源未连接）挂载的回收裁决——只接管
 *     从未 settle 的挂载，且绝不碰设置面板正在编辑的来源。
 *  5. `graphGapKindFor`：上浮边界——非本地来源的
 *     `not-injected` 豁免，本地实例的 `not-injected` 收敛为 `local-graph-not-injected`
 *     （chamber 侧安装/seed 事实，仍可自愈）。
 *
 * 纪律：本模块是叶子（零运行时 import——下面的 kind 类型是 `import type`，被类型
 * 擦除），被 App.tsx 与 InstanceView.tsx 同时引用时不会形成环；文案一律走
 * locales.ts 的 typed 字典，本模块只输出决策与结构化事实，不产出用户可见句子
 * （跨边界诊断文案规则）。
 */

import type { ShellDegradedKind } from './boot-gap.ts'

/** 来源相位的拼写与服务端 `SshStatusProjection.phase` / global.d.ts 一致：
 *  `idle | connecting | ready | degraded | error`（gateway 形态还会带上托管运行时的
 *  `stopped | restart-exhausted`，见 `isTerminalUnreadyPhase`）。入参一律按
 *  `string | undefined` 收，union 不导出——没有消费者，导出的类型只会成为死锚点。 */

/**
 * 传输已放弃（快速重试耗尽、进入慢速重探）的相位。
 *
 * **`degraded` 不在内**：它表示"重连在途"（App.tsx 的点击即时重连注释：
 * error = 快速重试耗尽，degraded = 重试在途），来源正在自愈——把门判死会让
 * 一次本可赶上的重连退化成"无图降级 + 事后冷重挂"，故 `degraded` 与
 * `connecting` 同属"未就绪慢态"，在预算内继续等。
 *
 * 入参刻意收成 `string | undefined`：来源相位从 `ChamberServerAggregate.phase`
 * （sidebar 包，`phase: string`）与 `serversPhaseRef` 镜像（`Record<string, string>`）
 * 流入，与 `boot-gap.ts` 的 `BootGapNoticeContext.phase: string | undefined`
 * 同一口径——在边界做字符串判等，union 只作为文档与测试锚点。 */
export function isTerminalUnreadyPhase(phase: string | undefined): boolean {
  // 词汇表与 sidebar 的姊妹门保持一致（`shared/serving-gate.ts` 的
  // TERMINAL_PHASES = error | stopped | restart-exhausted）：托管 dsh 的
  // stopped/restart-exhausted 同样是"再等也不会服务"。degraded 仍不在内（重连在途）。
  return phase === 'error' || phase === 'stopped' || phase === 'restart-exhausted'
}

/**
 * 手动断开（idle）的来源不启动 boot。
 *
 * 语义边界：idle 是**用户手动断开**的终态（App.tsx 的 ensureRemoteConnected
 * 明确不触碰它——「设置页 Connect 是显式恢复路径」）。自动 boot 一个 idle
 * 来源只会拿满 503 预算后降级，所以 boot 推迟到用户显式连接：遮罩呈现
 * 「未连接」+「连接」，点连接后相位离开 idle，再按正常路径 boot。
 * 未知相位（undefined，投影尚未到达）不推迟——不能因为投影没到就拒绝启动。
 */
export function shouldDeferBootForSource(phase: string | undefined): boolean {
  return phase === 'idle'
}

/**
 * 终态宽限：用户点击来源时 App 会先触发一次即时重连（ensureRemoteConnected），
 * 相位需要一两个 tick 才能翻到 connecting。若一看到 error 就判「不可服务」，
 * 会把「正在恢复」的来源误报成未连接；因此终态必须**持续**该宽限后才判终态。
 */
export const SERVING_TERMINAL_GRACE_MS = 1_500

/** 一次就绪门判定的输入。 */
export interface ServingGateFacts {
  /** 当前相位（undefined = 投影里还没有该来源）。 */
  phase: string | undefined
  /** 判定时刻（注入时钟，便于单测）。 */
  nowMs: number
  /** 本门观察到的终态起始时刻（null = 尚未观察到终态）。 */
  terminalSinceMs: number | null
}

/** 判定结果；`terminalSinceMs` 由调用方带回下一次判定（唯一的状态）。 */
export interface ServingGateDecision {
  action: 'serve' | 'unavailable' | 'wait'
  terminalSinceMs: number | null
}

/**
 * 就绪门的相位输入（纯函数）。
 *
 * - **原始 transport 投影缺席**（`rawProjectionPresent === false`）= 事实未到 ⇒
 *   `undefined`：门在预算内继续等，绝不把"投影还没到"读成手动断开；
 * - 原始投影在场 ⇒ 取**合并后**的派生相位：网关形态的 `stopped`/`restart-exhausted`
 *   （以及 `starting`/`restarting`）只存在于 `deriveServers` 的托管折叠里（原始
 *   `SshPhase` 只有 idle/connecting/ready/degraded/error），直接用原始相位会让终态
 *   词表在 App 路径上不可达、与 sidebar 姊妹门判得不一样。
 */
export function servingGatePhase(derivedPhase: string, rawProjectionPresent: boolean): string | undefined {
  return rawProjectionPresent ? derivedPhase : undefined
}

/**
 * 就绪门判定（纯函数）：`serve` = 图通道可以取；`unavailable` = 该来源此刻
 * 供不了图，boot 走既有的「无图降级」；`wait` = 继续轮询（受调用方的绝对
 * 截止兜底）。
 *
 * **`undefined`（投影尚未到达）走 `wait`，不是 `unavailable`**：调用方必须以
 * **原始 transport 投影**的相位喂入，不能用 `deriveServers` 的 `?? 'idle'` 折叠值
 * ——"事实未到"不等于"用户手动断开"，后者才是立即不可服务（折叠值会让缺投影的
 * 来源被秒判无图，把一次投影延迟变成无图挂载 + 只剩一次 ready 世代自愈）。
 */
export function decideServingGate(facts: ServingGateFacts): ServingGateDecision {
  const { phase, nowMs, terminalSinceMs } = facts
  if (phase === undefined) return { action: 'wait', terminalSinceMs: null }
  if (phase === 'ready') return { action: 'serve', terminalSinceMs: null }
  if (phase === 'idle') return { action: 'unavailable', terminalSinceMs: null }
  if (isTerminalUnreadyPhase(phase)) {
    const since = terminalSinceMs ?? nowMs
    if (nowMs - since >= SERVING_TERMINAL_GRACE_MS) return { action: 'unavailable', terminalSinceMs: since }
    return { action: 'wait', terminalSinceMs: since }
  }
  // connecting / degraded：都在"恢复中"，按未就绪慢态处理（绝对截止兜底）。
  return { action: 'wait', terminalSinceMs: null }
}

/** 图通道失败在 App 侧应上浮的降级事实种类（只产出这两种）。 */
export type GraphGapKind = Extract<ShellDegradedKind, 'graph-unavailable' | 'local-graph-not-injected'>

/**
 * 图通道失败 → App 侧降级事实的**唯一裁决**。
 *
 * 上浮面必须让用户停在 boot 表面时也能读到解释并拿到自愈：只把通道失败
 * 写进连接页的 pluginDiagnostic 一行（侧栏已不渲染它）会让用户既看不到解释也拿不到
 * 自愈。
 *
 * 唯一豁免是**非本地**来源的 `not-injected`（HTTP 404，或通道答 method 缺失）——
 * gateway/mobile 形态合法地没有图端点，那不是降级，App 也不该为它重挂。
 * **本地实例不在此列**：chamber 托管的本地宿主总会注入客户端图
 * （seed 行），404/method 缺失只可能是 chamber 自己的安装/seed 破损，属于可由
 * 重挂/重启本地 dsh 处理的事实，因此走独立的 `local-graph-not-injected`——其文案
 * 指向 chamber 侧原因，绝不建议"升级该来源的 dsh 运行时"（win32 上运行时管理是
 * 只读投影）。
 * @param diagnosticState - 通道分类结果（`not-injected` | `graph-unreachable`）。
 * @param instanceId - 来源 id（`'local'` 是 App 托管的本地实例）。
 * @returns 上浮的 kind，或 null（该形态按设计不上浮）。
 */
export function graphGapKindFor(diagnosticState: string, instanceId: string): GraphGapKind | null {
  if (diagnosticState !== 'not-injected') return 'graph-unavailable'
  return instanceId === 'local' ? 'local-graph-not-injected' : null
}

/**
 * 遮罩从「纯转圈」升级为「可操作态」的反馈窗。取 10s：与
 * `HEALTH_ERROR_GRACE_MS` 同量级，长于正常冷启动（控制面 3s 量级），
 * 短到用户不会以为程序死了。
 */
export const VEIL_ACTIONS_AFTER_MS = 10_000

/** 一次遮罩呈现的分类。 */
export type VeilState =
  /** 来源未连接：boot 被推迟，遮罩直接是可操作态（立即，不等反馈窗）。 */
  | 'boot-deferred'
  /** 正在 boot，仍在反馈窗内（纯转圈）。 */
  | 'loading'
  /** 正在 boot 且已超过反馈窗：升级为可操作态（**不是**失败声明）。 */
  | 'loading-stuck'
  /** boot 已 settle（壳或失败覆盖层接管）。 */
  | 'settled'

/** 遮罩呈现判定（纯函数）。 */
export function veilState(facts: { deferred: boolean; settled: boolean; waitedMs: number }): VeilState {
  if (facts.settled) return 'settled'
  if (facts.deferred) return 'boot-deferred'
  return facts.waitedMs >= VEIL_ACTIONS_AFTER_MS ? 'loading-stuck' : 'loading'
}

/** 遮罩是否显示动作（可操作态）。 */
export function veilShowsActions(state: VeilState): boolean {
  return state === 'loading-stuck' || state === 'boot-deferred'
}

/**
 * 推迟挂载的回收裁决。
 *
 * 只有"从未 settle"的推迟挂载由推迟回收臂接管：它不持有壳，也永远不会自己进入
 * retention 候选窗（候选要求 settled）。两道守卫缺一不可：
 * - `settingsTarget`：设置面板正在编辑的来源，拆壳 = 正在编辑的面板面消失
 *   （design 05 §5 的面板 hold；retention 候选循环有同一道守卫）。
 * - `busy`（活动/待开）：展示中的壳绝不回收（`reclaimView` 自身也会拒绝，
 *   这里同判以免把"该不该收"的结论建立在被调用方的二次守卫上）。
 *
 * 已经 settle 过的推迟壳回到 retention 的常规隐藏宽限与计数：它是真壳。
 */
export function isDeferredReclaimDue(input: {
  deferred: boolean
  settled: boolean
  busy: boolean
  settingsTarget: boolean
  hiddenSinceMs: number | undefined
  nowMs: number
  graceMs: number
}): boolean {
  if (!input.deferred || input.settled || input.busy || input.settingsTarget) return false
  const since = input.hiddenSinceMs
  return since !== undefined && input.nowMs - since >= input.graceMs
}

/**
 * 重试在途时必须如实播报：同 id 的新 boot 要先等同 id boot 尾（绝对上限
 * `INSTANCE_TAIL_WAIT_CAP_MS` = 两个 boot 预算），静默点击会让用户以为
 * 按钮没反应，或在放弃臂重新计时后又被判一次超时。
 *
 * 判据是**前一次尝试还没有 settle**（`queuedBehindPredecessor`），不是"第几次
 * 尝试"：boot 以失败 settle 后同 id 尾已经释放
 * （shell.ts 的 settle 路径先 await teardown），此时点重试根本不用排队——
 * 按次数播报会在最常见的"失败后重试"里撒谎。
 */
export function shouldAnnounceRetryQueue(queuedBehindPredecessor: boolean, settled: boolean): boolean {
  return queuedBehindPredecessor && !settled
}
