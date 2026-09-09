/**
 * 安装阻塞原因（installBlockedReason）的纯分类模块 —— 2026-09 模块评审 E#1。
 *
 * 从 UpdateSection.tsx 抽出：`.tsx` 无法被 node:test 直接 import（JSX 扩展名），
 * 而这条判定需要插件内单测 + 跨包字面量锁步。分类规则只有两条已知原因，
 * 其余一律 unknown（**绝不**凭空断言「未配置签名」）。
 */
/** 原生壳（macOS Swift flavor）的 wire 值，与 packages/desktop/update-headless.ts
 *  `NATIVE_SHELL_INSTALL_BLOCKED_REASON` 逐字锁步（本包测试直接读源码比对）。 */
export const NATIVE_SHELL_BLOCKED_REASON = '原生壳不支持自动安装'

export type BlockedReasonClass = 'native-shell' | 'mac-signing' | 'unknown'

/** 分类：原生壳 / mac 签名缺失 / 未知（未知由调用方原样透出原因）。 */
export function classifyBlockedReason(reason: string | null | undefined): BlockedReasonClass {
  if (reason === NATIVE_SHELL_BLOCKED_REASON) return 'native-shell'
  if (reason === 'missing Developer ID signature') return 'mac-signing'
  return 'unknown'
}
