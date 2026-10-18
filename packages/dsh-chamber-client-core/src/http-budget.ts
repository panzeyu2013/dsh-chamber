/**
 * Page-level same-origin HTTP budget — the ONE owner of chamber's unary/bundle
 * dispatch against the browser's per-origin connection pool (design 26 §D7 /
 * design 14 §D4).
 *
 * WHY（已证实的缺陷）：浏览器对同一 origin 的 HTTP/1.1 连接是共享且隐形的资源。
 * 在慢远程占满连接池时，本地 mux 无壳观察者的 5s 基线请求会排队到截止期，
 * `source-mux-facts.rpc` 只能把它记成 `TimeoutError`；证据分类器在页面有调度时
 * 判 `deadline` 并作为**来源事实**入账，本地来源因此被伪降级。
 *
 * Fetch API 没有 dispatch 事件：请求一旦交给 `fetch()`，JS 侧无法再区分
 * 「已发往网络」与「排在浏览器连接池里」。因此**能证明「从未派发」的只有本模块
 * 自己的队列**。调用方经 `acquireHttpBudget` 拿槽后才会调用 fetch；在队列里就到期的
 * 请求返回 `unscheduled`（携带 `queuedMs`），证据层据此按非来源事实结算。
 *
 * 契约：
 * - 调度：只有 `local` 车道有严格保留（lane 级，不承诺多个 local 请求下的基线优先）；
 *   `foreground`/`background` 目前同权（词汇保留给将来的分级）；`bundle` 另有子帽。
 * - 队列：只有显式带 `queueDeadlineAt` 的调用方受 `queueMax`/`perSourceQueueMax` 约束；
 *   无 deadline 的调用方由各自生产者的单飞/波控收敛，永不因队列深度被拒，local 永不被拒。
 * - 租约：已派发槽带 lease；watchdog 只回收不重派——回收后真实连接可能短暂超帽
 *   （防泄漏的已知代价），容量读数只数 `active`。
 * - 归因：队列内到期 ⇒ `unscheduled`（`dispatched=false`），绝不写成来源事实；
 *   已派发超时沿用旧语义。
 * - fail-open：入队/计时器/监听器异常直接放行；kill switch 不回溯排空已入队项
 *   （开启后靠槽释放/lease 收敛）；kill switch
 *   `globalThis.__DSH_CHAMBER_HTTP_BUDGET_OFF__ === true` 全局旁路——开启即回到
 *   **无预算语义**（派发超时会重新按 `deadline` 归类），仅供现场排障。
 * - 零运行时依赖、零 Node 内建；单例模块（页面级资源只能有一个所有者）。
 *
 * 停止/退役的来源不会主动取消已排队请求（只有权威退役与页面拆除会驱逐）：停止后的
 * 排队项最多空跑一次 fetch，由调用方的 stopped 门丢弃，不落账。
 */

import { assertSingletonModule } from './singleton.ts'
import { recordEvidence } from './evidence-log.ts'

assertSingletonModule('http-budget')

/** 调度车道：只有 `local` 有严格保留；`foreground`/`background` 目前同权（词汇保留）。 */
export type HttpBudgetLane = 'local' | 'foreground' | 'background'
/** 两类受预算约束的请求。bundle 的槽位语义由调用方按 script 生命周期释放。 */
export type HttpBudgetKind = 'unary' | 'bundle'

export interface HttpBudgetLimits {
  /** 本模块允许的同时在飞请求上限（必须小于浏览器池容量，留头寸给不可调度消费者）。 */
  readonly totalMax: number
  /** 只给 `local` 车道的保留槽数（严格保留，不因无本地流量而借出）。 */
  readonly localReserve: number
  /** bundle 类同时在飞上限（boot 脚本装载不得吃满全池）。 */
  readonly bundleMax: number
  /** 全局排队上限（仅约束带 queueDeadlineAt 的调用方）。 */
  readonly queueMax: number
  /** 每来源排队上限（同上；local 车道不受此限）。 */
  readonly perSourceQueueMax: number
  /** 槽位租约扫描周期。 */
  readonly watchdogMs: number
  /** 未显式给 leaseMs 的槽位租约（覆盖 60s 最长单请求 + 余量）。 */
  readonly defaultLeaseMs: number
}

/** 预算参数单源。浏览器池容量 6（design 26 §1 实测）；留 2 槽给官方客户端与
 *  script/import/导航等不可调度消费者。真机标定后只改这一处。 */
export const HTTP_BUDGET_LIMITS: HttpBudgetLimits = Object.freeze({
  totalMax: 4,
  localReserve: 1,
  bundleMax: 2,
  queueMax: 64,
  perSourceQueueMax: 8,
  watchdogMs: 1_000,
  defaultLeaseMs: 65_000,
})

export interface HttpBudgetRequest {
  readonly sourceId: string
  readonly kind: HttpBudgetKind
  readonly lane: HttpBudgetLane
  /** 绝对时刻（同 Date.now() 时基）：仍在排队即结算 `queue-deadline`。 */
  readonly queueDeadlineAt?: number
  /** 排队期间的取消信号；已派发后由调用方自己的 timeout 负责。 */
  readonly signal?: AbortSignal
  /** 已派发槽的租约覆盖（bundle 应传 script 生命周期上界）。 */
  readonly leaseMs?: number
  /** 诊断标签（进入证据明细，不参与判定；stats 不按 label 聚合）。 */
  readonly label?: string
}

export type HttpBudgetUnscheduledReason =
  | 'queue-deadline'
  | 'queue-full'
  | 'aborted'
  | 'source-retired'

export interface HttpBudgetSlot {
  readonly id: number
  readonly sourceId: string
  readonly lane: HttpBudgetLane
  readonly kind: HttpBudgetKind
  /** 从入队到派发的毫秒数。 */
  readonly queuedMs: number
  /** 幂等释放；释放后本槽不再计入在飞。 */
  release(): void
}

export type HttpBudgetAcquire =
  | {
    readonly kind: 'granted'
    readonly slot: HttpBudgetSlot
    readonly queuedMs: number
    /** 非 `undefined` 表示走了旁路放行（kill switch / 内部 fail-open）。 */
    readonly bypass?: 'kill-switch' | 'fail-open'
  }
  | {
    readonly kind: 'unscheduled'
    readonly reason: HttpBudgetUnscheduledReason
    readonly queuedMs: number
  }

/** Thrown by a budgeted caller when the request was settled without dispatch.
 *  The evidence layer maps it to \`unscheduled\` (never a source fact) and
 *  records the queue wait in its detail. */
export class HttpBudgetUnscheduledError extends Error {
  readonly reason: HttpBudgetUnscheduledReason
  readonly queuedMs: number
  constructor(reason: HttpBudgetUnscheduledReason, queuedMs: number) {
    super('http-budget: not dispatched (' + reason + ', queued ' + String(Math.round(queuedMs)) + 'ms)')
    this.name = 'HttpBudgetUnscheduledError'
    this.reason = reason
    this.queuedMs = queuedMs
  }
}

export interface HttpBudgetStats {
  readonly mode: 'on' | 'off'
  readonly inflight: number
  readonly queued: number
  /** Maximum POSITIVE queue wait observed (ms), NOT a queue depth. */
  readonly maxQueueWaitMs: number
  readonly inflightByLane: Readonly<Record<HttpBudgetLane, number>>
  readonly inflightByKind: Readonly<Record<HttpBudgetKind, number>>
  readonly enqueued: number
  readonly granted: number
  readonly unscheduled: Readonly<Record<HttpBudgetUnscheduledReason, number>>
  /** Percentiles over POSITIVE queue waits only (a same-tick grant is not a
   *  wait). Calibrating against these must not be diluted by the share of
   *  zero-wait grants — that share is reported separately as zeroWaitGrants. */
  readonly queueMsP50: number
  readonly queueMsP95: number
  readonly queueMsMax: number
  /** Grants that needed no wait at all (queue depth 0 for this request). */
  readonly zeroWaitGrants: number
  readonly leaseExpired: number
  readonly bypass: number
  readonly evicted: number
}

interface QueueEntry {
  readonly request: HttpBudgetRequest
  readonly enqueuedAt: number
  resolve: (result: HttpBudgetAcquire) => void
  settled: boolean
  timer: ReturnType<typeof setTimeout> | null
  detachAbort: (() => void) | null
}

interface ActiveSlot {
  readonly record: HttpBudgetSlot
  readonly startedAt: number
  readonly leaseMs: number
  readonly label?: string
  released: boolean
}

const MODE_OFF_FLAG = '__DSH_CHAMBER_HTTP_BUDGET_OFF__'

let limits: HttpBudgetLimits = HTTP_BUDGET_LIMITS
let nextSlotId = 1
const queue: QueueEntry[] = []
const active = new Map<number, ActiveSlot>()
const recentQueueMs: number[] = []
/** Last refusal evidence time per source+reason (1s sampling guard). */
const refusalEvidenceAt = new Map<string, number>()
let watchdogTimer: ReturnType<typeof setTimeout> | null = null
const counters = {
  enqueued: 0,
  granted: 0,
  maxQueueWaitMs: 0,
  zeroWaitGrants: 0,
  leaseExpired: 0,
  bypass: 0,
  evicted: 0,
  unscheduled: { 'queue-deadline': 0, 'queue-full': 0, aborted: 0, 'source-retired': 0 } as Record<HttpBudgetUnscheduledReason, number>,
}

function now(): number {
  return Date.now()
}

function budgetDisabled(): boolean {
  return (globalThis as Record<string, unknown>)[MODE_OFF_FLAG] === true
}

function inflightCount(): number {
  let count = 0
  for (const slot of active.values()) if (!slot.released) count += 1
  return count
}

function inflightByKindCount(kind: HttpBudgetKind): number {
  let count = 0
  for (const slot of active.values()) if (!slot.released && slot.record.kind === kind) count += 1
  return count
}

function nonLocalInflightCount(): number {
  let count = 0
  for (const slot of active.values()) {
    if (!slot.released && slot.record.lane !== 'local') count += 1
  }
  return count
}

function canStart(lane: HttpBudgetLane, kind: HttpBudgetKind): boolean {
  // bundle 子帽：boot 脚本装载不得吃满全池，unary（尤其本地基线）始终有余量。
  if (kind === 'bundle' && inflightByKindCount('bundle') >= limits.bundleMax) return false
  // Global cap always applies; the strict local reserve is counted on the
  // NON-local in-flight count so a running local request does not shrink the
  // non-local quota a second time (review M2).
  if (inflightCount() >= limits.totalMax) return false
  if (lane === 'local') return true
  return nonLocalInflightCount() < limits.totalMax - limits.localReserve
}

/** Remember a POSITIVE queue wait, whatever ended the wait. Zero waittimes are
 *  NOT samples here: mixing them in made queueMsP50/P95 read 0 in any healthy
 *  window, which silently voided the calibration criterion STATUS takes them from. */
function rememberQueueWait(value: number): void {
  if (value <= 0) return
  recentQueueMs.push(value)
  if (recentQueueMs.length > 128) recentQueueMs.splice(0, recentQueueMs.length - 128)
  if (value > counters.maxQueueWaitMs) counters.maxQueueWaitMs = value
}

/** Nearest-rank percentile (1-based rank, clamped): index = ceil(ratio*n)-1. */
function percentile(sorted: number[], ratio: number): number {
  if (sorted.length === 0) return 0
  const rank = Math.max(1, Math.ceil(sorted.length * ratio))
  return sorted[Math.min(sorted.length - 1, rank - 1)] as number
}

function clearEntryTimer(entry: QueueEntry): void {
  if (entry.timer !== null) {
    clearTimeout(entry.timer)
    entry.timer = null
  }
}

function detachEntryAbort(entry: QueueEntry): void {
  if (entry.detachAbort !== null) {
    entry.detachAbort()
    entry.detachAbort = null
  }
}

/** Sampled refusal ledger (1s per source+reason): a saturated page must stay
 *  explainable afterwards without one line per refused request. */
function recordRefusalEvidence(
  request: HttpBudgetRequest,
  reason: HttpBudgetUnscheduledReason,
  queuedMs: number,
  extra: Record<string, unknown> = {},
): void {
  const key = request.sourceId + '|' + reason
  const at = now()
  if (at - (refusalEvidenceAt.get(key) ?? 0) < 1_000) return
  refusalEvidenceAt.set(key, at)
  recordEvidence('http-budget', 'unscheduled', {
    sourceId: request.sourceId, reason, queuedMs, ...extra, label: request.label ?? null,
  }, false)
}

function settleUnscheduled(entry: QueueEntry, reason: HttpBudgetUnscheduledReason): void {
  if (entry.settled) return
  entry.settled = true
  const index = queue.indexOf(entry)
  if (index >= 0) queue.splice(index, 1)
  clearEntryTimer(entry)
  detachEntryAbort(entry)
  const queuedMs = now() - entry.enqueuedAt
  counters.unscheduled[reason] += 1
  // Queue-deadline is exactly the wait the STATUS calibration reads; record it so
  // queueMsP50/P95/maxQueueWaitMs are not blind to the dominant refusal path.
  if (reason === 'queue-deadline') {
    rememberQueueWait(queuedMs)
    recordRefusalEvidence(entry.request, 'queue-deadline', queuedMs)
  }
  entry.resolve({ kind: 'unscheduled', reason, queuedMs })
}

function stopWatchdogIfIdle(): void {
  if (watchdogTimer !== null && active.size === 0) {
    clearTimeout(watchdogTimer)
    watchdogTimer = null
  }
}

function armWatchdog(): void {
  if (watchdogTimer !== null) return
  watchdogTimer = setTimeout(() => {
    watchdogTimer = null
    try {
      const at = now()
      for (const [id, slot] of [...active]) {
        if (slot.released) continue
        if (at - slot.startedAt > slot.leaseMs) {
          counters.leaseExpired += 1
          recordEvidence('http-budget', 'deadline', {
            sourceId: slot.record.sourceId, kind: slot.record.kind, leaseMs: slot.leaseMs,
            ageMs: at - slot.startedAt, label: slot.label ?? null, dispatched: true,
          }, false)
          releaseSlot(id)
        }
      }
    } finally {
      // 任何一步抛错都不能让回收停摆（fail-open 的兜底边）。
      if (active.size > 0) armWatchdog()
    }
  }, limits.watchdogMs)
  // `unref` is a Node test-host nicety (a leaked lease must not keep a test
  // process alive); browsers have no such method and the safety bound is
  // unchanged there.
  ;(watchdogTimer as { unref?: () => void } | null)?.unref?.()
}

function releaseSlot(id: number): void {
  const slot = active.get(id)
  if (slot === undefined || slot.released) return
  slot.released = true
  active.delete(id)
  stopWatchdogIfIdle()
  pump()
}

function makeSlot(entry: QueueEntry, queuedMs: number): HttpBudgetSlot {
  const slotId = nextSlotId
  nextSlotId += 1
  const slot: HttpBudgetSlot = Object.freeze({
    id: slotId,
    sourceId: entry.request.sourceId,
    lane: entry.request.lane,
    kind: entry.request.kind,
    queuedMs,
    release: () => releaseSlot(slotId),
  })
  active.set(slotId, {
    record: slot,
    startedAt: now(),
    leaseMs: entry.request.leaseMs ?? limits.defaultLeaseMs,
    ...(entry.request.label === undefined ? {} : { label: entry.request.label }),
    released: false,
  })
  armWatchdog()
  return slot
}

function grantEntry(entry: QueueEntry): void {
  if (entry.settled) return
  // Deadline re-check: never admit an entry whose bounded wait already expired.
  if (entry.request.queueDeadlineAt !== undefined && now() >= entry.request.queueDeadlineAt) {
    settleUnscheduled(entry, 'queue-deadline')
    return
  }
  entry.settled = true
  const index = queue.indexOf(entry)
  if (index >= 0) queue.splice(index, 1)
  clearEntryTimer(entry)
  detachEntryAbort(entry)
  const queuedMs = now() - entry.enqueuedAt
  // Only a GRANT can be a zero-wait event; a refusal that expires at once is not
  // a grant and must not inflate the share (review: 2 zero-wait grants > 1 grant).
  if (queuedMs <= 0) counters.zeroWaitGrants += 1
  else rememberQueueWait(queuedMs)
  counters.granted += 1
  entry.resolve({ kind: 'granted', slot: makeSlot(entry, queuedMs), queuedMs })
}

function pump(): void {
  for (;;) {
    const index = queue.findIndex(entry => canStart(entry.request.lane, entry.request.kind))
    if (index < 0) return
    const entry = queue[index] as QueueEntry
    grantEntry(entry)
  }
}

/** Bounded-wait entries of one source. Undeadlined callers are excluded on
 *  purpose: their producers own the bound (bundle rows, gateway facts probes,
 *  long actions), so counting them here would let a source's own boot wave
 *  refuse a same-source bounded read that the queue itself could still serve. */
function sourceBoundedQueuedCount(sourceId: string): number {
  let count = 0
  for (const entry of queue) {
    if (entry.request.sourceId === sourceId && entry.request.queueDeadlineAt !== undefined) count += 1
  }
  return count
}

function bypassGrant(entry: QueueEntry, reason: 'kill-switch' | 'fail-open'): HttpBudgetAcquire {
  counters.bypass += 1
  counters.granted += 1
  const queuedMs = now() - entry.enqueuedAt
  const slotId = nextSlotId
  nextSlotId += 1
  const slot: HttpBudgetSlot = Object.freeze({
    id: slotId,
    sourceId: entry.request.sourceId,
    lane: entry.request.lane,
    kind: entry.request.kind,
    queuedMs,
    release: () => releaseSlot(slotId),
  })
  // A bypassed request is still a real same-origin connection: count it so the
  // capacity/stat surface stays honest (kill switch restores pre-budget
  // semantics, not an invisible extra slot). Released by the caller or watchdog.
  active.set(slotId, {
    record: slot,
    startedAt: now(),
    leaseMs: entry.request.leaseMs ?? limits.defaultLeaseMs,
    ...(entry.request.label === undefined ? {} : { label: entry.request.label }),
    released: false,
  })
  armWatchdog()
  return { kind: 'granted', slot, queuedMs, bypass: reason }
}

/**
 * 申请一个同源请求槽。调用方在 `granted` 之后才发起 fetch/script；`unscheduled`
 * 表示请求**从未离开本模块队列**，证据层必须按非来源事实结算。
 */
export function acquireHttpBudget(request: HttpBudgetRequest): Promise<HttpBudgetAcquire> {
  const entry: QueueEntry = {
    request,
    enqueuedAt: now(),
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    resolve: () => {},
    settled: false,
    timer: null,
    detachAbort: null,
  }
  const promise = new Promise<HttpBudgetAcquire>(resolve => { entry.resolve = resolve })
  try {
    // 已过期/已取消：不排队，按 unscheduled 立即结算（kill switch 也不假放行已取消请求）。
    if (request.queueDeadlineAt !== undefined && now() >= request.queueDeadlineAt) {
      counters.unscheduled['queue-deadline'] += 1
      recordRefusalEvidence(request, 'queue-deadline', 0)
      entry.resolve({ kind: 'unscheduled', reason: 'queue-deadline', queuedMs: 0 })
      return promise
    }
    if (request.signal?.aborted === true) {
      counters.unscheduled.aborted += 1
      entry.resolve({ kind: 'unscheduled', reason: 'aborted', queuedMs: 0 })
      return promise
    }
    if (budgetDisabled()) {
      queueMicrotask(() => entry.resolve(bypassGrant(entry, 'kill-switch')))
      return promise
    }
    const local = request.lane === 'local'
    // Queue-depth refusal applies ONLY to callers that opted into a bounded wait
    // (an explicit queueDeadlineAt; mux, per-instance unary, runtime polls). Callers
    // without one (bundle rows, gateway facts probes, user actions) are bounded by
    // their producers; refusing them would turn page-local congestion into a new
    // failure surface (review M1–M4). The local lane is never refused.
    // Queue-depth refusal is a LAST resort: if a slot is free right now, admit the
    // request (a deep queue of undeadlined producers must not reject a bounded
    // caller while capacity sits idle — review M1).
    if (!local && request.queueDeadlineAt !== undefined
      && (queue.length >= limits.queueMax || sourceBoundedQueuedCount(request.sourceId) >= limits.perSourceQueueMax)
      && !canStart(request.lane, request.kind)) {
      counters.unscheduled['queue-full'] += 1
      recordRefusalEvidence(request, 'queue-full', 0, {
        cap: queue.length >= limits.queueMax ? 'queue' : 'per-source',
      })
      entry.resolve({ kind: 'unscheduled', reason: 'queue-full', queuedMs: 0 })
      return promise
    }
    queue.push(entry)
    counters.enqueued += 1
    if (request.queueDeadlineAt !== undefined) {
      entry.timer = setTimeout(() => settleUnscheduled(entry, 'queue-deadline'), Math.max(0, request.queueDeadlineAt - now()))
    }
    if (request.signal !== undefined) {
      const onAbort = (): void => settleUnscheduled(entry, 'aborted')
      request.signal.addEventListener('abort', onAbort, { once: true })
      entry.detachAbort = () => request.signal?.removeEventListener('abort', onAbort)
    }
  } catch {
    // fail-open（只覆盖入队阶段）：撤回未生效条目后直接放行。grantEntry 成功后
    // 不再经过这里，避免一个真实槽位泄漏 + 二次授予（review Minor 11）。
    const index = queue.indexOf(entry)
    if (index >= 0) queue.splice(index, 1)
    clearEntryTimer(entry)
    detachEntryAbort(entry)
    entry.settled = true
    // bypassGrant itself counts the bypass; counting here too double-reports it.
    entry.resolve(bypassGrant(entry, 'fail-open'))
    return promise
  }
  pump()
  return promise
}

/** Convenience wrapper: acquire, run the task, always release. Resolves with the
 *  task value; throws HttpBudgetUnscheduledError when the request was settled
 *  without dispatch (callers decide whether that is transient for their policy). */
export async function runWithHttpBudget<T>(
  request: HttpBudgetRequest,
  task: (slot: HttpBudgetSlot) => Promise<T>,
): Promise<T> {
  const acquired = await acquireHttpBudget(request)
  if (acquired.kind === 'unscheduled') {
    throw new HttpBudgetUnscheduledError(acquired.reason, acquired.queuedMs)
  }
  try {
    return await task(acquired.slot)
  } finally {
    acquired.slot.release()
  }
}

/**
 * 来源退役/换代：只清**尚未派发**的排队请求（已派发不打断，调用方自己的
 * generation 栅栏负责迟到结果）。返回被驱逐的请求数。
 */
export function evictHttpBudgetSource(sourceId: string, reason = 'source-retired'): number {
  let evicted = 0
  for (const entry of [...queue]) {
    if (entry.request.sourceId !== sourceId) continue
    counters.evicted += 1
    evicted += 1
    settleUnscheduled(entry, 'source-retired')
  }
  // ONE line per eviction call (not one per entry): page teardown can drop a
  // whole boot generation at once, and the count is the fact that matters.
  if (evicted > 0) recordEvidence('http-budget', 'superseded', { sourceId, reason, count: evicted }, false)
  for (const key of [...refusalEvidenceAt.keys()]) {
    if (key.startsWith(sourceId + '|')) refusalEvidenceAt.delete(key)
  }
  return evicted
}

/** 现场可读的预算读数（真机 inspector / 诊断面）。 */
export function readHttpBudgetStats(): HttpBudgetStats {
  const byLane: Record<HttpBudgetLane, number> = { local: 0, foreground: 0, background: 0 }
  const byKind: Record<HttpBudgetKind, number> = { unary: 0, bundle: 0 }
  for (const slot of active.values()) {
    if (slot.released) continue
    byLane[slot.record.lane] += 1
    byKind[slot.record.kind] += 1
  }
  const sorted = [...recentQueueMs].sort((left, right) => left - right)
  return Object.freeze({
    mode: budgetDisabled() ? 'off' as const : 'on' as const,
    inflight: inflightCount(),
    queued: queue.length,
    maxQueueWaitMs: counters.maxQueueWaitMs,
    inflightByLane: Object.freeze(byLane),
    inflightByKind: Object.freeze(byKind),
    enqueued: counters.enqueued,
    granted: counters.granted,
    unscheduled: Object.freeze({ ...counters.unscheduled }),
    queueMsP50: percentile(sorted, 0.5),
    queueMsP95: percentile(sorted, 0.95),
    queueMsMax: sorted.length === 0 ? 0 : (sorted[sorted.length - 1] as number),
    zeroWaitGrants: counters.zeroWaitGrants,
    leaseExpired: counters.leaseExpired,
    bypass: counters.bypass,
    evicted: counters.evicted,
  })
}

/** Test-only：注入更小的参数与外部时钟边界；返回还原函数。 */
export function configureHttpBudgetForTests(partial: Partial<HttpBudgetLimits>): () => void {
  const previous = limits
  limits = { ...limits, ...partial }
  return () => { limits = previous }
}

/** Test-only：清空队列、在飞、计时器与计数。 */
export function resetHttpBudgetForTests(): void {
  for (const entry of [...queue]) {
    clearEntryTimer(entry)
    detachEntryAbort(entry)
    entry.settled = true
    // Resolve instead of leaving the acquire promise dangling across tests.
    entry.resolve({ kind: 'unscheduled', reason: 'source-retired', queuedMs: 0 })
  }
  queue.length = 0
  for (const id of [...active.keys()]) releaseSlot(id)
  active.clear()
  if (watchdogTimer !== null) {
    clearTimeout(watchdogTimer)
    watchdogTimer = null
  }
  recentQueueMs.length = 0
  refusalEvidenceAt.clear()
  counters.enqueued = 0
  counters.granted = 0
  counters.maxQueueWaitMs = 0
  counters.zeroWaitGrants = 0
  counters.leaseExpired = 0
  counters.bypass = 0
  counters.evicted = 0
  counters.unscheduled = { 'queue-deadline': 0, 'queue-full': 0, aborted: 0, 'source-retired': 0 }
  limits = HTTP_BUDGET_LIMITS
}

/** Resolve the proxy source id a `/api/i/<id>/...` path or URL addresses. */
export function httpBudgetSourceIdFromProxyPath(pathOrUrl: string): string {
  return /\/api\/i\/([^/?#]+)/.exec(pathOrUrl)?.[1] ?? 'control-plane'
}

/** Budget left for the carrier after the dispatcher spent `queuedMs` of a caller's
 *  `timeoutMs`: a 5s baseline must stay 5s end to end, never 5s + queue wait.
 *  Pure; a non-positive remainder still allows a 1ms attempt (never 0/negative
 *  timers, which fire immediately). */
export function remainingDispatchBudgetMs(timeoutMs: number, queuedMs: number): number {
  return Math.max(1, timeoutMs - Math.max(0, queuedMs))
}

/** The lane a source id belongs to: only `local` is privileged (strict reserve). */
export function httpBudgetLaneFor(sourceId: string): HttpBudgetLane {
  return sourceId === 'local' ? 'local' : 'foreground'
}

/** Lease with headroom over the caller's own deadline, never below the default. */
export function httpBudgetLeaseFor(timeoutMs: number): number {
  // Reads the LIVE limits so a test seam (or a future tuning table) changes both
  // the dispatcher and the lease derived from it (review Minor: two sources).
  return Math.max(limits.defaultLeaseMs, timeoutMs + 5_000)
}

// 现场可读出口（真机 inspector）：挂函数而不是快照，读数始终是最新值。
const budgetGlobalHost = globalThis as { __dshChamberHttpBudget?: () => HttpBudgetStats }
if (budgetGlobalHost.__dshChamberHttpBudget === undefined) {
  budgetGlobalHost.__dshChamberHttpBudget = () => readHttpBudgetStats()
}
