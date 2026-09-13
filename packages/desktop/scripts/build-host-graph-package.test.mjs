/**
 * build-host-graph-package.mjs packaging-row test (plain node, no electron):
 * the packaging build distributes the chamber host packages (2026-12: design
 * 24 added archive-cleanup; design 20 §6 added the local-shape-only open-in
 * domain) into desktop/dist/ — the packaged source dirs the local
 * control-plane seed reads from, and from which main.ts derives the remote
 * SSH seed list (which omits the local-only row on purpose). Importing the
 * script must not execute the build (the import guard is proven by this file
 * running at all).
 *
 * Run directly: node scripts/build-host-graph-package.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { basename, join } from 'node:path'
import { HOST_PACKAGE_BUILD_ROWS } from './build-host-graph-package.mjs'

test('the host-graph packaging build distributes the chamber host packages', () => {
  assert.deepEqual(
    HOST_PACKAGE_BUILD_ROWS.map(row => row.label),
    ['host-graph', 'git-worktree', 'archive-cleanup', 'open-in'],
    'stable row order: client-graph, git-worktree, archive-cleanup (design 24), open-in (design 20 §6)',
  )
  // The packaged outDir names are the exact dirs main.ts reads in packaged
  // builds (pkgDir/dist/<outDir basename>); labels mirror the desktop
  // seed-row labels main.ts uses (NOT the loader insert ids: row 1's label
  // 'host-graph' corresponds to insert id 'client-graph').
  const expectedOutDirs = new Map([
    ['host-graph', 'host-graph-package'],
    ['git-worktree', 'host-git-worktree-package'],
    ['archive-cleanup', 'host-archive-cleanup-package'],
    ['open-in', 'host-open-in-package'],
  ])
  for (const row of HOST_PACKAGE_BUILD_ROWS) {
    assert.equal(basename(row.outDir), expectedOutDirs.get(row.label), row.label)
    assert.notEqual(row.sourceDir, row.outDir, 'a row never copies onto itself')
  }
  const archive = HOST_PACKAGE_BUILD_ROWS.find(row => row.label === 'archive-cleanup')
  assert.ok(archive !== undefined, 'the third chamber host package row must exist')
  assert.ok(
    archive.sourceDir.endsWith(join('packages', 'dsh-chamber-seed-archive-cleanup')),
    `archive-cleanup source must be the packaged dsh-chamber-seed-archive-cleanup tree: ${archive.sourceDir}`,
  )
  assert.ok(
    archive.outDir.endsWith(join('dist', 'host-archive-cleanup-package')),
    `archive-cleanup packaged dir must be dist/host-archive-cleanup-package: ${archive.outDir}`,
  )
  // design 20 §6: the open-in host domain is bundled for the LOCAL seed too.
  // It is a local-shape-only registry row, so main.ts keeps it OUT of the
  // remote/gateway source map — the packaged dir exists for the local
  // control-plane seed alone.
  const openIn = HOST_PACKAGE_BUILD_ROWS.find(row => row.label === 'open-in')
  assert.ok(openIn !== undefined, 'the open-in host package row must exist')
  assert.ok(
    openIn.sourceDir.endsWith(join('packages', 'dsh-chamber-seed-open-in')),
    `open-in source must be the packaged dsh-chamber-seed-open-in tree: ${openIn.sourceDir}`,
  )
  assert.ok(
    openIn.outDir.endsWith(join('dist', 'host-open-in-package')),
    `open-in packaged dir must be dist/host-open-in-package: ${openIn.outDir}`,
  )
})
