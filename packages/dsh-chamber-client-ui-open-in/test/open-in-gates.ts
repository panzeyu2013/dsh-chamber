/**
 * OpenInButton render-gate unit tests (plain node:test, no React/DOM): the
 * pure decision surface extracted into src/client/open-in-gates.ts — gate 1
 * (per-source usable apps, incl. the gateway fail-closed P2 fix), gate 2
 * (workspace-path lookup) and the launch instance-id prefix strip. The
 * component itself (React + CSS + a raster mark) is not importable under
 * node; these tests pin its decision logic.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  rawInstanceIdForLaunch,
  usableAppsForSource,
  workspacePathForSession,
} from '../src/client/open-in-gates.ts'
import type { OpenInApp } from '../src/shared/coordinator.ts'

const FINDER: OpenInApp = { id: 'finder', remoteCapable: false, available: true }
const VSCODE: OpenInApp = { id: 'vscode', remoteCapable: true, available: true }
const EXPLORER_UNAVAILABLE: OpenInApp = { id: 'explorer', remoteCapable: false, available: false }
const ALL: OpenInApp[] = [FINDER, VSCODE, EXPLORER_UNAVAILABLE]

test('gate 1 / local: every AVAILABLE app is usable (Finder + VS Code), unavailable ones are hidden', () => {
  assert.deepEqual(usableAppsForSource('local', ALL), [FINDER, VSCODE])
  assert.deepEqual(usableAppsForSource('local', []), [])
})

test('gate 1 / ssh source: only remote-capable apps are usable (VS Code)', () => {
  assert.deepEqual(usableAppsForSource('ssh-edge-west', ALL), [VSCODE])
  // An unavailable remote-capable app stays hidden (fail-closed).
  const unavailableVscode: OpenInApp = { id: 'vscode', remoteCapable: true, available: false }
  assert.deepEqual(usableAppsForSource('ssh-edge-west', [FINDER, unavailableVscode]), [])
})

test('gate 1 / gateway source: NOTHING is usable — a gateway button would be a dead button (P2 fix)', () => {
  // Regression for the review finding: the old `sourceId === 'local' ? all :
  // remoteCapable-only` branch treated every non-local source as ssh and
  // rendered a VS Code button for a 'gateway-<id>' source. The click always
  // failed in the main process: only the 'ssh-' prefix is ever stripped, so
  // the launch sent 'gateway-<id>' as the raw registry id and lookupInstance
  // resolved null. Fail-closed now: the button never renders for gateway.
  assert.deepEqual(usableAppsForSource('gateway-edge-west', ALL), [])
  assert.deepEqual(usableAppsForSource('gateway-edge-west', [VSCODE]), [])
  assert.deepEqual(usableAppsForSource('gateway-edge-west', [FINDER]), [])
})

test('gate 1 / unknown or malformed sources get nothing (fail-closed)', () => {
  assert.deepEqual(usableAppsForSource('', ALL), [])
  assert.deepEqual(usableAppsForSource('http-edge', ALL), [])
  assert.deepEqual(usableAppsForSource('ssh-', [VSCODE]), [VSCODE]) // degenerate but ssh-shaped → remote filter applies
  assert.deepEqual(usableAppsForSource(undefined as unknown as string, ALL), [])
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

test('launch instance id: the ssh- prefix is stripped, local and others pass through', () => {
  assert.equal(rawInstanceIdForLaunch('local'), 'local')
  assert.equal(rawInstanceIdForLaunch('ssh-edge-west'), 'edge-west')
  // Never reachable after the gate-1 fix, but the passthrough is the
  // documented contract (only ssh has a raw-id prefix strip).
  assert.equal(rawInstanceIdForLaunch('gateway-edge-west'), 'gateway-edge-west')
})
