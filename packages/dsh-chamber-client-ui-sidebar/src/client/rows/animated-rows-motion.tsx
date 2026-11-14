/**
 * `AnimatedRows` 的高频提交预算外壳（B6，渲染 P0；判定在 motion-budget.ts）。
 *
 * 为什么是子类而不是改 port：animated-rows.tsx 是 pinned vendor
 * `dsh-client-ui-primitives/src/AnimatedRows.tsx` 的逐字节移植（design 06 §7），
 * provenance 锁（test/session-rows/animated-rows.test.ts）要求「唯一 delta = props
 * interface 本地化」。本外壳在 React 调 `getSnapshotBeforeUpdate` 时**先**做预算判定：
 * 预算耗尽 ⇒ 返回 null，不进入 port 的 `readPositions`（逐行 getBoundingClientRect /
 * getComputedStyle）与 FLIP 动画创建；预算允许 ⇒ 原样委托 port，由 port 自己决定这次
 * 提交是否真有行位移。port 的静止态/取消语义不变：null 快照走 port 的
 * `componentDidUpdate` 清理分支（cancel 旧 movements），行即时落位、不留 transform。
 *
 * 位置记忆与可访问性：FLIP 是纯装饰（列表语义 role/label/data-row-key 与行内容都在 port
 * 之外，由调用方与行组件拥有）；跳过只影响「是否滑行」，不改变任何 state、焦点或行顺序。
 */
import { AnimatedRows } from './animated-rows.tsx'
import { shouldAnimateRowMotion } from './motion-budget.ts'

/** port 的唯一生命周期入参（`AnimatedRowsProps` 是 port 的 package-local 接口，不导出）。 */
type AnimatedRowsPortProps = Parameters<AnimatedRows['getSnapshotBeforeUpdate']>[0]
type AnimatedRowsPortSnapshot = ReturnType<AnimatedRows['getSnapshotBeforeUpdate']>

/**
 * Port + 每列表 FLIP 预算：两次 FLIP 起始批之间至少间隔 ROW_MOTION_MIN_INTERVAL_MS。
 * 正常交互（提交间隔 > 250ms）与 port 行为一致；高频 churn 期间只让每 250ms 的第一拍
 * 动，其余提交即时落位。
 */
export class AnimatedRowsMotion extends AnimatedRows {
  /** 上一轮真正启动 FLIP 的时刻（performance.now()；-Infinity = 尚未启动过）。 */
  private motionStartedAt = Number.NEGATIVE_INFINITY

  override getSnapshotBeforeUpdate(previous: AnimatedRowsPortProps): AnimatedRowsPortSnapshot {
    const now = performance.now()
    // 预算判定必须先于 super：port 的第一步就是逐行量几何（分配/布局主站）。
    if (!shouldAnimateRowMotion(this.motionStartedAt, now)) return null
    const snapshot = super.getSnapshotBeforeUpdate(previous)
    if (snapshot !== null) this.motionStartedAt = now
    return snapshot
  }
}
