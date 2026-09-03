/**
 * Gateway chamber seed-cache drift projections (design 21 §6.2/§6.5, plan
 * Phase 3 — A0 read side): the pure local-manifest ↔ gateway-seed-cache
 * comparison (plugin-inventory-text.ts chamberSeedDrift) that the gateway
 * plugin view renders (local vX · gateway vY + drift / 未同步 markers) and
 * the manual「立即同步」action resolves. Plain node:test, no dsh, no React
 * (mirror of plugin-inventory.test.ts).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  GIT_WORKTREE_PACKAGE,
  HOST_GRAPH_PACKAGE,
  chamberSeedDrift,
  type ChamberLocalVersions,
  type ChamberSeedDriftProjection,
} from '../src/client/plugin-inventory-text.ts'

/** A name-keyed cache row set with explicit null rows (version null = that
 *  package was never synced — the gateway list() always names both). */
function cacheWith(hostGraph: string | null, gitWorktree: string | null): Record<string, string | null> {
  return { [HOST_GRAPH_PACKAGE]: hostGraph, [GIT_WORKTREE_PACKAGE]: gitWorktree }
}

interface DriftCase {
  name: string
  local: ChamberLocalVersions
  cached: Record<string, string | null>
  expected: ChamberSeedDriftProjection
}

const localBoth: ChamberLocalVersions = { hostGraph: '1.0.0', gitWorktree: '2.0.0' }

const cases: DriftCase[] = [
  {
    name: 'identical versions are a match for both packages',
    local: localBoth,
    cached: cacheWith('1.0.0', '2.0.0'),
    expected: { hostGraph: 'match', gitWorktree: 'match' },
  },
  {
    name: 'a version inequality on both packages is a drift on both',
    local: localBoth,
    cached: cacheWith('0.9.0', '3.0.0'),
    expected: { hostGraph: 'drift', gitWorktree: 'drift' },
  },
  {
    name: 'an empty cache is absent-cache for both packages (fresh gateway)',
    local: localBoth,
    cached: {},
    expected: { hostGraph: 'absent-cache', gitWorktree: 'absent-cache' },
  },
  {
    name: 'cache rows with null versions are absent-cache (never synced rows)',
    local: localBoth,
    cached: cacheWith(null, null),
    expected: { hostGraph: 'absent-cache', gitWorktree: 'absent-cache' },
  },
  {
    name: 'an unknown LOCAL version next to a cached package is absent-local (no mismatch claim)',
    local: { hostGraph: null, gitWorktree: null },
    cached: cacheWith('1.0.0', '2.0.0'),
    expected: { hostGraph: 'absent-local', gitWorktree: 'absent-local' },
  },
  {
    name: 'per-package states mix: hostGraph drift while gitWorktree matches',
    local: localBoth,
    cached: cacheWith('2.0.0', '2.0.0'),
    expected: { hostGraph: 'drift', gitWorktree: 'match' },
  },
  {
    name: 'per-package states mix: hostGraph absent-local while gitWorktree absent-cache',
    local: { hostGraph: null, gitWorktree: '2.0.0' },
    cached: cacheWith('1.0.0', null),
    expected: { hostGraph: 'absent-local', gitWorktree: 'absent-cache' },
  },
  {
    name: 'a cache that does not name a package counts that package as absent-cache',
    local: localBoth,
    cached: { [GIT_WORKTREE_PACKAGE]: '2.0.0' },
    expected: { hostGraph: 'absent-cache', gitWorktree: 'match' },
  },
  {
    name: 'unknown (non-chamber) names in the cache map are ignored',
    local: localBoth,
    cached: { '@dsh-chamber/unrelated-package': '9.9.9' },
    expected: { hostGraph: 'absent-cache', gitWorktree: 'absent-cache' },
  },
]

for (const entry of cases) {
  test(`chamberSeedDrift: ${entry.name}`, () => {
    assert.deepEqual(chamberSeedDrift(entry.local, entry.cached), entry.expected)
  })
}

test('chamberSeedDrift: the cache map is keyed by the exact chamber package names (rename guard)', () => {
  // Literal key strings pin the lookup to the documented package names: if a
  // HOST_GRAPH_PACKAGE/GIT_WORKTREE_PACKAGE constant ever drifted from the
  // gateway's syncable-name set, matching versions below would stop matching
  // (→ absent-cache) and this test fails loudly.
  const cached: Record<string, string | null> = {
    '@dsh-chamber/dsh-host-client-graph': '1.0.0',
    '@dsh-chamber/dsh-host-git-worktree': '2.0.0',
  }
  assert.equal(HOST_GRAPH_PACKAGE, '@dsh-chamber/dsh-host-client-graph')
  assert.equal(GIT_WORKTREE_PACKAGE, '@dsh-chamber/dsh-host-git-worktree')
  assert.deepEqual(chamberSeedDrift(localBoth, cached), { hostGraph: 'match', gitWorktree: 'match' })
})
