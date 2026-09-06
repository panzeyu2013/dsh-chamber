/**
 * build-host-graph-package.mjs packaging-row test (plain node, no electron):
 * the packaging build distributes the THREE chamber host packages (2026-12:
 * design 24 added archive-cleanup) into desktop/dist/ — the packaged source
 * dirs the local control-plane seed and the remote SSH/gateway seeds read
 * from. Importing the script must not execute the build (the import guard is
 * proven by this file running at all).
 *
 * Run directly: node scripts/build-host-graph-package.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { basename, join } from 'node:path'
import { HOST_PACKAGE_BUILD_ROWS } from './build-host-graph-package.mjs'

test('the host-graph packaging build distributes the three chamber host packages', () => {
  assert.deepEqual(
    HOST_PACKAGE_BUILD_ROWS.map(row => row.label),
    ['host-graph', 'git-worktree', 'archive-cleanup'],
    'stable row order: client-graph, git-worktree, archive-cleanup (design 24)',
  )
  // The packaged outDir names are the exact dirs main.ts reads in packaged
  // builds (pkgDir/dist/<outDir basename>); labels mirror the desktop
  // seed-row labels main.ts uses (NOT the loader insert ids: row 1's label
  // 'host-graph' corresponds to insert id 'client-graph').
  const expectedOutDirs = new Map([
    ['host-graph', 'host-graph-package'],
    ['git-worktree', 'host-git-worktree-package'],
    ['archive-cleanup', 'host-archive-cleanup-package'],
  ])
  for (const row of HOST_PACKAGE_BUILD_ROWS) {
    assert.equal(basename(row.outDir), expectedOutDirs.get(row.label), row.label)
    assert.notEqual(row.sourceDir, row.outDir, 'a row never copies onto itself')
  }
  const archive = HOST_PACKAGE_BUILD_ROWS.find(row => row.label === 'archive-cleanup')
  assert.ok(archive !== undefined, 'the third chamber host package row must exist')
  assert.ok(
    archive.sourceDir.endsWith(join('packages', 'dsh-host-archive-cleanup')),
    `archive-cleanup source must be the packaged dsh-host-archive-cleanup tree: ${archive.sourceDir}`,
  )
  assert.ok(
    archive.outDir.endsWith(join('dist', 'host-archive-cleanup-package')),
    `archive-cleanup packaged dir must be dist/host-archive-cleanup-package: ${archive.outDir}`,
  )
})
