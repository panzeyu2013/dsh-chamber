/**
 * One error-text projection for the connections surface (2026-12 audit): the
 * card and the plugin dialog carried byte-identical copies of this helper.
 * Kept module-local (not a cross-package share): settings-bridge keeps its own
 * one-liner and test/runtime-gate/error-text-parity.test.ts locks the two
 * bodies to the same expression.
 */

/** The message of an unknown throwable, verbatim (never a fabricated cause). */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
