/**
 * Node-side error-text projection — the control plane's instance of the
 * primitive whose browser twin lives in
 * dsh-chamber-client-ui-sidebar/src/shared/error-text.ts (2026-12
 * single-sourcing pass).
 *
 * Two sites inside this package carried the expression inline
 * (local-connection.ts's restart-failure state, protected-plugins.ts's
 * messageOfUnknown). The desktop main process keeps its own describe-error.ts
 * (it additionally appends an Error cause chain) and the official copies stay
 * untouched: those are documented splits, not drift.
 */

/** The message of an unknown throwable, verbatim (never a fabricated cause). */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
