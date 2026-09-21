import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyRequireSwitch,
  DARK_SURFACE_MAX_LUMA,
  switchFrameVerdict,
  type SwitchFrameSample,
} from '../../src/switch-frame-verdict.ts'

// W3 无白帧判据（见 src/switch-frame-verdict.ts 头注）：三形态 + 温壳进度面。
// 判据只判采集到的事实：未演练/探针坏/零帧一律 INFO（ok === null），严格档才升 FAIL。
// 本文件是 CI 里的主判据面（采集腿 = scripts/perf/switch-frame-probe.mjs，需 GUI）。

function domSample(over: Partial<SwitchFrameSample> = {}): SwitchFrameSample {
  return { at: 100, visibleView: 'gateway-a', selectedView: 'gateway-b', veil: false, veilBg: null, ...over }
}

test('形态(a) 无可见视图帧 ⇒ FAIL（已打开来源互切不允许任何一帧没有视图）', () => {
  const verdict = switchFrameVerdict({
    switchExercised: true,
    samples: [domSample(), domSample({ at: 116, visibleView: null })],
  })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.counts.noVisibleViewFrames, 1)
  assert.match(verdict.evidence, /无可见视图 1 帧/)
})

test('形态(b) 遮罩底色 #ffffff ⇒ FAIL；声明浅色的来源豁免', () => {
  const white = switchFrameVerdict({
    switchExercised: true,
    samples: [domSample({ veil: true, veilBg: 'rgb(255, 255, 255)' })],
  })
  assert.equal(white.ok, false)
  assert.equal(white.counts.flatWhiteFrames, 1)
  const declared = switchFrameVerdict({
    switchExercised: true,
    declaredLightViewIds: ['gateway-b'],
    samples: [domSample({ veil: true, veilBg: 'rgba(255, 255, 255, 1)' })],
  })
  assert.equal(declared.ok, true)
  assert.equal(declared.counts.flatWhiteFrames, 0)
})

test('形态(b) Leg B 像素平面为 #ffffff ⇒ FAIL（不需要遮罩事实）', () => {
  const verdict = switchFrameVerdict({
    switchExercised: true,
    samples: [domSample({ veil: undefined, veilBg: undefined, flatColor: '#ffffff', inkRatio: 0 })],
  })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.counts.flatWhiteFrames, 1)
})

test('形态(c) 主题失配进度面：cache 命中时必须精确等于目标快照色', () => {
  const miss = switchFrameVerdict({
    switchExercised: true,
    expectedVeilBg: { 'gateway-b': '#151517' },
    samples: [domSample({ veil: true, veilBg: 'rgb(59, 59, 59)' })],
  })
  assert.equal(miss.ok, false)
  assert.equal(miss.counts.themeMismatchedFrames, 1)
  const hit = switchFrameVerdict({
    switchExercised: true,
    expectedVeilBg: { 'gateway-b': '#151517' },
    samples: [domSample({ veil: true, veilBg: 'rgb(21, 21, 23)' })],
  })
  assert.equal(hit.ok, true)
})

test('形态(c) 无 cache 时回退暗色族：chamber 暗色通过，中灰/亮色 FAIL', () => {
  const dark151517 = switchFrameVerdict({ switchExercised: true, samples: [domSample({ veil: true, veilBg: '#151517' })] })
  const dark0f1115 = switchFrameVerdict({ switchExercised: true, samples: [domSample({ veil: true, veilBg: 'rgb(15, 17, 21)' })] })
  assert.equal(dark151517.ok, true)
  assert.equal(dark0f1115.ok, true)
  // 中灰（0x77=119/通道，luma≈119）必须高于暗色族阈值，否则下面这条用例证明不了任何东西。
  assert.ok(DARK_SURFACE_MAX_LUMA < 0.2126 * 119 + 0.7152 * 119 + 0.0722 * 119, '中灰必须高于暗色族阈值')
  const midGray = switchFrameVerdict({ switchExercised: true, samples: [domSample({ veil: true, veilBg: '#777777' })] })
  assert.equal(midGray.ok, false)
  assert.equal(midGray.counts.themeMismatchedFrames, 1)
})

test('半透明遮罩不参与颜色判定（alpha < 0.5 = 底下是什么色不是本帧事实）', () => {
  const verdict = switchFrameVerdict({
    switchExercised: true,
    samples: [domSample({ veil: true, veilBg: 'rgba(255, 255, 255, 0.2)' })],
  })
  assert.equal(verdict.ok, true)
  assert.deepEqual(verdict.counts.flatWhiteFrames, 0)
  assert.deepEqual(verdict.counts.themeMismatchedFrames, 0)
})

test('温壳（切换前已 settle）上出现进度面 ⇒ FAIL（蓝图 §7.3-3）', () => {
  const verdict = switchFrameVerdict({
    switchExercised: true,
    samples: [
      domSample({ veil: true, veilBg: '#151517', targetSettledBeforeSwitch: true }),
      domSample({ at: 120, veil: true, veilBg: '#151517', targetSettledBeforeSwitch: true }),
    ],
  })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.counts.settledVeilFrames, 2)
  assert.match(verdict.evidence, /温壳仍出现进度面 2 帧/)
})

test('温壳上无进度面（另有冷启动帧）⇒ PASS：覆盖率不是通过条件', () => {
  const verdict = switchFrameVerdict({
    switchExercised: true,
    samples: [
      domSample({ targetSettledBeforeSwitch: true }),
      domSample({ at: 116, veil: true, veilBg: '#000000', targetSettledBeforeSwitch: false }),
    ],
  })
  assert.equal(verdict.ok, true)
  assert.equal(verdict.counts.veilFrames, 1)
})

test('Leg B 有内容的帧不参与颜色判定（flatColor === null 只是证据）', () => {
  const verdict = switchFrameVerdict({
    switchExercised: true,
    samples: [domSample({ veil: undefined, veilBg: undefined, flatColor: null, inkRatio: 0.42 })],
  })
  assert.equal(verdict.ok, true)
})

test('INFO 语义：未演练 / 零帧 / 探针异常都不是通过', () => {
  assert.equal(switchFrameVerdict({ switchExercised: false }).ok, null)
  assert.equal(switchFrameVerdict({ switchExercised: true, samples: [] }).ok, null)
  const broken = switchFrameVerdict({ switchExercised: true, samples: [domSample()], error: 'probe blew up' })
  assert.equal(broken.ok, null)
  assert.match(broken.evidence, /探针异常/)
})

test('严格档 --require-switch：INFO 升 FAIL，PASS/FAIL 原样', () => {
  const info = switchFrameVerdict({ switchExercised: false })
  assert.equal(applyRequireSwitch(info, false).ok, null)
  const strict = applyRequireSwitch(info, true)
  assert.equal(strict.ok, false)
  assert.match(strict.evidence, /--require-switch/)
  const pass = switchFrameVerdict({ switchExercised: true, samples: [domSample({ veil: true, veilBg: '#151517' })] })
  assert.equal(applyRequireSwitch(pass, true).ok, true)
  const fail = switchFrameVerdict({ switchExercised: true, samples: [domSample({ visibleView: null })] })
  assert.equal(applyRequireSwitch(fail, true).ok, false)
})
