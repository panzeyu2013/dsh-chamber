/**
 * gateway session-state store: the persisted, bounded row projection. Merge semantics
 * (baseline/status/activity/added/removed/pending/goal), the delta ring, the durable
 * document with corrupt-aside recovery, and the observer-owned completion edges all
 * live here. Split out of session-state.ts (B3-3); the facade keeps the service.
 */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  SESSION_STATE_PROTOCOL_VERSION, classifyTurnEnd, createJsonStore, ensurePrivateDirectoryNoFollow,
  type JsonStore, type SessionStateCompletedAtSource, type SessionStateDelta,
  type SessionStateGoalActivation, type SessionStateHostInfo,
  type SessionStateMode, type SessionStateSnapshot,
} from '@dsh-chamber/control-plane'
import { isWatermark } from '@dsh-chamber/dsh-chamber-wire/json-guards'
import type {
  CompletionEdge, SessionStateStore, SessionStateStoreDeps, SessionStateStoreStatus,
} from '../session-state-types.ts'
import {
  SESSION_STATE_SCHEMA_VERSION, cloneGoalFact, createStoredRow, emptyDocument, mergeGoalFact,
  persistedGoalFact, persistedRow, toWireRow, validateDocument,
  type SessionStateDocument, type StoredHost, type StoredRow,
} from './store-codec.ts'
import { featuresForMode } from './features.ts'

export { SESSION_STATE_SCHEMA_VERSION } from './store-codec.ts'
export const SESSION_STATE_DIR_NAME = 'session-state'
export const SESSION_STATE_FILE_NAME = 'state.json'
/** Hard row cap; the excess is evicted by observedAt and counted in dropped. */
export const MAX_SESSIONS = 2_000
/**
 * Cap of process-local retained goal-activation edges (P2a). A host can emit
 * edges for session ids no projection ever carries, so the map must stay
 * bounded: eviction is oldest-first and counted in `dropped.goalActivations`.
 */
export const MAX_PENDING_GOAL_ACTIVATIONS = MAX_SESSIONS
/** In-memory SSE resume window (deltas, not bytes). */
export const SSE_RING_MAX = 1_024
export const PERSIST_DEBOUNCE_MS = 1_000

const SESSION_STATE_DIR_MODE = 0o700
const SESSION_STATE_FILE_MODE = 0o600


/**
 * Create the session-state store. Loading is loud: a corrupt main falls back to
 * the backup with an explicit recovery state; a double corruption stays sticky
 * integrity='corrupt', starts cold and REFUSES to persist (the damaged evidence
 * is never overwritten).
 */
export function createSessionStateStore(deps: SessionStateStoreDeps): SessionStateStore {
  const now = deps.now ?? (() => Date.now())
  // Observer epoch id; a fresh one per process (gap reconstruction input).
  const epoch = randomUUID()

  /** Persisted projection of one row: the goal fact is written without its
   *  process-local `activation` (and without any unknown field). */
  const sessionStateDir = join(deps.stateDir, SESSION_STATE_DIR_NAME)
  const filePath = join(sessionStateDir, SESSION_STATE_FILE_NAME)
  ensurePrivateDirectoryNoFollow(sessionStateDir, SESSION_STATE_DIR_MODE)

  const rows = new Map<string, StoredRow>()
  const ring: SessionStateDelta[] = []
  const listeners = new Set<(delta: SessionStateDelta) => void>()
  const gapCandidates = new Set<string>()
  // The edge object is an opaque per-run capability. An older follow cannot
  // settle a newly running session, a later prompt, or a replacement edge.
  const pendingEdges = new Map<string, CompletionEdge>()
  /**
   * Process-local activation edges whose goal id has not matched a projected
   * row yet (the create raced a lagging session/list projection) — P2a
   * identity binding. At most one edge per session (the latest wins); never
   * persisted, cleared with the epoch and with the row's removal/prune.
   * Bounded by {@link MAX_PENDING_GOAL_ACTIVATIONS}: a host can emit edges for
   * ids no baseline ever carries, so the oldest retained edge is evicted and
   * counted in `dropped.goalActivations` (never silent).
   */
  const pendingGoalActivations = new Map<string, { goalId: string | null; activation: SessionStateGoalActivation }>()

  /** Retain one edge (latest wins) under the map cap. */
  function retainPendingGoalActivation(
    sessionId: string,
    edge: { goalId: string | null; activation: SessionStateGoalActivation },
  ): void {
    const retained = pendingGoalActivations.has(sessionId)
    if (!retained && pendingGoalActivations.size >= MAX_PENDING_GOAL_ACTIVATIONS) {
      const oldest = pendingGoalActivations.keys().next()
      if (oldest.done !== true) pendingGoalActivations.delete(oldest.value)
      dropped.goalActivations += 1
      warn('pending goal-activation cap reached; dropped the oldest retained edge (never silent)')
    }
    // Map.set on an existing key does NOT move it to the end: an updated edge
    // would keep its first-seen position and be evicted as "oldest" on the next
    // overflow. Delete-then-set refreshes the retention order (LRU: eviction is
    // least-recently-updated, never least-recently-first-seen).
    if (retained) pendingGoalActivations.delete(sessionId)
    pendingGoalActivations.set(sessionId, edge)
  }
  /**
   * 本进程已成功应用的「成功且完整」基线数（S4/T2）：wire `diagnostics.baselines` 的
   * 唯一来源，含 poll 档（mux 的自计数只作观察者自诊断）。同时承担「本进程首份基线」
   * 判定——重启后持久化的 running 行只在这一拍被当作缺口候选分类。
   */
  let baselinesApplied = 0

  let cursor = 0
  let mode: SessionStateMode = 'poll'
  let host: StoredHost = { state: 'unknown', serviceable: false, since: now() }
  let dropped = { sessions: 0, goalActivations: 0 }
  // 每条完成边沿的 turn/end 分类构成（与 follow 读取一一对应）。
  const turnEnds = { completed: 0, userStopped: 0, neutral: 0, unreadable: 0 }
  let integrity: SessionStateStoreStatus['integrity'] = 'ok'
  let recoveryDetail: string | null = null
  let loaded = false
  let persistBlocked = false
  let persistedAt: number | null = null
  let doc: SessionStateDocument = emptyDocument(now(), epoch)

  // Accumulated delta changes (one cursor step per committed batch).
  const deltaSessions = new Map<string, StoredRow>()
  const deltaRemoved = new Set<string>()
  let deltaHost = false
  let deltaMode = false
  let revision = 0
  let persistTimer: ReturnType<typeof setTimeout> | null = null
  let flushing: Promise<void> | null = null


  function warn(message: string): void {
    deps.logger.warn('gateway session-state: ' + message)
  }



  /**
   * Validate one persisted goal fact. A persisted `activation` is deliberately
   * IGNORED: activation is a process-local value, so a restart must clear it
   * back to unknown (never adopt a stale edge from disk). Unknown extra fields
   * are dropped by construction (whitelist), matching the wire projector.
   */


  let jsonStore: JsonStore | null = null
  try {
    jsonStore = createJsonStore({
      filePath,
      logger: deps.logger,
      initial: emptyDocument(now(), epoch),
      fileMode: SESSION_STATE_FILE_MODE,
      onLoadValidate: (raw) => {
        const result = validateDocument(raw as Record<string, unknown>, { now, epoch })
        if (result.droppedSessions > 0) {
          warn('dropped ' + result.droppedSessions + ' unreadable session row(s) while loading; never silent')
        }
        return { doc: result.doc, dropped: { connections: 0, projects: 0 } }
      },
    })
    const loadedDoc = jsonStore.load() as unknown as SessionStateDocument
    const storeStatus = jsonStore.getStatus()
    integrity = storeStatus.recoveryState === null ? 'ok' : 'recovered'
    recoveryDetail = storeStatus.recoveryState === null
      ? null
      : 'recovered session-state snapshot from ' + storeStatus.recoveryState.source
    if (integrity === 'recovered') warn(recoveryDetail + '; loading the last durable completion state')
    adoptDocument(loadedDoc)
    loaded = true
  } catch (error) {
    integrity = 'corrupt'
    recoveryDetail = error instanceof Error ? error.message : String(error)
    // Corrupt is never a fake-empty AND never an overwrite: serve cold, refuse persistence, stay loud.
    warn('session-state snapshot is corrupt and will NOT be overwritten (' + recoveryDetail
      + '); starting cold - unread may be lost, never fabricated')
    doc = emptyDocument(now(), epoch)
    persistBlocked = true
    loaded = false
  }

  function adoptDocument(loadedDoc: SessionStateDocument): void {
    doc = loadedDoc
    cursor = isWatermark(doc.cursor) ? doc.cursor : 0
    mode = doc.mode === 'sse' || doc.mode === 'poll' || doc.mode === 'off' ? doc.mode : 'poll'
    host = doc.host
    dropped = {
      sessions: isWatermark(doc.dropped?.sessions) ? doc.dropped.sessions : 0,
      // goalActivations 是进程内累计计数：validateDocument 在加载时已按契约把它
      // 归 0（保留边不落盘，重启本就不继承），这里从 0 起算。绝不按持久值读——
      // 那是 validateDocument 永不产生非零值的死分支。
      goalActivations: 0,
    }
    revision = isWatermark(doc.revision) ? doc.revision : 0
    for (const row of doc.sessions) {
      rows.set(row.sessionId, row)
      if (row.running) gapCandidates.add(row.sessionId)
    }
  }

  // --- persistence ---------------------------------------------------------

  function markDirty(): void {
    if (persistBlocked) return
    if (persistTimer !== null) return
    persistTimer = setTimeout(() => {
      persistTimer = null
      void flush()
    }, PERSIST_DEBOUNCE_MS)
    persistTimer.unref?.()
  }

  function enforceLimits(): void {
    if (rows.size <= MAX_SESSIONS) return
    const ordered = [...rows.values()].sort((a, b) => a.observedAt - b.observedAt)
    for (const row of ordered.slice(0, rows.size - MAX_SESSIONS)) {
      const wasDeliverable = isDeliverable(row)
      rows.delete(row.sessionId)
      // Eviction is a deletion, not a quiet field wipe: a row that once rode the
      // wire must be retracted (applyRemoved discipline), or an SSE client keeps
      // a phantom row forever. A never-delivered row (unconfirmed identity) is
      // removed silently — a removal for it would be a phantom retraction.
      deltaSessions.delete(row.sessionId)
      if (wasDeliverable) deltaRemoved.add(row.sessionId)
      // 完成边与 goal 边随行消亡：其余删除路径都做（applyRemoved / baseline 缺席 prune），
      // 漏掉会让陈旧边在重列后复活，也会让 map 无界残留。
      pendingEdges.delete(row.sessionId)
      if (pendingGoalActivations.delete(row.sessionId)) dropped.goalActivations += 1
      dropped.sessions += 1
    }
    warn('session cap reached; dropped ' + dropped.sessions + ' oldest row(s) (never silent)')
    // 淘汰是删除：子代理行被淘汰时父的 subagentCount 必须同拍回落（与 applyRemoved / 基线
    // 缺席同一纪律），否则陈旧计数会随本次 flush 一起落盘。
    recomputeSubagentCounts()
    commitDelta()
  }

  async function flush(): Promise<void> {
    if (flushing !== null) return flushing
    const run = (async () => {
      try {
        // The row cap is an in-memory invariant, NOT a persistence concern: it
        // must hold even when persistence is refused (double corruption
        // early-returns below). Enforce it BEFORE the persistBlocked gate, or a
        // 2005-row baseline would be served over the cap with dropped.sessions
        // stuck at 0 in exactly the state where the snapshot is the only
        // evidence left.
        enforceLimits()
        if (persistBlocked) return
        revision += 1
        doc.schemaVersion = SESSION_STATE_SCHEMA_VERSION
        doc.revision = revision
        doc.cursor = cursor
        doc.watcherEpoch = epoch
        doc.mode = mode
        doc.host = host
        doc.sessions = [...rows.values()].map(persistedRow)
        doc.dropped = { ...dropped }
        if (jsonStore !== null) await jsonStore.persist(doc)
        persistedAt = now()
      } catch (error) {
        // Never fatal: the in-memory state stays authoritative until the next
        // successful flush, and the failure is loud.
        warn('snapshot persist failed: ' + (error instanceof Error ? error.message : String(error)))
      }
    })()
    flushing = run
    try {
      await run
    } finally {
      flushing = null
    }
  }

  // --- delta emission ------------------------------------------------------

  function hostInfo(): SessionStateHostInfo {
    return { now: now(), serviceable: host.serviceable, state: host.state }
  }

  /**
   * 单点投递判定（snapshot 与 delta 同规，S1）：子代理行不是桌面事实主体
   *  （design 19 §3.2）；**行身份只能由列表事实确认**——只有 applyBaseline/applyAdded
   *  置真的 originKnown 才算数，仅由 status/activity/pending 建的行（originKnown=false）
   *  一律不投递，直到某次基线或 added 把它确认为顶层。该硬门覆盖进程重启、每次 $events
   *  换代与任何 added 丢失窗口，绝不依赖「本进程见过基线」这类进程级一次性状态。
   *  代价：顶层新会话若 added 丢失，其 status-only 行最晚等一次基线（poll 15s /
   *  sse ≤60s）才进入判定面——以硬约束「子代理绝不通知」为先。
   *  基线缺席行已在 applyBaseline 里直接删除（S3 单阶段），不会走到这里。
   */
  function isDeliverable(row: StoredRow): boolean {
    return row.present && row.origin !== 'subagent' && row.originKnown
  }

  function commitDelta(): void {
    const sessions = [...deltaSessions.values()]
      .filter(isDeliverable)
      .map(toWireRow)
    if (sessions.length === 0 && deltaRemoved.size === 0 && !deltaHost && !deltaMode) {
      // 只有被过滤的行发生变化：游标不前进、payload 为空。
      deltaSessions.clear()
      deltaRemoved.clear()
      return
    }
    cursor += 1
    const delta: SessionStateDelta = {
      cursor,
      sessions,
      removedSessionIds: [...deltaRemoved],
      host: deltaHost ? hostInfo() : null,
      mode: deltaMode ? mode : null,
    }
    deltaSessions.clear()
    deltaRemoved.clear()
    deltaHost = false
    deltaMode = false
    ring.push(delta)
    if (ring.length > SSE_RING_MAX) ring.splice(0, ring.length - SSE_RING_MAX)
    for (const listener of [...listeners]) {
      try {
        listener(delta)
      } catch (error) {
        warn('delta listener failed: ' + (error instanceof Error ? error.message : String(error)))
      }
    }
    markDirty()
  }

  function recomputeSubagentCounts(): void {
    const counts = new Map<string, number>()
    for (const row of rows.values()) {
      if (!row.present || row.origin !== 'subagent' || row.parentSessionId === null) continue
      counts.set(row.parentSessionId, (counts.get(row.parentSessionId) ?? 0) + 1)
    }
    for (const row of rows.values()) {
      const next = counts.get(row.sessionId) ?? 0
      if (next !== row.subagentCount) {
        row.subagentCount = next
        deltaSessions.set(row.sessionId, row)
      }
    }
  }

  function getOrCreate(sessionId: string, at: number): StoredRow {
    let row = rows.get(sessionId)
    if (row === undefined) {
      row = createStoredRow(sessionId, at)
      rows.set(sessionId, row)
      deltaSessions.set(sessionId, row)
    }
    return row
  }

  function clearConclusion(row: StoredRow): void {
    row.completedAt = null
    row.completedAtSource = null
    row.lastTurnEnd = null
  }

  /**
   * 子代理身份边界上的结论清除（S1 后续修正）：子代理行不是投递主体，但行本身必须保留
   * ——父的 `subagentCount` 仍由它统计。进入子代理身份时丢掉此前（顶层身份期间）武装的
   * 结论；身份翻回顶层时再清一次：子代理身份期间仍可能有 status/基线边沿武装出 observed
   * 完成（读尾照常分类），不清就会以「全新行」形态带出一条真横幅。P2b 在揭示子代理时
   * `retireSession`、重上架即全新行（source-mux-facts.ts）；本处保留行、只清结论，同语义。
   */
  function clearConclusionAtSubagentBoundary(row: StoredRow): void {
    clearConclusion(row)
    pendingEdges.delete(row.sessionId)
  }

  function newCompletionEdge(sessionId: string, source: SessionStateCompletedAtSource): CompletionEdge {
    const edge = { sessionId, source }
    pendingEdges.set(sessionId, edge)
    return edge
  }

  /**
   * Apply a retained activation edge after a baseline/added merged a goal fact
   * into the row. The edge is consumed only when the projected goal identity
   * matches (an unbound edge matches the current known goal); a mismatching edge
   * stays retained for a later projection and never touches the previous goal's
   * row. An absent/unknown/null projection keeps the edge too: the create may
   * still be racing this baseline.
   * @returns whether the row's fact changed (delta emission input).
   */
  function applyRetainedGoalActivation(row: StoredRow, at: number): boolean {
    const goal = row.goal
    if (goal === undefined || goal === null) return false
    const edge = pendingGoalActivations.get(row.sessionId)
    if (edge === undefined) return false
    if (edge.goalId !== null && edge.goalId !== goal.goalId) return false
    pendingGoalActivations.delete(row.sessionId)
    if (goal.activation === edge.activation) return false
    const next = cloneGoalFact(goal)
    next.activation = edge.activation
    row.goal = next
    row.observedAt = at
    return true
  }

  return {
    status(): SessionStateStoreStatus {
      return {
        integrity,
        recoveryDetail,
        loaded,
        persistedAt,
        cursor,
        sessions: rows.size,
        dropped: { ...dropped },
        turnEnds: { ...turnEnds },
        baselines: baselinesApplied,
      }
    },

    host: hostInfo,

    setHost(input): boolean {
      const serviceable = input.serviceable === true
      if (host.state === input.state && host.serviceable === serviceable) return false
      const stateChanged = host.state !== input.state
      host = { ...host, state: input.state, serviceable, since: stateChanged ? now() : host.since }
      deltaHost = true
      commitDelta()
      return true
    },

    mode(): SessionStateMode {
      return mode
    },

    setMode(next): boolean {
      if (mode === next) return false
      mode = next
      deltaMode = true
      commitDelta()
      return true
    },

    applyBaseline(items, opts): CompletionEdge[] {
      const seen = new Set<string>()
      const edges: CompletionEdge[] = []
      for (const item of items) {
        seen.add(item.sessionId)
        // 「曾经存在」是翻转补移除的前提：首见即子代理的行从未上线，补移除只会造假删除与假提示。
        const existed = rows.has(item.sessionId)
        const row = getOrCreate(item.sessionId, opts.at)
        // 变更**前**该行是否可能已经被投递：补移除只对已上线的行有意义。身份未确认
        // （仅由 status 首建）的行从未投递，翻成子代理时补移除只会造出幽灵撤回（S1）。
        const wasDeliverable = isDeliverable(row)
        const previousRunning = row.running
        const previousUpdatedAt = row.updatedAt
        const previousOrigin = row.origin
        row.updatedAt = Math.max(row.updatedAt, item.updatedAt)
        row.present = true
        row.observedAt = opts.at
        row.parentSessionId = item.parentSessionId
        row.origin = item.origin
        row.originKnown = true
        // 身份边界的结论清除：进入子代理 / 从子代理翻回顶层都不带旧结论（见 helper 头注）。
        if (item.origin === 'subagent' || previousOrigin === 'subagent') {
          clearConclusionAtSubagentBoundary(row)
        }
        // 门开（或从旧的未投递态转成可投递）本身就是一次投递变化：不只在字段变化时发。
        // 否则首基线前被扣下的 activity 行（updatedAt 已在位、基线带同一值）会静默上线，
        // 只被后续整量快照看见，delta-only 客户端会缺这一行。
        const becameDeliverable = !wasDeliverable && isDeliverable(row)
        // 曾以顶层身份上线又变成子代理：补移除，桌面才能丢掉它（并清掉可能已武装的行）。
        if (item.origin === 'subagent' && existed && wasDeliverable) deltaRemoved.add(item.sessionId)
        // Baseline refresh is the phase/watermark authority; activation (if any)
        // survives an unchanged goalId, and a retained edge for THIS goal id
        // lands the moment the create reaches the projection.
        const mergedGoal = mergeGoalFact(row, item.goal)
        const retainedGoal = applyRetainedGoalActivation(row, opts.at)
        const goalChanged = mergedGoal || retainedGoal
        if (item.running) {
          const resolves = row.completedAt !== null || row.completedAtSource !== null || row.lastTurnEnd !== null
          row.running = true
          row.lastRunningAt = opts.at
          clearConclusion(row)
          pendingEdges.delete(item.sessionId)
          gapCandidates.delete(item.sessionId)
          if (becameDeliverable || !previousRunning || resolves || row.updatedAt !== previousUpdatedAt || goalChanged) {
            deltaSessions.set(item.sessionId, row)
          }
        } else if (previousRunning) {
          // The edge is armed by the observer after ONE classified follow read; the baseline never arms completedAt raw.
          row.running = false
          const source: SessionStateCompletedAtSource = gapCandidates.has(item.sessionId) ? 'reconstructed' : 'observed'
          gapCandidates.delete(item.sessionId)
          edges.push(newCompletionEdge(item.sessionId, source))
          deltaSessions.set(item.sessionId, row)
        } else {
          if (row.updatedAt > previousUpdatedAt) {
            // The official list watermark is lastPromptAt. A newer prompt
            // invalidates the previous conclusion even when both list samples
            // are stopped (the true/false pair may have been lost).
            clearConclusion(row)
            pendingEdges.delete(item.sessionId)
          }
          const pending = pendingEdges.get(item.sessionId)
          if (pending !== undefined && row.updatedAt === previousUpdatedAt) edges.push(pending)
          // becameDeliverable 已覆盖「subagent 行翻回顶层」的形状（当时不可投递 ⇒ 现在可投递）。
          if (becameDeliverable || row.running !== false || row.updatedAt !== previousUpdatedAt || goalChanged) {
            row.running = false
            deltaSessions.set(item.sessionId, row)
          }
        }
      }
      for (const row of [...rows.values()]) {
        if (seen.has(row.sessionId)) continue
        // 单阶段删除（2026-12 收尾，按上游 ready-即删对齐；design 17 §10.7）：一次
        // **成功且完整**的基线缺席即离表——进 removedSessionIds 并从 store 删除，不再有
        // 「首次隐藏、二次剪枝」的容忍窗。删除不是完成：不发 running:false、不产完成
        // 边沿（缺 wire 行 = 客户端离表清臂 + 随行退役记忆）。
        const wasDeliverable = isDeliverable(row)
        rows.delete(row.sessionId)
        pendingEdges.delete(row.sessionId)
        // The retained edge dies with the pruned row: a re-listed session id
        // must never inherit it (same rule as applyRemoved / the row cap).
        pendingGoalActivations.delete(row.sessionId)
        deltaSessions.delete(row.sessionId)
        // 从未上线的行（首基线前的 status 行、子代理行）删除时静默：补移除是幽灵撤回。
        if (wasDeliverable) deltaRemoved.add(row.sessionId)
      }
      recomputeSubagentCounts()
      // A persisted running candidate is recognized on the first complete
      // baseline after load; an unreadable classification may still retry.
      // （首份基线的判定与新计数同源，不再维护第二个布尔。）
      if (baselinesApplied === 0) gapCandidates.clear()
      baselinesApplied += 1
      // 每次成功基线照旧投递 host 帧（now 变化即证据）；host 本身只有 state/serviceable/since 三键。
      deltaHost = true
      commitDelta()
      return edges
    },

    applyStatus(sessionId, running, at): CompletionEdge[] {
      const row = getOrCreate(sessionId, at)
      row.observedAt = at
      row.present = true
      if (running) {
        const changed = row.running !== true || row.completedAt !== null || row.completedAtSource !== null
          || row.lastTurnEnd !== null || row.pendingKind !== null
        row.running = true
        row.lastRunningAt = at
        clearConclusion(row)
        pendingEdges.delete(sessionId)
        row.pendingKind = null
        gapCandidates.delete(sessionId)
        if (changed) deltaSessions.set(sessionId, row)
        commitDelta()
        return []
      }
      if (row.running) {
        row.running = false
        const source: SessionStateCompletedAtSource = gapCandidates.has(sessionId) ? 'reconstructed' : 'observed'
        gapCandidates.delete(sessionId)
        deltaSessions.set(sessionId, row)
        commitDelta()
        return [newCompletionEdge(sessionId, source)]
      }
      // Already stopped: nothing changed (a duplicate status(false) must not advance the cursor).
      // （S3 起行在即 present；旧的 !wasPresent 分支已无写入者，删除。）
      commitDelta()
      return []
    },

    applyActivity(sessionId, updatedAt, at): boolean {
      if (!isWatermark(updatedAt)) return false
      const row = getOrCreate(sessionId, at)
      row.observedAt = at
      row.present = true
      if (updatedAt <= row.updatedAt) return false
      row.updatedAt = updatedAt
      if (!row.running) {
        clearConclusion(row)
        pendingEdges.delete(sessionId)
      }
      deltaSessions.set(sessionId, row)
      commitDelta()
      return true
    },

    applyAdded(item, at): boolean {
      const existed = rows.has(item.sessionId)
      const row = getOrCreate(item.sessionId, at)
      const wasDeliverable = isDeliverable(row)
      const previousOrigin = row.origin
      row.observedAt = at
      row.present = true
      row.parentSessionId = item.parentSessionId
      row.origin = item.origin
      row.originKnown = true
      // 与 applyBaseline 同一身份边界纪律：子代理行不带结论，翻回顶层即全新行。
      if (item.origin === 'subagent' || previousOrigin === 'subagent') {
        clearConclusionAtSubagentBoundary(row)
      }
      if (item.origin === 'subagent' && existed && wasDeliverable) deltaRemoved.add(item.sessionId)
      const previousUpdatedAt = row.updatedAt
      row.updatedAt = Math.max(row.updatedAt, item.updatedAt)
      mergeGoalFact(row, item.goal)
      // An added frame can be the first projection that carries the new goal:
      // the retained activation edge lands with the row itself.
      applyRetainedGoalActivation(row, at)
      if (item.running) {
        row.running = true
        row.lastRunningAt = at
        clearConclusion(row)
        pendingEdges.delete(item.sessionId)
      } else if (row.updatedAt > previousUpdatedAt && !row.running) {
        clearConclusion(row)
        pendingEdges.delete(item.sessionId)
      }
      recomputeSubagentCounts()
      deltaSessions.set(item.sessionId, row)
      commitDelta()
      return true
    },

    applyRemoved(sessionId): boolean {
      // The retained edge dies with the session even when no row ever existed
      // (an activation edge that outraced its create): a re-created session id
      // must never inherit it. Delete BEFORE the early return.
      pendingGoalActivations.delete(sessionId)
      const row = rows.get(sessionId)
      if (row === undefined) return false
      const wasDeliverable = isDeliverable(row)
      // The goal fact and the completion edge die with the row.
      rows.delete(sessionId)
      pendingEdges.delete(sessionId)
      deltaSessions.delete(sessionId)
      // 补移除只对「曾可投递」的行有意义（与 baseline 缺席删除同一门槛）：身份未确认的
      // status 行从未上线，补 removed 只会造出幽灵撤回与多余的整量重取提示。
      if (wasDeliverable) deltaRemoved.add(sessionId)
      recomputeSubagentCounts()
      commitDelta()
      return true
    },

    applyGoalActivation(event, at): boolean {
      const { sessionId } = event
      if (event.activation === null) {
        // The host explicitly reports no current goal; a retained edge for a
        // goal that no longer exists is dead information now.
        pendingGoalActivations.delete(sessionId)
        // Only a KNOWN fact is resolved to `null`: an unknown row stays unknown
        // (we never fabricate "no goal" from an activation edge that may have
        // outraced the baseline).
        const row = rows.get(sessionId)
        if (row === undefined || row.goal === undefined || row.goal === null) return false
        row.goal = null
        row.observedAt = at
        deltaSessions.set(sessionId, row)
        commitDelta()
        return true
      }
      const row = rows.get(sessionId)
      const goal = row === undefined ? undefined : row.goal
      // Identity binding (P2a): a bound edge lands ONLY on the projected goal
      // with the same id; an unbound edge acts on the current known goal
      // (mirroring the renderer P2b parser). An unknown row, an unknown
      // projection, or a create that outran the baseline retains the edge until
      // a baseline/added brings the matching identity — never guessed onto the
      // previous goal's row (that produced complete+armed).
      if (row === undefined || goal === undefined || goal === null
        || (event.goalId !== null && event.goalId !== goal.goalId)) {
        retainPendingGoalActivation(sessionId, { goalId: event.goalId, activation: event.activation })
        return false
      }
      // The latest event for this session supersedes any earlier retained edge.
      pendingGoalActivations.delete(sessionId)
      if (goal.activation === event.activation) return false
      const next = cloneGoalFact(goal)
      next.activation = event.activation
      row.goal = next
      row.observedAt = at
      deltaSessions.set(sessionId, row)
      commitDelta()
      return true
    },

    clearGoalActivations(at): boolean {
      // A new $events generation invalidates every process-local edge — both the
      // applied values below and edges still waiting for their projection.
      pendingGoalActivations.clear()
      let changed = false
      for (const row of rows.values()) {
        const goal = row.goal
        if (goal === undefined || goal === null || goal.activation === undefined) continue
        row.goal = persistedGoalFact(goal)
        row.observedAt = at
        deltaSessions.set(row.sessionId, row)
        changed = true
      }
      if (changed) commitDelta()
      return changed
    },

    applyPending(sessionId, kind, at): boolean {
      const row = getOrCreate(sessionId, at)
      if (row.pendingKind === kind) return false
      // 兼容位（S3）：旧文档的 present:false 行仍按隐藏读；瀑布帧是行在场的证据，与
      // applyStatus/applyActivity 同规把行置回 present（身份门 originKnown 不受影响）。
      row.present = true
      row.pendingKind = kind
      row.observedAt = at
      deltaSessions.set(sessionId, row)
      commitDelta()
      return true
    },

    clearPending(sessionId, at): boolean {
      const row = rows.get(sessionId)
      if (row === undefined || row.pendingKind === null) return false
      // 同上：cancel 帧同样证明行在场，与 status/activity 同规置回 present。
      row.present = true
      row.pendingKind = null
      row.observedAt = at
      deltaSessions.set(sessionId, row)
      commitDelta()
      return true
    },

    settleCompletion(edge, input): boolean {
      const row = rows.get(edge.sessionId)
      if (row === undefined || row.running || pendingEdges.get(edge.sessionId) !== edge) return false
      if (!input.unreadable) pendingEdges.delete(edge.sessionId)
      const disposition = classifyTurnEnd(input.turnEnd)
      if (input.unreadable) turnEnds.unreadable += 1
      else if (disposition === 'completed') turnEnds.completed += 1
      else if (disposition === 'user-stopped') turnEnds.userStopped += 1
      else turnEnds.neutral += 1
      // completed arms unread; a user stop / neutral conclusion arms nothing. An
      // unreadable tail arms with lastTurnEnd null as the degraded marker.
      const completed = disposition === 'completed' || input.unreadable
      const nextCompletedAt = completed
        ? input.unreadable && row.completedAtSource === 'reconstructed' && row.completedAt !== null
          ? row.completedAt
          : input.at
        : null
      // A missing turn/end proves only "stopped". Keep unread, but never
      // present it as a classified completion eligible for a notification.
      const nextSource = completed ? input.unreadable ? 'reconstructed' : edge.source : null
      const changed = row.completedAt !== nextCompletedAt
        || row.completedAtSource !== nextSource
        || row.lastTurnEnd !== input.turnEnd
      row.completedAt = nextCompletedAt
      row.completedAtSource = nextSource
      row.lastTurnEnd = input.turnEnd
      row.observedAt = input.at
      if (!changed) return false
      deltaSessions.set(edge.sessionId, row)
      commitDelta()
      return true
    },

    snapshotFor(snapshotMode, snapshotHost): SessionStateSnapshot {
      const sessions = [...rows.values()]
        .filter(isDeliverable)
        .sort((a, b) => {
          const aw = Math.max(a.updatedAt, a.completedAt ?? 0, a.observedAt)
          const bw = Math.max(b.updatedAt, b.completedAt ?? 0, b.observedAt)
          return bw - aw || (a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0)
        })
        .map(toWireRow)
      return {
        protocol: SESSION_STATE_PROTOCOL_VERSION,
        features: featuresForMode(snapshotMode),
        mode: snapshotMode,
        cursor,
        host: snapshotHost,
        sessions,
      }
    },

    subscribe(listener): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },

    replayFrom(sinceCursor): SessionStateDelta[] | null {
      if (!isWatermark(sinceCursor) || sinceCursor > cursor) return null
      if (sinceCursor === cursor) return []
      const events = ring.filter(delta => delta.cursor > sinceCursor)
      if (events.length === 0) return null
      if (events[0].cursor !== sinceCursor + 1) return null
      return events
    },

    flush,

    dispose(): void {
      if (persistTimer !== null) {
        clearTimeout(persistTimer)
        persistTimer = null
      }
    },
  }
}



