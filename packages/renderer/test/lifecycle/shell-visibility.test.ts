/**
 * 壳窗口可见性事实与页面注意力（design 14 §D1「隐藏窗口渲染活性」）：
 *  - 无事件 / 无壳默认可见（旧前台相位门行为不变）；
 *  - 事件 detail 归一（异形 / 缺字段回落默认；active 只认 boolean 且缺省键缺席）；
 *  - 监听安装 / 卸载语义；
 *  - 页面注意力纯函数真值（文档可见 ∧ 壳在屏 ∧ (active ?? hasFocus)）与派生订阅边沿
 *    （复用壳事件 + focus/blur/visibilitychange；初始不通知、同值去重、退订卸载）；
 *  - 接线锁：background-phase 只叠一层 isShellVisible()，十个相位消费方不另开第二判断；
 *  - 接线锁：通知门三分量（painted ∧ current ∧ 页面注意力）、补臂 foreground 同源、
 *    恢复补偿相位边沿（active-only 变化不重跑补偿轮）；
 *  - 跨语言契约：事件名 / detail 形状（含 active）/ 窗口观察面与 Swift 派发源同一字面量。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { stripComments } from '../../../../scripts/dev/test-support/source-text.ts'
import { shouldRunBackgroundPhase } from '../../src/background-phase.ts'
import {
  currentPageForeground,
  pageForegroundOf,
  subscribePageForeground,
  type PageDocFacts,
} from '../../src/page-attention.ts'
import {
  SHELL_VISIBILITY_DEFAULT,
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

interface FakePageTarget {
  target: {
    addEventListener: (type: string, listener: () => void) => void
    removeEventListener: (type: string, listener: () => void) => void
  }
  emit: (type: string) => void
  listenerCount: () => number
}

/** 页面事件目标假体（focus / blur / visibilitychange；记录监听数量用于退订锁）。 */
function makeFakePageTarget(): FakePageTarget {
  const buckets = new Map<string, Set<() => void>>()
  const bucket = (type: string): Set<() => void> => {
    let listeners = buckets.get(type)
    if (listeners === undefined) {
      listeners = new Set()
      buckets.set(type, listeners)
    }
    return listeners
  }
  return {
    target: {
      addEventListener(type: string, listener: () => void): void { bucket(type).add(listener) },
      removeEventListener(type: string, listener: () => void): void { buckets.get(type)?.delete(listener) },
    },
    emit(type: string): void {
      for (const listener of [...(buckets.get(type) ?? [])]) listener()
    },
    listenerCount(): number {
      let count = 0
      for (const listeners of buckets.values()) count += listeners.size
      return count
    },
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

test('detail 归一：active 只认 boolean 且缺省键缺席（无壳回退走页面事实）', () => {
  assert.deepEqual(normalizeShellVisibilityDetail({ visible: true, occluded: false, active: true }),
    { visible: true, occluded: false, active: true })
  assert.deepEqual(normalizeShellVisibilityDetail({ visible: true, occluded: false, active: false }),
    { visible: true, occluded: false, active: false })
  assert.deepEqual(normalizeShellVisibilityDetail({ visible: true, active: 'yes' }),
    { visible: true, occluded: false }, 'active 非法 = 键缺席（绝不伪造 boolean）')
  const missing = normalizeShellVisibilityDetail({ visible: true })
  assert.ok(!('active' in missing), '缺 active 必须是键缺席，不是 active: undefined')
  assert.deepEqual(SHELL_VISIBILITY_DEFAULT, { visible: true, occluded: false },
    '缺事实默认值保持两键（active 缺席 ⇒ 页面注意力回退 hasFocus）')
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
  // active 是注意力事实（additive），不进相位门：相位仍只看 visible && !occluded。
  fake.emit({ visible: true, occluded: false, active: false })
  assert.deepEqual(currentShellVisibility(), { visible: true, occluded: false, active: false })
  assert.equal(isShellVisible(), true, '应用失活不得停掉相位门（两门不得混用）')
  fake.emit({ visible: true, occluded: false, active: true })
  assert.deepEqual(currentShellVisibility(), { visible: true, occluded: false, active: true })
  fake.emit(undefined)
  assert.deepEqual(currentShellVisibility(), { visible: true, occluded: false }, '还原默认事实供后续用例共享状态')
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

test('pageForegroundOf：文档可见 ∧ 壳在屏 ∧ (active ?? hasFocus)（纯函数真值表）', () => {
  const focused: PageDocFacts = { visibilityState: 'visible', hasFocus: true }
  const blurred: PageDocFacts = { visibilityState: 'visible', hasFocus: false }
  const hidden: PageDocFacts = { visibilityState: 'hidden', hasFocus: true }
  assert.equal(pageForegroundOf({ visible: true, occluded: false, active: true }, blurred), true,
    'active=true 时即便页面无焦点也在前台（右栏 Browser guest / 原生面板；active 的收益面）')
  assert.equal(pageForegroundOf({ visible: true, occluded: false, active: false }, focused), false,
    '应用失活 ⇒ 不在前台（即便页面 hasFocus）')
  assert.equal(pageForegroundOf({ visible: true, occluded: false }, focused), true,
    '旧壳 / web 直开缺 active ⇒ 回退 document.hasFocus()')
  assert.equal(pageForegroundOf({ visible: true, occluded: false }, blurred), false,
    '缺 active 且页面失焦 ⇒ 不在前台（旧壳回退形态的返回边沿）')
  assert.equal(pageForegroundOf({ visible: true, occluded: false, active: true }, hidden), false,
    '文档隐藏压过 active（页面不可见 = 不在前台）')
  assert.equal(pageForegroundOf({ visible: true, occluded: true, active: true }, focused), false,
    '完全遮挡 / 另一 Space ⇒ 不在前台（相位门半边）')
  assert.equal(pageForegroundOf({ visible: false, occluded: false, active: true }, focused), false,
    '壳隐藏 / 最小化 ⇒ 不在前台')
  assert.equal(pageForegroundOf(SHELL_VISIBILITY_DEFAULT, focused), true,
    '首帧 / 无壳默认事实 + 页面聚焦 ⇒ 前台（绝不因缺壳事实停注意力门）')
  assert.equal(pageForegroundOf(SHELL_VISIBILITY_DEFAULT, blurred), false)
})

test('currentPageForeground：无 DOM 环境安全回退，壳隐藏 / 应用失活各自回落', () => {
  assert.equal(typeof document, 'undefined', 'node 环境无 DOM：页面事实走安全回退')
  const fake = makeFakeTarget()
  const uninstall = installShellVisibilityListener(fake.target)
  fake.emit({ visible: true, occluded: false })
  assert.equal(currentPageForeground(), true, '无 DOM + 壳在屏 ⇒ 安全返回真（旧行为不回退）')
  fake.emit({ visible: false, occluded: false })
  assert.equal(currentPageForeground(), false, '壳隐藏 ⇒ 页面不在前台')
  fake.emit({ visible: true, occluded: false, active: true })
  assert.equal(currentPageForeground(), true, 'active=true（应用激活）⇒ 前台')
  fake.emit({ visible: true, occluded: false, active: false })
  assert.equal(currentPageForeground(), false, 'active=false ⇒ 不在前台（无 DOM 回退也不假真）')
  fake.emit(undefined)
  assert.equal(currentPageForeground(), true, '还原默认事实')
  uninstall()
})

test('subscribePageForeground：复用壳事件 + 页面焦点/可见事件，派生布尔去重且初始不通知', () => {
  const shell = makeFakeTarget()
  const uninstallShell = installShellVisibilityListener(shell.target)
  shell.emit({ visible: true, occluded: false })
  const page = makeFakePageTarget()
  let docFacts: PageDocFacts = { visibilityState: 'visible', hasFocus: true }
  const seen: boolean[] = []
  const unsubscribe = subscribePageForeground(foreground => { seen.push(foreground) }, {
    focusTarget: page.target,
    docFacts: () => docFacts,
  })
  assert.deepEqual(seen, [], '初始不通知（基准 = 订阅时派生值）')
  assert.equal(page.listenerCount(), 3, '只新增 focus/blur/visibilitychange 三个监听（壳事件复用订阅）')

  docFacts = { visibilityState: 'visible', hasFocus: false }
  page.emit('blur')
  assert.deepEqual(seen, [false], '旧壳回退形态：页面失焦 = 离开前台')

  page.emit('blur')
  assert.deepEqual(seen, [false], '同派生布尔边沿去重（不重复通知）')

  docFacts = { visibilityState: 'hidden', hasFocus: true }
  page.emit('visibilitychange')
  assert.deepEqual(seen, [false], '文档隐藏不产生 true 边沿')

  docFacts = { visibilityState: 'visible', hasFocus: true }
  page.emit('focus')
  assert.deepEqual(seen, [false, true], '页面恢复可见 + 聚焦 ⇒ 回前台边沿')

  shell.emit({ visible: true, occluded: false, active: false })
  assert.deepEqual(seen, [false, true, false], '壳 active=false（应用切走）⇒ 离前台边沿')

  shell.emit({ visible: true, occluded: false, active: true })
  assert.deepEqual(seen, [false, true, false, true], '壳 active=true ⇒ 回前台边沿（壳事件驱动）')

  unsubscribe()
  assert.equal(page.listenerCount(), 0, '退订即卸载本次新增监听')
  const count = seen.length
  docFacts = { visibilityState: 'visible', hasFocus: false }
  page.emit('blur')
  shell.emit({ visible: false, occluded: false })
  assert.equal(seen.length, count, '退订后焦点 / 可见性 / 壳边沿都不再通知')
  shell.emit(undefined)
  uninstallShell()

  // node 无 window：no-op（生产无壳直开由 focus/blur 回退；测试环境不装监听）。
  const noopUnsubscribe = subscribePageForeground(() => { throw new Error('node subscribe must be a no-op') })
  assert.equal(typeof noopUnsubscribe, 'function')
  noopUnsubscribe()
})

test('接线锁：页面注意力单点（按参数纯函数 / 复用壳订阅 / 单向依赖）', () => {
  const attention = stripComments(readRepoFile('packages/renderer/src/page-attention.ts'))
  assert.match(attention, /docFacts\.visibilityState === 'visible'/, '文档可见是注意力门的页面半边')
  assert.match(attention, /isShellVisible\(detail\)/, '壳在屏未遮挡必须按传入 detail 判（不双读全局相位门）')
  assert.match(attention, /detail\.active \?\? docFacts\.hasFocus/, 'active 缺席时回退 document.hasFocus()')
  assert.match(attention, /pageForegroundOf\(currentShellVisibility\(\), defaultDocFacts\(\)\)/,
    'currentPageForeground 必须自用纯函数（renderer ENTRYLESS 死导出门：selfUsed）')
  assert.match(attention, /subscribeShellVisibility\(/, '订阅复用壳事实订阅（不装第二份壳事件监听）')
  assert.match(attention, /window as unknown as PageAttentionEventTarget/,
    '生产 focus/blur 目标 = window（默认监听目标写反时现测必须变红）')
  assert.match(attention, /document as unknown as PageAttentionEventTarget/,
    '生产 visibilitychange 目标 = document（默认监听目标写反时现测必须变红）')
  assert.doesNotMatch(attention, /installShellVisibilityListener/, '不得再装第二份壳事件监听')
  assert.doesNotMatch(attention, /background-phase|shouldRunBackgroundPhase/,
    '注意力门不得复用相位门（其内部 isShellVisible() 读全局，纯函数会失真）')
  const shellVisibility = stripComments(readRepoFile('packages/renderer/src/shell-visibility.ts'))
  assert.doesNotMatch(shellVisibility, /page-attention/, '单向依赖：shell-visibility 不得反向 import page-attention（值环）')
})

test('恢复补偿：宿主可见边沿也补偿一轮，且不新增第二前台门', () => {
  const compensation = readRepoFile('packages/renderer/src/app-hooks/use-visibility-compensation.ts')
  assert.match(compensation, /subscribeShellVisibility/, '恢复补偿必须订阅宿主可见性事实')
  assert.match(compensation, /let lastPhase = shouldRunBackgroundPhase\(document\.visibilityState\)/,
    'mount 时记录初始相位（基准 = 当前统一相位）')
  assert.match(compensation, /const notePhaseEdge = \(\): void => \{/u,
    '相位边沿单点定义（壳 / 页面两源共用一个函数）')
  assert.equal((compensation.match(/const phase = shouldRunBackgroundPhase\(document\.visibilityState\)/gu) ?? []).length, 1,
    '相位判定只保留一处（notePhaseEdge 内），不得两源各写一份')
  assert.equal((compensation.match(/if \(phase && !lastPhase\) compensate\(\)/gu) ?? []).length, 1,
    '只有相位 false→true 才补偿（应用激活变化不重跑补偿轮）')
  assert.match(compensation, /subscribeShellVisibility\(notePhaseEdge\)/u,
    '壳事件与页面 visibilitychange 共用同一相位边沿函数')
  assert.match(compensation, /document\.addEventListener\('visibilitychange', notePhaseEdge\)/u,
    '页面 visibilitychange 复用同一相位边沿函数')
  assert.match(compensation, /lastPhase = phase/u, '相位记忆随每个边沿推进')
  assert.match(compensation, /visibilitychange/, '页面级 visibilitychange 补偿不得丢失')
  assert.doesNotMatch(compensation, /detail\.visible && !detail\.occluded/,
    '旧「只看壳 detail」的边沿必须废弃（active-only 变化不得驱动补偿）')
})

test('接线锁：background-phase 单一叠加壳可见性，十个相位消费方不另开第二判断', () => {
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
    // design 14 §D1：1Hz 会话健康采样走统一门（Swift 腿 visibilityState 恒 visible）。
    'packages/renderer/src/components/InstanceView.tsx',
    // 隐藏期不做每源 60s 图返回探针 / 静默对账（design 14 §D1）。
    'packages/renderer/src/app-hooks/use-shell-retry.ts',
    'packages/renderer/src/session-facts-source.ts',
  ]
  for (const consumer of consumers) {
    const source = readRepoFile(consumer)
    assert.ok(source.includes('shouldRunBackgroundPhase('), consumer + ' 必须经统一门')
    for (const forbidden of ['shell-visibility', 'isShellVisible', 'SHELL_VISIBILITY_EVENT']) {
      assert.ok(!source.includes(forbidden), consumer + ' 不得出现第二判断：' + forbidden)
    }
  }
})

test('接线负控：门序/四处相位门/通知事实与壳边沿回退都会变红', () => {
  const compensation = stripComments(readRepoFile('packages/renderer/src/app-hooks/use-visibility-compensation.ts'))
  const gateAt = compensation.indexOf('if (!shouldRunBackgroundPhase(document.visibilityState)) return')
  const dedupeAt = compensation.indexOf('lastCompensationAt = now')
  assert.ok(gateAt !== -1 && dedupeAt !== -1 && gateAt < dedupeAt,
    '补偿必须先过统一相位门再记录 250ms 去重时间戳')
  const resident = stripComments(readRepoFile('packages/renderer/src/app-hooks/use-resident-guard.ts'))
  assert.equal((resident.match(/shouldRunBackgroundPhase\(/gu) ?? []).length, 4,
    '压力阀四处（入口 / 快照后 / 错峰释放 / 页面恢复）都必须经统一门')
  assert.match(resident, /if \(stopped \|\| sampling \|\| !shouldRunBackgroundPhase\(/u, '入口门')
  assert.match(resident, /if \(stopped \|\| !shouldRunBackgroundPhase\(document\.visibilityState\)\) return/u, '快照后门')
  assert.match(resident,
    /setTimeout\(\(\) => \{[\s\S]{0,160}?shouldRunBackgroundPhase\([\s\S]{0,160}?releaseSource\(id, 'pressure'\)/u,
    '错峰释放的 setTimeout 内必须再判一次统一门')
  assert.match(resident, /const onVisibility = \(\): void => \{ if \(shouldRunBackgroundPhase\(/u, '页面恢复门')
  const notifications = stripComments(readRepoFile('packages/renderer/src/app-hooks/use-notifications.ts'))
  assert.match(notifications,
    /const requireHidden = viewStore\.getSnapshot\(\)\.painted === entry\.sourceId[\s\S]{0,240}?current === entry\.sessionId[\s\S]{0,160}?currentPageForeground\(\)/u,
    'requireHidden = 3 元注意力门（painted ∧ 同会话 current ∧ 页面注意力）')
  assert.doesNotMatch(notifications, /document\.hasFocus\(\)|document\.visibilityState|isShellVisible\(\)/u,
    '通知门不得自拼页面 / 壳事实（单一注意力谓词）')
  assert.match(notifications, /foreground: currentPageForeground\(\),/u,
    '补臂输入 foreground 与通知门同源（页面注意力）')
  assert.match(notifications, /subscribePageForeground\(/u, '返回前台边沿必须订阅页面注意力')
  assert.match(compensation, /subscribeShellVisibility\(/u, '壳可见边沿订阅不得丢失')
  assert.match(compensation, /const notePhaseEdge = \(\): void => \{/u,
    '壳 / 页面两源统一相位边沿（active-only 变化不重跑补偿）')
})

test('跨语言契约：Swift 派发的事件名 / detail 形状 / 窗口观察面与 renderer 同字面量', () => {
  const swift = readRepoFile('macos/Sources/DSHChamber/MainWindowController.swift')
  assert.ok(swift.includes(SHELL_VISIBILITY_EVENT), 'Swift 必须派发同一事件名')
  assert.ok(swift.includes('{detail: {visible: '), 'detail 形状必须含 visible')
  assert.ok(swift.includes(', occluded: '), 'detail 形状必须含 occluded')
  assert.ok(swift.includes(', active: '), 'detail 形状必须含 active（应用激活事实 additive）')
  assert.ok(swift.includes('didChangeOcclusionStateNotification'), '必须观察窗口遮挡状态变化')
  assert.ok(!swift.includes('windowVisible') && !swift.includes('windowOccluded'),
    'hostFacts 不得再携带无消费者的可见性键（事件是唯一事实通道）')
})
