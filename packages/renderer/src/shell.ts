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
 * across instances (boot.ts reuse seam — the module system refuses a second
 * `__ModuleLoader__` install); materialized exports are stateless plugin
 * definitions applied per-ctx, so sharing is safe.
 *
 * Bundle loading uses module-script elements (the chamber bundle is an ESM
 * chunk of the vite build — see vite.config.mjs) instead of the stock
 * classic-script loader.
 */



import { AppWebEntry, ensureWebModuleSystem } from '@deepseek-ai/dsh-client-web'

import { getChamberInstanceId, setChamberInstanceId } from './chamber-knob.ts'
import { collectExtraRows, type ExtraModuleRow } from './host-graph.ts'
import { chamberBridge } from '@dsh-chamber/dsh-client-ui-sidebar/shared'
import { PendingOpenQueue } from './pending-open-queue.ts'

/** How long a session open waits for the runtime list before failing loud. */
const OPEN_WAIT_MS = 8000
const OPEN_RETRY_MS = 400

/**
 * How long one boot may hold the serialized queue before it is CANCELLED
 * (2026 audit H1). A vendor `entry.run()` that never settles (a hung
 * fetch/loader) must not wedge every other instance's boot for the rest of
 * the session: the budget expires, the boot is cancelled — the constructed
 * entry is disposed, queued opens are rejected, and the caller AND the
 * serialized chain settle within budget. A boot that late-settles after its
 * cancellation observes the monotonic cancellation threshold and tears the
 * entry down instead of registering (no zombie ctx); its knob cleanup is
 * value- and generation-guarded so it never clobbers a later boot's knob.
 */
const BOOT_TIMEOUT_MS = 60_000
const QUEUED_OPEN_TIMEOUT_MS = BOOT_TIMEOUT_MS + OPEN_WAIT_MS

/** The per-boot budget (test-overridable: node tests cannot wait 60s). */
let bootTimeoutMs = BOOT_TIMEOUT_MS

/** Test-only: override the per-boot budget. */
export function __testSetBootTimeoutMs(ms: number): void {
  bootTimeoutMs = ms
}

/** Same-origin module-script loader (ESM chunks; the stock loader uses classic scripts). */
function loadModuleBundle(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script')
    el.type = 'module'
    el.src = url
    let done = false
    let timer: ReturnType<typeof setTimeout> | undefined
    // One finish path (load / error / timeout) wins; the loser is a no-op.
    const finish = (action: () => void): void => {
      if (done) return
      done = true
      if (timer !== undefined) clearTimeout(timer)
      el.remove()
      action()
    }
    // A hung bundle (server stalls, never fires load/error) must not keep this
    // instance's boot pending forever — fail loud at the same order of
    // magnitude as the graph fetch (host-graph.ts GRAPH_TIMEOUT_MS); the
    // rejection runs through the same fail-loud boot path as a load error.
    // Known boundary: el.remove() does not cancel the in-flight module fetch —
    // a bundle delivered after the timeout still executes and registers its
    // factory; a later retry boot that re-preloads the same URL would then hit
    // the duplicate-registration sink and fail loud. Low probability (stall +
    // late delivery + manual retry), loud either way; documented, not fixed.
    timer = setTimeout(() => {
      finish(() => reject(new Error(`dsh-chamber: bundle script ${url} timed out after ${BUNDLE_LOAD_TIMEOUT_MS}ms`)))
    }, BUNDLE_LOAD_TIMEOUT_MS)
    el.addEventListener('load', () => finish(resolve), { once: true })
    el.addEventListener('error', () => {
      finish(() => reject(new Error(`dsh-chamber: bundle script ${url} failed to load`)))
    }, { once: true })
    document.head.append(el)
  })
}

/** How long one extra-bundle script load may take before it fails loud (parallel to GRAPH_TIMEOUT_MS). */
const BUNDLE_LOAD_TIMEOUT_MS = 30_000

/** Per-instance shell lifecycle. */
export interface ShellState {
  instanceId: string
  basePath: string
  /** Boot settled (UI up or failure report shown — AppWebEntry resolves either way). */
  booted: boolean
  /** Boot is in flight (queued behind earlier instances). */
  booting: boolean
  /**
   * Boot failure report: run() rejection (missing/malformed boot manifest, …),
   * or a resolved-but-failed boot surfaced via AppWebEntry.bootError (05 §4
   * failure-presentation revision) — null on a clean settle.
   */
  error: string | null
  /** 2026 audit M6: the host boot-graph CHANNEL failed (graph-unreachable /
   *  not-injected) — the boot succeeded but this instance's profile plugins
   *  were not loaded. The UI shows a warning instead of a silent "no plugins". */
  pluginDegraded: boolean
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

/**
 * Serialized async dispose (2026 audit M1): AppWebEntry.dispose() is ASYNC
 * (boot.ts: `await ctx.fiber.dispose()` tears down connection streams,
 * sessions and the shared sidebar producers). The teardown promise is
 * recorded per instance so a re-add's fresh boot AWAITS it before
 * constructing a new ctx — no same-id ctx overlap, and an old teardown can
 * never clear a new shell's shared state.
 */
const pendingDisposes = new Map<string, Promise<void>>()
function disposeEntry(instanceId: string, entry: AppWebEntry): void {
  const promise = Promise.resolve().then(() => entry.dispose())
  promise.catch(error => console.error(`[shell] dispose of instance ${instanceId} threw:`, error))
  pendingDisposes.set(instanceId, promise)
  void promise.finally(() => {
    if (pendingDisposes.get(instanceId) === promise) pendingDisposes.delete(instanceId)
  })
}

/** Session opens requested before boot; their original promises settle on dispatch. */
const pendingOpens = new PendingOpenQueue(QUEUED_OPEN_TIMEOUT_MS)

export function shellStateIdle(instanceId: string, basePath: string): ShellState {
  return { instanceId, basePath, booted: false, booting: false, error: null, pluginDegraded: false }
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
  const before: ShellState = { instanceId, basePath, booted: false, booting: true, error: null, pluginDegraded: false }
  onState(before)
  // 首启竞态修复（2026-08，05 §4）：任何 bundle 脚本执行前必须装好页面级
  // 模块表（window.__DSH_MODULES__ + __ModuleLoader__ 注册 sink）——额外
  // bundle 的脚本在加载时即执行并自注册 factory，sink 不存在则官方 bundle
  // 的无守卫顶层交接直接抛错、factory 永未注册，boot 以难懂的 "cannot
  // resolve" 失败（旧顺序：collectExtraRows 预加载 → run() 才装表，首个带
  // 额外行的 boot 必踩）。ensureWebModuleSystem 幂等（首次装、其后复用），
  // run() 也经同一 helper 收编，绝不重复注册 statics。manifest 缺失/畸形时
  // 此处即抛——跳过额外预加载（无 sink 不执行任何 bundle），boot 照常在
  // run() 以同一错误响亮失败（失败覆盖层 + 重试）。
  let moduleSystemError: string | null = null
  try {
    ensureWebModuleSystem({ loadBundle: loadModuleBundle })
  } catch (reason) {
    moduleSystemError = reason instanceof Error ? reason.message : String(reason)
  }
  // 提前启动宿主启动图 fetch（LCP/perf pass，design 09 module C）：collectExtraRows
  // 只读 basePath 参数、完全不碰 __DSH_BASE_PATH__ 旋钮（见下注释），所以可以在
  // 排进串行链之前就开始——与排在前面的 boot（前一实例的 AppWebEntry.run()，最坏
  // 占满 BOOT_TIMEOUT_MS）以及 App 自身的启动工作重叠，而不是在拿到链槽后才发起
  // 网络往返。任务体仍在构造 entry 之前 await 它（extraRows-before-create 顺序不变：
  // factory 必须在 loader.create 物化 entries 之前注册进共享模块表）。排队的等待期
  // 内若提前失败（extra bundle 加载失败），先挂一个 no-op catch 防止 unhandledrejection
  // 冒泡——任务体 await 同一 promise 并照旧走 fail-loud 路径。
  // Declared BEFORE the reportDiagnostic closure below (2026 review): the
  // closure references it, and a future synchronous call path must not hit a
  // TDZ ReferenceError.
  let pluginDegraded = false
  const extraRowsPromise = moduleSystemError === null
    ? collectExtraRows(instanceId, basePath, {
        loadModuleBundle,
        // A retry starts its graph request before the previous queued boot has
        // necessarily settled. Only the current, non-cancelled generation may
        // publish: otherwise an old slow failure can overwrite a newer ok.
        reportDiagnostic: (sourceId, diagnostic) => {
          if (bootGenerations.get(instanceId) !== gen) return
          if ((cancelledBoots.get(instanceId) ?? 0) >= gen) return
          // 2026 audit M6: channel failures degrade to "no extra plugins" —
          // surface that on the settled state instead of a silent success.
          if (diagnostic.state === 'graph-unreachable' || diagnostic.state === 'not-injected') pluginDegraded = true
          else if (diagnostic.state === 'ok') pluginDegraded = false
          chamberBridge.reportPluginDiagnostic(sourceId, diagnostic)
        },
      })
    : Promise.resolve<ExtraModuleRow[]>([])
  void extraRowsPromise.catch(() => undefined)
  // 任务体与预算竞速共享的 entry 句柄：超时分支需要立即 dispose 已构造的
  // entry（H1），而任务体在迟到 settle 时也用它走取消检查。
  let staleEntry: AppWebEntry | undefined
  const task = bootChain.then(async () => {
    const win = window as Window & { __DSH_BASE_PATH__?: string }
    try {
      // M1（2026 audit）：同 ID 旧 ctx 的异步 teardown 必须完成，新 boot
      // 才能构造新 entry——否则新旧 ctx 重叠，旧 teardown 会清掉新 ctx
      // 依赖的共享 sidebar 状态。
      const pendingDispose = pendingDisposes.get(instanceId)
      if (pendingDispose !== undefined) {
        try {
          await pendingDispose
        } catch { /* already logged by disposeEntry */ }
        if (pendingDisposes.get(instanceId) === pendingDispose) pendingDisposes.delete(instanceId)
      }
      // Host boot-graph merge (design 09, module C): the composite covers the
      // whole official shell; client plugins installed into the instance's
      // profile arrive as rows the composite does not cover. Preloading their
      // bundles completes BEFORE entry creation so every factory is registered
      // in the shared module table when loader.create materializes entries
      // (boot.ts runPluginBoot — the factories branch).
      const extraRows = await extraRowsPromise
      // 预算已到期（超时分支已取消本 boot、拒绝 opens）：迟到 continuation
      // 不得再设旋钮或构造 entry，直接退场——绝不与后续 boot 并发覆盖
      // 窗口旋钮（H1）。
      if ((cancelledBoots.get(instanceId) ?? 0) >= gen) {
        return { instanceId, basePath, booted: false, booting: false, error: 'boot timed out', pluginDegraded } satisfies ShellState
      }
      // 旋钮设置纳入 try（任何一步抛错都必须落成终态错误 settle，且 finally
      // 保证旋钮清除——若在 try 之外抛出，任务 promise 拒绝且永无 settle，
      // 视图骨架屏与预热队列会卡死），并放在 collectExtraRows 之后：图 fetch
      // 与 bundle 预加载完全不读旋钮（basePath 是参数），放后面收窄旋钮窗口。
      win.__DSH_BASE_PATH__ = basePath
      // The sidebar plugin reads the knob while this boot materializes (05 §4).
      setChamberInstanceId(instanceId)
      const entry = new AppWebEntry(el, { loadBundle: loadModuleBundle, extraRows })
      staleEntry = entry
      await entry.run()
      if ((cancelledBoots.get(instanceId) ?? 0) >= gen) {
        // The shell was reaped — or the boot budget expired (H1) — while this
        // boot was queued/in flight: tear the fresh entry down instead of
        // registering it (no zombie ctx; the container is already on its way
        // out with the InstanceView unmount).
        disposeEntry(instanceId, entry)
        // dispose 时已拒绝当时排队的 opens；dispose 之后、本 settle 之前新入
        // 队的 opens（侧边栏陈旧 UI 在轮询周期内仍可请求）此刻已永无 dispatch
        // 机会——同样走响亮丢弃路径，避免静默丢失 + pendingOpens 死键累积。
        rejectPendingOpens(instanceId, 'shell disposed (instance left ready)')
        return { instanceId, basePath, booted: false, booting: false, error: 'shell disposed (instance left ready)', pluginDegraded } satisfies ShellState
      }
      // chamber (2026-08 failure-presentation revision, 05 §4): run() RESOLVES
      // on boot-chain failures by design (the dsh loading page renders the
      // in-shell report — fail loud, never a silent partial UI), but the
      // chamber must see the failure to show its own per-instance fallback
      // (retry + server switching) instead of a dead-end report trapping the
      // active view. Treat a resolved-but-failed boot as a failure here: the
      // failed entry is disposed (unmounts the in-shell report root, so a
      // retry re-boots the container cleanly) and the error is projected like
      // a run() rejection.
      const bootFailure = entry.bootError
      if (bootFailure !== undefined) {
        disposeEntry(instanceId, entry)
        rejectPendingOpens(instanceId, bootFailure)
        return { instanceId, basePath, booted: false, booting: false, error: bootFailure, pluginDegraded } satisfies ShellState
      }
      entries.set(instanceId, { entry, dispose: () => disposeEntry(instanceId, entry) })
      // 取消阈值是**单调**的（永不删除，与 bootGenerations 同范式）：注册
      // 成功清阈值依赖「队列 FIFO、旧代必已 settle」——但 H1 超时打破该
      // 假设：被超时的旧 boot 任务体仍在运行、可迟到 settle，其取消检查
      // （258 行）依赖本阈值；删掉它会让迟到 settle 误注册、覆盖本 entry
      // （僵尸 ctx，2026 最终 review HIGH）。阈值仅随增删/超时周期增长，
      // 与 bootGenerations 同量级，无收敛负担。
      flushPendingOpens(instanceId)
      return { instanceId, basePath, booted: true, booting: false, error: null, pluginDegraded } satisfies ShellState
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason)
      // run() 不再拒绝（rc.8 形状：一切失败经 bootError 上浮），catch 兜底
      // 构造期/挂载期的同步异常——若 entry 已在容器上画过加载页或挂载过 UI，
      // 先 dispose（移除 boot DOM / 卸载 React root），重试才能干净重 boot。
      if (staleEntry !== undefined) disposeEntry(instanceId, staleEntry)
      // 失败的 boot 从不注册，无需（也不应）消费取消阈值：阈值只按代匹配
      // 本次 pending 的 boot，重加实例后的新代 boot 天然不受影响。
      rejectPendingOpens(instanceId, message)
      return { instanceId, basePath, booted: false, booting: false, error: message, pluginDegraded } satisfies ShellState
    } finally {
      // 迟到 settle 的旋钮清理必须按值守卫 + 代际守卫：值守卫防「误删他人
      // 实例的旋钮」；代际守卫防「同实例重 boot 的迟到 finally 删掉新 boot
      // 刚设的同值旋钮」（2026 最终 review MEDIUM）。
      if (win.__DSH_BASE_PATH__ === basePath && bootGenerations.get(instanceId) === gen) delete win.__DSH_BASE_PATH__
      if (getChamberInstanceId() === instanceId && bootGenerations.get(instanceId) === gen) setChamberInstanceId(undefined)
    }
  })
  // H1 修复（2026 audit）：整个 boot 任务（含 extraRows/run 各阶段）受预算
  // 约束。超时即取消——记录 cancelledBoots（任务体内的取消检查随后 dispose
  // 而非注册）、立即 dispose 已构造的 entry、拒绝排队 opens；调用方与串行
  // 链都在预算内 settle，两个 boot 永不并发覆盖窗口旋钮（跨实例流量混淆的
  // 根因）。vendor run() 可能仍卡在无超时 fetch 里：其迟到 settle 观察到
  // cancelledBoots 后拆除，绝不注册。任务先 settle 时计时器必须清除——
  // 否则过期计时器会在稍后误取消/误 dispose 一个已注册的 entry。
  const bounded: Promise<ShellState> = new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeoutBranch = (): void => {
      console.error(`[shell] instance ${instanceId} boot timed out after ${bootTimeoutMs}ms — cancelled`)
      cancelledBoots.set(instanceId, gen)
      if (staleEntry !== undefined) disposeEntry(instanceId, staleEntry)
      rejectPendingOpens(instanceId, `boot timed out after ${bootTimeoutMs}ms`)
      resolve({ instanceId, basePath, booted: false, booting: false, error: 'boot timed out', pluginDegraded } satisfies ShellState)
    }
    timer = setTimeout(timeoutBranch, bootTimeoutMs)
    timer.unref?.()
    task.then(
      (state) => {
        if (timer !== undefined) clearTimeout(timer)
        resolve(state)
      },
      (error) => {
        if (timer !== undefined) clearTimeout(timer)
        reject(error)
      },
    )
  })
  bootChain = bounded.then(() => undefined, () => undefined)
  return bounded
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
  return pendingOpens.enqueue(instanceId, sessionId)
}

/** Boot settled: dispatch every queued open for this instance. */
function flushPendingOpens(instanceId: string): void {
  const holder = entries.get(instanceId)
  if (holder === undefined) return
  pendingOpens.flush(instanceId, sessionId => dispatchOpen(holder.entry, sessionId))
}

/** Boot failed: the queued opens can never dispatch — drop them loud. */
function rejectPendingOpens(instanceId: string, message: string): void {
  const error = new Error(`实例 ${instanceId} 无法打开会话：${message}`)
  const count = pendingOpens.reject(instanceId, error)
  if (count > 0) console.error(`[shell] instance ${instanceId} failed to boot; ${count} queued session open(s) dropped: ${message}`)
}

/**
 * Dispatch one open through the settled runtime context (ctx.sessions — the
 * ISessions face of dsh-client-runtime, see boot.ts runtimeCtx). The runtime
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
      // 经 disposeEntry 串行化：重加实例的新 boot 会 await 本次 teardown。
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
  pendingOpens.rejectAll(new Error('全部实例 shell 已释放，排队的会话未打开'))
}
