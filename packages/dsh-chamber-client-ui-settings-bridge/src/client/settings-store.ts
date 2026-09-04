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

let current: ChamberSettingsStatus | null = null
const listeners = new Set<() => void>()
/** True once the bridge onChanged/state subscription is attached (module-wide, once). */
let bridgeSubscribed = false
/** Unsubscribe handle of the attached onChanged listener, or null. */
let bridgeUnsubscribe: (() => void) | null = null
/** The active hydration retry timer, or null when no chain is running. */
let retryTimer: ReturnType<typeof setTimeout> | null = null
/** Backoff for bridge re-probing: fast 100ms while the bridge is expected
 * imminently, capped at 2s so a late bridge or a one-shot query failure can
 * never strand the section permanently disabled. */
let retryDelayMs = 100

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

/** Rebuild the cached optimistic snapshot (no-op when no overlay is active). */
function recomputeOptimistic(): void {
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
  notify()
}

function notify(): void {
  for (const listener of listeners) listener()
}

function bridgeSettings(): SettingsSurface | null {
  return typeof window !== 'undefined' ? window.dshChamber?.settings ?? null : null
}

/** Re-arm the bridge probe chain (once at a time): the bridge absent, or a
 * one-shot get() failure, both recover by re-attaching. While no subscriber
 * is present the slow chain stays quiet. */
function retryLater(): void {
  if (retryTimer !== null) return
  retryTimer = setTimeout(() => {
    retryTimer = null
    const api = bridgeSettings()
    if (api === null) {
      if (current === null && listeners.size > 0) retryLater()
      return
    }
    retryDelayMs = 100
    attachBridge(api)
  }, retryDelayMs)
  retryDelayMs = Math.min(retryDelayMs * 2, 2_000)
}

function attachBridge(api: SettingsSurface): void {
  if (bridgeSubscribed) return
  bridgeSubscribed = true
  bridgeUnsubscribe = api.onChanged((status) => {
    current = status
    // The authoritative value may arrive while an optimistic overlay is
    // still in flight (the main process pushes BEFORE the invoke reply) —
    // rebuild the merged snapshot so the overlay stays visible.
    recomputeOptimistic()
    notify()
  })
  void api.get()
    .then((status) => {
      // Push wins over a stale query snapshot: only apply the query result
      // when no push has landed yet.
      if (current === null) {
        current = status
        recomputeOptimistic()
        notify()
      }
    })
    .catch(() => {
      // A one-shot query failure must not leave the store unhydrated forever
      // (GeneralView/DshRuntimeSection would stay permanently disabled with
      // no error): release the latch, drop the listener, and re-arm the
      // retry chain.
      bridgeUnsubscribe?.()
      bridgeUnsubscribe = null
      bridgeSubscribed = false
      retryLater()
    })
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
        // The fast chain is exhausted: keep probing slowly so a late bridge
        // (or a bridge that appeared between the fast attempts) still
        // hydrates while subscribers are waiting.
        if (listeners.size > 0) retryLater()
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
  if (current === null) return null
  return optimisticPatches.length > 0 && optimisticStatus !== null ? optimisticStatus : current
}

export function subscribeSettings(listener: () => void): () => void {
  listeners.add(listener)
  if (current === null) hydrate()
  return () => {
    listeners.delete(listener)
  }
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
  notify()
  const api = bridgeSettings()
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
      notify()
      return { ok: false, error: result.error, code: result.code }
    }
    current = result
    notify()
    return { ok: true, status: result }
  } catch (error) {
    dropOptimistic(seq)
    return { ok: false, error: String(error) }
  }
}
