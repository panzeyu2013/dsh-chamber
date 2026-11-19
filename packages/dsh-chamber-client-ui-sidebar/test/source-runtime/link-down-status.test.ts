/**
 * E2 (design 27 §3.3 / review C9): the source status dot + hover/aria label must show the
 * TRANSPORT link sub-state carried by ChamberServerAggregate.linkState. A ready source whose
 * link is down still has its shell and snapshots (nothing is unmounted), but it must not keep
 * claiming 「已就绪」: the proxy fast-fails NEW requests, so the dot turns err and the label
 * says the link is unavailable. 'suspect' deliberately keeps the ready face (design 27 I3).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  sourceStatusKind,
  sourceStatusLabelKey,
} from '../../src/client/server-section-model.ts'
import { en, zh } from '../../src/client/locales.ts'
import type { ChamberServerAggregate } from '../../../dsh-chamber-client-core/src/aggregate-store.ts'

function server(overrides: Partial<ChamberServerAggregate> = {}): ChamberServerAggregate {
  return {
    id: 'dsh-r1',
    sourceFingerprint: 'b'.repeat(64),
    kind: 'dsh',
    transport: 'ssh',
    label: 'R1',
    connected: true,
    phase: 'ready',
    workspaces: [],
    updatedAt: 0,
    ...overrides,
  }
}

test('a ready source with a down link shows the error dot, not the green ready dot', () => {
  assert.equal(sourceStatusKind(server({ linkUp: false, linkState: 'down' })), 'err')
  assert.equal(sourceStatusLabelKey(server({ linkUp: false, linkState: 'down' })), 'status.linkDown')
  // suspect still forwards new work → the ready face stays (design 27 I3).
  assert.equal(sourceStatusKind(server({ linkUp: true, linkState: 'suspect' })), 'ok')
  assert.equal(sourceStatusLabelKey(server({ linkUp: true, linkState: 'suspect' })), 'status.ready')
  // healthy / old producer (absent facts) keeps today's face.
  assert.equal(sourceStatusKind(server({ linkState: 'healthy' })), 'ok')
  assert.equal(sourceStatusLabelKey(server({ linkState: 'healthy' })), 'status.ready')
  assert.equal(sourceStatusKind(server()), 'ok')
  assert.equal(sourceStatusLabelKey(server()), 'status.ready')
})

test('the down-link branch is scoped to the ready phase (the existing phase matrix is untouched)', () => {
  // Non-ready phases keep their existing vocabulary: a down transport in the reconnect cycle
  // must not be relabelled as a link-down READY source.
  assert.equal(sourceStatusKind(server({ phase: 'connecting', linkState: 'down' })), 'busy')
  assert.equal(sourceStatusLabelKey(server({ phase: 'connecting', linkState: 'down' })), 'status.connecting')
  assert.equal(sourceStatusKind(server({ phase: 'degraded', linkState: 'down' })), 'busy')
  assert.equal(sourceStatusLabelKey(server({ phase: 'degraded', linkState: 'down' })), 'status.reconnecting')
  assert.equal(sourceStatusKind(server({ phase: 'error', linkState: 'down' })), 'err')
  assert.equal(sourceStatusLabelKey(server({ phase: 'error', linkState: 'down' })), 'status.error')
  // The managed-dsh fold already owns stopped/restart-exhausted (gateway) — unchanged.
  assert.equal(sourceStatusKind(server({ kind: 'gateway', phase: 'stopped' })), 'err')
  assert.equal(sourceStatusLabelKey(server({ kind: 'gateway', phase: 'stopped' })), 'status.stopped')
})

test('the link-down label exists in BOTH dictionaries (zh + en)', () => {
  assert.ok(zh['status.linkDown'].trim() !== '')
  assert.ok(en['status.linkDown'].trim() !== '')
  assert.match(zh['status.linkDown'], /链路不可用/)
  assert.match(en['status.linkDown'], /unavailable/)
})
