import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  filterServerRows,
  serverDropdownPlacement,
  serverProjectionSignature,
  sourceFingerprintIsCurrent,
  staleOwnedSessionIds,
} from '../src/client/server-selector.ts'

const rows = [
  { id: 'local', label: '本地实例' },
  { id: 'ssh-alpha', label: 'Build Alpha' },
  { id: 'ssh-beta', label: '离线备机' },
]

test('server selector filters by label or stable instance id without dropping offline rows', () => {
  assert.deepEqual(filterServerRows(rows, 'alpha').map(row => row.id), ['ssh-alpha'])
  assert.deepEqual(filterServerRows(rows, 'ssh-beta').map(row => row.id), ['ssh-beta'])
  assert.equal(filterServerRows(rows, '').length, 3)
})

test('portal placement flips above near the viewport tail and clamps horizontally', () => {
  assert.deepEqual(
    serverDropdownPlacement({ left: 900, top: 700, bottom: 734, width: 164 }, { width: 1024, height: 768 }),
    { top: 276, left: 736, width: 280, maxHeight: 420 },
  )
  assert.deepEqual(
    serverDropdownPlacement({ left: 12, top: 40, bottom: 74, width: 164 }, { width: 1024, height: 768 }),
    { top: 78, left: 12, width: 280, maxHeight: 420 },
  )
})

test('portal placement shrinks to a tiny viewport instead of overflowing it', () => {
  assert.deepEqual(
    serverDropdownPlacement({ left: 12, top: 40, bottom: 74, width: 164 }, { width: 200, height: 120 }),
    { top: 78, left: 8, width: 184, maxHeight: 34 },
  )
})

test('settings roster signature tracks rendered pluginId but ignores timestamp-only changes', () => {
  const base = {
    id: 'ssh-alpha', kind: 'ssh' as const, label: 'Alpha', connected: true, phase: 'ready',
    sourceFingerprint: 'proof-a',
    pluginDiagnostic: { state: 'bundle-load-failed', message: 'load failed', pluginId: 'plugin-a' },
  }
  const signature = serverProjectionSignature([{ ...base, updatedAt: 1 }])
  assert.equal(signature, serverProjectionSignature([{ ...base, updatedAt: 2 }]))
  assert.notEqual(signature, serverProjectionSignature([{
    ...base, pluginDiagnostic: { ...base.pluginDiagnostic, pluginId: 'plugin-b' }, updatedAt: 2,
  }]))
  assert.notEqual(signature, serverProjectionSignature([{
    ...base, sourceFingerprint: 'proof-b', updatedAt: 2,
  }]))
})

test('settings roster signature cannot collide through separator-like user text', () => {
  const row = (id: string, label: string) => ({
    id, sourceFingerprint: 'proof', kind: 'ssh' as const, label, connected: true, phase: 'ready',
  })
  assert.notEqual(
    serverProjectionSignature([row('a', 'b\u0000ssh\nnext')]),
    serverProjectionSignature([row('a\u0000b', 'ssh\nnext')]),
  )
})

test('source-owned settings sessions retire on replacement or deletion', () => {
  const sessions = {
    local: { sourceFingerprint: 'local' },
    'ssh-stable': { sourceFingerprint: 'proof-stable' },
    'ssh-replaced': { sourceFingerprint: 'proof-old' },
    'ssh-deleted': { sourceFingerprint: 'proof-deleted' },
  }
  const roster = [
    { id: 'local', sourceFingerprint: 'local' },
    { id: 'ssh-stable', sourceFingerprint: 'proof-stable' },
    { id: 'ssh-replaced', sourceFingerprint: 'proof-new' },
  ]

  assert.deepEqual(staleOwnedSessionIds(sessions, roster), ['ssh-replaced', 'ssh-deleted'])
})

test('a late mount can commit only while its captured source proof is still current', () => {
  const roster = [
    { id: 'local', sourceFingerprint: 'local' },
    { id: 'ssh-stable', sourceFingerprint: 'proof-stable' },
    { id: 'ssh-replaced', sourceFingerprint: 'proof-new' },
  ]

  assert.equal(sourceFingerprintIsCurrent(roster, 'ssh-stable', 'proof-stable'), true)
  assert.equal(sourceFingerprintIsCurrent(roster, 'ssh-replaced', 'proof-old'), false)
  assert.equal(sourceFingerprintIsCurrent(roster, 'ssh-deleted', 'proof-deleted'), false)
})
