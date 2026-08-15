/** 共享的错误文案助手（renderer 通用）。 */

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
