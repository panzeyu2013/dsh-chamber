/**
 * Cross-package contract lockstep tests (A2 cross-package protocol
 * single-sourcing — the ipc-surface-mirror golden spirit): the desktop's
 * consumption of the shared wire formats must be byte-identical to the
 * control-plane's authoritative implementation for the same input.
 *
 * The desktop never re-derives the formats: ssh-provider.ts and plugin-sync.ts
 * consume control-plane's rpc-envelope.ts / cordis-inserts.ts through
 * control-plane-module.ts (packaged → compiled dist/control-plane, dev/tests →
 * workspace source). These tests pin the desktop-consumed output to the
 * control-plane output AND to the golden bytes, so a drift in either
 * direction fails loudly — a duplicated implementation sneaking back into
 * the desktop, or a wire-format change landing on only one side.
 *
 * Note: in the dev/test resolution both imports resolve to the same
 * control-plane module instance (the workspace source), so the byte equality
 * is also an identity assertion — it proves control-plane-module.ts forwards
 * the shared functions instead of re-implementing them. The packaged path
 * (compiled dist/control-plane) is exercised by the desktop build, not by
 * this test.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
// Desktop consumption entry: the dual-path facade (packaged → compiled
// control-plane, dev/tests → workspace source).
import {
  buildClientRequest as desktopBuildClientRequest,
  isPackagedElectronRuntime,
  renderCordisInserts as desktopRenderCordisInserts,
} from './control-plane-module.ts'
// The control-plane authoritative package (the cross-package contract target).
import {
  buildClientRequest as planeBuildClientRequest,
  renderCordisInserts as planeRenderCordisInserts,
} from '@dsh-chamber/control-plane'
import {
  CLIENT_GRAPH_INSERT_ID,
  CLIENT_GRAPH_PACKAGE_NAME,
  computeCordisPatchUpdate,
  GIT_WORKTREE_INSERT_ID,
  GIT_WORKTREE_PACKAGE_NAME,
} from './plugin-sync.ts'

const CLIENT_GRAPH = { id: CLIENT_GRAPH_INSERT_ID, name: CLIENT_GRAPH_PACKAGE_NAME }
const GIT_WORKTREE = { id: GIT_WORKTREE_INSERT_ID, name: GIT_WORKTREE_PACKAGE_NAME }

test('the control-plane facade selects packaged artifacts without importing Electron in pure Node', () => {
  assert.equal(isPackagedElectronRuntime({}), false, 'pure Node must use the workspace package')
  assert.equal(
    isPackagedElectronRuntime({ electronVersion: '43.4.0', defaultApp: true }),
    false,
    'an unpackaged Electron app must use the workspace package',
  )
  assert.equal(
    isPackagedElectronRuntime({ electronVersion: '43.4.0', defaultApp: false }),
    true,
    'a packaged Electron app must use the compiled artifact',
  )
  assert.equal(
    isPackagedElectronRuntime({ electronVersion: '43.4.0' }),
    true,
    'packaged Electron may leave defaultApp undefined',
  )
})

/** Golden wire bytes of the chamber loader overlay (dsh-app-boot
 *  loadOverlayPatches format: a top-level YAML array of `- insert:` loader
 *  patch entries). Regenerate only when the wire format changes on BOTH
 *  sides deliberately. */
const GOLDEN_OVERLAY = `- insert:
    - id: client-graph
      name: '@dsh-chamber/dsh-host-client-graph'
    - id: git-worktree
      name: '@dsh-chamber/dsh-host-git-worktree'
`

test('the desktop-consumed insert render is byte-identical to control-plane for the same input (A2)', () => {
  const desktop = desktopRenderCordisInserts([CLIENT_GRAPH, GIT_WORKTREE])
  const plane = planeRenderCordisInserts([CLIENT_GRAPH, GIT_WORKTREE])
  assert.equal(desktop, GOLDEN_OVERLAY, 'the desktop-consumed render drifted from the golden overlay bytes')
  assert.equal(plane, GOLDEN_OVERLAY, 'the control-plane render drifted from the golden overlay bytes')
  assert.equal(desktop, plane, 'the desktop and control-plane renders must be byte-identical for the same input')
})

test('computeCordisPatchUpdate embeds the shared render bytes verbatim (the fold uses the single source)', () => {
  const update = computeCordisPatchUpdate('# header\n[]\n', [
    { insertId: CLIENT_GRAPH_INSERT_ID, packageName: CLIENT_GRAPH_PACKAGE_NAME },
    { insertId: GIT_WORKTREE_INSERT_ID, packageName: GIT_WORKTREE_PACKAGE_NAME },
  ])
  assert.equal('error' in update, false)
  if ('error' in update || !update.write) return
  // The template rewrite appends the shared render — byte-identical to the
  // control-plane renderer's output, not a desktop-side re-render.
  assert.equal(update.content, '# header\n' + GOLDEN_OVERLAY)
})

test('the desktop-consumed client-request envelope is byte-identical to control-plane (A2)', () => {
  const rpcId = 'test-rpc-id'
  const method = 'session/list'
  const payload = { args: {} }
  const desktop = desktopBuildClientRequest(rpcId, method, payload)
  const plane = planeBuildClientRequest(rpcId, method, payload)
  assert.deepEqual(desktop, plane, 'the desktop-consumed envelope drifted from the control-plane envelope')
  // Pin the wire bytes (JSON.stringify key order is the wire order).
  assert.equal(
    JSON.stringify(desktop),
    '{"type":"client-request","rpcId":"test-rpc-id","method":"session/list","payload":{"args":{}}}',
  )
})
