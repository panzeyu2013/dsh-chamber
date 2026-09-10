/**
 * Unit tests for the C8 artifact-gate helpers (design 09 §3.6 / C8).
 *
 * The gate script itself is a top-level program; these tests pin the decision
 * semantics that a silent pass could hide: a skipped build is a failure, a
 * missing artifact is a failure, restore is byte-exact and removes extras.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { artifactGateVerdict, compareOutputs, restoreDir, snapshotDir } from './artifact-gate.mjs'

const withTempDir = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'artifact-gate-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('a skipped build is a hard failure (never a silent pass)', () => {
  const verdict = artifactGateVerdict({ stale: [], skipped: ['x/scripts/build.mjs（构建不可用：Cannot find module）'] })
  assert.equal(verdict.ok, false)
  assert.match(verdict.message, /无法重建产物/)
  assert.match(verdict.message, /--no-artifact-rebuild/)
})

test('stale outputs are a hard failure with the rebuild commands', () => {
  const verdict = artifactGateVerdict({ stale: ['a/dist/index.js'], skipped: [] })
  assert.equal(verdict.ok, false)
  assert.match(verdict.message, /不一致/)
  assert.match(verdict.message, /build:host-packages/)
  assert.match(verdict.message, /build:dsh-runtime/)
})

test('no observations is the only passing outcome', () => {
  assert.equal(artifactGateVerdict({ stale: [], skipped: [] }).ok, true)
})

test('snapshot/restore round-trips bytes and removes files created after the snapshot', () => {
  withTempDir((dir) => {
    const dist = join(dir, 'dist')
    mkdirSync(join(dist, 'nested'), { recursive: true })
    writeFileSync(join(dist, 'index.js'), 'original')
    writeFileSync(join(dist, 'nested', 'a.js'), 'nested-original')
    const snapshot = snapshotDir(dist)
    assert.deepEqual([...snapshot.keys()].sort(), ['index.js', 'nested/a.js'])

    // Simulate a build: rewrite one file, add a stray, delete another.
    writeFileSync(join(dist, 'index.js'), 'rebuilt')
    writeFileSync(join(dist, 'STRAY.js'), 'stray')
    rmSync(join(dist, 'nested', 'a.js'))

    restoreDir(dist, snapshot)
    assert.equal(readFileSync(join(dist, 'index.js'), 'utf8'), 'original')
    assert.equal(readFileSync(join(dist, 'nested', 'a.js'), 'utf8'), 'nested-original')
    assert.throws(() => readFileSync(join(dist, 'STRAY.js'), 'utf8'), /ENOENT/)
  })
})

test('snapshot of a missing directory is empty (no throw)', () => {
  withTempDir((dir) => {
    assert.equal(snapshotDir(join(dir, 'nope')).size, 0)
  })
})

test('compareOutputs reports missing and changed artifacts, not identical ones', () => {
  withTempDir((root) => {
    const dist = join(root, 'pkg', 'dist')
    mkdirSync(dist, { recursive: true })
    writeFileSync(join(dist, 'index.js'), 'committed')
    const snapshots = new Map([[dist, snapshotDir(dist)]])
    const toRelative = (abs, dir) => relative(dir, abs)
    const outputs = ['pkg/dist/index.js']
    assert.deepEqual(compareOutputs(outputs, root, snapshots, toRelative), [])

    writeFileSync(join(dist, 'index.js'), 'rebuilt')
    assert.deepEqual(compareOutputs(outputs, root, snapshots, toRelative), ['pkg/dist/index.js'])

    rmSync(join(dist, 'index.js'))
    const missing = compareOutputs(outputs, root, snapshots, toRelative)
    assert.equal(missing.length, 1)
    assert.match(missing[0], /缺失/)
  })
})

test('an unreadable artifact throws instead of comparing nothing', () => {
  withTempDir((dir) => {
    const dist = join(dir, 'dist')
    mkdirSync(dist, { recursive: true })
    writeFileSync(join(dist, 'index.js'), 'x')
    // A dangling symlink is the portable "present but unreadable" case (a
    // chmod-based case is meaningless when the tests may run as root).
    symlinkSync(join(dir, 'missing-target.js'), join(dist, 'broken.js'))
    assert.throws(() => snapshotDir(dist), /ENOENT/)
  })
})

test('artifact output paths resolve against the repository root, not the CWD', () => {
  withTempDir((root) => {
    const abs = join(root, 'packages', 'pkg', 'dist', 'index.js')
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, 'x')
    const snapshots = new Map([[dirname(abs), snapshotDir(dirname(abs))]])
    const stale = compareOutputs(['packages/pkg/dist/index.js'], root, snapshots, (file, dir) => relative(dir, file))
    assert.deepEqual(stale, [])
  })
})
