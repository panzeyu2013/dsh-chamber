/**
 * 揭示门（延迟揭示）：本叶子回答——**这一拍该把 painted 收敛到 selected，还是继续持有旧视图**。
 *
 * `runViewTransition` 的「渲染就绪后动画才开始」对冷 boot 不成立（目标未挂载时其"首帧"就是
 * 遮罩本身），因此可见性由 App 事实 `paintedView` 表达：点击只改 `activeView`（选择），
 * 屏上仍是旧视图，直到本叶子判定该揭示。
 *
 * 规则（顺序即优先级）：
 *  1. `selected === painted` ⇒ 稳态不做事；2. 目标不可挂载（已回收/退役）⇒ 立即收敛
 *     （绝不把死视图留在屏上等一个永远不来的揭示）；3. 目标 boot 失败 ⇒ 立即揭示（失败覆盖层
 *     模态且不透明）；4. 目标已 settle（booted 或 error）⇒ 立即揭示；5. 其余 ⇒ 持有到单调钟
 *     走过 `REVEAL_HOLD_MAX_MS` 才揭示（展示目标自己的主题化遮罩）。`holdStartedAtMs === null`
 *     = 窗口未锚定：保持持有，锚定由调用方在同一拍完成。
 *
 * 时基纪律：持有窗只做差值比较，调用方必须传单调钟（`performance.now()`）；墙钟回拨会让
 * 定时器算出负 elapsed 且不再重臂，故 `nowMs - holdStartedAtMs < 0` 按「未到期」处理。
 * 持有是**内容决策**：prefers-reduced-motion 只让过渡节退化，持有窗与截止窗不变。
 */

/** 旧视图最长的保留窗（ms）：1s 内覆盖典型预热/温壳 settle，更长会让「点了没反应」成为主投诉面。 */
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
 * 推进持有窗起点：`inFlight`（selected !== painted）= 一次在途揭示，窗口从它开始那一拍起算并
 * **不因换目标重置**（连点 B→C 时用户已等同一段墙钟；重置会把「点击后无反应」无限延长）；
 * 回到稳态即清空。
 */
export function revealHoldStartedAt(
  current: number | null,
  facts: { inFlight: boolean; nowMs: number },
): number | null {
  if (!facts.inFlight) return null
  return current ?? facts.nowMs
}

/**
 * 距到期还有多久（ms；钳到 [0, REVEAL_HOLD_MAX_MS]），调用方据此重臂一次性定时器。
 * 未锚定 ⇒ 返回满窗（不是 0）——锚定缺失绝不能变成提前揭示。
 */
export function revealHoldRemainingMs(holdStartedAtMs: number | null, nowMs: number): number {
  if (holdStartedAtMs === null) return REVEAL_HOLD_MAX_MS
  const elapsed = nowMs - holdStartedAtMs
  return Math.min(REVEAL_HOLD_MAX_MS, Math.max(0, REVEAL_HOLD_MAX_MS - elapsed))
}
