/**
 * 通知 durable 表的内存上界（design 19 §3.2.4「卫生上界」）。
 *
 * 落盘侧一直用每来源 500 条的尾截断，但内存权威表只按来源 prune；长活来源内的
 * 会话 churn 会让身份/水位/pending/outcomes 只增不减（实测 2000 会话 → 4×2000 行、
 * 整表 COW/JSON 随行数线性）。这里把同一套界做成纯 helper，供 notification-store
 * 的落盘剪枝与 complete-ledger / notification-projection 的内存写点共用：
 *  - 会话键表（notifiedRuns / notified / pending）按插入序保留尾部 max 条；
 *  - outcomes 以 goalId 为键，按水位降序、goalId 升序 tie-break 保留前 max 条。
 * 与落盘语义保持一致后，flush 起内存=盘、reload 幂等；被裁会话的身份窗 = 最近
 * max 个会话（reload 今天已是同一窗口，故不新增重复通知类别）。
 */

/** 每来源 durable 表上界；落盘与内存的唯一出处。 */
export const NOTIFICATION_MAX_SESSIONS_PER_SOURCE = 500

/** 会话键表：保留 `Object.keys` 插入序尾部 max 条；未超界返回原引用（零 churn）。 */
export function tailSessionTable<T>(table: Record<string, Record<string, T>>, maxPerSource: number = NOTIFICATION_MAX_SESSIONS_PER_SOURCE): Record<string, Record<string, T>> {
  if (maxPerSource <= 0) return {}
  const next: Record<string, Record<string, T>> = {}
  let changed = false
  for (const [sourceId, sessions] of Object.entries(table)) {
    const keys = Object.keys(sessions)
    if (keys.length === 0) continue
    if (keys.length <= maxPerSource) { next[sourceId] = sessions; continue }
    changed = true
    const kept: Record<string, T> = {}
    for (const key of keys.slice(keys.length - maxPerSource)) kept[key] = sessions[key]!
    next[sourceId] = kept
  }
  return changed ? next : table
}

/** outcomes 表：每来源按水位降序 + goalId 升序 tie-break 保留前 max 条；未超界返回原引用。 */
export function tailOutcomeTable(table: Record<string, Record<string, number>>, maxPerSource: number = NOTIFICATION_MAX_SESSIONS_PER_SOURCE): Record<string, Record<string, number>> {
  if (maxPerSource <= 0) return {}
  const next: Record<string, Record<string, number>> = {}
  let changed = false
  for (const [sourceId, outcomes] of Object.entries(table)) {
    const entries = Object.entries(outcomes)
    if (entries.length === 0) continue
    if (entries.length <= maxPerSource) { next[sourceId] = outcomes; continue }
    changed = true
    entries.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    const kept: Record<string, number> = {}
    for (const [goalId, watermark] of entries.slice(0, maxPerSource)) kept[goalId] = watermark
    next[sourceId] = kept
  }
  return changed ? next : table
}
