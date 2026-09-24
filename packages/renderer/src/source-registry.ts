/**
 * 每来源（per-source）注册表收敛的单一内核：App 的 roster 剪枝、retire 与 push 提交点
 * 都必须按 live 集合删除每来源表项，漏删会让 same-id 重加继承上一代判定。
 * 三种形态（对象表 / Set / 保序数组）均 identity-preserving：无变化返回 null，
 * 调用方可保留原引用、不触发重渲染。键的语义由调用方决定。
 */

/** 删掉 live 之外的键；无变化返回 null（调用方可保留原引用，不触发重渲染）。 */
export function pruneSourceRecord<T>(
  table: Readonly<Record<string, T>>,
  live: ReadonlySet<string>,
): Record<string, T> | null {
  let changed = false
  const next: Record<string, T> = { ...table }
  for (const key of Object.keys(next)) {
    if (live.has(key)) continue
    delete next[key]
    changed = true
  }
  return changed ? next : null
}

/** 删掉 live 之外的元素；无变化返回 null。 */
export function pruneSourceSet(
  table: ReadonlySet<string>,
  live: ReadonlySet<string>,
): Set<string> | null {
  const next = new Set<string>()
  for (const key of table) {
    if (live.has(key)) next.add(key)
  }
  return next.size === table.size ? null : next
}

/** 过滤掉 live 之外的元素并保序；无变化返回 null。 */
export function pruneSourceList(
  list: readonly string[],
  live: ReadonlySet<string>,
): string[] | null {
  const next = list.filter(key => live.has(key))
  return next.length === list.length ? null : next
}
