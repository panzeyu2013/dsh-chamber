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
 *   node scripts/gates/verify-test-wiring.mjs            # gate (exit 1 on unwired)
 *   node scripts/gates/verify-test-wiring.mjs --list     # report, never fails
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
  // Dev runtime state (the desktop app's own .dev-user-data holds a harness
  // worktree with foreign *.test.mjs files): never part of the package's test
  // surface. Mirrors test-runner-lockstep.test.mjs's list.
  '.dev-user-data',
])

/** Wiring forms accepted for one test file. */
export const TEST_FILE_PATTERN = /\.test\.(?:ts|mjs)$/u

/**
 * macOS/Swift test surface (G24): `swift test` discovers XCTest cases by
 * convention, so a file renamed off the Package.swift testTarget path — or a
 * file whose methods stopped being named `func test*` — silently stops running
 * while every JS gate stays green. The Swift corpus is therefore scanned with
 * the same both-directions lockstep as packages/scripts: every file on disk
 * must be inside a declared testTarget AND test-bearing, every declared
 * testTarget must have files, and the root manifest must expose a Swift-suite
 * script the gate entry (`run-checks.mjs`) actually references.
 */
export const SWIFT_TEST_SCAN_ROOT = 'macos/Tests'
export const SWIFT_TEST_FILE_PATTERN = /\.swift$/u
export const SWIFT_TEST_FUNC_PATTERN = /\bfunc\s+test[A-Za-z0-9_]*\s*\(/u

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
 * Collect every Swift file under macos/Tests.
 * @param {string} repoRoot - repository root.
 * @returns {string[]} repository-relative Swift file paths, sorted.
 */
export function collectSwiftTestFiles(repoRoot) {
  const absolute = join(repoRoot, SWIFT_TEST_SCAN_ROOT)
  if (!existsSync(absolute)) return []
  return walkFiles(absolute, candidate => SWIFT_TEST_FILE_PATTERN.test(candidate))
    .map(path => relative(repoRoot, path).split(sep).join('/'))
    .sort()
}

/**
 * Parse the test targets declared in macos/Package.swift. The path defaults to
 * `Tests/<name>` (SwiftPM's convention) and is relative to the package root.
 * @param {string} packageSwiftText - Package.swift content.
 * @returns {{ name: string, path: string }[]} declared test targets in file order.
 */
export function parseSwiftTestTargets(packageSwiftText) {
  const targets = []
  for (const match of String(packageSwiftText ?? '').matchAll(/\.testTarget\(([\s\S]*?)\n\s*\)/gu)) {
    const name = /name:\s*"([^"]+)"/u.exec(match[1])?.[1]
    if (name === undefined) continue
    const path = /path:\s*"([^"]+)"/u.exec(match[1])?.[1] ?? `Tests/${name}`
    targets.push({ name, path })
  }
  return targets
}

/**
 * Escape one literal for use inside a RegExp.
 * @param {string} value - literal text.
 * @returns {string} escaped text.
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/**
 * Read the root manifest's Swift-suite script. Both wiring forms count: a raw
 * `swift test ...` command and a delegation to run-swift-tests.mjs.
 * @param {unknown} manifest - parsed root package.json.
 * @returns {{ name: string, command: string } | null} the first matching script.
 */
export function findSwiftTestScript(manifest) {
  const scripts = manifest !== null && typeof manifest === 'object' ? manifest.scripts : undefined
  if (scripts === null || typeof scripts !== 'object') return null
  for (const [name, command] of Object.entries(scripts)) {
    if (typeof command !== 'string') continue
    if (/\bswift\s+test\b/u.test(command) || /run-swift-tests\.mjs/u.test(command)) {
      return { name, command }
    }
  }
  return null
}

/**
 * Lockstep between macos/Tests and the gate entry: the manifest must expose a
 * Swift-suite script, and run-checks.mjs must reference that exact script name
 * so a darwin `check:tests`/`check:full` really reaches it.
 * @param {object} input - wiring evidence.
 * @param {{ name: string, command: string } | null} input.script - `findSwiftTestScript` output.
 * @param {string} input.runChecksText - scripts/gates/run-checks.mjs content.
 * @returns {string[]} problems, empty when the wiring is complete.
 */
export function swiftWiringProblems({ script, runChecksText }) {
  if (script === null) {
    return ['root package.json has no script that runs the Swift suite (swift test / run-swift-tests.mjs)']
  }
  const referenced = new RegExp(`['"]${escapeRegExp(script.name)}['"]`, 'u').test(String(runChecksText ?? ''))
  if (!referenced) {
    return [`scripts/gates/run-checks.mjs does not reference the Swift-suite script '${script.name}' on darwin`]
  }
  return []
}

/**
 * Decide which Swift test files XCTest can never discover, in both directions.
 * @param {object} input - collected inputs.
 * @param {string[]} input.testFiles - repository-relative Swift file paths.
 * @param {{ name: string, path: string }[]} input.targets - repo-relative testTarget paths.
 * @param {(relativePath: string) => string | null} input.readFile - Swift source reader.
 * @param {readonly { path: string, reason: string }[]} [input.allowlist] - accepted exceptions.
 * @returns {{ unwired: { path: string, reason: string }[], allowlisted: string[], corpusSize: number, missingTargets: string[] }} verdict.
 */
export function findUnwiredSwiftTests({ testFiles, targets, readFile, allowlist = UNWIRED_ALLOWLIST }) {
  const allowlistedPaths = new Set(allowlist.map(entry => entry.path))
  const unwired = []
  const allowlisted = []
  for (const file of testFiles) {
    if (allowlistedPaths.has(file)) {
      allowlisted.push(file)
      continue
    }
    const inTarget = targets.some(target => file === target.path || file.startsWith(target.path + '/'))
    if (!inTarget) {
      unwired.push({ path: file, reason: 'not under a Package.swift testTarget path (never compiled)' })
      continue
    }
    const text = readFile(file)
    if (text === null) {
      unwired.push({ path: file, reason: 'unreadable' })
      continue
    }
    if (!SWIFT_TEST_FUNC_PATTERN.test(text)) {
      unwired.push({ path: file, reason: 'no func test* declaration (XCTest would not discover it)' })
    }
  }
  const missingTargets = targets
    .filter(target => !testFiles.some(file => file === target.path || file.startsWith(target.path + '/')))
    .map(target => target.path)
  return { unwired, allowlisted, corpusSize: testFiles.length, missingTargets }
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

/**
 * Detect repeated group keys in a test manifest.
 *
 * A manifest groups its files under a top-level `'name': [` key, and a JavaScript
 * object literal keeps the LAST value of a repeated key: a path listed under an
 * earlier duplicate never runs while `wiringEvidence` still matches its text, so
 * the gate would report it as wired. The sidebar's placeholder `'visual-lock': []`
 * silently shadowed a real source lock exactly that way (2026-12). Unique keys are
 * what make the text-match verdict trustworthy.
 * @param {string} source - manifest source text.
 * @returns {string[]} keys declared more than once, in first-seen order.
 */
export function findDuplicateGroupKeys(source) {
  const counts = new Map()
  for (const match of String(source ?? '').matchAll(/^ {2}["']([^"']+)["']: \[/gmu)) {
    counts.set(match[1], (counts.get(match[1]) ?? 0) + 1)
  }
  return [...counts].filter(([, count]) => count > 1).map(([key]) => key)
}

/** Render the allowlist as a reviewer-visible report line. */
function describeAllowlist(allowlist) {
  return allowlist.map(entry => `  - ${entry.path} — ${entry.reason}`).join('\n')
}

/** Read a UTF-8 file, or null when it is absent/unreadable. */
function readTextOrNull(path) {
  if (!existsSync(path)) return null
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function main() {
  const listOnly = process.argv.includes('--list')
  const testFiles = collectTestFiles(REPO_ROOT)
  const evidence = wiringEvidence(REPO_ROOT, testFiles)
  const { unwired, allowlisted, corpusSize } = findUnwiredTests({ testFiles, evidence })

  // macOS/Swift corpus (G24): files ↔ Package.swift testTargets, plus the
  // manifest ↔ run-checks lockstep around the Swift-suite script.
  const swiftFiles = collectSwiftTestFiles(REPO_ROOT)
  const packageSwift = readTextOrNull(join(REPO_ROOT, 'macos', 'Package.swift')) ?? ''
  const swiftTargets = parseSwiftTestTargets(packageSwift).map(target => ({
    ...target,
    path: 'macos/' + target.path,
  }))
  const swiftVerdict = findUnwiredSwiftTests({
    testFiles: swiftFiles,
    targets: swiftTargets,
    readFile: file => readTextOrNull(join(REPO_ROOT, file)),
  })
  const swiftScript = findSwiftTestScript(
    JSON.parse(readTextOrNull(join(REPO_ROOT, 'package.json')) ?? '{}'),
  )
  const swiftProblems = [
    ...swiftVerdict.unwired.map(entry => `${entry.path} — ${entry.reason}`),
    ...swiftVerdict.missingTargets.map(path => `${path} — declared testTarget has no Swift file (empty test target)`),
    ...swiftWiringProblems({
      script: swiftScript,
      runChecksText: readTextOrNull(join(REPO_ROOT, 'scripts', 'gates', 'run-checks.mjs')) ?? '',
    }),
  ]
  if (swiftTargets.length === 0) swiftProblems.push('macos/Package.swift declares no testTarget — nothing would compile')
  if (swiftVerdict.corpusSize === 0) swiftProblems.push('macos/Tests holds no Swift test files — a gate that scans nothing has not passed')

  // Manifest shadows: a repeated group key never runs its earlier list.
  const manifestShadows = []
  const scannedPackages = new Set()
  for (const file of testFiles) {
    const segments = file.split('/')
    if (segments[0] !== 'packages' || segments.length < 3 || scannedPackages.has(segments[1])) continue
    scannedPackages.add(segments[1])
    const manifest = join(REPO_ROOT, 'packages', segments[1], 'scripts', 'test.mjs')
    const text = readTextOrNull(manifest)
    if (text === null) continue
    for (const key of findDuplicateGroupKeys(text)) {
      manifestShadows.push(`packages/${segments[1]}/scripts/test.mjs — group '${key}' is declared twice (JS keeps the last value, so the earlier list never runs)`)
    }
  }

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
    console.log(`swift wiring: ${swiftVerdict.corpusSize} Swift test file(s) in ${swiftTargets.length} testTarget(s), ${swiftProblems.length} problem(s)`)
    for (const problem of swiftProblems) console.log(`  - ${problem}`)
    return
  }
  if (unwired.length > 0 || swiftProblems.length > 0 || manifestShadows.length > 0) {
    if (unwired.length > 0) {
      console.error(`test wiring: ${unwired.length} test file(s) are on disk but no script runs them:`)
      for (const file of unwired) console.error(`  - ${file}`)
      console.error('Add each file to its package `test` script (or the owning file list), or record a justified allowlist entry.')
    }
    if (manifestShadows.length > 0) {
      console.error(`test wiring: ${manifestShadows.length} shadowed group list(s) — the file looks wired but never runs:`)
      for (const shadow of manifestShadows) console.error(`  - ${shadow}`)
    }
    if (swiftProblems.length > 0) {
      console.error(`swift test wiring: ${swiftProblems.length} problem(s) — XCTest would not run every file:`)
      for (const problem of swiftProblems) console.error(`  - ${problem}`)
      console.error('Keep macos/Tests inside Package.swift testTargets with func test* declarations, and reference the Swift-suite script from run-checks.mjs.')
    }
    process.exit(1)
  }
  console.log(`test wiring: ${corpusSize} test file(s) all wired by a script`)
  console.log(`swift wiring: ${swiftVerdict.corpusSize} Swift test file(s) wired via ${swiftScript?.name ?? '?'}`)
}

const isEntry = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isEntry) main()
