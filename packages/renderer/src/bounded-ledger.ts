/**
 * 有界集合内核：把「容量 + 尾部入队 + 头部淘汰」从各账本里抽出，
 * 容量策略与淘汰诊断只有一处答案。
 * 适用：notification-ledger 的决定环（尾部入队 + 头部淘汰）。
 * 不并入的族（状态机型，不是容器问题）：authority 的三级阶梯滚动窗、baseline-harvest attempts/backoff、
 * pending-open deadline 队列、prewarm-ledger 计数表。
 */

export interface BoundedList<V> {
  /** 尾部入队；容量 <= 0 时丢弃并返回 false。 */
  push(value: V): boolean
  /** 快照副本（最旧 → 最新）。 */
  toArray(): V[]
  size(): number
  clear(): void
}

/** 有界环列表：尾部入队、超限从头部淘汰（数组语义的容量封顶）。 */
export function createBoundedList<V>(limit: number): BoundedList<V> {
  const cap = Number.isSafeInteger(limit) ? Math.max(0, limit) : 0
  const items: V[] = []
  return {
    push(value) {
      if (cap <= 0) return false
      items.push(value)
      if (items.length > cap) items.splice(0, items.length - cap)
      return true
    },
    toArray: () => [...items],
    size: () => items.length,
    clear: () => { items.length = 0 },
  }
}
