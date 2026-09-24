/**
 * Shell boot budget in its own dependency-free module: pure lifecycle modules
 * import it from here so that importing `shell.ts` does not drag the client graph.
 */

/** How long one instance shell may take to settle before the boot chain gives up on it. */
export const BOOT_TIMEOUT_MS = 60_000
