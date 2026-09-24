/**
 * N-ctx shell orchestration: one AppWebEntry per dsh instance, each an independent cordis
 * ctx with a full ui-* tree in its own container div. Per-instance identity/basePath bind
 * through a closure, so a bounded queue timeout may let a later DIFFERENT-id boot proceed
 * without page-global contamination. Same-id boots stay serialized through the
 * predecessor's settle and async teardown (capped by INSTANCE_TAIL_WAIT_CAP_MS); the
 * generation gate plus the boot-generation fence on producer registration keep a late
 * predecessor superseded (no double-root container survives). Booted shells stay mounted（hide/show 是纯 CSS）；保留策略例外：
 * retention.ts 可在空闲期回收超限隐藏壳，走与注册表删除相同的 disposeInstanceShell
 * 原语（generation cancel + 异步 teardown barrier），实例进程/连接不受影响。
 * 模块表与 bundle 注册表是页面级单例；bundle 通过 module-script 元素加载。
 */



import { AppWebEntry, ensureWebModuleSystem, FIBER_STATE } from '@deepseek-ai/dsh-client-web'
import type { Context } from '@deepseek-ai/cordis'

import { parseAuthoritativeSourceFingerprint } from './deep-link-activation.ts'
import { BOOT_TIMEOUT_MS } from './boot-budget.ts'
import { withDeadline } from '@dsh-chamber/dsh-stream-state'

/** The real clock, injected: the instance tail wait and the boot-chain guard ride
 *  the shared primitive; their budgets stay local constants. */
const SHELL_SCHEDULER = {
  setTimeout: (run: () => void, ms: number): unknown => setTimeout(run, ms),
  clearTimeout: (handle: unknown): void => { clearTimeout(handle as ReturnType<typeof setTimeout>) },
}
// The settled-boot gap fact + its identity live in boot-gap.ts (a leaf) so the
// chamber-entry producer / shell carrier / App renderer triangle stays acyclic.
import {
  bootGapClearMatchesFact, bootGapSignature, isShellDegradedClear, shouldReplaceBootGap,
  type ShellDegradedFact, type ShellDegradedReport,
} from './boot-gap.ts'
// The graph-channel decision (kind) is owned by source-readiness.ts; this module carries it.
import type { GraphGapKind } from './source-readiness.ts'
import { isChamberSourceId, rawInstanceIdFromSourceId } from './transport-source.ts'
import { collectExtraRows, type CollectExtraRowsDeps, type ExtraModuleRow } from './host-graph.ts'
import { BundleLoadTimeoutError } from '@dsh-chamber/dsh-chamber-client-core/client-plugin-loader'
import { chamberBridge, describeThrown, type PluginGraphDiagnostic } from '@dsh-chamber/dsh-chamber-client-core'
// Page-level machine catalog + the page-level instance client it reads through: pure
// modules with no vendor/runtime links.
import {
  createMachineCatalog, type MachineCatalog,
} from '@dsh-chamber/dsh-chamber-client-ui-open-in/machine-catalog'
import {
  hasHealRoute, hasSessionStreamResync, resyncSessionStream, sessionOpenInFlight, sessionOpenState,
  sessionStreamResyncInFlight,
  type SessionsLoose,
} from '@dsh-chamber/dsh-chamber-client-ui-open-in/stream-health-probe'
import { getInstanceClient } from '@dsh-chamber/dsh-chamber-client-core/instance-api'
import { PendingOpenQueue } from './pending-open-queue.ts'
import { PERF_MARKS, perfMark } from './perf-marks.ts'

const CHAMBER_BOOT = '@dsh-chamber/app'
export type ChamberTransport = 'local' | 'ssh' | 'http'

/**
 * The page's ONE machine application catalog: "which apps are installed, their icons,
 * how to launch" describes the MACHINE, not the source on screen, and upstream can read
 * `location.origin` only because one page is served by one host. The chamber reads it
 * once from the LOCAL instance's own api base path (/api/i/local — same route, envelope,
 * cookie and trust fence every entry uses) and injects the settled catalog into every
 * entry's Context (one page, one machine). A failing read is fail-closed inside the
 * catalog (empty pool), so a stopped local instance degrades marks instead of breaking boot.
 */
let pageMachineCatalog: MachineCatalog | null = null

function machineCatalogForPage(): MachineCatalog {
  pageMachineCatalog ??= createMachineCatalog({
    call: (endpoint, args, signal) => getInstanceClient('local').callUnary(endpoint, args, signal),
  })
  return pageMachineCatalog
}

/** Never-throwing error text for external runtime stores/plugins (shared impl,
 *  client-core error-text.ts): their proxies may throw from traps too. */
function describeShellError(reason: unknown): string {
  return describeThrown(reason)
}

/** Direct opens get 8s of list polling; queued opens keep their 68s total deadline and receive at most this remaining dispatch time. */
const OPEN_WAIT_MS = 8000
const OPEN_RETRY_MS = 400

/** Loose mirror of the vendored cordis Entry reached through `ctx.loader.entries()`. */
export interface BootLoaderEntryFace {
  options: { name: string }
  fiber?: { state: number }
}

/**
 * The plugin ids that did NOT activate in a failed boot — the item list the official
 * failure report shows. Upstream derives it from its post-settle sweep and renders one
 * item per id; the chamber overlay replaced that page, so the SAME live loader is read
 * here BEFORE teardown and the ids travel on the ShellState the App already receives — no
 * new channel, no invented list. Tolerated extra rows are excluded (their version skew
 * must never fail a boot; their own failure is reported per id while the boot succeeds).
 */
export function collectFailedEntries(
  ctx: { loader?: { entries(): readonly BootLoaderEntryFace[] } } | undefined,
  tolerated: ReadonlySet<string> = new Set(),
): string[] {
  if (ctx === undefined) return []
  let entries: readonly BootLoaderEntryFace[]
  try {
    // External code: a hostile proxy must not turn a failure report into a second failure.
    entries = ctx.loader?.entries() ?? []
  } catch {
    return []
  }
  const out: string[] = []
  for (const entry of entries) {
    const name = entry?.options?.name
    if (typeof name !== 'string' || name === '' || tolerated.has(name)) continue
    if (entry.fiber !== undefined && entry.fiber.state === FIBER_STATE.ACTIVE) continue
    if (!out.includes(name)) out.push(name)
  }
  return out
}

/**
 * How long one boot may hold the serialized queue before the chain moves on: a vendor
 * entry.run() that never settles must not wedge every later DIFFERENT-id boot. Same-id
 * successors first await their predecessor's full settle/teardown, then join the global tail.
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
    // A hung bundle must not keep this boot pending forever — fail loud on the graph
    // fetch's order of magnitude. Removing a module element does not cancel its fetch, so
    // leave it attached; host-graph tombstones it and observes bundleOutcome.
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
  /** Boot failure report (run() rejection or a resolved-but-failed boot) — null on a clean settle. */
  error: string | null
  /** Plugin ids of a FAILED boot: every loader entry that did not activate, in loader
   *  order. Omitted when the boot failed before any loader entry existed. */
  failedEntries?: string[]
  /**
   * The boot settled with a KNOWN gap the App self-heals by re-booting on the ready
   * transition; the fact also has a user surface. Kinds:
   *  - `graph-unavailable`: the source never served its client plugin graph in the window
   *    (ui-chat pends on sidebarRight; the conversation view never registers);
   *  - `local-graph-not-injected`: the LOCAL graph endpoint answered 404/method-missing —
   *    a chamber-side installation fact, not the legitimate gateway/mobile shape;
   *  - `required-services-missing`: graph WAS available but a required service never
   *    materialized; `deferred-registration-failed`: a deferred family's chunk never loaded.
   * SINGLE SLOT: the last reported fact wins; two producers can fire in one boot (deferred
   * at ~0ms, probe at 5s), so only the later verdict is shown — both stay on console.error.
   */
  degraded: ShellDegradedFact | null
}

/** The shape lives in the leaf module boot-gap.ts (shared with chamber-entry producers
 *  and the App without an import cycle); re-exported for this module's consumers. */
export type { ShellDegradedFact } from './boot-gap.ts'

/** One serialized boot queue shared by every instance (module/plugin discipline). */
let bootChain: Promise<void> = Promise.resolve()

/** Build the per-entry Context initializer: the closure owns immutable values. */
export function createChamberContextSetup(
  instanceId: string,
  basePath: string,
  sourceFingerprint: string,
  transport: ChamberTransport = instanceId === 'local' ? 'local' : 'ssh',
  bootGeneration?: number,
  reportBootDegraded?: (report: ShellDegradedReport) => void,
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
    // The machine catalog is a PAGE fact, not per-source: every entry reads the same
    // instance the shell built for the LOCAL instance — a remote source cannot serve it.
    ctx.provide('chamberMachineCatalog', machineCatalogForPage())
    // 代际事实：生产者注册按注册顺序授权，挂死后恢复的老 boot 会夺走生产权，
    // 其 teardown clear 会把健康后继的通道清空——消费者按它做代际栅栏。
    if (bootGeneration !== undefined) ctx.provide('chamberBootGeneration', bootGeneration)
    // Post-settle producers report a STRUCTURED gap through this seam; the App re-boots
    // the instance and renders the same whole fact (never parsing the diagnostic message).
    if (reportBootDegraded !== undefined) {
      ctx.provide('chamberReportBootDegraded', reportBootDegraded)
    }
  }
}

/**
 * Boot cancellation (view lifetime = registry entry lifetime): `bootGenerations` hands each
 * boot the next generation; `disposeInstanceShell` records the highest pending generation,
 * and a boot at or below the threshold is torn down on settle instead of registered.
 * Per-boot generations keep cancellation exact (remove→re-add→remove cancels both pending
 * boots; a boot after the last removal registers normally).
 */
const bootGenerations = new Map<string, number>()

/** Page-monotonic boot serial (never per-id, never reused): the post-settle fact path
 * compares it, so a stale producer cannot pass by landing on a reused generation. */
let bootSerialCounter = 0
const cancelledBoots = new Map<string, number>()

type DispatchCancel = (error: Error) => void

/** One exact live generation. Pollers belong to the holder, so replacement/teardown can
 * cancel them before an old runtime ever reaches sessions.open(). */
interface ShellHolder {
  entry: AppWebEntry
  activeDispatchCancels: Set<DispatchCancel>
  /** Monotonic per-PAGE boot serial (never reused): the pending replay and the holder
   *  identity compare it, so a stale producer cannot land on a reused generation. */
  serial: number
  /** The VIEW's state channel (the bootInstanceShell `onState` argument). A degrade after
   *  settle is republished here so the view's own copy stays true; it is NOT what reaches the App. */
  onState?: (next: ShellState) => void
  /** App-facing sink for POST-SETTLE republishes — deliberately distinct from `onState`
   *  (the view's setter, which never reaches the App's `shellStates` mirror read by the
   *  banner, projections and self-heal). Absent in hosts that boot without an App. */
  onRepublish?: (instanceId: string, next: ShellState) => void
  lastState?: ShellState
}

/**
 * Reports that arrived BEFORE their boot settled. A slow boot can outlive the probe's 5s
 * timer and the deferred cluster's report races the same window; dropping those lost the
 * boot's only user-visible verdict. The newest report per id waits here, keyed by boot
 * SERIAL so only the loading boot can claim it, and LAST-WINS like the live path.
 * Cleared on teardown, cleanup and boot failure.
 */
const pendingDegrades = new Map<string, { serial: number; report: ShellDegradedReport }>()

/**
 * Record a post-settle degrade (or retraction) on the live holder and republish. No-op
 * when the instance has no holder, its boot failed, or the report changes nothing (same
 * signature). Identity is {@link bootGapSignature}, not the kind alone: a re-armed pass
 * can name a LARGER missing set, so kind-only comparison would drop the richer verdict.
 * A {@link ShellDegradedClear} retracts only the fact it exactly matches (kind AND
 * payload), so a newer verdict is never erased; a no-op retraction does not republish.
 */
function reportSettledDegrade(instanceId: string, report: ShellDegradedReport, serial: number): void {
  const holder = entries.get(instanceId)
  // A holder of ANOTHER boot owns the slot: this report is from a dead incarnation and
  // must never spread that holder's `lastState`.
  if (holder !== undefined && holder.serial !== serial) return
  if (holder?.lastState === undefined || holder.onState === undefined) {
    // Still booting: hold the NEWEST report (last-wins) for the settle that is coming;
    // only a boot with this serial may claim it.
    pendingDegrades.set(instanceId, { serial, report })
    return
  }
  if (!holder.lastState.booted) return
  const current = holder.lastState.degraded
  if (isShellDegradedClear(report)) {
    if (!bootGapClearMatchesFact(current, report)) return
    // Retraction: the condition no longer holds, so the user surface must go away.
    const cleared: ShellState = { ...holder.lastState, degraded: null }
    holder.lastState = cleared
    holder.onState(cleared)
    holder.onRepublish?.(instanceId, cleared)
    return
  }
  if (current !== null && bootGapSignature(current) === bootGapSignature(report)) return
  // Cause outranks consequence: a still-current higher-priority fact is not overwritten by its symptom.
  if (!shouldReplaceBootGap(current, report)) return
  const next: ShellState = { ...holder.lastState, degraded: report }
  holder.lastState = next
  holder.onState(next)
  holder.onRepublish?.(instanceId, next)
}

/** The live AppWebEntry holder per booted instance (unmount on teardown). */
const entries = new Map<string, ShellHolder>()

/** Strict per-id lifecycle tail: a successor waits for the predecessor's full task
 * (including teardown) before joining the global boot queue. */
const instanceBootTails = new Map<string, Promise<void>>()
/** When the id's current boot started (absolute same-id wait deadline). */
const instanceBootStartedAt = new Map<string, number>()

/** Every async AppWebEntry.dispose() currently in flight, folded per id. */
const instanceTeardownBarriers = new Map<string, Promise<void>>()

/** Reclaim per-id generation owners only after the exact current tail and teardown
 * barrier settled. The identity checks are essential: remove→same-id re-add may install a newer tail. */
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
    // A stash belongs to a boot that never settled; once the id is free it can only mislead.
    pendingDegrades.delete(instanceId)
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
 * The LAST session each instance was asked to open — the renderer-side record of the
 * per-source request stream (every open enters through {@link openInstanceSession}).
 * It survives the settle of the request that set it. Cleared by
 * {@link disposeInstanceShell} / {@link disposeAllShells}, so a same-id re-add is a NEW
 * generation whose first open is never judged as superseded by the previous incarnation's
 * request. Dispatch always writes its own request first, so leftover records elsewhere
 * are inert.
 */
const lastRequestedSession = new Map<string, string>()

/** Test-only seam: read one source's supersede record — its retirement is not observable
 *  through the public surface, so this is the only way to pin the map's stated invariant. */
export function __testLastRequestedSession(instanceId: string): string | undefined {
  return lastRequestedSession.get(instanceId)
}

/** settle 事实的唯一判据：booted 或已失败；retention 候选、预热槽、推迟回收臂与
 *  视图遮罩分类共用它，避免各处自写 `booted || error !== null` 漂移。 */
export function isSettledShellState(state: ShellState | undefined): boolean {
  return state !== undefined && (state.booted || state.error !== null)
}

export function shellStateIdle(instanceId: string, basePath: string): ShellState {
  return { instanceId, basePath, booted: false, booting: false, error: null, degraded: null }
}

/** Boot (or queue) the instance shell into `el`; returns the settled state. Boots
 *  normally serialize page-level module materialization while instance facts stay private. */
export function bootInstanceShell(
  instanceId: string,
  basePath: string,
  el: HTMLElement,
  onState: (next: ShellState) => void,
  sourceFingerprint: string,
  transport: ChamberTransport = instanceId === 'local' ? 'local' : 'ssh',
  /** App-owned seams: `waitForServing` lets the host-graph fetch wait for a
   *  still-starting source instead of losing its client plugins. */
  options: {
    waitForServing?: (instanceId: string) => Promise<boolean>
    /** App-owned sink for post-settle republishes; the caller passes the SAME handler
     *  as `onStateChange` (the view's `onState` cannot reach the App's mirror). */
    onRepublish?: (instanceId: string, state: ShellState) => void
    /** Test seam: host-graph retry budget (attempts/delayMs/sleep). Production keeps
     *  the shipped 10×500ms window. */
    retry?: CollectExtraRowsDeps['retry']
  } = {},
): Promise<ShellState> {
  // perf 埋点：boot 入口（含全局队列排队；注册表见 perf-marks.ts）。
  perfMark(PERF_MARKS.shellBootStart)
  // Validate the source/base-path pair before installing module globals or starting the
  // host-graph request. 取序在入队前：dispose 阈值与 settle 检查都按本次 boot 的代；也在
  // configureContext 之前，因为上下文要携带本次代际事实。
  const gen = (bootGenerations.get(instanceId) ?? 0) + 1
  bootGenerations.set(instanceId, gen)
  // Page-monotonic serial: unlike `gen` it is NEVER reused, so it identifies the post-settle fact path.
  const serial = ++bootSerialCounter
  // Only the current, non-cancelled generation may publish.
  const mayPublish = (): boolean =>
    bootGenerations.get(instanceId) === gen && (cancelledBoots.get(instanceId) ?? 0) < gen
  /** Degrade facts of this boot: `graphUnavailable` is known before settle; the entry's
   *  producers arrive later and are republished through the holder. */
  let graphUnavailable: { kind: GraphGapKind; message: string } | null = null
  const reportPluginDiagnostic = (sourceId: string, diagnostic: PluginGraphDiagnostic): void => {
    if (!mayPublish()) return
    chamberBridge.reportPluginDiagnostic(sourceId, diagnostic)
  }
  /** The ONE fenced writer for post-settle gaps: a superseded boot's late verdict must
   *  never overwrite a healthy successor's state. */
  const reportBootDegraded = (report: ShellDegradedReport): void => {
    if (!mayPublish()) return
    reportSettledDegrade(instanceId, report, serial)
  }
  const configureContext = createChamberContextSetup(
    instanceId, basePath, sourceFingerprint, transport, gen, reportBootDegraded)
  const previousInstanceTail = instanceBootTails.get(instanceId)
  // 前代 boot 的起始时刻（绝对等待上限用）：必须在覆盖本代记录之前读取。
  const previousInstanceBootStartedAt = instanceBootStartedAt.get(instanceId)
  const before: ShellState = { instanceId, basePath, booted: false, booting: true, error: null, degraded: null }
  onState(before)
  // A completed boot has no instance tail, but removing/replacing its live holder
  // registers an async teardown barrier synchronously — capture it before any page-global preloading.
  const previousTeardownBarrier = instanceTeardownBarriers.get(instanceId)
  const hadLiveHolder = entries.has(instanceId)
  const previousInstanceBoot = Promise.all([
    previousInstanceTail ?? Promise.resolve(),
    previousTeardownBarrier ?? Promise.resolve(),
  ]).then(() => undefined)
  // The page-level module table must be installed before ANY bundle executes: extra
  // bundles self-register at script execution, and a missing sink makes the official
  // bundle's top-level handoff throw. ensureWebModuleSystem is idempotent; a malformed
  // manifest throws here, skipping extra preload, and run() still fails loud with it.
  let moduleSystemError: string | null = null
  let modulesSystem: ReturnType<typeof ensureWebModuleSystem> | null = null
  try {
    modulesSystem = ensureWebModuleSystem({ loadBundle: loadModuleBundle })
  } catch (reason) {
    moduleSystemError = describeShellError(reason)
  }
  // Const capture: TS does not narrow a mutable captured variable inside the closure below.
  const installedModulesSystem = modulesSystem
  // Ordering gate: the covered factory for ui-primitives is registered by the chamber
  // entry itself, so this entry must finish evaluating before ANY extra bundle executes.
  // Prefetch fires now, in parallel with the host-graph fetch; failures are swallowed
  // (loader.create's create-side re-import is the loud surface, uncached on failure).
  let chamberEval: Promise<void> | null = null
  const fireChamberPrefetch = (): void => {
    if (chamberEval !== null) return
    chamberEval = (async () => {
      try {
        if (installedModulesSystem !== null) await installedModulesSystem.prefetch(CHAMBER_BOOT)
      } catch {
        // 吞掉：loud 面在 loader.create 的 create-side import 重取。
      }
    })()
  }
  // Host-graph/bundle preloading may overlap the global queue for a source with no same-id
  // predecessor; a same-id successor MUST defer it until its strict instance tail settles.
  const startExtraRows = (): Promise<ExtraModuleRow[]> => {
    // chamber prefetch 与 host-graph 取图并行；collectExtraRows 装载 extra bundle 前 await 本门。
    fireChamberPrefetch()
    const promise = moduleSystemError === null
      ? collectExtraRows(instanceId, basePath, {
        loadModuleBundle,
        awaitBeforeLoad: () => chamberEval ?? Promise.resolve(),
        // A retry may start before the previous queued boot settled — the generation guard covers it.
        reportDiagnostic: reportPluginDiagnostic,
        // 503 = the source is still starting; wait for it instead of booting without client plugins.
        ...(options.waitForServing === undefined ? {} : { waitForServing: options.waitForServing }),
        ...(options.retry === undefined ? {} : { retry: options.retry }),
        onGraphUnavailable: (message, kind) => { if (mayPublish()) graphUnavailable = { kind, message } },
      })
      : Promise.resolve<ExtraModuleRow[]>([])
    // An eager different-id prefetch may reject while waiting for its global slot; run awaits it.
    void promise.catch(() => undefined)
    return promise
  }
  const eagerExtraRows = previousInstanceTail === undefined
    && previousTeardownBarrier === undefined
    && !hadLiveHolder
    ? startExtraRows()
    : undefined
  const tailDeadlineAt = previousInstanceBootStartedAt === undefined
    ? undefined
    : previousInstanceBootStartedAt + INSTANCE_TAIL_WAIT_CAP_MS
  const tailRemainingMs = previousInstanceBoot === undefined
    ? 0
    : tailWaitRemainingMs(tailDeadlineAt, Date.now())
  const task = (tailRemainingMs <= 0
    ? Promise.resolve()
    : withDeadline<undefined>(
      previousInstanceBoot.then(() => undefined, () => undefined),
      { ms: tailRemainingMs, onExpire: () => undefined, scheduler: SHELL_SCHEDULER },
    ).then(() => undefined)
  ).then(() => {
    const runTask = bootChain.then(async () => {
    let staleEntry: AppWebEntry | undefined
    // Hoisted so the catch arm can apply the SAME tolerated-row filter the failed-entry
    // sweep uses; it stays [] until the rows resolved, so the filter never guesses.
    let extraRows: ExtraModuleRow[] = []
    try {
      let blocked: ReturnType<typeof blockedBoot>

      /** Drain every same-id teardown and retire a live predecessor; run both before a
       *  deferred preload and after every preload (a removal may begin while in flight). */
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
          // Defensive direct replacement: duplicate callers must retire and AWAIT a live holder.
          const previousHolder = entries.get(instanceId)
          if (previousHolder === undefined) return undefined
          entries.delete(instanceId)
          await disposeHolder(instanceId, previousHolder, 'shell replaced by a newer generation')
        }
      }

      if (eagerExtraRows !== undefined) {
        extraRows = await eagerExtraRows
      } else {
        const stopped = await retireSameIdPredecessors()
        if (stopped !== undefined) return stopped
        extraRows = await startExtraRows()
      }

      // Host boot-graph merge: the composite covers the whole official shell; client
      // plugins in the instance's profile arrive as rows the composite does not cover and
      // their bundles must preload BEFORE loader.create materializes entries. Re-check for
      // a remove/retry that began while this request was in flight.
      const stoppedAfterPreload = await retireSameIdPredecessors()
      if (stoppedAfterPreload !== undefined) return stoppedAfterPreload

      // Bind instance facts to THIS entry instead of page globals: configureContext runs
      // synchronously before loader/plugin materialization. perf 埋点：boot 内核即将接管。
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
        // Registration is guarded by BOTH cancellation and current generation: a same-id
        // successor awaits this entire task, so a timed-out predecessor is fully retired.
        await teardownEntry(instanceId, entry, 'stale boot')
        // Pending opens are keyed by instance, so an old generation must not reject its
        // replacement's queued requests; if still current, they must fail loud.
        if (bootGenerations.get(instanceId) === gen) rejectPendingOpens(instanceId, blocked.message)
        return { instanceId, basePath, booted: false, booting: false, error: blocked.message, degraded: null } satisfies ShellState
      }
      // chamber: run() RESOLVES on boot-chain failures by design (the official loading page
      // renders the report), but the chamber needs the failure to show its own retry/server
      // fallback. Treat a resolved-but-failed boot as a failure: dispose the entry and
      // project the error like a rejection.
      const bootFailure = entry.bootError
      if (bootFailure !== undefined) {
        // Read the failed loader entries NOW (the ctx is live until teardown) so the
        // overlay can list the same ids; guard a hostile runtimeCtx getter like every boundary.
        let failedEntries: string[] = []
        try {
          failedEntries = collectFailedEntries(
            entry.runtimeCtx,
            new Set(extraRows.map(row => row.id)),
          )
        } catch (error) {
          console.error(`[shell] instance ${instanceId} failed-entry sweep unavailable:`, error)
        }
        await teardownEntry(instanceId, entry, 'failed boot')
        if (bootGenerations.get(instanceId) === gen) {
          rejectPendingOpens(instanceId, bootFailure)
          // 与 catch 分支同代际门控：teardown await 期间可能换代。
          perfMark(PERF_MARKS.shellBootFailed, instanceId)
        }
        return {
          instanceId, basePath, booted: false, booting: false, error: bootFailure, degraded: null,
          ...(failedEntries.length === 0 ? {} : { failedEntries }),
        } satisfies ShellState
      }
      // An older timed-out boot may have begun teardown while this entry ran: drain it
      // before registration so the final barrier/holder checks and entries.set are atomic.
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
          : { kind: graphUnavailable.kind, message: graphUnavailable.message },
      }
      const holder: ShellHolder = {
        entry, activeDispatchCancels: new Set(), serial, onState, onRepublish: options.onRepublish, lastState: settled,
      }
      entries.set(instanceId, holder)
      // A verdict stashed while this boot was loading; the serial check keeps a dead incarnation out.
      const pending = pendingDegrades.get(instanceId)
      if (pending !== undefined) {
        pendingDegrades.delete(instanceId)
        if (pending.serial === serial) reportSettledDegrade(instanceId, pending.report, serial)
      }
      // 注册成功即清旧阈值：同 id 尾已让前代完成/被判 superseded，current-generation
      // 门覆盖 await 期间被新代取代的情形；残留阈值只会扩大 Map。
      cancelledBoots.delete(instanceId)
      flushPendingOpens(instanceId)
      // perf 埋点：该实例 shell 成功 settle（真实 UI 可用的最近似点）。
      perfMark(PERF_MARKS.shellSettled, instanceId)
      return settled
    } catch (reason) {
      const message = describeShellError(reason)
      // catch 兜底：run() 不拒绝（失败经 bootError 上浮），但构造期/挂载期的同步异常
      // 仍可能在此抛出且 live ctx 已存在。先 dispose（移除 boot DOM / 卸载 root），重试
      // 才能干净重 boot；读取失败清单与 try 分支同规矩（teardown 前读、try 包裹、
      // 容忍集合来自已解析的 extra rows）。
      let caughtFailedEntries: string[] = []
      try {
        caughtFailedEntries = collectFailedEntries(
          staleEntry?.runtimeCtx,
          new Set(extraRows.map(row => row.id)),
        )
      } catch (error) {
        console.error(`[shell] instance ${instanceId} failed-entry sweep unavailable:`, error)
      }
      if (staleEntry !== undefined) {
        const registered = entries.get(instanceId)
        if (registered?.entry === staleEntry) {
          entries.delete(instanceId)
          await disposeHolder(instanceId, registered, 'boot failed after registration')
        } else {
          await teardownEntry(instanceId, staleEntry, 'boot exception')
        }
      }
      // 失败的旧代不能清掉新代排队的 opens；只有仍为 current 的失败 boot 才拥有该队列，
      // 才打失败 perf 标记。
      if (bootGenerations.get(instanceId) === gen) {
        rejectPendingOpens(instanceId, message)
        perfMark(PERF_MARKS.shellBootFailed, instanceId)
      }
      // The failure overlay owns the surface; a stashed verdict must not linger.
      pendingDegrades.delete(instanceId)
      return {
        instanceId, basePath, booted: false, booting: false, error: message, degraded: null,
        ...(caughtFailedEntries.length === 0 ? {} : { failedEntries: caughtFailedEntries }),
      } satisfies ShellState
    }
    })
    // 页面级链推进超时护栏：永不 settle 的 boot 在 BOOT_TIMEOUT_MS 后只放行其他 id；
    // runTask 仍被本 id 的 instance tail 持有。never rejects；到期只 LOG，晚 settle
    // 仍受代际门控。
    bootChain = withDeadline<ShellState | undefined>(
      runTask.then(value => value, () => undefined),
      {
        ms: BOOT_TIMEOUT_MS,
        onExpire: () => {
          console.error(`[shell] boot timed out after ${BOOT_TIMEOUT_MS}ms — queue continues (late settle remains generation-gated)`)
          return undefined
        },
        scheduler: SHELL_SCHEDULER,
      },
    ).then(() => undefined)
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
 * Absolute cap on a same-id predecessor that never settles. The strict per-id tail must
 * stay (releasing early would let a late abandoned boot register over its successor), but
 * an unbounded wait pins the id forever. Two boot budgets: past a slow-but-healthy
 * predecessor and below the App's 135s harvest-abandon cap.
 */
export const INSTANCE_TAIL_WAIT_CAP_MS = BOOT_TIMEOUT_MS * 2

/**
 * Remaining wait for a same-id predecessor. All successors share the ABSOLUTE deadline
 * (predecessor start + cap) instead of arming a fresh cap each — otherwise a retry at the
 * abandon cap would wait a whole extra cap.
 */
export function tailWaitRemainingMs(deadlineAt: number | undefined, now: number): number {
  if (deadlineAt === undefined) return INSTANCE_TAIL_WAIT_CAP_MS
  return Math.max(0, deadlineAt - now)
}


/**
 * Request opening one session: dispatch when the shell already booted, else queue for the
 * boot-settle flush. Resolves once the runtime accepted the open (sessions may still be
 * activating after settle; dispatch polls up to 8s, and a pre-boot request keeps its
 * original 68s total deadline across the flush).
 */
export function openInstanceSession(instanceId: string, sessionId: string): Promise<void> {
  // Record the request stream BEFORE dispatching: the dispatcher drops requests a newer
  // one superseded, and the record must hold THIS request when its own dispatch starts.
  lastRequestedSession.set(instanceId, sessionId)
  const holder = entries.get(instanceId)
  if (holder !== undefined) return dispatchOpen(instanceId, holder, sessionId)
  return pendingOpens.enqueue(instanceId, sessionId)
}

function currentSessionFace(instanceId: string): SessionsLoose | undefined {
  try { return entries.get(instanceId)?.entry.runtimeCtx?.sessions as unknown as SessionsLoose | undefined }
  catch { return undefined }
}

/** The page-level recovery seat reads the same concrete session as the header seat. */
export function readInstanceSessionStreamHealth(instanceId: string, sessionId: string): {
  openState: 'cold' | 'loading' | 'open' | 'error'
  openInFlight: boolean | undefined
  resyncInFlight: boolean
  resyncAvailable: boolean
  /** The header's stage move is usable: current, listed, and a listed neighbour. */
  healRoute: boolean
} | null {
  const sessions = currentSessionFace(instanceId)
  const openState = sessionOpenState(sessions, sessionId)
  if (openState === undefined) return null
  return {
    openState,
    openInFlight: sessionOpenInFlight(sessions, sessionId),
    resyncInFlight: sessionStreamResyncInFlight(sessions, sessionId),
    resyncAvailable: hasSessionStreamResync(sessions, sessionId),
    healRoute: hasHealRoute(sessions, sessionId),
  }
}

export function rebuildInstanceSessionStream(instanceId: string, sessionId: string): boolean {
  return resyncSessionStream(currentSessionFace(instanceId), sessionId)
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
 * Dispatch one open through one EXACT settled holder/runtime ctx. The boot settle waits
 * only on entry ROOT fibers, so ctx.sessions (a child fiber behind async api-remotes
 * mounts) can register after the holder exists; the poll covers service readiness and
 * list visibility within the same deadline, with distinct terminal reports. Every retry
 * and the final sessions.open re-check holder identity; teardown cancels the poller.
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

    // Whether the runtime sessions service was EVER observed, to pick the terminal report.
    let serviceSeen = false

    const timeout = (): void => {
      // One last guarded read: the service may have registered inside the final
      // OPEN_RETRY_MS window — never blame boot readiness for a service present by deadline.
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

    /** Schedule the next poll inside the remaining budget; at the deadline the report fires. */
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
      // 被取代的请求不得再开：同一来源的 open 是「最后意图胜出」流，官方 sessions.open
      // 只是普通 select，一个已离开的旧请求会把壳翻回旧会话（连点两个会话可见抖动）。
      // 静默 resolve：被放弃的请求不是失败，失败面归最新那次请求。
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
        // runtimeCtx is shell-owned, but Cordis lookup may be a throwing proxy: same boundary.
        sessions = holder.entry.runtimeCtx?.sessions
      } catch (err) {
        fail(new Error(describeShellError(err)))
        return
      }
      if (sessions === undefined) {
        // TRANSIENT, not terminal: the settle only waits on ROOT fibers while ctx.sessions
        // arrives with the session-controller CHILD fiber (after async api-remotes mounts).
        // Poll service readiness on the same cadence/budget as the list wait.
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
        // getSnapshot() is external synchronous code and may re-enter teardown; re-check now.
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

/** Register one async teardown into the id-local barrier; rejections are loud but contained
 * so a broken disposer cannot wedge every future boot for that source. */
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
 * Tear down ONE instance's shell (the source was REMOVED from the registry, or the
 * retention policy reaps an over-limit hidden view): dispose the AppWebEntry and drop the
 * entry and pending/active opens; async ctx teardown becomes an id-local barrier a re-added
 * source must await, and a queued/in-flight boot is cancelled on settle (cancelledBoots).
 * The container div is React's to remove. Connection state never reaps a shell.
 */
export function disposeInstanceShell(instanceId: string): void {
  // Cancel through the generation current at disposal time: a live holder does not imply
  // there is no newer queued/in-flight same-id boot, and a missing threshold would let it
  // resurrect a removed source after this holder is torn down.
  const currentGeneration = bootGenerations.get(instanceId) ?? 0
  cancelledBoots.set(instanceId, Math.max(cancelledBoots.get(instanceId) ?? 0, currentGeneration))
  // The record retires with the source: a same-id re-add is a new generation, and its
  // first open must not be judged as superseded by the previous incarnation's last request.
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
 * Tear down every mounted shell (window unload / crash screen). In-flight or queued boots
 * must also be cancelled: a boot settling after this call would re-register its entry and
 * either overwrite a retry's fresh entry (leaking its ctx) or double-root the container.
 */
export function disposeAllShells(): void {
  // Invalidate every identity before any teardown can re-enter dispatch; holders reject synchronously.
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
 * Lightweight reconnect of one instance's connection loop: the App staleness watchdog
 * calls this when a MOUNTED source's pushed snapshots go silent while the transport still
 * reports ready (a half-open upstream leg never fires 'error'/'close'). Reconnect() aborts
 * the current connection generation and opens a fresh one, whose baseline replay
 * re-establishes the workspace follow. NO shell reboot. Guards mirror dispatchOpen (no
 * holder / no ctx are no-ops; external access is try/catch-wrapped; errors logged, never
 * thrown). Returns true only when reconnect() was invoked, so callers can decide whether a
 * no-op attempt consumes their backoff window.
 */
export function reconnectInstanceConnection(instanceId: string): boolean {
  const holder = entries.get(instanceId)
  if (holder === undefined) return false
  try {
    const ctx = holder.entry.runtimeCtx
    if (ctx === undefined) return false
    // Shape-typed: the ambient cordis module only declares the sessions face, so read the
    // connection service through its minimal surface instead of extending vendor-modules.d.ts.
    const connection = (ctx as { connection?: { reconnect(): void } }).connection
    if (connection === undefined || typeof connection.reconnect !== 'function') return false
    connection.reconnect()
    // ConnectionHandle.reconnect() is a silent no-op with no owner (deep no-op still reports
    // true here); unreachable for this caller.
    return true
  } catch (reason) {
    console.error(`[shell] instance ${instanceId} reconnect failed: ${describeShellError(reason)}`)
    return false
  }
}
