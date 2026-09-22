/**
 * Ladder-table parity gate (B4/G-G precondition).
 *
 * B4's acceptance is "four ladders -> one reducer + ONE TABLE". This gate is the
 * first half, staged exactly like the Swift parity gate: the values are recorded in
 * `packages/dsh-stream-state/tables.json`, and every module that still OWNS a copy
 * (until B4/P5 retires it) is checked against that table here. Until the modules
 * import the table, this gate is what makes drift impossible - the same "lockstep
 * while both exist" pattern B5 used for the Swift mirror.
 *
 * WHY A GATE AND NOT A UNIT TEST: the modules live in four different packages, and the
 * dependency direction is "modules import the package", so a package test cannot read
 * them. This script reads their source declarations (the values are literal constants)
 * and compares. Plain constants are read by name; the config-object defaults are read
 * by field inside the exported object literal.
 *
 * A module that no longer declares a constant is NOT a failure: that is the
 * retirement working (P5 removes these entries one at a time). A constant that EXISTS
 * with a different value IS a failure.
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
  // G-G: the renderer liveness ladder (P5 wires it onto the shared engine and
  // retires this block).
  {
    table: 'tables.ladders.sessionLiveness.refreshAfterMs',
    source: 'packages/renderer/src/session-liveness.ts',
    object: 'SESSION_LIVENESS_DEFAULTS',
    name: 'refreshAfterMs',
  },
  {
    table: 'tables.ladders.sessionLiveness.refreshCoalesceMs',
    source: 'packages/renderer/src/session-liveness.ts',
    object: 'SESSION_LIVENESS_DEFAULTS',
    name: 'refreshCoalesceMs',
  },
  {
    table: 'tables.ladders.sessionLiveness.maxRefreshRequests',
    source: 'packages/renderer/src/session-liveness.ts',
    object: 'SESSION_LIVENESS_DEFAULTS',
    name: 'maxRefreshRequests',
  },
  {
    table: 'tables.ladders.sessionLiveness.refreshWindowMs',
    source: 'packages/renderer/src/session-liveness.ts',
    object: 'SESSION_LIVENESS_DEFAULTS',
    name: 'refreshWindowMs',
  },
  {
    table: 'tables.ladders.sessionLiveness.refreshOutcomeTimeoutMs',
    source: 'packages/renderer/src/session-liveness.ts',
    object: 'SESSION_LIVENESS_DEFAULTS',
    name: 'refreshOutcomeTimeoutMs',
  },
  {
    table: 'tables.ladders.sessionLiveness.reconnectBackoffMs',
    source: 'packages/renderer/src/session-liveness.ts',
    object: 'SESSION_LIVENESS_DEFAULTS',
    name: 'reconnectBackoffMs',
  },
  {
    table: 'tables.ladders.sessionLiveness.maxReconnects',
    source: 'packages/renderer/src/session-liveness.ts',
    object: 'SESSION_LIVENESS_DEFAULTS',
    name: 'maxReconnects',
  },
  {
    table: 'tables.ladders.sessionLiveness.maxNoopReconnects',
    source: 'packages/renderer/src/session-liveness.ts',
    object: 'SESSION_LIVENESS_DEFAULTS',
    name: 'maxNoopReconnects',
  },
  {
    table: 'tables.ladders.sessionLiveness.noticeAfterMs',
    source: 'packages/renderer/src/session-liveness.ts',
    object: 'SESSION_LIVENESS_DEFAULTS',
    name: 'noticeAfterMs',
  },
  // G-G: the open-in stream-health chip.
  {
    table: 'tables.ladders.streamHealth.errorGraceMs',
    source: 'packages/dsh-chamber-client-ui-open-in/src/client/session-stream-health.ts',
    object: 'SESSION_STREAM_HEALTH_DEFAULTS',
    name: 'errorGraceMs',
  },
  {
    table: 'tables.ladders.streamHealth.loadingStallMs',
    source: 'packages/dsh-chamber-client-ui-open-in/src/client/session-stream-health.ts',
    object: 'SESSION_STREAM_HEALTH_DEFAULTS',
    name: 'loadingStallMs',
  },
  {
    table: 'tables.ladders.streamHealth.loadingFailedMs',
    source: 'packages/dsh-chamber-client-ui-open-in/src/client/session-stream-health.ts',
    object: 'SESSION_STREAM_HEALTH_DEFAULTS',
    name: 'loadingFailedMs',
  },
  {
    table: 'tables.ladders.streamHealth.healCooldownMs',
    source: 'packages/dsh-chamber-client-ui-open-in/src/client/session-stream-health.ts',
    object: 'SESSION_STREAM_HEALTH_DEFAULTS',
    name: 'healCooldownMs',
  },
  {
    table: 'tables.ladders.streamHealth.healBudgetWindowMs',
    source: 'packages/dsh-chamber-client-ui-open-in/src/client/session-stream-health.ts',
    object: 'SESSION_STREAM_HEALTH_DEFAULTS',
    name: 'healBudgetWindowMs',
  },
  {
    table: 'tables.ladders.streamHealth.healBudgetMax',
    source: 'packages/dsh-chamber-client-ui-open-in/src/client/session-stream-health.ts',
    object: 'SESSION_STREAM_HEALTH_DEFAULTS',
    name: 'healBudgetMax',
  },
  {
    table: 'tables.ladders.streamHealth.healSettleMs',
    source: 'packages/dsh-chamber-client-ui-open-in/src/client/session-stream-health.ts',
    object: 'SESSION_STREAM_HEALTH_DEFAULTS',
    name: 'healSettleMs',
  },
  {
    table: 'tables.ladders.streamHealth.carrierChurnMs',
    source: 'packages/dsh-chamber-client-ui-open-in/src/client/session-stream-health.ts',
    object: 'SESSION_STREAM_HEALTH_DEFAULTS',
    name: 'carrierChurnMs',
  },
  // P3 (2026-12): the api-gateway carrier constants and the opening budget were
  // retired into the package (stream-client consumes openingBudgetMs /
  // HANDSHAKE_TIMEOUT_MS / SILENT_TEARDOWN_MIN_MS directly), so their lockstep
  // entries are gone with them.
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
  const { failures, checked, retired, lines } = compareLockstep(LOCKSTEP, {
    table: readTable,
    constant: readConstant,
    objectField: readObjectField,
  })
  for (const line of lines) console.error(line)
  if (failures > 0) {
    console.error('')
    console.error('ladder-table parity: ' + String(failures) + ' mismatch(es). The single table is the authority;')
    console.error('either fix the table or the module - do not let the two drift while both exist.')
    process.exit(1)
  }
  console.log(
    'ok ladder-table parity: ' + String(checked) + ' constant(s) locked to tables.json' +
    (retired > 0 ? ', ' + String(retired) + ' already retired' : ''),
  )
}

const isEntry = process.argv[1] !== undefined && process.argv[1].endsWith('verify-ladder-table-parity.mjs')
if (isEntry) main()
