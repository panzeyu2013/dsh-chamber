/**
 * App-global chamber-settings store for the settings「通用」section.
 *
 * Module-level singleton (the shell mounts per-ctx, but settings are app-global — one
 * desktop main process): hydrates from window.dshChamber.settings (query + push), keeps
 * ONE subscription across all shell instances, and exposes a stable snapshot for
 * useSyncExternalStore. The skeleton is bridge-hydration.ts (the twin update-store.ts
 * runs the same), including the settings-only slow re-probe chain that keeps probing
 * while subscribers wait. getSettingsStatus() is PURE (getSnapshot runs during render);
 * a push wins over a stale query snapshot; the bridge exposes asynchronously so
 * hydration re-arms on the next subscriber.
 *
 * OPTIMISTIC SAVE: applySettingsPatch overlays its patch IMMEDIATELY (the control
 * reflects the click in the same frame — no disabled/dimmed flash during the IPC
 * round-trip), then settles on the authoritative result: the NEWEST save replaces the
 * snapshot, a FAILED patch is dropped from the overlay (control snaps back + caller
 * shows the error). In-flight patches merge in order, and a monotonic save sequence
 * keeps an OLDER save's late result from flashing an intermediate value over a newer
 * overlay.
 */
import type { ChamberSettings, ChamberSettingsStatus, SettingsSurface } from '../ambient/settings-bridge.d.ts'
import { createBridgeHydration } from './bridge-hydration.ts'

// ---- optimistic save overlay ----
/** In-flight patches, merged IN ORDER over the authoritative snapshot. A patch is
 *  removed when its save FAILS; settled successes stay until the NEWEST save
 *  settles (its result contains every earlier applied patch — see saveSeq). */
let optimisticPatches: Array<{ seq: number; patch: Partial<ChamberSettings> }> = []
/** Cached merged snapshot: getSettingsStatus must return a STABLE reference between
 *  notifies (useSyncExternalStore compares results), so it rebuilds only on change. */
let optimisticStatus: ChamberSettingsStatus | null = null
/** Monotonic save sequence: only the LATEST save's settle clears the overlay list
 *  and replaces the snapshot; an older save's result never flashes an intermediate value. */
let saveSeq = 0

/** Deep-merge a partial patch over a settings object (notifications, sessionTodo and
 *  debug are nested blocks — a partial patch must never drop sibling keys). */
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
    debug: patch.debug !== undefined ? { ...base.debug, ...patch.debug } : base.debug,
  }
}

/** Rebuild the cached optimistic snapshot (no-op when no overlay is active). The
 *  authoritative `current` lives in the hydration singleton and is assigned before
 *  this runs through its onPush/onQuery hooks. */
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
  // The authoritative value may arrive while an optimistic overlay is in flight (the
  // main process pushes BEFORE the invoke reply) — rebuild the merged snapshot so the
  // overlay stays visible; runs on pushes AND on the pre-push query result, exactly
  // like the twin file's two acceptance paths.
  onPush: () => recomputeOptimistic(),
  onQuery: () => recomputeOptimistic(),
  // Slow re-probe chain (bridge absent or a one-shot get() failure): while subscribers
  // wait, keep probing with a capped backoff instead of stranding the section disabled.
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
 * Apply a settings patch: OPTIMISTIC — the patch overlays the snapshot immediately
 * (controls reflect the click in the same frame; no disabled/dimmed flash during the
 * IPC round-trip), then the main process validates, applies side effects (keep-awake /
 * login autostart), persists and pushes. Loud {error} on failure — never a silent fake
 * success; a failed patch is dropped from the overlay (the control snaps back), and
 * ONLY that patch: an older in-flight save may already have succeeded, so clearing the
 * whole list on a newer failure would strand the UI on a value the host has changed.
 * Only the LATEST save's SUCCESS clears the overlay list and replaces the snapshot.
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
    if ('error' in result) {
      // 失败：无论新旧，只丢**这一条** overlay。旧写法在「最新一次失败」时清空全表，
      // 会连更早那条**已经成功**的在飞补丁一起清掉——它的结果不会再回写，外部 push
      // 丢失时 UI 就停在已被宿主改掉的旧值上。失败也绝不假装成功。
      dropOptimistic(seq)
      return { ok: false, error: result.error, code: result.code }
    }
    if (seq !== saveSeq) {
      // An OLDER save settling successfully: its authoritative value already landed via the push
      // (the newest save's settle replaces the snapshot) — keep the patch, no flash.
      return { ok: true, status: getSettingsStatus() as ChamberSettingsStatus }
    }
    // The NEWEST save settles successfully: every earlier in-flight patch was applied in
    // order, so the result is final — clear the overlay list and take the authoritative value.
    optimisticPatches = []
    recomputeOptimistic()
    hydration.replace(result)
    return { ok: true, status: result }
  } catch (error) {
    dropOptimistic(seq)
    return { ok: false, error: String(error) }
  }
}
