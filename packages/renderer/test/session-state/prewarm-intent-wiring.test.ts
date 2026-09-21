/**
 * R8 意图预热 **App 侧**锁（plan R8 / switch blueprint §4.2–§4.4）。
 *
 * 行为面：hover 意图到达 App 后**真的改变既有选取逻辑的结果**——重排后的队列
 * 让 `pickPrewarmTarget`（baseline-harvest.ts，未改一行）先选中被悬停的来源；
 * 被抑制/不可用的来源连重排都进不去，收割预留原样压过意图。
 * 接线面（源码文本锁）：订阅 `chamberBridge.onIntentPrewarm` 的 effect、卸载
 * 取消、先过 `prewarmEligibleRef` 门、把意图喂给既有队列后调既有 drain；计费
 * 发生在既有 drain 真正选中该来源的那一刻；意图 handler **绝不**触碰
 * `prewarmSuppressedRef`（用户明确点开仍走 selectView 原路）。
 *
 * Run directly: node test/session-state/prewarm-intent-wiring.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { pickPrewarmTarget } from '../../src/baseline-harvest.ts'
import {
  emptyIntentPrewarmBudget,
  intentPrewarmAllowed,
  intentPrewarmSpent,
  prioritizePrewarmSource,
} from '../../../dsh-chamber-client-ui-sidebar/src/shared/prewarm-intent.ts'

const APP = readFileSync(fileURLToPath(new URL('../../src/App.tsx', import.meta.url)), 'utf8')

/** The one subscription effect: from `useEffect(() => {` through its `}, [])`. */
const intentEffect = (): string => {
  const match = /useEffect\(\(\) => \{\s*const unsubscribe = chamberBridge\.onIntentPrewarm\(\(\{ sourceId \}\) => \{[\s\S]*?\n  \}, \[\]\)/.exec(APP)
  assert.ok(match, 'App.tsx must subscribe to chamberBridge.onIntentPrewarm in its own effect')
  return match[0]
}

const NO_HARVEST = (): boolean => false
const DUE = (): boolean => true

test('a hover intent changes what the EXISTING pick logic selects next (re-order, nothing else)', () => {
  const queue = ['a', 'b']
  const eligible = new Set(['a', 'b'])
  assert.equal(pickPrewarmTarget(queue, eligible, NO_HARVEST, DUE), 'a', 'seeding order decides by default')
  const prioritized = prioritizePrewarmSource(queue, 'b', eligible)
  assert.equal(pickPrewarmTarget(prioritized, eligible, NO_HARVEST, DUE), 'b', 'the hovered source wins the slot')
  assert.deepEqual(prioritized, ['b', 'a'], 're-order only — no id added, none dropped')
})

test('a suppressed/reclaimed source is never reordered, so no boot can follow the hover', () => {
  // prewarmSuppressedRef filters ids out of warmIds ⇒ absence from the eligible
  // set is exactly how the App-side discipline reaches this pure function.
  const eligible = new Set(['a', 'b'])
  const queue = ['a', 'b']
  assert.equal(prioritizePrewarmSource(queue, 'reclaimed', eligible), queue)
  // And even a stale queue entry for an ineligible id is not selectable.
  assert.equal(pickPrewarmTarget(['reclaimed', 'a'], eligible, NO_HARVEST, DUE), 'a')
})

test('the harvest reservation still outranks an intent: pending harvest ids are the only eligible ones', () => {
  // While any harvest candidate is pending, prewarmCandidates returns ONLY that
  // id, so the eligible set the intent re-orders against holds no warm source.
  const eligible = new Set(['harvest-1'])
  const reordered = prioritizePrewarmSource(['harvest-1'], 'warm-a', eligible)
  assert.deepEqual(reordered, ['harvest-1'], 'nothing to reorder — baseline recovery keeps the slot')
  assert.equal(
    pickPrewarmTarget(reordered, eligible, id => id === 'harvest-1', DUE),
    'harvest-1',
    'the harvest leg of the existing pick is untouched',
  )
})

test('the budget bills only boots that start; later intents wait for the cooldown and the per-source once', () => {
  let budget = emptyIntentPrewarmBudget()
  assert.equal(intentPrewarmAllowed(budget, 'a', 0), true)
  budget = intentPrewarmSpent(budget, 'a', 0)
  assert.equal(intentPrewarmAllowed(budget, 'b', 59_999), false, '60s cooldown between billed boots')
  assert.equal(intentPrewarmAllowed(budget, 'b', 60_000), true)
  budget = intentPrewarmSpent(budget, 'b', 60_000)
  assert.equal(intentPrewarmAllowed(budget, 'c', 120_001), false, 'two intent boots per session is the cap')
  assert.equal(intentPrewarmAllowed(emptyIntentPrewarmBudget(), 'a', 0), true, 'the ledger is per session, not global')
})

test('the App subscribes to the intent channel, gates it, feeds the existing queue and unsubscribes', () => {
  const effect = intentEffect()
  assert.match(effect, /return unsubscribe/)
  assert.match(effect, /if \(!prewarmEligibleRef\.current\.has\(sourceId\)\) return/, 'the existing eligibility gate comes first')
  assert.match(effect, /if \(!intentPrewarmAllowed\(intentBudgetRef\.current, sourceId, now\)\) return/)
  assert.match(
    effect,
    /prewarmQueueRef\.current = prioritizePrewarmSource\(\s*prewarmQueueRef\.current,\s*sourceId,\s*prewarmEligibleRef\.current,?\s*\)/,
    'the intent is handed to the EXISTING queue, not a new prewarm implementation',
  )
  assert.match(effect, /drainPrewarmRef\.current\(\)/, 'the existing drain decides whether anything boots')
})

test('the intent never clears the retention suppression — a reclaimed source is not re-booted by a hover', () => {
  const effect = intentEffect()
  assert.doesNotMatch(effect, /prewarmSuppressedRef/, 'explicit user intent (selectView) is the only suppression clearer')
  // The user-click path still owns it, unchanged.
  assert.match(APP, /prewarmSuppressedRef\.current\.delete\(viewId\)/)
})

test('the intent boot is billed exactly where the existing drain lands on a prioritised source', () => {
  assert.match(
    APP,
    /if \(intentPriorityRef\.current\.delete\(next\)\) \{\s*intentBudgetRef\.current = intentPrewarmSpent\(intentBudgetRef\.current, next, now\)\s*\}/,
  )
})

test('the stale priority keys are pruned when a source stops being eligible', () => {
  assert.match(APP, /for \(const id of \[\.\.\.intentPriorityRef\.current\]\) \{\s*if \(!eligible\.has\(id\)\) intentPriorityRef\.current\.delete\(id\)\s*\}/)
})
