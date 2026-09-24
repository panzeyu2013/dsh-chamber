/**
 * Single error-stringification boundary for the desktop main process: every
 * catch/report site uses one function, so a diagnostic cannot be lost to a
 * thrown proxy/getter or a re-thrown second exception (the discipline the
 * structured IPC result channel depends on). An Error's `cause` chain is
 * appended as `<message>: <cause>`, bounded to MAX_CAUSE_DEPTH links and
 * cycle-safe, so a wrapped failure keeps why it happened.
 */
const MAX_CAUSE_DEPTH = 4

/** Hostile-safe stable text for one thrown value (never throws, never ''). */
function primaryText(error: unknown): string {
  try {
    if (error instanceof Error) {
      const message = typeof error.message === 'string' ? error.message : ''
      if (message !== '') return message
      const name = typeof error.name === 'string' ? error.name : ''
      if (name !== '') return name
    }
  } catch {
  }
  try {
    const text = String(error)
    return text === '' ? 'unknown error' : text
  } catch {
    return 'unknown error'
  }
}

function causeText(error: unknown, depth: number): string | null {
  if (depth >= MAX_CAUSE_DEPTH) return null
  let cause: unknown
  try {
    if (!(error instanceof Error)) return null
    cause = (error as { cause?: unknown }).cause
  } catch {
    return null
  }
  if (cause === undefined || cause === null) return null
  const text = primaryText(cause)
  const nested = causeText(cause, depth + 1)
  return nested === null ? text : text + ': ' + nested
}

/** Stable, non-empty, hostile-safe diagnostic including the cause chain. */
export function describeError(error: unknown): string {
  const text = primaryText(error)
  const cause = causeText(error, 0)
  return cause === null ? text : text + ': ' + cause
}
