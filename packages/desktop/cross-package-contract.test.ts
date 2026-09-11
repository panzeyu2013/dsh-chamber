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
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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
  ARCHIVE_CLEANUP_INSERT_ID,
  ARCHIVE_CLEANUP_PACKAGE_NAME,
  CLIENT_GRAPH_INSERT_ID,
  CLIENT_GRAPH_PACKAGE_NAME,
  computeCordisPatchUpdate,
  GIT_WORKTREE_INSERT_ID,
  GIT_WORKTREE_PACKAGE_NAME,
} from './plugin-sync.ts'
// The shared dsh-runtime activation-probe set (the desktop shims re-export
// the package main → dist; this import therefore pins the COMMITTED bundle).
import { REQUIRED_ACTIVATION_PROBES } from '@dsh-chamber/dsh-runtime'
// The control-plane single-source host-identity constants (consumed through
// the same facade the desktop probes use).
import { HOST_IDENTITY_METHOD, LEGACY_HOST_PROBE_METHOD } from './control-plane-module.ts'

const CLIENT_GRAPH = { id: CLIENT_GRAPH_INSERT_ID, name: CLIENT_GRAPH_PACKAGE_NAME }
const GIT_WORKTREE = { id: GIT_WORKTREE_INSERT_ID, name: GIT_WORKTREE_PACKAGE_NAME }
const ARCHIVE_CLEANUP = { id: ARCHIVE_CLEANUP_INSERT_ID, name: ARCHIVE_CLEANUP_PACKAGE_NAME }

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
      name: '@dsh-chamber/dsh-chamber-seed-client-graph'
    - id: git-worktree
      name: '@dsh-chamber/dsh-chamber-seed-git-worktree'
    - id: archive-cleanup
      name: '@dsh-chamber/dsh-chamber-seed-archive-cleanup'
`

test('the desktop-consumed insert render is byte-identical to control-plane for the same input (A2)', () => {
  const desktop = desktopRenderCordisInserts([CLIENT_GRAPH, GIT_WORKTREE, ARCHIVE_CLEANUP])
  const plane = planeRenderCordisInserts([CLIENT_GRAPH, GIT_WORKTREE, ARCHIVE_CLEANUP])
  assert.equal(desktop, GOLDEN_OVERLAY, 'the desktop-consumed render drifted from the golden overlay bytes')
  assert.equal(plane, GOLDEN_OVERLAY, 'the control-plane render drifted from the golden overlay bytes')
  assert.equal(desktop, plane, 'the desktop and control-plane renders must be byte-identical for the same input')
})

test('computeCordisPatchUpdate embeds the shared render bytes verbatim (the fold uses the single source)', () => {
  const update = computeCordisPatchUpdate('# header\n[]\n', [
    { insertId: CLIENT_GRAPH_INSERT_ID, packageName: CLIENT_GRAPH_PACKAGE_NAME },
    { insertId: GIT_WORKTREE_INSERT_ID, packageName: GIT_WORKTREE_PACKAGE_NAME },
    { insertId: ARCHIVE_CLEANUP_INSERT_ID, packageName: ARCHIVE_CLEANUP_PACKAGE_NAME },
  ])
  assert.equal('error' in update, false)
  if ('error' in update || !update.write) return
  // The template rewrite appends the shared render — byte-identical to the
  // control-plane renderer's output, not a desktop-side re-render.
  assert.equal(update.content, '# header\n' + GOLDEN_OVERLAY)
})

test('the desktop-consumed client-request envelope is byte-identical to control-plane (A2)', () => {
  const rpcId = 'test-rpc-id'
  // The two REAL current wire calls: the fixed-size identity probe
  // (payload {args:{}}) and the legacy session/list fallback
  // (payload {args:{_request:{}}}). Golden bytes pin the key order.
  const identity = { method: HOST_IDENTITY_METHOD, payload: { args: {} } }
  const desktopIdentity = desktopBuildClientRequest(rpcId, identity.method, identity.payload)
  const planeIdentity = planeBuildClientRequest(rpcId, identity.method, identity.payload)
  assert.deepEqual(desktopIdentity, planeIdentity, 'the desktop-consumed identity envelope drifted from the control-plane envelope')
  assert.equal(
    JSON.stringify(desktopIdentity),
    '{"type":"client-request","rpcId":"test-rpc-id","method":"session/canOpenWorkspacePath","payload":{"args":{}}}',
    'identity wire bytes drifted',
  )
  const legacy = { method: LEGACY_HOST_PROBE_METHOD, payload: { args: { _request: {} } } }
  const desktopLegacy = desktopBuildClientRequest(rpcId, legacy.method, legacy.payload)
  const planeLegacy = planeBuildClientRequest(rpcId, legacy.method, legacy.payload)
  assert.deepEqual(desktopLegacy, planeLegacy, 'the desktop-consumed legacy envelope drifted from the control-plane envelope')
  assert.equal(
    JSON.stringify(desktopLegacy),
    '{"type":"client-request","rpcId":"test-rpc-id","method":"session/list","payload":{"args":{"_request":{}}}}',
    'legacy wire bytes drifted',
  )
})

test('the dsh-runtime activation set and the control-plane identity method stay in lockstep (A2)', () => {
  // dsh-runtime (pure Node) mirrors the host-identity wire by design and its
  // desktop/gateway consumers import the package main (the committed dist):
  // this assertion pins the runtime's CLOSED activation set to the
  // control-plane single-source method constants. A drift on either side —
  // an identity-method rename, a session/list or data.sessions row sneaking
  // back into the activation set, or a stale committed dist — fails here.
  const probeSet = REQUIRED_ACTIVATION_PROBES as readonly string[]
  assert.equal(probeSet.includes(HOST_IDENTITY_METHOD), true,
    'the activation set no longer probes the identity method (or dist is stale)')
  assert.equal(probeSet.includes(LEGACY_HOST_PROBE_METHOD), false,
    'session/list must not re-enter the activation probe set')
  assert.equal(probeSet.includes('data.sessions'), false,
    'data.sessions must not re-enter the activation probe set')
})

/** The `interface <name> { … }` body of one source file (the lockstep gate
 *  below parses declarations, never values — the three declarations involved
 *  live in three runtimes: desktop main, renderer browser code, client plugin). */
function interfaceBody(source: string, name: string): string {
  const match = new RegExp(`interface ${name} \\{([\\s\\S]*?)\\n\\}`).exec(source)
  assert.ok(match !== null, `interface ${name} not found in the parsed source`)
  return match[1]!
}

/** Field names declared by an interface body (comments and blanks dropped). */
function interfaceFields(body: string): string[] {
  return body
    .split('\n')
    .map(line => line.replace(/\/\/.*$/, '').trim())
    .filter(line => line !== '' && !line.startsWith('*') && !line.startsWith('/*'))
    // `readonly` is a modifier, not part of the field name (the client mirror
    // declares every field readonly; the desktop projection does not).
    .map(line => /^(?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*:/.exec(line)?.[1])
    .filter((name): name is string => name !== undefined)
}

test('the chamber host-package state field set is identical across its three declarations (design 20 §6)', () => {
  // The SAME wire object is declared three times on purpose (three runtimes, no
  // shared import path): plugin-sync.ts projects it, renderer/global.d.ts types
  // it for the preload bridge, and the settings plugin mirrors it structurally
  // for its pure projections. 2026-09-11: the open-in `localOnly` field landed
  // in two of the three and the renderer's wire type silently missed it — the
  // name-set drift gate could not see a FIELD. This is that gate.
  const repoRoot = join(import.meta.dirname, '..', '..')
  const desktopFields = interfaceFields(interfaceBody(
    readFileSync(join(import.meta.dirname, 'plugin-sync.ts'), 'utf8'), 'ChamberHostPackageState'))
  const rendererFields = interfaceFields(interfaceBody(
    readFileSync(join(repoRoot, 'packages', 'renderer', 'src', 'global.d.ts'), 'utf8'), 'ChamberHostPackageState'))
  const clientFields = interfaceFields(interfaceBody(
    readFileSync(join(repoRoot, 'packages', 'dsh-chamber-client-ui-settings-connections', 'src', 'client',
      'plugin-inventory-text.ts'), 'utf8'), 'ChamberPackageState'))
  assert.deepEqual([...desktopFields].sort(), [...rendererFields].sort(),
    'renderer/global.d.ts must declare exactly the desktop projection fields')
  // The FOURTH declaration of this wire object — preload.cts — is pinned to
  // the renderer copy by ipc-surface-mirror.test.ts (L3 shape guard), so the
  // whole four-way set is transitively covered by the two gates together.
  //
  // The client plugin legitimately omits `probe` (documented: unused by its
  // projection, and the omission keeps that module importable by the plain-node
  // suite), so it is a SUBSET — never a superset with invented fields.
  const clientOnly = clientFields.filter(field => !desktopFields.includes(field))
  assert.deepEqual(clientOnly, [], 'the client mirror must not invent fields the desktop never projects')
  assert.deepEqual(desktopFields.filter(field => !clientFields.includes(field)), ['probe'])
})
