/**
 * P2 wiring lock: the session-fact authority has exactly ONE policy owner (the pure
 * package) and one executor; the App holds no second planner/state machine.
 *
 * These are source-text locks, not behavior tests: the behavior lives in
 * packages/dsh-stream-state/test/authority/ and the executor's own suite. They exist
 * to make "a new repair function at the symptom layer" fail loudly.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { stripComments } from '../../../../scripts/dev/test-support/source-text.ts'

const app = stripComments(readFileSync(fileURLToPath(new URL('../../src/App.tsx', import.meta.url)), 'utf8'))
const sidebar = stripComments(readFileSync(
  fileURLToPath(new URL('../../../dsh-chamber-client-ui-sidebar/src/client/index.ts', import.meta.url)), 'utf8'))
const executor = stripComments(readFileSync(
  fileURLToPath(new URL('../../../dsh-chamber-client-core/src/session-fact-reconcile.ts', import.meta.url)), 'utf8'))
const hook = stripComments(readFileSync(
  fileURLToPath(new URL('../../src/app-hooks/use-bridge-subscriptions.ts', import.meta.url)), 'utf8'))
// 事实第二入口（planFactsNotifications）与升级 ladder 的执行端已随
// 通知/未读投影簇、聚合刷新簇抽到命名 hook；锁跨 App + 两个 hook 取并集
// （presence/absence 都不放松）。
const unreadHook = stripComments(readFileSync(
  fileURLToPath(new URL('../../src/app-hooks/use-unread-notifications.ts', import.meta.url)), 'utf8'))
const aggregateHook = stripComments(readFileSync(
  fileURLToPath(new URL('../../src/app-hooks/use-aggregate-refresh.ts', import.meta.url)), 'utf8'))
const factsHook = stripComments(readFileSync(
  fileURLToPath(new URL('../../src/app-hooks/use-session-facts-lifecycle.ts', import.meta.url)), 'utf8'))
const frame = app + '\n' + unreadHook + '\n' + aggregateHook + '\n' + factsHook
const projection = stripComments(readFileSync(
  fileURLToPath(new URL('../../src/notification-projection.ts', import.meta.url)), 'utf8'))
const logStore = stripComments(readFileSync(
  fileURLToPath(new URL('../../../dsh-chamber-client-core/src/authority-log-store.ts', import.meta.url)), 'utf8'))

test('the App has no second liveness planner or state machine', () => {
  assert.doesNotMatch(frame, /planSessionLiveness|sessionLivenessRef|markSessionLiveness/)
  assert.match(frame, /sessionAuthorityEscalationLadder\(LADDER_TABLES\.authority\)/)
  assert.match(frame, /planLadder\(/)
  assert.match(frame, /chamberBridge\.requestSessionListRefresh\(id\)/, 'the tick drives the executor')
})

test('the producer executes the one authority reducer + probe ladder', () => {
  assert.match(sidebar, /new SessionAuthorityReconciler\(/)
  assert.match(sidebar, /readOfficial: readOfficialProjection/)
  assert.match(sidebar, /readAuthority: readAuthorityRunning/)
  assert.match(sidebar, /correct: correctAuthorityRunning/)
  assert.match(executor, /reduceSessionAuthority\(/)
  assert.match(executor, /sessionAuthorityProbeLadder\(LADDER_TABLES\.authority\)/)
  assert.doesNotMatch(executor, /maxAttempts|verifyTimeoutMs|SESSION_FACT_RECONCILE_DEFAULTS/)
})

test('the write-back only ever writes false, behind the capability guard', () => {
  assert.match(sidebar, /service\.handleSessionStatus\(id, false\)/)
  assert.doesNotMatch(sidebar, /handleSessionStatus\([^)]*true[^)]*\)/)
  assert.match(sidebar, /typeof service\.handleSessionStatus !== 'function'/)
})

test('authority actions persist to the machine-local ring (P5)', () => {
  assert.match(sidebar, /appendAuthorityLog\(storage, chamberInstanceId, entry\)/)
  assert.match(sidebar, /authorityLogStorage\(\)/)
  assert.match(logStore, /AUTHORITY_LOG_KEY = 'dsh-chamber\.authority-log\.v1'/)
  assert.match(logStore, /AUTHORITY_LOG_MAX_PER_SOURCE = 32/)
})

test('completion notifications have one policy entry (P3)', () => {
  assert.match(hook, /planRuntimeNotifications\(/)
  assert.doesNotMatch(hook, /detectNotificationEdges|dedupeCompleteEdges/)
  assert.match(frame, /planFactsNotifications\(/)
  assert.doesNotMatch(frame, /shouldNotifyWatermark|nextNotifiedWatermark/)
  assert.match(projection, /export function planRuntimeNotifications/)
  assert.match(projection, /export function planFactsNotifications/)
})

test('the notification association uses the facts host anchor, never the content watermark', () => {
  // The outbox associates a pending runtime edge with a facts completion through the
  // host `updatedAt` BOTH sides carry. Passing the content watermark (completedAt ??
  // updatedAt) as that anchor was the double-banner defect; the API now requires the
  // anchor object, and this lock pins the one caller's value and its single call.
  assert.match(unreadHook, /hostUpdatedAt: row\.updatedAt/)
  assert.match(unreadHook, /associateCompletion\(\s*\n?\s*sourceId, lifecycle\.fingerprint, row\.sessionId, observed,/)
  assert.match(unreadHook, /pendingSessions\.add\(row\.sessionId\)/)
})

test('the retained-view unverified-running arm stays wired (design 05)', () => {
  assert.ok(frame.includes('shouldDropUnverifiedRunningFacts('), 'the 90s bound must stay wired to the drop decision')
  assert.ok(frame.includes('...new Set([...stalledSources, ...unverifiedSources])'), 'both banner sources share one visible set')
  assert.ok(frame.includes('unverified: unverifiedSourcesRef.current.includes(sourceId)'), 'the report must mark unverified sources')
})

test('the escalation ladder gates both levers on stuck evidence', () => {
  assert.match(frame, /stuckEvidence: authority\?\.stuckSince !== undefined/)
  assert.match(frame, /escalationBlocked:/)
})
