/**
 * Shared row-error contract for session open outcomes: writer and renderer must derive the key
 * from ONE template — drift would silently write failures that never render.
 */

/** rowErrors key of one session's open-outcome text (writer == reader). */
export function openErrorKey(sourceId: string, sessionId: string): string {
  return `${sourceId}/session/${sessionId}/open`
}

/** Delete one key from a rowErrors map without churn when it is absent. */
export function withoutOpenError(
  previous: Record<string, string>,
  key: string,
): Record<string, string> {
  if (previous[key] === undefined) return previous
  const next = { ...previous }
  delete next[key]
  return next
}
