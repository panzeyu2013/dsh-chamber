/**
 * Unit lock for the import-cycle gate (G-C): the resolver/graph negative
 * controls the gate's own --self-test exercises, wired into the script-test
 * manifest so a regression in the scanner can never leave that self-test
 * manual. The real repository is asserted acyclic in the VALUE graph (the
 * gate's hard failure) and non-trivially sized (an empty scan is not a pass).
 * The dot-directory rule (gitignored dev state such as
 * packages/desktop/.dev-user-data/ is never first-party source) is locked with
 * an injectable-root fixture, so the skip cannot silently regress.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  buildGraph,
  parseEdges,
  resolveSpec,
  sourceFiles,
  stronglyConnected,
} from './verify-import-cycles.mjs'

test('parseEdges classifies value, type-only and dynamic edges', () => {
  const edges = parseEdges([
    "import { a } from './a.ts'",
    "import type { b } from './b.ts'",
    "import { type c } from './c.ts'",
    "import { d, type e } from './d.ts'",
    "const f = await import('./f.ts')",
    "import { external } from 'pkg'",
  ].join('\n'))
  assert.ok(edges.some((edge) => edge.spec === './a.ts' && edge.typeOnly === false), 'a value import')
  assert.ok(edges.some((edge) => edge.spec === './b.ts' && edge.typeOnly === true), 'a type-only import')
  assert.ok(edges.some((edge) => edge.spec === './c.ts' && edge.typeOnly === true), 'an inline type specifier')
  assert.ok(edges.some((edge) => edge.spec === './d.ts' && edge.typeOnly === false), 'a mixed import is a value edge')
  assert.ok(edges.some((edge) => edge.spec === './f.ts' && edge.typeOnly === false), 'a dynamic import')
  assert.ok(edges.every((edge) => edge.spec.startsWith('.')), 'a bare specifier is not a filesystem edge')
})

test('the graph finds a value cycle and keeps a type-only cycle out of it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'import-cycle-test-'))
  try {
    const sources = {
      a: "import { b } from './b.ts'\n",
      b: "import { a } from './a.ts'\n",
      c: "import type { d } from './d.ts'\n",
      d: "import { type c } from './c.ts'\n",
    }
    for (const [name, text] of Object.entries(sources)) writeFileSync(join(dir, name + '.ts'), text)
    const files = Object.keys(sources).map((name) => join(dir, name + '.ts'))
    const { value, all } = buildGraph(files)
    const valueCycles = stronglyConnected(value)
    const fullCycles = stronglyConnected(all)
    assert.equal(valueCycles.length, 1, 'the value cycle is a hard failure')
    assert.equal(valueCycles[0].length, 2)
    assert.equal(fullCycles.length, 2, 'the type-only cycle exists in the full graph')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveSpec resolves a relative module and reports a missing one as null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'import-cycle-resolve-'))
  try {
    writeFileSync(join(dir, 'a.ts'), '')
    assert.equal(resolveSpec(join(dir, 'b.ts'), './a.ts'), join(dir, 'a.ts'))
    assert.equal(resolveSpec(join(dir, 'b.ts'), './missing.ts'), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('sourceFiles skips dot-directories (dev state) and keeps the real sources', () => {
  const dir = mkdtempSync(join(tmpdir(), 'import-cycle-dotdir-'))
  try {
    const packages = join(dir, 'packages')
    const pkg = join(packages, 'pkg-a')
    mkdirSync(join(pkg, 'src', 'nested'), { recursive: true })
    // The gitignored dev-state shape that broke the gate: a full worktree under
    // a dot-directory, carrying its own value cycle.
    const hidden = join(pkg, '.dev-user-data', 'state', 'plugin', 'src')
    mkdirSync(hidden, { recursive: true })
    writeFileSync(join(pkg, 'src', 'a.ts'), '')
    writeFileSync(join(pkg, 'src', 'nested', 'b.ts'), '')
    writeFileSync(join(pkg, 'root.ts'), '')
    writeFileSync(join(hidden, 'cycle.ts'), "import { x } from './other.ts'\n")
    writeFileSync(join(hidden, 'other.ts'), "import { x } from './cycle.ts'\n")

    const files = sourceFiles(packages)
    assert.ok(files.some((file) => file.endsWith('a.ts')), 'src sources are scanned')
    assert.ok(files.some((file) => file.endsWith(join('nested', 'b.ts'))), 'nested src sources are scanned')
    assert.ok(files.some((file) => file.endsWith('root.ts')), 'the desktop-shaped root scan still works')
    assert.ok(files.every((file) => !file.includes('.dev-user-data')), 'dot-directories are never scanned')
    assert.deepEqual(stronglyConnected(buildGraph(files).value), [],
      'the hidden cycle cannot leak into the gate')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the real repository has no value-level import cycle', () => {
  const files = sourceFiles()
  assert.ok(files.length > 900, 'the scanner must see the production tree (got ' + files.length + ')')
  assert.deepEqual(stronglyConnected(buildGraph(files).value), [])
})
