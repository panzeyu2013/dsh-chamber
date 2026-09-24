/**
 * The real clock injected into bounded waits (`waitForCondition` /
 * `withDeadline` from @dsh-chamber/dsh-stream-state): ONE adapter shared by
 * the pending-open queue and the App's serving gate, so a scheduler change or
 * a test seam lands in one place instead of drifting between copies.
 */
export const WAIT_SCHEDULER = {
  setTimeout: (run: () => void, ms: number): unknown => setTimeout(run, ms),
  clearTimeout: (handle: unknown): void => { clearTimeout(handle as ReturnType<typeof setTimeout>) },
}
