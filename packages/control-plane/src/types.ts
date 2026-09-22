/**
 * Shared control-plane type surface.
 *
 * `Logger` is the console-like sink every control-plane module accepts
 * ({log, warn, error}); it is shared by the remaining modules (spawn-dsh,
 * host-logs, reaper, local-connection, api, index, standalone) so they
 * share one definition.
 */

/** Console-like logger sink accepted by every control-plane module. */
export interface Logger {
  log(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}
