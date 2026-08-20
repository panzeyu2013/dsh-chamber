/**
 * App-global update-state store for the settings「更新」section (design 11).
 *
 * Module-level singleton (the settings shell mounts per-ctx, but the update
 * state is app-global — one desktop main process): hydrates from
 * window.dshChamber.update (query + push), keeps ONE subscription across all
 * shell instances, and exposes a stable snapshot for useSyncExternalStore.
 *
 * Design notes:
 * - getUpdateState() is PURE (no side effects) — it must stay that way:
 *   useSyncExternalStore's getSnapshot runs during the render phase. All
 *   hydration is triggered from subscribeUpdateState (commit phase) and from
 *   module load, never from getSnapshot.
 * - The preload exposes the bridge asynchronously (after dsh-chamber:info
 *   resolves, ≤~500ms). Hydration retries briefly; if the window lapses, the
 *   next subscriber re-arms a fresh chain instead of giving up forever.
 * - The push wins over a stale query snapshot (a push arriving between the
 *   state() invoke and its resolution is never overwritten by the older
 *   query result).
 * - The bridge subscription is a PERMANENT ipcRenderer listener for the
 *   page's lifetime (app-global store; zero listeners while idle — the push
 *   only wakes subscribers). This assumes one module instance per page
 *   (shared chunk); a duplicated bundle would double the listener.
 */
import type { UpdateState, UpdateSurface } from '../ambient/update-bridge.d.ts'

let current: UpdateState | null = null
const listeners = new Set<() => void>()
/** True once the bridge onChanged/state subscription is attached (module-wide, once). */
let bridgeSubscribed = false
/** The active hydration retry timer, or null when no chain is running. */
let retryTimer: ReturnType<typeof setTimeout> | null = null
/** Module-wide download in-flight guard (N-ctx shells share one download). */
let downloadInFlight = false

function notify(): void {
  for (const listener of listeners) listener()
}

function bridgeUpdate(): UpdateSurface | null {
  return typeof window !== 'undefined' ? window.dshChamber?.update ?? null : null
}

function attachBridge(api: UpdateSurface): void {
  if (bridgeSubscribed) return
  bridgeSubscribed = true
  api.onChanged((state) => {
    current = state
    notify()
  })
  void api.state()
    .then((state) => {
      // Push wins over a stale query snapshot: only apply the query result
      // when no push has landed yet.
      if (current === null) {
        current = state
        notify()
      }
    })
    .catch(() => {})
}

function hydrate(): void {
  if (bridgeSubscribed || retryTimer !== null) return
  const tryAttach = (attempt: number): void => {
    const api = bridgeUpdate()
    if (api === null) {
      if (attempt < 20) {
        retryTimer = setTimeout(() => tryAttach(attempt + 1), 100)
      } else {
        retryTimer = null
      }
      return
    }
    retryTimer = null
    attachBridge(api)
  }
  tryAttach(0)
}

// Start hydration as soon as the module loads (the bundle loads before the
// preload bridge resolves; the retry chain covers the gap).
hydrate()

/** Stable snapshot (null = bridge absent / not hydrated yet). PURE — no side effects. */
export function getUpdateState(): UpdateState | null {
  return current
}

export function subscribeUpdateState(listener: () => void): () => void {
  listeners.add(listener)
  // Re-arm hydration when the bridge never landed (a failed chain retries on
  // the next subscriber instead of giving up forever).
  if (current === null) hydrate()
  return () => {
    listeners.delete(listener)
  }
}

/** The「检查更新」button action: a user-initiated check (same silent check
 *  path as the startup/6h checks — autoDownload stays off, a check never
 *  downloads). */
export async function requestUpdateCheck(): Promise<{ ok: true } | { ok: false; error: string }> {
  const api = bridgeUpdate()
  if (api === null) return { ok: false, error: 'update bridge unavailable' }
  try {
    return await api.check()
  } catch (error) {
    return { ok: false, error: String(error) }
  }
}

/** The「更新」button action: user-confirmed download (autoDownload stays off). */
export async function requestUpdateDownload(): Promise<{ ok: true } | { ok: false; error: string }> {
  if (downloadInFlight) return { ok: false, error: 'download already in progress' }
  downloadInFlight = true
  try {
    const api = bridgeUpdate()
    if (api === null) return { ok: false, error: 'update bridge unavailable' }
    return await api.download()
  } catch (error) {
    return { ok: false, error: String(error) }
  } finally {
    downloadInFlight = false
  }
}

/** The「前往下载页」link action (main-process allowlisted). */
export async function requestOpenReleasePage(url: string): Promise<void> {
  const api = bridgeUpdate()
  if (api === null) return
  try {
    await api.openReleasePage(url)
  } catch {
    // 静默：打开失败不打扰用户（低打扰契约）。
  }
}
