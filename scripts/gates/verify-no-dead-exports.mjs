/**
 * Dead-export gate (G-H) - every package entry's public surface must have
 * production consumers.
 *
 * WHY. A package's src/index.ts declares its public surface: direct
 * declarations plus re-exported modules. A wholesale export-* barrel or a stale
 * named re-export can grow without anyone importing the result. An export
 * nothing imports is a face with no consumer: it invites a second implementation
 * (the exact anti-pattern this refactor removes), it makes a future rename look
 * like API, and it hides which parts of the model are actually wired.
 *
 * WHAT IS CHECKED. Every first-party workspace package (the package list is
 * derived from pnpm-workspace.yaml - no package is named in this file) with a
 * src/index.ts. Every runtime export reachable through that index must be
 * named by a production importer: a named import, a namespace/default member
 * access, a dynamic-import member or a re-export in any .ts/.tsx/.mts/.mjs
 * file under packages/ or scripts/, the package's own production files
 * included, excluding tests and build output. An import through the package
 * specifier and a relative import that resolves inside the package directory are
 * the same consumer (the implementation is used either way; only the entry
 * re-export face is judged). An export with no importer is red unless it is
 * covered by a documented exemption.
 *
 * NOT JUDGED, but named with a reason so the skip is auditable:
 * - RUNTIME_LOADED_PACKAGES: entries the dsh plugin loader / host-graph insert
 *   loads at runtime by package name - no static importer exists by design.
 * - PENDING_PACKAGES: barrel narrowing assigned to another owner. The dead faces
 *   are still counted and printed, but do not fail this run. A pending package
 *   with no dead export is a zombie entry and FAILS - the list can only shrink
 *   as owners land their narrowing.
 *
 * EXEMPTIONS. DEAD_EXPORT_EXEMPTIONS names a real dead export per package, with
 * the reason a reviewer accepted and where the consumer lands. A stale exemption
 * (the export is imported or gone) is red: the list may not lie.
 *
 * NEGATIVE CONTROL: --self-test drives the pure resolver with a fabricated
 * module list whose one export has no importer and asserts it is reported, an
 * exemption silences it, a stale exemption is flagged, and the index parser does
 * not mistake comment text for an export name.
 *
 * Usage:
 *   node scripts/gates/verify-no-dead-exports.mjs            # gate
 *   node scripts/gates/verify-no-dead-exports.mjs --self-test
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { walkFiles } from '../lib/walk.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..')

/**
 * Exports with no production importer, each with the reason a reviewer accepted
 * and the consumer landing point. package is the directory name under
 * packages/; every entry must name a REAL dead export (a stale exemption fails).
 * @type {readonly { package: string, name: string, reason: string }[]}
 */
export const DEAD_EXPORT_EXEMPTIONS = [
  // Table value surface: the constants are consumed through CARRIER_ENV /
  // TABLE_SNAPSHOT by the reducer, the api-gateway and the G-G parity gate. The
  // values are the table's public record, so there is no direct importer by design.
  { package: 'dsh-stream-state', name: 'REBUILD_WINDOW_MS', reason: 'table value consumed via CARRIER_ENV + parity gate' },
  { package: 'dsh-stream-state', name: 'MAX_REBUILDS_PER_WINDOW', reason: 'table value consumed via CARRIER_ENV + parity gate' },
  { package: 'dsh-stream-state', name: 'MIN_REBUILD_SPACING_MS', reason: 'table value consumed via CARRIER_ENV + parity gate' },
  { package: 'dsh-stream-state', name: 'IN_FLIGHT_GRACE_MS', reason: 'table value consumed via CARRIER_ENV + parity gate' },
  { package: 'dsh-stream-state', name: 'OPENING_TIMEOUT_LADDER_MS', reason: 'table value consumed via openingBudgetMs + parity gate' },
  { package: 'dsh-stream-state', name: 'OPENING_STALL_STREAK', reason: 'table value consumed via CARRIER_ENV + parity gate' },
  // Differential-harness surface: imported by test/equivalence and
  // scripts/refactor/equivalence.mjs, not by a production module.
  { package: 'dsh-stream-state', name: 'reasonClassOf', reason: 'differential normalizer; consumed by the equivalence harness' },
  { package: 'dsh-stream-state', name: 'equivalents', reason: 'differential comparison; consumed by the equivalence harness' },
  // Aggregate reducers re-exported for the differential replay and the Swift
  // mirror; production callers use reduceCarrier/reduceSource.
  { package: 'dsh-stream-state', name: 'decideRebuild', reason: 'pure rebuild predicate; used by reduceCarrier and the vectors' },
  { package: 'dsh-stream-state', name: 'reduceSourceSequence', reason: 'source reducer replay face; used by the vectors' },
  { package: 'dsh-stream-state', name: 'collapseRecords', reason: 'ladder internal; used by planLadder + its suite' },
  // Presentation outer-bound helpers superseded by decidePresentation/planVeilTimer;
  // kept for the renderer suite's bound cases.
  { package: 'dsh-stream-state', name: 'surfaceBoundMs', reason: 'outer-bound helper; retires when the renderer tests use the frame API only' },
  { package: 'dsh-stream-state', name: 'veilUpperBoundMs', reason: 'outer-bound helper; retires when the renderer tests use the frame API only' },
  // Upstream host-plugin entry (src/index.ts is a [pure] mirror of the upstream
  // package, C1 byte-identical): name/inject/Config/apply are the cordis plugin
  // ABI the dsh loader reads at runtime; the browser half is imported through the
  // ./client subpath and does not consume the root entry.
  { package: 'dsh-client-connection', name: 'name', reason: 'upstream [pure] host-plugin entry: loader reads the plugin name at runtime (no static importer)' },
  { package: 'dsh-client-connection', name: 'inject', reason: 'upstream [pure] host-plugin entry: cordis reads inject at load time (no static importer)' },
  { package: 'dsh-client-connection', name: 'Config', reason: 'upstream [pure] host-plugin entry: config schema consumed by the dsh loader (no static importer)' },
  { package: 'dsh-client-connection', name: 'apply', reason: 'upstream [pure] host-plugin entry: dsh loader calls apply() by plugin ABI (no static importer)' },
]

/**
 * Package entries loaded at runtime by name, so their root index has no static
 * importer by design. Each entry carries the reason; none of these packages'
 * exports is judged as a dead face.
 * @type {Readonly<Record<string, string>>}
 */
export const RUNTIME_LOADED_PACKAGES = {
  'dsh-chamber-seed-client-graph': 'host-graph insert row: the dsh loader imports dist/index.js by package name and reads the default-exported gateway',
  'dsh-chamber-seed-git-worktree': 'host-graph insert row: the dsh loader imports dist/index.js by package name and reads the default-exported gateway',
  'dsh-chamber-seed-archive-cleanup': 'host-graph insert row: the dsh loader imports dist/index.js by package name and reads the default-exported gateway',
  'dsh-chamber-seed-open-in': 'host-graph insert row: the dsh loader imports dist/index.js by package name and reads the default-exported gateway',
  'dsh-chamber-client-ui-git': 'client-plugin loader: the composite entry imports the ./client half at build time; the root index apply() is the host plugin ABI the dsh loader calls',
  'dsh-chamber-client-ui-layout': 'client-plugin loader: the composite entry imports the ./client half at build time; the root index apply() is the host plugin ABI the dsh loader calls',
  'dsh-chamber-client-ui-mobile': 'client-plugin loader: the composite entry imports the ./client half at build time; the root index apply() is the host plugin ABI the dsh loader calls',
  'dsh-chamber-client-ui-open-in': 'client-plugin loader: the composite entry imports the ./client half at build time; the root index apply() is the host plugin ABI the dsh loader calls',
  'dsh-chamber-client-ui-settings-bridge': 'client-plugin loader: the composite entry imports the ./client half at build time; the root index apply() is the host plugin ABI the dsh loader calls',
  'dsh-chamber-client-ui-settings-connections': 'client-plugin loader: the composite entry imports the ./client half at build time; the root index apply() is the host plugin ABI the dsh loader calls',
  'dsh-chamber-client-ui-sidebar': 'client-plugin loader: the composite entry imports the ./client half at build time; the root index apply() is the host plugin ABI the dsh loader calls',
}

/**
 * Packages whose barrel narrowing is owned by another writer while a migration
 * lands. Their dead faces are counted and printed but do not fail this run; an
 * entry that no longer has a dead export is a zombie and fails instead. The
 * table is empty after the client-core barrel converged (R4 P3/P3b): its tests
 * now reference package-local sources, so a new entry is a deliberate,
 * time-boxed suppression, never a default.
 * @type {Readonly<Record<string, { owner: string, reason: string, retiresWhen: string }>>}
 */
export const PENDING_PACKAGES = {}

/** Strip comments so an import/export parser never reads prose as code. */
export function stripComments(sourceText) {
  let out = ''
  let index = 0
  const length = sourceText.length
  while (index < length) {
    const char = sourceText[index]
    const next = sourceText[index + 1]
    if (char === '/' && next === '/') {
      while (index < length && sourceText[index] !== '\n') index += 1
      continue
    }
    if (char === '/' && next === '*') {
      index += 2
      while (index < length && !(sourceText[index] === '*' && sourceText[index + 1] === '/')) index += 1
      index += 2
      continue
    }
    if (char === '"' || char === "'" || char === '\u0060') {
      out += char
      index += 1
      while (index < length) {
        out += sourceText[index]
        if (sourceText[index] === '\\') {
          index += 1
          if (index < length) out += sourceText[index]
        } else if (sourceText[index] === char) {
          index += 1
          break
        }
        index += 1
      }
      continue
    }
    out += char
    index += 1
  }
  return out
}

/** Parse export-* from './x.ts' (and named re-exports) out of the index. */
export function parseIndexModules(indexText) {
  const text = stripComments(indexText)
  const modules = []
  const star = /(?:^|\n)\s*export\s+\*\s+from\s+['"](\.[^'"]+)['"]/gu
  for (const match of text.matchAll(star)) modules.push(match[1])
  const named = /(?:^|\n)\s*export\s*(?:type\s+)?\{([^}]*)\}\s*from\s*['"](\.[^'"]+)['"]/gu
  for (const match of text.matchAll(named)) {
    const names = match[1].split(',').map((name) => name.trim().replace(/^type\s+/u, '').split(/\s+as\s+/u)[0].trim()).filter(Boolean)
    modules.push({ module: match[2], names })
  }
  return modules
}

/** Runtime exports of one module source (types are erased and not importable values). */
export function extractRuntimeExports(sourceText) {
  const text = stripComments(sourceText)
  const names = []
  const pattern = /(?:^|\n)\s*export\s+(?:async\s+)?(?:function|const|class)\s+([A-Za-z0-9_$]+)/gmu
  for (const match of text.matchAll(pattern)) {
    if (!names.includes(match[1])) names.push(match[1])
  }
  return names
}

/** Named imports of one module source: [{ source, names }]. */
export function collectImports(sourceText) {
  const text = stripComments(sourceText)
  const imports = []
  const pattern = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"]([^'"]+)['"]/gsu
  for (const match of text.matchAll(pattern)) {
    const names = match[1]
      .split(',')
      .map((name) => name.trim().replace(/^type\s+/u, '').split(/\s+as\s+/u)[0].trim())
      .filter(Boolean)
    imports.push({ source: match[2], names })
  }
  return imports
}

/** Workspace globs (packages: list) from pnpm-workspace.yaml. */
export function workspacePackageGlobs(repoRoot = REPO_ROOT) {
  const text = readFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'utf8')
  const globs = []
  let inPackages = false
  for (const line of text.split('\n')) {
    if (/^packages:\s*$/u.test(line)) { inPackages = true; continue }
    if (!inPackages) continue
    if (line.trim() === '') continue
    if (/^\S/u.test(line)) break
    const match = /^\s*-\s*['"]?([^'"#]+?)['"]?\s*(?:#.*)?$/u.exec(line)
    if (match !== null) globs.push(match[1].trim())
  }
  return globs
}

/**
 * First-party packages with a src/index.ts: the package list comes from
 * pnpm-workspace.yaml globs, filtered to direct children of packages/.
 * @returns {{ name: string, dir: string, spec: string, index: string }[]}
 */
export function discoverPackages(repoRoot = REPO_ROOT) {
  const dirs = new Set()
  for (const glob of workspacePackageGlobs(repoRoot)) {
    const star = glob.indexOf('*')
    if (star === -1) { dirs.add(resolve(repoRoot, glob)); continue }
    const base = glob.slice(0, star).replace(/\/+$/u, '')
    const rest = glob.slice(star + 1).replace(/^\/+/u, '')
    if (base === '' || rest.includes('*') || rest.includes('/')) continue
    const baseDir = resolve(repoRoot, base)
    if (!existsSync(baseDir)) continue
    for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
      if (entry.isDirectory()) dirs.add(join(baseDir, entry.name, rest))
    }
  }
  const packages = []
  for (const dir of [...dirs].sort()) {
    const rel = relative(repoRoot, dir).split(sep).join('/')
    if (!rel.startsWith('packages/') || rel.slice('packages/'.length).includes('/')) continue
    const index = join(dir, 'src', 'index.ts')
    const manifestPath = join(dir, 'package.json')
    if (!existsSync(index) || !existsSync(manifestPath)) continue
    let manifest
    try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) } catch { continue }
    if (typeof manifest.name !== 'string' || manifest.name === '') continue
    packages.push({ name: rel.slice('packages/'.length), dir, spec: manifest.name, index })
  }
  return packages
}

/**
 * Production importer names of one package's entry (see the header for the
 * consumer rule). Every file under packages/ and scripts/ is scanned, including
 * the package's own sources; tests and build output are excluded.
 * @returns {Set<string>}
 */
export function collectPackageConsumers(pkg, repoRoot = REPO_ROOT) {
  const imported = new Set()
  const files = [
    ...walkFiles(join(repoRoot, 'packages'), () => true),
    ...walkFiles(join(repoRoot, 'scripts'), () => true),
  ]
  for (const absolute of files) {
    if (!/\.(?:ts|tsx|mts|mjs)$/u.test(absolute)) continue
    const rel = relative(repoRoot, absolute).split(sep).join('/')
    if (rel.includes('/test/') || rel.includes('/tests/') || rel.includes('/dist/') || rel.includes('/lib/')) continue
    let raw
    try {
      raw = readFileSync(absolute, 'utf8')
    } catch {
      continue
    }
    const text = stripComments(raw)
    const inPackage = (source) => {
      if (source === pkg.spec || source.startsWith(pkg.spec + '/')) return true
      if (!source.startsWith('.')) return false
      const resolved = resolve(dirname(absolute), source)
      return resolved === pkg.dir || resolved.startsWith(pkg.dir + sep)
    }
    for (const entry of collectImports(text)) {
      if (!inPackage(entry.source)) continue
      for (const name of entry.names) imported.add(name)
    }
    const memberAccesses = (binding) => {
      const pattern = new RegExp('\\b' + binding.replace(/[$]/gu, '\\$&') + '\\.([A-Za-z0-9_$]+)\\b', 'gu')
      for (const match of text.matchAll(pattern)) imported.add(match[1])
    }
    for (const match of text.matchAll(/import\s+(?:type\s+)?(?:\*\s+as\s+([A-Za-z0-9_$]+)|([A-Za-z0-9_$]+))\s+from\s+['"]([^'"]+)['"]/gu)) {
      if (!inPackage(match[3])) continue
      const binding = match[1] ?? match[2]
      if (binding !== undefined) memberAccesses(binding)
    }
    for (const match of text.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"]([^'"]+)['"]/gsu)) {
      if (!inPackage(match[2])) continue
      for (const name of match[1].split(',').map((item) => item.trim().replace(/^type\s+/u, '').split(/\s+as\s+/u)[0].trim()).filter(Boolean)) imported.add(name)
    }
    const dynamicBindings = []
    for (const match of text.matchAll(/const\s+([A-Za-z0-9_$]+)\s*(?::[^=]*)?=\s*await[\s\S]{0,400}?import\(\s*['"]([^'"]+)['"]\s*\)/gu)) {
      if (inPackage(match[2])) dynamicBindings.push(match[1])
    }
    for (const match of text.matchAll(/const\s*\{([^}]*)\}\s*=\s*await\s+import\(\s*['"]([^'"]+)['"]\s*\)/gsu)) {
      if (!inPackage(match[2])) continue
      for (const name of match[1].split(',').map((item) => item.trim().split(':').pop().split(/\s+as\s+/u)[0].trim()).filter(Boolean)) imported.add(name)
    }
    for (const match of text.matchAll(/await\s+import\(\s*['"]([^'"]+)['"]\s*\)\s*\.\s*([A-Za-z0-9_$]+)/gu)) {
      if (inPackage(match[1])) imported.add(match[2])
    }
    for (const binding of dynamicBindings) memberAccesses(binding)
  }
  return imported
}

/**
 * Read one package's index surface from disk.
 * @returns {{ indexText: string, modules: { package: string, file: string, names: string[], missing?: true }[] }}
 */
export function readModules(pkg, repoRoot = REPO_ROOT) {
  const indexText = readFileSync(pkg.index, 'utf8')
  const modules = []
  const indexRel = relative(repoRoot, pkg.index).split(sep).join('/')
  for (const name of extractRuntimeExports(indexText)) modules.push({ package: pkg.name, file: indexRel, names: [name] })
  for (const entry of parseIndexModules(indexText)) {
    const module = typeof entry === 'string' ? entry : entry.module
    const file = join(pkg.dir, 'src', module.replace(/^\.\//u, ''))
    const relFile = relative(repoRoot, file).split(sep).join('/')
    if (!existsSync(file)) {
      modules.push({ package: pkg.name, file: relFile, names: [], missing: true })
      continue
    }
    const names = typeof entry === 'string'
      ? extractRuntimeExports(readFileSync(file, 'utf8'))
      : entry.names
    modules.push({ package: pkg.name, file: relFile, names })
  }
  return { indexText, modules }
}

/**
 * Pure verdict: which declared runtime exports no importer names.
 * @returns {{ dead: { name: string, file: string, package?: string }[], checked: number }}
 */
export function deadExports(modules, imported, exemptions = DEAD_EXPORT_EXEMPTIONS) {
  const exempted = new Set()
  for (const entry of exemptions) {
    exempted.add(entry.package === undefined ? '\u0000' + entry.name : entry.package + '\u0000' + entry.name)
  }
  const dead = []
  let checked = 0
  for (const module of modules) {
    for (const name of module.names) {
      checked += 1
      if (imported.has(name)) continue
      if (exempted.has('\u0000' + name) || exempted.has((module.package ?? '') + '\u0000' + name)) continue
      const entry = { name, file: module.file }
      if (module.package !== undefined) entry.package = module.package
      dead.push(entry)
    }
  }
  return { dead, checked }
}

/** Exemptions that no longer name a dead export (stale = the list would lie). */
export function staleExemptions(modules, imported, exemptions = DEAD_EXPORT_EXEMPTIONS) {
  const dead = new Set(deadExports(modules, imported, []).dead.map((entry) => (entry.package ?? '') + '\u0000' + entry.name))
  return exemptions.filter((entry) => !dead.has((entry.package ?? '') + '\u0000' + entry.name))
}

function selfTest() {
  const modules = [
    { file: 'src/a.ts', names: ['used', 'orphan'] },
    { file: 'src/b.ts', names: ['alsoUsed'] },
  ]
  const verdict = deadExports(modules, new Set(['used', 'alsoUsed']))
  const detected = verdict.dead.length === 1 && verdict.dead[0].name === 'orphan' && verdict.checked === 3
  const exempted = deadExports(modules, new Set(['used', 'alsoUsed']), [{ name: 'orphan', reason: 'scheduled' }])
  const exemptionWorks = exempted.dead.length === 0
  const stale = staleExemptions(modules, new Set(['used', 'alsoUsed', 'orphan']), [{ name: 'orphan', reason: 'scheduled' }])
  const staleDetected = stale.length === 1
  const parsed = parseIndexModules(
    '// comment with { braces } must not parse as an export\n' +
    "export * from './a.ts'\n" +
    'export {\n' +
    '  // another { comment\n' +
    '  used,\n' +
    '  type Face,\n' +
    "} from './b.ts'\n",
  )
  const commentsIgnored = parsed.length === 2
    && parsed[1].names.length === 2
    && parsed[1].names[0] === 'used'
    && parsed[1].names[1] === 'Face'
  if (detected && exemptionWorks && staleDetected && commentsIgnored) {
    console.log('no-dead-exports self-test: ok (an orphan is reported, an exemption silences it, a stale exemption is flagged, comments are not code)')
    return
  }
  console.error(
    'no-dead-exports self-test: FAIL (detected=' + String(detected) +
    ', exemptionWorks=' + String(exemptionWorks) + ', staleDetected=' + String(staleDetected) +
    ', commentsIgnored=' + String(commentsIgnored) + ')',
  )
  process.exit(1)
}

function main() {
  if (process.argv.includes('--self-test')) {
    selfTest()
    return
  }
  const packages = discoverPackages()
  if (packages.length < 10) {
    console.error('no-dead-exports: workspace discovery found only ' + String(packages.length) + ' package(s) with src/index.ts - refusing to read a discovery failure as a clean surface')
    process.exit(1)
  }
  const failures = []
  const perPackage = []
  let totalChecked = 0
  let totalDead = 0
  for (const pkg of packages) {
    const { modules } = readModules(pkg)
    const declared = modules.reduce((sum, module) => sum + module.names.length, 0)
    const indexHasExports = /(?:^|\n)\s*export\s/u.test(stripComments(readFileSync(pkg.index, 'utf8')))
    if (indexHasExports && modules.length === 0) {
      failures.push(pkg.name + ': index declares exports but the parser read none - refusing to read a parse failure as a clean surface')
      continue
    }
    const missing = modules.filter((module) => module.missing === true)
    if (missing.length > 0) {
      failures.push(pkg.name + ': index re-exports a missing module: ' + missing.map((module) => module.file).join(', '))
      continue
    }
    const imported = collectPackageConsumers(pkg)
    const exemptions = DEAD_EXPORT_EXEMPTIONS.filter((entry) => entry.package === pkg.name)
    const { dead, checked } = deadExports(modules, imported, exemptions)
    const stale = staleExemptions(modules, imported, exemptions)
    totalChecked += checked
    totalDead += dead.length
    perPackage.push({ pkg, declared, dead, stale })
  }
  if (totalChecked < 100) {
    failures.push('the workspace parsed only ' + String(totalChecked) + ' runtime export(s) - below the sanity floor (100); refusing to read a parse failure as a clean surface')
  }
  for (const entry of perPackage) {
    if (entry.stale.length > 0) {
      failures.push(entry.pkg.name + ': ' + String(entry.stale.length) + ' stale exemption(s) - the export is imported or gone: '
        + entry.stale.map((item) => item.package + '#' + item.name).join(', '))
    }
  }
  if (failures.length > 0) {
    for (const message of failures) console.error('✗ no-dead-exports: ' + message)
    process.exit(1)
  }
  let runtimeLoaded = 0
  let pendingSuppressed = 0
  for (const entry of perPackage) {
    const runtimeReason = RUNTIME_LOADED_PACKAGES[entry.pkg.name]
    if (runtimeReason !== undefined) {
      runtimeLoaded += 1
      continue
    }
    const pending = PENDING_PACKAGES[entry.pkg.name]
    if (pending !== undefined) {
      if (entry.dead.length === 0) {
        console.error('✗ no-dead-exports: PENDING_PACKAGES entry ' + entry.pkg.name + ' (owner ' + pending.owner
          + ') no longer has any dead export - delete the entry (zombie: ' + pending.retiresWhen + ')')
        process.exit(1)
      }
      pendingSuppressed += entry.dead.length
      console.warn('⚠ no-dead-exports: ' + entry.pkg.name + ' pending barrel narrowing (owner ' + pending.owner + '): '
        + String(entry.dead.length) + ' dead export(s) suppressed - ' + entry.dead.map((item) => item.name).join(', '))
      continue
    }
    if (entry.dead.length > 0) {
      console.error('✗ no-dead-exports: ' + entry.pkg.name + ': ' + String(entry.dead.length) + ' of ' + String(entry.declared) + ' runtime export(s) have no production importer:')
      for (const item of entry.dead) console.error('  - ' + item.name + '  (' + item.file + ')')
      console.error('Delete the export (and its implementation if unused), narrow the re-export, or add a DEAD_EXPORT_EXEMPTIONS entry with the reason and the phase that lands its consumer.')
      process.exit(1)
    }
  }
  const suffix = [
    runtimeLoaded > 0 ? String(runtimeLoaded) + ' runtime-loaded package(s) not judged' : '',
    pendingSuppressed > 0 ? String(pendingSuppressed) + ' pending dead export(s) suppressed' : '',
  ].filter(Boolean).join('; ')
  console.log('ok no-dead-exports: all ' + String(totalChecked - pendingSuppressed) + ' judged runtime export(s) have a production importer across ' + String(packages.length) + ' package(s)'
    + (suffix === '' ? '' : '（' + suffix + '）'))
}

const isEntry = process.argv[1] !== undefined && process.argv[1].endsWith('verify-no-dead-exports.mjs')
if (isEntry) main()
