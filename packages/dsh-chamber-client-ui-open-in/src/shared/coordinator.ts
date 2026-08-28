/**
 * Page-wide open-in app-list coordinator (design 16 + open-in extension).
 *
 * The chamber composite imports this module once and mounts the plugin in N
 * cordis contexts, so every ctx shares ONE app-list probe — a main-process
 * fact over `window.dshChamber.openIn.apps()` (the renderer is sandboxed;
 * host capabilities are probed in the main process only).
 *
 * Fail-closed (design 16 §6.3): an unknown, in-flight or failed probe resolves
 * to `null` — the button never renders on uncertainty.
 */

import { parseOpenInApps, type OpenInApp } from './capabilities.ts'

export type { OpenInApp, OpenInSource } from './capabilities.ts'

/** The window.dshChamber slice this plugin consumes (structural subset of the
 *  desktop preload bridge; local interface on purpose — the plugin stays out
 *  of the renderer's global Window augmentation merge). The preload's `apps()`
 *  already unwraps the IPC `{ apps: [...] }` envelope and resolves the bare
 *  array (preload contract), so this face matches the runtime shape. */
export interface OpenInBridgeSurface {
  dshChamber?: {
    platform?: string | null
    openIn?: {
      apps(): Promise<unknown>
      open(appId: string, instanceId: string, path: string, sourceFingerprint: string): Promise<unknown>
    }
  }
}

/** Bound translator shape (the locale service's bind return, loosely typed). */
export type Translate = (key: string, params?: Record<string, unknown>) => string

let apps: OpenInApp[] | null = null
let appsPromise: Promise<OpenInApp[] | null> | null = null
/** Probe epoch: refreshApps() bumps it so a superseded in-flight probe can
 *  never overwrite the newer result (write-order guard for concurrent
 *  flights — see refreshApps). */
let probeEpoch = 0
const listeners = new Set<() => void>()
export const OPEN_IN_APP_PROBE_RETRY_LIMIT = 3
export const OPEN_IN_APP_PROBE_RETRY_MS = 500

export interface OpenInAppProbeOptions {
  /** Test seam: production uses a real bounded delay between IPC attempts. */
  wait?: (delayMs: number) => Promise<void>
}

function waitForProbeRetry(delayMs: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, delayMs))
}

function emit(): void {
  for (const listener of [...listeners]) listener()
}

/** Current app list; null = not yet probed. The button renders only on a
 *  non-empty filtered list. */
export function getOpenInApps(): OpenInApp[] | null {
  return apps
}

/** Single-flight app-list probe shared across N-ctx; resolves the shared list.
 *  A MISSING bridge is NOT memoized (frontend-review P1-1, final-review
 *  correction): the preload exposes the bridge only after an async
 *  `dsh-chamber:info` round-trip, so a probe that ran before hydration must be
 *  retryable. The bridge check therefore runs BEFORE the promise is cached —
 *  an absent bridge returns a fresh resolved null and leaves `appsPromise`
 *  untouched, so later callers re-probe (an earlier version nulled the promise
 *  INSIDE the cached IIFE, which the outer assignment overwrote — a silent
 *  no-op). A real IPC rejection gets three delayed attempts inside the same
 *  page-wide flight; this recovers a transient first-call sender/handler race
 *  even while the fail-closed button is hidden and has no manual refresh
 *  affordance. Success or final exhaustion is memoized; an explicit lifecycle
 *  signal (window focus/menu opening) calls refreshApps() to release it. This
 *  recovers without turning N mounted buttons into an implicit retry loop. */
export function getApps(options: OpenInAppProbeOptions = {}): Promise<OpenInApp[] | null> {
  if (appsPromise !== null) return appsPromise
  const bridge = (window as unknown as OpenInBridgeSurface).dshChamber?.openIn
  if (bridge === undefined) {
    // Bridge not hydrated yet: keep the unknown state and allow a retry.
    const changed = apps !== null
    apps = null
    if (changed) emit()
    return Promise.resolve(null)
  }
  appsPromise = (async () => {
    const epoch = probeEpoch
    const wait = options.wait ?? waitForProbeRetry
    for (let attempt = 1; attempt <= OPEN_IN_APP_PROBE_RETRY_LIMIT; attempt += 1) {
      try {
        const result = await bridge.apps()
        if (epoch !== probeEpoch) return apps // superseded by a refresh — newer flight owns the write
        apps = parseOpenInApps(result)
        emit()
        return apps
      } catch {
        if (epoch !== probeEpoch) return apps
        if (attempt < OPEN_IN_APP_PROBE_RETRY_LIMIT) {
          await wait(OPEN_IN_APP_PROBE_RETRY_MS)
          if (epoch !== probeEpoch) return apps
          continue
        }
        // Exhaustion remains fail-closed and memoized until refreshApps().
        // This prevents staggered N-ctx mounts from starting repeated waves.
        apps = null
      }
    }
    emit()
    return apps
  })()
  return appsPromise
}

/** True once the preload bridge exposes the openIn surface (desktop only). */
export function openInBridgeReady(): boolean {
  return (window as unknown as OpenInBridgeSurface).dshChamber?.openIn !== undefined
}

/** Force a fresh probe bypassing the memo (menu-open/window-focus refresh): a mid-session
 *  app install/uninstall becomes visible without a page reload. The probe
 *  epoch is bumped so a still-in-flight older probe cannot overwrite the
 *  fresh result. NOTE the fail-closed failure path: a real probe failure
 *  clears the list to null (button hides, memoized) — the stale list is kept
 *  only while the fresh probe is in flight, not after it fails (getApps'
 *  documented fail-closed contract). */
export function refreshApps(): Promise<OpenInApp[] | null> {
  probeEpoch += 1
  appsPromise = null
  return getApps()
}

/** The host platform string ('darwin' | 'win32' | 'linux' | …) or null. Used
 *  for the platform-appropriate Finder/Explorer/file-manager wording. */
export function bridgePlatform(): string | null {
  return (window as unknown as OpenInBridgeSurface).dshChamber?.platform ?? null
}

export function subscribeOpenIn(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1) window.addEventListener('focus', refreshAppsOnFocus)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) window.removeEventListener('focus', refreshAppsOnFocus)
  }
}

/** One page-level focus signal covers every N-ctx consumer and naturally
 * catches apps installed or removed while Chamber was in the background. */
function refreshAppsOnFocus(): void {
  void refreshApps()
}
