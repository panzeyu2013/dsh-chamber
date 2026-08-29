/**
 * N-ctx shell orchestration (design 05 §1/§3.6): one AppWebEntry per dsh
 * instance, each an independent cordis ctx with a full ui-* tree, mounted
 * into its own container div. Boots normally serialize module/plugin
 * materialization; per-instance identity and basePath are bound into each
 * AppWebEntry Context through a closure, so the bounded queue timeout may let
 * a later DIFFERENT-instance boot proceed without page-global knob
 * cross-contamination. Same-id boots stay strictly serialized through settle
 * and async teardown, preventing producer-registration reversal and two React
 * roots from ever targeting one container. Instance shells stay mounted once
 * booted (hide/show switching is pure CSS, sessions stay alive).
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
import type { Context } from '@deepseek-ai/cordis'

import { parseAuthoritativeSourceFingerprint } from './deep-link-activation.ts'
import { isChamberSourceId, rawInstanceIdFromSourceId } from './transport-source.ts'
import { BundleLoadTimeoutError, collectExtraRows, type ExtraModuleRow } from './host-graph.ts'
import { chamberBridge } from '@dsh-chamber/dsh-client-ui-sidebar/shared'
import { PendingOpenQueue } from './pending-open-queue.ts'

const CHAMBER_BOOT = '@dsh-chamber/app'
export type ChamberTransport = 'local' | 'ssh' | 'http'

/** Convert an arbitrary thrown value into a stable diagnostic without ever
 * throwing again. External runtime stores/plugins may throw proxies whose
 * getPrototypeOf, message, or string-conversion traps also throw; every shell
 * catch boundary must still settle its caller instead of stranding a boot or
 * timer-driven session-open promise. */
function describeShellError(reason: unknown): string {
  try {
    if (reason instanceof Error) {
      const message = typeof reason.message === 'string' ? reason.message : ''
      if (message !== '') return message
      const name = typeof reason.name === 'string' ? reason.name : ''
      if (name !== '') return name
    }
  } catch {
    // Fall through to the separately guarded String conversion.
  }
  try {
    const text = String(reason)
    return text === '' ? 'unknown error' : text
  } catch {
    return 'unknown error'
  }
}

/** Direct opens get 8s of list polling; queued opens retain their earlier
 * 68s total deadline and receive at most this much remaining dispatch time. */
const OPEN_WAIT_MS = 8000
const OPEN_RETRY_MS = 400

/**
 * How long one boot may hold the serialized queue before the chain moves on.
 * A vendor `entry.run()` that never settles (a hung fetch/loader) must not
 * wedge every other instance's boot for the rest of the session: the queue
 * slot times out and later DIFFERENT-instance boots proceed. Same-id successors
 * do not consume a page-global queue slot while waiting: they first await their
 * predecessor's full settle/teardown, then join the current global tail.
 */
const BOOT_TIMEOUT_MS = 60_000
const QUEUED_OPEN_TIMEOUT_MS = BOOT_TIMEOUT_MS + OPEN_WAIT_MS

/** Same-origin module-script loader (ESM chunks; the stock loader uses classic scripts). */
function loadModuleBundle(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script')
    el.type = 'module'
    el.src = url
    let requestSettled = false
    let scriptSettled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let settleOutcome!: (loaded: boolean) => void
    const bundleOutcome = new Promise<boolean>(resolveOutcome => { settleOutcome = resolveOutcome })
    const settleScript = (loaded: boolean, action: () => void): void => {
      if (scriptSettled) return
      scriptSettled = true
      if (timer !== undefined) clearTimeout(timer)
      el.remove()
      settleOutcome(loaded)
      if (!requestSettled) {
        requestSettled = true
        action()
      }
    }
    // A hung bundle (server stalls, never fires load/error) must not keep this
    // instance's boot pending forever — fail loud at the same order of
    // magnitude as the graph fetch (host-graph.ts GRAPH_TIMEOUT_MS); the
    // rejection runs through the same fail-loud boot path as a load error.
    // Removing a module element does not reliably cancel its fetch, so leave
    // it attached after timeout. host-graph keeps a temporary tombstone and
    // observes bundleOutcome: a late load becomes success, a late error makes
    // a later retry safe.
    timer = setTimeout(() => {
      if (requestSettled) return
      requestSettled = true
      reject(new BundleLoadTimeoutError(
        `dsh-chamber: bundle script ${url} timed out after ${BUNDLE_LOAD_TIMEOUT_MS}ms`,
        bundleOutcome,
      ))
    }, BUNDLE_LOAD_TIMEOUT_MS)
    el.addEventListener('load', () => settleScript(true, resolve), { once: true })
    el.addEventListener('error', () => {
      settleScript(false, () => reject(new Error(`dsh-chamber: bundle script ${url} failed to load`)))
    }, { once: true })
    try {
      document.head.append(el)
    } catch (error) {
      settleScript(false, () => reject(error))
    }
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
}

/** One serialized boot queue shared by every instance (module/plugin discipline). */
let bootChain: Promise<void> = Promise.resolve()

/** Build the per-entry Context initializer. The closure owns immutable values;
 * invoking initializers out of boot order can never exchange instance facts. */
export function createChamberContextSetup(
  instanceId: string,
  basePath: string,
  sourceFingerprint: string,
  transport: ChamberTransport = instanceId === 'local' ? 'local' : 'ssh',
): (ctx: Pick<Context, 'provide'>) => void {
  if (instanceId.trim() === '') throw new Error('shell: empty instance id')
  if (!isChamberSourceId(instanceId)
    || (instanceId !== 'local' && rawInstanceIdFromSourceId(instanceId) === null)) {
    throw new Error(`shell: invalid instance id ${JSON.stringify(instanceId)}`)
  }
  if ((instanceId === 'local' && transport !== 'local')
    || (instanceId !== 'local' && transport !== 'ssh' && transport !== 'http')) {
    throw new Error(`shell: invalid transport ${JSON.stringify(transport)} for ${JSON.stringify(instanceId)}`)
  }
  const expectedBasePath = `/api/i/${instanceId}`
  if (basePath !== expectedBasePath) {
    throw new Error(`shell: instance/base-path mismatch (${JSON.stringify(instanceId)}, ${JSON.stringify(basePath)})`)
  }
  if (parseAuthoritativeSourceFingerprint(instanceId, sourceFingerprint) === null) {
    throw new Error(`shell: invalid source fingerprint for ${JSON.stringify(instanceId)}`)
  }
  return (ctx) => {
    ctx.provide('chamberInstanceId', instanceId)
    ctx.provide('chamberBasePath', basePath)
    ctx.provide('chamberSourceFingerprint', sourceFingerprint)
    ctx.provide('chamberTransport', transport)
  }
}

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

type DispatchCancel = (error: Error) => void

/** One exact live generation. In-flight session-list pollers belong to the
 * holder, not just the instance id, so replacement/teardown can cancel them
 * before an old runtime ever reaches sessions.open(). */
interface ShellHolder {
  entry: AppWebEntry
  activeDispatchCancels: Set<DispatchCancel>
}

/** The live AppWebEntry holder per booted instance (unmount on teardown). */
const entries = new Map<string, ShellHolder>()

/** Strict per-id lifecycle tail. A successor waits for the predecessor's full
 * task (including stale/failure teardown) before it joins the global boot
 * queue. This prevents same-container mounts and producer registration order
 * from reversing across the page-level 60s timeout. */
const instanceBootTails = new Map<string, Promise<void>>()

/** Every async AppWebEntry.dispose() currently in flight, folded per id. */
const instanceTeardownBarriers = new Map<string, Promise<void>>()

/** Reclaim per-id generation/cancellation owners only after the exact current
 * tail and teardown barrier have both settled. The final identity checks are
 * essential: remove -> same-id re-add may install a newer tail while this
 * cleanup is waiting, and an old callback must never erase its generation. */
function scheduleInstanceLifecycleOwnerCleanup(instanceId: string): void {
  const capturedGeneration = bootGenerations.get(instanceId)
  const capturedTail = instanceBootTails.get(instanceId)
  const capturedBarrier = instanceTeardownBarriers.get(instanceId)
  void Promise.all([
    capturedTail ?? Promise.resolve(),
    capturedBarrier ?? Promise.resolve(),
  ]).then(() => {
    if (bootGenerations.get(instanceId) !== capturedGeneration) return
    if (instanceBootTails.get(instanceId) !== undefined) return
    if (instanceTeardownBarriers.get(instanceId) !== undefined) return
    if (entries.has(instanceId)) return
    bootGenerations.delete(instanceId)
    cancelledBoots.delete(instanceId)
  })
}

/** Test-only storage seam: historical source ids must not accumulate. */
export function __testShellLifecycleOwnerCounts(): {
  bootGenerations: number
  cancelledBoots: number
} {
  return {
    bootGenerations: bootGenerations.size,
    cancelledBoots: cancelledBoots.size,
  }
}

/** Session opens requested before boot; their original promises settle on dispatch. */
const pendingOpens = new PendingOpenQueue(QUEUED_OPEN_TIMEOUT_MS)

export function shellStateIdle(instanceId: string, basePath: string): ShellState {
  return { instanceId, basePath, booted: false, booting: false, error: null }
}

/**
 * Boot (or queue) the instance shell into `el`. Returns the settled state.
 * Boots normally serialize page-level module materialization; instance facts
 * remain private even when the bounded queue lets DIFFERENT ids overlap.
 */
export function bootInstanceShell(
  instanceId: string,
  basePath: string,
  el: HTMLElement,
  onState: (next: ShellState) => void,
  sourceFingerprint: string,
  transport: ChamberTransport = instanceId === 'local' ? 'local' : 'ssh',
): Promise<ShellState> {
  // Validate the source/base-path pair before installing module globals or
  // starting the host-graph request. An invalid source must not be able to
  // steer even a same-origin probe through a crafted /api/i/... prefix.
  const configureContext = createChamberContextSetup(instanceId, basePath, sourceFingerprint, transport)
  // 取序必须在入队前：dispose 记录的阈值与 settle 检查都按本次 boot 的代。
  const gen = (bootGenerations.get(instanceId) ?? 0) + 1
  bootGenerations.set(instanceId, gen)
  const previousInstanceTail = instanceBootTails.get(instanceId)
  const before: ShellState = { instanceId, basePath, booted: false, booting: true, error: null }
  onState(before)
  // A completed boot no longer has an instance tail, but removing/replacing
  // its live holder registers an async teardown barrier synchronously. Capture
  // that barrier before deciding whether host-graph/bundle preloading may run:
  // those page-global module-table side effects belong to the new generation
  // and must not overlap the old ctx's disposer either.
  const previousTeardownBarrier = instanceTeardownBarriers.get(instanceId)
  const hadLiveHolder = entries.has(instanceId)
  const previousInstanceBoot = Promise.all([
    previousInstanceTail ?? Promise.resolve(),
    previousTeardownBarrier ?? Promise.resolve(),
  ]).then(() => undefined)
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
    moduleSystemError = describeShellError(reason)
  }
  // Host-graph/bundle preloading can overlap the global queue for a source
  // with no same-id predecessor. A same-id successor MUST defer even these
  // side effects until its strict instance tail settles: bundle evaluation
  // mutates the shared module registration table and is therefore part of the
  // lifecycle exclusion, not harmless network-only prefetch.
  const startExtraRows = (): Promise<ExtraModuleRow[]> => {
    const promise = moduleSystemError === null
      ? collectExtraRows(instanceId, basePath, {
        loadModuleBundle,
        // A retry starts its graph request before the previous queued boot has
        // necessarily settled. Only the current, non-cancelled generation may
        // publish: otherwise an old slow failure can overwrite a newer ok.
        reportDiagnostic: (sourceId, diagnostic) => {
          if (bootGenerations.get(instanceId) !== gen) return
          if ((cancelledBoots.get(instanceId) ?? 0) >= gen) return
          chamberBridge.reportPluginDiagnostic(sourceId, diagnostic)
        },
      })
      : Promise.resolve<ExtraModuleRow[]>([])
    // An eager different-id prefetch may reject while waiting for its global
    // slot. The run task awaits this same promise and still fails loud there.
    void promise.catch(() => undefined)
    return promise
  }
  const eagerExtraRows = previousInstanceTail === undefined
    && previousTeardownBarrier === undefined
    && !hadLiveHolder
    ? startExtraRows()
    : undefined
  // Wait for the exact same-id predecessor BEFORE claiming a page-global
  // queue position. Thus a hung source never hides a different source behind
  // its strict instance tail: after the predecessor's 60s page-level slot is
  // released, unrelated ids may proceed while this successor keeps waiting.
  const task = previousInstanceBoot.then(() => {
    const runTask = bootChain.then(async () => {
    let staleEntry: AppWebEntry | undefined
    try {
      let blocked: ReturnType<typeof blockedBoot>

      /** Drain every same-id teardown and retire a live predecessor. This is
       * called both before a deferred graph preload and after every preload:
       * the second pass catches a removal/replacement that begins while the
       * graph or bundle request is in flight. */
      const retireSameIdPredecessors = async (): Promise<ShellState | undefined> => {
        while (true) {
          const barrier = instanceTeardownBarriers.get(instanceId)
          if (barrier !== undefined) {
            await barrier
            continue
          }
          blocked = blockedBoot(instanceId, gen)
          if (blocked !== undefined) {
            if (bootGenerations.get(instanceId) === gen) rejectPendingOpens(instanceId, blocked.message)
            return { instanceId, basePath, booted: false, booting: false, error: blocked.message }
          }
          // Defensive direct replacement: normal App retry first disposes the
          // failed holder, but duplicate callers must retire and AWAIT a live
          // holder before their graph/bundle side effects can begin.
          const previousHolder = entries.get(instanceId)
          if (previousHolder === undefined) return undefined
          entries.delete(instanceId)
          await disposeHolder(instanceId, previousHolder, 'shell replaced by a newer generation')
        }
      }

      let extraRows: ExtraModuleRow[]
      if (eagerExtraRows !== undefined) {
        extraRows = await eagerExtraRows
      } else {
        const stopped = await retireSameIdPredecessors()
        if (stopped !== undefined) return stopped
        extraRows = await startExtraRows()
      }

      // Host boot-graph merge (design 09, module C): the composite covers the
      // whole official shell; client plugins installed into the instance's
      // profile arrive as rows the composite does not cover. Preloading their
      // bundles completes BEFORE entry creation so every factory is registered
      // in the shared module table when loader.create materializes entries
      // (boot.ts runPluginBoot — the factories branch).
      // A remove/retry may have started while this boot's eager/deferred graph
      // request was in flight. Re-check without an artificial resolved-await
      // gap before constructing the Context.
      const stoppedAfterPreload = await retireSameIdPredecessors()
      if (stoppedAfterPreload !== undefined) return stoppedAfterPreload

      // Bind instance facts to THIS entry instead of page globals. configureContext
      // runs synchronously before loader/plugin materialization, so a boot that
      // overlaps a different id after the queue timeout cannot observe it.
      const entry = new AppWebEntry(el, {
        loadBundle: loadModuleBundle,
        extraRows,
        configureContext,
      })
      staleEntry = entry
      await entry.run()
      blocked = blockedBoot(instanceId, gen)
      if (blocked !== undefined) {
        // Registration is guarded by BOTH cancellation and current generation.
        // Same-id successors await this entire task (including teardown), so
        // even a predecessor that exceeded the page-level timeout is fully
        // retired before its successor can construct or register.
        await teardownEntry(instanceId, entry, 'stale boot')
        // Pending opens are keyed by instance, so an old generation must not
        // reject requests queued for its replacement. If this is still the
        // current (cancelled) generation, however, no later entry can dispatch
        // them and they must fail loud.
        if (bootGenerations.get(instanceId) === gen) rejectPendingOpens(instanceId, blocked.message)
        return { instanceId, basePath, booted: false, booting: false, error: blocked.message } satisfies ShellState
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
        await teardownEntry(instanceId, entry, 'failed boot')
        if (bootGenerations.get(instanceId) === gen) rejectPendingOpens(instanceId, bootFailure)
        return { instanceId, basePath, booted: false, booting: false, error: bootFailure } satisfies ShellState
      }
      // An older timed-out boot may have begun teardown while this entry ran.
      // Drain it before registration, again making the final barrier/holder
      // checks and entries.set atomic within one synchronous turn. Unknown
      // re-entrant callers can therefore never make Map overwrite leak a ctx.
      while (true) {
        const barrier = instanceTeardownBarriers.get(instanceId)
        if (barrier !== undefined) {
          await barrier
          continue
        }
        blocked = blockedBoot(instanceId, gen)
        if (blocked !== undefined) {
          await teardownEntry(instanceId, entry, 'superseded during registration')
          if (bootGenerations.get(instanceId) === gen) rejectPendingOpens(instanceId, blocked.message)
          return { instanceId, basePath, booted: false, booting: false, error: blocked.message } satisfies ShellState
        }
        const displacedHolder = entries.get(instanceId)
        if (displacedHolder === undefined || displacedHolder.entry === entry) break
        entries.delete(instanceId)
        await disposeHolder(instanceId, displacedHolder, 'shell replaced during registration')
      }
      const holder: ShellHolder = { entry, activeDispatchCancels: new Set() }
      entries.set(instanceId, holder)
      // 注册成功即清掉本实例的旧阈值：same-id boot tail 已保证前代完成 teardown，
      // current-generation 门又覆盖本代 await 期间被更新一代取代的情形；残留
      // 阈值这里只会扩大 Map，不再承担旧 ctx 隔离职责。
      cancelledBoots.delete(instanceId)
      flushPendingOpens(instanceId)
      return { instanceId, basePath, booted: true, booting: false, error: null } satisfies ShellState
    } catch (reason) {
      const message = describeShellError(reason)
      // run() 不再拒绝（rc.8 形状：一切失败经 bootError 上浮），catch 兜底
      // 构造期/挂载期的同步异常——若 entry 已在容器上画过加载页或挂载过 UI，
      // 先 dispose（移除 boot DOM / 卸载 React root），重试才能干净重 boot。
      if (staleEntry !== undefined) {
        const registered = entries.get(instanceId)
        if (registered?.entry === staleEntry) {
          entries.delete(instanceId)
          await disposeHolder(instanceId, registered, 'boot failed after registration')
        } else {
          await teardownEntry(instanceId, staleEntry, 'boot exception')
        }
      }
      // 失败的旧代不能清掉新代排队的 opens；只有仍为 current 的失败 boot
      // 才拥有该 instance-keyed 队列。失败 boot 从不消费取消阈值。
      if (bootGenerations.get(instanceId) === gen) rejectPendingOpens(instanceId, message)
      return { instanceId, basePath, booted: false, booting: false, error: message } satisfies ShellState
    }
    })
    // 页面级链推进用超时护栏：一个永不 settle 的 boot 在
    // BOOT_TIMEOUT_MS 后只放行其他 id。runTask 本身仍被本 id 的
    // instance tail 持有；同 id 新代必须等它 settle + async teardown。
    // withBootTimeout 本身不 reject，无需再套一层重复 then。
    bootChain = withBootTimeout(runTask)
    return runTask
  })
  const instanceTail = task.then(() => undefined, () => undefined)
  instanceBootTails.set(instanceId, instanceTail)
  void instanceTail.then(() => {
    if (instanceBootTails.get(instanceId) === instanceTail) instanceBootTails.delete(instanceId)
    scheduleInstanceLifecycleOwnerCleanup(instanceId)
  })
  return task
}

function blockedBoot(instanceId: string, gen: number): { superseded: boolean; message: string } | undefined {
  const currentGeneration = bootGenerations.get(instanceId)
  const superseded = currentGeneration !== gen
  if (superseded) {
    return { superseded: true, message: `shell boot superseded by generation ${currentGeneration ?? 'none'}` }
  }
  if ((cancelledBoots.get(instanceId) ?? 0) >= gen) {
    return { superseded: false, message: 'shell disposed (instance left ready)' }
  }
  return undefined
}

/**
 * Resolve once the wrapped boot settles OR the timeout elapses — the serialized
 * queue must never be wedged by a boot that never settles. The wrapped promise
 * only drives the page-level chain for other ids; callers and the strict
 * per-id tail still await the original task. A same-id successor therefore
 * never passes a predecessor that has not settled and torn down.
 */
function withBootTimeout(promise: Promise<ShellState>): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      console.error(`[shell] boot timed out after ${BOOT_TIMEOUT_MS}ms — queue continues (late settle remains generation-gated)`)
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
 * race right after boot, so direct dispatch polls up to 8s; a pre-boot request
 * keeps its original 68s total deadline across the eventual flush).
 */
export function openInstanceSession(instanceId: string, sessionId: string): Promise<void> {
  const holder = entries.get(instanceId)
  if (holder !== undefined) return dispatchOpen(instanceId, holder, sessionId)
  return pendingOpens.enqueue(instanceId, sessionId)
}

/** Boot settled: dispatch every queued open without resetting its original
 * 68s total deadline; only the remaining budget (capped at 8s) is available. */
function flushPendingOpens(instanceId: string): void {
  const holder = entries.get(instanceId)
  if (holder === undefined) return
  pendingOpens.flush(instanceId, (sessionId, deadline) => dispatchOpen(instanceId, holder, sessionId, deadline))
}

/** Boot failed: the queued opens can never dispatch — drop them loud. */
function rejectPendingOpens(instanceId: string, message: string): void {
  const error = new Error(`实例 ${instanceId} 无法打开会话：${message}`)
  const count = pendingOpens.reject(instanceId, error)
  if (count > 0) console.error(`[shell] instance ${instanceId} failed to boot; ${count} queued session open(s) dropped: ${message}`)
}

/**
 * Dispatch one open through one EXACT settled holder/runtime context
 * (ctx.sessions — the ISessions face of dsh-client-runtime, see boot.ts
 * runtimeCtx). The runtime validates the id against its own list, so wait
 * until the session surfaces there before calling open. Every retry and the
 * final sessions.open gate re-check holder identity; teardown/replacement
 * cancels the holder-owned poller immediately and clears its timer.
 */
function dispatchOpen(
  instanceId: string,
  holder: ShellHolder,
  sessionId: string,
  queuedDeadline?: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Math.min(queuedDeadline ?? Number.POSITIVE_INFINITY, Date.now() + OPEN_WAIT_MS)
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const cleanup = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      holder.activeDispatchCancels.delete(cancel)
    }

    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }

    const succeed = (): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve()
    }

    const cancel: DispatchCancel = error => fail(error)
    holder.activeDispatchCancels.add(cancel)

    const timeout = (): void => {
      fail(new Error(`会话 ${sessionId} 未出现在实例会话列表中（等待超时）`))
    }

    const attempt = (): void => {
      timer = undefined
      if (settled) return
      if (entries.get(instanceId) !== holder) {
        fail(new Error(`实例 ${instanceId} shell 已失效，会话 ${sessionId} 未打开`))
        return
      }
      if (Date.now() >= deadline) {
        timeout()
        return
      }
      let sessions: NonNullable<AppWebEntry['runtimeCtx']>['sessions'] | undefined
      try {
        // runtimeCtx is shell-owned, but Cordis service lookup is external and
        // may itself be a throwing proxy. Keep it under the same settlement
        // boundary as list.getSnapshot/open, including timer-driven attempts.
        sessions = holder.entry.runtimeCtx?.sessions
      } catch (err) {
        fail(new Error(describeShellError(err)))
        return
      }
      if (sessions === undefined) {
        fail(new Error('实例会话服务不可用（boot 未完全就绪）'))
        return
      }
      let listed = false
      try {
        listed = sessions.list?.getSnapshot()?.byId?.[sessionId] !== undefined
      } catch (err) {
        fail(new Error(describeShellError(err)))
        return
      }
      if (listed) {
        // getSnapshot() is external synchronous code and may re-enter shell
        // teardown. Re-check immediately before the irreversible open call.
        if (entries.get(instanceId) !== holder) {
          fail(new Error(`实例 ${instanceId} shell 已失效，会话 ${sessionId} 未打开`))
          return
        }
        if (Date.now() >= deadline) {
          timeout()
          return
        }
        try {
          sessions.open(sessionId)
          succeed()
        } catch (err) {
          fail(new Error(describeShellError(err)))
        }
        return
      }
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        timeout()
        return
      }
      timer = setTimeout(attempt, Math.min(OPEN_RETRY_MS, remaining))
    }
    attempt()
  })
}

/** Register one async entry teardown immediately and fold it into the id-local
 * barrier. Rejections are loud but contained so a broken disposer cannot
 * permanently wedge every future boot for that source. */
function teardownEntry(instanceId: string, entry: AppWebEntry, reason: string): Promise<void> {
  let ownTeardown: Promise<void>
  try {
    ownTeardown = Promise.resolve(entry.dispose()).catch(error => {
      console.error(`[shell] async dispose of instance ${instanceId} (${reason}) rejected:`, error)
    })
  } catch (error) {
    console.error(`[shell] dispose of instance ${instanceId} (${reason}) threw:`, error)
    ownTeardown = Promise.resolve()
  }
  const prior = instanceTeardownBarriers.get(instanceId) ?? Promise.resolve()
  const barrier = Promise.all([prior, ownTeardown]).then(() => undefined)
  instanceTeardownBarriers.set(instanceId, barrier)
  void barrier.then(() => {
    if (instanceTeardownBarriers.get(instanceId) === barrier) instanceTeardownBarriers.delete(instanceId)
    scheduleInstanceLifecycleOwnerCleanup(instanceId)
  })
  return barrier
}

/** Invalidate all holder-owned dispatches before disposing its runtime ctx. */
function disposeHolder(instanceId: string, holder: ShellHolder, reason: string): Promise<void> {
  const error = new Error(`实例 ${instanceId} 无法打开会话：${reason}`)
  for (const cancel of [...holder.activeDispatchCancels]) cancel(error)
  holder.activeDispatchCancels.clear()
  return teardownEntry(instanceId, holder.entry, reason)
}

/**
 * Tear down ONE instance's shell (design 05 §4: view lifetime = registry
 * entry lifetime — the source was REMOVED from the registry): dispose the
 * AppWebEntry, drop the entry and any pending/active opens (they can never
 * dispatch). Async ctx teardown is registered as an id-local barrier that a
 * re-added source must await. A boot queued or in flight for the instance is
 * cancelled on settle (cancelledBoots). The container div is React's to remove
 * (InstanceView unmounts after the reap). Connection state never reaps a
 * shell — disconnected/errored sources keep their view (the settings page
 * and the sidebar both anchor the registry, the shell must not diverge).
 */
export function disposeInstanceShell(instanceId: string): void {
  // Always cancel through the generation current at disposal time. A live
  // holder does not imply there is no newer queued/in-flight same-id boot;
  // omitting the threshold in that branch lets the later boot resurrect a
  // registry-removed source after this holder is torn down.
  const currentGeneration = bootGenerations.get(instanceId) ?? 0
  cancelledBoots.set(instanceId, Math.max(cancelledBoots.get(instanceId) ?? 0, currentGeneration))
  const holder = entries.get(instanceId)
  if (holder !== undefined) {
    entries.delete(instanceId)
    void disposeHolder(instanceId, holder, 'shell disposed (instance left ready)')
  }
  rejectPendingOpens(instanceId, 'shell disposed (instance left ready)')
  scheduleInstanceLifecycleOwnerCleanup(instanceId)
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
  // Invalidate every identity before any entry teardown can re-enter shell
  // dispatch. Each holder then synchronously rejects and clears its pollers.
  const holders = [...entries]
  entries.clear()
  for (const [instanceId, holder] of holders) {
    void disposeHolder(instanceId, holder, 'all shells disposed')
    scheduleInstanceLifecycleOwnerCleanup(instanceId)
  }
  for (const [instanceId, gen] of bootGenerations) {
    cancelledBoots.set(instanceId, gen)
    scheduleInstanceLifecycleOwnerCleanup(instanceId)
  }
  pendingOpens.rejectAll(new Error('全部实例 shell 已释放，排队的会话未打开'))
}

/** The boot-graph row id this page's manifest must carry (gen-boot-manifest.mjs). */
export const BOOT_PLUGIN_ID = CHAMBER_BOOT
