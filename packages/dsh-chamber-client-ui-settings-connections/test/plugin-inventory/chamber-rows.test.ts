/**
 * deriveChamberRows (plugin-inventory-text.ts) — the chamber table's full input
 * matrix, plain node:test with no dsh and no React. Every data-source rule the
 * component relies on is pinned here: per-target expected/local/version sources,
 * the ssh remote-probe preference, the gateway seed-cache states, the
 * empty-expected-list honesty rule, and the inventory-derived chamber CLIENT rows
 * (P2.7 — never a hardcoded package name).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ARCHIVE_CLEANUP_PACKAGE,
  GIT_WORKTREE_PACKAGE,
  HOST_GRAPH_PACKAGE,
  MOBILE_PACKAGE,
  OPEN_IN_PACKAGE,
  chamberSeedDrift,
  classifyChamberClientPlugin,
  classifyInventoryEntry,
  deriveChamberRows,
  type ChamberPackageState,
  type ChamberRowDescriptor,
} from '../../src/client/plugin-inventory-text.ts'

function pkg(name: string, over: Partial<ChamberPackageState> = {}): ChamberPackageState {
  return { insertId: `insert:${name}`, name, installed: false, patched: false, version: null, live: null, ...over }
}

/** Injected + patched + live, version 1.2.3 (the strongest local claim). */
const INJECTED = { installed: true, patched: true, version: '1.2.3', live: true }
/** Installed but the boot row is missing (half-injected). */
const HALF = { installed: true, patched: false, version: '1.2.3', live: null }

const LOCAL_MANIFEST = [
  pkg(HOST_GRAPH_PACKAGE, INJECTED),
  pkg(GIT_WORKTREE_PACKAGE, { installed: true, patched: true, version: '1.2.3', live: false }),
  pkg(ARCHIVE_CLEANUP_PACKAGE, HALF),
]
/** A DIFFERENT read of the same registry: nothing installed, version 9.9.9.
 *  Used to prove which target reads which source. */
const POISON = [pkg(HOST_GRAPH_PACKAGE, { installed: false, patched: false, version: '9.9.9', live: null })]

function byName(rows: readonly ChamberRowDescriptor[], name: string): ChamberRowDescriptor {
  const row = rows.find(candidate => candidate.name === name)
  assert.ok(row !== undefined, `row for ${name}`)
  return row
}

/* ---- local: its OWN profile manifest is the only source ---- */

test('local: expected + local column + version all come from the instance own profile manifest', () => {
  const rows = deriveChamberRows({ target: 'local', expected: LOCAL_MANIFEST,
    // The desktop-side projection is a DIFFERENT read: it must be ignored for
    // the local target (the regression this file pins).
    localManifestChamber: POISON, remoteChamber: null, inventory: null, seedCache: null, localSideFailed: false })
  assert.deepEqual(rows.map(row => row.name), [HOST_GRAPH_PACKAGE, GIT_WORKTREE_PACKAGE, ARCHIVE_CLEANUP_PACKAGE])
  assert.deepEqual(byName(rows, HOST_GRAPH_PACKAGE).localBadge, { labelKey: 'chamberBadgeInjected', tone: 'ok' })
  assert.equal(byName(rows, HOST_GRAPH_PACKAGE).versionText, 'v1.2.3', 'the poisoned 9.9.9 never leaks into a local row')
  assert.deepEqual(byName(rows, ARCHIVE_CLEANUP_PACKAGE).localBadge, { labelKey: 'chamberBadgeNotInjected', tone: 'muted' },
    'installed without the patched boot row is not an injected claim')
  assert.equal(byName(rows, ARCHIVE_CLEANUP_PACKAGE).versionText, 'v1.2.3')
  // No remote surface, no gateway cache surface for the local target.
  for (const row of rows) {
    assert.equal(row.remoteBadge, null)
    assert.equal(row.cacheVersionText, null)
    assert.equal(row.cacheNotSynced, false)
    assert.equal(row.cacheAbsent, false)
    assert.equal(row.driftState, null)
  }
})

test('local: an unreadable own manifest yields NO rows and never claims a seed-cache state', () => {
  const rows = deriveChamberRows({ target: 'local', expected: null, localManifestChamber: LOCAL_MANIFEST,
    remoteChamber: null, inventory: null, seedCache: {}, localSideFailed: true })
  assert.deepEqual(rows, [], 'an empty expected list must not fabricate rows from another source')
})

/* ---- ssh: remote probe preferred, desktop projection as the local column ---- */

test('ssh: the remote probe list wins over the caller expected list, and the local column reads the desktop projection', () => {
  const rows = deriveChamberRows({ target: 'ssh', expected: POISON, localManifestChamber: LOCAL_MANIFEST,
    remoteChamber: { ok: true, packages: [pkg(HOST_GRAPH_PACKAGE, INJECTED), pkg(GIT_WORKTREE_PACKAGE, HALF)] },
    inventory: null, seedCache: null, localSideFailed: false })
  assert.deepEqual(rows.map(row => row.name), [HOST_GRAPH_PACKAGE, GIT_WORKTREE_PACKAGE])
  assert.deepEqual(byName(rows, HOST_GRAPH_PACKAGE).remoteBadge, { labelKey: 'chamberBadgeLive', tone: 'ok' })
  assert.deepEqual(byName(rows, GIT_WORKTREE_PACKAGE).remoteBadge, { labelKey: 'chamberBadgeInjected', tone: 'warn' },
    'installed without the patched row is a half-injected warn, never live')
  assert.deepEqual(byName(rows, HOST_GRAPH_PACKAGE).localBadge, { labelKey: 'chamberBadgeInjected', tone: 'ok' })
  assert.equal(byName(rows, HOST_GRAPH_PACKAGE).versionText, 'v1.2.3', 'the REMOTE version, not the local one')
  assert.equal(byName(rows, GIT_WORKTREE_PACKAGE).versionText, 'v1.2.3')
})

test('ssh: a failed probe keeps the caller list visible and every remote badge unknown', () => {
  const rows = deriveChamberRows({ target: 'ssh', expected: LOCAL_MANIFEST, localManifestChamber: LOCAL_MANIFEST,
    remoteChamber: { ok: false, error: 'ssh exec failed' }, inventory: null, seedCache: null, localSideFailed: false })
  assert.equal(rows.length, LOCAL_MANIFEST.length, 'a remote-only read failure must not empty the table')
  for (const row of rows) {
    assert.deepEqual(row.remoteBadge, { labelKey: 'chamberBadgeUnknown', tone: 'warn' },
      'an unreadable remote probe is a degradation, never a "not injected" claim')
  }
})

test('ssh: an absent local projection leaves the local column unknown (failed read) or muted (still loading)', () => {
  const failed = deriveChamberRows({ target: 'ssh', expected: [pkg(HOST_GRAPH_PACKAGE, INJECTED)],
    localManifestChamber: null, remoteChamber: { ok: true, packages: [pkg(HOST_GRAPH_PACKAGE, INJECTED)] },
    inventory: null, seedCache: null, localSideFailed: true })
  assert.deepEqual(byName(failed, HOST_GRAPH_PACKAGE).localBadge, { labelKey: 'chamberBadgeUnknown', tone: 'warn' })
  const loading = deriveChamberRows({ target: 'ssh', expected: [pkg(HOST_GRAPH_PACKAGE, INJECTED)],
    localManifestChamber: null, remoteChamber: { ok: true, packages: [pkg(HOST_GRAPH_PACKAGE, INJECTED)] },
    inventory: null, seedCache: null, localSideFailed: false })
  assert.deepEqual(byName(loading, HOST_GRAPH_PACKAGE).localBadge, { labelKey: 'chamberBadgeUnknown', tone: 'muted' })
})

/* ---- gateway: desktop projection + seed-cache comparison + client rows ---- */

function gatewayRows(over: Partial<Parameters<typeof deriveChamberRows>[0]> = {}): ChamberRowDescriptor[] {
  return deriveChamberRows({ target: 'gateway', expected: LOCAL_MANIFEST, localManifestChamber: LOCAL_MANIFEST,
    remoteChamber: null, inventory: null, seedCache: null, localSideFailed: false, ...over })
}

test('gateway: an unread seed cache renders no cache columns at all', () => {
  const rows = gatewayRows()
  const row = byName(rows, HOST_GRAPH_PACKAGE)
  assert.equal(row.cacheVersionText, null)
  assert.equal(row.cacheNotSynced, false)
  assert.equal(row.cacheAbsent, false)
  assert.equal(row.driftState, null, 'no cache read = no comparison, never a drift claim')
  assert.deepEqual(row.remoteBadge, { labelKey: 'chamberBadgeUnknown', tone: 'muted' },
    'an unavailable Loader snapshot is unknown, never "not injected"')
})

test('gateway: cache match / drift / per-row absent / whole-cache absent are four distinct states', () => {
  const match = byName(gatewayRows({
    seedCache: { [HOST_GRAPH_PACKAGE]: '1.2.3', [GIT_WORKTREE_PACKAGE]: '1.2.3', [ARCHIVE_CLEANUP_PACKAGE]: '1.2.3' },
  }), HOST_GRAPH_PACKAGE)
  assert.equal(match.cacheVersionText, 'v1.2.3')
  assert.equal(match.driftState, 'match')
  assert.equal(match.cacheNotSynced, false)
  assert.equal(match.cacheAbsent, false)

  const drift = byName(gatewayRows({
    seedCache: { [HOST_GRAPH_PACKAGE]: '1.2.4', [GIT_WORKTREE_PACKAGE]: '1.2.3', [ARCHIVE_CLEANUP_PACKAGE]: '1.2.3' },
  }), HOST_GRAPH_PACKAGE)
  assert.equal(drift.cacheVersionText, 'v1.2.4')
  assert.equal(drift.driftState, 'drift')
  assert.equal(drift.cacheNotSynced, false, 'a cached-but-different package is drift, not "not synced"')

  // One package missing from a NON-empty cache: per-row 未同步.
  const partial = gatewayRows({
    seedCache: { [HOST_GRAPH_PACKAGE]: '1.2.3', [GIT_WORKTREE_PACKAGE]: '1.2.3' },
  })
  const absentRow = byName(partial, ARCHIVE_CLEANUP_PACKAGE)
  assert.equal(absentRow.cacheVersionText, null)
  assert.equal(absentRow.cacheNotSynced, true)
  assert.equal(absentRow.cacheAbsent, false)
  assert.equal(absentRow.driftState, 'absent-cache')

  // The WHOLE cache absent: the zone status line speaks instead of three
  // per-row 未同步 markers. (Registry rows only — the derived client row has
  // no cache dimension.)
  const wholeAbsent = gatewayRows({ seedCache: {} }).filter(row => row.name !== null)
  assert.equal(wholeAbsent.length, LOCAL_MANIFEST.length)
  for (const row of wholeAbsent) {
    assert.equal(row.cacheAbsent, true)
    assert.equal(row.cacheNotSynced, false)
  }
})

test('gateway: an unknown LOCAL version beside a cached row is absent-local, never a mismatch claim', () => {
  // Moved from the deleted chamber-seed-drift.test.ts (2026-12 trim): the
  // unreadable-manifest state and the pure comparison's representation rules.
  const rows = gatewayRows({
    localManifestChamber: [
      pkg(HOST_GRAPH_PACKAGE, { ...INJECTED, version: null }),
      pkg(GIT_WORKTREE_PACKAGE, INJECTED),
      pkg(ARCHIVE_CLEANUP_PACKAGE, INJECTED),
    ],
    seedCache: { [HOST_GRAPH_PACKAGE]: '1.2.3' },
  })
  const row = byName(rows, HOST_GRAPH_PACKAGE)
  assert.equal(row.driftState, 'absent-local', 'no local version = no drift claim')
  assert.equal(row.cacheVersionText, 'v1.2.3')
  assert.equal(row.cacheNotSynced, false)
  // The pure comparison keeps the same states, ignores unknown cache names
  // and treats a null cache row as absent-cache (never-synced row).
  assert.deepEqual(
    chamberSeedDrift([{ name: HOST_GRAPH_PACKAGE, version: null }],
      { [HOST_GRAPH_PACKAGE]: '1.2.3', '@dsh-chamber/unrelated': '9.9.9' }),
    { [HOST_GRAPH_PACKAGE]: 'absent-local' },
  )
  assert.deepEqual(
    chamberSeedDrift([{ name: HOST_GRAPH_PACKAGE, version: '1.0.0' }], { [HOST_GRAPH_PACKAGE]: null }),
    { [HOST_GRAPH_PACKAGE]: 'absent-cache' },
  )
  assert.deepEqual(chamberSeedDrift([], { [HOST_GRAPH_PACKAGE]: '1.0.0' }), {})
})

test('gateway: an EMPTY expected list never claims the seed cache is absent', () => {
  const rows = gatewayRows({ expected: null, localManifestChamber: null, seedCache: {} })
  assert.deepEqual(rows.filter(row => row.name !== null), [],
    'no expected packages = no registry rows, and no "nothing synced" claim')
  // The derivation-level flag is what the zone line reads.
  assert.equal(rows.some(row => row.cacheAbsent), false)
})

test('gateway: the remote badge comes from the Loader inventory when it is available', () => {
  const rows = gatewayRows({
    inventory: {
      entries: [
        { moduleName: HOST_GRAPH_PACKAGE, enabled: true, fiberPhase: 'active' },
        { moduleName: GIT_WORKTREE_PACKAGE, enabled: true, fiberPhase: 'failed' },
        { moduleName: ARCHIVE_CLEANUP_PACKAGE, enabled: false, fiberPhase: 'active' },
      ],
    },
  })
  assert.deepEqual(byName(rows, HOST_GRAPH_PACKAGE).remoteBadge, { labelKey: 'chamberBadgeLive', tone: 'ok' })
  assert.deepEqual(byName(rows, GIT_WORKTREE_PACKAGE).remoteBadge, { labelKey: 'chamberBadgeFailed', tone: 'danger' })
  assert.deepEqual(byName(rows, ARCHIVE_CLEANUP_PACKAGE).remoteBadge, { labelKey: 'chamberBadgeInjected', tone: 'muted' },
    'a disabled entry claims presence only')
})

/* ---- P2.7: inventory-derived chamber CLIENT rows (no hardcoded package) ---- */

test('classifyChamberClientPlugin: the chamber client scope is classified by name, not by a literal list', () => {
  assert.equal(classifyChamberClientPlugin(MOBILE_PACKAGE), 'chamber-mobile')
  assert.equal(classifyChamberClientPlugin(`cordis:include ${MOBILE_PACKAGE}`), 'chamber-mobile')
  assert.equal(classifyChamberClientPlugin('@dsh-chamber/dsh-client-ui-sidebar'), 'chamber-client')
  assert.equal(classifyChamberClientPlugin(HOST_GRAPH_PACKAGE), null)
  assert.equal(classifyChamberClientPlugin('@dsh-chamber/user-tool'), null)
  assert.equal(classifyChamberClientPlugin('my-third-party-plugin'), null)
})

test('gateway: client rows are derived from the inventory, never from a hardcoded name', () => {
  const rows = gatewayRows({
    inventory: {
      entries: [
        // The gateway reports its packaged client entry under the raw
        // cordis patch-insert syntax (plan 24 D7-A).
        { moduleName: `cordis:include ${MOBILE_PACKAGE}`, enabled: true, fiberPhase: 'active' },
        { moduleName: '@dsh-chamber/user-tool', enabled: true, fiberPhase: 'active' },
        // A duplicate report of the same package (plain form) collapses.
        { moduleName: MOBILE_PACKAGE, enabled: false, fiberPhase: 'failed' },
      ],
    },
  })
  const clientRows = rows.filter(row => row.nameLabelKey !== null)
  assert.equal(clientRows.length, 1, 'one row per chamber client package')
  const mobile = clientRows[0]!
  assert.equal(mobile.name, MOBILE_PACKAGE, 'the name comes from the inventory entry')
  assert.equal(mobile.key, `chamber-client:${MOBILE_PACKAGE}`)
  assert.equal(mobile.nameLabelKey, 'chamberMobileRow')
  assert.equal(mobile.versionHintKey, 'chamberMobileHint')
  assert.equal(mobile.versionText, null)
  assert.equal(mobile.localBadge, null, 'a gateway client row has no local column')
  assert.deepEqual(mobile.remoteBadge, { labelKey: 'chamberBadgeLive', tone: 'ok' },
    'the first (enabled + active) report decides; a duplicate does not flip it to failed')
  assert.equal(rows.some(row => row.name === '@dsh-chamber/user-tool'), false,
    'third-party entries are never chamber rows')
})

test('gateway: a generic chamber client plugin is a chamber row with no invented label', () => {
  const rows = gatewayRows({
    inventory: { entries: [{ moduleName: '@dsh-chamber/dsh-client-ui-sidebar', enabled: true, fiberPhase: 'active' }] },
  })
  const clientRows = rows.filter(row => row.nameLabelKey !== null || row.name?.startsWith('@dsh-chamber/dsh-client-ui-') === true)
  assert.equal(clientRows.length, 1)
  assert.equal(clientRows[0]!.name, '@dsh-chamber/dsh-client-ui-sidebar')
  assert.equal(clientRows[0]!.nameLabelKey, null, 'only the packaged mobile entry has dedicated copy')
  assert.equal(clientRows[0]!.versionHintKey, null)
})

test('gateway: an unavailable inventory renders ONE unknown-state client row, never a hardcoded name', () => {
  const rows = gatewayRows({ inventory: null })
  const unknown = rows.filter(row => row.name === null)
  assert.equal(unknown.length, 1)
  assert.equal(unknown[0]!.key, 'chamber-client-unknown')
  assert.equal(unknown[0]!.nameLabelKey, 'chamberMobileRow')
  assert.deepEqual(unknown[0]!.remoteBadge, { labelKey: 'chamberBadgeUnknown', tone: 'muted' })
  assert.equal(rows.some(row => row.name === MOBILE_PACKAGE), false,
    'the literal package name must never appear without an inventory fact')
})

test('gateway: a readable inventory with NO chamber client entry renders ONE muted 未注入 row', () => {
  // The old hardcoded row showed 未注入 in exactly this state (review G2-6):
  // rendering NOTHING at all would let a dropped/disabled client package look
  // like "no such row exists". Still never a hardcoded package name.
  const rows = gatewayRows({ inventory: { entries: [] } })
  const clientRows = rows.filter(row => row.nameLabelKey !== null)
  assert.equal(clientRows.length, 1, 'one absent-state client row, never zero')
  assert.equal(clientRows[0]!.key, 'chamber-client-absent')
  assert.equal(clientRows[0]!.name, null, 'an absent row never names a package')
  assert.equal(clientRows[0]!.nameLabelKey, 'chamberMobileRow')
  assert.deepEqual(clientRows[0]!.remoteBadge, { labelKey: 'chamberBadgeNotInjected', tone: 'muted' })
  assert.equal(rows.some(row => row.name === MOBILE_PACKAGE), false,
    'the literal package name must never appear without an inventory fact')
})

/* ---- http: read-only Loader view, no cache and no client rows ---- */

test('http: the local column and version read the desktop projection; the remote badge reads the inventory', () => {
  const rows = deriveChamberRows({ target: 'http', expected: LOCAL_MANIFEST, localManifestChamber: LOCAL_MANIFEST,
    remoteChamber: null, inventory: { entries: [{ moduleName: HOST_GRAPH_PACKAGE, enabled: true, fiberPhase: 'active' }] },
    seedCache: null, localSideFailed: false })
  const row = byName(rows, HOST_GRAPH_PACKAGE)
  assert.equal(row.versionText, 'v1.2.3')
  assert.deepEqual(row.remoteBadge, { labelKey: 'chamberBadgeLive', tone: 'ok' })
  assert.deepEqual(byName(rows, ARCHIVE_CLEANUP_PACKAGE).remoteBadge, { labelKey: 'chamberBadgeNotInjected', tone: 'muted' })
  for (const candidate of rows) {
    assert.equal(candidate.cacheVersionText, null)
    assert.equal(candidate.cacheAbsent, false)
  }
  assert.equal(rows.some(candidate => candidate.nameLabelKey !== null), false,
    'client rows are gateway-only')
})

test('every target: an empty expected list yields no REGISTRY rows', () => {
  for (const target of ['local', 'ssh', 'gateway', 'http'] as const) {
    const rows = deriveChamberRows({ target, expected: [], localManifestChamber: [], remoteChamber: null,
      inventory: null, seedCache: null, localSideFailed: false })
    assert.deepEqual(rows.filter(row => row.name !== null), [], `${target} with an empty expected list`)
    // The gateway's inventory-derived client row is independent of the
    // registry list: with no inventory it is the single unknown-state row.
    assert.equal(rows.filter(row => row.name === null).length, target === 'gateway' ? 1 : 0)
  }
})

/* ---- localOnly registry rows (design 20 §6; 2026-12 user decision): listed on
 * the LOCAL target only, OMITTED everywhere else — a per-target table must not
 * list a row that no action on that target could ever produce. ---- */

/** The registry's four rows as the desktop projects them (open-in flagged). */
const FOUR_ROWS = [
  ...LOCAL_MANIFEST,
  pkg(OPEN_IN_PACKAGE, { ...INJECTED, localOnly: true }),
]

test('local: a localOnly registry row is an ORDINARY row there — its state is real on the one shape it applies to', () => {
  const rows = deriveChamberRows({ target: 'local', expected: FOUR_ROWS, localManifestChamber: POISON,
    remoteChamber: null, inventory: null, seedCache: null, localSideFailed: false })
  assert.deepEqual(rows.map(row => row.name),
    [HOST_GRAPH_PACKAGE, GIT_WORKTREE_PACKAGE, ARCHIVE_CLEANUP_PACKAGE, OPEN_IN_PACKAGE],
    'the local target lists all four registry rows')
  assert.deepEqual(byName(rows, OPEN_IN_PACKAGE).localBadge, { labelKey: 'chamberBadgeInjected', tone: 'ok' })
  assert.equal(byName(rows, OPEN_IN_PACKAGE).versionText, 'v1.2.3')
})

test('ssh/gateway/http: a localOnly registry row is OMITTED, never badged — no state, no version, no sync marker', () => {
  // Both sources carry the row on purpose: the desktop projection (expected /
  // localManifestChamber) and the ssh probe's synthesized installed:false row.
  // Neither may turn it into a table row on a target that can never seed it.
  const localOnlyProbe = pkg(OPEN_IN_PACKAGE, { installed: false, patched: false, live: null, localOnly: true })
  for (const target of ['ssh', 'gateway', 'http'] as const) {
    const rows = deriveChamberRows({ target, expected: FOUR_ROWS, localManifestChamber: FOUR_ROWS,
      remoteChamber: target === 'ssh' ? { ok: true, packages: [...LOCAL_MANIFEST, localOnlyProbe] } : null,
      inventory: null, seedCache: null, localSideFailed: false })
    const registryRows = rows.filter(row => row.name !== null)
    assert.deepEqual(registryRows.map(row => row.name),
      [HOST_GRAPH_PACKAGE, GIT_WORKTREE_PACKAGE, ARCHIVE_CLEANUP_PACKAGE],
      `${target}: the applicable registry rows only (design 20 §6: 3)`)
    assert.equal(rows.some(row => row.name === OPEN_IN_PACKAGE), false,
      `${target}: a row that cannot exist here is not rendered as a state`)
  }
})

test('ssh: the synthesized localOnly probe row speaks for nothing — the probed rows keep their own states', () => {
  const rows = deriveChamberRows({ target: 'ssh', expected: FOUR_ROWS, localManifestChamber: FOUR_ROWS,
    remoteChamber: { ok: true, packages: [
      pkg(HOST_GRAPH_PACKAGE, INJECTED), pkg(GIT_WORKTREE_PACKAGE, HALF), pkg(OPEN_IN_PACKAGE, { localOnly: true }),
    ] },
    inventory: null, seedCache: null, localSideFailed: false })
  assert.deepEqual(rows.map(row => row.name), [HOST_GRAPH_PACKAGE, GIT_WORKTREE_PACKAGE])
  assert.deepEqual(byName(rows, HOST_GRAPH_PACKAGE).remoteBadge, { labelKey: 'chamberBadgeLive', tone: 'ok' })
  assert.deepEqual(byName(rows, GIT_WORKTREE_PACKAGE).remoteBadge, { labelKey: 'chamberBadgeInjected', tone: 'warn' },
    'the half-injected warn belongs to the probed row, not to the omitted one')
})

test('gateway: the omitted localOnly row is outside the cache accounting too', () => {
  const rows = gatewayRows({
    expected: FOUR_ROWS,
    localManifestChamber: FOUR_ROWS,
    seedCache: { [HOST_GRAPH_PACKAGE]: '1.2.3', [GIT_WORKTREE_PACKAGE]: '1.2.3', [ARCHIVE_CLEANUP_PACKAGE]: '1.2.3' },
  })
  assert.equal(rows.some(row => row.name === OPEN_IN_PACKAGE), false)
  const row = byName(rows, HOST_GRAPH_PACKAGE)
  assert.equal(row.cacheAbsent, false, 'three applicable packages cached is never "nothing synced"')
  assert.equal(row.cacheNotSynced, false)
  assert.equal(row.driftState, 'match')
})

/* ---- package-name lockstep: the client constants are hand-mirrored, so a host
 * rename must fail here instead of silently classifying a chamber row as
 * third-party. The control-plane registry is the authoritative declaration. ---- */
test('chamber package constants mirror the control-plane registry and the packaged mobile manifest', () => {
  const seed = readFileSync(join(import.meta.dirname, '../../../control-plane/src/host-graph-seed.ts'), 'utf8')
  const declared = [...seed.matchAll(/export const HOST_[A-Z_]+_PACKAGE_NAME = '([^']+)'/gu)].map(match => match[1]!)
  assert.deepEqual(
    [...declared].sort(),
    [HOST_GRAPH_PACKAGE, GIT_WORKTREE_PACKAGE, ARCHIVE_CLEANUP_PACKAGE, OPEN_IN_PACKAGE].sort(),
    'a NEW registry host package must be mirrored by the client constants',
  )
  for (const name of declared) {
    assert.notEqual(classifyInventoryEntry(name), 'third-party',
      `registry host package ${name} must classify as a chamber row, or a non-local target would list it as third-party`)
  }
  const manifest = JSON.parse(
    readFileSync(join(import.meta.dirname, '../../../dsh-chamber-client-ui-mobile/package.json'), 'utf8'),
  ) as { name?: unknown }
  assert.equal(manifest.name, MOBILE_PACKAGE, 'the packaged mobile manifest name and the client constant must stay in lockstep')
})
