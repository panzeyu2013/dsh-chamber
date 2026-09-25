/**
 * Node-side error-text projection — the control plane's instance of the
 * primitive whose browser twin lives in
 * packages/dsh-chamber-client-core/src/error-text.ts.
 *
 * The primitive is single-sourced here for every site inside this package
 * (local-connection / protected-plugins / state-root-lease / session-mux).
 * The desktop main process keeps its own describe-error.ts
 * (it additionally appends an Error cause chain) and the official copies stay
 * untouched: those are documented splits, not drift.
 */

/** The message of an unknown throwable, verbatim (never a fabricated cause). */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
