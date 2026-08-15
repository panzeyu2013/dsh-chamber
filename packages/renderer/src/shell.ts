/**
 * N-ctx shell orchestration (design 05 §1/§3.6): one AppWebEntry per dsh
 * instance, each an independent cordis ctx with a full ui-* tree, mounted
 * into its own container div. Boots are strictly sequential (the connection
 * client resolves its per-instance base path from `window.__DSH_BASE_PATH__`
 * at carrier construction, so the knob must not change while a boot is
 * in flight); instance shells stay mounted once booted (hide/show switching
 * is pure CSS, sessions stay alive).
 *
 * The module table and bundle registry are page-level singletons shared
 * across instances (boot.tsx reuse seam — the module system refuses a second
 * `__ModuleLoader__` install); materialized exports are stateless plugin
 * definitions applied per-ctx, so sharing is safe.
 *
 * Bundle loading uses module-script elements (the chamber bundle is an ESM
 * chunk of the vite build — see vite.config.mjs) instead of the stock
 * classic-script loader.
 */



import { AppWebEntry } from '@deepseek-ai/dsh-client-web'

import { getChamberInstanceId, setChamberInstanceId } from './chamber-knob.ts'

const CHAMBER_BOOT = '@dsh-chamber/app'

/** How long a session open waits for the runtime list before failing loud. */
const OPEN_WAIT_MS = 8000
const OPEN_RETRY_MS = 400

/**
 * How long one boot may hold the serialized queue before the chain moves on.
 * A vendor `entry.run()` that never settles (a hung fetch/loader) must not
 * wedge every other instance's boot for the rest of the session: the queue
 * slot times out, later boots proceed, and the late-settling boot still
 * registers its view normally (session continuity) — its knob cleanup is
 * guarded to never clobber a later boot's knob.
 */
const BOOT_TIMEOUT_MS = 60_000

/** Same-origin module-script loader (ESM chunks; the stock loader uses classic scripts). */
function loadModuleBundle(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script')
    el.type = 'module'
    el.src = url
    el.addEventListener('load', () => {
      el.remove()
      resolve()
    }, { once: true })
    el.addEventListener('error', () => {
      el.remove()
      reject(new Error(`dsh-chamber: bundle script ${url} failed to load`))
    }, { once: true })
    document.head.append(el)
  })
}

/** Per-instance shell lifecycle. */
export interface ShellState {
  instanceId: string
  basePath: string
  /** Boot settled (UI up or failure report shown — AppWebEntry resolves either way). */
  booted: boolean
  /** Boot is in flight (queued behind earlier instances). */
  booting: boolean
  /** Boot rejection (missing/malformed boot manifest only; failures resolve in-page). */
  error: string | null
}

/** One serialized boot queue shared by every instance (window knob discipline). */
let bootChain: Promise<void> = Promise.resolve()

/**
 * Boot cancellation (design 05 §4: view lifetime = registry entry lifetime):
 * `bootGenerations` hands each bootInstanceShell call the next generation of
 * its instance; `disposeInstanceShell` (registry removal) records, per
 * instance, the highest generation pending at that moment. A boot whose
 * generation is at or below the recorded threshold is torn down on settle
 * instead of being registered — a reaped instance must never leave a zombie
 * ctx behind. Per-boot generations (not a single per-id flag) keep the
 * cancellation exact: remove → re-add → remove inside one boot window must
 * cancel BOTH pending boots, while a boot created after the last removal
 * (a fresh generation) registers normally. Boots are dispatched by mount
 * effects, which run before the parent reclamation effect that calls
 * dispose — a same-commit reap always sees the pending boot's generation.
 */
const bootGenerations = new Map<string, number>()
const cancelledBoots = new Map<string, number>()

/** The live AppWebEntry handle per booted instance (unmount on window teardown). */
const entries = new Map<string, { entry: AppWebEntry; dispose(): void }>()

/** Session opens requested before the instance shell booted (flushed on settle). */
const pendingOpens = new Map<string, string[]>()

export function shellStateIdle(instanceId: string, basePath: string): ShellState {
  return { instanceId, basePath, booted: false, booting: false, error: null }
}

/**
 * Boot (or queue) the instance shell into `el`. Returns the settled state.
 * One boot at a time: `window.__DSH_BASE_PATH__` is set for the duration of
 * this boot only, then removed.
 */
export function bootInstanceShell(
  instanceId: string,
  basePath: string,
  el: HTMLElement,
  onState: (next: ShellState) => void,
): Promise<ShellState> {
  // 取序必须在入队前：dispose 记录的阈值与 settle 检查都按本次 boot 的代。
  const gen = (bootGenerations.get(instanceId) ?? 0) + 1
  bootGenerations.set(instanceId, gen)
  const before: ShellState = { instanceId, basePath, booted: false, booting: true, error: null }
  onState(before)
  const task = bootChain.then(async () => {
    const win = window as Window & { __DSH_BASE_PATH__?: string }
    let staleEntry: AppWebEntry | undefined
    try {
      // 旋钮设置纳入 try：任何一步抛错都必须落成终态错误 settle（视图不
      // 悬挂、预热链推进、opens 响亮拒绝），且 finally 保证旋钮清除——
      // 若在 try 之外抛出，任务 promise 拒绝且永无 settle，视图骨架屏与
      // 预热队列会卡死，残留旋钮还会污染后续 boot。
      win.__DSH_BASE_PATH__ = basePath
      // The sidebar plugin reads the knob while this boot materializes (05 §4).
      setChamberInstanceId(instanceId)
      const entry = new AppWebEntry(el, { loadBundle: loadModuleBundle })
      staleEntry = entry
      await entry.run()
      if ((cancelledBoots.get(instanceId) ?? 0) >= gen) {
        // The shell was reaped while this boot was queued/in flight: tear the
        // fresh entry down instead of registering it (no zombie ctx; the
        // container is already on its way out with the InstanceView unmount).
        entry.dispose()
        // dispose 时已拒绝当时排队的 opens；dispose 之后、本 settle 之前新入
        // 队的 opens（侧边栏陈旧 UI 在轮询周期内仍可请求）此刻已永无 dispatch
        // 机会——同样走响亮丢弃路径，避免静默丢失 + pendingOpens 死键累积。
        rejectPendingOpens(instanceId, 'shell disposed (instance left ready)')
        return { instanceId, basePath, booted: false, booting: false, error: 'shell disposed (instance left ready)' } satisfies ShellState
      }
      entries.set(instanceId, { entry, dispose: () => entry.dispose() })
      // 注册成功即清掉本实例的旧阈值：boot 队列 FIFO，所有代 <= 阈值的 boot
      // 都已先于本次 settle 处理完毕，此后任何新代 boot 天然大于阈值——残留
      // 阈值只会随注册表增删周期无限累积（清理无正确性负担，仅收敛 Map）。
      cancelledBoots.delete(instanceId)
      flushPendingOpens(instanceId)
      return { instanceId, basePath, booted: true, booting: false, error: null } satisfies ShellState
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason)
      // 若 run() 在 createRoot 之后才拒绝（如 AppRoot 渲染异常），容器上会
      // 残留未卸载的 React root——先 dispose，重试才能在同一容器重新 createRoot。
      staleEntry?.dispose()
      // 失败的 boot 从不注册，无需（也不应）消费取消阈值：阈值只按代匹配
      // 本次 pending 的 boot，重加实例后的新代 boot 天然不受影响。
      rejectPendingOpens(instanceId, message)
      return { instanceId, basePath, booted: false, booting: false, error: message } satisfies ShellState
    } finally {
      // 迟到 settle 的旋钮清理必须按值守卫：boot 超时后队列已放行，后续
      // boot 已覆盖窗口旋钮——只删「仍是自己设置的值」，绝不误删他人。
      if (win.__DSH_BASE_PATH__ === basePath) delete win.__DSH_BASE_PATH__
      if (getChamberInstanceId() === instanceId) setChamberInstanceId(undefined)
    }
  })
  // 链推进用超时护栏：一个永不 settle 的 boot 在 BOOT_TIMEOUT_MS 后放行后续
  // boot（task 本身仍由调用者 await——迟到 settle 正常注册视图，会话保活）。
  bootChain = withBootTimeout(task).then(() => undefined, () => undefined)
  return task
}

/**
 * Resolve once the wrapped boot settles OR the timeout elapses — the serialized
 * queue must never be wedged by a boot that never settles. The wrapped promise
 * only drives the CHAIN; callers still await the original task (a late settle
 * registers its view normally).
 */
function withBootTimeout(promise: Promise<ShellState>): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      console.error(`[shell] boot timed out after ${BOOT_TIMEOUT_MS}ms — queue continues (late settle still registers)`)
      resolve()
    }, BOOT_TIMEOUT_MS)
    promise.then(
      () => { clearTimeout(timer); resolve() },
      () => { clearTimeout(timer); resolve() },
    )
  })
}

/**
 * Request opening one session on an instance: dispatch immediately when the
 * shell already booted, else queue for the boot-settle flush. Resolves once
 * the runtime accepted the open (the session id must be visible in the
 * instance's own session list — the sidebar fetch and the runtime list can
 * race right after boot, so the dispatch polls the list store briefly).
 */
export function openInstanceSession(instanceId: string, sessionId: string): Promise<void> {
  const holder = entries.get(instanceId)
  if (holder !== undefined) return dispatchOpen(holder.entry, sessionId)
  const queued = pendingOpens.get(instanceId) ?? []
  queued.push(sessionId)
  pendingOpens.set(instanceId, queued)
  return Promise.resolve()
}

/** Boot settled: dispatch every queued open for this instance. */
function flushPendingOpens(instanceId: string): void {
  const queued = pendingOpens.get(instanceId)
  if (queued === undefined || queued.length === 0) return
  pendingOpens.delete(instanceId)
  const holder = entries.get(instanceId)
  if (holder === undefined) return
  for (const sessionId of queued) {
    // 成功路径也要响亮：分发可能超时/运行时拒绝，静默吞掉等于无声丢请求
    // （与 rejectPendingOpens 的响亮丢弃一致）。
    void dispatchOpen(holder.entry, sessionId).catch((error) => {
      console.error(`[shell] instance ${instanceId} queued session open (${sessionId}) failed after settle:`, error)
    })
  }
}

/** Boot failed: the queued opens can never dispatch — drop them loud. */
function rejectPendingOpens(instanceId: string, message: string): void {
  const queued = pendingOpens.get(instanceId)
  if (queued === undefined || queued.length === 0) return
  pendingOpens.delete(instanceId)
  console.error(`[shell] instance ${instanceId} failed to boot; ${queued.length} queued session open(s) dropped: ${message}`)
}

/**
 * Dispatch one open through the settled runtime context (ctx.sessions — the
 * ISessions face of dsh-client-runtime, see boot.tsx runtimeCtx). The runtime
 * validates the id against its own list, so wait until the session surfaces
 * there before calling open.
 */
function dispatchOpen(entry: AppWebEntry, sessionId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const sessions = entry.runtimeCtx?.sessions
    if (sessions === undefined) {
      reject(new Error('实例会话服务不可用（boot 未完全就绪）'))
      return
    }
    const deadline = Date.now() + OPEN_WAIT_MS
    const attempt = (): void => {
      let listed = false
      try {
        listed = sessions.list?.getSnapshot()?.byId?.[sessionId] !== undefined
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)))
        return
      }
      if (listed) {
        try {
          sessions.open(sessionId)
          resolve()
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)))
        }
        return
      }
      if (Date.now() >= deadline) {
        reject(new Error(`会话 ${sessionId} 未出现在实例会话列表中（等待超时）`))
        return
      }
      setTimeout(attempt, OPEN_RETRY_MS)
    }
    attempt()
  })
}

/**
 * Tear down ONE instance's shell (design 05 §4: view lifetime = registry
 * entry lifetime — the source was REMOVED from the registry): dispose the
 * AppWebEntry, drop the entry and any pending opens (they can never
 * dispatch). A boot queued or in flight for the instance is cancelled on
 * settle (cancelledBoots). The container div is React's to remove
 * (InstanceView unmounts after the reap). Connection state never reaps a
 * shell — disconnected/errored sources keep their view (the settings page
 * and the sidebar both anchor the registry, the shell must not diverge).
 */
export function disposeInstanceShell(instanceId: string): void {
  const holder = entries.get(instanceId)
  if (holder !== undefined) {
    entries.delete(instanceId)
    try {
      holder.dispose()
    } catch (error) {
      console.error(`[shell] dispose of instance ${instanceId} threw:`, error)
    }
  } else {
    // No live entry: cancel every boot queued or in flight for the instance —
    // none of them may register afterwards (generation threshold, see above).
    cancelledBoots.set(instanceId, bootGenerations.get(instanceId) ?? 0)
  }
  rejectPendingOpens(instanceId, 'shell disposed (instance left ready)')
}

/**
 * Tear down every mounted shell (window unload / ErrorBoundary crash screen).
 * In-flight or queued boots must also be cancelled (generation threshold):
 * a boot that settles after this call would re-register its entry and either
 * overwrite a retry re-boot's fresh entry (leaking its ctx) or double-root the
 * same container — the 05 §4 no-zombie invariant. Fresh boots started after
 * this call carry higher generations, so the thresholds never touch them.
 */
export function disposeAllShells(): void {
  for (const [instanceId, holder] of entries) {
    try {
      holder.dispose()
    } catch (error) {
      console.error(`[shell] dispose of instance ${instanceId} threw:`, error)
    }
  }
  entries.clear()
  for (const [instanceId, gen] of bootGenerations) {
    cancelledBoots.set(instanceId, gen)
  }
}

/** The boot-graph row id this page's manifest must carry (gen-boot-manifest.mjs). */
export const BOOT_PLUGIN_ID = CHAMBER_BOOT
