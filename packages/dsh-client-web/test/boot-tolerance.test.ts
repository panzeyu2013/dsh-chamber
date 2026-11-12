/**
 * node:test for the chamber version-tolerance decision rules
 * (`packages/dsh-client-web/src/boot-tolerance.ts`) — the load-bearing
 * version-tolerance policy (design 09 §3.3): the rc.2 required-entry audit plus the
 * extra-row degrade. React-free by design, so this suite runs under plain node
 * (`pnpm run test:client-web`).
 *
 * The assertions pin the EXACT failure-report strings the boot throw/warns with: a
 * refactor that changes the rules (e.g. making every manifest row tolerable, or
 * flipping the default to fail-loud) fails here first.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  activationFailure, classifySweepEntry, sweepFatalReport, sweepWarningReport,
  type SweepFailure, type SweepPolicy,
} from '../src/boot-tolerance.ts'

const KERNEL = '@deepseek-ai/dsh-client-modules'
const MANIFEST = '@deepseek-ai/dsh-client-ui-tool'
const EXTRA = '@third-party/plugin-a'
// The page's fatal set: kernel-adopted rows plus the build-time manifest rows (the
// manifest carries only the chamber composite bundle); per-instance extras degrade.
const REQUIRED = new Set([KERNEL, MANIFEST])
const OPTIONAL = '@example/non-required-row'
const POLICY: SweepPolicy = { required: REQUIRED, tolerated: new Set([EXTRA]) }
const EMPTY: SweepFailure[] = []

// ── classifySweepEntry: required (kernel) rows ─────────────────────────────

test('sweep: an active entry is ok regardless of its id sets', () => {
  assert.deepEqual(classifySweepEntry(KERNEL, 'active', POLICY, []), { kind: 'ok' })
  assert.deepEqual(classifySweepEntry(MANIFEST, 'active', POLICY, []), { kind: 'ok' })
  assert.deepEqual(classifySweepEntry(EXTRA, 'active', POLICY, []), { kind: 'ok' })
})

test('sweep: an inactive REQUIRED row is fatal with its reason', () => {
  assert.deepEqual(classifySweepEntry(KERNEL, undefined, POLICY, []),
    { kind: 'fatal', reason: 'import failed (see console for the import error)' })
  assert.deepEqual(classifySweepEntry(KERNEL, 'pending', POLICY, ['slots']),
    { kind: 'fatal', reason: 'pending (waiting for service: slots)' })
  assert.deepEqual(classifySweepEntry(KERNEL, 'failed', POLICY, [], undefined, 'failed: boom'),
    { kind: 'fatal', reason: 'failed: boom' })
})

test('sweep: an inactive REQUIRED manifest row is fatal — build-time manifest rows are required', () => {
  assert.deepEqual(classifySweepEntry(MANIFEST, 'failed', POLICY, [], undefined, 'failed: Error: apply exploded'),
    { kind: 'fatal', reason: 'failed: Error: apply exploded' })
})

// ── classifySweepEntry: non-required rows degrade; required rows are fatal ──

test('sweep: an inactive non-required row degrades instead of failing the boot', () => {
  assert.deepEqual(classifySweepEntry(OPTIONAL, undefined, POLICY, [], 'Failed to fetch dynamically imported module'),
    { kind: 'degraded', reason: 'import failed: Failed to fetch dynamically imported module' })
  assert.deepEqual(classifySweepEntry(OPTIONAL, 'pending', POLICY, ['a', 'b']),
    { kind: 'degraded', reason: 'pending (waiting for services: a, b)' })
  assert.deepEqual(classifySweepEntry(OPTIONAL, 'failed', POLICY, [], undefined, 'failed: Error: apply exploded'),
    { kind: 'degraded', reason: 'failed: Error: apply exploded' })
  assert.deepEqual(classifySweepEntry(OPTIONAL, 'disposed', POLICY, []),
    { kind: 'degraded', reason: 'disposed' })
})

test('sweep: a tolerated extra row degrades in ANY non-active state, never fatal', () => {
  for (const label of ['pending', 'loading', 'failed', 'disposed', 'unloading', undefined]) {
    const verdict = classifySweepEntry(EXTRA, label, POLICY, [])
    assert.equal(verdict.kind, 'degraded', `fiberLabel=${String(label)}`)
  }
})

test('sweep: tolerant wins even when a misconfiguration also lists the id as required', () => {
  const both: SweepPolicy = { required: new Set([EXTRA]), tolerated: new Set([EXTRA]) }
  assert.equal(classifySweepEntry(EXTRA, 'failed', both, []).kind, 'degraded')
})

test('sweep: a recorded import error names the real reason (upstream boot audit parity)', () => {
  const verdict = classifySweepEntry(KERNEL, undefined, POLICY, [], 'Failed to fetch dynamically imported module')
  assert.deepEqual(verdict, { kind: 'fatal', reason: 'import failed: Failed to fetch dynamically imported module' })
  // 空串也照用：空串 ≠ 无记录（有记录就报真实原因）。
  assert.deepEqual(classifySweepEntry(KERNEL, undefined, POLICY, [], ''),
    { kind: 'fatal', reason: 'import failed: ' })
})

test('sweep: pending lists the missing services (plural/unknown forms)', () => {
  const reason = (missing: string[]): string => {
    const verdict = classifySweepEntry(KERNEL, 'pending', POLICY, missing)
    assert.equal(verdict.kind, 'fatal')
    return verdict.kind === 'fatal' ? verdict.reason : ''
  }
  assert.equal(reason(['a', 'b']), 'pending (waiting for services: a, b)')
  assert.equal(reason(['a']), 'pending (waiting for service: a)')
  // Empty missing list → the "unknown" fallback keeps the plural form (preserved verbatim).
  assert.equal(reason([]), 'pending (waiting for services: unknown)')
})

// ── reports ────────────────────────────────────────────────────────────────

test('report: no failures produce neither a fatal report nor a warning', () => {
  assert.equal(sweepFatalReport(EMPTY, REQUIRED), undefined)
  assert.equal(sweepWarningReport(EMPTY, REQUIRED), undefined)
})

test('report: only non-required failures produce ONE warning (no fatal report)', () => {
  const failures = [
    { name: OPTIONAL, reason: 'import failed: boom' },
    { name: EXTRA, reason: 'failed: boom' },
  ]
  assert.equal(sweepFatalReport(failures, REQUIRED), undefined)
  assert.equal(sweepWarningReport(failures, REQUIRED),
    'web boot: warning: 2 entries did not activate\n'
    + `${OPTIONAL}: import failed: boom\n${EXTRA}: failed: boom`)
})

test('report: a required failure rejects with every failure listed and required ids marked', () => {
  const failures = [
    { name: KERNEL, reason: 'failed: boom' },
    { name: MANIFEST, reason: 'import failed: sku' },
  ]
  assert.equal(sweepFatalReport(failures, REQUIRED),
    'web boot: 2 required entries did not activate\n'
    + `${KERNEL} (required): failed: boom\n${MANIFEST} (required): import failed: sku`)
  // rc.2 writes no warning alongside a required failure.
  assert.equal(sweepWarningReport(failures, REQUIRED), undefined)
  // …and the boot never reaches the warning path: the fatal report exists.
  assert.notEqual(sweepFatalReport(failures, REQUIRED), undefined)
})

// ── activationFailure ─────────────────────────────────────────────────────

test('activationFailure: a settled failed fiber rethrows its recorded error through await()', async () => {
  const failed = { await: async (): Promise<unknown> => { throw new Error('apply exploded') } }
  assert.equal(await activationFailure(failed), 'failed: Error: apply exploded')
})

test('activationFailure: a fiber that settles without throwing reports the bare state', async () => {
  assert.equal(await activationFailure({ await: async () => {} }), 'failed')
})
