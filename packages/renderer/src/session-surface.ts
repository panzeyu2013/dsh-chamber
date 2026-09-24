/**
 * 会话面绘制信号——以"壳自己画出了什么"为准，而非 App 侧事实猜就绪。相位取自官方会话根
 * `div[data-phase]`：
 *  - `hero`：未选中会话，或选中的是"空白新会话"——**无正当内容**，遮罩保持；
 *  - `settling`：会话已选中但内容仍在载入（或等父目录可用）——同样保持遮罩；
 *  - `active`：上游"非 hero 非 settling"的兜底值——它**释放遮罩**，所以这个方向是 fail-open：
 *    只保证"不是 hero/settling"，不保证"有正当内容"，也不保证"是请求的那个会话"；
 *  - `absent`：取不到会话根（boot 早期，或 ui-chat 未注册的降级形态）。
 * `data-phase` 在同一容器里有多个发射点（composer 也发），读取**不靠"第一个** `[data-phase]`，
 * 而是从恒在的 {@link SESSION_SCROLL_ANCHOR} 反查最近的 `[data-phase]` 祖先；取不到按 `absent`。
 *
 * 释放规则：兜底窗必须从"已 settle 且揭示门首次持有"起算，**绝不能**锚在 shell settle 时刻——
 * 温壳上 settle 早已是几分钟前，会让持有窗第一帧就过期。`active` ⇒ 立即释放；`absent`/`unknown`
 * ⇒ 共享表 2s 兜底；`hero`/`settling` ⇒ 保持，只留 70s 外层保险；未 settle 或时钟未建立 ⇒
 * 永不释放（新持有时第一帧相位可能是上一代残留）。释放是**电平**而非闩锁：相位回到
 * `hero`/`settling` 遮罩仍会回来，否则一次瞬时 `active` 会让空白"新会话"在整个 open 窗内裸露。
 * 叶子（零运行时 import）；DOM 访问只在 {@link readSessionSurfacePhase} 的入参接口上（接线在 InstanceView）。
 */

/** 会话根相位取值域。`unknown` 独立于 `hero`：读不懂的取值与 `absent` 同走 2s 兜底，
 *  版本歪斜的锚点不能把用户按在 70s 保险上。 */
export type SessionSurfacePhase = 'absent' | 'hero' | 'settling' | 'active' | 'unknown'

/** 会话根相位属性的名字（观察器 attributeFilter 与查询共用一处定义）。 */
export const SESSION_PHASE_ATTRIBUTE = 'data-phase'

/**
 * 会话根反查锚：`[data-conversation-scroll]` 在 hero/settling/active 三态都由官方
 * ConversationRoot 恒渲染（composer 在其内部），从它 `closest` 向上拿相位比"容器内第一个
 * `[data-phase]`"更结构化（上游再加/前插相位节点也不会读错）。
 */
export const SESSION_SCROLL_ANCHOR = '[data-conversation-scroll]'

/**
 * 相位采样（MutationObserver → 相位落 state）的最小间隔：每次 DOM 变更排一帧的采样在各源壳
 * 同时装载时等于每帧一次 React 状态更新；合并到 100ms 并保证尾部采样后语义不变
 * （最终相位一定会被观察到，判定不依赖中间帧）。
 */
export const SURFACE_SAMPLE_MIN_INTERVAL_MS = 100

// 相位→上界映射与两个阈值（2s 兜底 / 70s 外层保险）的唯一判定在共享包的
// `surfaceBoundMs`/`decidePresentation`（阈值 `PRESENTATION_THRESHOLDS`，tables.ts/tables.json 同源）；
// 组件只消费帧里的 `veil`/`releaseAtMonoMs`，本模块只保留相位读取与采样间隔常量。

/** 读取相位所需的最小 DOM 面（node 测试用桩即可，不依赖真实 DOM）。 */
export interface SessionSurfaceRoot {
  querySelector(selector: string): {
    closest(selector: string): { getAttribute(name: string): string | null } | null
  } | null
}

/**
 * 读取容器内的会话根相位：`[data-conversation-scroll]` → 最近的 `[data-phase]` 祖先。
 * 取不到锚点/祖先返回 `absent`（共享表 2s 兜底）；取值未知返回 `unknown`（同界），
 * 绝不把"没看懂"读成"已就绪"，也不用 hero 的 70s 保险按住版本歪斜的锚点。
 */
export function readSessionSurfacePhase(root: SessionSurfaceRoot): SessionSurfacePhase {
  const anchor = root.querySelector(SESSION_SCROLL_ANCHOR)
  const node = anchor === null ? null : anchor.closest(`[${SESSION_PHASE_ATTRIBUTE}]`)
  if (node === null) return 'absent'
  const raw = node.getAttribute(SESSION_PHASE_ATTRIBUTE)
  if (raw === 'active' || raw === 'settling' || raw === 'hero') return raw
  return 'unknown'
}
