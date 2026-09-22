/**
 * Differential equivalence CLI.
 *
 * Runs the recorded scenarios through BOTH readings - the legacy reference trace
 * and the new carrier reducer - and reports where they agree and where they
 * differ. Agreement is required wherever no DIVERGENCE entry authorizes a
 * difference; an unauthorized difference is what this tool exists to catch.
 *
 * Usage:
 *   node scripts/refactor/equivalence.mjs          # report, exit 1 on unauthorized drift
 *   node scripts/refactor/equivalence.mjs --json   # machine-readable verdicts
 *
 * It is deliberately dependency-free and reads neither the fork nor node_modules,
 * so it runs in any checkout - including one where tsc is unavailable.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { reduceCarrierSequence } from '../../packages/dsh-stream-state/src/carrier.ts'
import { initialCarrierState } from '../../packages/dsh-stream-state/src/state.ts'
import { CARRIER_ENV } from '../../packages/dsh-stream-state/src/tables.ts'
import { compareTraces, formatVerdict } from '../../packages/dsh-stream-state/src/compare.ts'
import { legacyEffects, modernCarrierEvents } from '../../packages/dsh-stream-state/test/refactor/reference-adapter.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_VECTORS = join(HERE, '..', '..', 'packages', 'dsh-stream-state', 'test', 'refactor', 'vectors.json')

/**
 * @typedef {object} EquivalenceVector
 * @property {string} id
 * @property {string} [intent]
 * @property {boolean} [expectEquivalent]
 * @property {string} [divergence]
 * @property {Array<Record<string, unknown>>} events
 */

/**
 * @typedef {object} EquivalenceEntry
 * @property {string} id
 * @property {string} [intent]
 * @property {boolean} expectsEquivalent
 * @property {string | null} divergence
 * @property {boolean} equivalent
 * @property {boolean} ok
 * @property {string} detail
 */

/**
 * Load the recorded scenarios; a malformed or empty set throws (a gate that
 * checks nothing must not read as green).
 * @param {string} [path]
 * @returns {EquivalenceVector[]}
 */
export function loadVectors(path = DEFAULT_VECTORS) {
  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  const vectors = parsed?.vectors
  if (!Array.isArray(vectors) || vectors.length === 0) {
    throw new Error('equivalence: no vectors recorded at ' + path)
  }
  for (const vector of vectors) {
    if (typeof vector?.id !== 'string' || !Array.isArray(vector?.events)) {
      throw new Error('equivalence: malformed vector ' + String(vector?.id))
    }
  }
  return vectors
}

/** Run one scenario through both readings.
 * @param {EquivalenceVector} vector
 * @returns {{ expected: import('../../packages/dsh-stream-state/src/state.ts').RecoveryEffect[], actual: import('../../packages/dsh-stream-state/src/state.ts').RecoveryEffect[], verdict: ReturnType<typeof compareTraces> }} */
export function runVector(vector) {
  const expected = legacyEffects(vector.events)
  const events = modernCarrierEvents(vector.events)
  const reduced = reduceCarrierSequence(initialCarrierState(), events, CARRIER_ENV)
  return { expected, actual: reduced.effects, verdict: compareTraces(expected, reduced.effects) }
}

/** Evaluate every vector. Exported so the package suite can assert the same
 * contract without spawning a process.
 * @param {string} [path]
 * @returns {{ report: EquivalenceEntry[], drift: number }} */
export function evaluate(path) {
  const vectors = loadVectors(path)
  const report = []
  let drift = 0
  for (const vector of vectors) {
    const { verdict } = runVector(vector)
    const expectsEquivalent = vector.expectEquivalent !== false
    const divergence = expectsEquivalent ? null : (vector.divergence ?? null)
    const ok = expectsEquivalent ? verdict.equivalent : !verdict.equivalent
    if (!ok) drift += 1
    report.push({
      id: vector.id,
      intent: vector.intent,
      expectsEquivalent,
      divergence,
      equivalent: verdict.equivalent,
      ok,
      detail: formatVerdict(verdict),
    })
  }
  return { report, drift }
}

function main() {
  const { report, drift } = evaluate()
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ vectors: report, drift }, null, 2))
  } else {
    for (const entry of report) {
      const flag = entry.ok ? 'ok  ' : 'FAIL'
      const tag = entry.divergence === null ? 'equivalent-expected' : 'divergence ' + entry.divergence
      const detail = entry.equivalent ? '' : ' :: ' + entry.detail
      console.log(flag + ' ' + entry.id + ' [' + tag + ']' + detail)
    }
    console.log('')
    console.log('vectors ' + String(report.length) + ', drift ' + String(drift))
  }
  process.exit(drift === 0 ? 0 : 1)
}

if (process.argv[1] && process.argv[1].endsWith('equivalence.mjs')) main()
