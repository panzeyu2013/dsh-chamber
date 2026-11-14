/**
 * B6（渲染 P0）：Keyed-row FLIP 的高频提交预算。
 *
 * 侧栏自有的 motion 外壳（rows/animated-rows-motion.tsx）扩展逐字节 vendor port
 * （rows/animated-rows.tsx，provenance 锁在 animated-rows.test.ts），在 port 逐行量几何
 * 之前先过 `shouldAnimateRowMotion`：两次 FLIP 起始批间隔 ≥ ROW_MOTION_MIN_INTERVAL_MS
 * （> port 的 ROW_GLIDE_MS），churn 期间的其余提交即时落位（与 resetKey settle 同一静止
 * 语义）。本包无 DOM/React 渲染环境，故分两层锁：
 * 1. 行为：预算真值表（首次 / 间隔内 / 边界 / 时钟回拨 / 坏钟）；
 * 2. 接线与负向对照（源码文本）：port 本体零改动、外壳只委托不复制、预算判定在 super 之前、
 *    ServerSection 渲染预算外壳且调用方 gates（rowKeys/role/label/ready）原样。
 *
 * Run directly: node test/session-rows/row-motion-budget.test.ts
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { stripComments } from '../../../../scripts/dev/test-support/source-text.ts'
import {
  ROW_MOTION_MIN_INTERVAL_MS,
  shouldAnimateRowMotion,
} from '../../src/client/rows/motion-budget.ts'

/** Source locks must see code, not comments: a commented-out line must not satisfy them. */
const read = (rel: string): string => stripComments(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8'))

const BUDGET = read('../../src/client/rows/motion-budget.ts')
const MOTION = read('../../src/client/rows/animated-rows-motion.tsx')
const PORT = read('../../src/client/rows/animated-rows.tsx')
const SECTION = read('../../src/client/ServerSection.tsx')
/** port 的滑行时长（源文本单源，避免测试把 200 抄成第二处字面量）。 */
const PORT_GLIDE_MS = Number(PORT.match(/const ROW_GLIDE_MS = (\d+)/u)?.[1])

test('a FLIP batch starts at most once per interval; normal cadence is untouched', () => {
  // 设计下限（design 06 §3.3「每列表 ≥250ms」）用**精确值**钉住，并对照 port 的 ROW_GLIDE_MS：
  // 旧的 200–500 宽窗允许把常量改成 200–249（仍小于一次滑行，批与批叠加）而不变红。
  assert.ok(Number.isFinite(PORT_GLIDE_MS), 'port 的 ROW_GLIDE_MS 必须可从源文本解析')
  assert.equal(ROW_MOTION_MIN_INTERVAL_MS, 250, '阈值 = 设计下限 250ms（design 06 §3.3）')
  assert.ok(ROW_MOTION_MIN_INTERVAL_MS > PORT_GLIDE_MS,
    '阈值必须大于一次滑行时长（ROW_GLIDE_MS = ' + PORT_GLIDE_MS + 'ms）')
  assert.equal(shouldAnimateRowMotion(Number.NEGATIVE_INFINITY, 1_000), true, '首次提交')
  assert.equal(shouldAnimateRowMotion(0, ROW_MOTION_MIN_INTERVAL_MS - 1), false, '间隔内跳过')
  assert.equal(shouldAnimateRowMotion(0, ROW_MOTION_MIN_INTERVAL_MS), true, '边界 = 允许')
  assert.equal(shouldAnimateRowMotion(1_000, 1_000 + ROW_MOTION_MIN_INTERVAL_MS * 3), true,
    '正常交互间隔不受影响')
  assert.equal(shouldAnimateRowMotion(1_000, 500), false, '时钟回拨按冷却处理（保守，不放大动画频率）')
  assert.equal(shouldAnimateRowMotion(1_000, Number.NaN), false, '坏钟不得放大动画')
  assert.equal(shouldAnimateRowMotion(Number.NaN, 1_000), true, '未记录过起始（防御性 NaN）')
})

test('the shell delegates to the verbatim port; budget check precedes the geometry read', () => {
  // 负向对照：预算实现绝不能落回 port body（provenance 锁之外的第二道漂移闸）。
  assert.doesNotMatch(PORT, /motion-budget|ROW_MOTION_MIN_INTERVAL_MS|shouldAnimateRowMotion|performance\.now/u,
    'port 保持与 pinned vendor 逐字节一致：预算只在外壳里')
  assert.match(MOTION, /import \{ AnimatedRows \} from '\.\/animated-rows\.tsx'/u)
  assert.match(MOTION, /import \{ shouldAnimateRowMotion \} from '\.\/motion-budget\.ts'/u)
  assert.match(MOTION, /extends AnimatedRows/u, '外壳只扩展 port，不复制 body')
  assert.doesNotMatch(MOTION, /getBoundingClientRect|getComputedStyle|\.animate\(|element\.animate/u,
    '外壳不得复制 port 的几何 / 动画实现')
  const checkAt = MOTION.indexOf('shouldAnimateRowMotion(this.motionStartedAt, now)')
  const superAt = MOTION.indexOf('super.getSnapshotBeforeUpdate(previous)')
  assert.ok(checkAt !== -1 && superAt !== -1 && checkAt < superAt,
    '预算判定必须先于 super（port 第一步就是逐行量几何）')
  assert.match(MOTION, /if \(snapshot !== null\) this\.motionStartedAt = now/u,
    '只有真正启动 FLIP 才记录起始时刻（被 port 的 sameRows/ready 早退时不计冷却）')
  assert.match(MOTION, /performance\.now\(\)/u)
  assert.match(BUDGET, /return now - lastStartedAt >= ROW_MOTION_MIN_INTERVAL_MS/u)
})

test('the browse tree renders the budgeted shell and keeps every caller gate', () => {
  assert.match(SECTION, /import \{ AnimatedRowsMotion \} from '\.\/rows\/animated-rows-motion\.tsx'/u)
  assert.match(SECTION, /<AnimatedRowsMotion[\s\S]{0,800}?rowKeys=\{rowKeys\}/u)
  assert.match(SECTION, /<AnimatedRowsMotion[\s\S]{0,800}?role="tree" label=\{t\('section\.sessions'\)\}/u,
    'tree semantics / 可访问名仍由调用方 pin 住')
  assert.match(SECTION, /<AnimatedRowsMotion[\s\S]{0,900}?ready=\{server\.aggregateReady === true/u,
    '拖拽在飞 / 数据未就绪时动效仍整体停用')
  assert.equal(SECTION.split('</AnimatedRowsMotion>').length - 1, 1, '恰好一处关闭标签')
})
