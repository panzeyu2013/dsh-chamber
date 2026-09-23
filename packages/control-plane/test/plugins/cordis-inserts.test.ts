/**
 * cordis-inserts.ts unit tests (cross-package protocol single-sourcing):
 *   - renderCordisInserts: the canonical `- insert:` bytes (byte-exact), the
 *     validation point (empty / invalid rows / duplicates throw);
 *   - parseLoaderRows / hasExactInsert / fieldCount: the comment-aware
 *     parse family the conflict decisions rest on (nested config names never
 *     complete a loader identity; name-first rows work; boundaries hold);
 *   - insertConflict: the shared classification host-graph-seed.ts and
 *     plugin-sync.ts both map onto their own message wording;
 *   - the id-targeted non-insert shape (renderCordisDisablePatches /
 *     renderCordisOverlay): the disable row bytes, the mixed overlay order, the
 *     disable-only overlay, validation, and the fact that a disable row never
 *     joins the insert identity parse the desktop probe reads;
 *   - the host-graph-seed reuse: buildPatchOverlay materializes EXACTLY
 *     renderCordisOverlay output (byte-identical overlay render).
 * Run directly: node packages/control-plane/test/plugins/cordis-inserts.test.ts
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
  renderCordisDisablePatches,
  renderCordisInserts,
  renderCordisOverlay,
  type CordisInsert,
} from '../../src/cordis-inserts.ts'
import {
  buildPatchOverlay,
  HOST_GIT_WORKTREE_INSERT,
  HOST_GRAPH_INSERT,
  HOST_GRAPH_PATCH_FILENAME,
  OFFICIAL_OPEN_IN_DISABLE,
} from '../../src/host-graph-seed.ts'

const CLIENT_GRAPH: CordisInsert = { id: 'client-graph', name: '@dsh-chamber/dsh-chamber-seed-client-graph' }
const GIT_WORKTREE: CordisInsert = { id: 'git-worktree', name: '@dsh-chamber/dsh-chamber-seed-git-worktree' }

/** The canonical overlay bytes (the dsh-app-boot loadOverlayPatches shape). */
const GOLDEN_ONE = `- insert:
    - id: client-graph
      name: '@dsh-chamber/dsh-chamber-seed-client-graph'
`
const GOLDEN_BOTH = `- insert:
    - id: client-graph
      name: '@dsh-chamber/dsh-chamber-seed-client-graph'
    - id: git-worktree
      name: '@dsh-chamber/dsh-chamber-seed-git-worktree'
`
/** The id-targeted non-insert row (the loader PatchOptions disable form). */
const GOLDEN_OFFICIAL_DISABLE = `- id: open-in-app
  name: '@deepseek-ai/dsh-host-open-in-app'
  disabled: true
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
// renderCordisDisablePatches / renderCordisOverlay (the non-insert rows)
// ---------------------------------------------------------------------------

test('renderCordisDisablePatches emits the canonical id-targeted disable bytes', () => {
  assert.equal(renderCordisDisablePatches([OFFICIAL_OPEN_IN_DISABLE]), GOLDEN_OFFICIAL_DISABLE)
})

test('renderCordisOverlay appends the disable rows AFTER the insert bundle (pure-insert bytes unchanged)', () => {
  assert.equal(renderCordisOverlay([CLIENT_GRAPH]), GOLDEN_ONE, 'no disables = the legacy insert-only bytes')
  assert.equal(renderCordisOverlay([CLIENT_GRAPH, GIT_WORKTREE]), GOLDEN_BOTH)
  assert.equal(renderCordisOverlay([], [OFFICIAL_OPEN_IN_DISABLE]), GOLDEN_OFFICIAL_DISABLE,
    'a disable-only overlay is legal (every insert row is user-owned in the profile patch)')
  assert.equal(
    renderCordisOverlay([CLIENT_GRAPH, GIT_WORKTREE], [OFFICIAL_OPEN_IN_DISABLE]),
    GOLDEN_BOTH + GOLDEN_OFFICIAL_DISABLE,
    'the disable applies after the rows an earlier layer mounted',
  )
})

test('renderCordisDisablePatches is a validation point: invalid id/name and duplicate targets throw', () => {
  assert.throws(
    () => renderCordisDisablePatches([{ id: 'bad id!', name: '@deepseek-ai/x' }]),
    /invalid overlay row/,
  )
  assert.throws(
    () => renderCordisDisablePatches([{ id: 'ok-id', name: 'not-a-scoped-package' }]),
    /invalid overlay row/,
  )
  assert.throws(
    () => renderCordisDisablePatches([
      OFFICIAL_OPEN_IN_DISABLE,
      { ...OFFICIAL_OPEN_IN_DISABLE, name: '@deepseek-ai/other-package' },
    ]),
    /duplicate overlay row/,
  )
})

test('renderCordisOverlay refuses an empty list and a disable that targets a row it inserts', () => {
  assert.throws(() => renderCordisOverlay([], []), /at least one row/)
  assert.throws(
    () => renderCordisOverlay(
      [{ id: 'open-in-app', name: '@dsh-chamber/dsh-chamber-seed-open-in-app' }],
      [OFFICIAL_OPEN_IN_DISABLE],
    ),
    /targets a row this overlay inserts/,
  )
})

test('a disable row never joins the insert identity parse (the desktop probe keeps reading mounts)', () => {
  const mixed = GOLDEN_BOTH + GOLDEN_OFFICIAL_DISABLE
  assert.equal(parseLoaderRows(mixed).length, 2, 'the disable row is not an insert row')
  assert.equal(hasExactInsert(mixed, CLIENT_GRAPH), true)
  assert.equal(hasExactInsert(mixed, GIT_WORKTREE), true)
  assert.equal(insertConflict(mixed, CLIENT_GRAPH), null)
  assert.equal(fieldCount(mixed, 'id', 'open-in-app'), 1, 'the disable target id is counted once, never as an insert')
})

// ---------------------------------------------------------------------------
// parseLoaderRows / hasExactInsert / fieldCount
// ---------------------------------------------------------------------------

test('parseLoaderRows reads direct block rows and ignores YAML comments', () => {
  const patch = `# a comment header
- insert:
    # another comment
    - id: client-graph
      name: '@dsh-chamber/dsh-chamber-seed-client-graph' # trailing comment
`
  const rows = parseLoaderRows(patch)
  assert.equal(rows.length, 1)
  assert.deepEqual(rows[0]!.ids, ['client-graph'])
  assert.deepEqual(rows[0]!.names, ['@dsh-chamber/dsh-chamber-seed-client-graph'])
})

test('parseLoaderRows keeps name-first rows and inline-flow rows as one loader row each', () => {
  const nameFirst = `- insert:
    - name: '@dsh-chamber/dsh-chamber-seed-git-worktree'
      id: git-worktree
`
  assert.deepEqual(parseLoaderRows(nameFirst)[0]!.ids, ['git-worktree'])
  assert.deepEqual(parseLoaderRows(nameFirst)[0]!.names, ['@dsh-chamber/dsh-chamber-seed-git-worktree'])
  const inline = `- insert: [{ id: git-worktree, name: '@dsh-chamber/dsh-chamber-seed-git-worktree' }, { id: other, name: '@dsh-chamber/other' }]
`
  assert.equal(parseLoaderRows(inline).length, 2)
})

test('parseLoaderRows never lets a nested config name complete a loader identity', () => {
  const nested = `- insert:
    - id: git-worktree
      name: '@example/not-chamber'
      config:
        name: '@dsh-chamber/dsh-chamber-seed-git-worktree'
`
  const rows = parseLoaderRows(nested)
  assert.equal(rows.length, 1)
  assert.deepEqual(rows[0]!.names, ['@example/not-chamber'], 'the nested config name is not a loader name')
})

test('hasExactInsert matches only a single exact id/name pair in one loader row', () => {
  const exact = `- insert:
    - id: git-worktree
      name: '@dsh-chamber/dsh-chamber-seed-git-worktree'
`
  assert.equal(hasExactInsert(exact, GIT_WORKTREE), true)
  assert.equal(hasExactInsert(exact, CLIENT_GRAPH), false)
  // Cross-paired siblings never produce a false exact match.
  const crossed = `- insert:
    - id: git-worktree
      name: '@example/not-chamber'
    - name: '@dsh-chamber/dsh-chamber-seed-git-worktree'
      id: another-git-service
`
  assert.equal(hasExactInsert(crossed, GIT_WORKTREE), false)
  // An exact name-first row is reused.
  const nameFirst = `- insert:
    - name: '@dsh-chamber/dsh-chamber-seed-git-worktree'
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
      name: '@dsh-chamber/dsh-chamber-seed-client-graph'
`
  assert.equal(fieldCount(patch, 'id', 'client-graph'), 1, 'client-graph-foo must not count as client-graph')
  assert.equal(fieldCount(patch, 'id', 'client-graph-foo'), 1)
  assert.equal(fieldCount(patch, 'name', '@dsh-chamber/dsh-chamber-seed-client-graph'), 1)
})

// ---------------------------------------------------------------------------
// insertConflict — the shared classification both consumers map to wording
// ---------------------------------------------------------------------------

test('insertConflict returns null for an exactly-present row and for a clean patch', () => {
  const exact = `- insert:
    - id: client-graph
      name: '@dsh-chamber/dsh-chamber-seed-client-graph'
`
  assert.equal(insertConflict(exact, CLIENT_GRAPH), null)
  assert.equal(insertConflict('# empty\n[]\n', CLIENT_GRAPH), null)
  assert.equal(insertConflict('', CLIENT_GRAPH), null)
})

test('insertConflict classifies duplicate identity / id-bound / name-bound', () => {
  assert.equal(
    insertConflict(`- insert:\n    - id: client-graph\n      name: '@dsh-chamber/dsh-chamber-seed-git-worktree'\n`, CLIENT_GRAPH),
    'id-bound',
  )
  assert.equal(
    insertConflict(`- insert:\n    - id: user-row\n      name: '@dsh-chamber/dsh-chamber-seed-client-graph'\n`, CLIENT_GRAPH),
    'name-bound',
  )
  const duplicate = `- insert:\n    - id: client-graph\n      name: '@dsh-chamber/dsh-chamber-seed-client-graph'\n    - id: client-graph\n      name: '@dsh-chamber/dsh-chamber-seed-client-graph'\n`
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

test('buildPatchOverlay materializes the insert bundle PLUS the disable rows (single render source)', t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cordis-overlay-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = buildPatchOverlay(dir, [HOST_GRAPH_INSERT], [OFFICIAL_OPEN_IN_DISABLE])
  const onDisk = readFileSync(path, 'utf8')
  assert.equal(onDisk, renderCordisOverlay([CLIENT_GRAPH], [OFFICIAL_OPEN_IN_DISABLE]))
  assert.equal(onDisk, GOLDEN_ONE + GOLDEN_OFFICIAL_DISABLE)
  assert.equal(join(dir, HOST_GRAPH_PATCH_FILENAME), path)
})

test('buildPatchOverlay writes a disable-only overlay (all insert rows user-owned)', t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cordis-disable-only-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = buildPatchOverlay(dir, [], [OFFICIAL_OPEN_IN_DISABLE])
  assert.equal(readFileSync(path, 'utf8'), GOLDEN_OFFICIAL_DISABLE)
})

