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

/** 已接受的重启最长「武装」时间：超过它仍未退出 ⇒ 安装没有真正开始（全屏未退、退出被取消、
 *  Sparkle 静默失败……），必须释放门与 busy，让用户能重试。没有它时 {ok:true} 会把
 *  restartInFlight 与组件 busy 双双钉死，用户既不能重试也消不掉提示。 */
export const RESTART_ARM_TIMEOUT_MS = 60_000

/** 单次确认 invoke 的等待上限：宿主不回答时不能把模块门与组件 busy 一起挂住。 */
export const UPDATE_INVOKE_TIMEOUT_MS = 15_000

const armExpiryListeners = new Set<() => void>()

/** 「重启武装超时」订阅（组件用它清 busy 并把拒绝换成超时文案）。 */
export function subscribeUpdateArmExpiry(listener: () => void): () => void {
  armExpiryListeners.add(listener)
  return () => { armExpiryListeners.delete(listener) }
}

let restartArmTimer: ReturnType<typeof setTimeout> | null = null

function clearRestartArmTimer(): void {
  if (restartArmTimer !== null) { clearTimeout(restartArmTimer); restartArmTimer = null }
}

/** 武装超时：释放模块门并通知组件；只在「仍存活」时触发（真退出就无从执行了）。 */
function armRestartExpiry(): void {
  clearRestartArmTimer()
  restartArmTimer = setTimeout(() => {
    restartArmTimer = null
    // Sparkle 已进入 installing（正在替换 bundle）：此时放开会让用户重试并触发第二次安装。
    // 继续武装，等下一轮；真正的失败仍由推送（restartFailureText / phase 离开）释放。
    if (hydration.snapshot()?.phase === 'installing') { armRestartExpiry(); return }
    restartInFlight = false
    for (const listener of armExpiryListeners) {
      try { listener() } catch { /* listener boundary */ }
    }
  }, RESTART_ARM_TIMEOUT_MS)
  restartArmTimer.unref?.()
}

/** 与确认 invoke 的竞速上限：返回 null = 超时。 */
function withInvokeTimeout<T>(promise: Promise<T>): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(null), UPDATE_INVOKE_TIMEOUT_MS)
    timer.unref?.()
    promise.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) },
    )
  })
}

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
      clearRestartArmTimer()
    }
    // Download-stall recovery: main's watchdog releases its own single-flight and accepts a
    // retry at the CURRENT revision, but this module gate otherwise clears only in the pending
    // call's finally — without this release the「更新」retry can never reach the bridge and the
    // page shows the misleading state-changed refusal. download-network is the failure kind the
    // watchdog publishes for a stalled download.
    if (state.failureKind === 'download-network') downloadInFlight = false
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

/** The「更新」button action: user-confirmed download (autoDownload stays off).
 *  `revision` = the snapshot revision this answer was rendered from; the main process
 *  refuses a stale answer (design 11 §4) instead of downloading a newer unconfirmed target. */
export async function requestUpdateDownload(revision: number): Promise<{ ok: true } | { ok: false; error: string }> {
  if (downloadInFlight) return { ok: false, error: 'download already in progress' }
  downloadInFlight = true
  try {
    const api = hydration.surface()
    if (api === null) return { ok: false, error: 'update bridge unavailable' }
    const result = await withInvokeTimeout(api.download(revision))
    if (result === null) return { ok: false, error: 'update request timed out: the shell did not answer' }
    return result
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
 * `revision` = the snapshot revision this answer was rendered from (same stale-answer
 * guard as requestUpdateDownload).
 */
export async function requestUpdateRestart(revision: number): Promise<{ ok: true } | { ok: false; error: string }> {
  if (restartInFlight) return { ok: false, error: 'restart already in progress' }
  restartInFlight = true
  try {
    const api = hydration.surface()
    if (api === null) {
      restartInFlight = false
      return { ok: false, error: 'update bridge unavailable' }
    }
    const result = await withInvokeTimeout(api.restartAndInstall(revision))
    if (result === null) {
      restartInFlight = false
      return { ok: false, error: 'restart request timed out: the shell did not answer' }
    }
    if (!result.ok) restartInFlight = false
    // {ok:true} = armed. Keep the gate for the quit window, but not forever: an arm whose
    // app never exits must release the gate and the row so the user can retry.
    else armRestartExpiry()
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
