/**
 * 水位（watermark）原语单一来源。
 *
 * WHY：同一套「host 域整数水位」契约必须在 unread-store / session-facts-source /
 * notification 各消费点保持同解：isWatermark / max / 完成水位组合都归口于此，
 * 「什么样的数是合法水位」只有一处答案。
 *
 * 去重已改为**运行身份**（notification-identity.ts）：水位只作为身份的一部分
 * （chamber 回退族的 episode）与未读游标，不再有单调水位比较表。主进程 claim 键
 * 仍含 fingerprint/kind/watermark + 5s TTL（packages/desktop/notifications.ts，
 * 本侧不复制其实现）。watermark 语义：complete = max(completedAt, updatedAt)；
 * ask/request = updatedAt（host 域）。
 *
 * 契约：合法水位 = 非负安全整数（host 域毫秒/游标）。缺失/坏值不臆造，由调用方按
 * 各自语义决定「不改变 / 不通知 / 回落 0」。
 */

/** 合法水位：非负安全整数（NaN / Infinity / 小数 / 负数 / 字符串都不是）。 */
export function isWatermark(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** 取若干候选水位中的最大合法值；无合法值时为 0（调用方决定 0 是「缺失」还是「极小」）。 */
export function maxWatermarkValue(...values: readonly (number | null | undefined)[]): number {
  let max = 0
  for (const value of values) {
    if (isWatermark(value) && value > max) max = value
  }
  return max
}

/** 完成边沿的内容水位 = max(completedAt, updatedAt)（两者皆无合法值 = undefined）。 */
export function completionWatermark(row: {
  completedAt?: number | null
  updatedAt?: number
}): number | undefined {
  const watermark = maxWatermarkValue(row.completedAt, row.updatedAt)
  return watermark > 0 ? watermark : undefined
}
