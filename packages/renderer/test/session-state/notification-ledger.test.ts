/**
 * I3/I4 仪器锁（plan §10；`notes/residual-verifiability-review.md` §5-I3/I4）：
 * 徽标计数必须可回读、通知的**每一个决定**（含"没有桥"这次）必须可查，且账本记的是
 * **主进程回执**而不是"我们调用了通知"——R6/R3 的负断言只有配上同一次运行内的正对照
 * 才有意义，而正对照要求看见主进程的诚实结果。
 *
 * Run directly: node test/session-state/notification-ledger.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  createNotificationLedger,
  publishBadgeCount,
  publishNotificationInstrument,
} from '../../src/notification-ledger.ts'

const APP = readFileSync(fileURLToPath(new URL('../../src/App.tsx', import.meta.url)), 'utf8')
const APP_LINES = APP.split('\n')
// 阶段 3：徽标推送 effect 簇已抽为命名 hook；锁钉在其最终落点（意图不变，只是位置
// 从 App.tsx 移到 hook——App 内不可渲染测试，hook 的行为由窗口桥面在真机验证）。
const BADGE_HOOK = readFileSync(
  fileURLToPath(new URL('../../src/app-hooks/use-badge-count.ts', import.meta.url)),
  'utf8',
)

function entry(decision: 'sent' | 'suppressed' | 'skipped', extra: Partial<Record<string, unknown>> = {}) {
  return { at: 1, sourceId: 'local', sessionId: 's1', kind: 'complete', requireHidden: false, decision, ...extra } as never
}

test('the ledger counts decisions and is bounded, and its snapshots are copies', () => {
  const ledger = createNotificationLedger({ limit: 3 })
  ledger.record(entry('sent'))
  ledger.record(entry('suppressed', { error: 'duplicate' }))
  ledger.record(entry('skipped', { error: 'no-notification-bridge' }))
  ledger.record(entry('sent'))
  assert.deepEqual(ledger.counts(), { sent: 2, suppressed: 1, skipped: 1 })
  assert.equal(ledger.total(), 4, 'counters count every decision even when entries evict')
  assert.equal(ledger.entries().length, 3)
  assert.equal(ledger.entries()[0].error, 'duplicate', 'oldest entry evicted')
  const counts = ledger.counts()
  counts.sent = 99
  assert.equal(ledger.counts().sent, 2, 'counters snapshot is a copy')
})

test('the instruments publish once and stay live views', () => {
  const host: Record<string, unknown> = {}
  publishNotificationInstrument(host)
  const first = host.__dshChamberNotifications
  publishNotificationInstrument(host)
  assert.equal(host.__dshChamberNotifications, first, 'idempotent')
  publishBadgeCount(7, host)
  assert.equal(host.__dshChamberBadgeCount, 7)
  const instrument = first as { counts(): { sent: number } }
  assert.equal(typeof instrument.counts(), 'object')
})

test('the badge hook publishes the dispatched count next to the projection', () => {
  assert.match(BADGE_HOOK, /const count = projectBadgeCount\(completedBySource, runtimeFacts\)[\s\S]{0,220}?publishBadgeCount\(count\)/)
})

test('every notification decision is recorded — including the no-bridge case', () => {
  assert.match(APP, /if \(bridge === undefined\) \{[\s\S]{0,600}?decision: 'skipped'[\s\S]{0,200}?no-notification-bridge/)
  assert.match(APP, /decision: result\.shown \? 'sent' : 'suppressed'/)
  assert.match(APP, /catch\(err => \{[\s\S]{0,300}?decision: 'skipped'/)
  assert.match(APP, /publishNotificationInstrument\(\)/)
})

test('the ledger records the MAIN-PROCESS result, and notify is still called exactly once', () => {
  // 账本读的是回执（shown/error），不是"调用了"。
  assert.doesNotMatch(APP, /notificationLedger\.record\(\{\s*\.\.\.ledgerBase,\s*decision: 'sent' \}\)/)
  // 单组装点锁（与 WS-C 的 L6/L7 同一条）：去掉注释行后 bridge.notify( 只出现一次。
  // 注释行两种形态都要剔除：行注释 `//` 与块注释体 `*`（文档注释里也会提到这个调用）。
  const calls = APP_LINES.filter(line => {
    const trimmed = line.trimStart()
    return !trimmed.startsWith('//') && !trimmed.startsWith('*') && line.includes('bridge.notify(')
  })
  assert.equal(calls.length, 1, calls.join(' | '))
})
