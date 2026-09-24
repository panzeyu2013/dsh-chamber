/**
 * The per-source mutable bookkeeping of the renderer host: every table whose
 * key is a source id and whose lifecycle is "created on first fact, dropped
 * when the registry retires the source". This file owns the FIELD LIST, so the
 * retirement paths cannot drift — a new per-source table is added here once and
 * every prune/drop site follows.
 *
 * The fields stay ref-shaped (`{ current }`) on purpose: the app-hooks receive
 * them as mutable boxes and write from event callbacks, so turning them into a
 * rendered store is a separate (rendering) decision, not a bookkeeping one.
 *
 * Identity-preserving: a prune that removes nothing keeps the SAME object, so
 * consumers that memoize on identity do not re-render for a no-op.
 */
import type { SessionFacts } from '../notification-edges.ts'
import { pruneSourceRecord, pruneSourceSet } from '../source-registry.ts'

export interface RefBox<T> {
  current: T
}

export interface SourceLedger {
  /** Last PUSHED-snapshot timestamp per source (ms epoch; absent = never).
   * The staleness watchdog uses recency as its only liveness signal — the
   * unary client exposes no per-source connection state, and a silently dead
   * push channel never fires the producer withdrawal. */
  snapshotAt: RefBox<Record<string, number>>
  /** 最近一次**成功验证事实**（push 或 unary 提交）的时刻：保留视图据此有界化
   * ——超过界限仍无法验证时不保留该 running 断言（design 05）。 */
  factsAt: RefBox<Record<string, number>>
  /** Last connection-reconnect timestamp per source (ms epoch; absent = never
   * reconnected). Bounds repeat reconnects of one stale mounted source
   * (AGGREGATE_RECONNECT_BACKOFF_MS); reaped with the source so a same-id re-add
   * starts a fresh backoff window. */
  lastReconnectAt: RefBox<Record<string, number>>
  /** Last session-list refresh request timestamp per source (design 24;
   * floors the ghost-row re-request cadence: a refresh re-runs the OFFICIAL
   * session.list of the mounted ctx). Reaped with the source. */
  sessionListRefreshAt: RefBox<Record<string, number>>
  /** Un-converged ghost-row ids per source (design 24): archived ids whose rows
   * are still listed in the latest mounted push. Maintained by
   * planSessionListRefresh; empty/absent = converged. */
  sessionListRefreshPending: RefBox<Record<string, string[]>>
  /** Last AUTHORITATIVE archive set per source (design 24): ids published by a
   * mounted push with `archiveSetKnown: true`. It survives the aggregate being
   * replaced by the degraded unary view, so a purge shrink stays detectable and
   * a degraded commit keeps filtering archived rows. Never authoritative on its
   * own. */
  authoritativeArchiveSet: RefBox<Record<string, readonly string[]>>
  /** 通知边沿记忆（设计 19）：每来源每会话的上一份事实快照（running→idle /
   * pending 武装边沿）。与 prevRunning（蓝点机）并存互不耦合。 */
  prevRuntimeFacts: RefBox<Record<string, Record<string, SessionFacts>>>
  /** 蓝点机（未读边沿）的上一轮 running 投影。随来源生命周期收敛。 */
  prevRunning: RefBox<Record<string, Record<string, boolean>>>
  /** 首帧从 v2 落盘载入的读水位（sourceId → sessionId → host 域水位）。 */
  readMarks: RefBox<Record<string, Record<string, number>>>
  /** 通知第二入口的基线播种集：首份 facts 快照只播种水位，不补发通知。 */
  factsSeeded: RefBox<Set<string>>
  /** 行刷新提示的 floor 记账（每来源）。 */
  refreshHintAt: RefBox<Record<string, number>>
  /** 每来源在途 unary 拉取计数（提示的 inFlight 拒绝输入）。 */
  factsPullInFlight: RefBox<Record<string, number>>
}

/** Build an empty ledger. The two persisted tables are installed by the App
 * once the unread boot payload is read (assignment, not construction: the
 * ledger exists before the payload does). */
export function createSourceLedger(): SourceLedger {
  return {
    snapshotAt: { current: {} },
    factsAt: { current: {} },
    lastReconnectAt: { current: {} },
    sessionListRefreshAt: { current: {} },
    sessionListRefreshPending: { current: {} },
    authoritativeArchiveSet: { current: {} },
    prevRuntimeFacts: { current: {} },
    prevRunning: { current: {} },
    readMarks: { current: {} },
    factsSeeded: { current: new Set() },
    refreshHintAt: { current: {} },
    factsPullInFlight: { current: {} },
  }
}

/**
 * Prune every ledger table against the live source set, in one pass. The
 * mounted-source table is NOT here: host/mounted-sources-store.ts owns it and
 * its prune returns the dropped ids that drive the snapshotAt lockstep.
 */
export function pruneSourceLedger(ledger: SourceLedger, live: ReadonlySet<string>): void {
  const records: Array<RefBox<Record<string, unknown>>> = [
    ledger.snapshotAt,
    ledger.factsAt,
    ledger.lastReconnectAt,
    ledger.sessionListRefreshAt,
    ledger.sessionListRefreshPending,
    ledger.authoritativeArchiveSet,
    ledger.prevRuntimeFacts,
    ledger.prevRunning,
    ledger.readMarks,
    ledger.refreshHintAt,
    ledger.factsPullInFlight,
  ]
  for (const box of records) {
    const next = pruneSourceRecord(box.current, live)
    if (next !== null) box.current = next
  }
  const seeded = pruneSourceSet(ledger.factsSeeded.current, live)
  if (seeded !== null) ledger.factsSeeded.current = seeded
}
