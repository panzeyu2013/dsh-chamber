/**
 * 通知第二入口的水位去重（主计划 §5-16 / R6；蓝图 §2-接线 3）。
 *
 * renderer 身份键 = (sourceId, sourceFingerprint, sessionId, kind, watermark)：
 * kind 与 fingerprint 必须保留（否则同水位的 ask 与 complete 互吞、同 id 换宿主
 * 继承旧 claim）；主进程 claim 键是同一五元组 + 5s TTL 兜底
 * （packages/desktop/notifications.ts，本侧不复制其实现）。
 *
 * watermark 语义：complete = completedAt ?? updatedAt；ask/request = updatedAt（host 域）。
 * 首见（prev === undefined）只播种不通知——桌面启动/来源重挂时，基线里已经完成的
 * 会话不得补发通知（主计划 §5-5「离线完成不回补通知」）。
 */

function isWatermark(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** 同一完成不重发：只有严格更高的水位才允许再通知。 */
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

/** 完成边沿的内容水位 = max(completedAt, updatedAt)（两者皆缺 = undefined）。 */
export function completionWatermark(row: {
  completedAt?: number | null
  updatedAt?: number
}): number | undefined {
  const completed = row.completedAt !== null && row.completedAt !== undefined && isWatermark(row.completedAt)
    ? row.completedAt
    : 0
  const updated = isWatermark(row.updatedAt) ? row.updatedAt : 0
  const watermark = Math.max(completed, updated)
  return watermark > 0 ? watermark : undefined
}
