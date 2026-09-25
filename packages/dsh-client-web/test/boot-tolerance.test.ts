/**
 * node:test for the chamber version-tolerance decision rules
 * (`packages/dsh-client-web/src/boot-tolerance.ts`) — the load-bearing
 * version-tolerance policy (design 09 §3.3). React-free by design,
 * so this suite runs under plain node (`pnpm run test:client-web`).
 *
 * The assertions pin the EXACT failure-report strings assertEntriesActive
 * throws with: a refactor that
 * changes the rules (e.g. making manifest rows tolerable) fails here first.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { classifySweepEntry } from '../src/boot-tolerance.ts'

const TOLERATED = new Set(['@deepseek-ai/dsh-client-ui-renderer'])
const row = '@deepseek-ai/dsh-client-ui-renderer'

// ── classifySweepEntry: tolerated (extra) rows ─────────────────────────────

test('sweep: a tolerated extra row that ran is ok (features present)', () => {
  assert.deepEqual(classifySweepEntry(row, 'active', TOLERATED, []), { kind: 'ok' })
})

test('sweep: a tolerated extra row in ANY non-active state degrades, never fails the boot', () => {
  for (const label of ['pending', 'loading', 'failed', 'disposed', 'unloading', undefined]) {
    assert.deepEqual(classifySweepEntry(row, label, TOLERATED, []), { kind: 'degraded' }, `fiberLabel=${String(label)}`)
  }
})

// ── classifySweepEntry: manifest / app-shell rows (fatal) ──────────────────

test('sweep: a manifest row without a fiber fails the boot (import failed)', () => {
  assert.deepEqual(classifySweepEntry('@deepseek-ai/dsh-client-ui-tool', undefined, new Set(), []),
    { kind: 'fatal', reason: '@deepseek-ai/dsh-client-ui-tool: import failed (see console for the import error)' })
})

test('sweep: a recorded import error names the real reason (upstream boot audit parity)', () => {
  assert.deepEqual(
    classifySweepEntry('@deepseek-ai/dsh-client-ui-tool', undefined, new Set(), [], 'Failed to fetch dynamically imported module'),
    { kind: 'fatal', reason: '@deepseek-ai/dsh-client-ui-tool: import failed: Failed to fetch dynamically imported module' })
  assert.deepEqual(
    classifySweepEntry('row', undefined, new Set(), [], ''),
    { kind: 'fatal', reason: 'row: import failed: ' },
    // 空串也照用：空串 ≠ 无记录（有记录就报真实原因）。
  )
})

test('sweep: an active manifest row is ok', () => {
  assert.deepEqual(classifySweepEntry('@deepseek-ai/dsh-client-ui-tool', 'active', new Set(), []), { kind: 'ok' })
})

test('sweep: a pending manifest row lists the missing services (plural/unknown forms)', () => {
  const pending = (missing: string[]): { kind: string; reason: string } =>
    classifySweepEntry('row', 'pending', new Set(), missing) as { kind: string; reason: string }
  const multi = pending(['a', 'b'])
  assert.equal(multi.kind, 'fatal')
  assert.equal(multi.reason, 'row: pending (waiting for services: a, b)')
  assert.equal(pending(['a']).reason, 'row: pending (waiting for service: a)')
  // Empty missing list → the "unknown" fallback keeps the plural form
  // (preserved verbatim).
  assert.equal(pending([]).reason, 'row: pending (waiting for services: unknown)')
})

test('sweep: any other manifest fiber state is fatal with the state label', () => {
  assert.deepEqual(classifySweepEntry('row', 'failed', new Set(), []), { kind: 'fatal', reason: 'row: failed' })
  assert.deepEqual(classifySweepEntry('row', 'unloading', new Set(), []), { kind: 'fatal', reason: 'row: unloading' })
})

test('sweep: tolerance applies per row id — the same label degrades only the tolerated row', () => {
  const tolerated = new Set(['extra-a'])
  assert.deepEqual(classifySweepEntry('extra-a', 'failed', tolerated, []), { kind: 'degraded' })
  assert.deepEqual(classifySweepEntry('manifest-row', 'failed', tolerated, []), { kind: 'fatal', reason: 'manifest-row: failed' })
})
