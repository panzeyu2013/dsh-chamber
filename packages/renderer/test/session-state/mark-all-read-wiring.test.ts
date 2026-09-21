/**
 * W4「全部已读」App 侧锁：读水位与落盘在 App（唯一权威），插件只发意图。
 * 本用例既**行为验证**算法（源级上界 + 单调提升），又锁住接线点，
 * 使「点全部已读」不会退化成只清 UI 的假动作。
 *
 * Run directly: node test/session-state/mark-all-read-wiring.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { advanceReadMark, maxWatermark } from '../../src/unread-store.ts'

const APP = readFileSync(fileURLToPath(new URL('../../src/App.tsx', import.meta.url)), 'utf8')
// 阶段 3：onMarkAllRead 订阅随桥订阅簇移到 hook —— 通道锁钉在最终落点；handler
// 本体（水位上界/落盘/镜像/重算）仍在 App，继续读 APP。
const BRIDGE = readFileSync(
  fileURLToPath(new URL('../../src/app-hooks/use-bridge-subscriptions.ts', import.meta.url)),
  'utf8',
)

test('the source-wide bound is max(updatedAt, completedAt) over the rows', () => {
  assert.equal(maxWatermark({}), 0)
  assert.equal(maxWatermark({ a: { updatedAt: 5, completedAt: null }, b: { updatedAt: 3, completedAt: 9 } }), 9)
  assert.equal(maxWatermark({ a: { updatedAt: 0, completedAt: null } }), 0, '0/absent rows contribute nothing')
})

test('raising every session mark to the bound is monotonic and never regresses', () => {
  const rows = { a: { updatedAt: 100, completedAt: null }, b: { updatedAt: 40, completedAt: 900 } }
  const through = maxWatermark(rows)
  assert.equal(through, 900)
  const table: Record<string, number> = { a: 500 }
  const next: Record<string, number> = { ...table }
  for (const sessionId of Object.keys(rows)) {
    next[sessionId] = advanceReadMark(next[sessionId], through) ?? through
  }
  assert.equal(next.a, 900, 'existing mark advances to the bound')
  assert.equal(next.b, 900, 'missing mark becomes the bound')
  // 第二次执行不改变任何值（幂等），且绝不低于既有读数。
  assert.equal(advanceReadMark(next.a, through), 900)
  assert.equal(advanceReadMark(next.a, 100), 900, 'a smaller watermark can never pull a mark back down')
})

test('the App handler uses the bound, persists, notifies the mirror and recomputes', () => {
  assert.match(APP, /const through = maxWatermark\(rows\)/)
  // 没有可用水位就什么都不做（绝不写凭空的已读读数）。
  assert.match(APP, /if \(through <= 0\) return/)
  assert.match(APP, /next\[sessionId\] = advanceReadMark\(next\[sessionId\], through\) \?\? through/)
  assert.match(APP, /readMarksRef\.current = \{ \.\.\.readMarksRef\.current, \[sourceId\]: next \}[\s\S]{0,200}?schedulePersistUnread\(\)/)
  assert.match(APP, /ackAllRead\(clientInstallIdRef\.current, through\)/)
  assert.match(APP, /recomputeSourceUnread\(sourceId\)/)
  // 请求通道：与 openSession 同一条桥纪律（mount 订阅、卸载取消）。
  assert.match(BRIDGE, /chamberBridge\.onMarkAllRead\(\(\{ sourceId \}\) => \{\s*markSourceAllRead\(sourceId\)/)
})
