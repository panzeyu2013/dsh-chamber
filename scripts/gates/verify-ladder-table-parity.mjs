/**
 * Ladder-table parity gate.
 *
 * The target is "four ladders -> one reducer + ONE TABLE". The gate covers both
 * halves:
 *
 *  1. LOCKSTEP - the values are recorded in `packages/dsh-stream-state/tables.json`,
 *     and every module that still OWNS a copy (until the table is imported) is
 *     checked against that table here. A module that no longer declares a constant
 *     is NOT a failure (that is the retirement working); a constant that EXISTS with
 *     a different value IS a failure. Once every copy is retired this list is green
 *     by construction, so it is a retirement ledger, not proof of collection.
 *  2. CONSUMERS - the ladder modules read the table. Each named consumer must
 *     reference `LADDER_TABLES.<ladder>` in code, must not re-declare a retired
 *     constant, and must not assign a ladder leaf a numeric literal; the ladder must
 *     be present in tables.json. Without this half "the table is the single driver"
 *     would be a comment: a green "0 locked + N retired" line with a ladder never
 *     collected at all.
 *
 * WHY A GATE AND NOT A UNIT TEST: the modules live in four different packages, and the
 * dependency direction is "modules import the package", so a package test cannot read
 * them. This script reads their source declarations (the values are literal constants)
 * and compares. Plain constants are read by name; the config-object defaults are read
 * by field inside the exported object literal.
 *
 * A module that no longer declares a constant is NOT a failure: that is the
 * retirement working. A constant that EXISTS with a different value IS a failure.
 *
 * NEGATIVE CONTROL: `--self-test` runs the same comparison against a synthetic entry
 * whose table expectation is deliberately wrong and asserts that it is reported; a
 * gate that cannot fail is not a gate.
 *
 * Usage: node scripts/gates/verify-ladder-table-parity.mjs [--self-test]
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
// Comment-proof source locks (the same helper every source-lock test uses): a
// comment that NAMES the table must not satisfy the consumer check - only code
// can. The helper is a pure TS module; node >= 24 strips its types natively.
import { stripComments } from '../dev/test-support/source-text.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..')
const TABLES = join(REPO_ROOT, 'packages', 'dsh-stream-state', 'tables.json')

/**
 * Each entry: the table path, and the declaration it must match while the module
 * still owns it. `source` is repo-relative; `name` is the exported/local const, or
 * the field name when `object` names the exported config object holding it.
 */
export const LOCKSTEP = [
  {
    table: 'tables.ladders.mobile.thresholdMs',
    source: 'packages/dsh-chamber-client-ui-mobile/src/client/session-stall.ts',
    name: 'STALL_THRESHOLD_MS',
  },
  {
    table: 'tables.ladders.mobile.pollMs',
    source: 'packages/dsh-chamber-client-ui-mobile/src/client/session-stall.ts',
    name: 'STALL_POLL_MS',
  },
  {
    table: 'tables.ladders.mobile.resyncCooldownMs',
    source: 'packages/dsh-chamber-client-ui-mobile/src/client/session-stall.ts',
    name: 'STALL_RESYNC_COOLDOWN_MS',
  },
  {
    table: 'tables.ladders.mobile.resyncWindowMs',
    source: 'packages/dsh-chamber-client-ui-mobile/src/client/session-stall.ts',
    name: 'STALL_RESYNC_WINDOW_MS',
  },
  {
    table: 'tables.ladders.mobile.resyncMax',
    source: 'packages/dsh-chamber-client-ui-mobile/src/client/session-stall.ts',
    name: 'STALL_RESYNC_MAX',
  },
  {
    table: 'tables.ladders.mobile.failedMs',
    source: 'packages/dsh-chamber-client-ui-mobile/src/client/session-stall.ts',
    name: 'STALL_FAILED_MS',
  },
  // The last surviving copies are retired: the authority probe ladder reads
  // LADDER_TABLES.authority directly, mobile reads LADDER_TABLES.mobile, and open-in
  // reads LADDER_TABLES.streamHealth. The list stays as the guard for any future
  // module that declares a local copy again (a found constant with a different value
  // is a failure; a missing one is the retirement working).
]

/**
 * The collection half: the ladder modules read the table.
 * Each entry names:
 *  - `table`: the ladder path that must exist in tables.json;
 *  - `source`: the module that must reference the table;
 *  - `reference`: the exact `LADDER_TABLES.<ladder>` expression that makes the
 *    import the driver, matched against comment-stripped source (a comment
 *    claiming it does not count);
 *  - `retiredNames`: constants the module used to own; a new declaration of one
 *    (const/let/var) is a regression, a prose mention is not;
 *  - the leaves of the ladder object are additionally checked as "must not be
 *    assigned a numeric literal" (`leaf: 123`), which is the shape a re-declared
 *    copy takes.
 */
export const CONSUMERS = [
  {
    table: 'tables.ladders.mobile',
    source: 'packages/dsh-chamber-client-ui-mobile/src/client/session-stall.ts',
    reference: 'LADDER_TABLES.mobile',
    retiredNames: [
      'STALL_THRESHOLD_MS',
      'STALL_POLL_MS',
      'STALL_RESYNC_COOLDOWN_MS',
      'STALL_RESYNC_WINDOW_MS',
      'STALL_RESYNC_MAX',
      'STALL_FAILED_MS',
    ],
  },
  {
    // The sidebar executor's probe cadence; the authority ladder replaced the
    // 190 s fact-reconcile receipt chain (the retired names below).
    table: 'tables.ladders.authority',
    source: 'packages/dsh-chamber-client-ui-sidebar/src/shared/session-fact-reconcile.ts',
    reference: 'LADDER_TABLES.authority',
    retiredNames: [
      'DEFAULT_MAX_ATTEMPTS',
      'DEFAULT_RETRY_MS',
      'DEFAULT_ATTEMPT_TIMEOUT_MS',
      'DEFAULT_VERIFY_TIMEOUT_MS',
      'CORRECTIVE_PHASE_TIMEOUT_MS',
    ],
  },
  {
    // The App's reconnect/notice escalation, the renderer host of the same
    // authority ladder (the retired renderer-local liveness defaults below).
    table: 'tables.ladders.authority',
    source: 'packages/renderer/src/App.tsx',
    reference: 'LADDER_TABLES.authority',
    retiredNames: ['SESSION_LIVENESS_DEFAULTS'],
  },
  {
    table: 'tables.ladders.streamHealth',
    source: 'packages/dsh-chamber-client-ui-open-in/src/client/session-stream-health.ts',
    reference: 'LADDER_TABLES.streamHealth',
    retiredNames: [],
  },
]

/** Read a dotted table path, array indices included. */
export function readTable(path) {
  let node = JSON.parse(readFileSync(TABLES, 'utf8'))
  for (const key of path.split('.')) {
    if (node === undefined || node === null || !(key in node)) return undefined
    node = node[key]
  }
  return node
}

/** Read a plain `const NAME = <numeric literal>`, tolerating underscores. */
export function readConstant(source, name, repoRoot = REPO_ROOT) {
  const absolute = join(repoRoot, source)
  if (!existsSync(absolute)) return { state: 'missing-file' }
  const text = readFileSync(absolute, 'utf8')
  const pattern = new RegExp('^\\s*(?:export\\s+)?const\\s+' + name + '\\s*=\\s*([0-9_]+)', 'mu')
  const match = pattern.exec(text)
  if (match === null) return { state: 'retired' }
  return { state: 'found', value: Number(match[1].replace(/_/gu, '')) }
}

/** Read `field: <numeric literal>` inside an exported config object literal. */
export function readObjectField(source, objectName, fieldName, repoRoot = REPO_ROOT) {
  const absolute = join(repoRoot, source)
  if (!existsSync(absolute)) return { state: 'missing-file' }
  const text = readFileSync(absolute, 'utf8')
  const startMatch = new RegExp('^\\s*(?:export\\s+)?const\\s+' + objectName + '\\b[\\s\\S]*?=\\s*\\{', 'mu').exec(text)
  if (startMatch === null) return { state: 'retired' }
  const end = text.indexOf('\n}', startMatch.index)
  const block = text.slice(startMatch.index, end === -1 ? text.length : end)
  const pattern = new RegExp('^\\s*' + fieldName + '\\s*:\\s*([0-9_]+)', 'mu')
  const match = pattern.exec(block)
  if (match === null) return { state: 'retired' }
  return { state: 'found', value: Number(match[1].replace(/_/gu, '')) }
}

/** Read one consumer module's source text, or null when the file is absent. */
export function readSourceText(source, repoRoot = REPO_ROOT) {
  const absolute = join(repoRoot, source)
  if (!existsSync(absolute)) return null
  return readFileSync(absolute, 'utf8')
}

/**
 * Compare one lockstep list. Pure: all I/O arrives through `resolve` so the
 * self-test can drive a fabricated expectation without touching the tree.
 * @returns {{ failures: number, checked: number, retired: number, lines: string[] }} verdict.
 */
export function compareLockstep(entries, resolve) {
  let failures = 0
  let checked = 0
  let retired = 0
  const lines = []
  for (const entry of entries) {
    const expected = resolve.table(entry.table)
    if (expected === undefined) {
      failures += 1
      lines.push('x tables.json is missing ' + entry.table + ' (the single table must name it)')
      continue
    }
    const actual = entry.object === undefined
      ? resolve.constant(entry.source, entry.name)
      : resolve.objectField(entry.source, entry.object, entry.name)
    if (actual.state === 'missing-file') {
      failures += 1
      lines.push('x ' + entry.source + ': file does not exist (declared in the lockstep list)')
      continue
    }
    if (actual.state === 'retired') {
      // The module stopped owning it: retirement. Informational, never a failure.
      retired += 1
      continue
    }
    checked += 1
    if (actual.value !== expected) {
      failures += 1
      lines.push(
        'x ' + entry.name + ' (' + entry.source + ') = ' + String(actual.value) +
        ' but tables.json ' + entry.table + ' = ' + String(expected),
      )
    }
  }
  return { failures, checked, retired, lines }
}

/**
 * Compare one consumer list: each entry's module must read its ladder from the
 * table in code (a comment naming it does not count), must not re-declare a
 * retired constant, and must not assign a ladder leaf a numeric literal.
 * Pure: all I/O arrives through `resolve`, so a fabricated expectation can be
 * driven without touching the tree.
 * @returns {{ failures: number, checked: number, lines: string[] }} verdict.
 */
export function compareConsumers(entries, resolve) {
  let failures = 0
  let checked = 0
  const lines = []
  for (const entry of entries) {
    const ladder = resolve.table(entry.table)
    if (ladder === undefined || ladder === null || typeof ladder !== 'object') {
      failures += 1
      lines.push('x tables.json is missing ' + entry.table + ' (the single table must name it)')
      continue
    }
    const text = resolve.sourceText(entry.source)
    if (text === null) {
      failures += 1
      lines.push('x ' + entry.source + ': file does not exist (declared as a table consumer)')
      continue
    }
    // Only CODE counts: comments are blanked (newlines preserved) so prose that
    // names the table or a retired constant cannot satisfy or trip a check.
    const code = resolve.strip(text)
    let consumerOk = true
    if (!code.includes(entry.reference)) {
      failures += 1
      consumerOk = false
      lines.push(
        'x ' + entry.source + ' no longer reads ' + entry.reference +
        ' - the ladder is not driven by the single table',
      )
    }
    for (const name of entry.retiredNames ?? []) {
      // Declaration form only: prose that names a retired constant is not a copy.
      const declaration = new RegExp('(?:^|\\s)(?:export\\s+)?(?:const|let|var)\\s+' + name + '\\s*=')
      if (declaration.test(code)) {
        failures += 1
        consumerOk = false
        lines.push('x ' + entry.source + ' declares retired ladder constant ' + name + ' again - the table is the only owner')
      }
    }
    for (const leaf of Object.keys(ladder)) {
      const literal = new RegExp('(?:^|[^A-Za-z0-9_$])' + leaf + '\\s*:\\s*[0-9]')
      if (literal.test(code)) {
        failures += 1
        consumerOk = false
        lines.push('x ' + entry.source + ' assigns ' + leaf + ' a literal again - read ' + entry.reference + ' instead')
      }
    }
    if (consumerOk) checked += 1
  }
  return { failures, checked, lines }
}

/** Negative control: the comparison must flag a deliberately wrong expectation. */
function selfTest() {
  const resolve = {
    table: (path) => (path === 'tables.handshakeTimeoutMs' ? 1 : readTable(path)),
    constant: (source, name) => readConstant(source, name),
    objectField: (source, object, name) => readObjectField(source, object, name),
  }
  const wrong = [{
    table: 'tables.handshakeTimeoutMs',
    source: 'packages/dsh-stream-state/src/tables.ts',
    name: 'HANDSHAKE_TIMEOUT_MS',
  }]
  const verdict = compareLockstep(wrong, resolve)
  const detected = verdict.failures === 1 && verdict.lines.length === 1
  const retiredVerdict = compareLockstep(
    [{ table: 'tables.silentTeardownMinMs', source: 'packages/dsh-stream-state/src/tables.ts', name: 'DEFINITELY_NOT_A_CONSTANT' }],
    { table: () => 1, constant: readConstant, objectField: readObjectField },
  )
  const retirementQuiet = retiredVerdict.failures === 0 && retiredVerdict.retired === 1
  if (detected && retirementQuiet) {
    console.log('ladder-table parity self-test: ok (a wrong expectation is flagged, a retired constant is quiet)')
    return
  }
  console.error('ladder-table parity self-test: FAIL (detected=' + String(detected) + ', retirementQuiet=' + String(retirementQuiet) + ')')
  process.exit(1)
}

function main() {
  if (process.argv.includes('--self-test')) {
    selfTest()
    return
  }
  const lockstep = compareLockstep(LOCKSTEP, {
    table: readTable,
    constant: readConstant,
    objectField: readObjectField,
  })
  const consumers = compareConsumers(CONSUMERS, {
    table: readTable,
    sourceText: readSourceText,
    strip: stripComments,
  })
  for (const line of [...lockstep.lines, ...consumers.lines]) console.error(line)
  const failures = lockstep.failures + consumers.failures
  if (failures > 0) {
    console.error('')
    console.error('ladder-table parity: ' + String(failures) + ' mismatch(es). The single table is the authority;')
    console.error('either fix the table or the module - do not let the two drift while both exist.')
    process.exit(1)
  }
  console.log(
    'ok ladder-table parity: ' + String(lockstep.checked) + ' constant(s) locked to tables.json' +
    (lockstep.retired > 0 ? ', ' + String(lockstep.retired) + ' already retired' : '') +
    ', ' + String(consumers.checked) + '/' + String(CONSUMERS.length) + ' consumer(s) read the table',
  )
}

const isEntry = process.argv[1] !== undefined && process.argv[1].endsWith('verify-ladder-table-parity.mjs')
if (isEntry) main()
