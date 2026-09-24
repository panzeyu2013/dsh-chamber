/**
 * Run-scoped runtime-settlement adoption (A3): a settled runtime completion with no
 * host evidence may adopt the next facts completion ONLY when that facts row does not
 * postdate the host state the runtime edge already covered. The old session-scoped
 * marker swallowed a genuinely later run's banner.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { planFactsNotifications, type NotificationFactsRow } from '../../src/notification-projection.ts'

const row = (over: Partial<NotificationFactsRow> = {}): NotificationFactsRow => ({
  completedAt: 2_000,
  completedAtSource: 'observed',
  updatedAt: 1_000,
  subagentCount: 0,
  ...over,
})

const plan = (input: Omit<Parameters<typeof planFactsNotifications>[0], 'sourceFingerprint'>) =>
  planFactsNotifications({ sourceFingerprint: 'host-1', ...input })

test('a settled runtime edge adopts a facts completion that does not postdate its host anchor', () => {
  const adopted = plan({
    rows: { s1: row({ completedAt: 2_000, updatedAt: 1_000 }) },
    seeded: true,
    notifiedRuns: {},
    armed: new Set(['s1']),
    runtimeSettled: new Map([['s1', 1_700_000_000_000]]),
  })
  assert.deepEqual(adopted.edges, [], 'the anchored edge already covered this host state')
  assert.deepEqual(adopted.runs, { s1: 'chamber:host-1:0:s1:2000' })
})

test('a later completion behind an older anchor must notify, never be adopted', () => {
  const later = plan({
    rows: { s1: row({ completedAt: 1_700_000_060_000, updatedAt: 1_700_000_060_000 }) },
    seeded: true,
    notifiedRuns: {},
    armed: new Set(['s1']),
    runtimeSettled: new Map([['s1', 1_700_000_000_000]]),
  })
  assert.deepEqual(later.edges.map(edge => edge.sessionId), ['s1'],
    'a newer host state is a new run: it must notify')
})

test('the same run is adopted even when its completion time is later than its last message time', () => {
  // The runtime edge anchors on the host updatedAt (last durable message); the facts
  // completion carries a LATER completedAt. Comparing completedAt here re-notified a
  // completion whose banner the host had already receipted.
  const adopted = plan({
    rows: { s1: row({ updatedAt: 1_700_000_000_000, completedAt: 1_700_000_005_000 }) },
    seeded: true,
    notifiedRuns: {},
    armed: new Set(['s1']),
    runtimeSettled: new Map([['s1', 1_700_000_000_000]]),
  })
  assert.deepEqual(adopted.edges, [], 'same updatedAt = same run, whatever completedAt says')
})

test('a host-time-less anchor keeps the legacy session-scoped adoption', () => {
  const legacy = plan({
    rows: { s1: row() },
    seeded: true,
    notifiedRuns: {},
    armed: new Set(['s1']),
    runtimeSettled: new Map([['s1', undefined]]),
  })
  assert.deepEqual(legacy.edges, [], 'a runtime edge without host time still owns the next facts completion')
})

test('both run-start sites use the ordering rule, never an unconditional clear', () => {
  for (const file of ['app-hooks/use-bridge-subscriptions.ts', 'app-hooks/use-unread-notifications.ts']) {
    const source = readFileSync(fileURLToPath(new URL('../../src/' + file, import.meta.url)), 'utf8')
    assert.doesNotMatch(source, /observeRunStart\(|markRunStarted\(/,
      file + ' must not keep a second new-run authority beside planRuntimeNotifications')
    assert.doesNotMatch(source, /clearRuntimeSettled\(sourceId, (row\.sessionId|sessionId)\)/,
      file + ' must not drop a settled marker for a late running snapshot')
  }
})

test('a pending native delivery is never adopted, anchored or not', () => {
  const pending = plan({
    rows: { s1: row() },
    seeded: true,
    notifiedRuns: {},
    armed: new Set(['s1']),
    pendingSessions: new Set(['s1']),
    runtimeSettled: new Map([['s1', 1_700_000_000_000]]),
  })
  assert.deepEqual(pending.edges, [])
  assert.deepEqual(pending.runs, {})
})
