/**
 * Error-text projections for the browser-side chamber packages — the single
 * implementation, with two DISTINCT primitives: {@link errorMessage} (an
 * Error's message verbatim, anything else String()-ed; may return '' and may
 * throw) and {@link describeThrown} (hostile-safe: never throws, never '').
 * The desktop main process and the official dsh-client-web copy keep their own
 * variants deliberately; dependency-free.
 */

/** The message of an unknown throwable, verbatim (never a fabricated cause). */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Hostile-safe stable text for one thrown value: never throws, never returns '' (empty Error message/name and a throwing String() fall back). */
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
