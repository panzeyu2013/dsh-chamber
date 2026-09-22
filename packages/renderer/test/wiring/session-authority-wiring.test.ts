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
  fileURLToPath(new URL('../../../dsh-chamber-client-ui-sidebar/src/shared/session-fact-reconcile.ts', import.meta.url)), 'utf8'))
const hook = stripComments(readFileSync(
  fileURLToPath(new URL('../../src/app-hooks/use-bridge-subscriptions.ts', import.meta.url)), 'utf8'))
const projection = stripComments(readFileSync(
  fileURLToPath(new URL('../../src/notification-projection.ts', import.meta.url)), 'utf8'))
const logStore = stripComments(readFileSync(
  fileURLToPath(new URL('../../../dsh-chamber-client-ui-sidebar/src/shared/authority-log-store.ts', import.meta.url)), 'utf8'))

test('the App has no second liveness planner or state machine', () => {
  assert.doesNotMatch(app, /planSessionLiveness|sessionLivenessRef|markSessionLiveness/)
  assert.match(app, /sessionAuthorityEscalationLadder\(LADDER_TABLES\.authority\)/)
  assert.match(app, /planLadder\(/)
  assert.match(app, /chamberBridge\.requestSessionListRefresh\(id\)/, 'the tick drives the executor')
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
  assert.match(app, /planFactsNotifications\(/)
  assert.doesNotMatch(app, /shouldNotifyWatermark|nextNotifiedWatermark/)
  assert.match(projection, /export function planRuntimeNotifications/)
  assert.match(projection, /export function planFactsNotifications/)
})

test('the retained-view unverified-running arm stays wired (design 05)', () => {
  assert.ok(app.includes('shouldDropUnverifiedRunningFacts('), 'the 90s bound must stay wired to the drop decision')
  assert.ok(app.includes('...new Set([...stalledSources, ...unverifiedSources])'), 'both banner sources share one visible set')
  assert.ok(app.includes('unverified: unverifiedSourcesRef.current.includes(sourceId)'), 'the report must mark unverified sources')
})

test('the escalation ladder gates both levers on stuck evidence', () => {
  assert.match(app, /stuckEvidence: authority\?\.stuckSince !== undefined/)
  assert.match(app, /escalationBlocked:/)
})
