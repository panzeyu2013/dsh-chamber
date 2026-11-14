/**
 * 行位移"指针并未移动"门控的锁（design 06 §7）。
 *
 * 本包无 DOM/React 渲染环境（见 row-render-cost.test.ts 头注），所以分两层锁：
 * 1. 行为：`needsHoverGate` 真值表——位移判据 × "位移前是否已 hover" 的四行全表；
 * 2. 接线与漂移（源码文本）：纯机器零 React 依赖（因此可被本文件直接 import）；scan 只认
 *    keyed 行、只由 pointermove/pointerdown 解除、解除时对仍在指针下的行补一次 over（让
 *    React 的 onPointerEnter 重新求值）；钩子 dispose 后置空 ref（StrictMode 重挂载换新机器，
 *    不复用 inert 机器）；section 根 ref、行内跑马灯、悬停卡三处守卫在场；
 *    样式表里每一条**行级** `:hover` 揭示都带 `:not([data-hover-gate])`——新增漏带即红。
 *    归档管理器（不参与 FLIP）、重命名态（抑制性规则，不是揭示）、JS 揭示半边
 *    `:has(.rowActionsVisible)`、未分组桶的 transparent 复位都不在门控面内。
 *
 * Run directly: node test/session-rows/hover-motion-gate.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { stripComments } from '../../../../scripts/dev/test-support/source-text.ts'
import {
  HOVER_GATE_ATTR,
  HOVER_GATE_SELECTOR,
  needsHoverGate,
  rowKeySequenceDiffers,
} from '../../src/client/hover-motion-gate.ts'

/** Source locks must see code, not comments: a commented-out line must not satisfy them. */
const read = (rel: string): string => stripComments(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8'))
const readCss = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '')

const GATE = read('../../src/client/hover-motion-gate.ts')
const HOOK = read('../../src/client/use-hover-motion-gate.ts')
const SECTION = read('../../src/client/ServerSection.tsx')
const ROWS = read('../../src/client/ServerSectionRows.tsx')
const CARD = read('../../src/client/RowHoverCard.tsx')
const CSS = readCss('../../src/client/sidebar-chamber.module.css')
/** 全部 CSS 模块（漂移锁半径 = 断言名里的「行选择器/行级 :hover」，不是单个文件）：
 *  新模块给行加过渡、或新增漏带门控条款的行级揭示，同样必须变红。 */
const CSS_SOURCES = readdirSync(fileURLToPath(new URL('../../src/client/', import.meta.url)),
  { recursive: true, encoding: 'utf8' })
  .filter((name) => name.endsWith('.css'))
  .map((name) => ({ name, text: readCss('../../src/client/' + name) }))

test('only a row that moved under a stationary pointer is gated', () => {
  // 位移前就在指针下的行保留揭示：用户真实悬停绝不掉。
  assert.equal(needsHoverGate(true, false), true, '被搬进指针下的行要门控')
  assert.equal(needsHoverGate(true, true), false, '位移前已在指针下的行保留揭示')
  assert.equal(needsHoverGate(false, false), false, '未位移的行不受影响')
  assert.equal(needsHoverGate(false, true), false, '未位移且已 hover 的行不受影响')
  assert.equal(HOVER_GATE_ATTR, 'data-hover-gate')
  assert.equal(HOVER_GATE_SELECTOR, '[data-hover-gate]')
})

test('the expensive animation scan runs only when the row-key sequence changed (B6)', () => {
  // 真值表：null（首次）/长度 / 顺序 / 内容变化 → 需要扫描；全等 → 跳过 getAnimations。
  assert.equal(rowKeySequenceDiffers(null, 0, () => undefined), true, '首次扫描没有可比序列')
  assert.equal(rowKeySequenceDiffers(null, 1, () => 'a'), true, '首次扫描且已有行')
  assert.equal(rowKeySequenceDiffers(['a'], 1, index => ['a'][index]), false,
    '序列未变 ⇒ 本提交不可能有新 FLIP 位移，跳过分配主站')
  assert.equal(rowKeySequenceDiffers(['a', 'b'], 2, index => ['a', 'b'][index]), false)
  assert.equal(rowKeySequenceDiffers(['a'], 2, index => ['a', 'b'][index]), true, '行数变化')
  assert.equal(rowKeySequenceDiffers(['a', 'b'], 2, index => ['b', 'a'][index]), true,
    '顺序变化 = FLIP 位移的真实信号')
  assert.equal(rowKeySequenceDiffers(['a', 'b'], 2, index => ['a', 'c'][index]), true, '内容变化')
  assert.equal(rowKeySequenceDiffers(['a'], 0, () => undefined), true, '行被清空')

  // 接线顺序（源码文本）：对拍必须先于 getAnimations，且读的是 data-row-key 的真实序列。
  const gateAt = GATE.indexOf('rowKeySequenceDiffers(lastRowKeys')
  const scanAt = GATE.indexOf('getAnimations({ subtree: true })')
  assert.ok(gateAt !== -1 && scanAt !== -1 && gateAt < scanAt,
    '行键对拍必须在 getAnimations 之前（否则热点没有降下来）')
  assert.match(GATE, /querySelectorAll<HTMLElement>\('\[data-row-key\]'\)/u)
  assert.match(GATE, /!root\.isConnected/u, '离屏 / 卸载中的 section 不扫')
  assert.match(GATE, /lastRoot = null[\s\S]{0,160}?lastRowKeys = null/u, 'dispose 清掉缓存')
})

test('行键对拍前置条件漂移锁：keyed 行没有 CSS 动画/过渡，WAAPI 只在 port 里创建', () => {
  // 前置条件 = keyed 行的唯一动画来源是 FLIP（port）。任何给行选择器加 animation/
  // transition、或在别处直接 element.animate 的改动都会让 B6 静默漏门控。
  const srcFiles = readdirSync(fileURLToPath(new URL('../../src/client/', import.meta.url)),
    { recursive: true, encoding: 'utf8' })
    .filter((name) => /\.(?:ts|tsx)$/u.test(name))
  const offenders = srcFiles.filter((name) => name !== 'rows/animated-rows.tsx'
    && read('../../src/client/' + name).includes('.animate('))
  assert.deepEqual(offenders, [], 'element.animate 只允许出现在 port（animated-rows.tsx）')
  // 行选择器（含 class 选择器）不得带动画/过渡；statusSpinner/foldChevron 等字形站点不在 keyed 行上。
  const rowSelector = /(?:data-row-key|sessionRow|\.row\b|\[data-session)/iu
  for (const { name, text } of CSS_SOURCES) {
    const animatedBlocks = [...text.matchAll(/^([^{}@]+)\{([^{}]*)\}/gmu)]
      .filter(([, , body]) => /\b(?:animation|transition)\s*:/u.test(body))
    for (const [, selector, body] of animatedBlocks) {
      assert.ok(!rowSelector.test(selector),
        `${name}：行选择器不得带 animation/transition：` + selector.trim() + ' => ' + body.trim())
    }
  }
  const port = read('../../src/client/rows/animated-rows.tsx')
  assert.match(port, /\.animate\(/u, 'port 是唯一允许 element.animate 的文件')
  const motion = read('../../src/client/rows/animated-rows-motion.tsx')
  assert.match(motion, /import \{ AnimatedRows \} from '\.\/animated-rows\.tsx'/u)
  assert.match(motion, /extends AnimatedRows/u)
  assert.match(motion, /shouldAnimateRowMotion\(this\.motionStartedAt, now\)/u)
})

test('the machine stays React-free and releases only on real pointer input', () => {
  assert.ok(!/from 'react'/u.test(GATE), '纯机器不得依赖 React（否则 plain-node 行为测无法 import）')
  assert.match(HOOK, /import \{ createHoverMotionGate, type HoverMotionGate \} from '\.\/hover-motion-gate\.ts'/u)
  assert.match(HOOK, /useLayoutEffect\(\(\) => \{[\s\S]{0,220}?gateRef\.current === null[\s\S]{0,120}?gateRef\.current = createHoverMotionGate\(\)[\s\S]{0,80}?gateRef\.current\.scan\(ref\.current\)/u,
    '每次提交后的 layout 阶段 scan；机器在此补建（首次挂载与 StrictMode 重挂载），渲染期不建')
  assert.match(HOOK, /gateRef\.current\?\.dispose\(\)[\s\S]{0,80}?gateRef\.current = null/u,
    'dispose 后必须把 ref 置空：StrictMode 的 setup→cleanup→setup 否则会复用一台永久 inert 的机器，scan 加上的门控再无人解除')
  assert.match(GATE, /document\.addEventListener\('pointermove', onPointer, \{ capture: true, passive: true \}\)/u)
  assert.match(GATE, /document\.addEventListener\('pointerdown', onPointer, \{ capture: true, passive: true \}\)/u)
  assert.match(GATE, /document\.removeEventListener\('pointermove', onPointer, \{ capture: true \}\)/u, '卸载摘监听')
  assert.match(GATE, /getAnimations\(\{ subtree: true \}\)/u, '候选只从动画里取，不逐行量布局')
  assert.match(GATE, /target\.dataset\.rowKey === undefined/u, '只门控 keyed 行（退出克隆体没有 key）')
  assert.match(GATE, /target\.matches\(':hover'\)/u, '用浏览器自己的 hover 真相判定"位移前"')
  assert.match(GATE, /row\.matches\(':hover'\)/u, '解除时只对仍在指针下的行补 over')
  assert.match(GATE, /new PointerEvent\('pointerover', \{/u, 'React 的 enter 由 pointerover/out 合成')
  assert.match(GATE, /relatedTarget: null/u)
})

test('the section root, the marquee and the hover card all honour the gate', () => {
  assert.match(SECTION, /import \{ useHoverMotionGate \} from '\.\/use-hover-motion-gate\.ts'/u)
  assert.match(SECTION, /const sectionRef = useRef<HTMLElement \| null>\(null\)/u)
  assert.match(SECTION, /useHoverMotionGate\(sectionRef\)/u)
  assert.match(SECTION, /<section\n\s+ref=\{sectionRef\}/u, 'scan 的根就是该节段')
  assert.match(ROWS, /import \{ HOVER_GATE_ATTR \} from '\.\/hover-motion-gate\.ts'/u)
  assert.match(ROWS, /if \(event\.currentTarget\.hasAttribute\(HOVER_GATE_ATTR\)\) return/u)
  assert.match(CARD, /import \{ HOVER_GATE_SELECTOR \} from '\.\/hover-motion-gate\.ts'/u)
  // 从锚点内部找门控行：FLIP 把行 transform 到旧位时事件目标可能是锚点自身，向上找会漏判。
  assert.match(CARD, /anchor\.querySelector\(HOVER_GATE_SELECTOR\) !== null\) return/u)
})

test('every row-level hover reveal carries the gate clause', () => {
  const required = [
    '.workspaceHeader:hover:not([data-hover-gate]),',
    '.sessionRow:hover:not([data-hover-gate]),',
    '.sessionRowsMore:hover:not([data-hover-gate]) {',
    '.workspaceHeader:hover:not([data-hover-gate]) .foldToggleFolder .foldChevron,',
    '.workspaceHeader:hover:not([data-hover-gate]) .foldToggleFolder .foldFolder,',
    '.workspaceHeader:hover:not([data-hover-gate]) .foldToggleGit .foldChevron,',
    '.workspaceHeader:hover:not([data-hover-gate]) .foldToggleGit .foldBranch,',
    '.workspaceHeader:hover:not([data-hover-gate]) [data-git-action],',
    '.workspaceHeader:hover:not([data-hover-gate]) [data-git-occupant],',
    '.workspaceHeader:hover:not([data-hover-gate]) .rowActions,',
    '.sessionRow:hover:not([data-hover-gate]) .rowActions {',
    '.workspaceHeader:hover:not([data-hover-gate]) [data-git-action]:disabled,',
    '.sessionRow:hover:not([data-hover-gate]) .sessionStateSlot,',
    '.sessionRow:hover:not([data-hover-gate]) .pinSlot,',
    '.workspaceHeader:hover:not([data-hover-gate]) .workspaceCount,',
    '.sessionRow:hover:not([data-hover-gate]) .sessionTitle {',
    '  .sessionRow:hover:not([data-hover-gate]) .sessionTitle,',
  ]
  for (const selector of required) assert.ok(CSS.includes(selector), `缺少门控条款：${selector}`)

  // 级联对拍：`:not([data-hover-gate])` 计一个额外伪类（揭示升到 (0,5,0)），重命名抑制的 hover
  // 半边必须带同一条款，否则被反超——改名中的字形仍会交换（合并后审计发现的真回归）。
  for (const selector of [
    '.workspaceRenaming:hover:not([data-hover-gate]) .foldToggleFolder .foldChevron,',
    '.workspaceRenaming:hover:not([data-hover-gate]) .foldToggleFolder .foldFolder,',
  ]) assert.ok(CSS.includes(selector), `重命名抑制缺少与揭示同级的门控条款：${selector}`)

  // 漂移锁：行级 :hover 选择器不得漏带条款（注释散文不算；半径 = src/client/**/*.css）。
  const offenders: string[] = []
  for (const { name, text } of CSS_SOURCES) {
    for (const raw of text.split('\n')) {
      const line = raw.trim()
      if (!line.endsWith('{') && !line.endsWith(',')) continue
      if (!/(?:\.workspaceHeader:hover|\.sessionRow:hover)/u.test(line)) continue
      if (line.includes(':not([data-hover-gate])')) continue
      if (line.includes('archiveManager') || line.includes('workspaceRenaming') || line.includes(':has(')) continue
      if (line.includes('ungroupedGroup')) continue
      offenders.push(name + ': ' + line)
    }
  }
  assert.deepEqual(offenders, [], '行级 :hover 揭示必须带 :not([data-hover-gate])')
})

test('the hover card keeps both dismiss paths (pointerdown and click-without-pointerdown)', () => {
  // vendor dismissFromAnchor 同时挂 pointerdown 与 click：不经过 pointerdown 的 click
  //（键盘激活、程序化 click）过去只靠 leave/宽限收卡。两条路径都必须是「按锚点收卡、
  // 卡片内部按压/点击不收卡」，否则 pointerleave-only 的失效面无法覆盖。
  const pointerDown = CARD.indexOf('onPointerDownCapture={(e) => {')
  const click = CARD.indexOf('onClickCapture={(e) => {')
  assert.ok(pointerDown !== -1, 'the pointerdown dismiss path exists')
  assert.ok(click !== -1, 'the click-without-pointerdown dismiss path exists')
  for (const at of [pointerDown, click]) {
    const guard = CARD.indexOf('cardRef.current?.contains(e.target as Node)', at)
    const press = CARD.indexOf('intent.press()', at)
    assert.ok(guard !== -1 && guard < press, 'a press inside the card (text selection) must stay mounted')
  }
})
