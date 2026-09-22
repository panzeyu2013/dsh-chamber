/** 共享的错误文案助手（renderer 通用）。
 *
 * 敌意值安全：该助手在 **catch 块里**被用来格式化桥/网络拒绝值，因此读取
 * `message` / `toString` 本身可能抛——错误格式化是一道异常边界，绝不能让
 * catch 处理器再抛一次。非敌意输入的返回值逐字不变。 */
export function errorMessage(err: unknown): string {
  try {
    return err instanceof Error ? err.message : String(err)
  } catch {
    return 'unknown error'
  }
}
