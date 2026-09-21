/**
 * I8 预热命中率仪表锁（plan §7-W3 判据「预热命中率 ≥80%」/§10）：
 * 三个事件的定义与计数必须可查，且**没有尝试时不臆造 100%**。纯函数 + 源文本锁。
 *
 * Run directly: node test/session-state/prewarm-ledger.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createPrewarmLedger, publishPrewarmInstrument } from '../../src/prewarm-ledger.ts'

const APP = readFileSync(fileURLToPath(new URL('../../src/App.tsx', import.meta.url)), 'utf8')
// 阶段 3：drainPrewarm 已平移到视图调度 hook —— attempt 锚点钉在最终落点；
// hit（selectView）与 cancelled（retireSources）仍在 App，继续读 APP。
const SCHEDULER = readFileSync(
  fileURLToPath(new URL('../../src/app-hooks/use-view-scheduler.ts', import.meta.url)),
  'utf8',
)

test('the ledger counts per source and computes the documented hit rate', () => {
  const ledger = createPrewarmLedger()
  assert.equal(ledger.hitRate(), 0, 'no attempts ⇒ 0, never a fabricated 100%')
  ledger.record('attempt', 'a')
  ledger.record('attempt', 'a')
  ledger.record('attempt', 'b')
  ledger.record('hit', 'a')
  ledger.record('cancelled', 'b')
  assert.deepEqual(ledger.counters().a, { attempts: 2, hits: 1, cancelled: 0 })
  assert.deepEqual(ledger.counters().b, { attempts: 1, hits: 0, cancelled: 1 })
  assert.deepEqual(ledger.totals(), { attempts: 3, hits: 1, cancelled: 1 })
  assert.equal(ledger.hitRate(), 1 / 3)
  assert.equal(ledger.counters().a.attempts, 2)
  const snapshot = ledger.counters()
  snapshot.a.attempts = 99
  assert.equal(ledger.counters().a.attempts, 2, 'snapshot is a copy')
})

test('the instrument publishes once and stays live', () => {
  const host: Record<string, unknown> = {}
  publishPrewarmInstrument(host)
  const first = host.__dshChamberPrewarm
  publishPrewarmInstrument(host)
  assert.equal(host.__dshChamberPrewarm, first, 'idempotent')
  const instrument = first as { hitRate(): number; totals(): { attempts: number } }
  assert.equal(typeof instrument.hitRate(), 'number')
  assert.equal(typeof instrument.totals().attempts, 'number')
})

test('App records attempt/hit/cancelled at the three real anchors', () => {
  // attempt：后台挂载真的开始（加入 autoPrewarmed 之后、mountedViews 之前）。
  assert.match(SCHEDULER, /autoPrewarmedRef\.current\.add\(next\)[\s\S]{0,200}?recordPrewarm\('attempt', next\)/)
  // hit：删除集合成员**之前**判定（此刻它仍是自动预热态）。
  assert.match(APP, /if \(autoPrewarmedRef\.current\.has\(viewId\)\) recordPrewarm\('hit', viewId\)\n\s*autoPrewarmedRef\.current\.delete\(viewId\)/)
  // cancelled：在途预热随来源退役作废。
  assert.match(APP, /retired\.has\(prewarmInflightRef\.current\)\) \{[\s\S]{0,200}?recordPrewarm\('cancelled', prewarmInflightRef\.current\)/)
})
