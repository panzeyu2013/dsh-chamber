/**
 * globalThis.window install/restore for the chamber base-path suites
 * (api-path, carrier-assembly): every fixture must leave the process-global
 * exactly as it found it, window-less or not.
 */

/** Run body with globalThis.window set to value; a missing prior window stays missing. */
export function withWindow<T>(value: unknown, body: () => T): T {
  const globals = globalThis as Record<string, unknown>
  const previous = globals.window
  globals.window = value
  try {
    return body()
  } finally {
    if (previous === undefined) delete globals.window
    else globals.window = previous
  }
}
