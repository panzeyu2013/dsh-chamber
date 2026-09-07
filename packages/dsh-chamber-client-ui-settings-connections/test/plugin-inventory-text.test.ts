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
  classifyInventoryEntry,
  localChamberBadge,
  remoteChamberBadge,
  thirdPartyEntries,
  thirdPartyLiveState,
} from '../src/client/plugin-inventory-text.ts'

test('classifyInventoryEntry: plain module names map to their package class', () => {
  assert.equal(classifyInventoryEntry(HOST_GRAPH_PACKAGE), 'chamber-host-graph')
  assert.equal(classifyInventoryEntry(GIT_WORKTREE_PACKAGE), 'chamber-git-worktree')
  assert.equal(classifyInventoryEntry(ARCHIVE_CLEANUP_PACKAGE), 'chamber-archive-cleanup')
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

test('thirdPartyEntries: the three chamber host packages and the mobile entry are excluded in both their raw patch-syntax and plain forms', () => {
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
    ],
  }
  const rows = thirdPartyEntries(snapshot)
  assert.deepEqual(rows.map(row => row.moduleName), ['@dsh-chamber/user-tool', 'my-third-party-plugin'])
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
