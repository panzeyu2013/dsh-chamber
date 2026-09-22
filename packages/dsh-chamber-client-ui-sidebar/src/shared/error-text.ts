/**
 * Error-text projections for the browser-side chamber packages — the
 * repository's single implementation (2026-12 single-sourcing pass).
 *
 * Two DISTINCT primitives, deliberately not collapsed into one:
 *
 * - {@link errorMessage} — the verbatim-message projection: an Error's message,
 *   anything else String()-ed. It is what a UI shows next to a failed action,
 *   and it may return '' (an Error with an empty message). It can also throw on
 *   a hostile value, because String() can throw.
 * - {@link describeThrown} — the hostile-value projection: never throws, never
 *   returns ''. Use it at a catch boundary whose caller must be settled even
 *   when the thrown value is a proxy whose getters/toString throw.
 *
 * Before this module these were copied per package: errorMessage in
 * settings-connections (error-text.ts), settings-bridge (DshRuntimeSection.tsx
 * inline, notify-test-result.ts) and git (saga.ts / coordinator.ts errorText,
 * git-api.ts, RemoveWorktreeDialog.tsx); describeThrown in renderer (shell.ts)
 * and git (action-error.ts rawMessage). Two further copies stay where they are
 * by design and are NOT merged here: the desktop main process
 * (packages/desktop/describe-error.ts, which additionally appends an Error
 * cause chain) and the official dsh-client-web copy
 * (packages/dsh-client-web/src/boot.ts, upstream-diffable).
 *
 * Dependency-free on purpose: the consumers' plain-node tests import it.
 */

/** The message of an unknown throwable, verbatim (never a fabricated cause).
 * @param err - any thrown value.
 * @returns the Error message, or the String() projection of anything else. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Hostile-safe stable text for one thrown value (never throws, never '').
 * @param value - any thrown value.
 * @param fallback - the text used when nothing readable can be extracted.
 * @returns a non-empty diagnostic string.
 */
export function describeThrown(value: unknown, fallback = 'unknown error'): string {
  try {
    if (value instanceof Error) {
      const message = typeof value.message === 'string' ? value.message : ''
      if (message !== '') return message
      const name = typeof value.name === 'string' ? value.name : ''
      if (name !== '') return name
    }
  } catch {
    // Hostile proxy/getter — fall through to the guarded String conversion.
  }
  try {
    const text = String(value)
    return text === '' ? fallback : text
  } catch {
    return fallback
  }
}
