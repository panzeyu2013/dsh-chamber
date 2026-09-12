/**
 * OpenInButton render-gate unit tests (plain node:test, no React/DOM): the
 * pure decision surface extracted into src/client/open-in-gates.ts — gate 1
 * (per-source usable apps across target kind × transport), gate 2
 * (workspace-path lookup) and the launch instance-id prefix strip. The
 * component itself (React + CSS + a raster mark) is not importable under
 * node; these tests pin its decision logic.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  markKindFor,
  rawInstanceIdForLaunch,
  usableAppsForSource,
  workspacePathForSession,
} from '../src/client/open-in-gates.ts'
import { displayKindOf } from '../src/client/local-catalog.ts'
import type { OpenInApp } from '../src/shared/coordinator.ts'

const FINDER: OpenInApp = { id: 'finder', displayKind: 'file-manager', remoteCapable: false, available: true }
const VSCODE: OpenInApp = { id: 'vscode', displayKind: 'vscode', remoteCapable: true, available: true }
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

test('mark selection: the host icon wins whenever the instance answered one', () => {
  // Upstream draws the icon its host serves (OpenInAppAction.tsx `AppIcon`);
  // the launch channel decides the carrier, never the mark — so a main-channel
  // VS Code entry shows the instance's real bundle art exactly like a local one.
  for (const displayKind of ['vscode', 'file-manager', 'terminal', 'unknown-family']) {
    assert.equal(markKindFor({ displayKind }, true), 'catalog-icon', displayKind)
  }
  // No host icon: the VS Code family keeps the bundled product raster (the
  // remote-SSH case has no instance catalog at all), everything else falls back
  // to the same rounded square upstream draws.
  assert.equal(markKindFor({ displayKind: 'vscode' }, false), 'vscode')
  assert.equal(markKindFor({ displayKind: displayKindOf('vscodeinsiders') }, false), 'vscode',
    'the whole VS Code family maps to the product family before mark selection')
  assert.equal(markKindFor({ displayKind: 'file-manager' }, false), 'generic')
  assert.equal(markKindFor({ displayKind: 'terminal' }, false), 'generic')
  assert.equal(markKindFor({ displayKind: 'unknown-family' }, false), 'generic')
})
