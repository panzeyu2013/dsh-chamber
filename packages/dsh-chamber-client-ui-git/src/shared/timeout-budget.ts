/**
 * The CLIENT leg of the three-layer Git timeout ladder (design 08 §7).
 *
 * One git mutation can be cut by three budgets, strictly nested:
 *
 *   host git mutation   MUTATION_TIMEOUT_MS = 30_000
 *     (packages/dsh-chamber-seed-git-worktree/src/core-constants.ts)
 *   proxy upstream idle UPSTREAM_TIMEOUT_MS = 45_000
 *     (packages/control-plane/src/proxy-forward.ts)
 *   browser RPC         RPC_TIMEOUT_MS      = 60_000  (this module)
 *
 * The browser must never abort while the host is still legitimately working,
 * or a committed mutation is misread as ambiguous. The relationship is
 * EXECUTABLE, not a comment: packages/control-plane/test/protocol/
 * git-timeout-ladder.test.ts imports all three REAL constants (including this
 * one, which is why the client budget lives in this leaf module instead of
 * git-api.ts) and fails on any one-sided edit that breaks the nesting or eats
 * the answer margin.
 */
export const RPC_TIMEOUT_MS = 60_000
