/**
 * Keyed-row FLIP 的高频提交预算（B6，渲染 P0）。
 *
 * WHY：`AnimatedRows` 的 FLIP 只在行键序列（membership/order）变化时启动，但启动一次就要
 * 逐行 `getBoundingClientRect`（+ 动画中的行 `getComputedStyle`）并为每个移动行
 * `element.animate` 分配 KeyframeEffect。流式高 churn 工况（facts 风暴 27 publish/s 引发的
 * 行集抖动、子代理会话行进出…）里这类位移是**帧级噪声**，人眼不需要也不该逐帧看完整 FLIP：
 * 动画批次会互相叠加，分配量随 churn 线性涨。故给每个列表一个最小起始间隔：间隔内到达的
 * 提交**即时落位**（与 resetKey/view-replacement 的 settle 同一条静止语义：不建动画、不留
 * transform），间隔外的第一拍照常完整 FLIP。
 *
 * 阈值 = 250ms：略大于 ROW_GLIDE_MS（200ms，见 animated-rows.tsx 的 port 常量），保证一批
 * 滑行结束前不叠加下一批；同时高于正常人类交互的连击间隔（创建/删除/拖拽提交、拖拽期间
 * ready=false 本来就停用），因此正常操作路径与 port 行为逐像素一致，只有 churn 被压到
 * ≤4 批/秒。
 *
 * 本模块零 React/DOM 依赖（plain-node 行为测可直 import）；React 接线在兄弟文件
 * animated-rows-motion.tsx 的子类里，port 本体（animated-rows.tsx）保持与 pinned vendor
 * 逐字节一致。
 */

/** 同一列表两次 FLIP 起始批之间的最小间隔（毫秒）。 */
export const ROW_MOTION_MIN_INTERVAL_MS = 250

/**
 * 本次提交是否允许启动一轮 FLIP（纯判定，单测直测）。
 *
 * - lastStartedAt 非有限（首次 = Number.NEGATIVE_INFINITY / 防御性 NaN）→ 允许；
 * - 距上次起始 ≥ ROW_MOTION_MIN_INTERVAL_MS → 允许；
 * - 间隔内（含时钟回拨 now < lastStartedAt）→ 跳过（保守：回拨不得放大动画频率）。
 */
export function shouldAnimateRowMotion(lastStartedAt: number, now: number): boolean {
  if (!Number.isFinite(lastStartedAt)) return true
  return now - lastStartedAt >= ROW_MOTION_MIN_INTERVAL_MS
}
