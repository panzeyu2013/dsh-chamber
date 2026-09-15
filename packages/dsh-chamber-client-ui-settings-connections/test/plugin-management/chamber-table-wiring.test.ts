import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const TEST_DIR = dirname(fileURLToPath(import.meta.url))
const dialogSource = readFileSync(join(TEST_DIR, '..', '..', 'src', 'client', 'PluginDialog.tsx'), 'utf8')
const inventoryTextSource = readFileSync(join(TEST_DIR, '..', '..', 'src', 'client', 'plugin-inventory-text.ts'), 'utf8')
const localesSource = readFileSync(join(TEST_DIR, '..', '..', 'src', 'locales.ts'), 'utf8')

/** A source window around a marker (JSX call sites are matched in context). */
function window(marker: string, before = 900, after = 900): string {
  const index = dialogSource.indexOf(marker)
  assert.notEqual(index, -1, `PluginDialog.tsx no longer contains: ${marker}`)
  return dialogSource.slice(Math.max(0, index - before), index + after)
}

/**
 * Chamber-table wiring drift (design 13 §6 / design 20 §6 / design 21 §6.6;
 * 2026-12 user decision + review): a local-shape-only registry row is LISTED
 * for the local target only and omitted on every remote target, and the ssh
 * gates/columns read the same applicability-filtered, desktop-projection data
 * the table does.
 *
 * The derivations themselves are covered behaviourally — `deriveChamberRows` /
 * `applicableChamberPackages` / `sshChamberGates` in plugin-inventory-text.ts by
 * plugin-inventory-text.test.ts + chamber-rows.test.ts. What this file pins is
 * the DIALOG's half: PluginDialog.tsx is a React component this DOM-free suite
 * cannot render, so its wiring is pinned at the SOURCE level (the same lockstep
 * discipline as runtime-gate-wiring.test.ts / installed-fence-wiring.test.ts).
 * Each assertion is a regression that was real:
 *
 * 1. `remoteNeedsSeed` iterated the remote probe's RAW package list. The probe
 *    reports a `localOnly` row as a synthesized `installed:false` WITHOUT ever
 *    asking the remote (plugin-sync.ts), so `some(pkg => !(installed &&
 *    patched))` was true whenever the probe succeeded — the 「注入」 button
 *    showed over a fully seeded remote, forever, and the restart branch was
 *    unreachable. Both gates now come from the pure `sshChamberGates`, which
 *    owns that filter; the component must not read `sshRemoteChamber.packages`
 *    itself.
 * 2. For ssh the 本地 column and the probe-failure fallback were dead: the
 *    dedicated desktop-projection read is gated on a gateway/http `sourceId`,
 *    so `localManifestChamber` was permanently null there (未知 forever, empty
 *    table when the probe failed). The ssh arm must seed both from the local
 *    manifest `loadSync` already fetched.
 * 3. The retired rendering of that row ("local shape only" in both state
 *    columns) must not come back through a re-added locale key: the decision is
 *    that the row does not exist on a non-local target.
 */

test('the ssh gates come from the pure projection, never from the raw probe package list', () => {
  assert.ok(
    dialogSource.includes('sshChamberGates(sshRemoteChamber)'),
    'the ssh gates must be derived by the shared pure projection',
  )
  const gates = window('const sshGates = sshChamberGates(sshRemoteChamber)', 600, 600)
  assert.ok(gates.includes('const remoteNeedsSeed = isSsh && sshGates.needsSeed'),
    'the 注入 gate must read the derived needsSeed')
  assert.ok(gates.includes('const remoteInjectedNotLive = isSsh && sshGates.injectedNotLive'),
    'the restart-pending gate must read the derived injectedNotLive')
  // Line-based, not a single literal: ANY line that reaches a remote probe or
  // manifest package list is the regression (the synthesized localOnly row is
  // inside it), including a re-spelled `remoteManifest?.chamber.packages`.
  const packageListLines = dialogSource.split('\n')
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(entry => /\.packages\b/.test(entry.line))
  assert.ok(packageListLines.length > 0, 'the guard found no package-list read at all — it would be vacuous')
  for (const entry of packageListLines) {
    assert.equal(
      /remoteManifest|sshRemoteChamber/.test(entry.line),
      false,
      `PluginDialog.tsx:${entry.number} reads the remote probe/manifest package list`,
    )
  }
})

test('loadSync commits the desktop and remote manifests BEFORE the remote-error early returns', () => {
  // The chamber zone renders in EVERY phase, so an ssh error path that returns
  // before committing these states leaves the table empty (and the gates
  // silent) even though both reads answered (2026-12 review).
  const localCommit = dialogSource.indexOf('setLocalManifest(localRes.manifest)')
  const remoteRead = dialogSource.indexOf('const remoteRes = await pluginList(sshSpec.id)')
  assert.notEqual(localCommit, -1, 'the local manifest is no longer committed')
  assert.notEqual(remoteRead, -1, 'the remote read moved')
  assert.ok(localCommit < remoteRead,
    'the desktop projection must be committed before the remote read, so a remote failure cannot discard it')
  const remoteCommit = dialogSource.indexOf('setRemoteManifest(remoteRes.manifest)')
  const parseErrorReturn = dialogSource.indexOf('remoteRes.manifest.error !== undefined')
  assert.notEqual(remoteCommit, -1, 'the remote manifest is no longer committed')
  assert.notEqual(parseErrorReturn, -1, 'the unparseable-remote-profile guard moved')
  assert.ok(remoteCommit < parseErrorReturn,
    'the probed chamber block must survive the unparseable-manifest error path')
})

test('the ssh arm seeds its local column and probe-failure fallback from the desktop projection loadSync fetched', () => {
  const desktop = window('const desktopChamberPackages =', 400, 700)
  assert.ok(desktop.includes('isSsh && localManifest !== null && localManifest.chamber.ok === true'),
    'ssh must read the local manifest the sync load already holds (no extra IPC)')
  assert.ok(desktop.includes(': localChamberPackages'),
    'gateway/http keep the dedicated projection read')
  const derivation = window('const chamberRows: ChamberRowDescriptor[] = deriveChamberRows({', 0, 900)
  assert.ok(derivation.includes(': desktopChamberPackages'), 'the expected list falls back to it')
  assert.ok(derivation.includes('localManifestChamber: desktopChamberPackages'),
    'the 本地 column reads it too')
})

test('the table rows are derived by the pure projection, not reassembled from the probe', () => {
  const rows = window('const chamberRows: ChamberRowDescriptor[] = deriveChamberRows({')
  assert.ok(rows.includes('remoteChamber: isSsh ? (sshRemoteChamber ?? null) : null'),
    'ssh still prefers the remote probe list; the derivation drops non-applicable rows itself')
})

test('the LOCAL-side projection is filtered by the same applicability rule', () => {
  // Inert TODAY (the omitted row is never rendered, and the only extra internal
  // delta — one gateway drift-map key — is read by no row), which is exactly
  // why no behavioural test can catch its removal (2026-12 verification gap
  // G2). The invariant still matters: no target-level structure may carry a row
  // that target can never have, so it is pinned at the source.
  assert.ok(inventoryTextSource.includes('applicableChamberPackages(target, localManifestChamber)'),
    'deriveChamberRows must run the local-side projection through the same filter')
})

test('the retired "local shape only" badge is gone from both the projection and the locale dictionaries', () => {
  // A re-added key would restore the rendering this decision retired; the two
  // state columns said the same sentence on every remote target.
  assert.equal(inventoryTextSource.includes('chamberBadgeLocalOnly'), false)
  assert.equal(localesSource.includes('chamberBadgeLocalOnly'), false)
  assert.equal(localesSource.includes('本地形态专用'), false)
  assert.equal(localesSource.includes('Local shape only'), false)
})
