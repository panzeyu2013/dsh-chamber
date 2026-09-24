/**
 * runtime-probe-detail.ts —— 运行时激活探针失败诊断（electron-free 纯模块）。
 *
 * 两种 flavor 必须对同一失败给出同一份明细，故失败清单、600 字符上限、
 * 统一前缀/兜底文案同为单源；输入只要结构形状（name/ok/error），error 已脱敏。
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

/** 统一失败文案：`<prefix> — <detail>`；无明细时 `no probe results`。 */
export function probeFailureMessage(prefix: string, probes: readonly ProbeFailureLike[]): string {
  const detail = probeFailureDetail(probes)
  return `${prefix} — ${detail === '' ? 'no probe results' : detail}`
}

/** 元数据恢复路径文案，经 sanitizeErrorText 脱敏，同样 600 字符上限。 */
export function metadataProbeFailureMessage(probes: readonly ProbeFailureLike[]): string {
  const detail = probeFailureDetail(probes)
  return sanitizeErrorText(
    detail === ''
      ? '内建 dsh 运行时探针未返回完整成功结果'
      : `内建 dsh 运行时探针失败：${detail}`,
  )
}
