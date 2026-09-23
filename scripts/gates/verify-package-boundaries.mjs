#!/usr/bin/env node
/**
 * verify-package-boundaries.mjs — R4 P7 package-boundary gate (criteria A + B).
 *
 * A — no cross-package relative import in PRODUCTION source. Scan surface:
 *     packages/<pkg>/src/** matching .ts/.tsx/.mts/.cts/.js/.mjs/.cjs.
 *     A relative specifier is resolved (POSIX normalization, no extension
 *     probing); when it escapes the file's own package directory it is a
 *     violation — unless it resolves into vendor/ AND the exact
 *     (consumer, vendorFile) pair is registered in
 *     scripts/upstream/registry.json vendorSourceConsumers (the SAME block C16
 *     reads; there is no second allowlist here). Type-only imports count too;
 *     extraction runs on a decoy-proof code projection (see
 *     scripts/upstream/verify-upstream-touchpoints-vendor.mjs).
 *
 * B — exports faces are an explicit allowlist. For every packages/<pkg>/package.json:
 *     a key containing '*' is a violation; declared faces and the EXPORTS_ALLOWLIST
 *     entry for that package must be equal in BOTH directions; every target must
 *     be an in-package './' path; a './src/' target must exist on disk (a source
 *     face), a './lib/' or './dist/' target is a build-output face and its
 *     existence is deliberately NOT checked; './package.json' is built in. The
 *     allowlist is explicit on purpose: a new public face must be a reviewed,
 *     one-line registration here.
 *
 * FALSE-POSITIVE BOUNDARIES (all locked by --self-test):
 *   1. test faces are outside A: packages/<pkg>/test/** is never scanned. The
 *      cross-package relative imports there are deliberate lockstep evidence
 *      (seed packages only export ./dist), and text reads via
 *      readFileSync(new URL(...)) are not imports at all.
 *   2. build configuration is outside A (P6 deleted the two tsdown configs;
 *      the scan root is src/ only, so no exemption is needed).
 *   3. scripts/** is outside A (repository tooling convention; scan root fixed).
 *   4. relative imports INSIDE vendor/ are not policed (read-only upstream tree;
 *      the scan root never enters vendor/).
 *   5. bare specifiers — including @dsh-chamber/* — are not judged by A; whether
 *      they resolve is proven by typecheck/build, not here.
 *   6. ./package.json, files, main and types are outside B (upstream mirror
 *      shape); B judges exports subpath keys and their targets only.
 *
 * Usage:
 *   node scripts/gates/verify-package-boundaries.mjs            # A + B on the real repo
 *   node scripts/gates/verify-package-boundaries.mjs --self-test # embedded controls incl. all 6 boundaries
 *   node scripts/gates/verify-package-boundaries.mjs --help
 *
 * Exit codes: 0 pass · 1 gate failure · 2 usage error.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadRegistry, validateRegistry } from '../upstream/registry.mjs'
import { resolveRelativeSpecifier, sourceModuleSpecifiers } from '../upstream/verify-upstream-touchpoints-vendor.mjs'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

/** Scanned production source extensions (A). */
const SOURCE_FILE = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/u

/** Directories A never enters: build output, test faces, tooling, vendor. */
const SKIP_DIRS = new Set(['node_modules', 'test', 'tests', 'dist', 'lib', 'vendor', 'coverage'])

/** Repo-relative '/'-separated path. */
const repoRel = (root, full) => relative(root, full).split(sep).join('/')

/** Key of one registered vendor-source consumer pair (single source: registry block). */
export const vendorAllowanceKey = (consumer, vendorFile) => consumer + '\u0000' + vendorFile

/**
 * Every production source file under packages/<pkg>/src (sorted, repo-relative).
 * @param {string} root - repository root.
 * @returns {string[]} repo-relative source paths.
 */
export function collectProductionSourceFiles(root = ROOT) {
  const files = []
  const packagesDir = join(root, 'packages')
  if (!existsSync(packagesDir)) return files
  for (const pkg of readdirSync(packagesDir).sort()) {
    const src = join(packagesDir, pkg, 'src')
    if (!existsSync(src) || !statSync(src).isDirectory()) continue
    const walk = (dir) => {
      const entries = readdirSync(dir, { withFileTypes: true })
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) continue
          walk(full)
        } else if (SOURCE_FILE.test(entry.name)) {
          files.push(repoRel(root, full))
        }
      }
    }
    walk(src)
  }
  return files.sort()
}

/**
 * A verdict: relative imports that escape their package (vendor escapes allowed
 * only by the registry pair set).
 * @param {object} input - collected facts.
 * @param {{ file: string, packageDir: string, text: string }[]} input.sources - production sources.
 * @param {Set<string>} input.vendorAllowances - vendorAllowanceKey(consumer, vendorFile) set.
 * @returns {{ violations: string[], checked: number, vendorAllowed: number }} verdict.
 */
export function boundaryAVerdict({ sources, vendorAllowances }) {
  const violations = []
  let checked = 0
  let vendorAllowed = 0
  for (const source of sources) {
    for (const item of sourceModuleSpecifiers(source.text)) {
      if (!item.specifier.startsWith('.')) continue // boundary 5
      checked += 1
      const resolved = resolveRelativeSpecifier(source.file, item.specifier)
      if (resolved.startsWith(source.packageDir + '/')) continue
      if (resolved.startsWith('vendor/') && vendorAllowances.has(vendorAllowanceKey(source.file, resolved))) {
        vendorAllowed += 1
        continue
      }
      violations.push(source.file + ':' + item.line + ' -> ' + item.specifier + ' resolves to ' + resolved
        + ' (cross-package relative import in production source; use a package specifier, or register the vendor pair in registry.vendorSourceConsumers)')
    }
  }
  return { violations, checked, vendorAllowed }
}

/** All string leaves of one exports value (string or nested condition object). */
export function leafTargets(value) {
  if (typeof value === 'string') return [value]
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return []
  return Object.values(value).flatMap(leafTargets)
}

/**
 * The explicit exports-face allowlist (R4 target state). Keys are package
 * DIRECTORY paths; values are the allowed subpath faces (./package.json is
 * built in and never listed). A new public face must be registered here in the
 * same change that declares it.
 */
export const EXPORTS_ALLOWLIST = Object.freeze({
  'packages/cli': [],
  'packages/control-plane': ['.'],
  'packages/desktop': [],
  'packages/renderer': ['./global.d.ts'],
  'packages/dsh-api-gateway': ['.', './client'],
  'packages/dsh-client-connection': ['.', './client'],
  'packages/dsh-client-web': ['.'],
  'packages/dsh-chamber-client-core': [
    '.',
    './aggregate-store',
    './authority-log-store',
    './boot-gap-shape',
    './client-plugin-loader',
    './derive',
    './hover-intent',
    './instance-api',
    './managed-runtime',
    './open-intent',
    './open-outcome',
    './pending-click',
    './plugin-graph-classify',
    './plugin-manifest',
    './plugin-row',
    './prewarm-intent',
    './purged-tracker',
    './runtime-management',
    './search-state',
    './session-create-ledger',
    './session-fact-reconcile',
    './session-mutations',
    './session-row-state',
    './session-row-window',
    './settings-shell',
    './subagent-lineage',
    './svg-resource-scope',
    './todo-attention',
    './todo-prefs',
    './view-prefs',
    './wire-common',
    './workspace-drag-order',
    './workspace-git-flags',
    './workspace-mutations',
  ],
  'packages/dsh-chamber-client-ui-git': ['.', './client'],
  'packages/dsh-chamber-client-ui-layout': ['.', './client'],
  'packages/dsh-chamber-client-ui-mobile': ['.', './client'],
  'packages/dsh-chamber-client-ui-open-in': ['.', './client', './machine-catalog'],
  'packages/dsh-chamber-client-ui-settings-bridge': ['.', './client'],
  'packages/dsh-chamber-client-ui-settings-connections': ['.', './client', './section'],
  'packages/dsh-chamber-client-ui-sidebar': ['.', './client', './invariant'],
  'packages/dsh-chamber-seed-archive-cleanup': ['.'],
  'packages/dsh-chamber-seed-client-graph': ['.'],
  'packages/dsh-chamber-seed-git-worktree': ['.'],
  'packages/dsh-chamber-seed-open-in': ['.'],
  'packages/dsh-chamber-wire': ['.', './plugin-manifest', './plugin-row', './runtime-status'],
  'packages/dsh-runtime': ['.'],
  'packages/dsh-stream-state': ['.'],
  'packages/gateway': ['.'],
})

/**
 * B verdict over collected package manifests.
 * @param {object} input - collected facts.
 * @param {{ dir: string, path: string, exports: unknown }[]} input.manifests - package manifests.
 * @param {(repoRelPath: string) => boolean} input.exists - in-repo target existence probe.
 * @param {Record<string, string[]>} [input.allowlist] - face allowlist (defaults to the real table).
 * @returns {{ violations: string[], checkedFaces: number, buildFaces: number }} verdict.
 */
export function exportsFaceVerdict({ manifests, exists, allowlist = EXPORTS_ALLOWLIST }) {
  const violations = []
  let checkedFaces = 0
  let buildFaces = 0
  const byDir = new Map(manifests.map((manifest) => [manifest.dir, manifest]))
  for (const dir of Object.keys(allowlist).sort()) {
    if (!byDir.has(dir)) {
      violations.push('B allowlist registers a package that does not exist: ' + dir)
      continue
    }
    const manifest = byDir.get(dir)
    const declared = manifest.exports === undefined
      ? []
      : Object.keys(manifest.exports).filter((face) => face !== './package.json')
    const allowed = allowlist[dir]
    for (const face of declared) {
      if (!allowed.includes(face)) {
        violations.push(manifest.path + ': exports face ' + face + ' is declared but not registered in the allowlist')
      }
    }
    for (const face of allowed) {
      if (!declared.includes(face)) {
        violations.push(manifest.path + ': allowlist registers ' + face + ' but the package does not declare it')
      }
    }
  }
  for (const manifest of manifests) {
    if (allowlist[manifest.dir] === undefined) {
      const faces = manifest.exports === undefined
        ? []
        : Object.keys(manifest.exports).filter((face) => face !== './package.json')
      if (faces.length > 0) {
        violations.push(manifest.path + ': package is not registered in the exports allowlist but declares ' + faces.length + ' face(s)')
      }
      continue
    }
    if (manifest.exports === undefined) continue
    for (const [face, value] of Object.entries(manifest.exports)) {
      if (face.includes('*')) {
        violations.push(manifest.path + ': exports key contains a wildcard: ' + face)
        continue
      }
      if (face === './package.json') continue // boundary 6
      checkedFaces += 1
      const targets = leafTargets(value)
      if (targets.length === 0) {
        violations.push(manifest.path + ': exports face ' + face + ' has no string target')
        continue
      }
      for (const target of targets) {
        if (!target.startsWith('./') || target.split('/').includes('..')) {
          violations.push(manifest.path + ': exports face ' + face + ' target must be an in-package ./ path: ' + target)
          continue
        }
        if (target.startsWith('./src/')) {
          if (!exists(manifest.dir + '/' + target.slice(2))) {
            violations.push(manifest.path + ': exports face ' + face + ' -> ' + target + ' does not exist (source targets must be real)')
          }
        } else if (target.startsWith('./lib/') || target.startsWith('./dist/')) {
          buildFaces += 1 // build-output face: existence is deliberately not checked
        } else {
          violations.push(manifest.path + ': exports face ' + face + ' target ' + target + ' is neither a src/ nor a lib//dist/ build face')
        }
      }
    }
  }
  return { violations, checkedFaces, buildFaces }
}

/**
 * Every package manifest under packages/ (sorted, repo-relative dirs).
 * @param {string} root - repository root.
 * @returns {{ dir: string, path: string, exports: unknown, packageName?: string }[]} manifests.
 */
export function collectPackageManifests(root = ROOT) {
  const out = []
  const packagesDir = join(root, 'packages')
  if (!existsSync(packagesDir)) return out
  for (const pkg of readdirSync(packagesDir).sort()) {
    const full = join(packagesDir, pkg, 'package.json')
    if (!existsSync(full)) continue
    const manifest = JSON.parse(readFileSync(full, 'utf8'))
    out.push({
      dir: 'packages/' + pkg,
      path: 'packages/' + pkg + '/package.json',
      exports: manifest.exports,
      packageName: manifest.name,
    })
  }
  return out
}

/** Load the registry and return the vendor allowance set, or null (with a reason). */
export function vendorAllowancesFromRegistry(root = ROOT) {
  try {
    const registry = loadRegistry(join(root, 'scripts', 'upstream', 'registry.json'))
    const findings = validateRegistry(registry)
    if (findings.length > 0) return { error: 'registry.json schema invalid: ' + findings.join('; ') }
    if (!Array.isArray(registry.vendorSourceConsumers) || registry.vendorSourceConsumers.length === 0) {
      return { error: 'registry.vendorSourceConsumers is missing/empty — criterion A has no vendor allowance source (one registry block only)' }
    }
    return { allowances: new Set(registry.vendorSourceConsumers.map((entry) => vendorAllowanceKey(entry.consumer, entry.vendorFile))) }
  } catch (error) {
    return { error: 'cannot load scripts/upstream/registry.json: ' + (error instanceof Error ? error.message : String(error)) }
  }
}

/** Run A + B over one repository root. */
export function runGate({ root = ROOT } = {}) {
  const failures = []
  const registryRead = vendorAllowancesFromRegistry(root)
  if (registryRead.error !== undefined) failures.push(registryRead.error)
  const files = collectProductionSourceFiles(root)
  if (files.length === 0) failures.push('scan surface is 0 files: criterion A has nothing to judge and must never pass silently')
  const sources = files.map((file) => ({
    file,
    packageDir: file.split('/').slice(0, 2).join('/'),
    text: readFileSync(join(root, file), 'utf8'),
  }))
  const a = boundaryAVerdict({ sources, vendorAllowances: registryRead.allowances ?? new Set() })
  failures.push(...a.violations)
  const manifests = collectPackageManifests(root)
  const b = exportsFaceVerdict({ manifests, exists: (target) => existsSync(join(root, target)) })
  failures.push(...b.violations)
  return { failures, a, b, files: files.length, manifests: manifests.length }
}

// ---------------------------------------------------------------------------
// --self-test: one control per criterion and per false-positive boundary.
// ---------------------------------------------------------------------------

/**
 * Embedded negative/positive controls. Uses a synthetic repository for the
 * boundary cases plus the real repo as the positive control.
 * @returns {{ ok: boolean, cases: { name: string, ok: boolean, detail?: string }[] }} outcome.
 */
export function runSelfTest() {
  const cases = []
  const check = (name, fn) => {
    try {
      fn()
      cases.push({ name, ok: true })
    } catch (error) {
      cases.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) })
    }
  }
  const assert = (condition, message) => { if (!condition) throw new Error(message) }
  const fixture = mkdtempSync(join(tmpdir(), 'pkg-boundaries-'))
  const write = (rel, text) => {
    const full = join(fixture, rel)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, text)
  }
  try {
    write('packages/a/src/local.ts', "import { x } from './x.ts'\nimport { y } from '@dsh-chamber/whatever'\nimport { z } from 'node:z'\n")
    write('packages/a/src/cross.ts', "import { b } from '../../b/src/internal.ts'\n")
    write('packages/a/src/vendor-registered.ts', "import { v } from '../../../vendor/p/src/z.ts'\n")
    write('packages/a/src/vendor-unregistered.ts', "import { v } from '../../../vendor/p/src/z.ts'\n")
    write('packages/a/test/escape.test.ts', "import { b } from '../../b/src/internal.ts'\n")
    write('packages/a/tsdown.config.ts', "import { t } from '../b/src/tool.ts'\n")
    write('packages/a/scripts/tool.mjs', "import { t } from '../../b/src/tool.ts'\n")
    write('packages/a/dist/bundle.mjs', "import { b } from '../../b/src/internal.ts'\n")
    write('packages/b/src/internal.ts', 'export const b = 1\n')
    write('vendor/p/src/z.ts', "import { q } from '../../q/src/q.ts'\nexport const v = 1\n")

    const fixtureSources = (names) => collectProductionSourceFiles(fixture)
      .filter((file) => names === undefined || names.includes(file))
      .map((file) => ({ file, packageDir: file.split('/').slice(0, 2).join('/'), text: readFileSync(join(fixture, file), 'utf8') }))
    const registeredKey = vendorAllowanceKey('packages/a/src/vendor-registered.ts', 'vendor/p/src/z.ts')

    check('A control: cross-package relative import is a violation', () => {
      const verdict = boundaryAVerdict({ sources: fixtureSources(['packages/a/src/cross.ts']), vendorAllowances: new Set() })
      assert(verdict.violations.length === 1, 'expected exactly one violation, got ' + verdict.violations.length)
      assert(verdict.violations[0].includes('packages/a/src/cross.ts'), verdict.violations[0])
    })

    check('A control: in-package relative imports and bare specifiers are clean (boundary 5)', () => {
      const verdict = boundaryAVerdict({ sources: fixtureSources(['packages/a/src/local.ts']), vendorAllowances: new Set() })
      assert(verdict.violations.length === 0, verdict.violations.join('; '))
      assert(verdict.checked === 1, 'only the ./ relative specifier is judged, got ' + verdict.checked)
    })

    check('A control: a vendor escape is red until the exact pair is registered, then allowed', () => {
      const names = ['packages/a/src/vendor-registered.ts', 'packages/a/src/vendor-unregistered.ts']
      const red = boundaryAVerdict({ sources: fixtureSources(names), vendorAllowances: new Set() })
      assert(red.violations.length === 2, 'both vendor escapes must be red without registration')
      const allowed = boundaryAVerdict({ sources: fixtureSources(names), vendorAllowances: new Set([registeredKey]) })
      assert(allowed.violations.length === 1, 'the unregistered consumer must stay red')
      assert(allowed.violations[0].includes('vendor-unregistered'), allowed.violations[0])
      assert(allowed.vendorAllowed === 1, 'the registered pair must be counted as allowed')
    })

    check('A boundary 1: packages/<pkg>/test/** is not scanned', () => {
      const files = collectProductionSourceFiles(fixture)
      assert(!files.includes('packages/a/test/escape.test.ts'), 'test face must be outside the scan surface')
    })

    check('A boundaries 2+3: build config at the package root and scripts/** are not scanned', () => {
      const files = collectProductionSourceFiles(fixture)
      assert(!files.includes('packages/a/tsdown.config.ts'), 'build config must be outside the scan surface')
      assert(!files.includes('packages/a/scripts/tool.mjs'), 'package scripts must be outside the scan surface')
      assert(!files.some((file) => file.includes('/dist/')), 'dist output must be outside the scan surface')
    })

    check('A boundary 4: relative imports inside vendor/ are not policed', () => {
      const files = collectProductionSourceFiles(fixture)
      assert(!files.some((file) => file.startsWith('vendor/')), 'the scan root must never enter vendor/')
    })

    check('A control: a 0-file scan surface is a failure, never a silent pass', () => {
      const emptyRoot = join(fixture, 'empty-root')
      mkdirSync(join(emptyRoot, 'packages/empty/src'), { recursive: true })
      assert(collectProductionSourceFiles(emptyRoot).length === 0, 'the empty fixture root must have no sources')
      assert(runGate({ root: emptyRoot }).failures.some((item) => item.includes('scan surface is 0 files')), 'an empty surface must fail the gate')
    })

    const manifest = (dir, exportsValue) => ({ dir, path: dir + '/package.json', exports: exportsValue })
    const existsAll = () => true
    const existsNone = () => false

    check('B control: a registered src face passes', () => {
      const verdict = exportsFaceVerdict({
        manifests: [manifest('packages/a', { '.': './src/index.ts' })],
        exists: existsAll,
        allowlist: { 'packages/a': ['.'] },
      })
      assert(verdict.violations.length === 0, verdict.violations.join('; '))
      assert(verdict.checkedFaces === 1, 'one face must be checked')
    })

    check('B control: a wildcard exports key is red', () => {
      const verdict = exportsFaceVerdict({
        manifests: [manifest('packages/a', { './src/*': './src/x.ts' })],
        exists: existsAll,
        allowlist: { 'packages/a': ['./src/*'] },
      })
      assert(verdict.violations.some((item) => item.includes('wildcard')), verdict.violations.join('; '))
    })

    check('B control: a declared-but-unregistered face is red', () => {
      const verdict = exportsFaceVerdict({
        manifests: [manifest('packages/a', { '.': './src/index.ts', './extra': './src/extra.ts' })],
        exists: existsAll,
        allowlist: { 'packages/a': ['.'] },
      })
      assert(verdict.violations.some((item) => item.includes('declared but not registered')), verdict.violations.join('; '))
    })

    check('B control: a registered-but-undeclared face is red (two-way table)', () => {
      const verdict = exportsFaceVerdict({
        manifests: [manifest('packages/a', { '.': './src/index.ts' })],
        exists: existsAll,
        allowlist: { 'packages/a': ['.', './client'] },
      })
      assert(verdict.violations.some((item) => item.includes('does not declare it')), verdict.violations.join('; '))
    })

    check('B control: a missing ./src/ target is red', () => {
      const verdict = exportsFaceVerdict({
        manifests: [manifest('packages/a', { '.': './src/index.ts' })],
        exists: existsNone,
        allowlist: { 'packages/a': ['.'] },
      })
      assert(verdict.violations.some((item) => item.includes('does not exist')), verdict.violations.join('; '))
    })

    check('B control: ./lib and ./dist targets are build faces (existence not checked)', () => {
      const verdict = exportsFaceVerdict({
        manifests: [manifest('packages/a', { '.': { types: './lib/types/index.d.ts', default: './dist/index.js' } })],
        exists: existsNone,
        allowlist: { 'packages/a': ['.'] },
      })
      assert(verdict.violations.length === 0, verdict.violations.join('; '))
      assert(verdict.buildFaces === 2, 'both build-output targets must be classified, got ' + verdict.buildFaces)
    })

    check('B control: a non-./ target is red', () => {
      const verdict = exportsFaceVerdict({
        manifests: [manifest('packages/a', { '.': 'src/index.ts' })],
        exists: existsAll,
        allowlist: { 'packages/a': ['.'] },
      })
      assert(verdict.violations.some((item) => item.includes('in-package ./ path')), verdict.violations.join('; '))
    })

    check('B boundary 6: ./package.json, files, main and types are not judged', () => {
      const verdict = exportsFaceVerdict({
        manifests: [{ ...manifest('packages/a', { './package.json': './package.json' }), files: ['lib/x.js'], main: 'lib/index.js', types: 'lib/index.d.ts' }],
        exists: existsNone,
        allowlist: { 'packages/a': [] },
      })
      assert(verdict.violations.length === 0, verdict.violations.join('; '))
      assert(verdict.checkedFaces === 0, 'no face may be checked')
    })

    check('B control: an unregistered package with declared faces is red', () => {
      const verdict = exportsFaceVerdict({
        manifests: [manifest('packages/z', { '.': './src/index.ts' })],
        exists: existsAll,
        allowlist: { 'packages/a': [] },
      })
      assert(verdict.violations.some((item) => item.includes('not registered in the exports allowlist')), verdict.violations.join('; '))
    })
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }

  check('real repo: the production scan surface is non-empty and A is clean (registry vendor rows allowed)', () => {
    const files = collectProductionSourceFiles(ROOT)
    assert(files.length > 0, 'the real repo must have production sources to scan')
    const registryRead = vendorAllowancesFromRegistry(ROOT)
    assert(registryRead.error === undefined, String(registryRead.error))
    const sources = files.map((file) => ({
      file,
      packageDir: file.split('/').slice(0, 2).join('/'),
      text: readFileSync(join(ROOT, file), 'utf8'),
    }))
    const verdict = boundaryAVerdict({ sources, vendorAllowances: registryRead.allowances })
    assert(verdict.violations.length === 0, verdict.violations.join('; '))
  })

  check('real repo: the B allowlist matches every package manifest (both directions)', () => {
    const verdict = exportsFaceVerdict({
      manifests: collectPackageManifests(ROOT),
      exists: (target) => existsSync(join(ROOT, target)),
    })
    assert(verdict.violations.length === 0, verdict.violations.join('; '))
  })

  return { ok: cases.every((item) => item.ok), cases }
}

const USAGE = [
  'usage: node scripts/gates/verify-package-boundaries.mjs [--self-test|--help]',
  '',
  '  (no flag)    run criterion A + B over the repository',
  '  --self-test  run the embedded controls (one per criterion and per false-positive boundary)',
  '  --help       print this usage',
  '',
  'exit codes: 0 pass · 1 gate failure · 2 usage error',
].join('\n')

function main(argv) {
  const unknown = argv.filter((argument) => !['--self-test', '--help', '-h'].includes(argument))
  if (unknown.length > 0) {
    console.error('verify-package-boundaries: unknown argument ' + unknown.join(' '))
    console.error(USAGE)
    process.exitCode = 2
    return
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE)
    return
  }
  if (argv.includes('--self-test')) {
    const outcome = runSelfTest()
    for (const item of outcome.cases) console.log((item.ok ? '✓ ' : '✗ ') + item.name + (item.ok ? '' : ' — ' + item.detail))
    if (!outcome.ok) {
      console.error('\n✗ verify-package-boundaries --self-test: ' + outcome.cases.filter((item) => !item.ok).length + ' of ' + outcome.cases.length + ' controls failed')
      process.exitCode = 1
      return
    }
    console.log('\n✓ verify-package-boundaries --self-test: ' + outcome.cases.length + ' controls passed')
    return
  }
  const { failures, a, b, files } = runGate()
  console.log('A: scanned ' + files + ' production sources, ' + a.checked + ' relative imports, ' + a.vendorAllowed + ' registered vendor rows allowed')
  console.log('B: checked ' + b.checkedFaces + ' exports faces across the allowlist, ' + b.buildFaces + ' lib/dist build faces')
  if (failures.length > 0) {
    for (const failure of failures) console.error('✗ ' + failure)
    console.error('\n✗ verify-package-boundaries: ' + failures.length + ' violation(s)')
    process.exitCode = 1
    return
  }
  console.log('✓ verify-package-boundaries: A (no cross-package relative import) + B (exports allowlist) clean')
}

const isEntry = (() => {
  const invoked = process.argv[1]
  if (invoked === undefined) return false
  try {
    return realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()
if (isEntry) main(process.argv.slice(2))
