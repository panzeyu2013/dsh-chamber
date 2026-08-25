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

/** One launchable app as reported by the main-process bridge. */
export interface OpenInApp {
  id: string
  /** True when the app can open a REMOTE (ssh-<id>) source's workspace. */
  remoteCapable: boolean
  /** True when the app is installed/available right now. */
  available: boolean
}

/** The window.dshChamber slice this plugin consumes (structural subset of the
 *  desktop preload bridge; local interface on purpose — the plugin stays out
 *  of the renderer's global Window augmentation merge). The preload's `apps()`
 *  already unwraps the IPC `{ apps: [...] }` envelope and resolves the bare
 *  array (preload contract), so this face matches the runtime shape. */
export interface OpenInBridgeSurface {
  dshChamber?: {
    platform?: string | null
    openIn?: {
      apps(): Promise<Array<OpenInApp>>
      open(appId: string, instanceId: string, path: string): Promise<{ ok: true } | { ok: false; error: string }>
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
 *  no-op). A REAL probe result (list or failure) is memoized. */
export function getApps(): Promise<OpenInApp[] | null> {
  if (appsPromise !== null) return appsPromise
  const bridge = (window as unknown as OpenInBridgeSurface).dshChamber?.openIn
  if (bridge === undefined) {
    // Bridge not hydrated yet: keep the unknown state and allow a retry.
    apps = null
    return Promise.resolve(null)
  }
  appsPromise = (async () => {
    const epoch = probeEpoch
    try {
      const result = await bridge.apps()
      if (epoch !== probeEpoch) return apps // superseded by a refresh — newer flight owns the write
      apps = Array.isArray(result) ? result : null
    } catch {
      if (epoch !== probeEpoch) return apps
      // A real probe failure is fail-closed (hidden), and it IS memoized —
      // retrying a broken channel in the same session cannot change the answer.
      apps = null
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

/** Force a fresh probe bypassing the memo (menu-open refresh): a mid-session
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
  return () => {
    listeners.delete(listener)
  }
}

/** Test-only: reset the shared probe state (list, in-flight promise, epoch
 *  and listeners) for isolation — same pattern as the sidebar's
 *  `__resetViewPrefsForTests`. */
export function __resetOpenInForTests(): void {
  apps = null
  appsPromise = null
  probeEpoch = 0
  listeners.clear()
}
