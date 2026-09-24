/**
 * 有界集合内核：把「容量 + 同键替换裁决 + FIFO 淘汰回调」从各账本里抽出，
 * 容量策略与淘汰诊断只有一处答案。
 * 适用：unread-store 的 ack 待发表（Map + 同键水位替换 + FIFO 淘汰）、
 * notification-ledger 的决定环（尾部入队 + 头部淘汰）。
 * 不并入的族（状态机型，不是容器问题）：authority 的三级阶梯滚动窗、baseline-harvest attempts/backoff、
 * pending-open deadline 队列、prewarm-ledger 计数表。
 */

export interface BoundedMap<V> {
  get(key: string): V | undefined
  /** 写入；被 replace 拒绝或容量 <= 0 时返回 false（不触碰既有顺序）。 */
  set(key: string, value: V): boolean
  delete(key: string): boolean
  has(key: string): boolean
  size(): number
  keys(): IterableIterator<string>
  values(): IterableIterator<V>
  entries(): IterableIterator<[string, V]>
  clear(): void
}

/**
 * 有界键值账本：Map 迭代序 = 最近写入序（同键写入先删后插，移到队尾）；
 * 超过容量时按迭代序 FIFO 淘汰最旧键并回调 onEvict（显式 delete 不回调）。
 */
export function createBoundedMap<V>(options: {
  /** 容量上限；<= 0 = 关闭（写入全部丢弃）。 */
  limit: number
  /** 新值是否取代旧值；缺省 = 总是取代。返回 false 时新值被丢弃且顺序不变。 */
  replace?: (previous: V, next: V) => boolean
  /** 每个因容量溢出被淘汰的键调用一次。 */
  onEvict?: (key: string, value: V) => void
}): BoundedMap<V> {
  const limit = Number.isSafeInteger(options.limit) ? Math.max(0, options.limit) : 0
  const entries = new Map<string, V>()
  const evictOldest = (): void => {
    const oldest = entries.keys().next()
    if (oldest.done === true) return
    const value = entries.get(oldest.value)
    entries.delete(oldest.value)
    if (value !== undefined) options.onEvict?.(oldest.value, value)
  }
  return {
    get: key => entries.get(key),
    set(key, value) {
      if (limit <= 0) return false
      const previous = entries.get(key)
      if (previous !== undefined) {
        if (options.replace !== undefined && !options.replace(previous, value)) return false
        entries.delete(key)
      }
      entries.set(key, value)
      while (entries.size > limit) evictOldest()
      return true
    },
    delete: key => entries.delete(key),
    has: key => entries.has(key),
    size: () => entries.size,
    keys: () => entries.keys(),
    values: () => entries.values(),
    entries: () => entries.entries(),
    clear: () => { entries.clear() },
  }
}

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
