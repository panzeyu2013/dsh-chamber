/**
 * 每来源（per-source）注册表收敛的单一内核。
 *
 * WHY：App 的 roster 剪枝 effect、retireSources 与 push 提交点都必须按 live 集合
 * 删除每来源表项；任何新增 per-source 表都可能漏删（same-id 重加会继承上一代判定）。
 * 本模块只提供三种形态：
 *   - pruneSourceRecord：对象表，identity-preserving（无变化返回 null）；
 *   - pruneSourceSet：Set，同样 identity-preserving；
 *   - pruneSourceList：数组（保序）。
 * 键的语义（视图 id / 原始实例 id）由调用方决定，本模块不解释键。
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
