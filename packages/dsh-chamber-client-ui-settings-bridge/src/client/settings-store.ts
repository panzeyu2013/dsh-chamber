/**
 * App-global chamber-settings store for the settings「通用」section (design
 * 14 D7 + 15 v1 flat form).
 *
 * Module-level singleton (the settings shell mounts per-ctx, but the settings
 * are app-global — one desktop main process): hydrates from
 * window.dshChamber.settings (query + push), keeps ONE subscription across all
 * shell instances, and exposes a stable snapshot for useSyncExternalStore.
 *
 * The singleton + hydration + subscription skeleton (bridge latch, the
 * 100ms×20 fast re-probe chain, push-wins query handling, module-load kick,
 * subscriber re-arm, and the settings-only slow re-probe chain that keeps
 * probing while subscribers wait) is the shared bridge-hydration.ts
 * machinery — the same skeleton update-store.ts runs with its own
 * surface/policies; see that module's file header for the shared design
 * notes. getSettingsStatus() is PURE (no side effects —
 * useSyncExternalStore's getSnapshot runs during render); the push wins over
 * a stale query snapshot; the bridge exposes asynchronously (≤~500ms) so
 * hydration retries briefly and re-arms on the next subscriber; the bridge
 * subscription is a PERMANENT ipcRenderer listener for the page's lifetime
 * (assumes one module instance per page).
 *
 * OPTIMISTIC SAVE (闪烁修复, 2026-12): applySettingsPatch overlays its patch
 * on the snapshot IMMEDIATELY (the control reflects the click in the same
 * frame — no disabled/dimmed flash while the IPC round-trip is in flight),
 * then settles on the authoritative result: the NEWEST save's success
 * replaces the snapshot, a FAILED patch is dropped from the overlay (the
 * control snaps back + the caller shows the error). In-flight patches are
 * merged in order, and a monotonic save sequence keeps an OLDER save's late
 * result from flashing an intermediate value over a newer overlay (rapid
 * successive toggles never flicker).
 */
import type { ChamberSettings, ChamberSettingsStatus, SettingsSurface } from '../ambient/settings-bridge.d.ts'
import { createBridgeHydration } from './bridge-hydration.ts'

// ---- optimistic save overlay ----
/** In-flight patches, merged IN ORDER over the authoritative snapshot. A
 *  patch is removed when its save FAILS (the main process never applied it);
 *  settled successes stay until the NEWEST save settles (its authoritative
 *  result contains every earlier applied patch — see saveSeq). */
let optimisticPatches: Array<{ seq: number; patch: Partial<ChamberSettings> }> = []
/** Cached merged snapshot: getSettingsStatus must return a STABLE reference
 *  between notifies (useSyncExternalStore compares getSnapshot results), so
 *  the merged object is rebuilt only when current or the patch list changes. */
let optimisticStatus: ChamberSettingsStatus | null = null
/** Monotonic save sequence: only the LATEST save's settle clears the overlay
 *  list and replaces the snapshot; an older save's result (already pushed by
 *  the main process) never flashes an intermediate value. */
let saveSeq = 0

/** Deep-merge a partial patch over a settings object (notifications and
 *  sessionTodo are nested blocks — a partial patch must never drop sibling
 *  keys). */
function mergeSettings(base: ChamberSettings, patch: Partial<ChamberSettings>): ChamberSettings {
  return {
    ...base,
    ...patch,
    notifications: patch.notifications !== undefined
      ? { ...base.notifications, ...patch.notifications }
      : base.notifications,
    sessionTodo: patch.sessionTodo !== undefined
      ? { ...base.sessionTodo, ...patch.sessionTodo }
      : base.sessionTodo,
  }
}

/** Rebuild the cached optimistic snapshot (no-op when no overlay is active).
 *  The authoritative `current` lives in the hydration singleton — the
 *  skeleton assigns it before invoking this through its onPush/onQuery
 *  acceptance hooks, so the fresh snapshot is always visible here. */
function recomputeOptimistic(): void {
  const current = hydration.snapshot()
  if (optimisticPatches.length === 0 || current === null) {
    optimisticStatus = null
    return
  }
  let merged = current.settings
  for (const entry of optimisticPatches) merged = mergeSettings(merged, entry.patch)
  optimisticStatus = { ...current, settings: merged }
}

/** Drop one in-flight patch (a failed save) and rebuild the overlay. */
function dropOptimistic(seq: number): void {
  optimisticPatches = optimisticPatches.filter(entry => entry.seq !== seq)
  recomputeOptimistic()
  hydration.notify()
}

const hydration = createBridgeHydration<ChamberSettingsStatus, SettingsSurface>({
  surface: () => (typeof window !== 'undefined' ? window.dshChamber?.settings ?? null : null),
  onChanged: (api, listener) => api.onChanged(listener),
  query: (api) => api.get(),
  // The authoritative value may arrive while an optimistic overlay is still
  // in flight (the main process pushes BEFORE the invoke reply) — rebuild
  // the merged snapshot so the overlay stays visible; runs on pushes AND on
  // the pre-push query result (an in-flight patch overlays the fresh
  // authoritative base), exactly like the twin file's two acceptance paths.
  onPush: () => recomputeOptimistic(),
  onQuery: () => recomputeOptimistic(),
  // Slow re-probe chain (bridge absent or a one-shot get() failure): while
  // subscribers wait, keep probing with a capped backoff instead of stranding
  // the section permanently disabled.
  slowReProbe: true,
})

// Start hydration as soon as the module loads (the bundle loads before the
// preload bridge resolves; the retry chain covers the gap).
hydration.hydrate()

/** Stable snapshot (null = bridge absent / not hydrated yet). PURE — no side effects. */
export function getSettingsStatus(): ChamberSettingsStatus | null {
  const current = hydration.snapshot()
  if (current === null) return null
  return optimisticPatches.length > 0 && optimisticStatus !== null ? optimisticStatus : current
}

export function subscribeSettings(listener: () => void): () => void {
  return hydration.subscribe(listener)
}

/**
 * Apply a settings patch (design 14 D7): OPTIMISTIC — the patch overlays the
 * snapshot immediately (controls reflect the click in the same frame; no
 * disabled/dimmed flash during the IPC round-trip), then the main process
 * validates, applies side effects (keep-awake / login autostart), persists,
 * and pushes. Loud {error} on failure — never a silent fake success; a failed
 * patch is dropped from the overlay (the control snaps back to the
 * authoritative value). Out-of-order results: only the LATEST save's settle
 * clears the overlay list and replaces the snapshot — a rapid second toggle
 * never flashes the first save's intermediate value.
 */
export async function applySettingsPatch(
  patch: Partial<ChamberSettings>,
): Promise<{ ok: true; status: ChamberSettingsStatus } | { ok: false; error: string; code?: string }> {
  const seq = ++saveSeq
  optimisticPatches = [...optimisticPatches, { seq, patch }]
  recomputeOptimistic()
  hydration.notify()
  const api = hydration.surface()
  if (api === null) {
    dropOptimistic(seq)
    return { ok: false, error: 'settings bridge unavailable' }
  }
  try {
    const result = await api.set(patch)
    if (seq !== saveSeq) {
      // An OLDER save settling: its authoritative value already landed via
      // the main-process push (the newest save's settle will replace the
      // snapshot) — keep the patch in the overlay, never flash an
      // intermediate value.
      return { ok: true, status: getSettingsStatus() as ChamberSettingsStatus }
    }
    // The NEWEST save settles: every earlier in-flight patch was applied by
    // the main process in order, so the result is final for all of them.
    optimisticPatches = []
    recomputeOptimistic()
    if ('error' in result) {
      hydration.notify()
      return { ok: false, error: result.error, code: result.code }
    }
    hydration.replace(result)
    return { ok: true, status: result }
  } catch (error) {
    dropOptimistic(seq)
    return { ok: false, error: String(error) }
  }
}
