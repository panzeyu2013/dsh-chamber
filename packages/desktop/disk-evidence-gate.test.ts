/**
 * D7 disk-evidence skip-set tests (2026-09 perf review M1): the desktop
 * refreshRuntimeEvidence skip decision, extracted into disk-evidence-gate.ts
 * so the set's contents and the membership test carry real assertions (the
 * inline DISK_SKIP_PROGRESS_PHASES in main.ts previously had zero unit
 * coverage, and main.ts is outside every test run).
 *
 * The compile-time ⊆ assertion is the `ReadonlySet<RuntimePhase>` annotation
 * on the module export itself (inserting a non-phase literal fails the root
 * typecheck); this file pins the same invariant at runtime against the full
 * phase list of the runtime state machine (same 12-phase set as
 * runtime-lockstep.test.ts, both keyed off the RuntimePhase union).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DISK_SKIP_PROGRESS_PHASES,
  shouldSkipDiskRefresh,
} from './disk-evidence-gate.ts'
import type { RuntimePhase } from './runtime-state-machine.ts'

/** Full legal phase set of the runtime state machine (typed against the
 *  RuntimePhase union — a typo/rename here fails the typecheck). */
const ALL_RUNTIME_PHASES: readonly RuntimePhase[] = [
  'idle', 'checking', 'available', 'downloading', 'installing', 'pending',
  'applying', 'applied', 'rollback', 'snapshot-failed', 'failed', 'error',
]

const PROGRESS_PHASES = ['downloading', 'installing', 'applying'] as const
const NON_PROGRESS_PHASES: readonly RuntimePhase[] = [
  'idle', 'checking', 'available', 'pending', 'applied',
  'rollback', 'snapshot-failed', 'failed', 'error',
]

test('D7: the three pure-progress phases are in the skip set and skip the disk refresh', () => {
  for (const phase of PROGRESS_PHASES) {
    assert.ok(DISK_SKIP_PROGRESS_PHASES.has(phase), `${phase} must be in DISK_SKIP_PROGRESS_PHASES`)
    assert.equal(shouldSkipDiskRefresh(phase), true, `${phase} must skip the disk refresh`)
  }
})

test('D7: representative non-progress phases never skip the disk refresh', () => {
  for (const phase of NON_PROGRESS_PHASES) {
    assert.equal(DISK_SKIP_PROGRESS_PHASES.has(phase), false, `${phase} must not be in the skip set`)
    assert.equal(shouldSkipDiskRefresh(phase), false, `${phase} must not skip`)
  }
})

test('D7: the skip set stays exactly the three progress phases', () => {
  // 恒为 3：任何未来相位进入/离开 skip 集都会在此显式炸出，防止静默扩展。
  assert.equal(DISK_SKIP_PROGRESS_PHASES.size, 3)
  const full = new Set<RuntimePhase>(ALL_RUNTIME_PHASES)
  for (const phase of DISK_SKIP_PROGRESS_PHASES) {
    assert.ok(full.has(phase), `skip member '${phase}' must be a legal runtime phase`)
  }
  assert.deepEqual(
    [...DISK_SKIP_PROGRESS_PHASES].sort(),
    [...PROGRESS_PHASES].sort(),
    'the skip set must contain exactly downloading/installing/applying',
  )
})
