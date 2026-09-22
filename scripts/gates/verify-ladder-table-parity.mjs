/**
 * Ladder-table parity gate (B4 precondition).
 *
 * B4's acceptance is "four ladders -> one reducer + ONE TABLE". This gate covers
 * both halves:
 *
 *  1. LOCKSTEP - the values are recorded in `packages/dsh-stream-state/tables.json`,
 *     and every module that still OWNS a copy (until B4 retires it) is checked
 *     against that table here. A module that no longer declares a constant is NOT a
 *     failure (that is B4's retirement working); a constant that EXISTS with a
 *     different value IS a failure. Once every copy is retired this list is green by
 *     construction, so it is a retirement ledger, not proof of collection.
 *  2. CONSUMERS - the four ladder modules now READ the table. Each named consumer
 *     must reference `LADDER_TABLES.<ladder>`, must not re-declare a retired
 *     constant, and must not assign a ladder leaf a numeric literal; the ladder must
 *     be present in tables.json. Without this half "the table is the single driver"
 *     would be a comment: a green "0 locked + N retired" line with two ladders never
 *     collected at all.
 *
 * WHY A GATE AND NOT A UNIT TEST: the modules live in four different packages, and the
 * dependency direction is "modules import the package", so a package test cannot read
 * them. This script reads their source declarations (the values are literal constants)
 * and compares.
 *
 * Usage: node scripts/gates/verify-ladder-table-parity.mjs
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
 * still owns it. `source` is repo-relative; `name` is the exported/local const.
 */
const LOCKSTEP = [
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
  {
    table: 'tables.ladders.factReconcile.maxAttempts',
    source: 'packages/dsh-chamber-client-ui-sidebar/src/shared/session-fact-reconcile.ts',
    name: 'DEFAULT_MAX_ATTEMPTS',
  },
  {
    table: 'tables.ladders.factReconcile.retryMs',
    source: 'packages/dsh-chamber-client-ui-sidebar/src/shared/session-fact-reconcile.ts',
    name: 'DEFAULT_RETRY_MS',
  },
  {
    table: 'tables.ladders.factReconcile.attemptTimeoutMs',
    source: 'packages/dsh-chamber-client-ui-sidebar/src/shared/session-fact-reconcile.ts',
    name: 'DEFAULT_ATTEMPT_TIMEOUT_MS',
  },
  {
    table: 'tables.ladders.factReconcile.verifyTimeoutMs',
    source: 'packages/dsh-chamber-client-ui-sidebar/src/shared/session-fact-reconcile.ts',
    name: 'DEFAULT_VERIFY_TIMEOUT_MS',
  },
  {
    table: 'tables.ladders.factReconcile.correctivePhaseTimeoutMs',
    source: 'packages/dsh-chamber-client-ui-sidebar/src/shared/session-fact-reconcile.ts',
    name: 'CORRECTIVE_PHASE_TIMEOUT_MS',
  },
]

/**
 * The collection half (B4 acceptance): the four ladder modules read the table.
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
const CONSUMERS = [
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
    table: 'tables.ladders.factReconcile',
    source: 'packages/dsh-chamber-client-ui-sidebar/src/shared/session-fact-reconcile.ts',
    reference: 'LADDER_TABLES.factReconcile',
    retiredNames: [
      'DEFAULT_MAX_ATTEMPTS',
      'DEFAULT_RETRY_MS',
      'DEFAULT_ATTEMPT_TIMEOUT_MS',
      'DEFAULT_VERIFY_TIMEOUT_MS',
      'CORRECTIVE_PHASE_TIMEOUT_MS',
    ],
  },
  {
    table: 'tables.ladders.sessionLiveness',
    source: 'packages/renderer/src/session-liveness.ts',
    reference: 'LADDER_TABLES.sessionLiveness',
    retiredNames: [],
  },
  {
    table: 'tables.ladders.sessionStreamHealth',
    source: 'packages/dsh-chamber-client-ui-open-in/src/client/session-stream-health.ts',
    reference: 'LADDER_TABLES.sessionStreamHealth',
    retiredNames: [],
  },
]

function readTable(path) {
  let node = JSON.parse(readFileSync(TABLES, 'utf8'))
  for (const key of path.split('.')) {
    if (node === undefined || node === null || !(key in node)) return undefined
    node = node[key]
  }
  return node
}

/** Read `const NAME = <numeric literal>` from source, tolerating underscores. */
function readConstant(source, name) {
  const absolute = join(REPO_ROOT, source)
  if (!existsSync(absolute)) return { state: 'missing-file' }
  const text = readFileSync(absolute, 'utf8')
  const pattern = new RegExp('^\\s*(?:export\\s+)?const\\s+' + name + '\\s*=\\s*([0-9_]+)', 'mu')
  const match = pattern.exec(text)
  if (match === null) return { state: 'retired' }
  return { state: 'found', value: Number(match[1].replace(/_/gu, '')) }
}

/** Read one consumer module's source text, or null when the file is absent. */
function readSourceText(source) {
  const absolute = join(REPO_ROOT, source)
  if (!existsSync(absolute)) return null
  return readFileSync(absolute, 'utf8')
}

let failures = 0
let checked = 0
let retired = 0
for (const entry of LOCKSTEP) {
  const expected = readTable(entry.table)
  if (expected === undefined) {
    console.error('✗ tables.json is missing ' + entry.table + ' (the single table must name it)')
    failures += 1
    continue
  }
  const actual = readConstant(entry.source, entry.name)
  if (actual.state === 'missing-file') {
    console.error('✗ ' + entry.source + ': file does not exist (declared in the lockstep list)')
    failures += 1
    continue
  }
  if (actual.state === 'retired') {
    // The module stopped owning it: B4's retirement. Informational, never a failure.
    retired += 1
    continue
  }
  checked += 1
  if (actual.value !== expected) {
    console.error(
      '✗ ' + entry.name + ' (' + entry.source + ') = ' + String(actual.value) +
      ' but tables.json ' + entry.table + ' = ' + String(expected),
    )
    failures += 1
  }
}

let consumersOk = 0
for (const consumer of CONSUMERS) {
  const ladder = readTable(consumer.table)
  if (ladder === undefined || ladder === null || typeof ladder !== 'object') {
    console.error('✗ tables.json is missing ' + consumer.table + ' (the single table must name it)')
    failures += 1
    continue
  }
  const text = readSourceText(consumer.source)
  if (text === null) {
    console.error('✗ ' + consumer.source + ': file does not exist (declared as a table consumer)')
    failures += 1
    continue
  }
  // Only CODE counts: comments are blanked (newlines preserved) so prose that
  // names the table or a retired constant cannot satisfy or trip a check.
  const code = stripComments(text)
  let consumerOk = true
  if (!code.includes(consumer.reference)) {
    console.error(
      '✗ ' + consumer.source + ' no longer reads ' + consumer.reference +
      ' - the ladder is not driven by the single table',
    )
    failures += 1
    consumerOk = false
  }
  for (const name of consumer.retiredNames) {
    // Declaration form only: prose that names a retired constant is not a copy.
    const declaration = new RegExp('(?:^|\\s)(?:export\\s+)?(?:const|let|var)\\s+' + name + '\\s*=')
    if (declaration.test(code)) {
      console.error('✗ ' + consumer.source + ' declares retired ladder constant ' + name + ' again - the table is the only owner')
      failures += 1
      consumerOk = false
    }
  }
  for (const leaf of Object.keys(ladder)) {
    const literal = new RegExp('(?:^|[^A-Za-z0-9_$])' + leaf + '\\s*:\\s*[0-9]')
    if (literal.test(code)) {
      console.error('✗ ' + consumer.source + ' assigns ' + leaf + ' a literal again - read ' + consumer.reference + ' instead')
      failures += 1
      consumerOk = false
    }
  }
  if (consumerOk) consumersOk += 1
}

if (failures > 0) {
  console.error('')
  console.error('ladder-table parity: ' + String(failures) + ' mismatch(es). The single table is the authority;')
  console.error('either fix the table or the module - do not let the two drift while both exist.')
  process.exit(1)
}
console.log(
  '✓ ladder-table parity: ' + String(checked) + ' constant(s) locked to tables.json' +
  (retired > 0 ? ', ' + String(retired) + ' already retired by B4' : '') +
  ', ' + String(consumersOk) + '/' + String(CONSUMERS.length) + ' consumer(s) read the table',
)
