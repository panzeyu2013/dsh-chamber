/**
 * N-ctx shell orchestration (design 05 §1/§3.6): one AppWebEntry per dsh
 * instance, each an independent cordis ctx with a full ui-* tree, mounted
 * into its own container div. Boots normally serialize module/plugin
 * materialization; per-instance identity and basePath are bound into each
 * AppWebEntry Context through a closure, so the bounded queue timeout may let
 * a later DIFFERENT-instance boot proceed without page-global knob
 * cross-contamination. Same-id boots stay serialized through the predecessor's
 * settle and async teardown — bounded by INSTANCE_TAIL_WAIT_CAP_MS when a
 * predecessor never settles — and the late predecessor is kept superseded by
 * the generation gate plus the boot-generation fence on producer registration,
 * so no producer reversal or two-React-roots container can survive. Instance shells stay mounted once
 * booted (hide/show switching is pure CSS, sessions stay alive).
 *
 * 保留策略例外（2026 性能整改，05 §1/§4 偏差）：上述"booted 后常驻"是 App
 * 层默认编排；App 的保留策略（src/retention.ts）可在空闲期回收超限隐藏壳——
 * 回收走与注册表删除相同的 disposeInstanceShell 原语（generation cancel +
 * 异步 teardown barrier），本模块语义不变（视图代际/同 id 串行 barrier 同样
 * 保证回收后的重 boot 不与异步 teardown 交错），实例进程/连接不受影响。
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
import { BOOT_TIMEOUT_MS } from './boot-budget.ts'
import { isChamberSourceId, rawInstanceIdFromSourceId } from './transport-source.ts'
import { BundleLoadTimeoutError, collectExtraRows, type ExtraModuleRow } from './host-graph.ts'
import { CHAMBER_COVERED_IDS } from './chamber-covered.ts'
import {
  installClientPluginLoader, retireSourceClientGraph,
} from '../../dsh-chamber-client-ui-sidebar/src/shared/client-plugin-loader.ts'
import { chamberBridge, type PluginGraphDiagnostic } from '@dsh-chamber/dsh-chamber-client-ui-sidebar/shared'
import { PendingOpenQueue } from './pending-open-queue.ts'
import { PERF_MARKS, perfMark } from './perf-marks.ts'

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
    // magnitude as the graph fetch (host-graph.ts, whose bounded-unary 30s
    // budget rides the shared postUnary kernel of sidebar shared
    // wire-common.ts); the
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

/** How long one extra-bundle script load may take before it fails loud (parallel to the graph fetch's 30s budget). */
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
  /**
   * The boot settled with a KNOWN gap that the App is expected to self-heal
   * (2026-09-10, sidebarRight 彻底修复):
   *  - `graph-unavailable`: the source never served its client plugin graph
   *    inside the boot window, so this entry runs with no profile client
   *    plugins — `ui-chat` pends on `sidebarRight`, the conversation view
   *    never registers.
   *  - `required-services-missing`: the graph WAS available but the required
   *    extra-row service still never materialized (the 5s probe's verdict).
   * Both are recoverable by a fresh boot once the source serves: the App
   * re-boots the instance on the ready transition instead of leaving a
   * half-dead mount (previously only a manual page reload recovered).
   */
  degraded: ShellDegradedFact | null
}

/** Why a settled boot is known to be incomplete (see {@link ShellState.degraded}). */
export interface ShellDegradedFact {
  kind: 'graph-unavailable' | 'required-services-missing'
  message: string
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
  bootGeneration?: number,
  reportRequiredServicesMissing?: (message: string) => void,
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
    // 代际事实（2026-12 复查 BLOCKER）：页面的 producer 注册表按注册顺序
    // 授权，一个挂死后又恢复的老 boot 会夺走生产权，其 teardown clear 会把
    // 健康后继的通道永久清空。消费者（侧栏 producer 注册）用它做代际栅栏。
    if (bootGeneration !== undefined) ctx.provide('chamberBootGeneration', bootGeneration)
    // The entry's required-service probe reports a post-settle degrade through
    // this seam (2026-09-10): the App re-boots the instance instead of leaving
    // a mount whose conversation view never registers.
    if (reportRequiredServicesMissing !== undefined) {
      ctx.provide('chamberReportBootDegraded', reportRequiredServicesMissing)
    }
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
  /**
   * The settle channel of the boot that installed this holder (2026-09-10):
   * a degrade discovered AFTER settle (the required-service probe's 5s
   * verdict) has to reach the App through the same `onState` seam, otherwise
   * the App can never learn that a mounted shell is half-dead.
   */
  onState?: (next: ShellState) => void
  lastState?: ShellState
}

/**
 * Record a post-settle degrade on the live holder and republish the state.
 * No-op when the instance has no holder (never booted / disposed) or its boot
 * did not succeed — a failed boot already reports its own error.
 */
function reportSettledDegrade(instanceId: string, fact: ShellDegradedFact): void {
  const holder = entries.get(instanceId)
  if (holder?.lastState === undefined || holder.onState === undefined) return
  if (!holder.lastState.booted) return
  if (holder.lastState.degraded?.kind === fact.kind) return
  const next: ShellState = { ...holder.lastState, degraded: fact }
  holder.lastState = next
  holder.onState(next)
}

/** The live AppWebEntry holder per booted instance (unmount on teardown). */
const entries = new Map<string, ShellHolder>()

/** Strict per-id lifecycle tail. A successor waits for the predecessor's full
 * task (including stale/failure teardown) before it joins the global boot
 * queue. This prevents same-container mounts and producer registration order
 * from reversing across the page-level 60s timeout. */
const instanceBootTails = new Map<string, Promise<void>>()
/** When the id's current boot started (absolute same-id wait deadline). */
const instanceBootStartedAt = new Map<string, number>()

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

/**
 * The LAST session each instance was asked to open (2026-12, design 05 §2.2
 * revision). Every open request enters through {@link openInstanceSession}, so
 * this map is the renderer-side record of the per-source request stream — the
 * dispatcher drops requests it has already superseded (see dispatchOpen). It
 * deliberately survives the settle of the request that set it: a stale request
 * may reach its dispatch only after the newer one finished.
 *
 * Cleared by {@link disposeInstanceShell} and {@link disposeAllShells} — the
 * paths that retire a source's shell — so a same-id re-add is a new generation
 * whose first open is not judged against the previous incarnation's request.
 *
 * The boot-failure / replacement paths deliberately do NOT clear it
 * (2026-09-11 review F5, doc narrowed to what the code does): the displaced
 * holder, the "boot failed after registration" teardown and the
 * pre-registration failure branches reject that instance's QUEUED opens but
 * leave this record. That is inert, because a dispatch is always preceded by
 * the write of its OWN request ({@link openInstanceSession} writes before it
 * dispatches or enqueues), so the record can differ from the request being
 * dispatched only when a NEWER request has since been recorded — which is
 * exactly the supersession this map exists to express. The doc used to claim
 * the record is cleared "when the source's shell is torn down", which those
 * paths made untrue.
 */
const lastRequestedSession = new Map<string, string>()

/**
 * Test-only seam: read one source's supersede record ({@link lastRequestedSession}).
 *
 * Why the record needs a seam at all (2026-09-11 review F4(b)): its retirement
 * is NOT observable through the public surface. Every dispatch is preceded by
 * the write of its own request, so a re-added source's first open overwrites the
 * leftover record before anything can compare it — a purely behavioral test of
 * "the re-added source still opens" passes even with the retirement removed
 * (mutation-verified). Asserting the record itself is the only way to pin the
 * invariant the map's doc states.
 */
export function __testLastRequestedSession(instanceId: string): string | undefined {
  return lastRequestedSession.get(instanceId)
}

export function shellStateIdle(instanceId: string, basePath: string): ShellState {
  return { instanceId, basePath, booted: false, booting: false, error: null, degraded: null }
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
  /**
   * Boot seams the App owns (2026-09-10): `waitForServing` lets the host-graph
   * fetch wait for a still-starting source instead of losing its client
   * plugins (see host-graph.ts CollectExtraRowsDeps.waitForServing).
   */
  options: { waitForServing?: (instanceId: string) => Promise<boolean> } = {},
): Promise<ShellState> {
  // C2 perf 埋点：boot 入口（含全局队列排队；注册表见 perf-marks.ts）。
  perfMark(PERF_MARKS.shellBootStart)
  // Validate the source/base-path pair before installing module globals or
  // starting the host-graph request. An invalid source must not be able to
  // steer even a same-origin probe through a crafted /api/i/... prefix.
  // 取序必须在入队前：dispose 记录的阈值与 settle 检查都按本次 boot 的代；
  // 也在 configureContext 之前，因为上下文要携带本次代际事实。
  const gen = (bootGenerations.get(instanceId) ?? 0) + 1
  bootGenerations.set(instanceId, gen)
  // Only the current, non-cancelled generation may publish: an old slow boot's
  // late failure must never overwrite a newer healthy mount's facts.
  const mayPublish = (): boolean =>
    bootGenerations.get(instanceId) === gen && (cancelledBoots.get(instanceId) ?? 0) < gen
  /**
   * The two degrade facts of this boot, filled by the host-graph fetch and by
   * the entry's required-service probe. `graphUnavailable` is known BEFORE the
   * boot settles (it is part of the settled state); the probe's verdict arrives
   * ~5s later and is republished through the holder (reportSettledDegrade).
   */
  let graphUnavailable: string | null = null
  const reportPluginDiagnostic = (sourceId: string, diagnostic: PluginGraphDiagnostic): void => {
    if (!mayPublish()) return
    chamberBridge.reportPluginDiagnostic(sourceId, diagnostic)
  }
  const reportRequiredServicesMissing = (message: string): void => {
    if (!mayPublish()) return
    reportSettledDegrade(instanceId, { kind: 'required-services-missing', message })
  }
  const configureContext = createChamberContextSetup(
    instanceId, basePath, sourceFingerprint, transport, gen, reportRequiredServicesMissing)
  const previousInstanceTail = instanceBootTails.get(instanceId)
  // 前代 boot 的起始时刻（绝对等待上限用）：必须在覆盖本代记录之前读取。
  const previousInstanceBootStartedAt = instanceBootStartedAt.get(instanceId)
  const before: ShellState = { instanceId, basePath, booted: false, booting: true, error: null, degraded: null }
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
  let modulesSystem: ReturnType<typeof ensureWebModuleSystem> | null = null
  try {
    modulesSystem = ensureWebModuleSystem({ loadBundle: loadModuleBundle })
  } catch (reason) {
    moduleSystemError = describeShellError(reason)
  }
  // Publish the page-level seams the SETTINGS BRIDGE consumes (2026-12): it
  // loads the selected source's own client plugins through the SAME transport,
  // module table and covered-id rule as this boot, so one page-wide union
  // table serves both. Installed even when the module system failed: the
  // settings panel then reports "module table unavailable" per source instead
  // of silently showing no plugin sections.
  installClientPluginLoader({
    loadBundle: loadModuleBundle,
    ...(modulesSystem === null ? {} : { modules: modulesSystem }),
    coveredIds: CHAMBER_COVERED_IDS,
  })
  // Const capture: TS does not narrow a mutable captured variable inside the
  // closure below.
  const installedModulesSystem = modulesSystem
  // C3 门（2026-09 性能审计；平台词偏差登记见 dsh-client-web platform.ts /
  // seed.ts）：`@deepseek-ai/dsh-client-ui-primitives` 不再由主图 seed 回答，
  // extra bundle 对该词的同步 require 由 chamber 入口顶层注册的 covered
  // factory 回答——因此 chamber 入口必须在任何 extra bundle 执行前完成求值。
  // prefetch 在此立即开火，与下方 host-graph 取图并行（实例 503 重试窗口内
  // chamber 在主线程求值）；失败在此吞掉：boot 内核 run() 内的
  // prefetchImmediateTier 同样静默（boot.ts），loud 面在 loader.create 的
  // create-side import 重取（模块缓存按 URL 去重、失败不缓存，成功后不会
  // 二次执行）。同 id 后继 boot 的
  // extra 装载仍被 strict instance tail 串行化（startExtraRows 在该 tail
  // 之后才跑），这里只负责"chamber 先于 extra"这一个顺序。
  let chamberEval: Promise<void> | null = null
  const fireChamberPrefetch = (): void => {
    if (chamberEval !== null) return
    chamberEval = (async () => {
      try {
        if (installedModulesSystem !== null) await installedModulesSystem.prefetch(CHAMBER_BOOT)
      } catch {
        // 吞掉：loud 面在 loader.create 的 create-side import 重取
        //（boot.ts 头注：prefetch 失败 resolve silently、import 重取负责 loud）。
      }
    })()
  }
  // Host-graph/bundle preloading can overlap the global queue for a source
  // with no same-id predecessor. A same-id successor MUST defer even these
  // side effects until its strict instance tail settles: bundle evaluation
  // mutates the shared module registration table and is therefore part of the
  // lifecycle exclusion, not harmless network-only prefetch.
  const startExtraRows = (): Promise<ExtraModuleRow[]> => {
    // C3：chamber prefetch 与 host-graph 取图并行开火；collectExtraRows 在
    // 装载 extra bundle 前 await 本门（host-graph.ts awaitBeforeLoad）。
    fireChamberPrefetch()
    const promise = moduleSystemError === null
      ? collectExtraRows(instanceId, basePath, {
        loadModuleBundle,
        awaitBeforeLoad: () => chamberEval ?? Promise.resolve(),
        // The published graph cache is keyed by this incarnation (2026-12):
        // the settings panel must never reuse another incarnation's rows.
        sourceFingerprint,
        // A retry starts its graph request before the previous queued boot has
        // necessarily settled — the shared generation-guarded reporter covers it.
        reportDiagnostic: reportPluginDiagnostic,
        // 503 = the source is still starting (cold start / restart straddle).
        // Wait for it instead of booting without any profile client plugins.
        ...(options.waitForServing === undefined ? {} : { waitForServing: options.waitForServing }),
        onGraphUnavailable: (message) => { if (mayPublish()) graphUnavailable = message },
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
  // The wait is BOUNDED by the same boot budget (2026-12 review BLOCKER): a
  // predecessor whose entry.run() never settles must not pin the id forever.
  // Releasing the tail instead would be wrong — the tail is what keeps
  // `bootGenerations`/`cancelledBoots` owned, so a late abandoned boot would
  // compare equal to its successor's generation and register over it. A bounded
  // wait keeps the generation records intact and therefore keeps the late
  // predecessor correctly superseded.
  const task = boundedTailWait(
    previousInstanceBoot,
    previousInstanceBootStartedAt === undefined
      ? undefined
      : previousInstanceBootStartedAt + INSTANCE_TAIL_WAIT_CAP_MS,
  ).then(() => {
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
            return { instanceId, basePath, booted: false, booting: false, error: blocked.message, degraded: null }
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
      // C2 perf 埋点：module system / host-graph / extra bundles 全部就绪，
      // boot 内核即将接管。
      perfMark(PERF_MARKS.shellEntryReady)
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
        return { instanceId, basePath, booted: false, booting: false, error: blocked.message, degraded: null } satisfies ShellState
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
        if (bootGenerations.get(instanceId) === gen) {
          rejectPendingOpens(instanceId, bootFailure)
          // 与 catch 分支同代际门控：teardown await 期间可能换代。
          perfMark(PERF_MARKS.shellBootFailed, instanceId)
        }
        return { instanceId, basePath, booted: false, booting: false, error: bootFailure, degraded: null } satisfies ShellState
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
          return { instanceId, basePath, booted: false, booting: false, error: blocked.message, degraded: null } satisfies ShellState
        }
        const displacedHolder = entries.get(instanceId)
        if (displacedHolder === undefined || displacedHolder.entry === entry) break
        entries.delete(instanceId)
        await disposeHolder(instanceId, displacedHolder, 'shell replaced during registration')
      }
      const settled: ShellState = {
        instanceId, basePath, booted: true, booting: false, error: null,
        degraded: graphUnavailable === null
          ? null
          : { kind: 'graph-unavailable', message: graphUnavailable },
      }
      const holder: ShellHolder = { entry, activeDispatchCancels: new Set(), onState, lastState: settled }
      entries.set(instanceId, holder)
      // 注册成功即清掉本实例的旧阈值：同 id 尾（有绝对上限）已让前代完成/被判
      // superseded，
      // current-generation 门又覆盖本代 await 期间被更新一代取代的情形；残留
      // 阈值这里只会扩大 Map，不再承担旧 ctx 隔离职责。
      cancelledBoots.delete(instanceId)
      flushPendingOpens(instanceId)
      // C2 perf 埋点：该实例 shell 成功 settle（真实 UI 可用的最近似点）。
      perfMark(PERF_MARKS.shellSettled, instanceId)
      return settled
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
      // 才拥有该 instance-keyed 队列。失败 boot 从不消费取消阈值。失败
      // perf 标记同条件：被换代/取消的旧 boot 的 teardown 抛错不算失败态。
      if (bootGenerations.get(instanceId) === gen) {
        rejectPendingOpens(instanceId, message)
        perfMark(PERF_MARKS.shellBootFailed, instanceId)
      }
      return { instanceId, basePath, booted: false, booting: false, error: message, degraded: null } satisfies ShellState
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
  instanceBootStartedAt.set(instanceId, Date.now())
  void instanceTail.then(() => {
    if (instanceBootTails.get(instanceId) === instanceTail) {
      instanceBootTails.delete(instanceId)
      instanceBootStartedAt.delete(instanceId)
    }
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
/**
 * Absolute cap on waiting for a same-id predecessor that never settles.
 *
 * (See boundedTailWait below.)
 *
 * The strict per-id tail is what keeps a successor from racing a live
 * predecessor's registration/teardown, so it must stay (and it is what keeps
 * `bootGenerations`/`cancelledBoots` owned — releasing the tail early would let
 * a late abandoned boot compare equal to its successor's generation and
 * register over it; 2026-12 review BLOCKER). But an unbounded wait means a
 * boot whose `entry.run()` never settles pins the id forever. The cap is two
 * boot budgets: comfortably past a slow-but-healthy predecessor (queue + boot),
 * and below the App's absolute harvest-abandon cap (135 s), so by the time a
 * wedged shell is abandoned and the user retries, the wait has already expired.
 */
export const INSTANCE_TAIL_WAIT_CAP_MS = BOOT_TIMEOUT_MS * 2

/**
 * Remaining wait for a same-id predecessor, in ms. All successors of one
 * predecessor share the ABSOLUTE deadline (predecessor start + cap) instead of
 * each arming a fresh cap — otherwise a retry at the abandon cap would wait a
 * whole extra cap before joining the queue (2026-12 review MAJOR). Exported for
 * its unit test (the integration path is timing-sensitive).
 */
export function tailWaitRemainingMs(deadlineAt: number | undefined, now: number): number {
  if (deadlineAt === undefined) return INSTANCE_TAIL_WAIT_CAP_MS
  return Math.max(0, deadlineAt - now)
}

function boundedTailWait(previous: Promise<void> | undefined, deadlineAt?: number): Promise<void> {
  if (previous === undefined) return Promise.resolve()
  const remaining = tailWaitRemainingMs(deadlineAt, Date.now())
  if (remaining <= 0) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, remaining)
    void previous.then(
      () => { clearTimeout(timer); resolve() },
      () => { clearTimeout(timer); resolve() },
    )
  })
}

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
 * the runtime accepted the open (the runtime sessions service may still be
 * activating right after settle — see dispatchOpen — and the session id must
 * be visible in the instance's own session list; the sidebar fetch and the
 * runtime list can race right after boot, so dispatch polls up to 8s; a
 * pre-boot request keeps its original 68s total deadline across the eventual
 * flush).
 */
export function openInstanceSession(instanceId: string, sessionId: string): Promise<void> {
  // Record the request stream BEFORE dispatching (2026-12, design 05 §2.2
  // revision): the dispatcher drops requests a newer one has superseded, and the
  // record must already hold THIS request when its own dispatch starts.
  lastRequestedSession.set(instanceId, sessionId)
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
 * (ctx.sessions — the ISessions face of @deepseek-ai/dsh-api-session-controller/client,
 * the dsh-v0.1.2-alpha.1 home of the sessions service; see boot.ts runtimeCtx).
 * The boot settle only waits on entry ROOT fibers, so the sessions service (a
 * composite child fiber behind async api-remotes mounts) can register AFTER the
 * holder exists; the poll therefore covers both service readiness and session
 * visibility in the runtime list within the same deadline budget, and only
 * fails when the deadline expires (distinct reports for the two causes). Every
 * retry and the final sessions.open gate re-check holder identity;
 * teardown/replacement cancels the holder-owned poller immediately and clears
 * its timer.
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

    // Whether the runtime sessions service was EVER observed: the terminal
    // report must distinguish a boot that never reached the service (child
    // fiber never activated) from a listed wait that simply expired.
    let serviceSeen = false

    const timeout = (): void => {
      // One last guarded read before choosing the report: the service may
      // have registered inside the final <OPEN_RETRY_MS window after the last
      // attempt that saw it absent — never blame boot readiness for a service
      // that is present by the deadline. Message selection is best-effort; a
      // hostile read must not throw here.
      if (!serviceSeen) {
        try {
          serviceSeen = holder.entry.runtimeCtx?.sessions !== undefined
        } catch {
          // Swallow: the deadline report stands on the observed attempts.
        }
      }
      fail(new Error(serviceSeen
        ? `会话 ${sessionId} 未出现在实例会话列表中（等待超时）`
        : `实例会话服务不可用（boot 未完全就绪）：会话 ${sessionId} 未打开`))
    }

    /** Schedule the next poll inside the remaining budget; at the deadline
     *  the terminal report fires instead of a further timer. */
    const scheduleRetry = (): void => {
      if (settled) return
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        timeout()
        return
      }
      timer = setTimeout(attempt, Math.min(OPEN_RETRY_MS, remaining))
    }

    const attempt = (): void => {
      timer = undefined
      if (settled) return
      if (entries.get(instanceId) !== holder) {
        fail(new Error(`实例 ${instanceId} shell 已失效，会话 ${sessionId} 未打开`))
        return
      }
      // 2026-12（design 05 §2.2 修订）——被取代的请求不得再开：同一来源的 open
      // 请求是"最后意图胜出"流（登记入口是 App.openSession 的两个调用点：侧栏
      // `chamberBridge.onOpenSession` 订阅与通知 runner——2026-09-11 review F5 更正：
      // 深链不经本函数，它只激活视图，settlePendingDeepLinkActivation → selectView），
      // 而官方 `sessions.open` 就是一次普通 select，一个用户已经离开的旧
      // 请求会把壳**翻回**旧会话：连点两个会话时可见 X→Y→X/Y 抖动，而 boot 期早开臂
      // 让"最新意图"在 boot 期间就已打开，settle 时的 FIFO flush 会先开旧的那个。
      // 静默 resolve：被放弃的请求不是失败，失败面与行内错误归最新那次请求。
      if (lastRequestedSession.get(instanceId) !== undefined
        && lastRequestedSession.get(instanceId) !== sessionId) {
        succeed()
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
        // TRANSIENT, not terminal: the boot settle (loader.await +
        // assertEntriesActive, boot.ts) only waits on entry ROOT fibers, while
        // ctx.sessions arrives with the session-controller CHILD fiber, which
        // activates only after the async api-remotes namespace mounts
        // (chamber-entry). A queued-open flush — or a click that lands inside
        // that window — used to fail instantly even though the session was
        // moments from opening; each such cold-shell click was a one-shot, and
        // the view had already switched, so the user landed on the target
        // server's UI without the session selected. Poll service readiness on
        // the same retry cadence and budget as the session-list wait.
        scheduleRetry()
        return
      }
      serviceSeen = true
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
      scheduleRetry()
    }
    attempt()
  })
}

/** Register one async entry teardown immediately and fold it into the id-local
 * barrier. Rejections are loud but contained so a broken disposer cannot
 * permanently wedge every future boot for that source. */
function teardownEntry(instanceId: string, entry: AppWebEntry, reason: string): Promise<void> {
  // The source's shell is going away: drop its cached client-plugin graph so a
  // later boot (or the settings panel) re-reads the live plugin set instead of
  // serving a retired incarnation's rows.
  retireSourceClientGraph(instanceId)
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
 * entry lifetime — the source was REMOVED from the registry, or the chamber
 * retention policy reaps an over-limit hidden view — App.tsx reclaimView,
 * 2026 性能整改): dispose the
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
  // The request-stream record retires with the source: a same-id re-add is a new
  // generation, and its first open must not be judged as superseded by the
  // previous incarnation's last request (design 05 §2.2 revision).
  lastRequestedSession.delete(instanceId)
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
  lastRequestedSession.clear()
  pendingOpens.rejectAll(new Error('全部实例 shell 已释放，排队的会话未打开'))
}

/**
 * Lightweight reconnect of one instance's connection loop (S2 sidebar
 * stability, 对齐 ssh 断链自动恢复): the App staleness watchdog calls this
 * when a MOUNTED source's pushed snapshots go silent while the transport
 * still reports ready — the ctx's own reconnect chain is healthy, it only
 * lacks a trigger when a half-open upstream leg (direct-http targets — no
 * ssh keepalive covers them) never fires 'error'/'close'. Reconnect() aborts
 * the current connection generation and opens a fresh one, whose baseline
 * replay re-establishes the workspace follow and resumes pushes. Deliberately
 * NO shell reboot: the shell, ctx stores and UI state stay mounted — only the
 * underlying connection is replaced (the official runtime's reconnect
 * semantics).
 *
 * Guard discipline mirrors dispatchOpen: no holder (never booted / already
 * disposed) and no runtime ctx are no-ops, and every external access is
 * try/catch-wrapped — errors are logged, never thrown (a watchdog timer must
 * not surface into the App).
 *
 * @returns true only when reconnect() was actually invoked — callers use the
 *   return to decide whether a no-op attempt should consume their backoff
 *   window (M4 review fix: a boot-failure retry window or a missing ctx must
 *   not delay the first effective reconnect by a full backoff period).
 */
export function reconnectInstanceConnection(instanceId: string): boolean {
  const holder = entries.get(instanceId)
  if (holder === undefined) return false
  try {
    const ctx = holder.entry.runtimeCtx
    if (ctx === undefined) return false
    // runtimeCtx is a cordis Context whose services live behind a proxy; the
    // connection service is the ConnectionHandle face of
    // @deepseek-ai/dsh-client-connection (ctx.connection.reconnect()).
    // Shape-typed here: the renderer's ambient cordis module only declares
    // the sessions face, so read the connection service through its minimal
    // surface instead of extending vendor-modules.d.ts.
    const connection = (ctx as { connection?: { reconnect(): void } }).connection
    if (connection === undefined || typeof connection.reconnect !== 'function') return false
    connection.reconnect()
    // The ConnectionHandle.reconnect() itself is a silent no-op when the
    // connection loop has no owner (never started / already stopped) — that
    // deep no-op still reports true here. Unreachable for the S2 caller (a
    // source that pushed once has an api-gateway client that started the
    // loop), noted for completeness.
    return true
  } catch (reason) {
    console.error(`[shell] instance ${instanceId} reconnect failed: ${describeShellError(reason)}`)
    return false
  }
}

/** The boot-graph row id this page's manifest must carry (gen-boot-manifest.mjs). */
export const BOOT_PLUGIN_ID = CHAMBER_BOOT
