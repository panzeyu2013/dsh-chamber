/**
 * Per-source open-in view-model unit tests (Batch 3 Phase 0, design 20 §2):
 * the presentation matrix over the instance-hosted (local) catalog and main
 * (desktop IPC) pools, the channel-priority dedup, the explicit suppression
 * reasons and the default selection. Plain node:test — the module is pure over
 * plain data. The gate half below shares this file and its fixtures because
 * src/client/open-in-gates.ts builds its matrix ON buildOpenInViewModel
 * (src/shared/open-in-view-model.ts): one contract chain.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildOpenInViewModel, type OpenInViewModel } from '../../src/shared/open-in-view-model.ts'
import { parseOpenInSource, type OpenInApp, type OpenInSource } from '../../src/shared/capabilities.ts'
import { FINDER, GHOST, TERMINAL, VSCODE } from '../support/harness.ts'

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

/**
 * OpenInButton render-gate unit tests (plain node:test, no React/DOM): the
 * pure decision surface extracted into src/client/open-in-gates.ts — gate 1
 * (per-source usable apps across target kind × transport), gate 2
 * (workspace-path lookup) and the launch instance-id prefix strip. The
 * component itself (React + CSS + a raster mark) is not importable under node;
 * these tests pin its decision logic.
 */

import {
  rawInstanceIdForLaunch,
  usableAppsForSource,
  workspacePathForSession,
} from '../../src/client/open-in-gates.ts'

const EXPLORER_UNAVAILABLE: OpenInApp = { id: 'explorer', displayKind: 'file-manager', remoteCapable: false, available: false }
const ALL: OpenInApp[] = [FINDER, VSCODE, EXPLORER_UNAVAILABLE]

test('gate 1 / local: every AVAILABLE app is usable (Finder + VS Code), unavailable ones are hidden', () => {
  assert.deepEqual(usableAppsForSource('local', ALL, 'local'), [FINDER, VSCODE])
  assert.deepEqual(usableAppsForSource('local', [], 'local'), [])
})

test('gate 1 / ssh transport: dsh, gateway, and the legacy ssh alias get only remote-capable apps', () => {
  assert.deepEqual(usableAppsForSource('dsh-edge-west', ALL, 'ssh'), [VSCODE])
  assert.deepEqual(usableAppsForSource('gateway-edge-west', ALL, 'ssh'), [VSCODE])
  assert.deepEqual(usableAppsForSource('ssh-edge-west', ALL, 'ssh'), [VSCODE])
  // An unavailable remote-capable app stays hidden (fail-closed).
  const unavailableVscode: OpenInApp = { id: 'vscode', displayKind: 'vscode', remoteCapable: true, available: false }
  assert.deepEqual(usableAppsForSource('gateway-edge-west', [FINDER, unavailableVscode], 'ssh'), [])
})

test('gate 1 / http transport: neither target kind exposes vscode-remote', () => {
  assert.deepEqual(usableAppsForSource('dsh-edge-west', ALL, 'http'), [])
  assert.deepEqual(usableAppsForSource('gateway-edge-west', ALL, 'http'), [])
})

test('gate 1 / unknown or malformed sources get nothing (fail-closed)', () => {
  assert.deepEqual(usableAppsForSource('', ALL, 'ssh'), [])
  assert.deepEqual(usableAppsForSource('http-edge', ALL, 'ssh'), [])
  assert.deepEqual(usableAppsForSource('ssh-', [VSCODE], 'ssh'), [])
  assert.deepEqual(usableAppsForSource(undefined as unknown as string, ALL, 'ssh'), [])
  assert.deepEqual(
    usableAppsForSource('gateway-edge', ALL, undefined as unknown as 'ssh'),
    [],
    'missing transport never guesses ssh',
  )
})

test('gate 2: the session must live in a workspace with a concrete path', () => {
  const workspaces = [
    { workspaceId: 'w1', path: '/home/u/w1', sessionIds: ['s1'] },
    { workspaceId: 'w2', path: '', sessionIds: ['s2'] },
    { workspaceId: 'w3', path: '/x', sessionIds: ['s3'] },
  ]
  assert.equal(workspacePathForSession(workspaces, 's1'), '/home/u/w1')
  assert.equal(workspacePathForSession(workspaces, 's3'), '/x')
  assert.equal(workspacePathForSession(workspaces, 's2'), '') // empty path → the button's gate-2 check fails
  assert.equal(workspacePathForSession(workspaces, 'missing'), undefined)
  assert.equal(workspacePathForSession(workspaces, 42 as unknown as string), undefined) // numeric session ids never match string ids
  assert.equal(workspacePathForSession([], 's1'), undefined)
})

test('launch instance id: canonical dsh/gateway and legacy ssh prefixes are stripped', () => {
  assert.equal(rawInstanceIdForLaunch('local'), 'local')
  assert.equal(rawInstanceIdForLaunch('dsh-edge-west'), 'edge-west')
  assert.equal(rawInstanceIdForLaunch('ssh-edge-west'), 'edge-west')
  assert.equal(rawInstanceIdForLaunch('gateway-edge-west'), 'edge-west')
})
