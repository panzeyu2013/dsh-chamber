/**
 * 来源就绪判定与遮罩动作决策（纯逻辑；App/InstanceView 只做接线）。
 *
 *  1. `shouldDeferBootForSource`：手动断开（idle）的来源不启动 boot（否则白烧一次 503 预算）。
 *  2. `decideServingGate`：相位感知就绪门——`error` 等终态在短宽限后立即判不可服务，
 *     `connecting`/`degraded`（恢复中）在预算内继续等。
 *  3. `isDeferredReclaimDue`：推迟挂载的回收裁决（只接管从未 settle 的挂载，绝不碰设置面板正在编辑的来源）。
 *  4. `graphGapKindFor`：图通道失败的上浮边界（非本地 `not-injected` 豁免，本地收敛为 `local-graph-not-injected`）。
 *
 * 叶子（零运行时 import，kind 为 `import type`）；只输出决策与结构化事实，文案走 locales.ts。
 */

import type { ShellDegradedKind } from './boot-gap.ts'

/** 来源相位拼写与服务端 `SshStatusProjection.phase` / global.d.ts 一致（gateway 形态还有
 *  `stopped | restart-exhausted`）。入参一律收 `string | undefined`；union 不导出（无消费者）。 */

/**
 * 传输已放弃的相位（快速重试耗尽、进入慢速重探）：error | stopped | restart-exhausted。
 * **`degraded` 不在内**——它表示重连在途，来源正在自愈，把门判死会退化成无图降级 + 事后冷重挂。
 * 入参刻意收 `string | undefined`：相位从 sidebar 聚合与 `serversPhaseRef` 镜像流入，边界做字符串判等。
 */
export function isTerminalUnreadyPhase(phase: string | undefined): boolean {
  // 与 sidebar 的姊妹门同词表（`shared/serving-gate.ts` 的 TERMINAL_PHASES）：托管 dsh 的
  // stopped/restart-exhausted 同样是"再等也不会服务"；degraded 不在内（重连在途）。
  return phase === 'error' || phase === 'stopped' || phase === 'restart-exhausted'
}

/**
 * 手动断开（idle）的来源不启动 boot：idle 是**用户手动断开**的终态，自动 boot 只会拿满
 * 503 预算后降级，所以推迟到用户显式连接（遮罩呈现「未连接」+「连接」）。
 * 未知相位（undefined，投影未到）不推迟——不能因为投影没到就拒绝启动。
 */
export function shouldDeferBootForSource(phase: string | undefined): boolean {
  return phase === 'idle'
}

/**
 * 终态宽限：用户点击来源会先触发一次即时重连（ensureRemoteConnected），相位需一两个 tick
 * 才翻到 connecting；终态必须**持续**该宽限后才判终态，避免把"正在恢复"误报成未连接。
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
 * 就绪门的相位输入（纯函数）：原始 transport 投影缺席 ⇒ `undefined`（事实未到，门继续等，
 * 绝不读成手动断开）；在场则取**合并后**的派生相位——gateway 的 `stopped`/`restart-exhausted`
 * 只存在于 `deriveServers` 的托管折叠里，直接用原始相位会让终态词表在 App 路径上不可达。
 */
export function servingGatePhase(derivedPhase: string, rawProjectionPresent: boolean): string | undefined {
  return rawProjectionPresent ? derivedPhase : undefined
}

/**
 * 就绪门判定（纯函数）：`serve` = 图可取；`unavailable` = 此刻供不了图（走无图降级）；
 * `wait` = 继续轮询（受调用方绝对截止兜底）。
 * **`undefined`（投影未到）走 wait，不是 unavailable**：调用方必须喂**原始 transport 投影**的
 * 相位，不能用 `deriveServers` 的 `?? 'idle'` 折叠值——"事实未到"不等于"用户手动断开"。
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
 * 图通道失败 → App 侧降级事实的唯一裁决。
 * 唯一豁免是**非本地**来源的 `not-injected`（HTTP 404 / method 缺失）——gateway/mobile 形态
 * 合法地没有图端点，不是降级。本地实例不在此列：chamber 托管的本地宿主总会注入客户端图
 * （seed 行），404/method 缺失只可能是 chamber 安装/seed 破损，走独立的
 * `local-graph-not-injected`——其文案指向 chamber 侧原因，绝不建议"升级该来源的 dsh 运行时"
 * （win32 上运行时管理是只读投影）。
 */
export function graphGapKindFor(diagnosticState: string, instanceId: string): GraphGapKind | null {
  if (diagnosticState !== 'not-injected') return 'graph-unavailable'
  return instanceId === 'local' ? 'local-graph-not-injected' : null
}

/**
 * 推迟挂载的回收裁决：只接管"从未 settle"的推迟挂载（它不持有壳，也永远不会进入
 * retention 候选窗）。两道守卫缺一不可：`settingsTarget`（设置面板正在编辑的来源，
 * 拆壳会让面板消失）与 `busy`（展示中的壳绝不回收）。已 settle 的推迟壳回到
 * retention 的常规隐藏宽限与计数——它是真壳。
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
 * `INSTANCE_TAIL_WAIT_CAP_MS` = 两个 boot 预算），静默点击会让用户以为按钮没反应。
 * 判据是**前一次尝试还没有 settle**，不是"第几次尝试"：boot 以失败 settle 后同 id 尾已释放
 * （shell.ts 的 settle 路径先 await teardown），此时点重试根本不用排队——按次数播报会在
 * 最常见的"失败后重试"里撒谎。
 */
export function shouldAnnounceRetryQueue(queuedBehindPredecessor: boolean, settled: boolean): boolean {
  return queuedBehindPredecessor && !settled
}
