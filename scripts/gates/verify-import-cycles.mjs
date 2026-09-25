#!/usr/bin/env node
/**
 * Import-cycle gate (G-C) — first-party source must be free of VALUE import
 * cycles; type-level cycles are reported and counted.
 *
 * WHY. A value cycle makes module evaluation order load-bearing: whether a
 * binding is initialized when the other module reads it depends on which entry
 * the bundler/node reached first, so a cycle that "works" today breaks when an
 * unrelated import is added. Type-only cycles are erased at compile time and
 * are therefore not runtime hazards, but they still couple two modules that
 * cannot be understood (or split) independently — so they are counted here.
 *
 * WHAT IS CHECKED. Every packages/* /src source file's RELATIVE imports and
 * re-exports, resolved to files. Value edges form one graph, type-only edges
 * another; an SCC of size > 1 (or a self-loop) in the value graph is a runtime
 * cycle and fails the gate. An SCC in the full graph that is not a value SCC is
 * a type-level cycle: printed with a count, reported (never silently ignored).
 *
 * File-only, read-only, no artifacts. --self-test runs the same checker over a
 * synthetic fixture (one value cycle, one type cycle) as a negative control.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Type-level cycle allowance (RATCHET, never a target). Type cycles are erased
 * at compile time, so this set is a debt list, not a runtime hazard; the gate
 * fails when an allowance entry disappears (delete it in the same change) and
 * when any SCC outside this list appears.
 *
 * EMPTY (audit round): the shell-core ⇄ 8 shell-ipc-* type cycle was broken by
 * extracting the seam types into leaf modules (host-edges.ts /
 * shell-assembly-ctx.ts / shell-ipc-ctx.ts / registry-projection.ts); the
 * registrars now depend on shell-ipc-ctx.ts, not on shell-core.ts. Keep it
 * empty — a new entry needs the same documented reason + retirement condition.
 */
const TYPE_CYCLE_ALLOWANCE = []

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * Directory names that never carry first-party source: build output, mirrors and
 * test fixtures live under them.
 */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'test', 'tests', 'scripts', 'vendor', 'generated'])

/**
 * Every first-party `packages/*` source file (plus the desktop package's
 * root-level production modules, which have no src/).
 *
 * Dot-directories are skipped: they hold tooling and dev state, never source.
 * `packages/desktop/.dev-user-data/` is the live case — a gitignored dev root
 * holding a full managed-dsh worktree (1440 reachable .ts files whose cycles
 * belong to the upstream, not to this repository); scanning it turned a local
 * `--dev` run into 20 bogus cycle findings. The parameter is injectable so the
 * skip rule is a testable unit (see verify-import-cycles.test.mjs) instead of a
 * claim in a comment.
 * @param {string} [packagesDir] - the directory holding the workspace packages.
 * @returns {string[]} absolute paths of the scanned source files.
 */
export function sourceFiles(packagesDir = join(ROOT, 'packages')) {
  const files = []
  for (const pkg of readdirSync(packagesDir)) {
    const pkgDir = join(packagesDir, pkg)
    const roots = []
    try { if (statSync(join(pkgDir, 'src')).isDirectory()) roots.push(join(pkgDir, 'src')) } catch { /* root-level package */ }
    // The desktop main process keeps its production modules at the package
    // root (no src/): scan them too, or the largest host graph goes unchecked.
    try { if (statSync(pkgDir).isDirectory()) roots.push(pkgDir) } catch { continue }
    for (const root of roots) {
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
          walk(full)
          continue
        }
        if (/\.(ts|tsx|mts|cts)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) files.push(full)
      }
    }
    walk(root)
    }
  }
  return files
}

/** Parse one file into { spec, typeOnly } edges (relative specifiers only). */
export function parseEdges(text) {
  const edges = []
  const statements = [
    { re: /(^|\n)\s*import\s+type\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g, force: 'type' },
    { re: /(^|\n)\s*import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g, force: 'auto' },
    { re: /(^|\n)\s*export\s+type\s+\{([\s\S]*?)\}\s*from\s+['"]([^'"]+)['"]/g, force: 'type' },
    { re: /(^|\n)\s*export\s+\{([\s\S]*?)\}\s*from\s+['"]([^'"]+)['"]/g, force: 'auto' },
  ]
  for (const { re, force } of statements) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(text))) {
      const clause = m[2]
      const spec = m[3]
      if (!spec.startsWith('.')) continue
      let typeOnly = force === 'type'
      if (force === 'auto') {
        // The bare `import` regex also matches `import type …`; honour the
        // leading type keyword before inspecting the clause.
        if (/^\s*type\s/.test(clause)) { edges.push({ spec, typeOnly: true }); continue }
        const hasDefault = /^\s*[A-Za-z_$][\w$]*\s*(,|$)/.test(clause)
        const hasNamespace = /\*\s+as\s/.test(clause)
        const names = (clause.match(/\{([\s\S]*?)\}/) ?? [])[1]
        const allTyped = names !== undefined && names.split(',').every((part) => {
          const s = part.trim()
          return s === '' || s.startsWith('//') || s.startsWith('type ')
        })
        typeOnly = !hasDefault && !hasNamespace && allTyped
      }
      edges.push({ spec, typeOnly })
    }
  }
  const dynamic = /import\(\s*['"]([^'"]+)['"]\s*\)/g
  let d
  while ((d = dynamic.exec(text))) if (d[1].startsWith('.')) edges.push({ spec: d[1], typeOnly: false })
  return edges
}

export function resolveSpec(fromFile, spec) {
  const base = resolve(dirname(fromFile), spec)
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.mts`, `${base}.cts`, join(base, 'index.ts'), join(base, 'index.tsx')]
  for (const candidate of candidates) {
    try { if (statSync(candidate).isFile()) return candidate } catch { /* keep trying */ }
  }
  return null
}

export function buildGraph(files) {
  const value = new Map()
  const all = new Map()
  for (const file of files) {
    const edges = parseEdges(readFileSync(file, 'utf8'))
    const vTargets = new Set()
    const aTargets = new Set()
    for (const edge of edges) {
      const target = resolveSpec(file, edge.spec)
      if (target === null || target === file) { if (target === file) vTargets.add(file); continue }
      aTargets.add(target)
      if (!edge.typeOnly) vTargets.add(target)
    }
    value.set(file, vTargets)
    all.set(file, aTargets)
  }
  return { value, all }
}

/** Tarjan SCC over a Map<node, Set<node>>. Returns components of size > 1 plus self-loops. */
export function stronglyConnected(graph) {
  const index = new Map()
  const low = new Map()
  const onStack = new Set()
  const stack = []
  const components = []
  let counter = 0
  const visit = (node) => {
    index.set(node, counter); low.set(node, counter); counter++
    stack.push(node); onStack.add(node)
    for (const next of graph.get(node) ?? []) {
      if (!index.has(next)) { visit(next); low.set(node, Math.min(low.get(node), low.get(next))) }
      else if (onStack.has(next)) low.set(node, Math.min(low.get(node), index.get(next)))
    }
    if (low.get(node) === index.get(node)) {
      const component = []
      for (;;) {
        const top = stack.pop(); onStack.delete(top); component.push(top)
        if (top === node) break
      }
      components.push(component)
    }
  }
  for (const node of graph.keys()) if (!index.has(node)) visit(node)
  const cycles = []
  for (const component of components) {
    if (component.length > 1) cycles.push(component)
    else if ((graph.get(component[0]) ?? new Set()).has(component[0])) cycles.push(component)
  }
  return cycles
}

function report(cycles, label) {
  console.log(`${label}: ${cycles.length}`)
  for (const cycle of cycles) {
    console.log(`  - ${cycle.map((f) => relative(ROOT, f)).sort().join(' <-> ')}`)
  }
}

function selfTest() {
  const dir = mkdtempSync(join(tmpdir(), 'import-cycle-gate-'))
  try {
    writeFileSync(join(dir, 'a.ts'), "import { b } from './b.ts'\n")
    writeFileSync(join(dir, 'b.ts'), "import { a } from './a.ts'\n")
    writeFileSync(join(dir, 'c.ts'), "import type { d } from './d.ts'\n")
    writeFileSync(join(dir, 'd.ts'), "import { type c } from './c.ts'\n")
    const files = ['a.ts', 'b.ts', 'c.ts', 'd.ts'].map((name) => join(dir, name))
    const { value, all } = buildGraph(files)
    const valueCycles = stronglyConnected(value)
    const fullCycles = stronglyConnected(all)
    const ok = valueCycles.length === 1 && valueCycles[0].length === 2 && fullCycles.length === 2
    console.log(ok ? 'self-test: OK (1 value cycle, 1 type-level cycle detected)' : `self-test: FAILED (value ${valueCycles.length}, full ${fullCycles.length})`)
    process.exitCode = ok ? 0 : 1
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function main() {
  if (process.argv.includes('--self-test')) { selfTest(); return }
  const files = sourceFiles()
  const { value, all } = buildGraph(files)
  const valueCycles = stronglyConnected(value)
  const fullCycles = stronglyConnected(all)
  const typeCycles = fullCycles.filter((component) => {
    const key = [...component].sort().join('\u0000')
    return !valueCycles.some((v) => [...v].sort().join('\u0000') === key)
  })
  console.log(`import-cycle gate: ${files.length} source file(s) scanned`)
  report(valueCycles, 'value (runtime) cycles')
  report(typeCycles, 'type-level cycles')
  let failed = false
  if (valueCycles.length > 0) {
    console.error('FAIL: value import cycles make module evaluation order load-bearing — break the cycle or move the shared face into a leaf module.')
    failed = true
  }
  for (const cycle of typeCycles) {
    const actual = cycle.map((file) => relative(ROOT, file)).sort().join('\u0000')
    const allowed = TYPE_CYCLE_ALLOWANCE.find((entry) => [...entry.files].sort().join('\u0000') === actual)
    if (allowed === undefined) {
      console.error('FAIL: type-level cycle not in the allowance — make the SCC a leaf or add a documented allowance entry:')
      console.error('  ' + cycle.map((file) => relative(ROOT, file)).sort().join(' <-> '))
      failed = true
    } else {
      console.log(`allowance: ${allowed.reason}`)
    }
  }
  for (const entry of TYPE_CYCLE_ALLOWANCE) {
    const allowed = [...entry.files].sort().join('\u0000')
    if (!typeCycles.some((cycle) => cycle.map((file) => relative(ROOT, file)).sort().join('\u0000') === allowed)) {
      console.error('FAIL: allowance entry no longer matches a type cycle — remove it in the same change that broke the cycle:')
      console.error('  ' + entry.reason)
      failed = true
    }
  }
  if (failed) process.exitCode = 1
}
main()
