/**
 * Ladder-table parity gate.
 *
 * The target is "four ladders -> one reducer + ONE TABLE". This gate is the
 * first half, staged exactly like the Swift parity gate: the values are recorded in
 * `packages/dsh-stream-state/tables.json`, and every module that still OWNS a copy
 * (until the table is imported) is checked against that table here. Until the modules import
 * the table, this gate is what makes drift impossible - the same "lockstep while
 * both exist" pattern as the Swift mirror.
 *
 * WHY A GATE AND NOT A UNIT TEST: the modules live in four different packages, and the
 * dependency direction is "modules import the package", so a package test cannot read
 * them. This script reads their source declarations (the values are literal constants)
 * and compares.
 *
 * A module that no longer declares a constant is NOT a failure: that is the
 * retirement working. A constant that EXISTS with a different value IS a failure.
 *
 * Usage: node scripts/gates/verify-ladder-table-parity.mjs
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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
    // The module stopped owning it: retirement. Informational, never a failure.
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

if (failures > 0) {
  console.error('')
  console.error('ladder-table parity: ' + String(failures) + ' mismatch(es). The single table is the authority;')
  console.error('either fix the table or the module - do not let the two drift while both exist.')
  process.exit(1)
}
console.log(
  '✓ ladder-table parity: ' + String(checked) + ' constant(s) locked to tables.json' +
  (retired > 0 ? ', ' + String(retired) + ' already retired by B4' : ''),
)
