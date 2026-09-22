/**
 * Dead-export gate (G-H) - the package's public surface must have production
 * consumers.
 *
 * WHY. `src/index.ts` re-exports every module wholesale ("nothing internal is hidden
 * by omission"), so the surface can grow without anyone importing the result. An
 * export nothing imports is a face with no consumer: it invites a second
 * implementation (the exact anti-pattern this refactor removes), it makes a future
 * rename look like API, and it hides which parts of the model are actually wired.
 *
 * WHAT IS CHECKED. Every runtime export reachable through `src/index.ts` must be
 * named by an import from a production importer - any file under `packages/` or
 * `scripts/` outside the package itself, excluding tests and build output. An export
 * with no importer is red unless it carries a documented exemption. The exemption
 * list is deliberate: a face whose consumer is scheduled (or a table projection the
 * Swift mirror reads) must say so, with the reason, instead of being silently kept.
 *
 * NEGATIVE CONTROL: `--self-test` drives the pure resolver with a fabricated module
 * list whose one export has no importer and asserts it is reported; a gate whose
 * comparison quietly matched nothing would read as a clean surface.
 *
 * Usage:
 *   node scripts/gates/verify-no-dead-exports.mjs            # gate
 *   node scripts/gates/verify-no-dead-exports.mjs --self-test
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { walkFiles } from '../lib/walk.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..')
const PACKAGE_DIR = join(REPO_ROOT, 'packages', 'dsh-stream-state')
const INDEX = join(PACKAGE_DIR, 'src', 'index.ts')
const PACKAGE_SPECIFIER = '@dsh-chamber/dsh-stream-state'

/**
 * Exports with no production importer, each with the reason a reviewer accepted.
 * Every entry must name a REAL dead export (a stale exemption fails), and the
 * reason must name where the consumer lands.
 * @type {readonly { name: string, reason: string }[]}
 */
export const DEAD_EXPORT_EXEMPTIONS = [
  // Table value surface: the constants are consumed through CARRIER_ENV /
  // TABLE_SNAPSHOT by the reducer, the api-gateway and the G-G parity gate. The
  // values are the table's public record, so there is no direct importer by design.
  { name: 'REBUILD_WINDOW_MS', reason: 'table value consumed via CARRIER_ENV + parity gate' },
  { name: 'MAX_REBUILDS_PER_WINDOW', reason: 'table value consumed via CARRIER_ENV + parity gate' },
  { name: 'MIN_REBUILD_SPACING_MS', reason: 'table value consumed via CARRIER_ENV + parity gate' },
  { name: 'IN_FLIGHT_GRACE_MS', reason: 'table value consumed via CARRIER_ENV + parity gate' },
  { name: 'OPENING_TIMEOUT_LADDER_MS', reason: 'table value consumed via openingBudgetMs + parity gate' },
  { name: 'OPENING_STALL_STREAK', reason: 'table value consumed via CARRIER_ENV + parity gate' },
  { name: 'TABLE_SNAPSHOT', reason: 'tables.json lockstep projection (tables test)' },
  // Cross-language reference implementations: mirrored field-for-field by the Swift
  // mirror and exercised by the G-B/G-F gates. Retirement: when the renderer
  // consumes the package for its load-state decisions, or the mirror is dropped
  // (engine model extension, design 14 section D4 item 5).
  { name: 'initialLoadState', reason: 'Swift-mirror reference implementation (G-F); retires with the engine extension' },
  { name: 'contentIsBelievable', reason: 'Swift-mirror reference implementation (G-F); retires with the engine extension' },
  { name: 'loadIsLate', reason: 'Swift-mirror reference implementation (G-F); retires with the engine extension' },
  { name: 'reduceLoadState', reason: 'Swift-mirror reference implementation (G-F); retires with the engine extension' },
  // Differential-harness surface: imported by test/equivalence and
  // scripts/refactor/equivalence.mjs, not by a production module.
  { name: 'reasonClassOf', reason: 'differential normalizer; consumed by the equivalence harness' },
  { name: 'normalizeEffect', reason: 'differential normalizer; consumed by the equivalence harness' },
  { name: 'equivalents', reason: 'differential comparison; consumed by the equivalence harness' },
  // Aggregate reducers re-exported for the differential replay and the Swift
  // mirror; production callers use reduceCarrier/reduceSource.
  { name: 'decideRebuild', reason: 'pure rebuild predicate; used by reduceCarrier and the vectors' },
  { name: 'initialSourceLifecycle', reason: 'source reducer face; used by container + vectors' },
  { name: 'reduceSource', reason: 'source reducer face; used by container + vectors' },
  { name: 'reduceSourceSequence', reason: 'source reducer replay face; used by the vectors' },
  { name: 'collapseRecords', reason: 'ladder internal; used by planLadder + its suite' },
  // Ladder shape references (design 14 section D4 item 5, plan section 84): the two
  // host ladders are NOT mechanically migratable until the engine gains a phase
  // machine. Retirement: the engine model extension lands and the hosts consume
  // these factories; until then they are the recorded shape of that target.
  { name: 'sessionLivenessLadder', reason: 'shape reference; retires when the engine phase machine lands (design 14 D4-5)' },
  { name: 'streamHealthLadder', reason: 'shape reference; retires when the engine phase machine lands (design 14 D4-5)' },
  // Presentation outer-bound helpers superseded by decidePresentation/planVeilTimer;
  // kept for the renderer suite's bound cases.
  { name: 'surfaceBoundMs', reason: 'outer-bound helper; retires when the renderer tests use the frame API only' },
  { name: 'veilUpperBoundMs', reason: 'outer-bound helper; retires when the renderer tests use the frame API only' },
]

/** Parse `export * from './x.ts'` (and named re-exports) out of the index. */
export function parseIndexModules(indexText) {
  const modules = []
  const star = /export\s+\*\s+from\s+['"](\.\/[^'"]+)['"]/gu
  for (const match of indexText.matchAll(star)) modules.push(match[1])
  const named = /export\s*\{([^}]*)\}\s*from\s*['"](\.\/[^'"]+)['"]/gu
  for (const match of indexText.matchAll(named)) {
    const names = match[1].split(',').map((name) => name.trim().replace(/^type\s+/u, '').split(/\s+as\s+/u)[0].trim()).filter(Boolean)
    modules.push({ module: match[2], names })
  }
  return modules
}

/** Runtime exports of one module source (types are erased and not importable values). */
export function extractRuntimeExports(sourceText) {
  const names = []
  const pattern = /^export\s+(?:async\s+)?(?:function|const|class)\s+([A-Za-z0-9_]+)/gmu
  for (const match of sourceText.matchAll(pattern)) {
    if (!names.includes(match[1])) names.push(match[1])
  }
  return names
}

/** Named imports of one module source: [{ source, names }]. */
export function collectImports(sourceText) {
  const imports = []
  const pattern = /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"]([^'"]+)['"]/gsu
  for (const match of sourceText.matchAll(pattern)) {
    const names = match[1]
      .split(',')
      .map((name) => name.trim().replace(/^type\s+/u, '').split(/\s+as\s+/u)[0].trim())
      .filter(Boolean)
    imports.push({ source: match[2], names })
  }
  return imports
}

/** Production importers: packages/ and scripts/, never the package's tests or output. */
export function collectProductionImports(repoRoot = REPO_ROOT) {
  const imported = new Set()
  const files = [
    ...walkFiles(join(repoRoot, 'packages'), () => true),
    ...walkFiles(join(repoRoot, 'scripts'), () => true),
  ]
  for (const absolute of files) {
    if (!/\.(?:ts|tsx|mts|mjs)$/u.test(absolute)) continue
    const rel = relative(repoRoot, absolute).split(sep).join('/')
    if (rel.startsWith('packages/dsh-stream-state/')) continue
    if (rel.includes('/test/') || rel.includes('/tests/')) continue
    if (rel.includes('/dist/') || rel.includes('/lib/')) continue
    let text
    try {
      text = readFileSync(absolute, 'utf8')
    } catch {
      continue
    }
    for (const entry of collectImports(text)) {
      // Production tooling (the differential replay, the metrics walker) imports the
      // package through relative subpaths; both spellings are the same consumer.
      const relativeFromFile = entry.source.startsWith('.')
        ? resolve(dirname(absolute), entry.source)
        : ''
      const isPackageImport = entry.source === PACKAGE_SPECIFIER
        || entry.source.startsWith(PACKAGE_SPECIFIER + '/')
        || (relativeFromFile !== '' && (relativeFromFile === PACKAGE_DIR || relativeFromFile.startsWith(PACKAGE_DIR + sep)))
      if (!isPackageImport) continue
      for (const name of entry.names) imported.add(name)
    }
  }
  return imported
}

/**
 * Pure verdict: which declared runtime exports no importer names.
 * @returns {{ dead: { name: string, file: string }[], checked: number }}
 */
export function deadExports(modules, imported, exemptions = DEAD_EXPORT_EXEMPTIONS) {
  const exempted = new Set(exemptions.map((entry) => entry.name))
  const dead = []
  let checked = 0
  for (const module of modules) {
    for (const name of module.names) {
      checked += 1
      if (imported.has(name)) continue
      if (exempted.has(name)) continue
      dead.push({ name, file: module.file })
    }
  }
  return { dead, checked }
}

/** Exemptions that no longer name a dead export (stale = the list would lie). */
export function staleExemptions(modules, imported, exemptions = DEAD_EXPORT_EXEMPTIONS) {
  const dead = new Set(deadExports(modules, imported, []).dead.map((entry) => entry.name))
  return exemptions.filter((entry) => !dead.has(entry.name))
}

/** Read the index's runtime export surface from disk. */
export function readModules(repoRoot = REPO_ROOT) {
  const indexText = readFileSync(join(repoRoot, 'packages', 'dsh-stream-state', 'src', 'index.ts'), 'utf8')
  const modules = []
  for (const entry of parseIndexModules(indexText)) {
    const module = typeof entry === 'string' ? entry : entry.module
    const file = join(packageDir(repoRoot), 'src', module.replace(/^\.\//u, ''))
    if (!existsSync(file)) {
      modules.push({ file: 'packages/dsh-stream-state/src/' + module, names: [], missing: true })
      continue
    }
    const names = typeof entry === 'string'
      ? extractRuntimeExports(readFileSync(file, 'utf8'))
      : entry.names
    modules.push({ file: 'packages/dsh-stream-state/src/' + module.replace(/^\.\//u, ''), names })
  }
  return { indexText, modules }
}

function packageDir(repoRoot) {
  return join(repoRoot, 'packages', 'dsh-stream-state')
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
  if (detected && exemptionWorks && staleDetected) {
    console.log('no-dead-exports self-test: ok (an orphan is reported, an exemption silences it, a stale exemption is flagged)')
    return
  }
  console.error(
    'no-dead-exports self-test: FAIL (detected=' + String(detected) +
    ', exemptionWorks=' + String(exemptionWorks) + ', staleDetected=' + String(staleDetected) + ')',
  )
  process.exit(1)
}

function main() {
  if (process.argv.includes('--self-test')) {
    selfTest()
    return
  }
  const { modules } = readModules()
  const declared = modules.reduce((sum, module) => sum + module.names.length, 0)
  if (modules.length < 10 || declared < 30) {
    console.error('no-dead-exports: the index parsed ' + String(modules.length) + ' module(s) and ' + String(declared) + ' export(s) - refusing to read a parse failure as a clean surface')
    process.exit(1)
  }
  const missing = modules.filter((module) => module.missing === true)
  if (missing.length > 0) {
    console.error('no-dead-exports: index re-exports a missing module: ' + missing.map((module) => module.file).join(', '))
    process.exit(1)
  }
  const imported = collectProductionImports()
  const { dead, checked } = deadExports(modules, imported)
  const stale = staleExemptions(modules, imported)
  if (stale.length > 0) {
    console.error('no-dead-exports: ' + String(stale.length) + ' stale exemption(s) - the export is imported or gone:')
    for (const entry of stale) console.error('  - ' + entry.name + ' (' + entry.reason + ')')
    process.exit(1)
  }
  if (dead.length > 0) {
    console.error('no-dead-exports: ' + String(dead.length) + ' of ' + String(checked) + ' runtime export(s) have no production importer:')
    for (const entry of dead) console.error('  - ' + entry.name + '  (' + entry.file + ')')
    console.error('Delete the export (and its implementation if unused) or add a DEAD_EXPORT_EXEMPTIONS entry with the reason and the phase that lands its consumer.')
    process.exit(1)
  }
  console.log('ok no-dead-exports: all ' + String(checked) + ' runtime export(s) have a production importer')
}

const isEntry = process.argv[1] !== undefined && process.argv[1].endsWith('verify-no-dead-exports.mjs')
if (isEntry) main()
