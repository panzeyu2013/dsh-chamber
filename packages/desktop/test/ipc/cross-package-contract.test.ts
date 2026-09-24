/** Cross-package contract lockstep (protocol single-sourcing, the ipc-surface-mirror golden
 *  spirit): the desktop never re-derives the shared wire formats — ssh-provider.ts and
 *  plugin-sync.ts consume control-plane's rpc-envelope.ts / cordis-inserts.ts through
 *  control-plane-module.ts (packaged → compiled dist/control-plane, dev/tests → workspace source).
 *  These tests pin the desktop-consumed output to the control-plane output AND to the golden bytes,
 *  so a duplicated implementation or a one-sided wire change fails loudly. In dev/test both imports
 *  resolve to the same module instance, so byte equality also proves the facade forwards instead of
 *  re-implementing; the packaged path is exercised by the desktop build, not here. */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// Desktop consumption entry: the dual-path facade (packaged → compiled, dev/tests → source).
import {
  buildClientRequest as desktopBuildClientRequest,
  HOST_GRAPH_PATCH_FILENAME as facadeHostGraphPatchFilename,
  HOST_PACKAGE_SEED_FILES as facadeSeedFiles,
  isPackagedElectronRuntime,
  renderCordisInserts as desktopRenderCordisInserts,
  HOST_ARCHIVE_CLEANUP_INSERT,
  HOST_GIT_WORKTREE_INSERT,
  HOST_GRAPH_INSERT,
} from '../../control-plane-module.ts'
// The control-plane authoritative package (the cross-package contract target).
import {
  buildClientRequest as planeBuildClientRequest,
  HOST_GRAPH_PATCH_FILENAME as planeHostGraphPatchFilename,
  HOST_OPEN_IN_INSERT,
  HOST_PACKAGE_SEED_FILES as planeSeedFiles,
  renderCordisInserts as planeRenderCordisInserts,
} from '@dsh-chamber/control-plane'
import {

  ARCHIVE_CLEANUP_PACKAGE_NAME,

  CLIENT_GRAPH_PACKAGE_NAME,
  computeCordisPatchUpdate,

  GIT_WORKTREE_PACKAGE_NAME,
  localPluginList,
  SEED_FILES,
} from '../../plugin-sync.ts'
import { syncedPluginUploadFiles } from '../../gateway-provider.ts'
// The gateway's usage points of the same seed set (design 17): the upload/cache
// file set of the sync surface. Imported as source (the desktop↔gateway
// cross-package lockstep pattern already used by plugin-tarball.test.ts) —
// module load only runs the registry/probe-domain naming pins, no I/O.
import {
  createChamberPlugins,
  SYNCED_PLUGIN_FILES,
  type SyncedPluginFiles,
} from '../../../gateway/src/plugins.ts'
// The shared dsh-runtime activation-probe set (the desktop shims re-export
// the package main → dist; this import therefore pins the COMMITTED bundle).
import { REQUIRED_ACTIVATION_PROBES } from '@dsh-chamber/dsh-runtime'
// The control-plane single-source host-identity constants (consumed through
// the same facade the desktop probes use).
import { HOST_IDENTITY_METHOD, LEGACY_HOST_PROBE_METHOD } from '../../control-plane-module.ts'

// Insert ids live in the authoritative seed registry (control-plane-module).
const CLIENT_GRAPH_INSERT_ID = HOST_GRAPH_INSERT.id
const GIT_WORKTREE_INSERT_ID = HOST_GIT_WORKTREE_INSERT.id
const ARCHIVE_CLEANUP_INSERT_ID = HOST_ARCHIVE_CLEANUP_INSERT.id

const CLIENT_GRAPH = { id: CLIENT_GRAPH_INSERT_ID, name: CLIENT_GRAPH_PACKAGE_NAME }
const GIT_WORKTREE = { id: GIT_WORKTREE_INSERT_ID, name: GIT_WORKTREE_PACKAGE_NAME }
const ARCHIVE_CLEANUP = { id: ARCHIVE_CLEANUP_INSERT_ID, name: ARCHIVE_CLEANUP_PACKAGE_NAME }
// The local-shape-only row (design 20 §6) — part of the registry and of the
// LOCAL profile's overlay, never of a remote seed (design 20 §6 sync points).
const OPEN_IN = { id: HOST_OPEN_IN_INSERT.id, name: HOST_OPEN_IN_INSERT.name }

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
    - id: open-in
      name: '@dsh-chamber/dsh-chamber-seed-open-in'
`

test('the desktop-consumed insert render is byte-identical to control-plane for the same input (A2)', () => {
  const desktop = desktopRenderCordisInserts([CLIENT_GRAPH, GIT_WORKTREE, ARCHIVE_CLEANUP, OPEN_IN])
  const plane = planeRenderCordisInserts([CLIENT_GRAPH, GIT_WORKTREE, ARCHIVE_CLEANUP, OPEN_IN])
  assert.equal(desktop, GOLDEN_OVERLAY, 'the desktop-consumed render drifted from the golden overlay bytes')
  assert.equal(plane, GOLDEN_OVERLAY, 'the control-plane render drifted from the golden overlay bytes')
  assert.equal(desktop, plane, 'the desktop and control-plane renders must be byte-identical for the same input')
})

test('computeCordisPatchUpdate embeds the shared render bytes verbatim (the fold uses the single source)', () => {
  const update = computeCordisPatchUpdate('# header\n[]\n', [
    { insertId: CLIENT_GRAPH_INSERT_ID, packageName: CLIENT_GRAPH_PACKAGE_NAME },
    { insertId: GIT_WORKTREE_INSERT_ID, packageName: GIT_WORKTREE_PACKAGE_NAME },
    { insertId: ARCHIVE_CLEANUP_INSERT_ID, packageName: ARCHIVE_CLEANUP_PACKAGE_NAME },
    { insertId: HOST_OPEN_IN_INSERT.id, packageName: HOST_OPEN_IN_INSERT.name },
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
  // dsh-runtime (pure Node) mirrors the host-identity wire by design and its desktop/gateway
  // consumers import the committed dist: pin the CLOSED activation set to the control-plane
  // single-source method constants — a rename, a re-entered session/list row or a stale dist fails.
  const probeSet = REQUIRED_ACTIVATION_PROBES as readonly string[]
  assert.equal(probeSet.includes(HOST_IDENTITY_METHOD), true,
    'the activation set no longer probes the identity method (or dist is stale)')
  assert.equal(probeSet.includes(LEGACY_HOST_PROBE_METHOD), false,
    'session/list must not re-enter the activation probe set')
  assert.equal(probeSet.includes('data.sessions'), false,
    'data.sessions must not re-enter the activation probe set')
})

// ---------------------------------------------------------------------------
// Seeded host-package FILE SET: one source, four consumers. Hand-copying the set
// in four places (control-plane's private tuple, the desktop remote seed/probe pair, the gateway
// upload body, the gateway cache) would let a third seed file on one side make the desktop PUT two
// keys, the gateway answer 200/changed:true and the remote boot miss the file silently. These
// assertions pin all four sides to the control-plane export item by item AND prove each side really
// consumes it.
// ---------------------------------------------------------------------------

/** Golden seed file set — regenerate ONLY for a deliberate control-plane change every consumer follows. */
const GOLDEN_SEED_FILES = ['package.json', 'dist/index.js']

test('the seeded file set is single-sourced: control-plane export ≡ desktop writer/probe ≡ desktop gateway upload ≡ gateway cache (A2)', () => {
  const plane = [...planeSeedFiles]
  assert.deepEqual(plane, GOLDEN_SEED_FILES,
    'the control-plane seed tuple drifted from the golden set: all four sides below must move together')
  // The desktop consumes the tuple through the dual-path facade, which must
  // FORWARD it (the packaged desktop cannot import the workspace package).
  assert.deepEqual([...facadeSeedFiles], plane,
    'control-plane-module.ts must forward HOST_PACKAGE_SEED_FILES, not re-declare it')
  // Side 2 — the desktop remote seed writer + both install probes.
  const desktopSeedFiles = [...SEED_FILES]
  assert.deepEqual(desktopSeedFiles, plane,
    'the desktop seed/probe file set (plugin-sync.ts SEED_FILES) drifted from the control-plane export')
  // Side 3 — the desktop `PUT /chamber/plugins` payload keys.
  const upload = syncedPluginUploadFiles({
    name: '@dsh-chamber/dsh-chamber-seed-client-graph',
    packageJson: '{"name":"x","version":"0.0.0"}',
    distIndex: 'export {}\n',
  })
  const uploadKeys = Object.keys(upload)
  assert.deepEqual(uploadKeys, plane,
    'the desktop gateway upload payload keys (gateway-provider.ts) drifted from the control-plane export')
  // Side 4 — the gateway upload/cache file set.
  const gatewaySeedFiles = [...SYNCED_PLUGIN_FILES]
  assert.deepEqual(gatewaySeedFiles, plane,
    'the gateway seed/upload file set (gateway/src/plugins.ts) drifted from the control-plane export')
  // Element-by-item (not just lengths): a one-sided rename must fail even when
  // both sides still carry the same NUMBER of files.
  for (let index = 0; index < plane.length; index += 1) {
    assert.equal(desktopSeedFiles[index], plane[index], `desktop seed file #${index} drifted`)
    assert.equal(uploadKeys[index], plane[index], `desktop upload key #${index} drifted`)
    assert.equal(gatewaySeedFiles[index], plane[index], `gateway seed file #${index} drifted`)
  }
  // The upload carries the real bytes under the derived keys (key derivation
  // never invents an empty/placeholder payload).
  assert.equal(upload['package.json'], '{"name":"x","version":"0.0.0"}')
  assert.equal(upload['dist/index.js'], 'export {}\n')
})

test('the gateway sync cache requires EVERY declared seed file and caches every one of them (no silent two-key accept)', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'chamber-seed-set-'))
  const silent = { log() {}, warn() {}, error() {} }
  const name = '@dsh-chamber/dsh-chamber-seed-client-graph'
  try {
    const plugins = createChamberPlugins(stateDir, silent)
    const complete = { 'package.json': JSON.stringify({ name, version: '0.0.1' }), 'dist/index.js': 'export {}\n' }
    assert.deepEqual(await plugins.put(name, complete), { changed: true })
    // Every declared member landed in the cache (derived from the shared set).
    for (const relative of [...SYNCED_PLUGIN_FILES]) {
      assert.equal(existsSync(join(stateDir, 'chamber-plugins', 'dsh-chamber-seed-client-graph', relative)), true,
        `the gateway cache did not write seed file ${relative}`)
    }
    // A caller that drops a declared key (an older/other-shaped desktop) is
    // refused loudly instead of being accepted with the file silently missing.
    const dropped = { ...complete } as Record<string, string>
    delete dropped[[...SYNCED_PLUGIN_FILES][1]]
    await assert.rejects(
      () => plugins.put(name, dropped as unknown as SyncedPluginFiles),
      /plugin upload must carry package\.json and dist\/index\.js/,
      'a dropped seed key must be refused, never cached as a partial package',
    )
    // Idempotence is unchanged: the same bytes are not a change.
    assert.deepEqual(await plugins.put(name, complete), { changed: false })
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test('the local `--patch` overlay filename comes from the control-plane export, not a desktop mirror (A2)', () => {
  assert.equal(facadeHostGraphPatchFilename, planeHostGraphPatchFilename,
    'control-plane-module.ts must forward HOST_GRAPH_PATCH_FILENAME (the packaged desktop cannot import the workspace package)')
  assert.equal(planeHostGraphPatchFilename, 'dsh-chamber-graph.patch.yml',
    'the overlay filename drifted: the control-plane seed writes this file and every reader resolves it')
  const stateDir = mkdtempSync(join(tmpdir(), 'chamber-overlay-name-'))
  try {
    // The overlay lives BESIDE the managed dsh home (<stateDir>/dsh-home).
    const localDshHome = join(stateDir, 'dsh-home')
    mkdirSync(join(localDshHome, 'profiles', 'web'), { recursive: true })
    writeFileSync(join(localDshHome, 'profiles', 'web', 'package.json'), '{"dependencies":{}}')
    const overlayPath = join(stateDir, planeHostGraphPatchFilename)
    writeFileSync(overlayPath, GOLDEN_OVERLAY)
    const projection = localPluginList(localDshHome)
    assert.equal(projection.chamber.ok, true)
    if (!projection.chamber.ok) return
    assert.deepEqual(projection.chamber.packages.map(entry => entry.patched), [true, true, true, true],
      'the local overlay probe must resolve the overlay through the SHARED filename (control-plane HOST_GRAPH_PATCH_FILENAME)')
    // Renamed: a desktop that re-hardcoded its own filename would still report
    // "patched" here, so this half proves the filename really is shared.
    renameSync(overlayPath, join(stateDir, 'renamed.patch.yml'))
    const renamed = localPluginList(localDshHome)
    assert.equal(renamed.chamber.ok, true)
    if (!renamed.chamber.ok) return
    assert.deepEqual(renamed.chamber.packages.map(entry => entry.patched), [false, false, false, false],
      'the overlay probe must read exactly the shared filename')
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
  }
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
    // `readonly` is a modifier, not part of the field name (the client mirror marks every field readonly).
    .map(line => /^(?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*:/.exec(line)?.[1])
    .filter((name): name is string => name !== undefined)
}

test('the chamber host-package state field set is identical across its three declarations (design 20 §6)', () => {
  // The SAME wire object is declared three times on purpose (three runtimes, no shared import
  // path): plugin-sync.ts projects it, renderer/global.d.ts types it for the preload bridge, the
  // settings plugin mirrors it structurally. A field added to two of the three would leave the
  // renderer's wire type silently missing it — this is the FIELD gate the name-set gate could not be.
  const repoRoot = join(import.meta.dirname, '..', '..', '..', '..')
  const desktopFields = interfaceFields(interfaceBody(
    readFileSync(join(import.meta.dirname, '..', '..', 'plugin-sync.ts'), 'utf8'), 'ChamberHostPackageState'))
  const rendererFields = interfaceFields(interfaceBody(
    readFileSync(join(repoRoot, 'packages', 'renderer', 'src', 'global.d.ts'), 'utf8'), 'ChamberHostPackageState'))
  const clientFields = interfaceFields(interfaceBody(
    readFileSync(join(repoRoot, 'packages', 'dsh-chamber-client-ui-settings-connections', 'src', 'client',
      'plugin-inventory-text.ts'), 'utf8'), 'ChamberPackageState'))
  assert.deepEqual([...desktopFields].sort(), [...rendererFields].sort(),
    'renderer/global.d.ts must declare exactly the desktop projection fields')
  // The FOURTH declaration (preload.cts) is pinned to the renderer copy by ipc-surface-mirror.test.ts,
  // so the two gates together cover all four. The client plugin legitimately omits `probe` (unused by
  // its projection; the omission keeps that module plain-node importable), so it is a SUBSET, never a superset.
  const clientOnly = clientFields.filter(field => !desktopFields.includes(field))
  assert.deepEqual(clientOnly, [], 'the client mirror must not invent fields the desktop never projects')
  assert.deepEqual(desktopFields.filter(field => !clientFields.includes(field)), ['probe'])
})
