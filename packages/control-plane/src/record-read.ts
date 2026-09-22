/**
 * Node-side record guards — the shared implementation for the control plane,
 * the desktop main process and the gateway server.
 *
 * `readStringArray` is the shared implementation for
 * packages/desktop/plugin-sync.ts and packages/gateway/src/plugins-installed.ts.
 * It is a pure data projection with no privilege, but it lives on the NODE side:
 * the browser-side twins stay in dsh-chamber-client-ui-sidebar/src/shared,
 * and the two trust domains deliberately do not import each other.
 *
 * The local `isRecord` in packages/control-plane/src/session-mux.ts looks
 * like the browser-side guard but is strictly stronger
 * (`&& !Array.isArray(value)`), so it answers a different invariant and stays
 * local.
 */

/**
 * Read a nested string-array member: an absent path, a non-array value and
 * non-string members are all "not there" — never a guessed default.
 * @param record - the parsed record.
 * @param path - the key path to walk.
 * @returns the string members in order, or [] when the path yields no array.
 */
export function readStringArray(record: Record<string, unknown>, path: string[]): string[] {
  let current: unknown = record
  for (const key of path) {
    if (current === null || typeof current !== 'object') return []
    current = (current as Record<string, unknown>)[key]
  }
  if (!Array.isArray(current)) return []
  return current.filter((item): item is string => typeof item === 'string')
}
