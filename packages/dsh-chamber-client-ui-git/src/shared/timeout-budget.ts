/**
 * The CLIENT leg of the three-layer Git timeout ladder (design 08 §7): one git
 * mutation can be cut by three strictly nested budgets —
 *   host git mutation   MUTATION_TIMEOUT_MS   = 30_000  (seed-git-worktree core-constants.ts)
 *   proxy upstream idle UPSTREAM_TIMEOUT_MS   = 45_000  (control-plane proxy-forward.ts)
 *   browser RPC         RPC_TIMEOUT_MS        = 60_000  (this module)
 * The browser must never abort while the host is legitimately working, or a
 * committed mutation is misread as ambiguous. The relationship is EXECUTABLE:
 * packages/control-plane/test/protocol/git-timeout-ladder.test.ts imports all
 * three REAL constants (hence this leaf module) and fails on a one-sided edit.
 */
export const RPC_TIMEOUT_MS = 60_000
