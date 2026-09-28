/**
 * The page's scheduling record (design 14 §D4). A rAF heartbeat is the only in-page
 * evidence that the page is being scheduled at all: WebKit throttles an unfocused or
 * occluded WKWebView while \`document.visibilityState\` still says \`visible\`, and these
 * tests pin the conservative rules every liveness deadline relies on.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  PAGE_SCHEDULE_GAP_MS,
  hadSchedulingGap,
  noteFocus,
  notePageTick,
  noteVisibility,
  pageScheduleSnapshot,
  resetPageScheduleForTests,
  startPageScheduleProbe,
} from '../../../dsh-chamber-client-core/src/page-schedule.ts'

test('a healthy cadence is not a gap', () => {
  resetPageScheduleForTests()
  for (let at = 1_000; at <= 5_000; at += 16) notePageTick(at)
  assert.equal(hadSchedulingGap(2_000, 5_000, 5_000), false)
  assert.equal(pageScheduleSnapshot().lastGap, null)
})

test('a tick gap overlapping the window is positive evidence', () => {
  resetPageScheduleForTests()
  notePageTick(1_000)
  notePageTick(5_000) // 4s of silence: throttled or suspended
  assert.equal(PAGE_SCHEDULE_GAP_MS <= 4_000, true)
  assert.equal(hadSchedulingGap(2_000, 5_000, 5_000), true)
  assert.deepEqual(pageScheduleSnapshot().lastGap, { from: 1_000, to: 5_000 })
})

test('silence across the whole window counts even without a recorded gap', () => {
  resetPageScheduleForTests()
  notePageTick(1_000)
  assert.equal(hadSchedulingGap(2_000, 6_000, 6_500), true)
})

test('an unfocused window is positive evidence', () => {
  resetPageScheduleForTests()
  notePageTick(10_000)
  noteFocus(false)
  assert.equal(hadSchedulingGap(9_000, 10_000, 10_000), true)
  noteFocus(true)
  assert.equal(hadSchedulingGap(9_000, 10_000, 10_000), false)
})

test('a hidden document is positive evidence', () => {
  resetPageScheduleForTests()
  notePageTick(10_000)
  noteVisibility(false)
  assert.equal(hadSchedulingGap(9_000, 10_000, 10_000), true)
})

test('no evidence never claims a gap (unknown must not excuse a failure)', () => {
  resetPageScheduleForTests()
  assert.equal(hadSchedulingGap(1_000, 2_000, 2_000), false)
  assert.equal(pageScheduleSnapshot().lastTickAt, null)
})

test('the entry installs the probe behind the marker a build gate can prove', () => {
  // 入口丢这一行 ⇒ hadSchedulingGap 永远「无证据」⇒ D4 证据有效性层整体静默失效（审计低2）。
  // 锚定赋值是故意的：esbuild 不改点号属性名，压缩产物里留下
  // globalThis.__chamberPageScheduleInstalled=<压缩后标识符>()，与 SVG scoper 的产物门同款
  // （main.tsx 的注释即该契约；裸调用会被改名，产物守卫恒红）。
  assert.equal(typeof startPageScheduleProbe, 'function', 'the installer must stay exported')
  const main = readFileSync(fileURLToPath(new URL('../../src/main.tsx', import.meta.url)), 'utf8')
  assert.match(main, /import\s*\{[^}]*\bstartPageScheduleProbe\b[^}]*\}\s*from/u, 'the entry must import the installer')
  assert.match(main, /\.__chamberPageScheduleInstalled\s*=\s*startPageScheduleProbe\(\)/u,
    'the marker must be assigned the install call itself: a rename or a bare call breaks the artifact marker')
})
