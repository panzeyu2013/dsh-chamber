/**
 * 水位（watermark）原语单一来源。
 *
 * WHY：同一套「host 域整数水位」契约必须在 unread-store / session-facts-source /
 * notification-projection / complete-ledger / completion-observation 各消费点保持
 * 同解：isWatermark、完成水位的 max / 单调记忆 / 递增判定都归口于此，
 * 「什么样的数是合法水位」「什么算更高」只有一处答案（直测见
 * test/aggregate/watermark.test.ts）。
 *
 * 通知身份键 = (sourceId, sourceFingerprint, sessionId, kind, watermark)：kind 与
 * fingerprint 必须保留（否则同水位的 ask 与 complete 互吞、同 id 换宿主继承旧
 * claim）；主进程 claim 键是同一五元组 + 5s TTL 兜底（packages/desktop/notifications.ts，
 * 本侧不复制其实现）。watermark 语义：complete = completedAt ?? updatedAt；
 * ask/request = updatedAt（host 域）。首见（prev === undefined）只播种不通知——桌面
 * 启动/来源重挂时，基线里已经完成的会话不得补发通知。
 *
 * 契约：合法水位 = 非负安全整数（host 域毫秒/游标）。缺失/坏值不臆造，由调用方按
 * 各自语义决定「不改变 / 不通知 / 回落 0」。
 */

/** 未读/通知身份的三个 kind（与 v2 载荷同一词表）——放零依赖叶以避免 complete-ledger ⇄ unread-store 类型环。 */
export type UnreadKind = 'complete' | 'ask' | 'request'

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

/** 同一完成不重发：只有严格更高的水位才允许再通知（首见 = 只播种，返回 false）。 */
export function shouldNotifyWatermark(prev: number | undefined, watermark: number | undefined): boolean {
  if (!isWatermark(watermark)) return false
  if (!isWatermark(prev)) return false
  return watermark > prev
}

/** 已通知水位的单调记忆（回退不允许；坏值原样保留 prev）。 */
export function nextNotifiedWatermark(prev: number | undefined, watermark: number | undefined): number | undefined {
  if (!isWatermark(watermark)) return prev
  if (!isWatermark(prev) || watermark > prev) return watermark
  return prev
}

/** 完成边沿的内容水位 = max(completedAt, updatedAt)（两者皆无合法值 = undefined）。 */
export function completionWatermark(row: {
  completedAt?: number | null
  updatedAt?: number
}): number | undefined {
  const watermark = maxWatermarkValue(row.completedAt, row.updatedAt)
  return watermark > 0 ? watermark : undefined
}
