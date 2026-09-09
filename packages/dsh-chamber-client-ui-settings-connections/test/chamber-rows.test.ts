/**
 * deriveChamberRows (plugin-inventory-text.ts) — the chamber table's full
 * input matrix, plain node:test with no dsh and no React.
 *
 * WHY this file exists (2026-09 P1 round): the row derivation used to live
 * inline in PluginDialog.tsx with NO test, and one untested branch read the
 * WRONG manifest source for the LOCAL target (the desktop's projection instead
 * of the instance's own profile manifest). Every data-source rule the
 * component relies on is pinned here: per-target expected/local/version
 * sources, the ssh remote-probe preference, the gateway seed-cache states, the
 * empty-expected-list honesty rule, and the inventory-derived chamber CLIENT
 * rows (P2.7 — never a hardcoded package name).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ARCHIVE_CLEANUP_PACKAGE,
  GIT_WORKTREE_PACKAGE,
  HOST_GRAPH_PACKAGE,
  MOBILE_PACKAGE,
  classifyChamberClientPlugin,
  deriveChamberRows,
  type ChamberPackageState,
  type ChamberRowDescriptor,
} from '../src/client/plugin-inventory-text.ts'

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
  const rows = deriveChamberRows({
    target: 'local',
    expected: LOCAL_MANIFEST,
    // The desktop-side projection is a DIFFERENT read: it must be ignored for
    // the local target (the regression this file pins).
    localManifestChamber: POISON,
    remoteChamber: null,
    inventory: null,
    seedCache: null,
    localSideFailed: false,
  })
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
  const rows = deriveChamberRows({
    target: 'local',
    expected: null,
    localManifestChamber: LOCAL_MANIFEST,
    remoteChamber: null,
    inventory: null,
    seedCache: {},
    localSideFailed: true,
  })
  assert.deepEqual(rows, [], 'an empty expected list must not fabricate rows from another source')
})

/* ---- ssh: remote probe preferred, desktop projection as the local column ---- */

test('ssh: the remote probe list wins over the caller expected list, and the local column reads the desktop projection', () => {
  const rows = deriveChamberRows({
    target: 'ssh',
    expected: POISON,
    localManifestChamber: LOCAL_MANIFEST,
    remoteChamber: { ok: true, packages: [pkg(HOST_GRAPH_PACKAGE, INJECTED), pkg(GIT_WORKTREE_PACKAGE, HALF)] },
    inventory: null,
    seedCache: null,
    localSideFailed: false,
  })
  assert.deepEqual(rows.map(row => row.name), [HOST_GRAPH_PACKAGE, GIT_WORKTREE_PACKAGE])
  assert.deepEqual(byName(rows, HOST_GRAPH_PACKAGE).remoteBadge, { labelKey: 'chamberBadgeLive', tone: 'ok' })
  assert.deepEqual(byName(rows, GIT_WORKTREE_PACKAGE).remoteBadge, { labelKey: 'chamberBadgeInjected', tone: 'warn' },
    'installed without the patched row is a half-injected warn, never live')
  assert.deepEqual(byName(rows, HOST_GRAPH_PACKAGE).localBadge, { labelKey: 'chamberBadgeInjected', tone: 'ok' })
  assert.equal(byName(rows, HOST_GRAPH_PACKAGE).versionText, 'v1.2.3', 'the REMOTE version, not the local one')
  assert.equal(byName(rows, GIT_WORKTREE_PACKAGE).versionText, 'v1.2.3')
})

test('ssh: a failed probe keeps the caller list visible and every remote badge unknown', () => {
  const rows = deriveChamberRows({
    target: 'ssh',
    expected: LOCAL_MANIFEST,
    localManifestChamber: LOCAL_MANIFEST,
    remoteChamber: { ok: false, error: 'ssh exec failed' },
    inventory: null,
    seedCache: null,
    localSideFailed: false,
  })
  assert.equal(rows.length, LOCAL_MANIFEST.length, 'a remote-only read failure must not empty the table')
  for (const row of rows) {
    assert.deepEqual(row.remoteBadge, { labelKey: 'chamberBadgeUnknown', tone: 'warn' },
      'an unreadable remote probe is a degradation, never a "not injected" claim')
  }
})

test('ssh: an absent local projection leaves the local column unknown (failed read) or muted (still loading)', () => {
  const failed = deriveChamberRows({
    target: 'ssh',
    expected: [pkg(HOST_GRAPH_PACKAGE, INJECTED)],
    localManifestChamber: null,
    remoteChamber: { ok: true, packages: [pkg(HOST_GRAPH_PACKAGE, INJECTED)] },
    inventory: null,
    seedCache: null,
    localSideFailed: true,
  })
  assert.deepEqual(byName(failed, HOST_GRAPH_PACKAGE).localBadge, { labelKey: 'chamberBadgeUnknown', tone: 'warn' })
  const loading = deriveChamberRows({
    target: 'ssh',
    expected: [pkg(HOST_GRAPH_PACKAGE, INJECTED)],
    localManifestChamber: null,
    remoteChamber: { ok: true, packages: [pkg(HOST_GRAPH_PACKAGE, INJECTED)] },
    inventory: null,
    seedCache: null,
    localSideFailed: false,
  })
  assert.deepEqual(byName(loading, HOST_GRAPH_PACKAGE).localBadge, { labelKey: 'chamberBadgeUnknown', tone: 'muted' })
})

/* ---- gateway: desktop projection + seed-cache comparison + client rows ---- */

function gatewayRows(over: Partial<Parameters<typeof deriveChamberRows>[0]> = {}): ChamberRowDescriptor[] {
  return deriveChamberRows({
    target: 'gateway',
    expected: LOCAL_MANIFEST,
    localManifestChamber: LOCAL_MANIFEST,
    remoteChamber: null,
    inventory: null,
    seedCache: null,
    localSideFailed: false,
    ...over,
  })
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
  const rows = deriveChamberRows({
    target: 'http',
    expected: LOCAL_MANIFEST,
    localManifestChamber: LOCAL_MANIFEST,
    remoteChamber: null,
    inventory: { entries: [{ moduleName: HOST_GRAPH_PACKAGE, enabled: true, fiberPhase: 'active' }] },
    seedCache: null,
    localSideFailed: false,
  })
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
    const rows = deriveChamberRows({
      target,
      expected: [],
      localManifestChamber: [],
      remoteChamber: null,
      inventory: null,
      seedCache: null,
      localSideFailed: false,
    })
    assert.deepEqual(rows.filter(row => row.name !== null), [], `${target} with an empty expected list`)
    // The gateway's inventory-derived client row is independent of the
    // registry list: with no inventory it is the single unknown-state row.
    assert.equal(rows.filter(row => row.name === null).length, target === 'gateway' ? 1 : 0)
  }
})
