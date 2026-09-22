/**
 * runtime-probe-detail.test.ts —— 探针失败诊断单源单测。
 *
 * 覆盖：
 *  ① probeFailureDetail：只列失败项、缺 error 的兜底文案、全通过 = ''、600 字符上限；
 *  ② probeFailureMessage：前缀 + 明细；无明细（全部通过/空数组）时 no probe results；
 *  ③ metadataProbeFailureMessage：元数据恢复路径的固定文案与无明细兜底，且经
 *     sanitizeErrorText 收敛。
 * 纯逻辑（无网络、无 Electron、无子进程）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  metadataProbeFailureMessage,
  probeFailureDetail,
  probeFailureMessage,
} from './runtime-probe-detail.ts'

test('① probeFailureDetail：失败项清单与 600 字符上限', () => {
  assert.equal(
    probeFailureDetail([
      { name: 'bundledTree', ok: true },
      { name: 'commandsExecute', ok: false, error: 'gateway/arguments-invalid' },
    ]),
    'commandsExecute: gateway/arguments-invalid',
  )
  assert.equal(probeFailureDetail([{ name: 'p', ok: false }]), 'p: 探针未通过')
  assert.equal(probeFailureDetail([{ name: 'p', ok: true }]), '')
  assert.equal(probeFailureDetail([]), '')
  const long = probeFailureDetail([{ name: 'p', ok: false, error: 'e'.repeat(2_000) }])
  assert.equal(long.length, 600, '诊断文本必须有界（UI/日志同款 600 上限）')
})

test('② probeFailureMessage：前缀 + 明细，无明细时 no probe results', () => {
  assert.equal(
    probeFailureMessage('runtime compatibility probes failed', [{ name: 'p', ok: false, error: 'E' }]),
    'runtime compatibility probes failed — p: E',
  )
  assert.equal(
    probeFailureMessage('原运行时兼容性探针失败', []),
    '原运行时兼容性探针失败 — no probe results',
    '全部通过/空数组与「探针没跑」必须可区分（绝不出现裸的 probes failed）',
  )
  assert.equal(
    probeFailureMessage('env runtime compatibility probes failed', [{ name: 'p', ok: true }]),
    'env runtime compatibility probes failed — no probe results',
  )
})

test('③ metadataProbeFailureMessage：内建探针文案与无明细兜底', () => {
  assert.equal(
    metadataProbeFailureMessage([{ name: 'p', ok: false, error: 'E' }]),
    '内建 dsh 运行时探针失败：p: E',
  )
  assert.equal(
    metadataProbeFailureMessage([{ name: 'p', ok: true }]),
    '内建 dsh 运行时探针未返回完整成功结果',
  )
  const long = metadataProbeFailureMessage([{ name: 'p', ok: false, error: 'e'.repeat(2_000) }])
  // 明细本身被 probeFailureDetail 截到 600；前缀 + 截断明细 = 有界的最终文案
  // （sanitizeErrorText 不负责截断，600 上限来自 probeFailureDetail 的截断）。
  assert.ok(long.length <= 620, 'sanitize 后仍必须收敛（不把 2000 字符原样透出）')
  assert.ok(long.includes('内建 dsh 运行时探针失败：p: '))
})
