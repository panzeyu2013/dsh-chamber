/**
 * Per-source open-in view-model unit tests (Batch 3 Phase 0, design 20 §2):
 * the presentation matrix over the official (host catalog) and main (desktop
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

test('view-model / local: official catalog then main provider, channel order preserved', () => {
  const model = buildOpenInViewModel({
    source: source('local', 'local'),
    official: [FINDER, TERMINAL],
    main: [VSCODE],
  })
  assert.deepEqual(ids(model), ['finder', 'terminal', 'vscode'])
  assert.deepEqual(model.entries.map(entry => entry.channel), ['official', 'official', 'main'])
  assert.deepEqual(model.entries.map(entry => entry.order), [0, 1, 2])
  assert.deepEqual(model.suppressed, [])
  assert.equal(model.visible, true)
  // VS Code wins the default even when it is not the first entry.
  assert.equal(model.defaultEntryId, 'vscode')
})

test('view-model / local: a main duplicate loses to the official entry', () => {
  const model = buildOpenInViewModel({
    source: source('local', 'local'),
    official: [VSCODE],
    main: [VSCODE],
  })
  assert.deepEqual(ids(model), ['vscode'])
  assert.equal(model.entries[0].channel, 'official', 'the host catalog is the authoritative channel')
  assert.deepEqual(model.suppressed, [{ id: 'vscode', channel: 'main', reason: 'duplicate-app-id' }])
})

test('view-model / remote ssh: main channel only, every official candidate reported', () => {
  const model = buildOpenInViewModel({
    source: source('dsh-edge-west', 'ssh'),
    official: [FINDER, VSCODE],
    main: [FINDER, VSCODE, TERMINAL],
  })
  assert.deepEqual(ids(model), ['vscode'])
  assert.deepEqual(model.suppressed, [
    { id: 'finder', channel: 'official', reason: 'source-not-local' },
    { id: 'vscode', channel: 'official', reason: 'source-not-local' },
    { id: 'finder', channel: 'main', reason: 'app-not-remote-capable' },
    { id: 'terminal', channel: 'main', reason: 'app-not-remote-capable' },
  ])
  assert.equal(model.defaultEntryId, 'vscode')
})

test('view-model / remote ssh: an unavailable remote-capable app is reported, not silently dropped', () => {
  const model = buildOpenInViewModel({
    source: source('gateway-edge-west', 'ssh'),
    official: null,
    main: [GHOST, VSCODE],
  })
  assert.deepEqual(ids(model), ['vscode'])
  assert.deepEqual(model.suppressed, [{ id: 'ghost', channel: 'main', reason: 'app-unavailable' }])
})

test('view-model / http transport: nothing renders, both pools are suppressed with the transport reason', () => {
  const model = buildOpenInViewModel({
    source: source('dsh-direct', 'http'),
    official: [FINDER],
    main: [VSCODE],
  })
  assert.deepEqual(ids(model), [])
  assert.equal(model.visible, false)
  assert.equal(model.defaultEntryId, undefined)
  assert.deepEqual(model.suppressed, [
    { id: 'finder', channel: 'official', reason: 'transport-not-ssh' },
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
    const model = buildOpenInViewModel({ source: candidate, official: [FINDER], main: [VSCODE] })
    assert.deepEqual(ids(model), [], JSON.stringify(candidate))
    assert.deepEqual(
      model.suppressed.map(entry => entry.reason),
      ['unknown-source', 'unknown-source'],
      JSON.stringify(candidate),
    )
  }
})

test('view-model / null pools are unknown, never an empty success', () => {
  const model = buildOpenInViewModel({ source: source('local', 'local'), official: null, main: null })
  assert.deepEqual(ids(model), [])
  assert.deepEqual(model.suppressed, [])
  assert.equal(model.visible, false)
})

test('view-model / the local default falls back to the first entry without VS Code', () => {
  const model = buildOpenInViewModel({ source: source('local', 'local'), official: [FINDER, TERMINAL], main: null })
  assert.equal(model.defaultEntryId, 'finder')
})
