/**
 * R8 意图预热**侧栏侧**接线锁（plan R8 / switch blueprint §4）。
 *
 * 行为面：`chamberBridge.requestIntentPrewarm` 必须真的到达 App 层订阅者，
 * 且取消订阅后不再投递（与 W4「全部已读」同一条桥纪律）。
 * 接线面（源码文本锁）：来源头部是本版**唯一**的意图触点——pointerenter/leave
 * 驱动 120ms dwell 机器，点击/键盘/拖动消费本次 hover 周期，`onIntent` 只把
 * 来源 id 交给 chamberBridge（挂载/排队/计费一律不在侧栏）。
 * 范围注记（blueprint §4.1）：会话行 hover 暂不接入——第一版只做来源头，避免
 * 与行菜单/拖拽的指针语义冲突；因此这里断言本文件只有一个 createPrewarmIntent
 * 调用点，新增触点必须带着决定来改这份锁。
 *
 * Run directly: node test/session-rows/prewarm-intent-wiring.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
const SECTION = read('../../src/client/ServerSection.tsx')

test('the bridge channel carries the intent to App-layer subscribers and unsubscribes cleanly', async () => {
  const { chamberBridge } = await import('../../src/shared/aggregate-store.ts')
  const seen: string[] = []
  const unsubscribe = chamberBridge.onIntentPrewarm(({ sourceId }) => { seen.push(sourceId) })
  chamberBridge.requestIntentPrewarm('ssh-a')
  chamberBridge.requestIntentPrewarm('local')
  assert.deepEqual(seen, ['ssh-a', 'local'])
  unsubscribe()
  chamberBridge.requestIntentPrewarm('ssh-b')
  assert.deepEqual(seen, ['ssh-a', 'local'], '取消订阅后不再投递')
})

test('the source header is the one and only intent touchpoint, driven by pointer enter/leave', () => {
  assert.match(SECTION, /import \{ createPrewarmIntent, type PrewarmIntent \} from '\.\.\/shared\/prewarm-intent\.ts'/)
  assert.equal((SECTION.match(/createPrewarmIntent\(/g) ?? []).length, 1, 'one machine per source header; session rows are out of scope for R8 v1')
  assert.match(SECTION, /const prewarmIntentRef = useRef<PrewarmIntent \| null>\(null\)/)
  assert.match(SECTION, /onPointerEnter=\{\(\) => \{ prewarmIntent\(\)\.enter\(\) \}\}/)
  assert.match(SECTION, /onPointerLeave=\{\(\) => \{ prewarmIntent\(\)\.leave\(\) \}\}/)
})

test('onIntent only asks the App — it never mounts, opens or prewarms anything itself', () => {
  assert.match(SECTION, /onIntent: \(\) => \{ chamberBridge\.requestIntentPrewarm\(server\.id\) \}/)
  const factory = /const prewarmIntent = \(\): PrewarmIntent => \{[\s\S]*?\n  \}/.exec(SECTION)
  assert.ok(factory, 'the lazy machine factory must exist')
  assert.doesNotMatch(factory[0], /chamberBridge\.(requestActivateSource|requestOpenSession)/, 'the intent callback is not an open request')
})

test('a click, a keyboard activation and a drag all consume the hover cycle (press)', () => {
  const click = /onClick=\{\(\) => \{[\s\S]{0,400}?prewarmIntent\(\)\.press\(\)[\s\S]{0,200}?if \(suppressClickRef\.current\) return/.exec(SECTION)
  assert.ok(click, 'the header click presses the intent machine before the activation path')
  const key = /event\.key === 'Enter' \|\| event\.key === ' '[\s\S]{0,300}?prewarmIntent\(\)\.press\(\)[\s\S]{0,200}?chamberBridge\.requestActivateSource\(server\.id\)/.exec(SECTION)
  assert.ok(key, 'Enter/Space presses the machine and then activates through the existing path')
  const drag = /onDragStart=\{\(event\) => \{[\s\S]{0,300}?prewarmIntent\(\)\.press\(\)/.exec(SECTION)
  assert.ok(drag, 'starting a header drag (reorder, not navigation) consumes the cycle')
})

test('unmount disposes the machine AND clears the ref (StrictMode effect re-run stays armed)', () => {
  const cleanup = /useEffect\(\(\) => \(\) => \{[\s\S]{0,200}?prewarmIntentRef\.current\?\.dispose\(\)[\s\S]{0,120}?prewarmIntentRef\.current = null\s*\n  \}, \[\]\)/.exec(SECTION)
  assert.ok(cleanup, 'dispose alone is not enough: a disposed machine left in the ref would silently kill hover after a StrictMode remount')
})
