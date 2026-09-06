/**
 * App-global update-state store for the settings「更新」section (design 11).
 *
 * Module-level singleton (the settings shell mounts per-ctx, but the update
 * state is app-global — one desktop main process): hydrates from
 * window.dshChamber.update (query + push), keeps ONE subscription across all
 * shell instances, and exposes a stable snapshot for useSyncExternalStore.
 *
 * The singleton + hydration + subscription skeleton (bridge latch, the
 * 100ms×20 fast re-probe chain, push-wins query handling, module-load kick,
 * subscriber re-arm) is the shared bridge-hydration.ts machinery — the same
 * skeleton settings-store.ts runs with its own surface/policies; see that
 * module's file header for the shared design notes.
 *
 * Store-specific notes:
 * - getUpdateState() is PURE (no side effects) — it must stay that way:
 *   useSyncExternalStore's getSnapshot runs during the render phase. All
 *   hydration is triggered from subscribeUpdateState (commit phase) and from
 *   module load, never from getSnapshot.
 * - No slow re-probe chain (slowReProbe: false): after the fast chain
 *   exhausts or a one-shot state() failure the store stays quiet — its
 *   PERMANENT push listener keeps hydrating on later pushes, and the next
 *   subscriber re-arms a fresh fast chain (the bridge subscription is a
 *   permanent ipcRenderer listener for the page's lifetime; zero listeners
 *   while idle — the push only wakes subscribers; assumes one module
 *   instance per page/shared chunk).
 * - The push wins over a stale query snapshot (a push arriving between the
 *   state() invoke and its resolution is never overwritten by the older
 *   query result).
 */
import type { UpdateState, UpdateSurface } from '../ambient/update-bridge.d.ts'
import { createBridgeHydration } from './bridge-hydration.ts'

/** Module-wide download in-flight guard (N-ctx shells share one download). */
let downloadInFlight = false

/** Module-wide restart in-flight guard (N-ctx shells share one restart).
 *
 * Two-layer single-flight contract (2026-12 review): this module gate covers
 * the IPC round-trip only — it is deliberately NOT reset when the main
 * process ACCEPTED the restart, because acceptance means quitAndInstall was
 * armed and the app is on its way out (cleanup takes seconds); a re-click in
 * that window must not fire a second invoke. The MAIN-process gate
 * (updater.restartAndInstall, also never reset on success) is the backstop
 * that covers the whole quit window regardless of what any page believes, so
 * this gate only needs to prevent pointless duplicate invokes from multiple
 * shells of the same page. Failure/refusal paths reset here so the user can
 * retry in place. */
let restartInFlight = false

const hydration = createBridgeHydration<UpdateState, UpdateSurface>({
  surface: () => (typeof window !== 'undefined' ? window.dshChamber?.update ?? null : null),
  onChanged: (api, listener) => api.onChanged(listener),
  query: (api) => api.state(),
  onPush: (state) => {
    // Restart recovery rule (2026-12 review round F2/F5): the module
    // restart single-flight mirrors main and is deliberately NOT reset on an
    // armed ok:true — but a push proving the restart FAILED must release it,
    // or every later click would be silently refused ('restart already in
    // progress') until an app reload. Failure proof = the pushed state
    // carries restartFailureText (main keeps phase `downloaded` there), or
    // the phase left {downloaded, downloading} toward 'error'/'up-to-date'
    // (belt — normally unreachable while armed, harmless when not armed).
    // A plain downloaded push without failure keeps the armed-forever-quit
    // semantics (the single-flight stays held until the quit — by design).
    if (state.restartFailureText !== undefined
      || state.phase === 'error' || state.phase === 'up-to-date') {
      restartInFlight = false
    }
  },
  onQuery: () => {
    // No extra shaping: a query result that wins the push-wins race is the
    // authoritative snapshot as-is (the release rule above is push-only —
    // only a PUSH can prove a restart failed).
  },
  slowReProbe: false,
})

// Start hydration as soon as the module loads (the bundle loads before the
// preload bridge resolves; the retry chain covers the gap).
hydration.hydrate()

/** Stable snapshot (null = bridge absent / not hydrated yet). PURE — no side effects. */
export function getUpdateState(): UpdateState | null {
  return hydration.snapshot()
}

export function subscribeUpdateState(listener: () => void): () => void {
  return hydration.subscribe(listener)
}

/** The「检查更新」button action: a user-initiated check (same silent check
 *  path as the startup/6h checks — autoDownload stays off, a check never
 *  downloads). */
export async function requestUpdateCheck(): Promise<{ ok: true } | { ok: false; error: string }> {
  const api = hydration.surface()
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
    const api = hydration.surface()
    if (api === null) return { ok: false, error: 'update bridge unavailable' }
    return await api.download()
  } catch (error) {
    return { ok: false, error: String(error) }
  } finally {
    downloadInFlight = false
  }
}

/**
 * The「重启并安装」button action (2026-12 user decision): once the download
 * completed, restart the app into the update (main-process quitAndInstall —
 * quit + install + relaunch through the normal quit path; transports and the
 * local dsh instance are disposed during that quit). {ok:true} means the
 * restart was armed — the process is on its way out and the caller should
 * treat the action as terminal (keep busy/disabled); only a refused or
 * failed call releases the gate for an in-place retry.
 */
export async function requestUpdateRestart(): Promise<{ ok: true } | { ok: false; error: string }> {
  if (restartInFlight) return { ok: false, error: 'restart already in progress' }
  restartInFlight = true
  try {
    const api = hydration.surface()
    if (api === null) {
      restartInFlight = false
      return { ok: false, error: 'update bridge unavailable' }
    }
    const result = await api.restartAndInstall()
    if (!result.ok) restartInFlight = false
    return result
  } catch (error) {
    restartInFlight = false
    return { ok: false, error: String(error) }
  }
}

/** The「前往下载页」link action (main-process allowlisted). */
export async function requestOpenReleasePage(url: string): Promise<void> {
  const api = hydration.surface()
  if (api === null) return
  try {
    await api.openReleasePage(url)
  } catch {
    // 静默：打开失败不打扰用户（低打扰契约）。
  }
}
