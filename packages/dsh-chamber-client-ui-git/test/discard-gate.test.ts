/**
 * Discard-authorization gate decisions of the remove dialog (2026-09-11
 * review-fix, F1/F2).
 *
 * The gate itself is a React component, but the two decisions it turns on are
 * pure and were previously inline in `RemoveWorktreeDialog.tsx` — where the
 * F1 regression lived: the gate's `open` was derived from
 * `nextDiscardGate`, which flips back to `null` the moment the acknowledgement
 * box is ticked, so the gate dismissed itself and its confirm could never run
 * (the removal needed a second `Remove` click). The cases below pin both halves
 * of the contract — which acknowledgement a click still has to collect, and
 * whether the single `discardChanges` wire flag (the host's `--force`) may be
 * sent — while `test/upstream-alignment.test.ts` pins the state wiring the pure
 * functions cannot see.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { discardAuthorized, nextDiscardGate } from '../src/shared/discard-gate.ts'
import type { DiscardGateFacts } from '../src/shared/discard-gate.ts'

/** The dialog's facts with nothing acknowledged and nothing refused. */
const CLEAN: DiscardGateFacts = {
  needsDiscardConfirmation: false,
  discardChanges: false,
  submoduleBlock: false,
  discardSubmodules: false,
}

test('nextDiscardGate: a clean target needs no acknowledgement at all', () => {
  assert.equal(nextDiscardGate(CLEAN), null, 'the click removes directly')
  // A stale-clean row fact that the fresh preflight reported dirty is the same
  // "dirty" authorization (review 2026-08 P2-1).
  assert.equal(nextDiscardGate({ ...CLEAN, needsDiscardConfirmation: true }), 'dirty')
  // The deterministic submodule refusal arms its own authorization.
  assert.equal(nextDiscardGate({ ...CLEAN, submoduleBlock: true }), 'submodule')
})

test('nextDiscardGate: the answer goes null on tick — which is why the gate holds its kind', () => {
  const dirty = { ...CLEAN, needsDiscardConfirmation: true }
  assert.equal(nextDiscardGate(dirty), 'dirty')
  // The tick that enables the gate's confirm also clears this answer: a gate
  // whose `open` were derived from it would unmount under the user's cursor and
  // leave `onConfirm` unreachable (2026-09-11 review-fix, F1).
  assert.equal(
    nextDiscardGate({ ...dirty, discardChanges: true }),
    null,
    'the derivation is EMPTY once authorized — it may never drive the gate open state',
  )
  // Same shape for the submodule authorization.
  const submodule = { ...CLEAN, submoduleBlock: true }
  assert.equal(nextDiscardGate(submodule), 'submodule')
  assert.equal(nextDiscardGate({ ...submodule, discardSubmodules: true }), null)
})

test('nextDiscardGate: the dirty authorization wins when both are missing', () => {
  // Both missing: the dirty gate covers the worktree that is also blocked by a
  // submodule (one acknowledgement, one `--force` removal) — and it must not
  // re-label to the submodule gate while the user is looking at it.
  const both = { needsDiscardConfirmation: true, discardChanges: false, submoduleBlock: true, discardSubmodules: false }
  assert.equal(nextDiscardGate(both), 'dirty')
  // Dirty already authorized: the submodule authorization is what is left.
  assert.equal(nextDiscardGate({ ...both, discardChanges: true }), 'submodule')
  // Submodule already authorized: a dirty target still needs its own.
  assert.equal(nextDiscardGate({ ...both, discardSubmodules: true }), 'dirty')
})

test('discardAuthorized: either acknowledgement turns on the ONE discardChanges wire flag', () => {
  // Nothing acknowledged: the removal must NOT carry `discardChanges` (the host
  // then refuses a dirty/submodule target instead of discarding it).
  assert.equal(discardAuthorized(CLEAN), false)
  assert.equal(discardAuthorized({ ...CLEAN, needsDiscardConfirmation: true }), false)
  assert.equal(discardAuthorized({ ...CLEAN, submoduleBlock: true }), false)
  // Either acknowledgement authorizes the same flag: the host's `--force` path
  // is one path (design 08 §5.3/§5.4).
  assert.equal(discardAuthorized({ ...CLEAN, needsDiscardConfirmation: true, discardChanges: true }), true)
  assert.equal(discardAuthorized({ ...CLEAN, submoduleBlock: true, discardSubmodules: true }), true)
  // An acknowledgement that no longer matches its trigger authorizes nothing:
  // a target that is neither dirty nor submodule-blocked never sends `--force`.
  assert.equal(discardAuthorized({ ...CLEAN, discardChanges: true }), false)
  assert.equal(discardAuthorized({ ...CLEAN, discardSubmodules: true }), false)
})
