/**
 * Test-wiring gate: every `*.test.ts` / `*.test.mjs` in the repository must be
 * reachable from a script that actually runs, so a newly added test cannot sit
 * on disk while the aggregate command stays green with less coverage than it
 * claims.
 *
 * Why the check is shaped this way (2026-12 pre-flight findings):
 * - Scope is the owning package, plus the root manifest. A package's test file
 *   may legitimately be wired by the root manifest (`packages/control-plane/
 *   test/smoke.test.ts` is the root `smoke` script), so root references count
 *   for every package.
 * - Matching accepts the package-relative path, the root-relative path, or the
 *   bare basename, because the repository wires tests in all three forms
 *   (`node ./scripts/test.mjs` file lists, `node test/x.test.ts` chains, and
 *   `node packages/<pkg>/test/x.test.ts` root scripts).
 * - An empty corpus is a failure: a gate that scans nothing has not passed.
 *
 * Usage:
 *   node scripts/dev/verify-test-wiring.mjs            # gate (exit 1 on unwired)
 *   node scripts/dev/verify-test-wiring.mjs --list     # report, never fails
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/** Repository directories that are scanned for test files. */
export const TEST_SCAN_ROOTS = ['packages', 'scripts']

/** Directory names never descended into while scanning. */
export const IGNORED_DIRECTORIES = new Set([
  'node_modules',
  'vendor',
  'dist',
  'lib',
  'release',
  '.git',
  '.desktop-build',
  'coverage',
])

/** Wiring forms accepted for one test file. */
export const TEST_FILE_PATTERN = /\.test\.(?:ts|mjs)$/u

/**
 * Test files intentionally kept out of every script, each with the reason a
 * reviewer accepted. Adding an entry requires the same justification a reader
 * would need to trust the gate stays meaningful.
 * @type {readonly { path: string, reason: string }[]}
 */
export const UNWIRED_ALLOWLIST = []

/**
 * List every file under `root` matching `predicate`, skipping ignored directories.
 * @param {string} root - absolute directory to walk.
 * @param {(path: string) => boolean} predicate - receives absolute file paths.
 * @returns {string[]} matching absolute paths, sorted.
 */
export function walkFiles(root, predicate) {
  const found = []
  const visit = (directory) => {
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name)) continue
        visit(path)
        continue
      }
      if (entry.isFile() && predicate(path)) found.push(path)
    }
  }
  visit(root)
  return found.sort()
}

/**
 * Collect test files from each scan root.
 * @param {string} repoRoot - repository root.
 * @returns {string[]} repository-relative test file paths, sorted.
 */
export function collectTestFiles(repoRoot) {
  const files = []
  for (const scanRoot of TEST_SCAN_ROOTS) {
    const absolute = join(repoRoot, scanRoot)
    if (!existsSync(absolute)) continue
    for (const path of walkFiles(absolute, candidate => TEST_FILE_PATTERN.test(candidate))) {
      files.push(relative(repoRoot, path).split(sep).join('/'))
    }
  }
  return files.sort()
}

/**
 * Read every string a manifest contributes as wiring evidence.
 * @param {string} manifestPath - absolute `package.json` path.
 * @returns {string} concatenated script text, empty when unreadable.
 */
function manifestScripts(manifestPath) {
  if (!existsSync(manifestPath)) return ''
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const scripts = manifest !== null && typeof manifest === 'object' ? manifest.scripts : undefined
    if (scripts === null || typeof scripts !== 'object') return ''
    return Object.values(scripts).filter(value => typeof value === 'string').join('\n')
  } catch {
    return ''
  }
}

/**
 * Read every `.mjs`/`.mts` helper beside a package that may carry a file list.
 * @param {string} directory - absolute directory to read.
 * @returns {string} concatenated text of helper modules.
 */
function helperText(directory) {
  if (!existsSync(directory)) return ''
  const parts = []
  for (const path of walkFiles(directory, candidate => /\.(?:mjs|mts|ts)$/u.test(candidate))) {
    try {
      parts.push(readFileSync(path, 'utf8'))
    } catch {
      /* unreadable helper contributes no wiring evidence */
    }
  }
  return parts.join('\n')
}

/**
 * Build the wiring-evidence map keyed by the package that owns each test file.
 * @param {string} repoRoot - repository root.
 * @param {string[]} testFiles - repository-relative test file paths.
 * @returns {{ root: string, byPackage: Map<string, string> }} wiring texts.
 */
export function wiringEvidence(repoRoot, testFiles) {
  // Root evidence is the root manifest only: every repository-level test file is
  // wired from a root script, and reading `scripts/**` here would let an
  // unrelated gate's prose count as wiring.
  const root = manifestScripts(join(repoRoot, 'package.json'))
  const byPackage = new Map()
  const packages = new Set()
  for (const file of testFiles) {
    const segments = file.split('/')
    if (segments[0] === 'packages' && segments.length > 2) packages.add(segments[1])
  }
  for (const name of packages) {
    const directory = join(repoRoot, 'packages', name)
    byPackage.set(name, [
      manifestScripts(join(directory, 'package.json')),
      helperText(join(directory, 'scripts')),
    ].join('\n'))
  }
  return { root, byPackage }
}

/**
 * Decide which test files no script reaches.
 * @param {object} input - collected inputs.
 * @param {string[]} input.testFiles - repository-relative test file paths.
 * @param {{ root: string, byPackage: Map<string, string> }} input.evidence - wiring texts.
 * @param {readonly { path: string, reason: string }[]} [input.allowlist] - accepted exceptions.
 * @returns {{ unwired: string[], allowlisted: string[], corpusSize: number }} verdict.
 */
export function findUnwiredTests({ testFiles, evidence, allowlist = UNWIRED_ALLOWLIST }) {
  const allowlistedPaths = new Set(allowlist.map(entry => entry.path))
  const unwired = []
  const allowlisted = []
  for (const file of testFiles) {
    if (allowlistedPaths.has(file)) {
      allowlisted.push(file)
      continue
    }
    const base = file.split('/').pop() ?? file
    const segments = file.split('/')
    const packageText = segments[0] === 'packages' ? evidence.byPackage.get(segments[1]) ?? '' : ''
    const matches = (text) => text !== '' && (text.includes(file) || text.includes(base))
    if (matches(evidence.root) || matches(packageText)) continue
    unwired.push(file)
  }
  return { unwired, allowlisted, corpusSize: testFiles.length }
}

/** Render the allowlist as a reviewer-visible report line. */
function describeAllowlist(allowlist) {
  return allowlist.map(entry => `  - ${entry.path} — ${entry.reason}`).join('\n')
}

function main() {
  const listOnly = process.argv.includes('--list')
  const testFiles = collectTestFiles(REPO_ROOT)
  const evidence = wiringEvidence(REPO_ROOT, testFiles)
  const { unwired, allowlisted, corpusSize } = findUnwiredTests({ testFiles, evidence })

  if (corpusSize === 0) {
    console.error('test wiring: no test files found — a gate that scans nothing has not passed')
    process.exit(1)
  }
  if (allowlisted.length > 0) {
    console.log(`test wiring: ${allowlisted.length} allowlisted file(s):`)
    console.log(describeAllowlist(UNWIRED_ALLOWLIST))
  }
  if (listOnly) {
    console.log(`test wiring: ${corpusSize} test file(s), ${unwired.length} unwired`)
    for (const file of unwired) console.log(`  - ${file}`)
    return
  }
  if (unwired.length > 0) {
    console.error(`test wiring: ${unwired.length} test file(s) are on disk but no script runs them:`)
    for (const file of unwired) console.error(`  - ${file}`)
    console.error('Add each file to its package `test` script (or the owning file list), or record a justified allowlist entry.')
    process.exit(1)
  }
  console.log(`test wiring: ${corpusSize} test file(s) all wired by a script`)
}

const isEntry = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isEntry) main()
