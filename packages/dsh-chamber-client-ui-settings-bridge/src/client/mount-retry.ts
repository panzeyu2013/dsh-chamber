/**
 * Bounded-backoff retry schedule for the settings-shell session mount
 * (SettingsShell.tsx): a transient not-ready burst (the selected host
 * mid-boot/restart) can reject the child-ctx mount, and while the panel
 * stays open the shell auto-retries the SAME mount path with this capped
 * schedule instead of stranding the settings content in error.
 *
 * Rationale for bounded backoff: the common failure is a SHORT transient
 * window (the target finishing its boot), so the first retries wait briefly
 * (1s, then 2s, 4s) and recover as soon as the target is ready; the cap per
 * step (8s) and the attempt bound (MOUNT_RETRY_ATTEMPTS) guarantee a
 * genuinely dead target still fails loud within a bounded horizon (~15s of
 * waiting) — the shell then keeps showing the error (fail-loud) and the
 * manual re-click / reopen / selection-switch paths still recover. Pure
 * (no React/DOM): the component owns the per-selection ledger, timers, and
 * cancellation; this module only answers "how long to wait next" and "is
 * the budget spent".
 */

/** Total mount attempts per selection: the initial one plus up to 4 retries. */
export const MOUNT_RETRY_ATTEMPTS = 5

/** Base backoff delay; doubles per consecutive failure (1s → 2s → 4s → 8s). */
export const MOUNT_RETRY_BASE_DELAY_MS = 1000

/** Per-step backoff cap: a step never waits longer than this, no matter how many failures. */
export const MOUNT_RETRY_MAX_DELAY_MS = 8000

/**
 * The wait before the retry that follows `failures` consecutive mount
 * rejections for one selection.
 * @param failures - consecutive rejections so far (>= 1; 1 → first retry).
 */
export function mountRetryDelayMs(failures: number): number {
  return Math.min(MOUNT_RETRY_MAX_DELAY_MS, MOUNT_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, failures - 1))
}

/**
 * The next retry delay after `failures` consecutive rejections, or null when
 * the budget is exhausted (failures >= MOUNT_RETRY_ATTEMPTS) — the shell then
 * stops auto-retrying and keeps the error state (fail loud; the manual
 * re-click / reopen / selection-switch / connection-transition paths still
 * recover).
 */
export function nextMountRetryDelayMs(failures: number): number | null {
  if (failures < 1 || failures >= MOUNT_RETRY_ATTEMPTS) return null
  return mountRetryDelayMs(failures)
}
