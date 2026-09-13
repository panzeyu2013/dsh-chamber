/**
 * plugin-inventory-text.ts pure display projections (plain node:test, no
 * dsh, no React): the entry classification (plan 24 D7-A — the gateway's
 * cordis.patch.yml insert rows are reported by the host inventory under
 * the raw 'cordis:include <name>' patch syntax; the mobile packaged entry
 * is a chamber row, never third-party), the chamber row badge mappings
 * (plan 24 B1.5 — local manifest truth + remote live-Loader state badge-
 * ized into {labelKey, tone}) and the third-party row live-state chips
 * (Loader-snapshot derived 生效状态 for the local/gateway/http installed
 * lists — liveness only from an enabled + active fiber, a missing entry
 * claims a restart, and an unreadable snapshot stays neutral).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PluginInventorySnapshot } from '../src/client/plugin-inventory-api.ts'
import {
  ARCHIVE_CLEANUP_PACKAGE,
  GIT_WORKTREE_PACKAGE,
  HOST_GRAPH_PACKAGE,
  MOBILE_PACKAGE,
  OPEN_IN_PACKAGE,
  applicableChamberPackages,
  classifyInventoryEntry,
  installedRowLiveState,
  localChamberBadge,
  remoteChamberBadge,
  sshChamberGates,
  thirdPartyEntries,
  thirdPartyLiveState,
} from '../src/client/plugin-inventory-text.ts'

test('classifyInventoryEntry: plain module names map to their package class', () => {
  assert.equal(classifyInventoryEntry(HOST_GRAPH_PACKAGE), 'chamber-host-graph')
  assert.equal(classifyInventoryEntry(GIT_WORKTREE_PACKAGE), 'chamber-git-worktree')
  assert.equal(classifyInventoryEntry(ARCHIVE_CLEANUP_PACKAGE), 'chamber-archive-cleanup')
  assert.equal(classifyInventoryEntry(OPEN_IN_PACKAGE), 'chamber-open-in')
  assert.equal(classifyInventoryEntry(MOBILE_PACKAGE), 'chamber-mobile')
  assert.equal(classifyInventoryEntry('@deepseek-ai/dsh-demo'), 'official')
  assert.equal(classifyInventoryEntry('@dsh-chamber/user-tool'), 'third-party')
  assert.equal(classifyInventoryEntry('my-third-party-plugin'), 'third-party')
})

test('classifyInventoryEntry: the raw cordis patch-insert prefix is stripped before matching', () => {
  assert.equal(classifyInventoryEntry(`cordis:include ${MOBILE_PACKAGE}`), 'chamber-mobile')
  assert.equal(classifyInventoryEntry(`cordis:include ${HOST_GRAPH_PACKAGE}`), 'chamber-host-graph')
  assert.equal(classifyInventoryEntry(`cordis:include ${GIT_WORKTREE_PACKAGE}`), 'chamber-git-worktree')
  assert.equal(classifyInventoryEntry(`cordis:include ${ARCHIVE_CLEANUP_PACKAGE}`), 'chamber-archive-cleanup')
  assert.equal(classifyInventoryEntry('cordis:include @deepseek-ai/dsh-demo'), 'official')
  assert.equal(classifyInventoryEntry('cordis:include my-third-party-plugin'), 'third-party')
  // The root include entry's own name carries no payload — without the
  // trailing space the prefix is not stripped and it stays third-party
  // (group entries never reach the inventory entries list anyway).
  assert.equal(classifyInventoryEntry('cordis:include'), 'third-party')
})

test('thirdPartyEntries: the chamber host packages and the mobile entry are excluded in both their raw patch-syntax and plain forms', () => {
  const snapshot: PluginInventorySnapshot = {
    entries: [
      { entryId: 'p1', moduleName: HOST_GRAPH_PACKAGE, enabled: true, fiberPhase: 'active' },
      { entryId: 'p2', moduleName: GIT_WORKTREE_PACKAGE, enabled: true, fiberPhase: 'active' },
      { entryId: 'p3', moduleName: `cordis:include ${MOBILE_PACKAGE}`, enabled: true, fiberPhase: 'active' },
      { entryId: 'p4', moduleName: MOBILE_PACKAGE, enabled: true, fiberPhase: 'active' },
      { entryId: 'p5', moduleName: 'cordis:include @deepseek-ai/dsh-demo', enabled: true, fiberPhase: 'active' },
      { entryId: 'p6', moduleName: '@dsh-chamber/user-tool', enabled: true, fiberPhase: 'loading' },
      { entryId: 'p7', moduleName: 'my-third-party-plugin', enabled: false, fiberPhase: 'failed' },
      // The third chamber host package (design 24) is a chamber row in both
      // report forms, never third-party.
      { entryId: 'p8', moduleName: ARCHIVE_CLEANUP_PACKAGE, enabled: true, fiberPhase: 'active' },
      { entryId: 'p9', moduleName: `cordis:include ${ARCHIVE_CLEANUP_PACKAGE}`, enabled: true, fiberPhase: 'active' },
      // The local-shape-only open-in row is no longer LISTED on a non-local
      // target (applicableChamberPackages), so this zone must exclude it by
      // CLASSIFICATION alone: an instance that somehow carries it (legacy seed
      // / manual install) is never reclassified as a third-party plugin.
      { entryId: 'p10', moduleName: OPEN_IN_PACKAGE, enabled: true, fiberPhase: 'active' },
    ],
  }
  const rows = thirdPartyEntries(snapshot)
  assert.deepEqual(rows.map(row => row.moduleName), ['@dsh-chamber/user-tool', 'my-third-party-plugin'])
})

test('thirdPartyEntries: the caller expected list excludes a registry package the literals do not know', () => {
  // A FUTURE registry package the literals do not know: the literal name
  // classification cannot know it, so it would leak into the http zone's
  // third-party list. The registry-derived expected list of the view is what
  // keeps that zone honest (review G2-5).
  const snapshot: PluginInventorySnapshot = {
    entries: [
      { entryId: 'p1', moduleName: '@dsh-chamber/dsh-host-future-domain', enabled: true, fiberPhase: 'active' },
      { entryId: 'p2', moduleName: 'cordis:include @dsh-chamber/dsh-host-future-domain', enabled: true, fiberPhase: 'active' },
      { entryId: 'p3', moduleName: '@dsh-chamber/user-tool', enabled: true, fiberPhase: 'loading' },
    ],
  }
  assert.deepEqual(
    thirdPartyEntries(snapshot).map(row => row.moduleName),
    ['@dsh-chamber/dsh-host-future-domain', 'cordis:include @dsh-chamber/dsh-host-future-domain', '@dsh-chamber/user-tool'],
    'without the expected list the unknown host package is classified third-party',
  )
  assert.deepEqual(
    thirdPartyEntries(snapshot, ['@dsh-chamber/dsh-host-future-domain']).map(row => row.moduleName),
    ['@dsh-chamber/user-tool'],
    'the registry-derived expected name excludes BOTH report forms',
  )
})

test('localChamberBadge: injected is positive, absent is muted, unreadable is a warn-unknown', () => {
  assert.deepEqual(localChamberBadge(true, false), { labelKey: 'chamberBadgeInjected', tone: 'ok' })
  assert.deepEqual(localChamberBadge(false, false), { labelKey: 'chamberBadgeNotInjected', tone: 'muted' })
  // Loading (null, not failed) → muted unknown; a failed local read is a
  // degradation (warn), never a silent "not injected".
  assert.deepEqual(localChamberBadge(null, false), { labelKey: 'chamberBadgeUnknown', tone: 'muted' })
  assert.deepEqual(localChamberBadge(null, true), { labelKey: 'chamberBadgeUnknown', tone: 'warn' })
})

test('remoteChamberBadge: the live Loader state derives the badge, never a constant claim', () => {
  const entries = [
    { moduleName: HOST_GRAPH_PACKAGE, enabled: true, fiberPhase: 'active' as const },
    { moduleName: GIT_WORKTREE_PACKAGE, enabled: true, fiberPhase: 'failed' as const },
    { moduleName: MOBILE_PACKAGE, enabled: true, fiberPhase: 'loading' as const },
    { moduleName: '@dsh-chamber/off', enabled: false, fiberPhase: 'active' as const },
  ]
  // Present + enabled + active → live (ok); failed → danger; present but
  // not proven live → injected-with-muted (presence only, never a live
  // claim); present-but-disabled → same muted presence; absent → not
  // injected (muted).
  assert.deepEqual(remoteChamberBadge(entries, HOST_GRAPH_PACKAGE), { labelKey: 'chamberBadgeLive', tone: 'ok' })
  assert.deepEqual(remoteChamberBadge(entries, GIT_WORKTREE_PACKAGE), { labelKey: 'chamberBadgeFailed', tone: 'danger' })
  assert.deepEqual(remoteChamberBadge(entries, MOBILE_PACKAGE), { labelKey: 'chamberBadgeInjected', tone: 'muted' })
  assert.deepEqual(remoteChamberBadge(entries, '@dsh-chamber/off'), { labelKey: 'chamberBadgeInjected', tone: 'muted' })
  assert.deepEqual(remoteChamberBadge(entries, '@dsh-chamber/never-installed'), { labelKey: 'chamberBadgeNotInjected', tone: 'muted' })
})

test('remoteChamberBadge: the raw cordis patch-insert report of a chamber row still resolves its live badge', () => {
  // The gateway's mobile entry arrives as 'cordis:include <name>' — the
  // classification-aware match must light up its badge instead of a
  // constant "not injected" (plan 24 D7-A fix).
  const entries = [
    { moduleName: `cordis:include ${MOBILE_PACKAGE}`, enabled: true, fiberPhase: 'active' as const },
    { moduleName: `cordis:include ${GIT_WORKTREE_PACKAGE}`, enabled: true, fiberPhase: 'failed' as const },
  ]
  assert.deepEqual(remoteChamberBadge(entries, MOBILE_PACKAGE), { labelKey: 'chamberBadgeLive', tone: 'ok' })
  assert.deepEqual(remoteChamberBadge(entries, GIT_WORKTREE_PACKAGE), { labelKey: 'chamberBadgeFailed', tone: 'danger' })
})

test('installedRowLiveState: protected composition/seed rows never claim a Loader state', () => {
  // 受保护行（安装自带基线）从不是 Loader 客户端入口：对它们要 Loader 状态会在每次
  // 打开对话框时给出假告警（2026-12 review；组合行在 §6.11.5 之后恒可见）。
  const snapshot = { entries: [
    { moduleName: 'third-party-live', enabled: true, fiberPhase: 'active' },
  ] } as unknown as PluginInventorySnapshot
  assert.equal(installedRowLiveState(snapshot, { name: '@deepseek-ai/dsh-base', protected: true, role: 'composition' }, true), null)
  assert.equal(installedRowLiveState(snapshot, { name: '@dsh-chamber/dsh-chamber-seed-client-graph', protected: true, role: 'seed' }, true), null)
  assert.equal(installedRowLiveState(snapshot, { name: 'x', protected: false, role: 'composition' }, true), null)
  // 用户行照旧。
  assert.deepEqual(installedRowLiveState(snapshot, { name: 'third-party-live', protected: false, role: 'layer' }, true),
    { labelKey: 'thirdPartyLiveActive', tone: 'ok' })
  assert.deepEqual(installedRowLiveState(snapshot, { name: 'missing-entry', protected: false, role: 'third-party' }, true),
    { labelKey: 'thirdPartyLiveRestart', tone: 'warn' })
  assert.equal(installedRowLiveState(snapshot, { name: 'missing-entry', protected: false, role: 'third-party' }, false), null)
  assert.equal(installedRowLiveState(null, { name: 'third-party-live', protected: false, role: 'layer' }, true), null)
})

test('thirdPartyLiveState: only an enabled + active Loader entry claims live, never an unreadable snapshot', () => {
  const snapshot: PluginInventorySnapshot = {
    entries: [
      { entryId: 'e1', moduleName: 'dsh-mcp-scope', enabled: true, fiberPhase: 'active' },
      { entryId: 'e2', moduleName: 'dsh-mcp-scope-lazy', enabled: true, fiberPhase: null },
      { entryId: 'e3', moduleName: 'dsh-mcp-scope-booting', enabled: true, fiberPhase: 'pending' },
      { entryId: 'e4', moduleName: 'dsh-mcp-scope-loading', enabled: true, fiberPhase: 'loading' },
      { entryId: 'e5', moduleName: 'dsh-mcp-scope-failed', enabled: true, fiberPhase: 'failed' },
      { entryId: 'e6', moduleName: 'dsh-mcp-scope-off', enabled: false, fiberPhase: 'active' },
      { entryId: 'e7', moduleName: 'dsh-mcp-scope-off-loading', enabled: false, fiberPhase: 'loading' },
    ],
  }
  // Matched-entry states are independent of the loader-entry expectation (a
  // matched entry IS a loader entry): expectations true/false agree here.
  // enabled + active = the only live claim.
  assert.deepEqual(thirdPartyLiveState(snapshot, 'dsh-mcp-scope', true), { labelKey: 'thirdPartyLiveActive', tone: 'ok' })
  // enabled, not yet active (null fiber / pending / loading) → starting, never live.
  assert.deepEqual(thirdPartyLiveState(snapshot, 'dsh-mcp-scope-lazy', true), { labelKey: 'thirdPartyLiveStarting', tone: 'muted' })
  assert.deepEqual(thirdPartyLiveState(snapshot, 'dsh-mcp-scope-booting', true), { labelKey: 'thirdPartyLiveStarting', tone: 'muted' })
  assert.deepEqual(thirdPartyLiveState(snapshot, 'dsh-mcp-scope-loading', true), { labelKey: 'thirdPartyLiveStarting', tone: 'muted' })
  // enabled + failed → load failure (the shared failed-to-load label).
  assert.deepEqual(thirdPartyLiveState(snapshot, 'dsh-mcp-scope-failed', false), { labelKey: 'chamberBadgeFailed', tone: 'danger' })
  // Disabled is dominant, whatever the fiber reports (an unloading fiber may
  // still be active while the disable lands).
  assert.deepEqual(thirdPartyLiveState(snapshot, 'dsh-mcp-scope-off', true), { labelKey: 'pluginDisabled', tone: 'muted' })
  assert.deepEqual(thirdPartyLiveState(snapshot, 'dsh-mcp-scope-off-loading', false), { labelKey: 'pluginDisabled', tone: 'muted' })
})

test('thirdPartyLiveState: a bundle-layer row without a matching entry claims a restart; a non-layer row stays neutral', () => {
  const snapshot: PluginInventorySnapshot = {
    entries: [
      { entryId: 'e1', moduleName: 'dsh-mcp-scope', enabled: true, fiberPhase: 'active' },
    ],
  }
  // Installed in the profile manifest AS A BUNDLE LAYER but the RUNNING
  // instance has not mounted it (the Loader reports no such module) →
  // activates on restart (never a live claim).
  assert.deepEqual(thirdPartyLiveState(snapshot, 'just-installed-plugin', true), { labelKey: 'thirdPartyLiveRestart', tone: 'warn' })
  // Exact-name match only: a near name is not the row's entry.
  assert.deepEqual(thirdPartyLiveState(snapshot, 'dsh-mcp-scope@1.0.0', true), { labelKey: 'thirdPartyLiveRestart', tone: 'warn' })
  // NOT a bundle layer (plain / client-only dependency — `dsh plugin add`
  // only promotes dsh.bundle-declaring packages into the layer stack): no
  // loader entry can ever appear, so a restart promise would be a false
  // promise — the cell stays neutral.
  assert.equal(thirdPartyLiveState(snapshot, 'plain-lib-dep', false), null)
})

test('thirdPartyLiveState: a null snapshot (instance not running / read failed) stays neutral — never a claim', () => {
  assert.equal(thirdPartyLiveState(null, 'any-plugin', true), null)
  assert.equal(thirdPartyLiveState(null, 'plain-lib-dep', false), null)
})

/* ---- sshChamberGates (design 13 §6 / design 20 §6, 2026-12 review): the two
 * ssh target-level gates read the APPLICABLE probe rows only, so a localOnly
 * row can never decide them. ---- */

/** One probe package row (`ChamberPackageState`-shaped). */
function probePkg(name: string, over: Record<string, unknown> = {}) {
  return { insertId: `insert:${name}`, name, probe: `${name}/probe`, installed: false, patched: false, version: null, live: null, ...over }
}

test('sshChamberGates: an unanswered probe (not ssh / still loading) asserts nothing', () => {
  assert.deepEqual(sshChamberGates(undefined), { needsSeed: false, injectedNotLive: false })
  assert.deepEqual(sshChamberGates(null), { needsSeed: false, injectedNotLive: false })
})

test('sshChamberGates: a failed probe asks for a re-seed and never claims a pending restart', () => {
  // The probe ANSWERED (loud `ok:false`): a re-seed may repair it, and nothing
  // proves a restart is pending — the exact pre-existing semantics.
  assert.deepEqual(sshChamberGates({ ok: false, error: 'ssh exec failed' }),
    { needsSeed: true, injectedNotLive: false })
})

test('sshChamberGates: the applicable rows decide both gates', () => {
  const injected = { installed: true, patched: true, live: true }
  const live = probePkg(HOST_GRAPH_PACKAGE, injected)
  const restartPending = probePkg(GIT_WORKTREE_PACKAGE, { installed: true, patched: true, live: false })
  const half = probePkg(ARCHIVE_CLEANUP_PACKAGE, { installed: true, patched: false, live: null })
  assert.deepEqual(sshChamberGates({ ok: true, packages: [live, restartPending, probePkg(OPEN_IN_PACKAGE, { localOnly: true })] }),
    { needsSeed: false, injectedNotLive: true },
    'all applicable rows injected + one not live = restart, never a re-seed')
  assert.deepEqual(sshChamberGates({ ok: true, packages: [live, restartPending, half] }),
    { needsSeed: true, injectedNotLive: false },
    'a half-injected applicable row is a seed request; the restart hint must NOT ride along (the pair is a partition)')
  assert.deepEqual(sshChamberGates({ ok: true, packages: [live, probePkg(GIT_WORKTREE_PACKAGE, injected), probePkg(ARCHIVE_CLEANUP_PACKAGE, injected)] }),
    { needsSeed: false, injectedNotLive: false },
    'a fully seeded, fully live remote asks for nothing')
  assert.deepEqual(sshChamberGates({ ok: true, packages: [] }),
    { needsSeed: false, injectedNotLive: false },
    'an empty probe list is not a missing package')
})

test('sshChamberGates: the synthesized localOnly row cannot pin 「注入」 true (the regression this exists for)', () => {
  // The probe answers with three APPLICABLE rows fully injected, plus the
  // localOnly row it never asked the remote about (installed:false/patched:false
  // by construction, plugin-sync.ts). Before the applicability filter, that row
  // made `needsSeed` true whenever the probe loaded: 注入 showed over a fully
  // seeded remote and the restart branch could never appear.
  const injected = { installed: true, patched: true, live: false }
  const probe = {
    ok: true as const,
    packages: [
      probePkg(HOST_GRAPH_PACKAGE, injected),
      probePkg(GIT_WORKTREE_PACKAGE, injected),
      probePkg(ARCHIVE_CLEANUP_PACKAGE, injected),
      probePkg(OPEN_IN_PACKAGE, { localOnly: true }),
    ],
  }
  assert.deepEqual(sshChamberGates(probe),
    { needsSeed: false, injectedNotLive: true },
    'the localOnly row speaks for nothing; the three probed rows decide')
})

/* ---- applicableChamberPackages (design 20 §6, 2026-12 user decision): a
 * `localOnly` registry row is listed for the LOCAL target only. ---- */

test('applicableChamberPackages: the local target keeps every registry row (including a localOnly one)', () => {
  const rows = [
    { name: HOST_GRAPH_PACKAGE },
    { name: OPEN_IN_PACKAGE, localOnly: true as const },
  ]
  assert.equal(applicableChamberPackages('local', rows), rows,
    'the local target is the one shape where a localOnly row applies — identity, same array')
})

test('applicableChamberPackages: every remote target drops localOnly rows and keeps the rest in order', () => {
  const rows = [
    { name: HOST_GRAPH_PACKAGE },
    { name: GIT_WORKTREE_PACKAGE },
    { name: OPEN_IN_PACKAGE, localOnly: true as const },
    { name: ARCHIVE_CLEANUP_PACKAGE },
  ]
  for (const target of ['ssh', 'gateway', 'http'] as const) {
    assert.deepEqual(applicableChamberPackages(target, rows).map(row => row.name),
      [HOST_GRAPH_PACKAGE, GIT_WORKTREE_PACKAGE, ARCHIVE_CLEANUP_PACKAGE],
      `${target}: only the applicable registry rows`)
  }
})

test('applicableChamberPackages: an explicit false / absent flag is an ordinary row, and an empty list stays empty', () => {
  // Only the registry's `true` marks a row local-shape-only: the four client
  // node-state declarations carry the field as optional, and `false` must never
  // be read as "local" (a truthiness check would flip the meaning).
  const rows = [{ name: 'a', localOnly: false }, { name: 'b' }]
  assert.deepEqual(applicableChamberPackages('ssh', rows).map(row => row.name), ['a', 'b'])
  assert.deepEqual(applicableChamberPackages('ssh', []), [])
  assert.deepEqual(applicableChamberPackages('gateway', []), [])
})
