/**
 * 「发送测试通知」结果的纯映射（design 19 §3.3/§4）。
 *
 * 主进程/宿主腿对 'dsh-chamber:notify' 回 {shown, error?}（未显示时 error 是
 * 裁决抑制原因或宿主/OS 原文）。设置页必须把原因展示出来——macOS 通知权限一旦
 * 被拒就永远不会弹授权框，用户只有「看到原因 → 去系统设置打开」这一条恢复路径；
 * 只显示「发送失败」等于把用户留在黑箱里。
 *
 * 之所以独立成纯模块：这条「原因不丢」契约要能被单测钉住，UI 只负责渲染。
 */

import { errorMessage } from '@dsh-chamber/dsh-chamber-client-ui-sidebar/shared'

/** 'dsh-chamber:notify' 的诚实结果（与 renderer global.d.ts 的 NotificationSurface 同形）。 */
export interface TestNotifyOutcome {
  shown: boolean
  error?: string
}

/** 设置页的一次测试通知结果：成功，或失败 + 可展示原因（可能缺失）。 */
export type TestNotifyResult =
  | { kind: 'sent' }
  | { kind: 'failed'; error?: string }

/** 成功/失败 + 原因原文（空串/非字符串按「无原因」处理，绝不制造假原因）。 */
export function testNotifyResult(outcome: TestNotifyOutcome): TestNotifyResult {
  if (outcome.shown) return { kind: 'sent' }
  return withReason(outcome.error)
}

/** invoke 直接 reject（桥/IPC 异常）时同样如实带原因，绝不吞掉。 */
export function testNotifyRejected(error: unknown): TestNotifyResult {
  return withReason(errorMessage(error))
}

function withReason(raw: unknown): TestNotifyResult {
  const reason = typeof raw === 'string' && raw.trim() !== '' ? raw : undefined
  return reason === undefined ? { kind: 'failed' } : { kind: 'failed', error: reason }
}
