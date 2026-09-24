/**
 * Shared control-plane type surface: the console-like logger sink
 * ({log, warn, error}) accepted by every control-plane module.
 */

/** Console-like logger sink accepted by every control-plane module. */
export interface Logger {
  log(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}
