/**
 * Node-side error-text projection. Its browser twin is
 * packages/dsh-chamber-client-core/src/error-text.ts; keep them in lockstep.
 */

/** The message of an unknown throwable, verbatim (never a fabricated cause). */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
