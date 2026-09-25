/**
 * 调试模式呈现决策（debug-mode-gate.ts）的真值表测试。
 *
 * 为什么单测纯函数而不是 pin 组件源码文本：源码断言会在「把行抽到独立文件」这类
 * 等价重构上误报，又会在「把可见性条件改成 enabled && …」这类真实回归上放过。
 * 呈现决策全部收敛到这三个纯函数后，UI 只负责映射，行为面由这里覆盖。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  debugFactsCard,
  debugFactsCardVisible,
  debugStatusKind,
  debugSupported,
  debugToggleDisabled,
} from '../../src/client/debug-mode-gate.ts'

test('debugStatusKind: 回读缺省 = 未知（绝不按 enabled 推断）', () => {
  assert.equal(debugStatusKind(undefined, false), 'unknown')
  assert.equal(debugStatusKind(undefined, true), 'unknown', '意图开着但宿主没报过 = 仍是未知，不是已开')
})

test('debugStatusKind: 回读为真 = 已开（与意图无关）', () => {
  assert.equal(debugStatusKind({ inspectable: true }, true), 'on')
  assert.equal(debugStatusKind({ inspectable: true }, false), 'on', '设置说关但宿主还开着 → 事实优先，仍是 on')
})

test('debugStatusKind: 回读为假时按意图区分「失败」与「正常关」', () => {
  // 想开没开成 = 错误（带宿主原因）。
  assert.equal(debugStatusKind({ inspectable: false, reason: 'x' }, true), 'error')
  assert.equal(debugStatusKind({ inspectable: false }, true), 'error')
  // 本来就关着 = 正常，不渲染事实卡（否则每次关都报一条假错误）。
  assert.equal(debugStatusKind({ inspectable: false }, false), 'off')
  assert.equal(debugStatusKind({ inspectable: false, reason: 'stale' }, false), 'off')
})

test('debugFactsCardVisible: 不支持的壳不呈现事实面；支持的壳按「意图｜实测｜保存错误」', () => {
  const base = { supported: true, enabled: false, inspectable: false, saveError: false }
  assert.equal(debugFactsCardVisible(base), false)
  assert.equal(debugFactsCardVisible({ ...base, enabled: true }), true)
  // 撤销未被宿主确认（设置已关但实测仍开）必须显示——这正是「事实优先」的本体。
  assert.equal(debugFactsCardVisible({ ...base, inspectable: true }), true)
  assert.equal(debugFactsCardVisible({ ...base, saveError: true }), true)
  // 不支持的壳（Electron 未接线）：没有事实可言，原因已在行内说明。
  assert.equal(debugFactsCardVisible({ ...base, supported: false, enabled: true, saveError: true }), false)
})

test('debugFactsCard: 状态行键的映射（on/error/unknown），off 与在飞都不渲染状态行', () => {
  const base = { saving: false }
  assert.equal(debugFactsCard({ ...base, kind: 'on' }).statusKey, 'debugModeStatusOn')
  assert.equal(debugFactsCard({ ...base, kind: 'error' }).statusKey, 'debugModeStatusError')
  assert.equal(debugFactsCard({ ...base, kind: 'unknown' }).statusKey, 'debugModeStatusUnknown')
  // off：用户本就关着，说任何话都是假错。
  assert.equal(debugFactsCard({ ...base, kind: 'off' }).statusKey, null)
  // 在飞：宿主回读是跨进程 await，此刻展示的是上一次结果 → 暂缓（卡片其余部分照常）。
  assert.equal(debugFactsCard({ saving: true, kind: 'error', reason: 'stale' }).statusKey, null)
  assert.equal(debugFactsCard({ saving: true, kind: 'on' }).showEnableHints, true)
})

test('debugFactsCard: 只有在「开启面」才讲 Safari/信任边界；原因原文只在 error 时透传', () => {
  assert.equal(debugFactsCard({ kind: 'off', saving: false }).showEnableHints, false)
  assert.equal(debugFactsCard({ kind: 'on', saving: false }).showEnableHints, true)
  assert.equal(debugFactsCard({ kind: 'error', saving: false, reason: 'no-window' }).reason, 'no-window')
  assert.equal(debugFactsCard({ kind: 'unknown', saving: false }).reason, undefined)
})

test('debugToggleDisabled: 未水合 / 不支持 / 保存在飞 三者任一即禁用', () => {
  const open = { hydrated: true, supported: true, saving: false }
  assert.equal(debugToggleDisabled(open), false)
  assert.equal(debugToggleDisabled({ ...open, hydrated: false }), true)
  assert.equal(debugToggleDisabled({ ...open, supported: false }), true)
  // 在飞门：跨进程回读是 await，两次连点的落盘顺序不保证 → 一次只允许一个意图在途。
  assert.equal(debugToggleDisabled({ ...open, saving: true }), true)
})

test('debugSupported: 缺字段 = 早于该门的主进程 → 按不支持读（非对称契约）', () => {
  assert.equal(debugSupported({ debugInspectable: true }), true)
  assert.equal(debugSupported({ debugInspectable: false }), false)
  assert.equal(debugSupported({}), false, '缺字段绝不乐观成支持（否则呈现一个可能无效的开关）')
  assert.equal(debugSupported(undefined), false, 'status 未水合 → 未知按不支持门控（文案另行区分）')
})
