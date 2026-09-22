// @ts-nocheck -- deliberate, see the note at the bottom of this header.
/**
 * Differential harness - the gate the whole refactor rests on.
 *
 * WHY THE TYPE LAYER IS OFF HERE: this file imports two plain `.mjs` scripts (the
 * equivalence CLI and, in the sibling metrics test, the metrics tool). They run as
 * scripts, not as members of any TS program (the repo's tsconfigs do not enable
 * allowJs for them), so TypeScript cannot resolve their types and every call would
 * read as 'any'. The runtime contract they must satisfy is asserted by the tests
 * themselves; nocheck is scoped to this file and is not an oversight.
 *
 * It runs every recorded scenario through both readings (the legacy reference
 * trace and the new reducer) and requires the outcome to match what the vector
 * RECORDS: equivalent where no divergence is authorized, and demonstrably
 * different where one is. A drift here means either the reducer changed behavior
 * or a recorded defect was silently repaired - both must be a conscious decision
 * with a DIVERGENCE.md entry, never a side effect.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { evaluate } from '../../../../scripts/refactor/equivalence.mjs'
import { legacyTrace, legacyOpeningTimeoutMs } from './reference-adapter.ts'
import { openingBudgetMs } from '../../src/tables.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
/** Repo root, derived from this file's location (test/refactor/ -> repo root). */
const REPO_ROOT = join(HERE, '..', '..', '..', '..')
const VECTORS = join(HERE, 'vectors.json')
const LEDGER = join(HERE, '..', '..', 'DIVERGENCE.md')

test('every recorded vector lands on its recorded expectation', () => {
  const { report, drift } = evaluate(VECTORS)
  const failures = report.filter((entry) => !entry.ok).map((entry) => entry.id + ': ' + entry.detail)
  assert.deepEqual(failures, [], 'drift reported by the differential gate')
  assert.equal(drift, 0)
  assert.ok(report.length >= 6, 'the vector set must keep covering every defect class')
})

test('no vector silently repairs a recorded defect', () => {
  const { report } = evaluate(VECTORS)
  for (const entry of report) {
    if (entry.expectsEquivalent) {
      assert.equal(entry.equivalent, true, entry.id + ' must be equivalent')
      assert.equal(entry.divergence, null, entry.id + ' must not carry an authorization')
    } else {
      assert.equal(entry.equivalent, false, entry.id + ' records a divergence that no longer happens')
      assert.match(String(entry.divergence), /^D-\d+$/, entry.id + ' must name a DIVERGENCE entry')
    }
  }
})

test('every authorized divergence has a ledger entry and vice versa', () => {
  const { report } = evaluate(VECTORS)
  const ledger = readFileSync(LEDGER, 'utf8')
  const cited = new Set(report.map((entry) => entry.divergence).filter((id) => id !== null))
  assert.ok(cited.size > 0, 'at least one divergence must stay recorded while B1 is pending')
  for (const id of cited) {
    assert.ok(ledger.includes('**' + String(id) + '**'), 'DIVERGENCE.md is missing entry ' + String(id))
  }
  // Section A of the ledger is the trace-verifiable set: its ids and the vector
  // citations must match exactly, both directions, so a divergence can never be
  // authorized silently nor recorded without being exercised.
  const sectionA = ledger.split('## A.')[1]?.split('## B.')[0] ?? ''
  const declared = [...sectionA.matchAll(/\*\*(D-\d+)\*\*/g)].map((match) => match[1])
  assert.ok(declared.length > 0, 'DIVERGENCE.md section A declares no entries')
  for (const id of declared) {
    assert.ok(cited.has(id), 'DIVERGENCE.md entry ' + String(id) + ' is not exercised by any vector')
  }
  for (const id of cited) {
    assert.ok(declared.includes(id), 'vector cites ' + String(id) + ' but section A does not declare it')
  }
  // Section B is the trace-invisible set: every entry must name a Proof.
  const sectionB = ledger.split('## B.')[1]?.split('## C.')[0] ?? ''
  const proofRows = sectionB.split('\n').filter((line) => /\*\*D-\d+\*\*/.test(line) && line.startsWith('|'))
  assert.ok(proofRows.length > 0, 'DIVERGENCE.md section B declares no entries')
  for (const row of proofRows) {
    assert.ok(row.includes('Proof:'), 'section B entry lacks a Proof citation: ' + row.slice(0, 40))
    // A citation to a file that does not exist is worse than no citation: it reads
    // as checked while checking nothing.
    const citedPath = /Proof: ([^ )|`]+)/.exec(row)?.[1]
    assert.ok(citedPath !== undefined, 'section B entry has an unparsable Proof citation')
    const absolute = join(REPO_ROOT, citedPath)
    assert.ok(existsSync(absolute), 'Proof citation does not exist: ' + citedPath)
  }
})

test('vector ids are unique', () => {
  const { report } = evaluate(VECTORS)
  const ids = report.map((entry) => entry.id)
  assert.equal(new Set(ids).size, ids.length)
})

test('the reference adapter reproduces the MEASURED legacy trace for two zero-frame misses', () => {
  const trace = legacyTrace([
    { kind: 'socketOpened', at: 0 },
    { kind: 'openingTimeout', at: 30000, frames: 0, request: 's1' },
    { kind: 'openingTimeout', at: 90000, frames: 0, request: 's1' },
  ])
  assert.deepEqual(trace.map((action) => action.reason), ['silent', 'silent'])
})

test('the reference widening formula matches the recorded ladder', () => {
  const ladder = [30000, 60000, 120000, 240000, 300000]
  for (let streak = 0; streak <= 8; streak += 1) {
    const expected = streak >= 4 ? 300000 : ladder[streak]
    assert.equal(openingBudgetMs(streak), expected, 'new table at streak ' + String(streak))
    if (streak < 4) {
      assert.equal(legacyOpeningTimeoutMs(streak), expected, 'legacy formula at streak ' + String(streak))
    }
  }
})
