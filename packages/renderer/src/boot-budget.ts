/**
 * Shell boot budget, in its own dependency-free module.
 *
 * `shell.ts` owns the boot chain and this constant, but importing `shell.ts`
 * drags the whole client module graph, so the pure lifecycle modules that must
 * reason about the budget (the harvest's deadline/abandon caps) import it from
 * here instead — the coupling is then structural, not a magic number.
 */

/** How long one instance shell may take to settle before the boot chain gives up on it. */
export const BOOT_TIMEOUT_MS = 60_000
