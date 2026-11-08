/**
 * 「性能与内存」只读组的纯投影测试（resident-panel-model.ts）。
 *
 * 为什么测纯函数而不是 pin 组件源码：状态文案/格式化/禁用门/两击 arm 的真值表都在纯
 * 模块里，等价重构不误报、真实回归不漏；源码只留一条挂载锁（GeneralView 只在调试模式
 * 打开时把 ResidentPanel 挂在「更新」组之后）与词典键存在性——挂载丢失、失去调试门或
 * 键缺失是「面板消失/面板常驻/文案空白」这类静默回归，用文本锁钉住最直接。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { en, zh } from '../../src/locales.ts'
import {
  NO_RELEASE_ARM, RELEASE_CONFIRM_WINDOW_MS, decodeResidentSnapshot, formatBytes, formatDuration,
  hiddenForMs, lastReleaseView, pageHeapView, releaseArmed, releaseArmRemainingMs, releaseClick,
  releaseReasonKey, residentRowViews, residentStateKey, systemMemorySourceKey, systemMemoryView,
} from '../../src/client/resident-panel-model.ts'

// ---- 解码：未知形状不臆造 ----

test('decodeResidentSnapshot: 非对象 = 空表；坏行丢弃、未知状态降级为 unknown', () => {
  assert.deepEqual(decodeResidentSnapshot(undefined), { sources: [] })
  assert.deepEqual(decodeResidentSnapshot(null), { sources: [] })
  assert.deepEqual(decodeResidentSnapshot('x'), { sources: [] })
  assert.deepEqual(decodeResidentSnapshot({ sources: 'nope' }), { sources: [] })

  const decoded = decodeResidentSnapshot({
    sources: [
      { id: 'dsh-a', label: 'A', state: 'resident', hiddenSinceMs: 30_000, domNodes: 1200 },
      // 未知状态：诚实哨兵，绝不猜成 resident。
      { id: 'dsh-b', label: 'B', state: 'sleeping' },
      // 无 id 的行不可操作 → 丢弃。
      { label: 'no-id', state: 'resident' },
      'garbage',
      { id: '  dsh-c  ', state: 'failed', lastActiveAt: 1_000 },
    ],
  })
  assert.equal(decoded.sources.length, 3)
  assert.deepEqual(decoded.sources[0], { id: 'dsh-a', label: 'A', state: 'resident', hiddenSinceMs: 30_000, domNodes: 1200 })
  assert.equal(decoded.sources[1]?.state, 'unknown')
  assert.equal(decoded.sources[1]?.hiddenSinceMs, undefined)
  assert.equal(decoded.sources[2]?.id, 'dsh-c', 'id 两端空白被归一')
  assert.equal(decoded.sources[2]?.label, '')
  assert.equal(decoded.sources[2]?.lastActiveAt, 1_000)
})

test('decodeResidentSnapshot: lastRelease 结构校验（原因白名单 + at 有限）', () => {
  const ok = decodeResidentSnapshot({ sources: [], lastRelease: { sourceId: 'dsh-a', reason: 'manual', at: 5 } })
  assert.deepEqual(ok.lastRelease, { sourceId: 'dsh-a', reason: 'manual', at: 5 })
  assert.equal(decodeResidentSnapshot({ lastRelease: { sourceId: 'x', reason: 'bogus', at: 1 } }).lastRelease, undefined)
  assert.equal(decodeResidentSnapshot({ lastRelease: { sourceId: '', reason: 'cap', at: 1 } }).lastRelease, undefined)
  assert.equal(decodeResidentSnapshot({ lastRelease: { sourceId: 'x', reason: 'cap', at: -1 } }).lastRelease, undefined)
})

// ---- 状态文案键 ----

test('residentStateKey: 五种契约状态 + 未知哨兵全有独立文案键', () => {
  assert.equal(residentStateKey('active'), 'generalResidentStateActive')
  assert.equal(residentStateKey('resident'), 'generalResidentStateResident')
  assert.equal(residentStateKey('booting'), 'generalResidentStateBooting')
  assert.equal(residentStateKey('failed'), 'generalResidentStateFailed')
  assert.equal(residentStateKey('released'), 'generalResidentStateReleased')
  assert.equal(residentStateKey('unknown'), 'generalResidentStateUnknown')
})

// ---- 格式化 ----

test('formatDuration: 秒/分/时/天的紧凑形状与非法值', () => {
  assert.equal(formatDuration(0), '0s')
  assert.equal(formatDuration(999), '0s', '亚秒按 0s 显示（不做假精度）')
  assert.equal(formatDuration(1_000), '1s')
  assert.equal(formatDuration(59_000), '59s')
  assert.equal(formatDuration(60_000), '1m 00s')
  assert.equal(formatDuration(65_000), '1m 05s')
  assert.equal(formatDuration(3_600_000), '1h 00m')
  assert.equal(formatDuration(3_665_000), '1h 01m')
  assert.equal(formatDuration(90_000_000), '1d 01h')
  assert.equal(formatDuration(-1), '')
  assert.equal(formatDuration(Number.NaN), '')
})

test('formatBytes: 1024 进制（与 formatRuntimeBytes 同规）与非法值', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(1024), '1.0 KiB')
  assert.equal(formatBytes(1536), '1.5 KiB')
  assert.equal(formatBytes(100 * 1024 * 1024), '100 MiB')
  assert.equal(formatBytes(16 * 1024 ** 3), '16 GiB', '>=10 取整（与 formatRuntimeBytes 一致）')
  assert.equal(formatBytes(1.5 * 1024 ** 3), '1.5 GiB')
  assert.equal(formatBytes(-1), '—')
  assert.equal(formatBytes(Number.POSITIVE_INFINITY), '—')
})

// ---- 隐藏时长 ----

test('hiddenForMs: 优先 lastActiveAt + now 现算；hiddenSinceMs 兜底；无法判定 = undefined', () => {
  assert.equal(hiddenForMs({ hiddenSinceMs: 30_000 }, 1_000_000), 30_000, 'lastActiveAt 缺席才用发布端时长兜底')
  assert.equal(hiddenForMs({ hiddenSinceMs: 0 }, 1_000_000), 0, '0 是有效时长，不算未知')
  assert.equal(hiddenForMs({ lastActiveAt: 1_000_000 - 45_000 }, 1_000_000), 45_000)
  assert.equal(hiddenForMs({ hiddenSinceMs: 10, lastActiveAt: 0 }, 1_000_000), 1_000_000,
    '两者都在时用 lastActiveAt + 显示时钟现算（时长随面板打开前进，不冻结在发布时刻）')
  assert.equal(hiddenForMs({}, 1_000_000), undefined)
  assert.equal(hiddenForMs({ lastActiveAt: 1_000_001, hiddenSinceMs: 10 }, 1_000_000), 10,
    '未来时间戳不产生负时长：回落到发布端时长')
  assert.equal(hiddenForMs({ lastActiveAt: 1_000_001 }, 1_000_000), undefined, '既无可用差值也无兜底 = 未知')
})

// ---- 行视图与释放禁用门 ----

test('residentRowViews: 文案/禁用门/armed/busy 的完整映射', () => {
  const now = 1_000_000
  const rows = residentRowViews({
    sources: [
      // 发布端误带 hiddenSinceMs 也不得让屏上壳显示隐藏时长（行投影按 state 门控）。
      { id: 'local', label: '本地实例', state: 'active', hiddenSinceMs: 9_000 },
      { id: 'dsh-a', label: 'A', state: 'resident', hiddenSinceMs: 65_000, domNodes: 900 },
      { id: 'dsh-b', label: '  ', state: 'booting' },
      { id: 'dsh-c', label: 'C', state: 'failed' },
      { id: 'dsh-d', label: 'D', state: 'released' },
      { id: 'dsh-e', label: 'E', state: 'unknown' },
    ],
    releasingId: 'dsh-c',
    armedId: 'dsh-a',
    now,
  })
  assert.equal(rows.length, 6)
  assert.deepEqual(rows[0], {
    id: 'local', labelText: '本地实例', state: 'active', stateKey: 'generalResidentStateActive',
    hiddenForText: '', domNodesText: '', armed: false, busy: false, settingsTarget: false, releaseDisabled: true,
  })
  assert.equal(rows[1]?.hiddenForText, '1m 05s')
  assert.equal(rows[1]?.domNodesText, '900')
  assert.equal(rows[1]?.armed, true, 'arm 中的行显示「确认释放」')
  assert.equal(rows[1]?.releaseDisabled, false)
  assert.equal(rows[2]?.labelText, 'dsh-b', '空 label 回落 id')
  assert.equal(rows[2]?.releaseDisabled, true, 'booting 不可释放')
  assert.equal(rows[3]?.releaseDisabled, true, '释放中的行禁用（busy）')
  assert.equal(rows[3]?.busy, true)
  assert.equal(rows[4]?.releaseDisabled, true, '已释放的壳没有可拆的界面：释放按钮必须禁用')
  assert.equal(rows[4]?.hiddenForText, '', 'released 行不显示隐藏时长（壳已卸载）')
  assert.equal(rows[5]?.stateKey, 'generalResidentStateUnknown')
  assert.equal(rows[5]?.releaseDisabled, false)
})

test('residentRowViews: the settings-panel target row exposes no release action', () => {
  const rows = residentRowViews({
    sources: [{ id: 'dsh-t', label: 'T', state: 'resident', settingsTarget: true }],
    releasingId: null,
    armedId: null,
    now: 1_000_000,
  })
  assert.equal(rows[0]?.settingsTarget, true)
  assert.equal(rows[0]?.releaseDisabled, true, 'the target source must not offer a release action the guard would refuse')
})

// ---- 两击确认状态机 ----

test('releaseClick: 第一击 arm、窗内第二击释放并清 arm', () => {
  const first = releaseClick(NO_RELEASE_ARM, 'dsh-a', 1_000)
  assert.deepEqual(first, { action: 'armed', next: { armedId: 'dsh-a', armedAt: 1_000 } })
  const second = releaseClick(first.next, 'dsh-a', 1_000 + RELEASE_CONFIRM_WINDOW_MS)
  assert.deepEqual(second, { action: 'release', next: NO_RELEASE_ARM }, '边界（恰好 3s）仍算窗内')
})

test('releaseClick: 超窗/点别的行/时钟回拨 → 重新 arm，绝不误释放', () => {
  const armed = { armedId: 'dsh-a', armedAt: 1_000 }
  assert.deepEqual(releaseClick(armed, 'dsh-a', 1_000 + RELEASE_CONFIRM_WINDOW_MS + 1), {
    action: 'armed', next: { armedId: 'dsh-a', armedAt: 1_000 + RELEASE_CONFIRM_WINDOW_MS + 1 },
  })
  assert.deepEqual(releaseClick(armed, 'dsh-b', 2_000), { action: 'armed', next: { armedId: 'dsh-b', armedAt: 2_000 } })
  // 时钟回拨：elapsed < 0 一律按「不在窗内」读（绝不凭逆序时间戳释放）。
  assert.deepEqual(releaseClick(armed, 'dsh-a', 999), { action: 'armed', next: { armedId: 'dsh-a', armedAt: 999 } })
})

test('releaseArmed / releaseArmRemainingMs: 窗边界与无 arm', () => {
  assert.equal(releaseArmed(NO_RELEASE_ARM, 'dsh-a', 1_000), false)
  assert.equal(releaseArmed(NO_RELEASE_ARM, null, 1_000), false)
  const armed = { armedId: 'dsh-a', armedAt: 1_000 }
  assert.equal(releaseArmed(armed, 'dsh-a', 1_000), true)
  assert.equal(releaseArmed(armed, 'dsh-a', 1_000 + RELEASE_CONFIRM_WINDOW_MS), true)
  assert.equal(releaseArmed(armed, 'dsh-a', 1_000 + RELEASE_CONFIRM_WINDOW_MS + 1), false)
  assert.equal(releaseArmed(armed, 'dsh-b', 1_000), false)
  assert.equal(releaseArmed(armed, 'dsh-a', 999), false)
  assert.equal(releaseArmRemainingMs(NO_RELEASE_ARM, 1_000), 0)
  assert.equal(releaseArmRemainingMs(armed, 1_000), RELEASE_CONFIRM_WINDOW_MS)
  assert.equal(releaseArmRemainingMs(armed, 2_000), RELEASE_CONFIRM_WINDOW_MS - 1_000)
  assert.equal(releaseArmRemainingMs(armed, 9_999), 0, '已超窗 = 0（定时器立即撤）')
  assert.equal(releaseArmRemainingMs(armed, 999), 0, '时钟回拨同样立即撤（保守重来）')
})

// ---- 内存读数投影 ----

test('systemMemoryView: 有效快照 → 格式化 + 来源键；缺字段 = 不可得', () => {
  const view = systemMemoryView({ totalBytes: 16 * 1024 ** 3, availableBytes: 4 * 1024 ** 3, source: 'proc-meminfo' })
  assert.deepEqual(view, {
    kind: 'available', available: '4.0 GiB', total: '16 GiB', sourceKey: 'generalResidentMemorySourceProcMeminfo',
  }, 'total 16 GiB 取整、available 4.0 GiB 一位小数——与 formatRuntimeBytes 同规')
  // available > total（坏快照）→ 夹到总量，不展示「可用多于总量」。
  assert.deepEqual(systemMemoryView({ totalBytes: 1024, availableBytes: 2048 }), {
    kind: 'available', available: '1.0 KiB', total: '1.0 KiB', sourceKey: 'generalResidentMemorySourceUnknown',
  })
  assert.deepEqual(systemMemoryView(undefined), { kind: 'unavailable' })
  assert.deepEqual(systemMemoryView({}), { kind: 'unavailable' })
  assert.deepEqual(systemMemoryView({ totalBytes: 0, availableBytes: 0 }), { kind: 'unavailable' })
  assert.deepEqual(systemMemoryView({ totalBytes: 1024, availableBytes: -1 }), { kind: 'unavailable' })
})

test('systemMemorySourceKey: 三种探测来源 + 未知', () => {
  assert.equal(systemMemorySourceKey('proc-meminfo'), 'generalResidentMemorySourceProcMeminfo')
  assert.equal(systemMemorySourceKey('os-freemem'), 'generalResidentMemorySourceOsFreemem')
  assert.equal(systemMemorySourceKey('vm-stat'), 'generalResidentMemorySourceVmStat')
  assert.equal(systemMemorySourceKey('other'), 'generalResidentMemorySourceUnknown')
  assert.equal(systemMemorySourceKey(undefined), 'generalResidentMemorySourceUnknown')
})

test('pageHeapView: 两个字段都在才可读；缺失/非法 = 不可得（不展示半条读数）', () => {
  assert.deepEqual(pageHeapView({ usedJSHeapSize: 200 * 1024 * 1024, jsHeapSizeLimit: 4 * 1024 ** 3 }), {
    kind: 'available', used: '200 MiB', limit: '4.0 GiB',
  })
  assert.deepEqual(pageHeapView({ usedJSHeapSize: 1024 }), { kind: 'unavailable' })
  assert.deepEqual(pageHeapView({ jsHeapSizeLimit: 1024 }), { kind: 'unavailable' })
  assert.deepEqual(pageHeapView({ usedJSHeapSize: 1024, jsHeapSizeLimit: 0 }), { kind: 'unavailable' })
  assert.deepEqual(pageHeapView(null), { kind: 'unavailable' })
  assert.deepEqual(pageHeapView(undefined), { kind: 'unavailable' })
})

test('lastReleaseView: label from snapshot sources; reason mapped to dictionary keys', () => {
  assert.deepEqual(lastReleaseView({
    sources: [{ id: 'dsh-a', label: 'A', state: 'released' }],
    lastRelease: { sourceId: 'dsh-a', reason: 'pressure', at: 1 },
  }), { label: 'A', reasonKey: 'generalResidentReleaseReasonPressure' })
  assert.deepEqual(lastReleaseView({
    sources: [],
    lastRelease: { sourceId: 'dsh-x', reason: 'manual', at: 1 },
  }), { label: 'dsh-x', reasonKey: 'generalResidentReleaseReasonManual' }, '缺失标签回落 id，绝不猜身份')
  assert.equal(lastReleaseView({ sources: [] }), undefined)
  assert.equal(releaseReasonKey('cap'), 'generalResidentReleaseReasonCap')
  assert.equal(releaseReasonKey('manual'), 'generalResidentReleaseReasonManual')
})

// ---- i18n 键集与组件挂载锁 ----

test('i18n: resident 组文案在 zh/en 双语字典里齐全且非空', () => {
  const keys = [
    'generalGroupPerformanceMemory',
    'generalResidentColumnSource', 'generalResidentColumnState', 'generalResidentColumnHidden',
    'generalResidentColumnDom', 'generalResidentColumnAction', 'generalResidentEmpty',
    'generalResidentStateActive', 'generalResidentStateResident', 'generalResidentStateBooting',
    'generalResidentStateFailed', 'generalResidentStateReleased', 'generalResidentStateUnknown',
    'generalResidentRelease', 'generalResidentReleaseConfirm', 'generalResidentReleasing',
    'generalResidentReleaseRequested', 'generalResidentReleaseHint', 'generalResidentSettingsTarget',
    'generalResidentLastRelease', 'generalResidentReleaseReasonManual', 'generalResidentReleaseReasonCap',
    'generalResidentReleaseReasonPressure',
    'generalResidentMemoryTitle', 'generalResidentSystemLabel', 'generalResidentPageHeapLabel',
    'generalResidentSystemAvailable', 'generalResidentSystemSource',
    'generalResidentMemorySourceProcMeminfo', 'generalResidentMemorySourceOsFreemem',
    'generalResidentMemorySourceVmStat', 'generalResidentMemorySourceUnknown',
    'generalResidentUnavailable', 'generalResidentPageHeapValue', 'generalResidentPerShellNote',
  ] as const
  for (const key of keys) {
    assert.equal(typeof zh[key], 'string', 'zh 缺键：' + key)
    assert.equal(typeof en[key], 'string', 'en 缺键：' + key)
    assert.notEqual(zh[key].trim(), '', 'zh 空文案：' + key)
    assert.notEqual(en[key].trim(), '', 'en 空文案：' + key)
  }
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort(), 'en/zh 键集必须镜像')
})

test('挂载锁: GeneralView 只在调试模式打开时挂载 ResidentPanel，且位置在「更新」组（调试模式行）之后', () => {
  const source = readFileSync(new URL('../../src/client/GeneralView.tsx', import.meta.url), 'utf8')
  assert.match(source, /import \{ ResidentPanel \} from '\.\/ResidentPanel\.tsx'/)
  // 唯一挂载点：无条件挂载 = 面板常驻，订阅/DOM 计数随页面一直在（旧形态回归）。
  assert.equal(source.match(/<ResidentPanel\b/g)?.length, 1, 'ResidentPanel 必须只有一个挂载点')
  const mountLine = source.split('\n').find(line => line.includes('<ResidentPanel')) ?? ''
  assert.match(mountLine, /&&\s*<ResidentPanel t=\{t\} \/>/, '挂载必须是条件渲染（调试模式门），不能无条件挂载')
  // 门在纯函数里，组件只接「已水合 + 调试模式开关」两个事实（真值表在 debug-mode-gate.test.ts）；
  // 两个事实都必须来自真实状态——写死 `hydrated: true` 也会让「仅调试模式」通过，故连传入形参一起钉。
  assert.match(source, /debugOnlySectionsVisible\(\{\s*hydrated,\s*enabled: settings\?\.debug\?\.enabled === true,?\s*\}\)/)
  // 位置：「更新」组的最后一行是调试模式行，面板必须在该组之后（不在「运行」组后常驻）。
  const update = source.indexOf('<UpdateSection t={t} />')
  const mount = source.indexOf('<ResidentPanel t={t} />')
  assert.ok(update >= 0 && mount > update, 'ResidentPanel 必须挂在「更新」组（调试模式行）之后')
})
