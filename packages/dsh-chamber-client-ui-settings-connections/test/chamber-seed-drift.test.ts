/**
 * Gateway chamber seed-cache drift projections (design 21 §6.2/§6.5, plan
 * Phase 3 — A0 read side): the pure local-manifest ↔ gateway-seed-cache
 * comparison (plugin-inventory-text.ts chamberSeedDrift) that the gateway
 * plugin view renders (local vX · gateway vY + drift / 未同步 markers) and
 * the manual「立即同步」action resolves. Plain node:test, no dsh, no React
 * (mirror of plugin-inventory.test.ts).
 *
 * 2026-09 dynamic-registry revision: the comparison is PER-PACKAGE over the
 * control-plane registry's expected list (the desktop manifest ships it over
 * IPC) — no fixed hostGraph/gitWorktree pair anywhere.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ARCHIVE_CLEANUP_PACKAGE,
  OPEN_IN_PACKAGE,
  GIT_WORKTREE_PACKAGE,
  HOST_GRAPH_PACKAGE,
  chamberSeedDrift,
  type ChamberSeedDriftState,
} from '../src/client/plugin-inventory-text.ts'

/** The registry's expected packages as the desktop manifest delivers them. */
function localPackages(
  hostGraphVersion: string | null,
  gitWorktreeVersion: string | null,
  archiveCleanupVersion: string | null = '3.0.0',
): { name: string; version: string | null }[] {
  return [
    { name: HOST_GRAPH_PACKAGE, version: hostGraphVersion },
    { name: GIT_WORKTREE_PACKAGE, version: gitWorktreeVersion },
    { name: ARCHIVE_CLEANUP_PACKAGE, version: archiveCleanupVersion },
  ]
}

/** A name-keyed cache row set with explicit null rows (version null = that
 *  package was never synced — the gateway list() names every synced row). */
function cacheWith(
  hostGraphVersion: string | null,
  gitWorktreeVersion: string | null,
  archiveCleanupVersion: string | null,
): Record<string, string | null> {
  return {
    [HOST_GRAPH_PACKAGE]: hostGraphVersion,
    [GIT_WORKTREE_PACKAGE]: gitWorktreeVersion,
    [ARCHIVE_CLEANUP_PACKAGE]: archiveCleanupVersion,
  }
}

interface DriftCase {
  name: string
  local: { name: string; version: string | null }[]
  cached: Record<string, string | null>
  expected: Record<string, ChamberSeedDriftState>
}

const localAll = localPackages('1.0.0', '2.0.0', '3.0.0')

const cases: DriftCase[] = [
  {
    name: 'identical versions are a match for every package',
    local: localAll,
    cached: cacheWith('1.0.0', '2.0.0', '3.0.0'),
    expected: {
      [HOST_GRAPH_PACKAGE]: 'match',
      [GIT_WORKTREE_PACKAGE]: 'match',
      [ARCHIVE_CLEANUP_PACKAGE]: 'match',
    },
  },
  {
    name: 'a version inequality on every package is a drift on every package',
    local: localAll,
    cached: cacheWith('0.9.0', '3.0.0', '2.0.0'),
    expected: {
      [HOST_GRAPH_PACKAGE]: 'drift',
      [GIT_WORKTREE_PACKAGE]: 'drift',
      [ARCHIVE_CLEANUP_PACKAGE]: 'drift',
    },
  },
  {
    name: 'an empty cache is absent-cache for every package (fresh gateway)',
    local: localAll,
    cached: {},
    expected: {
      [HOST_GRAPH_PACKAGE]: 'absent-cache',
      [GIT_WORKTREE_PACKAGE]: 'absent-cache',
      [ARCHIVE_CLEANUP_PACKAGE]: 'absent-cache',
    },
  },
  {
    name: 'cache rows with null versions are absent-cache (never synced rows)',
    local: localAll,
    cached: cacheWith(null, null, null),
    expected: {
      [HOST_GRAPH_PACKAGE]: 'absent-cache',
      [GIT_WORKTREE_PACKAGE]: 'absent-cache',
      [ARCHIVE_CLEANUP_PACKAGE]: 'absent-cache',
    },
  },
  {
    name: 'an unknown LOCAL version next to a cached package is absent-local (no mismatch claim)',
    local: localPackages(null, null, null),
    cached: cacheWith('1.0.0', '2.0.0', '3.0.0'),
    expected: {
      [HOST_GRAPH_PACKAGE]: 'absent-local',
      [GIT_WORKTREE_PACKAGE]: 'absent-local',
      [ARCHIVE_CLEANUP_PACKAGE]: 'absent-local',
    },
  },
  {
    name: 'per-package states mix independently (drift / match / absent-local)',
    local: localPackages('1.0.0', '2.0.0', null),
    cached: cacheWith('2.0.0', '2.0.0', '3.0.0'),
    expected: {
      [HOST_GRAPH_PACKAGE]: 'drift',
      [GIT_WORKTREE_PACKAGE]: 'match',
      [ARCHIVE_CLEANUP_PACKAGE]: 'absent-local',
    },
  },
  {
    name: 'per-package states mix independently (absent-local / absent-cache / match)',
    local: localPackages(null, '2.0.0', '3.0.0'),
    cached: cacheWith('1.0.0', null, '3.0.0'),
    expected: {
      [HOST_GRAPH_PACKAGE]: 'absent-local',
      [GIT_WORKTREE_PACKAGE]: 'absent-cache',
      [ARCHIVE_CLEANUP_PACKAGE]: 'match',
    },
  },
  {
    name: 'a cache that does not name a package counts that package as absent-cache',
    local: localAll,
    cached: { [GIT_WORKTREE_PACKAGE]: '2.0.0' },
    expected: {
      [HOST_GRAPH_PACKAGE]: 'absent-cache',
      [GIT_WORKTREE_PACKAGE]: 'match',
      [ARCHIVE_CLEANUP_PACKAGE]: 'absent-cache',
    },
  },
  {
    name: 'unknown (non-chamber) names in the cache map are ignored',
    local: localAll,
    cached: { '@dsh-chamber/unrelated-package': '9.9.9' },
    expected: {
      [HOST_GRAPH_PACKAGE]: 'absent-cache',
      [GIT_WORKTREE_PACKAGE]: 'absent-cache',
      [ARCHIVE_CLEANUP_PACKAGE]: 'absent-cache',
    },
  },
]

for (const entry of cases) {
  test(`chamberSeedDrift: ${entry.name}`, () => {
    assert.deepEqual(chamberSeedDrift(entry.local, entry.cached), entry.expected)
  })
}

test('chamberSeedDrift: an empty expected list yields an empty projection (no fixed pair)', () => {
  assert.deepEqual(chamberSeedDrift([], { [HOST_GRAPH_PACKAGE]: '1.0.0' }), {})
})

test('chamber package names mirror the control-plane registry (lockstep guard)', () => {
  // The client package cannot import the Node-side registry, so pin the NAME
  // SET the UI classifies against the authoritative source text: a rename in
  // host-graph-seed.ts fails here, and so does a NEW registry row (the client
  // constants are a mirror of the whole registry, not of a fixed trio) —
  // review G2-4: the previous per-name `includes` loop could not detect a
  // fourth package at all.
  const seed = readFileSync(join(import.meta.dirname, '../../control-plane/src/host-graph-seed.ts'), 'utf8')
  const declaredNames = [...seed.matchAll(/export const HOST_[A-Z_]+_PACKAGE_NAME = '([^']+)'/gu)].map(match => match[1]!)
  assert.deepEqual(
    [...declaredNames].sort(),
    [HOST_GRAPH_PACKAGE, GIT_WORKTREE_PACKAGE, ARCHIVE_CLEANUP_PACKAGE, OPEN_IN_PACKAGE].sort(),
    'a NEW registry host package must be added to the client projection (this module) as well',
  )
  // Registry ROW SET: every declared package is a row of CHAMBER_HOST_PACKAGES
  // (and every row is a declared package), so a package declared but never
  // registered — or registered but unknown to the client — fails loud.
  const registryRows = [...seed.matchAll(/\{ insert: (HOST_[A-Z_]+_INSERT), probe: \{ method: '([^']+)'/gu)]
  assert.equal(registryRows.length, declaredNames.length,
    'CHAMBER_HOST_PACKAGES must carry exactly one row per declared host package')
  assert.equal(new Set(registryRows.map(match => match[2])).size, registryRows.length,
    'registry probe methods must stay unique (control-plane assertChamberHostRegistry pins this at load)')
  for (const name of [HOST_GRAPH_PACKAGE, GIT_WORKTREE_PACKAGE, ARCHIVE_CLEANUP_PACKAGE, OPEN_IN_PACKAGE]) {
    assert.ok(seed.includes(`'${name}'`), `control-plane host-graph-seed.ts no longer declares ${name}`)
  }
  assert.equal(HOST_GRAPH_PACKAGE, '@dsh-chamber/dsh-chamber-seed-client-graph')
  assert.equal(GIT_WORKTREE_PACKAGE, '@dsh-chamber/dsh-chamber-seed-git-worktree')
  assert.equal(ARCHIVE_CLEANUP_PACKAGE, '@dsh-chamber/dsh-chamber-seed-archive-cleanup')
  assert.equal(OPEN_IN_PACKAGE, '@dsh-chamber/dsh-chamber-seed-open-in')
})
