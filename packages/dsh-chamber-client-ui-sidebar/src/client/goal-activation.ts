/**
 * Goal activation tracker (design 19 §3.2.2, P1) — the client
 * half that feeds the event-cached `activation` field of {@link GoalFact}.
 *
 * `goal/activation-changed` is the ONLY source. `goals/get` is deliberately
 * NEVER called (R3-verified): the host's agent lookup is overwritten with
 * resolveAgent→resume, so a read would RESUME cold sessions — a write face that
 * violates design 17 §10.7 ("no write face at all"). The forwarded event
 * allow-list already carries this event, so the tracker only subscribes.
 *
 * Access discipline (`ctx.get('remote')`):
 * the sidebar's `inject` list is NOT extended for this feature (the remote
 * service is provided by the api-gateway client, which may not be ready when
 * this plugin applies). Reading a not-yet-provided cordis service can THROW
 * from the service proxy (not return undefined), so every access is inside
 * try/catch and a failed subscription is retried a BOUNDED number of times with
 * an injected timer; after exhaustion the tracker stays inert (activation
 * stays unknown ⇒ the notification layer's unknown-hold, never a fabricated
 * disarmed) and warns once. A NON-throwing `$on` call is a successful
 * registration even when it returns no disposer: `undefined`/any other value
 * is accepted without a retry (a retry would register duplicate listeners),
 * warns once, and stale deliveries are discarded by the per-generation
 * listener guard instead of an unsubscribe.
 *
 * Parsed wire (the frozen `GoalActivationChanged` payload, vendor
 * packages/goal/goal/src/types.ts:75-87): `{ sessionId, goal?: { id, revision,
 * activation } }`. The nested `goal` view is the PRIMARY source; `goal`
 * absent is the host's explicit "no current goal" (that session's cache is
 * cleared), and `goal.id` binds the value to its goal so an edge for ANOTHER
 * goal never lands on the currently projected one. The P2b row rule is unified
 * here (2026-12/F14) for the BOUND-ID-MISMATCH case only: a bound edge whose
 * projection names a DIFFERENT goalId is RETAINED — whatever ids the
 * projection moves through in between — and the identity guard
 * ({@link GoalActivationTracker.activationOf}) withholds it the whole time.
 * It leaves with the session/row, an explicit no-goal delivery OR a goal:null
 * projection (P1's existing delete-on-null semantics: null is never retained),
 * a new event overwriting it, or reset/dispose. The top-level
 * `activation`/`armed`/`active` aliases stay as a documented fallback for
 * the legacy/test shapes; a malformed nested `goal` is shape drift, never a
 * guess.
 *
 * Refresh triggers (v5 §2.2, mirroring the official source's *when* — not its
 * read path): running changes in both directions, every goal-projection change,
 * and `connection/reset`. On those triggers the cache is re-scanned:
 * - a session that left the report loses its cache (行消失即 drop);
 * - an explicit `null` (no goal) loses it;
 * - a DIFFERENT goalId keeps the entry but never merges it (activation never
 *   transfers to another goal on the same session id — the identity guard
 *   withholds the bound value; a same-goal revision change keeps it applying);
 * - unknown goal facts keep the last-known cache (v5 §2.1 retention).
 * The cache is bounded by {@link MAX_ACTIVATION_CACHE} (B4-1; LRU eviction for
 * ghost events, counted + warned once).
 * `connection/reset` clears the whole cache (it belongs to the dead
 * generation), drops the dead generation's subscription, re-reports via
 * `sync()` because the resolved values changed — the App's identity dedupe
 * must see the unknown regression — and re-subscribes with a FRESH bounded
 * budget, because the remote service may have gone away with the generation.
 *
 * A parsed-value change (including a `goal/activation-changed` landing while
 * the goal is already active) MUST call `sync()` so the producer re-reports
 * with the new activation in the runtime signature — a durable-state-free
 * `armed` would otherwise be frozen away by the App's identity dedupe (v5
 * §2.1 signature discipline).
 *
 * Plain module, no React/DOM; timers and remote access are injected so the
 * state machine is node:test-runnable.
 */
import type { InstanceRuntimeReport } from '@dsh-chamber/dsh-chamber-client-core/aggregate-store'
import type { GoalFact } from '@dsh-chamber/dsh-chamber-client-core/session-row-state'

/** The two deterministic activation values of the forwarded event. */
export type GoalActivation = 'armed' | 'disarmed'

/** Forwarded event name (v5 §2.2; already on the gateway allow-list). */
export const GOAL_ACTIVATION_EVENT = 'goal/activation-changed'

/**
 * Bound of the per-generation activation cache (B4-1). A host can emit
 * `goal/activation-changed` for session ids no projection ever carries (ghost
 * ids); those edges are retained (P2b identity binding) until a scan sees the
 * session leave the report — and a scan only runs on an observed report
 * change — so a pure ghost-event flood must be bounded here. 2000 mirrors the
 * P2a gateway's `MAX_PENDING_GOAL_ACTIVATIONS = MAX_SESSIONS`
 * (packages/gateway/src/session-state.ts). Overflow evicts the
 * least-recently-updated key (delete-then-set refresh, same as P2a), is
 * counted in {@link GoalActivationTracker.evictedCount} and warns once (a cap
 * drop is never silent).
 */
export const MAX_ACTIVATION_CACHE = 2_000

/**
 * One parsed activation fact. `activation === null` is the frozen wire's
 * `goal`-absent form: the host's projection has NO current goal for that
 * session, so the cache entry (not the goal fact) is cleared.
 */
export interface GoalActivationEvent {
  sessionId: string
  activation: GoalActivation | null
  /**
   * `goal.id` of the frozen payload when it carried a usable one — the goal
   * identity this value is bound to. Absent = unbound (the legacy/positional
   * shapes), which rides whatever goal the projection names.
   */
  goalId?: string
}

/**
 * Defensive parser of one `goal/activation-changed` delivery.
 *
 * The forwarded listener receives the event ARGS spread, so the shape is parsed
 * from the first two arguments. Priority:
 * 1. the FROZEN wire — a single payload object
 *    `{ sessionId, goal?: { id, revision, activation } }` (vendor
 *    packages/goal/goal/src/types.ts:75-87; P2b's parseGoalActivationArgs and the
 *    control-plane mux read the same nesting). `goal` absent (or explicitly
 *    undefined) = the host reported no current goal ⇒ `activation: null`;
 *    `goal` present but not a record, or an activation outside
 *    `armed`/`disarmed` = shape drift ⇒ undefined (never a guess). A missing
 *    `goal.id` keeps the value, unbound.
 * 2. the legacy/test aliases — positional `(sessionId, activation)`, a
 *    top-level `{ sessionId | id, activation }`, or the boolean
 *    `armed`/`active` spellings.
 *
 * An unrecognized payload returns undefined and the tracker warns once.
 */
export function parseGoalActivationEvent(
  payload: unknown,
  activationArg?: unknown,
): GoalActivationEvent | undefined {
  const activationOf = (value: unknown): GoalActivation | undefined =>
    value === 'armed' || value === 'disarmed' ? value : undefined
  if (typeof payload === 'string' && payload !== '') {
    const activation = activationOf(activationArg)
    return activation === undefined ? undefined : { sessionId: payload, activation }
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined
  const record = payload as Record<string, unknown>
  const sessionId = typeof record.sessionId === 'string' && record.sessionId !== ''
    ? record.sessionId
    : typeof record.id === 'string' && record.id !== ''
      ? record.id
      : undefined
  if (sessionId === undefined) return undefined
  if (Object.hasOwn(record, 'goal')) {
    const goal = record.goal
    if (goal === undefined) return { sessionId, activation: null }
    if (goal === null || typeof goal !== 'object' || Array.isArray(goal)) return undefined
    const nested = goal as Record<string, unknown>
    const activation = activationOf(nested.activation)
    if (activation === undefined) return undefined
    const goalId = typeof nested.id === 'string' && nested.id !== '' ? nested.id : undefined
    return goalId === undefined ? { sessionId, activation } : { sessionId, activation, goalId }
  }
  // The frozen wire OMITS `goal` when the host has no current goal, so an object
  // carrying none of the activation spellings at all is that no-goal form. A
  // PRESENT alias key with an invalid value is shape drift (never a guess).
  if (!Object.hasOwn(record, 'activation') && !Object.hasOwn(record, 'armed') && !Object.hasOwn(record, 'active')) {
    return { sessionId, activation: null }
  }
  const activation = activationOf(record.activation)
    ?? (record.armed === true ? 'armed' : record.armed === false ? 'disarmed' : undefined)
    ?? (record.active === true ? 'armed' : record.active === false ? 'disarmed' : undefined)
  if (activation === undefined) return undefined
  return { sessionId, activation }
}

/** Injectable seams (the ctx-bound halves live in client/index.ts). */
export interface GoalActivationTrackerDeps {
  /**
   * Read `ctx.get('remote')`. May throw (the cordis service proxy throws while
   * the api-gateway client has not provided the service); may return undefined.
   */
  getRemote: () => unknown
  /** Re-report runtime facts so the producer's signature carries the new cache. */
  sync: () => void
  warn: (message: string) => void
  /** `connection/reset` subscription (the source's generation boundary). */
  onConnectionReset?: (listener: () => void) => () => void
  /** Timer seams (defaults to globalThis); injected by tests. */
  setTimeout?: (callback: () => void, ms: number) => unknown
  clearTimeout?: (handle: unknown) => void
  /** Bounded subscription attempts before going inert (default 8, ~32s window). */
  maxSubscriptionAttempts?: number
  /** First retry delay in ms; doubles per attempt (default 250). */
  retryBaseMs?: number
}

/** The per-source-generation activation cache (v5 §2.2 "按来源代清理"). */
export interface GoalActivationTracker {
  /** Begin the (possibly retried) event subscription + reset subscription. */
  start(): void
  /** Cache value for one session (merged into the goal fact by the producer). */
  activationOf(sessionId: string): GoalActivation | undefined
  /**
   * Per-pass observation: detects the running bidirectional change and the
   * goal-projection change, re-scans the cache, and remembers the pass. Called
   * by the producer inside `sync()` BEFORE the activation merge, so a prune is
   * reflected in the same report; no extra `sync()` is needed here.
   */
  observe(report: InstanceRuntimeReport, goals: ReadonlyMap<string, GoalFact | null>): void
  /** `connection/reset`: the cache belongs to the dead generation. */
  reset(): void
  dispose(): void
  /** Diagnostics/tests: the current resolved values. */
  snapshot(): ReadonlyMap<string, GoalActivation>
  /** Diagnostics/tests: attempts spent on the bounded subscription retry. */
  subscriptionAttempts(): number
  /** Diagnostics/tests: how many times the cache was re-scanned (the trigger matrix). */
  refreshCount(): number
  /** Diagnostics/tests: cumulative cap evictions (B4-1; never silent — warns once). */
  evictedCount(): number
}

interface ActivationEntry {
  activation: GoalActivation
  /**
   * Goal identity the value is bound to (event `goal.id`, or the observed fact
   * at delivery time for the unbound legacy shape). The value is only ever
   * merged while the observed projection names this same id; a projection
   * naming any other goal merely withholds it. F14 unified this with P2a/P2b
   * for the mismatch case only: a bound edge is never dropped merely because a
   * projection step names ANOTHER goalId (the old third-goalId exit is gone) —
   * but a projection that explicitly reports NO goal (goal:null) still drops
   * it (P1's existing delete-on-null semantics). Otherwise it leaves only with
   * the session/row, an explicit no-goal delivery, a new event overwriting it,
   * or reset/dispose.
   */
  goalId?: string
}

/**
 * Create one tracker. `start()` is separate so the producer can define its
 * `sync` closure before any synchronous subscription callback could touch it.
 */
export function createGoalActivationTracker(deps: GoalActivationTrackerDeps): GoalActivationTracker {
  const activations = new Map<string, ActivationEntry>()
  const runningBySession = new Map<string, boolean>()
  const goalFingerprints = new Map<string, string>()
  /** Last observed report — kept only for the ready-time re-scan. */
  let latestReport: InstanceRuntimeReport = { sessions: {} }
  let observedGoals: ReadonlyMap<string, GoalFact | null> = new Map()
  let observed = false
  let disposed = false
  let started = false
  let unsubscribeRemote: (() => void) | undefined
  /**
   * 本代是否已向远端登记了 `$on` 监听。与 `unsubscribeRemote` 分开：`$on` 返回非
   * 函数（undefined / 其他）时监听**已登记但没有可摘 disposer**——此时既不能重试
   * （会重复登记监听器），也不能假装未订阅（reset/dispose 必须知道这一代已占据
   * 一个监听位）。
   */
  let subscribed = false
  /**
   * 来源代计数：`subscribe` 捕获当时的代，监听器回调先比代再进状态机。`$on` 无
   * 可摘 disposer 时旧代监听器无法摘除（旧 remote 也可能在死亡世代里），本守卫是
   * 「旧代迟到事件不得落进新代」的唯一防线。
   */
  let generation = 0
  let unsubscribeReset: (() => void) | undefined
  let pendingTimer: unknown
  let attempts = 0
  let warnedNoDisposer = false
  let refreshes = 0
  let warnedUnavailable = false
  let warnedMalformed = false
  /** B4-1 diagnostics: cumulative cap evictions + warn-once latch. */
  let activationEvictions = 0
  let warnedActivationCap = false
  /**
   * dispose 的异常隔离诊断只 warning 一次（与其它 warn-once 同纪律）。dispose 是
   * 侧边栏 index.ts effect cleanup 的**首行**：任一步抛出都会跳过其后的
   * sessionFacts/purgedRows 退订与 producer.clear。
   */
  let warnedDisposeFailure = false
  // Bounded boot-window retry: the api-gateway client usually provides `remote`
  // within the same boot, so 8 attempts (250ms doubling) cover a slow start and
  // still terminate. Exhaustion is a warned, durable unknown-hold — never an
  // unbounded poll.
  const maxAttempts = deps.maxSubscriptionAttempts ?? 8
  const retryBaseMs = deps.retryBaseMs ?? 250
  const setTimer = deps.setTimeout ?? ((callback: () => void, ms: number): unknown => globalThis.setTimeout(callback, ms))
  const clearTimer = deps.clearTimeout ?? ((handle: unknown): void => {
    globalThis.clearTimeout(handle as Parameters<typeof globalThis.clearTimeout>[0])
  })

  /** Goal identity fingerprint of one row (v5 §2.2 "每次 goal 投影变化"). */
  const goalFingerprint = (goal: GoalFact | null | undefined): string =>
    goal === undefined ? 'u' : goal === null ? 'n' : `${goal.goalId}@${goal.revision}@${goal.phase}@${goal.updatedAt ?? ''}`

  /**
   * Retain one edge (latest wins) under {@link MAX_ACTIVATION_CACHE} (B4-1).
   * Map.set on an existing key does NOT move it to the end: an updated edge
   * would keep its first-seen position and be evicted as "oldest" on the next
   * overflow. Delete-then-set refreshes the retention order (LRU: eviction is
   * least-recently-updated, never least-recently-first-seen), mirroring P2a's
   * retainPendingGoalActivation. The cap drop is counted and warned once.
   */
  const retainActivation = (sessionId: string, entry: ActivationEntry): void => {
    const retained = activations.has(sessionId)
    if (!retained && activations.size >= MAX_ACTIVATION_CACHE) {
      const oldest = activations.keys().next()
      if (oldest.done !== true) activations.delete(oldest.value)
      activationEvictions += 1
      if (!warnedActivationCap) {
        warnedActivationCap = true
        deps.warn('the goal activation cache reached its cap (' + String(MAX_ACTIVATION_CACHE)
          + ', ghost sessionId events) — evicting the least-recently-updated entries (never silent)')
      }
    }
    if (retained) activations.delete(sessionId)
    activations.set(sessionId, entry)
  }

  /**
   * Re-scan the cache against the current report/goal facts. Only the two
   * terminal facts drop an entry (session left / explicit no-goal — the
   * latter INCLUDING a goal:null projection row); an unknown fact retains the
   * last-known cache, and a bound edge whose projection names a DIFFERENT
   * goal is retained too (P2b row rule, unified here 2026-12/F14 — P1 used to
   * drop on the third goalId; retention is the mismatch case only, never
   * null). Retention is safe and bounded: one
   * entry per session, overwritten by the next event, and cleared by
   * reset/dispose / the session leaving / an explicit no-goal delivery; the
   * value can never land on a foreign goal because activationOf withholds a
   * bound entry whenever the projection names a different id. The P1 counter-
   * argument (a live projection can only return to the same goalId through a
   * rollback, never a genuine goal switch — ids are unique) does not make the
   * retained edge unsafe: the guard keeps it from the rollback's neighbours,
   * and if the projection does name that id again its last-known switch is the
   * best evidence available (unknown-hold is the fallback, never a guess).
   * Ghost ids (no projection row ever carries them) are bounded by
   * {@link MAX_ACTIVATION_CACHE} with LRU eviction (B4-1).
   */
  const scan = (report: InstanceRuntimeReport, goals: ReadonlyMap<string, GoalFact | null>): void => {
    refreshes += 1
    for (const [sessionId, entry] of [...activations]) {
      if (report.sessions[sessionId] === undefined) {
        activations.delete(sessionId)
        continue
      }
      const goal = goals.get(sessionId)
      if (goal === null) {
        activations.delete(sessionId)
        continue
      }
      if (goal === undefined) continue
      // 未绑定边（legacy 形状）在首个已知投影上落身份；已绑定边无论投影经过什么
      // id 都保留待匹配，绝不改写绑定、绝不落到别的 goal 上。
      if (entry.goalId === undefined) entry.goalId = goal.goalId
    }
  }

  const onEvent = (...args: unknown[]): void => {
    if (disposed) return
    const parsed = parseGoalActivationEvent(args[0], args[1])
    if (parsed === undefined) {
      if (!warnedMalformed) {
        warnedMalformed = true
        deps.warn('ignoring a malformed goal/activation-changed delivery — activation stays unknown')
      }
      return
    }
    if (parsed.activation === null) {
      // Frozen wire: `goal` absent = the host has no current goal for this
      // session. The activation edge (not the goal projection) is what this
      // tracker owns: drop the cached value and re-report the unknown regression.
      if (activations.delete(parsed.sessionId)) deps.sync()
      return
    }
    const goal = observedGoals.get(parsed.sessionId)
    const observedGoalId = goal === undefined || goal === null ? undefined : goal.goalId
    // P2b row rule (unified 2026-12/F14), MISMATCH ONLY: the event's OWN
    // goal.id wins and the edge is retained while the projection names some
    // OTHER goal (or stays unknown) — an edge that raced ahead of the
    // projection must not land on the goal it replaced, and is no longer
    // discarded merely because the projection moves through other ids before
    // it can confirm it. A projection that explicitly reports NO goal
    // (goal:null) is not a mismatch: the next scan drops the entry (P1's
    // existing delete-on-null semantics). An unbound delivery rides the
    // observed goal, and the next scan binds it once a fact lands.
    const goalId = parsed.goalId ?? observedGoalId
    const next: ActivationEntry = goalId === undefined
      ? { activation: parsed.activation }
      : { activation: parsed.activation, goalId }
    const previous = activations.get(parsed.sessionId)
    if (
      previous !== undefined
      && previous.activation === next.activation
      && previous.goalId === next.goalId
    ) return
    retainActivation(parsed.sessionId, next)
    // v5 §2.2: a resolved-value change MUST re-report (identity dedupe would
    // otherwise freeze the first-seen activation).
    deps.sync()
  }

  const warnUnavailable = (): void => {
    if (warnedUnavailable) return
    warnedUnavailable = true
    deps.warn('goal/activation-changed is unavailable (remote service never became readable) — '
      + 'goal activation stays unknown-hold; goals/get is never called')
  }

  const scheduleRetry = (): void => {
    if (disposed || attempts >= maxAttempts) {
      if (attempts >= maxAttempts) warnUnavailable()
      return
    }
    const delay = retryBaseMs * 2 ** Math.max(0, attempts - 1)
    pendingTimer = setTimer(() => {
      pendingTimer = undefined
      subscribe()
    }, delay)
  }

  /**
   * One bounded subscription attempt. A throwing `getRemote`/member access and
   * a missing `$on` are the same failure (the service is not ready yet). A
   * NON-throwing `$on` call is a successful registration even when it returns
   * no disposer: `undefined`/any other value means "registered, cannot be
   * removed" — retrying would register duplicate listeners, so the tracker
   * accepts it, warns once, and relies on the generation guard for isolation.
   */
  const subscribe = (): void => {
    if (disposed || subscribed || attempts >= maxAttempts) {
      if (!disposed && !subscribed && attempts >= maxAttempts) warnUnavailable()
      return
    }
    attempts += 1
    let remote: unknown
    let on: unknown
    try {
      remote = deps.getRemote()
      on = remote === null || remote === undefined ? undefined : (remote as { $on?: unknown }).$on
    } catch {
      on = undefined
    }
    if (typeof on !== 'function') {
      scheduleRetry()
      return
    }
    // Capture the generation BEFORE the $on call: a delivery racing in from the
    // dead generation is accepted only while this subscription is still current.
    const subscriptionGeneration = generation
    const listener = (...args: unknown[]): void => {
      if (disposed || generation !== subscriptionGeneration) return
      onEvent(...args)
    }
    try {
      const off = (remote as { $on(event: string, listener: (...args: unknown[]) => void): unknown })
        .$on(GOAL_ACTIVATION_EVENT, listener)
      subscribed = true
      if (typeof off === 'function') {
        unsubscribeRemote = off as () => void
      } else if (!warnedNoDisposer) {
        // Regression F6: a missing disposer is NOT a subscription failure. The
        // listener IS installed; the generation guard (not an unsubscribe) is
        // what discards stale deliveries. Warn once, never retry/duplicate.
        warnedNoDisposer = true
        deps.warn('goal/activation-changed registered without an unsubscribe handle — '
          + 'stale deliveries are dropped by the generation guard')
      }
    } catch {
      scheduleRetry()
      return
    }
    // Ready (v5 §2.2 "就绪后扫描在场 active 会话"): the only scan this deployment
    // can do without a read path is a cache re-scan against the last observed
    // facts — active sessions whose activation is unresolved stay unknown-hold
    // until their event arrives. No sync() here: the cache did not change.
    if (observed) scan(latestReport, observedGoals)
  }

  /**
   * dispose 步骤的异常隔离：抛错的 disposer 或 onConnectionReset 返回的非函数值
   * 一律吞掉（warn-once 诊断），保证后续清理（另一个退订 / 缓存清空）与 index.ts
   * effect cleanup 的其余步骤继续执行。与 reset() 对死代退订的 try/catch 同款，
   * 差别只在诊断：reset 的失败是死代退订的正常噪声，dispose 的失败需要留证。
   */
  const cleanupQuietly = (what: string, run: () => void): void => {
    try {
      run()
    } catch {
      if (!warnedDisposeFailure) {
        warnedDisposeFailure = true
        deps.warn(`${what} failed during dispose — ignored; disposal continues`)
      }
    }
  }
  const callDisposer = (what: string, disposer: unknown): void => {
    if (disposer === undefined) return
    cleanupQuietly(what, () => {
      if (typeof disposer === 'function') {
        const off = disposer as () => void
        off()
        return
      }
      // onConnectionReset 的返回类型只是声明；运行期任意非 undefined 值都可能
      // 出现（旧/坏实现返回布尔、对象等），必须走同一条吞掉 + warn-once 路径。
      throw new TypeError(`${what} is not a function`)
    })
  }

  const reset = (): void => {
    if (disposed) return
    const hadValues = activations.size > 0
    activations.clear()
    runningBySession.clear()
    goalFingerprints.clear()
    observedGoals = new Map()
    observed = false
    // The old subscription belongs to the dead generation (the remote service
    // may have gone away with it): bump the generation FIRST — any late delivery
    // of the dead generation is now dropped by the listener guard, even when
    // $on returned no disposer — then drop whatever disposer exists, discard any
    // pending retry timer and give the new generation a fresh bounded budget
    // before re-subscribing.
    generation += 1
    if (subscribed) {
      if (unsubscribeRemote !== undefined) {
        try {
          unsubscribeRemote()
        } catch {
          // The dead generation's unsubscribe is best-effort; the listener
          // generation guard + the NEW subscription below carry liveness.
        }
      }
      unsubscribeRemote = undefined
      subscribed = false
    }
    if (pendingTimer !== undefined) {
      clearTimer(pendingTimer)
      pendingTimer = undefined
    }
    attempts = 0
    warnedUnavailable = false
    if (hadValues) deps.sync()
    if (started) subscribe()
  }

  return {
    start(): void {
      if (disposed || started) return
      started = true
      if (deps.onConnectionReset !== undefined) {
        try {
          unsubscribeReset = deps.onConnectionReset(reset)
        } catch {
          unsubscribeReset = undefined
        }
      }
      subscribe()
    },
    activationOf(sessionId: string): GoalActivation | undefined {
      const entry = activations.get(sessionId)
      if (entry === undefined) return undefined
      if (entry.goalId === undefined) return entry.activation
      const goal = observedGoals.get(sessionId)
      // Binding guard (mirrors P2b's row check): a goal-bound value is only
      // mergeable while the observed projection names that same goal. Unknown /
      // explicitly goal-free observations hand the raw value through — the merge
      // consumer skips non-object goal facts, so it cannot attach there; a
      // DIFFERENT goal id withholds the value from this pass's merge while the
      // cached edge stays available for a later projection that names its goal
      // (F14: retention covers the mismatch case only — it no longer ends at a
      // third goalId; an explicit goal:null PROJECTION is a drop point in
      // scan(), never a retention case).
      if (goal === undefined || goal === null || goal.goalId === entry.goalId) return entry.activation
      return undefined
    },
    observe(report: InstanceRuntimeReport, goals: ReadonlyMap<string, GoalFact | null>): void {
      if (disposed) return
      let runningChanged = !observed
      let goalsChanged = !observed
      const nextRunning = new Map<string, boolean>()
      const nextFingerprints = new Map<string, string>()
      for (const [sessionId, row] of Object.entries(report.sessions)) {
        const running = row.running === true
        nextRunning.set(sessionId, running)
        if (runningBySession.get(sessionId) !== running) runningChanged = true
        const fingerprint = goalFingerprint(row.goal)
        nextFingerprints.set(sessionId, fingerprint)
        if (goalFingerprints.get(sessionId) !== fingerprint) goalsChanged = true
      }
      // Removed sessions are changes too (a vanished goal/row must re-scan).
      if (nextRunning.size !== runningBySession.size) runningChanged = true
      if (nextFingerprints.size !== goalFingerprints.size) goalsChanged = true
      runningBySession.clear()
      for (const [sessionId, running] of nextRunning) runningBySession.set(sessionId, running)
      goalFingerprints.clear()
      for (const [sessionId, fingerprint] of nextFingerprints) goalFingerprints.set(sessionId, fingerprint)
      observedGoals = goals
      latestReport = report
      observed = true
      if (runningChanged || goalsChanged) scan(report, goals)
    },
    reset,
    dispose(): void {
      disposed = true
      // Same generation boundary as reset(): a disposed tracker ignores every
      // late delivery, including one from a listener $on left unremovable.
      generation += 1
      if (pendingTimer !== undefined) {
        const timer = pendingTimer
        pendingTimer = undefined
        cleanupQuietly('the retry timer', () => { clearTimer(timer) })
      }
      if (subscribed) {
        subscribed = false
        const off = unsubscribeRemote
        unsubscribeRemote = undefined
        callDisposer('the goal/activation-changed unsubscribe', off)
      }
      // 与上一步彼此独立：抛错的前一个 disposer 不得跳过这个退订（index.ts
      // cleanup 首行调用 dispose，这里抛出的任何异常都会跳过后续整个清理面）。
      const offReset = unsubscribeReset
      unsubscribeReset = undefined
      callDisposer('the connection/reset unsubscribe', offReset)
      activations.clear()
      runningBySession.clear()
      goalFingerprints.clear()
      observedGoals = new Map()
    },
    snapshot(): ReadonlyMap<string, GoalActivation> {
      const values = new Map<string, GoalActivation>()
      for (const [sessionId, entry] of activations) values.set(sessionId, entry.activation)
      return values
    },
    subscriptionAttempts(): number {
      return attempts
    },
    refreshCount(): number {
      return refreshes
    },
    evictedCount(): number {
      return activationEvictions
    },
  }
}
