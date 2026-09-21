/**
 * 揭示门（W3 延迟揭示，2026-12）：把「选中」与「屏上」拆开之后，本叶子回答唯一的
 * 问题——**这一拍该把 painted 收敛到 selected，还是继续持有旧视图**。
 *
 * 为什么需要它（事实，见 view-transition.ts:6-11 的语义）：`runViewTransition` 的
 * 「新状态渲染就绪后动画才开始」对冷 boot 不成立——目标未挂载时它的「首帧」就是遮罩
 * 本身，VT 无法在 boot 期保持旧视图。因此可见性必须在 VT 之外由 App 事实
 * `paintedView` 表达：点击只改 `activeView`（选择），屏上仍是旧视图，直到本叶子判定
 * 「该揭示了」，App 才经 `'view'` 过渡键把 painted 切到目标（交叉淡入 / 遮罩落地时
 * 硬切，判据不变）。
 *
 * 规则（顺序即优先级；全部为纯函数，node 直跑）：
 *  1. `selected === painted` ⇒ 稳态，无事可做（`steady`）；
 *  2. 目标不可挂载（已被回收 / 退役）⇒ **立即**收敛到 selected（`unmountable`）——
 *     绝不把死视图留在屏上等一个永远不来的揭示；
 *  3. 目标 boot 失败 ⇒ 立即揭示（`failed`）：App 的失败覆盖层是模态且不透明的，
 *     用户选的那个失败必须立刻可见（与 App 现在用 selected 渲染失败面同源）；
 *  4. 目标已 settle（booted 或 error）⇒ 立即揭示（`settled`，成功/失败都算）；
 *  5. 其余 ⇒ 持有，直到持有起点起的单调钟走过 REVEAL_HOLD_MAX_MS（`expired` 时才
 *     揭示；此时展示的是目标自己的遮罩——已归主题化，见 document-theme per-source
 *     快照 cache）。`holdStartedAtMs === null` = 窗口尚未锚定：本叶子保持持有，
 *     锚定由调用方在同一拍完成（App 的揭示 effect 先 `revealHoldStartedAt` 再判定）。
 *
 * 时基纪律（照 InstanceView.tsx:65-75 的既有理由）：持有窗只做差值比较，调用方必须
 * 传单调钟（`performance.now()`）；墙钟回拨会让一次定时器算出负 elapsed 且不再重臂。
 * 因此 `nowMs - holdStartedAtMs < 0` 按「未到期」处理——宁可多持有到下一次重算，
 * 也不因时钟异常提前揭示。
 *
 * 与动效无关（裁决，见蓝图 §2.4）：持有是**内容决策**；prefers-reduced-motion 只让
 * `view-transition.ts` 的过渡节退化，持有窗与截止窗不变。`revealHoldRemainingMs` 只
 * 是给调用方重臂定时器的算术，不产生任何动画语义。
 */

/** 旧视图最长的保留窗（ms）。低于 1s 不打断用户流；覆盖典型预热/温壳 settle；
 *  长于 1s 会让「点了没反应」变成主投诉面——宁可 1s 后给主题化的诚实进度面。 */
export const REVEAL_HOLD_MAX_MS = 1_000

export interface RevealFacts {
  /** 用户选中的来源（App 的 activeView）。 */
  selectedViewId: string
  /** 屏上真正可见的来源（App 的 paintedView）。 */
  paintedViewId: string
  /** 目标可挂载：在 mountedViews 且（local 或仍在 liveServerIds 内）。 */
  targetMountable: boolean
  /** 目标已 settle（isSettledShellState：booted || error !== null）。 */
  targetSettled: boolean
  /** 目标 boot 失败（error !== null）；缺省视为未知 = 未失败。 */
  targetFailed?: boolean
  /** 本次在途揭示的持有起点（单调钟 ms；null = 尚未锚定）。 */
  holdStartedAtMs: number | null
  /** 单调钟读数（performance.now()）。 */
  nowMs: number
}

export type RevealReason = 'steady' | 'painted' | 'unmountable' | 'settled' | 'failed' | 'expired'

export interface RevealVerdict {
  /** true = 这一拍把 painted 收敛到 selected；false = 继续持有旧视图。 */
  reveal: boolean
  reason: RevealReason
}

/** 规则见文件头（顺序即优先级）。 */
export function shouldReveal(facts: RevealFacts): RevealVerdict {
  if (facts.selectedViewId === facts.paintedViewId) return { reveal: false, reason: 'steady' }
  if (!facts.targetMountable) return { reveal: true, reason: 'unmountable' }
  if (facts.targetFailed === true) return { reveal: true, reason: 'failed' }
  if (facts.targetSettled) return { reveal: true, reason: 'settled' }
  if (facts.holdStartedAtMs !== null && facts.nowMs - facts.holdStartedAtMs >= REVEAL_HOLD_MAX_MS) {
    return { reveal: true, reason: 'expired' }
  }
  return { reveal: false, reason: 'painted' }
}

/**
 * 推进持有窗的起点：`inFlight`（selected !== painted）= 一次在途揭示，窗口从它开始的
 * 那一拍起算并**不因换目标重置**——连点 B→C 时用户已经等了同一段墙钟；每换一次目标就
 * 重置会把「点击后无反应」的窗口无限延长。回到稳态（inFlight 为假）即清空，下一次
 * 分叉重新起算。
 */
export function revealHoldStartedAt(
  current: number | null,
  facts: { inFlight: boolean; nowMs: number },
): number | null {
  if (!facts.inFlight) return null
  return current ?? facts.nowMs
}

/**
 * 距到期还有多久（ms；钳到 [0, REVEAL_HOLD_MAX_MS]）。调用方据此重臂一个一次性定时器
 * （照 InstanceView.tsx:385-400 的 surfaceFallbackTick 形态）：到期 tick 触发重算，
 * 判定必然放行。未锚定 ⇒ 返回满窗（而不是 0）——锚定缺失绝不能变成提前揭示。
 */
export function revealHoldRemainingMs(holdStartedAtMs: number | null, nowMs: number): number {
  if (holdStartedAtMs === null) return REVEAL_HOLD_MAX_MS
  const elapsed = nowMs - holdStartedAtMs
  return Math.min(REVEAL_HOLD_MAX_MS, Math.max(0, REVEAL_HOLD_MAX_MS - elapsed))
}
