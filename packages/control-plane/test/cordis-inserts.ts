/**
 * cordis-inserts.ts unit tests (A2 cross-package protocol single-sourcing):
 *   - renderCordisInserts: the canonical `- insert:` bytes (byte-exact), the
 *     validation point (empty / invalid rows / duplicates throw);
 *   - parseLoaderRows / hasExactInsert / fieldCount: the comment-aware
 *     parse family the conflict decisions rest on (nested config names never
 *     complete a loader identity; name-first rows work; boundaries hold);
 *   - insertConflict: the shared classification host-graph-seed.ts and
 *     plugin-sync.ts both map onto their own message wording;
 *   - the host-graph-seed reuse: buildPatchOverlay materializes EXACTLY
 *     renderCordisInserts output (byte-identical overlay render), and
 *     missingHostPackageInserts consumes the same classification.
 * Run directly: node packages/control-plane/test/cordis-inserts.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  fieldCount,
  hasExactInsert,
  insertConflict,
  parseLoaderRows,
  renderCordisInserts,
  type CordisInsert,
} from '../src/cordis-inserts.ts'
import {
  buildPatchOverlay,
  HOST_GIT_WORKTREE_INSERT,
  HOST_GRAPH_INSERT,
  HOST_GRAPH_PACKAGE_NAME,
  HOST_GRAPH_PATCH_FILENAME,
  missingHostPackageInserts,
} from '../src/host-graph-seed.ts'

const CLIENT_GRAPH: CordisInsert = { id: 'client-graph', name: '@dsh-chamber/dsh-host-client-graph' }
const GIT_WORKTREE: CordisInsert = { id: 'git-worktree', name: '@dsh-chamber/dsh-host-git-worktree' }

/** The canonical overlay bytes (the dsh-app-boot loadOverlayPatches shape). */
const GOLDEN_ONE = `- insert:
    - id: client-graph
      name: '@dsh-chamber/dsh-host-client-graph'
`
const GOLDEN_BOTH = `- insert:
    - id: client-graph
      name: '@dsh-chamber/dsh-host-client-graph'
    - id: git-worktree
      name: '@dsh-chamber/dsh-host-git-worktree'
`

// ---------------------------------------------------------------------------
// renderCordisInserts
// ---------------------------------------------------------------------------

test('renderCordisInserts emits the canonical overlay bytes for one and two rows', () => {
  assert.equal(renderCordisInserts([CLIENT_GRAPH]), GOLDEN_ONE)
  assert.equal(renderCordisInserts([CLIENT_GRAPH, GIT_WORKTREE]), GOLDEN_BOTH)
})

test('renderCordisInserts is the validation point: empty / invalid / duplicate rows throw', () => {
  assert.throws(() => renderCordisInserts([]), /at least one row/)
  assert.throws(() => renderCordisInserts([{ id: 'bad id!', name: '@dsh-chamber/x' }]), /invalid overlay row/)
  assert.throws(() => renderCordisInserts([{ id: 'ok-id', name: 'not-a-chamber-pkg' }]), /invalid overlay row/)
  // Duplicate id OR name — a duplicate would break the next host boot.
  assert.throws(() => renderCordisInserts([CLIENT_GRAPH, { id: 'client-graph', name: '@dsh-chamber/other' }]), /duplicate overlay row/)
  assert.throws(() => renderCordisInserts([CLIENT_GRAPH, { id: 'other', name: CLIENT_GRAPH.name }]), /duplicate overlay row/)
})

// ---------------------------------------------------------------------------
// parseLoaderRows / hasExactInsert / fieldCount
// ---------------------------------------------------------------------------

test('parseLoaderRows reads direct block rows and ignores YAML comments', () => {
  const patch = `# a comment header
- insert:
    # another comment
    - id: client-graph
      name: '@dsh-chamber/dsh-host-client-graph' # trailing comment
`
  const rows = parseLoaderRows(patch)
  assert.equal(rows.length, 1)
  assert.deepEqual(rows[0]!.ids, ['client-graph'])
  assert.deepEqual(rows[0]!.names, ['@dsh-chamber/dsh-host-client-graph'])
})

test('parseLoaderRows keeps name-first rows and inline-flow rows as one loader row each', () => {
  const nameFirst = `- insert:
    - name: '@dsh-chamber/dsh-host-git-worktree'
      id: git-worktree
`
  assert.deepEqual(parseLoaderRows(nameFirst)[0]!.ids, ['git-worktree'])
  assert.deepEqual(parseLoaderRows(nameFirst)[0]!.names, ['@dsh-chamber/dsh-host-git-worktree'])
  const inline = `- insert: [{ id: git-worktree, name: '@dsh-chamber/dsh-host-git-worktree' }, { id: other, name: '@dsh-chamber/other' }]
`
  assert.equal(parseLoaderRows(inline).length, 2)
})

test('parseLoaderRows never lets a nested config name complete a loader identity', () => {
  const nested = `- insert:
    - id: git-worktree
      name: '@example/not-chamber'
      config:
        name: '@dsh-chamber/dsh-host-git-worktree'
`
  const rows = parseLoaderRows(nested)
  assert.equal(rows.length, 1)
  assert.deepEqual(rows[0]!.names, ['@example/not-chamber'], 'the nested config name is not a loader name')
})

test('hasExactInsert matches only a single exact id/name pair in one loader row', () => {
  const exact = `- insert:
    - id: git-worktree
      name: '@dsh-chamber/dsh-host-git-worktree'
`
  assert.equal(hasExactInsert(exact, GIT_WORKTREE), true)
  assert.equal(hasExactInsert(exact, CLIENT_GRAPH), false)
  // Cross-paired siblings never produce a false exact match.
  const crossed = `- insert:
    - id: git-worktree
      name: '@example/not-chamber'
    - name: '@dsh-chamber/dsh-host-git-worktree'
      id: another-git-service
`
  assert.equal(hasExactInsert(crossed, GIT_WORKTREE), false)
  // An exact name-first row is reused.
  const nameFirst = `- insert:
    - name: '@dsh-chamber/dsh-host-git-worktree'
      id: git-worktree
`
  assert.equal(hasExactInsert(nameFirst, GIT_WORKTREE), true)
})

test('fieldCount counts exact scalars with boundary checks and ignores comments', () => {
  const patch = `- id: client-graph-foo
  config:
    x: 1
- insert:
    - id: client-graph
      name: '@dsh-chamber/dsh-host-client-graph'
`
  assert.equal(fieldCount(patch, 'id', 'client-graph'), 1, 'client-graph-foo must not count as client-graph')
  assert.equal(fieldCount(patch, 'id', 'client-graph-foo'), 1)
  assert.equal(fieldCount(patch, 'name', '@dsh-chamber/dsh-host-client-graph'), 1)
})

// ---------------------------------------------------------------------------
// insertConflict — the shared classification both consumers map to wording
// ---------------------------------------------------------------------------

test('insertConflict returns null for an exactly-present row and for a clean patch', () => {
  const exact = `- insert:
    - id: client-graph
      name: '@dsh-chamber/dsh-host-client-graph'
`
  assert.equal(insertConflict(exact, CLIENT_GRAPH), null)
  assert.equal(insertConflict('# empty\n[]\n', CLIENT_GRAPH), null)
  assert.equal(insertConflict('', CLIENT_GRAPH), null)
})

test('insertConflict classifies duplicate identity / id-bound / name-bound', () => {
  assert.equal(
    insertConflict(`- insert:\n    - id: client-graph\n      name: '@dsh-chamber/dsh-host-git-worktree'\n`, CLIENT_GRAPH),
    'id-bound',
  )
  assert.equal(
    insertConflict(`- insert:\n    - id: user-row\n      name: '@dsh-chamber/dsh-host-client-graph'\n`, CLIENT_GRAPH),
    'name-bound',
  )
  const duplicate = `- insert:\n    - id: client-graph\n      name: '@dsh-chamber/dsh-host-client-graph'\n    - id: client-graph\n      name: '@dsh-chamber/dsh-host-client-graph'\n`
  assert.equal(insertConflict(duplicate, CLIENT_GRAPH), 'duplicate-identity')
})

// ---------------------------------------------------------------------------
// host-graph-seed reuse — the local overlay render is byte-identical and the
// conflict classification drives the same fail-loud decisions
// ---------------------------------------------------------------------------

test('buildPatchOverlay materializes EXACTLY renderCordisInserts output (single render source)', t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cordis-inserts-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = buildPatchOverlay(dir, [HOST_GRAPH_INSERT, HOST_GIT_WORKTREE_INSERT])
  const onDisk = readFileSync(path, 'utf8')
  assert.equal(onDisk, renderCordisInserts([CLIENT_GRAPH, GIT_WORKTREE]))
  assert.equal(onDisk, GOLDEN_BOTH)
  assert.equal(join(dir, HOST_GRAPH_PATCH_FILENAME), path)
})

test('missingHostPackageInserts consumes the shared insertConflict classification', () => {
  // The conflict decisions (duplicate / id-bound / name-bound wording is the
  // host-graph-seed fail-loud surface) stay intact on top of the shared
  // classification — host-graph-seed.test.ts covers the full matrix; this
  // pins the wiring direction.
  const profile = `- insert:
    - id: client-graph
      name: '${HOST_GRAPH_PACKAGE_NAME}'
`
  assert.deepEqual(
    missingHostPackageInserts(profile, [HOST_GRAPH_INSERT, HOST_GIT_WORKTREE_INSERT]),
    [HOST_GIT_WORKTREE_INSERT],
  )
})
