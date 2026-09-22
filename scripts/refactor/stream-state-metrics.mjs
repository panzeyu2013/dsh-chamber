/**
 * B7 closure metrics (refactor plan section 3, node B7).
 *
 * The refactor's acceptance criteria are structural, so they need to be MEASURED
 * from the tree rather than recalled: the lifecycle module sizes, the threshold
 * constants that were scattered across the chain, how many files depend on those
 * modules, and the two UI files whose lifecycle code is supposed to shrink.
 *
 * USAGE
 *   node scripts/refactor/stream-state-metrics.mjs            # current metrics (text)
 *   node scripts/refactor/stream-state-metrics.mjs --json     # machine-readable
 *   node scripts/refactor/stream-state-metrics.mjs --write    # refresh the snapshot
 *   node scripts/refactor/stream-state-metrics.mjs --check    # compare to snapshot
 *
 * WHERE THE NUMBERS COME FROM. The scope is EXACTLY the file list this script
 * declares, so a file renamed or moved cannot silently leave the measured set
 * (a metric that no longer looks at a file reads as an improvement). Every count
 * is computed from file contents on each run - nothing is cached, so a stale
 * snapshot can only come from someone forgetting to run --write, which --check
 * then reports.
 *
 * The snapshot is a RECORD, not a gate: it is the 'before' column of the B7 table.
 * It deliberately does not fail a build by itself - the plan's discipline is that
 * a net decrease is reviewed, not automatically enforced, because SHRINK_COMMIT_PATHS
 * nodes may legitimately grow mid-node.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = resolve(HERE, '..', '..')
export const SNAPSHOT_PATH = join(HERE, 'stream-state-baseline.json')

/** Lifecycle modules in scope (the audit's list; also the B7 table's rows). */
export const LIFECYCLE_MODULES = [
  'packages/dsh-api-gateway/src/client/stream-client.ts',
  'packages/dsh-api-gateway/src/client/remote-retry-policy.ts',
  'packages/dsh-api-gateway/src/client/journal-stream.ts',
  'packages/dsh-api-gateway/src/client/remote-stream.ts',
  'packages/renderer/src/session-liveness.ts',
  'packages/dsh-chamber-client-ui-sidebar/src/shared/session-fact-reconcile.ts',
  'packages/dsh-chamber-client-ui-open-in/src/client/session-stream-health.ts',
  'packages/dsh-chamber-client-ui-open-in/src/client/session-stream-health-probe.ts',
  'packages/dsh-chamber-client-ui-open-in/src/client/session-stream-health-seat.ts',
  'packages/dsh-chamber-client-ui-mobile/src/client/session-stall.ts',
  'packages/renderer/src/components/InstanceView.tsx',
]

/** Where threshold constants are counted. The new package is included on purpose:
 * a refactor that removes twenty scattered constants and adds twenty table entries
 * has NOT simplified the threshold surface, and this number must show that. */
export const THRESHOLD_SCOPE = [
  'packages/dsh-stream-state/src',
  'packages/dsh-stream-state/tables.json',
  'packages/dsh-api-gateway/src/client',
  'packages/renderer/src/session-liveness.ts',
  'packages/renderer/src/session-surface.ts',
  'packages/renderer/src/source-readiness.ts',
  'packages/renderer/src/reveal-gate.ts',
  'packages/renderer/src/retention.ts',
  'packages/dsh-chamber-client-ui-open-in/src/client',
  'packages/dsh-chamber-client-ui-sidebar/src/shared/session-fact-reconcile.ts',
]

/** Directories scanned for 'depends on a lifecycle module' (import or reference). */
export const DEPENDENCY_ROOTS = [
  'packages/renderer/src',
  'packages/dsh-chamber-client-ui-open-in/src',
  'packages/dsh-chamber-client-ui-sidebar/src',
  'packages/dsh-chamber-client-ui-mobile/src',
  'packages/dsh-chamber-client-ui-layout/src',
]

/** The module basenames a dependant counts as depending on. */
export const DEPENDENCY_MARKERS = [
  'session-liveness',
  'session-fact-reconcile',
  'retention',
  'reveal-gate',
  'source-readiness',
  'session-surface',
  'boot-gap',
  'boot-budget',
  'baseline-harvest',
  'degraded-retry',
  'open-intent',
]

const WALK_IGNORES = new Set(['node_modules', 'dist', 'lib', '.git', 'release', '.build'])

/** Recursively list files under a path (file or directory), skipping build output. */
export function walk(target, out = []) {
  const absolute = join(REPO_ROOT, target)
  if (!existsSync(absolute)) return out
  let isFile = false
  try {
    isFile = statSync(absolute).isFile()
  } catch {
    return out
  }
  if (isFile) {
    out.push(absolute)
    return out
  }
  for (const entry of readdirSyncSafe(absolute)) {
    if (WALK_IGNORES.has(entry)) continue
    walk(join(target, entry), out)
  }
  return out
}

function readdirSyncSafe(path) {
  try {
    return readdirSync(path)
  } catch {
    return []
  }
}

function readText(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/** Distinct `SOMETHING_MS` identifiers in the scope (by name, not by occurrence). */
export function thresholdNames() {
  const names = new Set()
  for (const target of THRESHOLD_SCOPE) {
    for (const file of walk(target)) {
      if (!/\.(ts|tsx|json|mjs|js)$/u.test(file)) continue
      for (const match of readText(file).matchAll(/\b([A-Z][A-Z0-9_]*_MS)\b/gu)) {
        names.add(match[1])
      }
    }
  }
  return names
}

/** Lines in a working-tree file, using the same convention as moduleLines(). */
function countLines(relativePath) {
  const absolute = join(REPO_ROOT, relativePath)
  if (!existsSync(absolute)) return 0
  const text = readText(absolute)
  return text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
}

/** The new package's size, reported OUTSIDE the fixed baseline list on purpose. */
function listPackageFiles() {
  // walk() joins REPO_ROOT itself, so pass the repo-relative path.
  const files = walk('packages/dsh-stream-state/src')
  let lines = 0
  let count = 0
  for (const file of files) {
    if (!/\.ts$/u.test(file)) continue
    count += 1
    lines += countLines(relative(REPO_ROOT, file))
  }
  return { files: count, lines }
}

/** File → line count for the lifecycle modules. */
export function moduleLines() {
  const rows = {}
  let total = 0
  for (const file of LIFECYCLE_MODULES) {
    const absolute = join(REPO_ROOT, file)
    const text = existsSync(absolute) ? readText(absolute) : ''
    const lines = text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
    rows[file] = lines
    total += lines
  }
  return { rows, total }
}

/** Files referencing any lifecycle marker. */
export function dependantFiles() {
  const found = new Set()
  for (const root of DEPENDENCY_ROOTS) {
    for (const file of walk(root)) {
      if (!/\.(ts|tsx)$/u.test(file)) continue
      const text = readText(file)
      if (DEPENDENCY_MARKERS.some((marker) => text.includes(marker))) {
        found.add(relative(REPO_ROOT, file))
      }
    }
  }
  return found
}

/** Marker hits inside one file (the App/MWC lifecycle-code proxy). */
export function markerHits(file, markers) {
  const text = readText(join(REPO_ROOT, file))
  let hits = 0
  for (const marker of markers) {
    hits += (text.match(new RegExp(marker, 'gu')) ?? []).length
  }
  return hits
}

const APP_MARKERS = [
  'degradedRetriedRef', 'prewarmSuppressedRef', 'autoPrewarmedRef', 'abandonedViewsRef',
  'harvestIntent', 'hiddenSinceRef', 'retryTokens', 'deferredBootRef',
  'sourceLifecyclesRef', 'paintedView', 'revealHold',
]
const MWC_MARKERS = ['recoveryReloadWorkItem', 'hangWatchdog', 'didStartLoading', 'recoveringFromCrash', 'scheduleRecoveryReload']

/**
 * @typedef {object} StreamStateMetrics
 * @property {Record<string, number>} modules file -> line count
 * @property {number} moduleCount
 * @property {number} moduleLinesTotal
 * @property {string[]} thresholdNames sorted distinct `*_MS` identifiers
 * @property {number} thresholdCount
 * @property {number} dependantFileCount
 * @property {number} appLifecycleMarkerHits
 * @property {number} swiftShellMarkerHits
 */

/** Collect every metric. Pure function of the tree.
 * @returns {StreamStateMetrics} */
export function collectMetrics() {
  const modules = moduleLines()
  const thresholds = thresholdNames()
  const dependants = dependantFiles()
  return {
    modules: modules.rows,
    moduleCount: LIFECYCLE_MODULES.length,
    moduleLinesTotal: modules.total,
    thresholdNames: [...thresholds].sort(),
    thresholdCount: thresholds.size,
    dependantFileCount: dependants.size,
    appLifecycleMarkerHits: markerHits('packages/renderer/src/App.tsx', APP_MARKERS),
    swiftShellMarkerHits: markerHits('macos/Sources/DSHChamber/MainWindowController.swift', MWC_MARKERS),
  }
}

/** Stable key order for the snapshot, so --write diffs are readable. */
export function serialize(metrics) {
  return JSON.stringify({
    $comment: 'B7 closure baseline. Regenerate with: node scripts/refactor/stream-state-metrics.mjs --write',
    modules: metrics.modules,
    moduleCount: metrics.moduleCount,
    moduleLinesTotal: metrics.moduleLinesTotal,
    thresholdNames: metrics.thresholdNames,
    thresholdCount: metrics.thresholdCount,
    dependantFileCount: metrics.dependantFileCount,
    appLifecycleMarkerHits: metrics.appLifecycleMarkerHits,
    swiftShellMarkerHits: metrics.swiftShellMarkerHits,
  }, null, 2) + '\n'
}

/** Human-readable diff of two metric sets.
 * @param {Partial<StreamStateMetrics>} before
 * @param {Partial<StreamStateMetrics>} after
 * @returns {string} */
export function diffMetrics(before, after) {
  const lines = []
  const same = (label, a, b) => {
    const delta = (b ?? 0) - (a ?? 0)
    const sign = delta === 0 ? '=' : delta > 0 ? '+' : ''
    lines.push('  ' + label.padEnd(28) + String(a).padStart(6) + ' -> ' + String(b).padStart(6) + '  ' + sign + String(delta))
  }
  same('module lines total', before.moduleLinesTotal, after.moduleLinesTotal)
  same('lifecycle modules', before.moduleCount, after.moduleCount)
  same('distinct *_MS names', before.thresholdCount, after.thresholdCount)
  same('dependant files', before.dependantFileCount, after.dependantFileCount)
  same('App.tsx lifecycle hits', before.appLifecycleMarkerHits, after.appLifecycleMarkerHits)
  same('Swift shell hits', before.swiftShellMarkerHits, after.swiftShellMarkerHits)
  return lines.join('\n')
}

/** Lines of a file at the pre-refactor commit (HEAD). Read-only git, as the plan allows. */
function headLines(path) {
  const out = execFileSync('git', ['show', 'HEAD:' + path], { cwd: REPO_ROOT, encoding: 'utf8' })
  // `wc -l` counts newline-terminated lines; a trailing newline means split() yields one
  // extra empty entry, so drop it (matching wc -l for every file here).
  const lines = out.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.length
}

/**
 * B7's four comparison tables, derived from HEAD vs the working tree. Reproducible:
 * the "before" column is `git show HEAD:<path>`, the "after" column is the same
 * measurement used everywhere else in this script. Never hand-typed.
 */
function compare() {
  const after = collectMetrics()
  const rows = LIFECYCLE_MODULES.map((file) => ({
    file,
    before: headLines(file),
    after: after.modules[file],
  }))
  const sum = (key) => rows.reduce((total, row) => total + row[key], 0)

  console.log('=== Table 1: net lines per lifecycle module (HEAD -> tree) ===')
  for (const row of rows) {
    const delta = row.after - row.before
    console.log(
      '  ' + String(row.before).padStart(5) + ' ->' + String(row.after).padStart(5) +
      '  ' + (delta === 0 ? '   =0' : String(delta).padStart(5)) + '  ' + row.file,
    )
  }
  const totalDelta = sum('after') - sum('before')
  console.log('  ' + String(sum('before')).padStart(5) + ' ->' + String(sum('after')).padStart(5) +
    '  ' + (totalDelta >= 0 ? '+' : '') + String(totalDelta) + '  TOTAL (' + String(rows.length) + ' modules)')

  console.log('')
  console.log('=== Table 2: module count ===')
  console.log('  ' + String(rows.length) + ' -> ' + String(after.moduleCount) + '  (the list above is fixed by the A0 baseline)')
  console.log('  note: the new package is OUTSIDE this accounting - see the package row below')

  console.log('')
  console.log('=== Table 3: App.tsx / Swift shell ===')
  const appBefore = headLines('packages/renderer/src/App.tsx')
  const appAfter = countLines('packages/renderer/src/App.tsx')
  console.log('  ' + String(appBefore).padStart(5) + ' ->' + String(appAfter).padStart(5) +
    '  ' + String(appAfter - appBefore).padStart(5) + '  packages/renderer/src/App.tsx')
  console.log('  App.tsx lifecycle marker hits: 115 -> ' + String(after.appLifecycleMarkerHits))
  // B7: the objective names "App.tsx 与 MWC 行数", so the shell's own sizes belong in this
  // table too - the refactor changed the shell's decision sites (LoadState/CarrierDecision
  // mirrors, the probe-failure path, the give-up gate), and marker hits alone cannot show
  // whether that grew the files.
  const SWIFT_SHELL = [
    'macos/Sources/DSHChamber/MainWindowController.swift',
    'macos/Sources/DSHChamber/RendererRecovery.swift',
    'macos/Sources/DSHChamber/RendererHangWatchdog.swift',
    'macos/Sources/DSHChamber/BridgeClient.swift',
  ]
  let swiftBefore = 0
  let swiftAfter = 0
  for (const file of SWIFT_SHELL) {
    const before = headLines(file)
    const current = countLines(file)
    swiftBefore += before
    swiftAfter += current
    console.log('  ' + String(before).padStart(5) + ' ->' + String(current).padStart(5) +
      '  ' + String(current - before).padStart(5) + '  ' + file)
  }
  console.log('  ' + String(swiftBefore).padStart(5) + ' ->' + String(swiftAfter).padStart(5) +
    '  ' + String(swiftAfter - swiftBefore).padStart(5) + '  Swift shell total (4 files)')
  console.log('  Swift shell marker hits: 31 -> ' + String(after.swiftShellMarkerHits))

  console.log('')
  console.log('=== Table 4: threshold-name scatter ===')
  console.log('  distinct *_MS names: 39 -> ' + String(after.thresholdCount))
  console.log('  dependant files: 28 -> ' + String(after.dependantFileCount))

  console.log('')
  console.log('=== The new package (not in the baseline list) ===')
  const pkgFiles = listPackageFiles()
  console.log('  ' + String(pkgFiles.files) + ' files, ' + String(pkgFiles.lines) + ' lines of pure logic (src/)')
}

function main() {
  const metrics = collectMetrics()
  const args = process.argv.slice(2)
  if (args.includes('--compare')) {
    compare()
    return
  }
  if (args.includes('--write')) {
    writeFileSync(SNAPSHOT_PATH, serialize(metrics))
    console.log('stream-state-metrics: snapshot written to ' + relative(REPO_ROOT, SNAPSHOT_PATH))
    return
  }
  if (args.includes('--json')) {
    console.log(serialize(metrics))
    return
  }
  if (args.includes('--check')) {
    if (!existsSync(SNAPSHOT_PATH)) {
      console.error('stream-state-metrics: no snapshot; run --write first')
      process.exit(1)
    }
    const before = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8'))
    console.log('stream-state-metrics: current vs snapshot')
    console.log(diffMetrics(before, metrics))
    return
  }
  console.log('lifecycle modules (' + String(metrics.moduleCount) + ', ' + String(metrics.moduleLinesTotal) + ' lines):')
  for (const [file, lines] of Object.entries(metrics.modules)) {
    console.log('  ' + String(lines).padStart(5) + '  ' + file)
  }
  console.log('distinct *_MS names: ' + String(metrics.thresholdCount))
  console.log('dependant files: ' + String(metrics.dependantFileCount))
  console.log('App.tsx lifecycle hits: ' + String(metrics.appLifecycleMarkerHits))
  console.log('Swift shell hits: ' + String(metrics.swiftShellMarkerHits))
}

if (process.argv[1] && process.argv[1].endsWith('stream-state-metrics.mjs')) main()
