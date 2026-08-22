/**
 * Page-wide VS Code availability coordinator (design 16 §6.2).
 *
 * The chamber composite imports this module once and mounts the plugin in N
 * cordis contexts, so every ctx shares ONE availability probe — a main-process
 * fact over `window.dshChamber.vscode.availability()` (the renderer is
 * sandboxed; host capabilities are probed in the main process only).
 *
 * Fail-closed (design 16 §6.3): an unknown, in-flight or failed probe resolves
 * to `false` — the button never renders on uncertainty.
 */

/** The window.dshChamber slice this plugin consumes (structural subset of the
 *  desktop preload bridge; local interface on purpose — the plugin stays out
 *  of the renderer's global Window augmentation merge). */
export interface VscodeBridgeSurface {
  dshChamber?: {
    vscode?: {
      availability(): Promise<{ available: boolean }>
      open(instanceId: string, path: string): Promise<{ ok: true } | { ok: false; error: string }>
    }
  }
}

/** Bound translator shape (the locale service's bind return, loosely typed). */
export type Translate = (key: string, params?: Record<string, unknown>) => string

let availability: boolean | null = null
let availabilityPromise: Promise<boolean | null> | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of [...listeners]) listener()
}

/** Current availability; null = not yet probed. The button renders only when true. */
export function getVscodeAvailability(): boolean | null {
  return availability
}

/** Single-flight probe shared across N-ctx; resolves the shared availability.
 *  A MISSING bridge is NOT memoized (frontend-review P1-1, final-review
 *  correction): the preload exposes the bridge only after an async
 *  `dsh-chamber:info` round-trip, so a probe that ran before hydration must be
 *  retryable. The bridge check therefore runs BEFORE the promise is cached —
 *  an absent bridge returns a fresh resolved null and leaves
 *  `availabilityPromise` untouched, so later callers re-probe (an earlier
 *  version nulled the promise INSIDE the cached IIFE, which the outer
 *  assignment overwrote — a silent no-op). A REAL probe result (true/false)
 *  is memoized. */
export function ensureVscodeAvailability(): Promise<boolean | null> {
  if (availabilityPromise !== null) return availabilityPromise
  const bridge = (window as unknown as VscodeBridgeSurface).dshChamber?.vscode
  if (bridge === undefined) {
    // Bridge not hydrated yet: keep the unknown state and allow a retry.
    availability = null
    return Promise.resolve(null)
  }
  availabilityPromise = (async () => {
    try {
      const result = await bridge.availability()
      availability = result?.available === true
    } catch {
      // A real probe failure is fail-closed (hidden), and it IS memoized —
      // retrying a broken channel in the same session cannot change the answer.
      availability = false
    }
    emit()
    return availability
  })()
  return availabilityPromise
}

/** True once the preload bridge exposes the vscode surface (desktop only). */
export function vscodeBridgeReady(): boolean {
  return (window as unknown as VscodeBridgeSurface).dshChamber?.vscode !== undefined
}

export function subscribeVscodeAvailability(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
