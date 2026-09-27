/**
 * I3 修正 provenance 的标记生命周期（纯，node 可测）：侧栏生产者的 tier-3 写回把官方
 * running 位压成 false 之前落下标记，报告首次以非 running 承载该行时消费并打
 * `corrected: true`，让壳边沿在「无独立 host 域完成证据」时不产通知候选。
 *
 * 标记必须能被**撤回**，否则会伪造 provenance：写回抛出/自校验失败（store 位没变）时那些
 * id 的 false 边沿不可能来自本写回；写回成功但报告边沿迟迟不到时，之后的非 running 边沿
 * 也可能只是宿主自己的完成——租约到期即弃标（宁可重复通知，也不吞掉真完成）。规则在本模块
 * 单测，生产者（React/cordis 环境）只做 I/O。
 */
import { assertSingletonModule } from './singleton.ts'

assertSingletonModule('session-correction-marks')

/** 报告行上标记需要的最小形状。 */
export interface CorrectionMarkRow {
  running?: boolean
}

export interface CorrectionMarks {
  /** 写回**之前**武装；deadline = now + ttlMs。 */
  arm(ids: readonly string[], now: number): void
  /** 撤回（写回抛出、自校验失败、或任何证明该写回没产生边沿的证据）。 */
  retract(ids: readonly string[]): void
  /** 按一拍报告消费：返回必须打 `corrected: true` 的 id；过期、行消失即弃标。 */
  consume(rows: Readonly<Record<string, CorrectionMarkRow | undefined>>, now: number): string[]
  size(): number
}

export function createCorrectionMarks(ttlMs: number): CorrectionMarks {
  const marks = new Map<string, number>()
  return {
    arm(ids, now) {
      const deadline = now + ttlMs
      for (const id of ids) marks.set(id, deadline)
    },
    retract(ids) {
      for (const id of ids) marks.delete(id)
    },
    consume(rows, now) {
      const tagged: string[] = []
      for (const [id, deadline] of [...marks]) {
        const row = rows[id]
        // 行消失（会话被删/移出投影）或租约到期：标记无对象可描述，弃标而不是留着等下一次。
        if (row === undefined || now >= deadline) {
          marks.delete(id)
          continue
        }
        if (row.running === true) continue
        marks.delete(id)
        tagged.push(id)
      }
      return tagged
    },
    size() {
      return marks.size
    },
  }
}
