/**
 * Explicit user read fact → App correction arm clear (design 06 §4.9).
 *
 * The correction arm is an App-side display INFERENCE (hidden-shell mainView-retained
 * current row / facts-only per-row edges). The row-menu "mark read" is an explicit user
 * decision written to the Host's reading record; while the arm exists it keeps the dot
 * rendered, so without this path a mark on an arm-only row has no visible effect. The
 * sidebar reports the fact over chamberBridge after a successful mark; the App clears the
 * single row's arm (never a sweep) and re-steps through the same exit.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { chamberBridge } from '@dsh-chamber/dsh-chamber-client-core'
import { clearSessionArm, createCompletedStore } from '../../src/host/completed-store.ts'
import { stripComments } from '../../../../scripts/dev/test-support/source-text.ts'

test('clearSessionArm: row-keyed, idempotent, subscriber-visible', () => {
  const store = createCompletedStore()
  store.setSource('dsh-a', { s1: true, s2: true })
  store.setSource('dsh-b', { s9: true })
  let notifications = 0
  const unsubscribe = store.subscribe(() => { notifications += 1 })
  assert.equal(clearSessionArm(store, 'dsh-a', 's1'), true)
  assert.deepEqual(store.getSnapshot(), { 'dsh-a': { s2: true }, 'dsh-b': { s9: true } })
  assert.equal(notifications, 1)
  assert.equal(clearSessionArm(store, 'dsh-a', 's1'), false, 'idempotent: a duplicate mark is a no-op')
  assert.equal(notifications, 1, 'no store churn for a settled row')
  assert.equal(clearSessionArm(store, 'dsh-a', 'missing'), false)
  assert.equal(clearSessionArm(store, 'dsh-unknown', 's1'), false)
  unsubscribe()
})

test('chamberBridge: the explicit mark-read fact reaches App subscribers and unsubscribes', () => {
  const seen: string[] = []
  const unsubscribe = chamberBridge.onSessionMarkedRead((sourceId, sessionId, sourceFingerprint) => {
    seen.push(sourceId + '/' + sessionId + '/' + String(sourceFingerprint))
  })
  chamberBridge.reportSessionMarkedRead('dsh-a', 's1', 'fp-1')
  chamberBridge.reportSessionMarkedRead('local', 's2')
  unsubscribe()
  chamberBridge.reportSessionMarkedRead('dsh-b', 's3', 'fp-2')
  assert.deepEqual(seen, ['dsh-a/s1/fp-1', 'local/s2/undefined'],
    'one fan-out per report; the aggregate generation rides along; unsubscribe stops it')
})

test('a throwing mark-read subscriber never starves its siblings', () => {
  const original = console.error
  const errors: string[] = []
  console.error = ((...args: unknown[]) => { errors.push(args.map(String).join(' ')) }) as typeof console.error
  try {
    const seen: string[] = []
    const unsubscribeBad = chamberBridge.onSessionMarkedRead(() => { throw new Error('subscriber bug') })
    const unsubscribeGood = chamberBridge.onSessionMarkedRead(sourceId => { seen.push(sourceId) })
    chamberBridge.reportSessionMarkedRead('dsh-a', 's1')
    unsubscribeBad()
    unsubscribeGood()
    assert.deepEqual(seen, ['dsh-a'])
    assert.ok(errors.some(line => line.includes('session-marked-read listener failed')), 'the failure stays loud')
  } finally {
    console.error = original
  }
})

test('wiring: the notification hook turns the fact into the row-keyed arm clear', () => {
  const hook = stripComments(readFileSync(new URL('../../src/app-hooks/use-notifications.ts', import.meta.url), 'utf8'))
  assert.match(hook, /chamberBridge\.onSessionMarkedRead\(/)
  assert.match(hook, /clearSessionArm\(completedStore, sourceId, sessionId\)/)
  assert.match(hook, /stepCompletionArmFor\(sourceId\)/)
  // Generation fence: a late ack from a replaced aggregate generation must not clear the
  // new generation's arm.
  assert.match(hook, /chamberBridge\.getServers\(\)\.find\(server => server\.id === sourceId\)/u)
  assert.match(hook, /current\.sourceFingerprint !== sourceFingerprint/u)
  assert.match(hook, /import \{ clearSessionArm, type CompletedStore \}[\s\S]*?completed-store\.ts/u,
    'the clear goes through the CompletedStore helper module, not a raw snapshot write')
})
