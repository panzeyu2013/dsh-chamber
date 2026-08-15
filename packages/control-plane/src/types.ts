/**
 * Shared control-plane type surface.
 *
 * `Logger` is the console-like sink every control-plane module accepts
 * ({log, warn, error}); it used to live in sessions.ts (deleted in the v4
 * connection-manager refactor) and now stands on its own so the remaining
 * modules (spawn-dsh, host-logs, reaper, local-connection, api, index,
 * standalone) share one definition.
 */

/** Console-like logger sink accepted by every control-plane module. */
export interface Logger {
  log(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}
