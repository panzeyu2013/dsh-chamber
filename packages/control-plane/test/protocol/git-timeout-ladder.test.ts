/**
 * Git three-layer timeout ladder lockstep (design 08 §7).
 *
 * One git mutation is bounded three times, strictly nested: the host's git
 * mutation budget must finish inside the proxy's upstream idle window, which
 * must answer inside the browser RPC budget. Until now that relation lived
 * ONLY in three comments; this suite makes it executable by importing the
 * three REAL constants by relative source path (the repository's established
 * cross-package lockstep pattern — cf. win-probes-parity.test.ts):
 *
 *   MUTATION_TIMEOUT_MS  packages/dsh-chamber-seed-git-worktree/src/core-constants.ts
 *   UPSTREAM_TIMEOUT_MS  packages/control-plane/src/proxy-forward.ts
 *   RPC_TIMEOUT_MS       packages/dsh-chamber-client-ui-git/src/shared/timeout-budget.ts
 *
 * Any one-sided edit that inverts a layer or eats the answer margin fails
 * here; the three package owners must re-derive the ladder together, and the
 * registered 30s/45s/60s slots pin the design 08 §7 values explicitly.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MUTATION_TIMEOUT_MS } from '../../../dsh-chamber-seed-git-worktree/src/core-constants.ts'
import { RPC_TIMEOUT_MS } from '../../../dsh-chamber-client-ui-git/src/shared/timeout-budget.ts'
import { UPSTREAM_TIMEOUT_MS } from '../../src/proxy-forward.ts'

/** The ladder in wrap order: the inner budget first, the outer budget last. */
const LADDER = [
  { layer: 'host git mutation', budget: MUTATION_TIMEOUT_MS, owner: 'dsh-chamber-seed-git-worktree/src/core-constants.ts' },
  { layer: 'proxy upstream idle', budget: UPSTREAM_TIMEOUT_MS, owner: 'control-plane/src/proxy-forward.ts' },
  { layer: 'browser git RPC', budget: RPC_TIMEOUT_MS, owner: 'dsh-chamber-client-ui-git/src/shared/timeout-budget.ts' },
] as const

/**
 * The minimum the outer layer must leave the inner one to deliver its answer
 * (serialize + IPC + response) before its own deadline fires. A ladder whose
 * layers differ by microseconds is not a ladder.
 */
const MIN_ANSWER_MARGIN_MS = 5_000

test('the git timeout ladder is strictly nested with a real answer margin', () => {
  for (let index = 1; index < LADDER.length; index++) {
    const inner = LADDER[index - 1]!
    const outer = LADDER[index]!
    assert.ok(
      outer.budget > inner.budget,
      `${outer.layer} (${outer.budget}ms, ${outer.owner}) must exceed ${inner.layer} (${inner.budget}ms, ${inner.owner})`,
    )
    assert.ok(
      outer.budget - inner.budget >= MIN_ANSWER_MARGIN_MS,
      `${outer.layer} must leave ${inner.layer} at least ${MIN_ANSWER_MARGIN_MS}ms to answer, got ${outer.budget - inner.budget}ms`,
    )
  }
})

test('the ladder still carries the registered design 08 §7 slots (30s/45s/60s)', () => {
  assert.deepEqual(LADDER.map(entry => entry.budget), [30_000, 45_000, 60_000])
})
