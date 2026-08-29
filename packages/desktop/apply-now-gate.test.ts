/**
 * Apply-now gate matrix tests (review R2/R5): the desktop RUNTIME_APPLY_NOW
 * handler's decision function, extracted into the pure evaluateApplyNowGate so
 * the full IPC-gate matrix — busy / env / not-allowed / blocked / not-ready /
 * no-pending / snapshot-failed / invalid-tree / ok — is exercised with real
 * assertions instead of living untested inside main.ts.
 *
 * These are pure-function tests; the main.ts wiring (input construction from
 * re-read state, pre/post-confirm symmetry) is a separate concern covered by
 * the handler refactor plus the lockstep/ipc-surface mirrors.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateApplyNowGate, type ApplyNowGateInput } from './apply-now-gate.ts'

function gateInput(overrides: Partial<ApplyNowGateInput> = {}): ApplyNowGateInput {
  return {
    phase: 'pending',
    source: 'user',
    runtimeBlocked: false,
    managementSupported: true,
    hasOverride: true,
    pending: '2.0.0',
    journalTarget: null,
    overridePending: null,
    connectionState: 'ready',
    operationBusy: false,
    fenceBusy: false,
    snapshotFailed: false,
    treeValid: true,
    ...overrides,
  }
}

test('apply-now gate: a clean pending state resolves ok with the durable target', () => {
  const result = evaluateApplyNowGate(gateInput())
  assert.deepEqual(result, { ok: true, target: '2.0.0' })
})

test('apply-now gate: busy rejects (operation in flight or writer fence held)', () => {
  assert.deepEqual(evaluateApplyNowGate(gateInput({ operationBusy: true })), { ok: false, reason: 'busy' })
  assert.deepEqual(evaluateApplyNowGate(gateInput({ fenceBusy: true })), { ok: false, reason: 'busy' })
  // Busy is the first gate: it outranks env/blocked/not-ready/no-pending.
  assert.deepEqual(evaluateApplyNowGate(gateInput({
    operationBusy: true,
    source: 'env',
    runtimeBlocked: true,
    connectionState: 'stopped',
    pending: null,
  })), { ok: false, reason: 'busy' })
})

test('apply-now gate: env source rejects (env outranks every persisted override)', () => {
  assert.deepEqual(evaluateApplyNowGate(gateInput({ source: 'env' })), { ok: false, reason: 'env' })
  // Env outranks the later gates (blocked/not-ready/no-pending/tree).
  assert.deepEqual(evaluateApplyNowGate(gateInput({
    source: 'env',
    runtimeBlocked: true,
    connectionState: 'restarting',
    pending: null,
    treeValid: false,
  })), { ok: false, reason: 'env' })
})

test('apply-now gate: not-allowed rejects for non-pending phases and unsupported management', () => {
  // Every non-pending phase is rejected (pending is the only phase exposing
  // apply-now in the action matrix).
  for (const phase of ['idle', 'available', 'applying', 'applied', 'rollback', 'snapshot-failed', 'failed', 'error']) {
    assert.deepEqual(evaluateApplyNowGate(gateInput({ phase })), { ok: false, reason: 'not-allowed' }, phase)
  }
  // Read-only platforms reject regardless of phase.
  assert.deepEqual(evaluateApplyNowGate(gateInput({ managementSupported: false })), { ok: false, reason: 'not-allowed' })
  assert.deepEqual(evaluateApplyNowGate(gateInput({ managementSupported: false, phase: 'pending' })), { ok: false, reason: 'not-allowed' })
})

test('apply-now gate: runtimeBlocked rejects', () => {
  assert.deepEqual(evaluateApplyNowGate(gateInput({ runtimeBlocked: true })), { ok: false, reason: 'blocked' })
  // Blocked outranks the not-ready/no-pending/snapshot/tree gates.
  assert.deepEqual(evaluateApplyNowGate(gateInput({
    runtimeBlocked: true,
    connectionState: 'stopped',
    pending: null,
    snapshotFailed: true,
    treeValid: false,
  })), { ok: false, reason: 'blocked' })
})

test('apply-now gate: not-ready rejects unless the control plane is ready or degraded', () => {
  for (const connectionState of ['stopped', 'restarting', 'restart-exhausted', 'error', 'starting', 'none']) {
    assert.deepEqual(
      evaluateApplyNowGate(gateInput({ connectionState })),
      { ok: false, reason: 'not-ready' },
      connectionState,
    )
  }
  // 'none' is the handler's null-control-plane projection; degraded stays ok.
  assert.deepEqual(evaluateApplyNowGate(gateInput({ connectionState: 'none' })), { ok: false, reason: 'not-ready' })
  assert.deepEqual(evaluateApplyNowGate(gateInput({ connectionState: 'degraded' })), { ok: true, target: '2.0.0' })
})

test('apply-now gate: no-pending rejects when all three durable sources are empty (F5)', () => {
  assert.deepEqual(
    evaluateApplyNowGate(gateInput({ pending: null, journalTarget: null, overridePending: null })),
    { ok: false, reason: 'no-pending' },
  )
  // Target resolution precedes the tree/snapshot checks: with no durable
  // target there is nothing to snapshot-reject or tree-preflight.
  assert.deepEqual(evaluateApplyNowGate(gateInput({
    pending: null,
    journalTarget: null,
    overridePending: null,
    snapshotFailed: true,
    treeValid: false,
  })), { ok: false, reason: 'no-pending' })
})

test('apply-now gate: snapshot-failed rejects (retry-apply owns that path)', () => {
  assert.deepEqual(evaluateApplyNowGate(gateInput({ snapshotFailed: true })), { ok: false, reason: 'snapshot-failed' })
  // Snapshot failure outranks the tree preflight.
  assert.deepEqual(evaluateApplyNowGate(gateInput({ snapshotFailed: true, treeValid: false })), { ok: false, reason: 'snapshot-failed' })
})

test('apply-now gate: invalid-tree rejects a resolved target whose tree preflight failed', () => {
  assert.deepEqual(evaluateApplyNowGate(gateInput({ treeValid: false })), { ok: false, reason: 'invalid-tree' })
  // A builtin-anchor journal target is not a version tree: apply-now must
  // never treat it as a valid target (pending is the only version-tree source
  // this path accepts; a builtin intent resolves nothing here).
  assert.deepEqual(evaluateApplyNowGate(gateInput({
    pending: null,
    journalTarget: 'builtin-anchor',
    treeValid: false,
  })), { ok: false, reason: 'invalid-tree' })
})

test('apply-now gate: target resolution prefers pending over journalTarget over overridePending', () => {
  assert.deepEqual(
    evaluateApplyNowGate(gateInput({ pending: '2.0.0', journalTarget: '3.0.0', overridePending: '4.0.0' })),
    { ok: true, target: '2.0.0' },
  )
  assert.deepEqual(
    evaluateApplyNowGate(gateInput({ pending: null, journalTarget: '3.0.0', overridePending: '4.0.0' })),
    { ok: true, target: '3.0.0' },
  )
  assert.deepEqual(
    evaluateApplyNowGate(gateInput({ pending: null, journalTarget: null, overridePending: '4.0.0' })),
    { ok: true, target: '4.0.0' },
  )
  // overridePending alone is enough (the post-confirm gate parity fix — the
  // second gate must accept the same three-source target the first does).
  assert.deepEqual(
    evaluateApplyNowGate(gateInput({ pending: null, journalTarget: null, overridePending: '1.9.0', connectionState: 'degraded' })),
    { ok: true, target: '1.9.0' },
  )
})
