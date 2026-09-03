import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shouldReconnectStaleMounted } from '../src/aggregate-refresh.ts'

// ---- shouldReconnectStaleMounted (S2: watchdog reconnect of stale MOUNTED
// sources — 对齐 ssh 断链自动恢复; see aggregate-refresh.ts). The predicate
// takes `mounted` as a CALLER-DEFINED flag (the App passes "pushed at least
// once this generation"); these tests exercise the pure predicate with
// explicit values. The App wiring (transport-axis filter, record-then-fire,
// backoff recording only on an actual reconnect) is not unit-tested here —
// see shell.ts reconnectInstanceConnection and the App.tsx watchdog. ----

const STALENESS_MS = 30_000
const BACKOFF_MS = 60_000
const NOW = 1_000_000

function decide(partial: {
  mounted?: boolean
  lastSnapshotAt?: number | undefined
  lastReconnectAt?: number | undefined
  now?: number
  stalenessMs?: number
  reconnectBackoffMs?: number
}): boolean {
  return shouldReconnectStaleMounted({
    mounted: partial.mounted ?? true,
    lastSnapshotAt: partial.lastSnapshotAt,
    lastReconnectAt: partial.lastReconnectAt,
    now: partial.now ?? NOW,
    stalenessMs: partial.stalenessMs ?? STALENESS_MS,
    reconnectBackoffMs: partial.reconnectBackoffMs ?? BACKOFF_MS,
  })
}

test('shouldReconnectStaleMounted: unmounted sources never reconnect (no shell connection to restart — unary fallback owns them)', () => {
  assert.equal(decide({ mounted: false, lastSnapshotAt: undefined }), false)
  assert.equal(decide({ mounted: false, lastSnapshotAt: NOW - STALENESS_MS - 1 }), false)
  // Even with the backoff fully elapsed an unmounted source is excluded.
  assert.equal(decide({ mounted: false, lastSnapshotAt: NOW - STALENESS_MS - 1, lastReconnectAt: NOW - BACKOFF_MS - 1 }), false)
})

test('shouldReconnectStaleMounted: a mounted source that never pushed is stale and reconnectable', () => {
  assert.equal(decide({ lastSnapshotAt: undefined }), true)
})

test('shouldReconnectStaleMounted: a recent push keeps the source fresh (no reconnect)', () => {
  assert.equal(decide({ lastSnapshotAt: NOW - 1 }), false)
  // Exactly at the staleness threshold is still fresh (isSnapshotStale is strict).
  assert.equal(decide({ lastSnapshotAt: NOW - STALENESS_MS }), false)
})

test('shouldReconnectStaleMounted: silence past the threshold reconnects when no attempt is recorded', () => {
  assert.equal(decide({ lastSnapshotAt: NOW - STALENESS_MS - 1, lastReconnectAt: undefined }), true)
})

test('shouldReconnectStaleMounted: a recent reconnect holds off the next attempt (backoff window)', () => {
  assert.equal(decide({ lastSnapshotAt: NOW - STALENESS_MS - 1, lastReconnectAt: NOW - 1 }), false)
  assert.equal(decide({ lastSnapshotAt: NOW - STALENESS_MS - 1, lastReconnectAt: NOW - BACKOFF_MS + 1 }), false)
})

test('shouldReconnectStaleMounted: the backoff elapses at the boundary and reconnects resume', () => {
  assert.equal(decide({ lastSnapshotAt: NOW - STALENESS_MS - 1, lastReconnectAt: NOW - BACKOFF_MS }), true)
  assert.equal(decide({ lastSnapshotAt: NOW - STALENESS_MS - 1, lastReconnectAt: NOW - BACKOFF_MS - 1 }), true)
})

test('shouldReconnectStaleMounted: a fresh push after a reconnect clears staleness before the backoff matters', () => {
  // The reconnect healed the push channel: a new snapshot arrived, so the
  // source is fresh even though the last reconnect was recent.
  assert.equal(decide({ lastSnapshotAt: NOW - 1, lastReconnectAt: NOW - 1 }), false)
})
