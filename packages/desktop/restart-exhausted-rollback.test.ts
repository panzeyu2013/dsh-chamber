/** Design 17 §3.4 F7 durable rollback-planner tests. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  ActivationJournal,
  ActivationJournalIntent,
  ActivationJournalState,
} from './dsh-runtime-store.ts'
import {
  readActivationJournalState,
  writeActivationJournal,
} from './dsh-runtime-store.ts'
import { planRestartExhaustedRollback } from './restart-exhausted-rollback.ts'

const NOW = new Date('2026-08-23T10:00:00.000Z')

function monitoringJournal(overrides: Partial<ActivationJournal> = {}): ActivationJournal {
  return {
    schemaVersion: 1,
    phase: 'applied-monitoring',
    targetVersion: '2.0.0',
    targetIsBuiltin: false,
    manualRollback: false,
    intentKind: 'version-switch',
    sourceVersion: '1.0.0',
    sourceIsBuiltin: false,
    sourceWasKnownGood: true,
    knownGoodVersion: '0.9.0',
    preSwapSnapshotName: '1.0.0-1700000000000',
    manualDataSnapshotName: null,
    preRollbackStashName: null,
    rollbackTarget: null,
    nextIntent: null,
    startedAt: '2026-08-23T09:00:00.000Z',
    updatedAt: '2026-08-23T09:01:00.000Z',
    ...overrides,
  }
}

function valid(journal: ActivationJournal = monitoringJournal()): ActivationJournalState {
  return { kind: 'valid', journal }
}

function plan(overrides: Partial<Parameters<typeof planRestartExhaustedRollback>[0]> = {}) {
  return planRestartExhaustedRollback({
    restartExhausted: true,
    activeIsOverride: true,
    failedVersion: '2.0.0',
    journalState: valid(),
    now: () => NOW,
    ...overrides,
  })
}

test('non-exhausted and builtin activation never produce a rollback journal', () => {
  assert.deepEqual(plan({ restartExhausted: false }), {
    status: 'not-triggered', reason: 'not-restart-exhausted',
  })
  assert.deepEqual(plan({ activeIsOverride: false }), {
    status: 'not-triggered', reason: 'active-runtime-not-override',
  })
})

test('missing, corrupt, and unsafe journal evidence fail closed', () => {
  assert.deepEqual(plan({ journalState: { kind: 'missing' } }), {
    status: 'not-triggered', reason: 'journal-missing',
  })
  assert.deepEqual(plan({ journalState: { kind: 'corrupt' } }), {
    status: 'not-triggered', reason: 'journal-corrupt',
  })
  assert.deepEqual(plan({
    journalState: valid(monitoringJournal({ preSwapSnapshotName: '../snapshot' })),
  }), {
    status: 'not-triggered', reason: 'journal-monitoring-invalid',
  })
})

test('planner accepts only a matching non-builtin applied-monitoring target', () => {
  assert.deepEqual(plan({ failedVersion: '../2.0.0' }), {
    status: 'not-triggered', reason: 'failed-version-invalid',
  })
  assert.deepEqual(plan({ journalState: valid(monitoringJournal({ targetIsBuiltin: true })) }), {
    status: 'not-triggered', reason: 'journal-target-builtin',
  })
  assert.deepEqual(plan({ failedVersion: '3.0.0' }), {
    status: 'not-triggered', reason: 'journal-target-mismatch',
  })
  assert.deepEqual(plan({ journalState: valid(monitoringJournal({ phase: 'switched' })) }), {
    status: 'not-triggered', reason: 'journal-not-monitoring',
  })
})

test('planned journal durably enters rollback-needed before any external effect', () => {
  const original = monitoringJournal()
  const result = plan({ journalState: valid(original) })
  assert.equal(result.status, 'planned')
  if (result.status !== 'planned') return

  assert.equal(result.rollbackTarget, '1.0.0')
  assert.equal(result.journal.phase, 'rollback-needed')
  assert.equal(result.journal.rollbackTarget, '1.0.0')
  assert.equal(result.journal.updatedAt, NOW.toISOString())
  assert.equal(result.journal.preSwapSnapshotName, '1.0.0-1700000000000')
  assert.equal(result.journal.targetVersion, '2.0.0')
  assert.equal(original.phase, 'applied-monitoring', 'input journal remains immutable')
  assert.equal(original.rollbackTarget, null)
})

test('untrusted source uses known-good; builtin source selects builtin pointer', () => {
  const knownGood = plan({
    journalState: valid(monitoringJournal({ sourceWasKnownGood: false })),
  })
  assert.equal(knownGood.status, 'planned')
  if (knownGood.status === 'planned') assert.equal(knownGood.rollbackTarget, '0.9.0')

  const builtin = plan({
    journalState: valid(monitoringJournal({ sourceIsBuiltin: true })),
  })
  assert.equal(builtin.status, 'planned')
  if (builtin.status === 'planned') assert.equal(builtin.rollbackTarget, null)
})

test('stale facts can never select the failed tree', () => {
  const distinctKnownGood = plan({
    journalState: valid(monitoringJournal({
      sourceVersion: '2.0.0', sourceWasKnownGood: true, knownGoodVersion: '0.9.0',
    })),
  })
  assert.equal(distinctKnownGood.status, 'planned')
  if (distinctKnownGood.status === 'planned') assert.equal(distinctKnownGood.rollbackTarget, '0.9.0')

  const onlyFailedTree = plan({
    journalState: valid(monitoringJournal({
      sourceVersion: '2.0.0', sourceWasKnownGood: true, knownGoodVersion: '2.0.0',
    })),
  })
  assert.equal(onlyFailedTree.status, 'planned')
  if (onlyFailedTree.status === 'planned') assert.equal(onlyFailedTree.rollbackTarget, null)
})

test('persisted rollback phases are the exactly-once latch', () => {
  for (const phase of ['rollback-needed', 'restoring', 'restore-complete', 'fallback-builtin'] as const) {
    const journal = monitoringJournal({ phase, rollbackTarget: '1.0.0' })
    const result = plan({ journalState: valid(journal) })
    assert.equal(result.status, 'already-in-recovery')
    if (result.status === 'already-in-recovery') {
      assert.strictEqual(result.journal, journal)
      assert.equal(result.rollbackTarget, '1.0.0')
    }
  }
})

test('planned journal survives persistence and becomes the restart/duplicate-event latch', () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'dsh-f7-plan-'))
  try {
    const first = plan()
    assert.equal(first.status, 'planned')
    if (first.status !== 'planned') return
    writeActivationJournal(baseDir, first.journal)

    const persisted = readActivationJournalState(baseDir)
    assert.equal(persisted.kind, 'valid')
    const second = plan({ journalState: persisted })
    assert.equal(second.status, 'already-in-recovery')
    if (second.status === 'already-in-recovery') {
      assert.equal(second.journal.phase, 'rollback-needed')
      assert.equal(second.rollbackTarget, '1.0.0')
    }
  } finally {
    rmSync(baseDir, { recursive: true, force: true })
  }
})

test('a queued later selection is returned explicitly and never hidden in an invalid rollback journal', () => {
  const queued: ActivationJournalIntent = {
    targetVersion: '3.0.0', targetIsBuiltin: false, manualRollback: false, intentKind: 'version-switch',
  }
  const result = plan({ journalState: valid(monitoringJournal({ nextIntent: queued })) })
  assert.equal(result.status, 'planned')
  if (result.status !== 'planned') return
  assert.deepEqual(result.deferredIntent, queued)
  assert.equal(result.journal.nextIntent, null)
})

test('invalid monitoring facts or clock cannot produce mutation intent', () => {
  assert.deepEqual(plan({
    journalState: valid(monitoringJournal({ sourceVersion: null })),
  }), {
    status: 'not-triggered', reason: 'journal-monitoring-invalid',
  })
  assert.deepEqual(plan({ now: () => new Date(Number.NaN) }), {
    status: 'not-triggered', reason: 'clock-invalid',
  })
})
