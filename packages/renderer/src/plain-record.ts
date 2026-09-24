/** 纯记录判定单一来源：排除 null / 数组 / 类实例（原型必须是 Object.prototype 或 null）。
 *  facts 解析（session-facts-source）与未读落盘解析（unread-store）曾各写一份逐字相同的
 *  实现；两份必须保持同解，故归口到这里。 */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
