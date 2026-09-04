/**
 * plugin-inventory-text.ts pure display projections (plain node:test, no
 * dsh, no React): the entry classification (plan 24 D7-A — the gateway's
 * cordis.patch.yml insert rows are reported by the host inventory under
 * the raw 'cordis:include <name>' patch syntax; the mobile packaged entry
 * is a chamber row, never third-party) and the chamber row badge mappings
 * (plan 24 B1.5 — local manifest truth + remote live-Loader state badge-
 * ized into {labelKey, tone}).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { PluginInventorySnapshot } from '../src/client/plugin-inventory-api.ts'
import {
  GIT_WORKTREE_PACKAGE,
  HOST_GRAPH_PACKAGE,
  MOBILE_PACKAGE,
  classifyInventoryEntry,
  localChamberBadge,
  remoteChamberBadge,
  thirdPartyEntries,
} from '../src/client/plugin-inventory-text.ts'

test('classifyInventoryEntry: plain module names map to their package class', () => {
  assert.equal(classifyInventoryEntry(HOST_GRAPH_PACKAGE), 'chamber-host-graph')
  assert.equal(classifyInventoryEntry(GIT_WORKTREE_PACKAGE), 'chamber-git-worktree')
  assert.equal(classifyInventoryEntry(MOBILE_PACKAGE), 'chamber-mobile')
  assert.equal(classifyInventoryEntry('@deepseek-ai/dsh-demo'), 'official')
  assert.equal(classifyInventoryEntry('@dsh-chamber/user-tool'), 'third-party')
  assert.equal(classifyInventoryEntry('my-third-party-plugin'), 'third-party')
})

test('classifyInventoryEntry: the raw cordis patch-insert prefix is stripped before matching', () => {
  assert.equal(classifyInventoryEntry(`cordis:include ${MOBILE_PACKAGE}`), 'chamber-mobile')
  assert.equal(classifyInventoryEntry(`cordis:include ${HOST_GRAPH_PACKAGE}`), 'chamber-host-graph')
  assert.equal(classifyInventoryEntry(`cordis:include ${GIT_WORKTREE_PACKAGE}`), 'chamber-git-worktree')
  assert.equal(classifyInventoryEntry('cordis:include @deepseek-ai/dsh-demo'), 'official')
  assert.equal(classifyInventoryEntry('cordis:include my-third-party-plugin'), 'third-party')
  // The root include entry's own name carries no payload — without the
  // trailing space the prefix is not stripped and it stays third-party
  // (group entries never reach the inventory entries list anyway).
  assert.equal(classifyInventoryEntry('cordis:include'), 'third-party')
})

test('thirdPartyEntries: the mobile entry is excluded in both its raw patch-syntax and plain forms', () => {
  const snapshot: PluginInventorySnapshot = {
    entries: [
      { entryId: 'p1', moduleName: HOST_GRAPH_PACKAGE, enabled: true, fiberPhase: 'active' },
      { entryId: 'p2', moduleName: GIT_WORKTREE_PACKAGE, enabled: true, fiberPhase: 'active' },
      { entryId: 'p3', moduleName: `cordis:include ${MOBILE_PACKAGE}`, enabled: true, fiberPhase: 'active' },
      { entryId: 'p4', moduleName: MOBILE_PACKAGE, enabled: true, fiberPhase: 'active' },
      { entryId: 'p5', moduleName: 'cordis:include @deepseek-ai/dsh-demo', enabled: true, fiberPhase: 'active' },
      { entryId: 'p6', moduleName: '@dsh-chamber/user-tool', enabled: true, fiberPhase: 'loading' },
      { entryId: 'p7', moduleName: 'my-third-party-plugin', enabled: false, fiberPhase: 'failed' },
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
