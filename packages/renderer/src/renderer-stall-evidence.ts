/**
 * Desktop-observed renderer-stall evidence (design 14 §D4).
 *
 * The page cannot see a stopped rAF loop (Chromium still services the probe's JS)
 * or its own input-blocked thread; the main-process frame probe can. The shell
 * pushes strike counters on every change and keeps its own bounded reload as the
 * acting path - this registry only makes the same evidence available to the page
 * delivery owner. Evidence older than the validity window is treated as cleared:
 * a missed clear must expire rather than authorize escalation forever.
 */

export interface RendererStallObservation {
  readonly scheduleStrikes: number
  readonly inputBlockStrikes: number
  /** Wall clock of the observation (the shell's Date.now). */
  readonly at: number
}

/** How long a strike observation stays usable if no newer push arrives. */
export const RENDERER_STALL_EVIDENCE_VALID_MS = 30_000

let latest: RendererStallObservation | undefined

/** Accept one push from the desktop bridge (shape-validated, never throws). */
export function publishRendererStallObservation(value: unknown): void {
  if (value === null || typeof value !== 'object') return
  const row = value as Partial<RendererStallObservation>
  if (typeof row.scheduleStrikes !== 'number' || !Number.isSafeInteger(row.scheduleStrikes) || row.scheduleStrikes < 0) return
  if (typeof row.inputBlockStrikes !== 'number' || !Number.isSafeInteger(row.inputBlockStrikes) || row.inputBlockStrikes < 0) return
  if (typeof row.at !== 'number' || !Number.isSafeInteger(row.at) || row.at <= 0) return
  latest = { scheduleStrikes: row.scheduleStrikes, inputBlockStrikes: row.inputBlockStrikes, at: row.at }
}

/** Current strikes, zeroed once the observation is stale (wall-clock `now`). */
export function readRendererStallStrikes(now: number): {
  readonly scheduleStrikes: number
  readonly inputBlockStrikes: number
  readonly observedAt: number | undefined
} {
  if (latest === undefined || now - latest.at > RENDERER_STALL_EVIDENCE_VALID_MS) {
    return { scheduleStrikes: 0, inputBlockStrikes: 0, observedAt: undefined }
  }
  return { scheduleStrikes: latest.scheduleStrikes, inputBlockStrikes: latest.inputBlockStrikes, observedAt: latest.at }
}

/** Test seam: the registry is a module singleton. */
export function resetRendererStallEvidence(): void {
  latest = undefined
}
