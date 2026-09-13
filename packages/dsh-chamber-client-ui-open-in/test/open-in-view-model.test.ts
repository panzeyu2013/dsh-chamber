/**
 * Per-source open-in view-model unit tests (Batch 3 Phase 0, design 20 §2):
 * the presentation matrix over the instance-hosted (local) catalog and main (desktop
 * IPC) pools, the channel-priority dedup, the explicit suppression reasons and
 * the default selection. Plain node:test — the module is pure over plain data.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildOpenInViewModel, type OpenInViewModel } from '../src/shared/open-in-view-model.ts'
import { parseOpenInSource, type OpenInApp, type OpenInSource } from '../src/shared/capabilities.ts'

const FINDER: OpenInApp = { id: 'finder', displayKind: 'file-manager', remoteCapable: false, available: true }
const VSCODE: OpenInApp = { id: 'vscode', displayKind: 'vscode', remoteCapable: true, available: true }
const TERMINAL: OpenInApp = { id: 'terminal', displayKind: 'terminal', remoteCapable: false, available: true }
const GHOST: OpenInApp = { id: 'ghost', displayKind: 'ghost', remoteCapable: true, available: false }

function source(value: string, transport: 'local' | 'ssh' | 'http'): OpenInSource {
  const parsed = parseOpenInSource(value, transport)
  assert.ok(parsed !== null, `${value}/${transport} must parse`)
  return parsed
}

function ids(model: OpenInViewModel): string[] {
  return model.entries.map(entry => entry.id)
}

test('view-model / local: instance catalog then main provider, channel order preserved', () => {
  const model = buildOpenInViewModel({
    source: source('local', 'local'),
    localEntries: [FINDER, TERMINAL],
    mainEntries: [VSCODE],
  })
  assert.deepEqual(ids(model), ['finder', 'terminal', 'vscode'])
  assert.deepEqual(model.entries.map(entry => entry.channel), ['local', 'local', 'main'])
  assert.deepEqual(model.entries.map(entry => entry.order), [0, 1, 2])
  assert.deepEqual(model.suppressed, [])
  assert.equal(model.visible, true)
  // VS Code wins the default even when it is not the first entry.
  assert.equal(model.defaultEntryId, 'vscode')
})

test('view-model / local: an AVAILABLE main override owns the id (vscode goes through IPC)', () => {
  const model = buildOpenInViewModel({
    source: source('local', 'local'),
    localEntries: [VSCODE],
    mainEntries: [VSCODE],
  })
  assert.deepEqual(ids(model), ['vscode'])
  assert.equal(model.entries[0].channel, 'main', 'approved §5.1: vscode 全家走 IPC 覆盖')
  assert.deepEqual(model.suppressed, [{ id: 'vscode', channel: 'local', reason: 'duplicate-app-id' }])
})

test('view-model / local: an UNAVAILABLE main override leaves the local entry as the fallback (union + IPC 兜底)', () => {
  const model = buildOpenInViewModel({
    source: source('local', 'local'),
    localEntries: [VSCODE, FINDER],
    mainEntries: [{ id: 'vscode', displayKind: 'vscode', remoteCapable: true, available: false }],
  })
  assert.deepEqual(ids(model), ['vscode', 'finder'])
  assert.deepEqual(model.entries.map(entry => entry.channel), ['local', 'local'])
  assert.deepEqual(model.suppressed, [{ id: 'vscode', channel: 'main', reason: 'app-unavailable' }])
})

test('view-model / remote ssh: main channel only, every local candidate reported', () => {
  const model = buildOpenInViewModel({
    source: source('dsh-edge-west', 'ssh'),
    localEntries: [FINDER, VSCODE],
    mainEntries: [FINDER, VSCODE, TERMINAL],
  })
  assert.deepEqual(ids(model), ['vscode'])
  assert.deepEqual(model.suppressed, [
    { id: 'finder', channel: 'local', reason: 'source-not-local' },
    { id: 'vscode', channel: 'local', reason: 'source-not-local' },
    { id: 'finder', channel: 'main', reason: 'app-not-remote-capable' },
    { id: 'terminal', channel: 'main', reason: 'app-not-remote-capable' },
  ])
  assert.equal(model.defaultEntryId, 'vscode')
})

test('view-model / remote ssh: an unavailable remote-capable app is reported, not silently dropped', () => {
  const model = buildOpenInViewModel({
    source: source('gateway-edge-west', 'ssh'),
    localEntries: null,
    mainEntries: [GHOST, VSCODE],
  })
  assert.deepEqual(ids(model), ['vscode'])
  assert.deepEqual(model.suppressed, [{ id: 'ghost', channel: 'main', reason: 'app-unavailable' }])
})

test('view-model / http transport: nothing renders, both pools are suppressed with the transport reason', () => {
  const model = buildOpenInViewModel({
    source: source('dsh-direct', 'http'),
    localEntries: [FINDER],
    mainEntries: [VSCODE],
  })
  assert.deepEqual(ids(model), [])
  assert.equal(model.visible, false)
  assert.equal(model.defaultEntryId, undefined)
  assert.deepEqual(model.suppressed, [
    { id: 'finder', channel: 'local', reason: 'transport-not-ssh' },
    { id: 'vscode', channel: 'main', reason: 'transport-not-ssh' },
  ])
})

test('view-model / malformed or inconsistent sources are unknown-source (fail-closed)', () => {
  const malformed = [
    { sourceId: 'http-edge', instanceId: 'http-edge', local: false, transport: 'ssh' } as const,
    { sourceId: 'ssh-local', instanceId: 'local', local: false, transport: 'ssh' } as const,
    { sourceId: 'dsh-edge', instanceId: 'other', local: false, transport: 'ssh' } as const,
    { sourceId: 'local', instanceId: 'local', local: true, transport: 'ssh' } as const,
  ]
  for (const candidate of malformed) {
    const model = buildOpenInViewModel({ source: candidate, localEntries: [FINDER], mainEntries: [VSCODE] })
    assert.deepEqual(ids(model), [], JSON.stringify(candidate))
    assert.deepEqual(
      model.suppressed.map(entry => entry.reason),
      ['unknown-source', 'unknown-source'],
      JSON.stringify(candidate),
    )
  }
})

test('view-model / null pools are unknown, never an empty success', () => {
  const model = buildOpenInViewModel({ source: source('local', 'local'), localEntries: null, mainEntries: null })
  assert.deepEqual(ids(model), [])
  assert.deepEqual(model.suppressed, [])
  assert.equal(model.visible, false)
})

test('view-model / the local default falls back to the first entry without VS Code', () => {
  const model = buildOpenInViewModel({ source: source('local', 'local'), localEntries: [FINDER, TERMINAL], mainEntries: null })
  assert.equal(model.defaultEntryId, 'finder')
})
