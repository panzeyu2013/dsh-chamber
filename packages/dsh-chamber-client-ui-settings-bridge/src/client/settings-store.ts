/**
 * App-global chamber-settings store for the settings「通用」section (design
 * 14 D7 + 15 v1 flat form).
 *
 * Module-level singleton (the settings shell mounts per-ctx, but the settings
 * are app-global — one desktop main process): hydrates from
 * window.dshChamber.settings (query + push), keeps ONE subscription across all
 * shell instances, and exposes a stable snapshot for useSyncExternalStore.
 *
 * Same design notes as update-store.ts (design 11): getStatus() is PURE (no
 * side effects — useSyncExternalStore's getSnapshot runs during render);
 * the push wins over a stale query snapshot; the bridge exposes
 * asynchronously (≤~500ms) so hydration retries briefly and re-arms on the
 * next subscriber; the bridge subscription is a PERMANENT ipcRenderer
 * listener for the page's lifetime (assumes one module instance per page).
 */
import type { ChamberSettings, ChamberSettingsStatus, SettingsSurface } from '../ambient/settings-bridge.d.ts'

let current: ChamberSettingsStatus | null = null
const listeners = new Set<() => void>()
/** True once the bridge onChanged/state subscription is attached (module-wide, once). */
let bridgeSubscribed = false
/** The active hydration retry timer, or null when no chain is running. */
let retryTimer: ReturnType<typeof setTimeout> | null = null

function notify(): void {
  for (const listener of listeners) listener()
}

function bridgeSettings(): SettingsSurface | null {
  return typeof window !== 'undefined' ? window.dshChamber?.settings ?? null : null
}

function attachBridge(api: SettingsSurface): void {
  if (bridgeSubscribed) return
  bridgeSubscribed = true
  api.onChanged((status) => {
    current = status
    notify()
  })
  void api.get()
    .then((status) => {
      // Push wins over a stale query snapshot: only apply the query result
      // when no push has landed yet.
      if (current === null) {
        current = status
        notify()
      }
    })
    .catch(() => {})
}

function hydrate(): void {
  if (bridgeSubscribed || retryTimer !== null) return
  const tryAttach = (attempt: number): void => {
    const api = bridgeSettings()
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
export function getSettingsStatus(): ChamberSettingsStatus | null {
  return current
}

export function subscribeSettings(listener: () => void): () => void {
  listeners.add(listener)
  if (current === null) hydrate()
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Apply a settings patch (design 14 D7): the main process validates,
 * applies side effects (keep-awake / login autostart), persists, and pushes.
 * Loud {error} on failure — never a silent fake success. The returned status
 * (or the pushed update) refreshes the local snapshot.
 */
export async function applySettingsPatch(
  patch: Partial<ChamberSettings>,
): Promise<{ ok: true; status: ChamberSettingsStatus } | { ok: false; error: string; code?: string }> {
  const api = bridgeSettings()
  if (api === null) return { ok: false, error: 'settings bridge unavailable' }
  try {
    const result = await api.set(patch)
    if ('error' in result) return { ok: false, error: result.error, code: result.code }
    current = result
    notify()
    return { ok: true, status: result }
  } catch (error) {
    return { ok: false, error: String(error) }
  }
}
