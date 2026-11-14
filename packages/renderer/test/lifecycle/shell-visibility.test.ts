/**
 * 壳窗口可见性事实（design 14 §D1 / STATUS §1.7「隐藏窗口渲染活性」）：
 *  - 无事件 / 无壳默认可见（旧前台相位门行为不变）；
 *  - 事件 detail 归一（异形 / 缺字段回落默认）与 visible + occluded 的单一判定；
 *  - 监听安装 / 卸载语义；
 *  - 接线锁：background-phase 只叠一层 isShellVisible()，七个相位消费方不另开第二判断；
 *  - 跨语言契约：事件名 / detail 形状 / 窗口观察面与 Swift 派发源同一字面量。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { shouldRunBackgroundPhase } from '../../src/background-phase.ts'
import {
  SHELL_VISIBILITY_EVENT,
  currentShellVisibility,
  installShellVisibilityListener,
  isShellVisible,
  normalizeShellVisibilityDetail,
  subscribeShellVisibility,
} from '../../src/shell-visibility.ts'

interface FakeShellTarget {
  target: {
    addEventListener: (type: string, listener: (event: { detail?: unknown }) => void) => void
    removeEventListener: (type: string, listener: (event: { detail?: unknown }) => void) => void
  }
  emit: (detail?: unknown) => void
  listenerCount: () => number
}

/** 最小事件目标假体（node 环境没有 DOM；模块只依赖 add/removeEventListener）。 */
function makeFakeTarget(): FakeShellTarget {
  const listeners = new Set<(event: { detail?: unknown }) => void>()
  const target = {
    addEventListener(type: string, listener: (event: { detail?: unknown }) => void): void {
      if (type === SHELL_VISIBILITY_EVENT) listeners.add(listener)
    },
    removeEventListener(type: string, listener: (event: { detail?: unknown }) => void): void {
      if (type === SHELL_VISIBILITY_EVENT) listeners.delete(listener)
    },
  }
  return {
    target,
    emit(detail?: unknown): void {
      for (const listener of [...listeners]) listener({ detail })
    },
    listenerCount: (): number => listeners.size,
  }
}

const readRepoFile = (relative: string): string =>
  readFileSync(new URL('../../../../' + relative, import.meta.url), 'utf8')

test('无事件时默认可见：前台相位门保持旧行为', () => {
  assert.deepEqual(currentShellVisibility(), { visible: true, occluded: false })
  assert.equal(isShellVisible(), true)
  assert.equal(shouldRunBackgroundPhase('visible'), true)
  assert.equal(shouldRunBackgroundPhase('hidden'), false)
})

test('detail 归一：异形 / 缺字段回落默认可见，occluded 缺省 false', () => {
  assert.deepEqual(normalizeShellVisibilityDetail(undefined), { visible: true, occluded: false })
  assert.deepEqual(normalizeShellVisibilityDetail(null), { visible: true, occluded: false })
  assert.deepEqual(normalizeShellVisibilityDetail({}), { visible: true, occluded: false })
  assert.deepEqual(normalizeShellVisibilityDetail({ visible: 'no' }), { visible: true, occluded: false })
  assert.deepEqual(normalizeShellVisibilityDetail({ visible: false }), { visible: false, occluded: false })
  assert.deepEqual(normalizeShellVisibilityDetail({ visible: true, occluded: 'x' }),
    { visible: true, occluded: false })
  assert.deepEqual(normalizeShellVisibilityDetail({ visible: true, occluded: true }),
    { visible: true, occluded: true })
})

test('事件更新事实：隐藏 / 遮挡停前台相位，恢复重新放行', () => {
  const fake = makeFakeTarget()
  installShellVisibilityListener(fake.target)
  fake.emit({ visible: false, occluded: false })
  assert.deepEqual(currentShellVisibility(), { visible: false, occluded: false })
  assert.equal(isShellVisible(), false)
  assert.equal(shouldRunBackgroundPhase('visible'), false)
  fake.emit({ visible: true, occluded: true })
  assert.equal(isShellVisible(), false, '完全遮挡 / 另一 Space 同样停前台相位')
  fake.emit({ visible: true, occluded: false })
  assert.equal(isShellVisible(), true)
  assert.equal(shouldRunBackgroundPhase('visible'), true)
  assert.equal(shouldRunBackgroundPhase('hidden'), false, '页面级隐藏仍独立生效')
  fake.emit(undefined)
  assert.equal(isShellVisible(), true, '异形事件按默认可见处理（绝不因坏载荷停掉前台相位）')
})

test('卸载监听后不再更新事实', () => {
  const fake = makeFakeTarget()
  const uninstall = installShellVisibilityListener(fake.target)
  fake.emit({ visible: false, occluded: false })
  assert.equal(isShellVisible(), false)
  uninstall()
  assert.equal(fake.listenerCount(), 0)
  fake.emit({ visible: true, occluded: false })
  assert.equal(isShellVisible(), false, '卸载后迟到事件不得改事实')
})

test('恢复边沿订阅：事件归一后通知订阅者，退订后不再收到，订阅者抛错不打断事实管道', () => {
  const fake = makeFakeTarget()
  const uninstall = installShellVisibilityListener(fake.target)
  const seen: { visible: boolean; occluded: boolean }[] = []
  const unsubscribe = subscribeShellVisibility(detail => { seen.push(detail) })
  const throwing = subscribeShellVisibility(() => { throw new Error('subscriber boom') })
  fake.emit({ visible: false, occluded: false })
  assert.deepEqual(seen.at(-1), { visible: false, occluded: false }, '隐藏边沿必须通知订阅者')
  fake.emit(undefined)
  assert.deepEqual(seen.at(-1), { visible: true, occluded: false }, '异形事件归一后通知')
  throwing()
  unsubscribe()
  const count = seen.length
  fake.emit({ visible: false, occluded: false })
  assert.equal(seen.length, count, '退订后不再收到')
  uninstall()
})

test('恢复补偿：宿主可见边沿也补偿一轮，且不新增第二前台门', () => {
  const compensation = readRepoFile('packages/renderer/src/app-hooks/use-visibility-compensation.ts')
  assert.match(compensation, /subscribeShellVisibility/, '恢复补偿必须订阅宿主可见性事实')
  assert.match(compensation, /if \(detail\.visible && !detail\.occluded\) compensate\(\)/,
    '只有前台相位恢复（visible 且未遮挡）才补偿')
  assert.match(compensation, /visibilitychange/, '页面级 visibilitychange 补偿不得丢失')
})

test('接线锁：background-phase 单一叠加壳可见性，七个相位消费方不另开第二判断', () => {
  const backgroundPhase = readRepoFile('packages/renderer/src/background-phase.ts')
  assert.match(backgroundPhase, /isShellVisible\(\)/, '前台相位门必须叠加壳可见性事实')
  assert.match(backgroundPhase, /visibilityState === 'visible'/, '文档可见性判定必须仍在门内')
  const consumers = [
    'packages/renderer/src/App.tsx',
    'packages/renderer/src/host/use-managed-runtime.ts',
    'packages/renderer/src/app-hooks/use-aggregate-refresh.ts',
    'packages/renderer/src/app-hooks/use-view-scheduler.ts',
    'packages/renderer/src/app-hooks/use-host-health-stream.ts',
    'packages/renderer/src/app-hooks/use-session-facts-lifecycle.ts',
    'packages/renderer/src/app-hooks/use-resident-guard.ts',
  ]
  for (const consumer of consumers) {
    const source = readRepoFile(consumer)
    assert.ok(source.includes('shouldRunBackgroundPhase('), consumer + ' 必须经统一门')
    for (const forbidden of ['shell-visibility', 'isShellVisible', 'SHELL_VISIBILITY_EVENT']) {
      assert.ok(!source.includes(forbidden), consumer + ' 不得出现第二判断：' + forbidden)
    }
  }
})

test('接线负控：门序/双门/通知事实与壳边沿回退都会变红', () => {
  const compensation = readRepoFile('packages/renderer/src/app-hooks/use-visibility-compensation.ts')
  const gateAt = compensation.indexOf('if (!shouldRunBackgroundPhase(document.visibilityState)) return')
  const dedupeAt = compensation.indexOf('lastCompensationAt = now')
  assert.ok(gateAt !== -1 && dedupeAt !== -1 && gateAt < dedupeAt,
    '补偿必须先过统一相位门再记录 250ms 去重时间戳')
  const resident = readRepoFile('packages/renderer/src/app-hooks/use-resident-guard.ts')
  assert.ok((resident.match(/shouldRunBackgroundPhase\(/gu) ?? []).length >= 3,
    '压力阀入口/快照后/错峰释放三处都必须经统一门')
  const notifications = readRepoFile('packages/renderer/src/app-hooks/use-notifications.ts')
  assert.match(notifications, /requireHidden[\s\S]{0,900}?isShellVisible\(\)/u,
    'requireHidden 必须叠壳可见性事实（遮挡/另一 Space 不误抑制）')
  assert.match(compensation, /subscribeShellVisibility\(/u, '壳可见边沿订阅不得丢失')
  assert.match(compensation, /if \(detail\.visible && !detail\.occluded\) compensate\(\)/u,
    '只有 visible 且未遮挡的边沿才补偿')
})

test('跨语言契约：Swift 派发的事件名 / detail 形状 / 窗口观察面与 renderer 同字面量', () => {
  const swift = readRepoFile('macos/Sources/DSHChamber/MainWindowController.swift')
  assert.ok(swift.includes(SHELL_VISIBILITY_EVENT), 'Swift 必须派发同一事件名')
  assert.ok(swift.includes('{detail: {visible: '), 'detail 形状必须含 visible')
  assert.ok(swift.includes(', occluded: '), 'detail 形状必须含 occluded')
  assert.ok(swift.includes('didChangeOcclusionStateNotification'), '必须观察窗口遮挡状态变化')
  assert.ok(!swift.includes('windowVisible') && !swift.includes('windowOccluded'),
    'hostFacts 不得再携带无消费者的可见性键（事件是唯一事实通道）')
})
