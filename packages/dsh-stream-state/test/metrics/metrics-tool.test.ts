// @ts-nocheck -- deliberate, see the note below.
/**
 * Metrics tool - the guard against a self-deceiving baseline.
 *
 * WHY THE TYPE LAYER IS OFF HERE: this file imports a plain `.mjs` script (the
 * metrics tool), which is not part of any TS program (the repo's tsconfigs do not
 * enable allowJs for scripts). The tool's runtime contract is what these tests
 * check; the type layer cannot see it.
 *
 * The measurement tool is part of the deliverable: if it can silently measure
 * nothing, 'the numbers went down'
 * means nothing. These tests pin the tool's scope and its output shape, not the
 * values (values are the snapshot's job, and they legitimately move).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  LIFECYCLE_MODULES,
  THRESHOLD_SCOPE,
  collectMetrics,
  diffMetrics,
  thresholdNames,
} from '../../../../scripts/refactor/stream-state-metrics.mjs'

test('the tool measures a non-empty, named scope', () => {
  assert.ok(LIFECYCLE_MODULES.length >= 11, 'the audit list must stay in scope')
  assert.ok(THRESHOLD_SCOPE.includes('packages/dsh-stream-state/src'), 'the new package must be counted')
  assert.ok(THRESHOLD_SCOPE.includes('packages/dsh-stream-state/tables.json'), 'the shared table must be counted')
})

test('every module in scope still exists (a renamed file cannot leave silently)', () => {
  const metrics = collectMetrics()
  const missing = Object.entries(metrics.modules)
    .filter(([, lines]) => lines === 0)
    .map(([file]) => file)
  assert.deepEqual(missing, [], 'in-scope modules with zero lines')
})

test('the threshold count is a real count, not an empty set', () => {
  const names = thresholdNames()
  assert.ok(names.size >= 20, 'expected the chain to still carry dozens of thresholds, got ' + String(names.size))
  assert.ok(names.has('OPENING_TIMEOUT_LADDER_MS'), 'the opening ladder table constant must be in scope')
})

test('the snapshot diff is directional: growth reads as positive', () => {
  const before = { moduleLinesTotal: 100, moduleCount: 2, thresholdCount: 5, dependantFileCount: 3, appLifecycleMarkerHits: 4, swiftShellMarkerHits: 1 }
  const after = { ...before, moduleLinesTotal: 80, thresholdCount: 7 }
  const report = diffMetrics(before, after)
  // -20 must appear as a negative delta, +2 as positive: a sign error here would
  // invert every conclusion.
  assert.match(report, /100 ->\s+80\s+-20/u)
  assert.match(report, /5 ->\s+7\s+\+2/u)
})
