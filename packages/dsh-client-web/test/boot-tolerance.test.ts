/**
 * node:test for the chamber version-tolerance decision rules
 * (`packages/dsh-client-web/src/boot-tolerance.ts`) — the load-bearing
 * policy behind the 2026-08 rc.8 regression fix (design 09 §3.3). The rules
 * are React-free by design so this suite runs under plain node (no DOM, no
 * jsdom — `pnpm run test:client-web`).
 *
 * The assertions pin the EXACT pre-extraction behavior, including the
 * failure-report strings assertEntriesActive throws with: a refactor that
 * changes the rules (e.g. accidentally making manifest rows tolerable) fails
 * here before it can fail a real boot.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { classifyRendererInstallError, classifySweepEntry } from '../src/boot-tolerance.ts'

const TOLERATED = new Set(['@deepseek-ai/dsh-client-ui-renderer'])
const row = '@deepseek-ai/dsh-client-ui-renderer'

// ── classifySweepEntry: tolerated (extra) rows ─────────────────────────────

test('sweep: a tolerated extra row that ran is ok (features present)', () => {
  assert.deepEqual(classifySweepEntry(row, 'active', TOLERATED, []), { kind: 'ok' })
})

test('sweep: a tolerated extra row in ANY non-active state degrades, never fails the boot', () => {
  for (const label of ['pending', 'loading', 'failed', 'disposed', 'unloading', undefined]) {
    assert.deepEqual(
      classifySweepEntry(row, label, TOLERATED, []),
      { kind: 'degraded' },
      `fiberLabel=${String(label)}`,
    )
  }
})

// ── classifySweepEntry: manifest / app-shell rows (fatal) ──────────────────

test('sweep: a manifest row without a fiber fails the boot (import failed)', () => {
  assert.deepEqual(classifySweepEntry('@deepseek-ai/dsh-client-ui-tool', undefined, new Set(), []), {
    kind: 'fatal',
    reason: '@deepseek-ai/dsh-client-ui-tool: import failed (see console for the import error)',
  })
})

test('sweep: an active manifest row is ok', () => {
  assert.deepEqual(classifySweepEntry('@deepseek-ai/dsh-client-ui-tool', 'active', new Set(), []), { kind: 'ok' })
})

test('sweep: a pending manifest row lists the missing services (plural/unknown forms)', () => {
  const multi = classifySweepEntry('row', 'pending', new Set(), ['a', 'b'])
  assert.equal(multi.kind, 'fatal')
  assert.equal((multi as { reason: string }).reason, 'row: pending (waiting for services: a, b)')
  const single = classifySweepEntry('row', 'pending', new Set(), ['a'])
  assert.equal((single as { reason: string }).reason, 'row: pending (waiting for service: a)')
  const unknown = classifySweepEntry('row', 'pending', new Set(), [])
  // Empty missing list → the "unknown" fallback keeps the plural form (the
  // pre-extraction behavior, preserved verbatim).
  assert.equal((unknown as { reason: string }).reason, 'row: pending (waiting for services: unknown)')
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

// ── classifyRendererInstallError ───────────────────────────────────────────

test('renderer install: the runtime boot-once error adopts the existing renderer', () => {
  assert.equal(
    classifyRendererInstallError(new Error('slot renderer already installed (install() is boot-once)')),
    'adopt',
  )
})

test('renderer install: any other failure is fatal (fail-safe direction)', () => {
  assert.equal(classifyRendererInstallError(new Error('boom')), 'fatal')
  assert.equal(classifyRendererInstallError('not an error object'), 'fatal')
  assert.equal(classifyRendererInstallError(undefined), 'fatal')
})
