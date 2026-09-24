/**
 * App-global update-state store for the settings「更新」section.
 *
 * Module-level singleton (the shell mounts per-ctx, but update state is app-global —
 * one desktop main process): hydrates from window.dshChamber.update (query + push),
 * keeps ONE subscription across all shell instances, and exposes a stable snapshot for
 * useSyncExternalStore. The singleton/hydration/subscription skeleton is
 * bridge-hydration.ts (the twin settings-store.ts runs the same).
 *
 * Store-specific: getUpdateState() is PURE — getSnapshot runs during render, so
 * hydration comes from subscribeUpdateState (commit phase) and module load only. No slow
 * re-probe chain: after the fast chain exhausts or a one-shot state() failure the store
 * stays quiet — its PERMANENT push listener keeps hydrating and the next subscriber
 * re-arms. A push always wins over a stale query snapshot. Discovery is single-source:
 * the flavor routes the「检查更新」invoke inside the shell and the page renders pushed
 * phases only; checkInFlight's module single-flight keeps N-ctx shells from a second edge.
 */
import type { UpdateState, UpdateSurface } from '../ambient/update-bridge.d.ts'
import { createBridgeHydration } from './bridge-hydration.ts'

/** Module-wide download in-flight guard (N-ctx shells share one download). */
let downloadInFlight = false

/** Module-wide check in-flight guard (N-ctx shells share one check).
 *
 * In the native flavor the inspect invoke is the frozen updateNativeAction
 * kind=check edge — the shell must see exactly ONE per click across every shell
 * instance. The guard covers the invoke round trip only; the phase push is the
 * visible authority for the outcome. */
let checkInFlight = false

/** Module-wide restart in-flight guard (N-ctx shells share one restart).
 *
 * Two-layer single-flight: this module gate covers the IPC round-trip only and is
 * deliberately NOT reset when the main process ACCEPTED the restart — acceptance
 * means quitAndInstall was armed and the app is on its way out, so a re-click in
 * that window must not fire a second invoke. The MAIN-process gate
 * (updater.restartAndInstall, also never reset on success) is the backstop for the
 * whole quit window, so this gate only prevents pointless duplicate invokes from
 * multiple shells. Failure/refusal paths reset here so the user can retry. */
let restartInFlight = false

const hydration = createBridgeHydration<UpdateState, UpdateSurface>({
  surface: () => (typeof window !== 'undefined' ? window.dshChamber?.update ?? null : null),
  onChanged: (api, listener) => api.onChanged(listener),
  query: (api) => api.state(),
  onPush: (state) => {
    // Restart recovery rule: the module restart single-flight mirrors main and is
    // deliberately NOT reset on an armed ok:true — but a push proving the restart
    // FAILED must release it, or every later click would be silently refused until an
    // app reload. Failure proof = the pushed state carries restartFailureText (main
    // keeps phase `downloaded`), or the phase left {downloaded, downloading} toward
    // 'error'/'up-to-date' (belt — normally unreachable while armed). A plain
    // downloaded push keeps the armed-forever-quit semantics (held until the quit).
    if (state.restartFailureText !== undefined
      || state.phase === 'error' || state.phase === 'up-to-date') {
      restartInFlight = false
    }
  },
  onQuery: () => {
    // No extra shaping: a query result that wins the push-wins race is the
    // authoritative snapshot as-is (the release rule above is push-only — only a
    // PUSH can prove a restart failed).
  },
  // 保持设计值 false：这里不靠慢探针兜底——Swift shim 已与 preload 同序（只有 info
  // 成功才暴露 dshChamber），「surface 存在但 query 恒 reject」的形态不会出现。慢探针
  // 本身的收敛性加固（成功才重置背退 + 无订阅者即停）供 settings-store 等消费面使用。
  slowReProbe: false,
})

hydration.hydrate()

/** Stable snapshot (null = bridge absent / not hydrated yet). PURE — no side effects. */
export function getUpdateState(): UpdateState | null {
  return hydration.snapshot()
}

export function subscribeUpdateState(listener: () => void): () => void {
  return hydration.subscribe(listener)
}

/** The「检查更新」button action: a user-initiated check (autoDownload stays off, a
 *  check never downloads). It never triggers the page's own discovery — the flavor
 *  routes it inside the shell; the result is rendered from the pushed phases. */
export async function requestUpdateCheck(): Promise<{ ok: true } | { ok: false; error: string }> {
  if (checkInFlight) return { ok: false, error: 'check already in progress' }
  checkInFlight = true
  try {
    const api = hydration.surface()
    if (api === null) return { ok: false, error: 'update bridge unavailable' }
    return await api.check()
  } catch (error) {
    return { ok: false, error: String(error) }
  } finally {
    checkInFlight = false
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
 * The「重启并安装」button action: restart the app into the completed update
 * (main-process quitAndInstall — quit + install + relaunch through the normal quit
 * path; transports and the local dsh instance are disposed during that quit).
 * {ok:true} means the restart was armed and the caller should treat it as terminal
 * (keep busy/disabled); only a refused or failed call releases the gate for retry.
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
