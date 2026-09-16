/**
 * runtime-probe-detail.ts —— 运行时激活探针失败诊断（electron-free 纯模块）。
 *
 * 为什么单源：`probeFailureDetail` 原先只存在于 main.ts 的 whenReady 闭包里，
 * Swift flavor 的 sidecar-ctx 于是各自 `throw new Error('runtime compatibility
 * probes failed')` 之类的常量串——同一个失败在两种 flavor 上可诊断性不同，而
 * 这条诊断正是 2026-09 验收轮唯一能看见的证据链（0.1.3-alpha.1 升级后的
 * `gateway/arguments-invalid` 曾对所有日志与界面不可见，见 main.ts 原注释）。
 * 本模块把「列出失败探针 + 600 字符上限 + 统一前缀/兜底文案」抽成纯函数，
 * Electron 装配（main.ts）与 Swift 装配（sidecar-ctx.ts）共用同一实现。
 *
 * 输入只要求结构形状（name/ok/error），不耦合具体探针实现；`error` 已是
 * dsh-runtime 侧 sanitize 过的文本（sanitizeErrorText + 引号路径剥离 + 2000 上限）。
 */
import { sanitizeErrorText } from './sanitize-error.ts';

/** 探针结果的最小结构面（ProbeResult 的结构子集）。 */
export interface ProbeFailureLike {
  readonly name: string
  readonly ok: boolean
  readonly error?: string | null
}

/** 失败探针的「name: error」清单（全部通过时返回 ''），600 字符上限。 */
export function probeFailureDetail(probes: readonly ProbeFailureLike[]): string {
  return probes
    .filter(probe => !probe.ok)
    .map(probe => `${probe.name}: ${probe.error ?? '探针未通过'}`)
    .join('; ')
    .slice(0, 600)
}

/** 激活路径的统一失败文案：`<prefix> — <detail>`，无失败明细时 `no probe results`。 */
export function probeFailureMessage(prefix: string, probes: readonly ProbeFailureLike[]): string {
  const detail = probeFailureDetail(probes)
  return `${prefix} — ${detail === '' ? 'no probe results' : detail}`
}

/** 元数据恢复路径的文案（main.ts 原 metadataProbeError 逐字，含 600 字符上限）。 */
export function metadataProbeFailureMessage(probes: readonly ProbeFailureLike[]): string {
  const detail = probeFailureDetail(probes)
  return sanitizeErrorText(
    detail === ''
      ? '内建 dsh 运行时探针未返回完整成功结果'
      : `内建 dsh 运行时探针失败：${detail}`,
  )
}
