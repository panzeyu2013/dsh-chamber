/**
 * chamberBridge — the renderer-shared single instance (design 05 §3). The
 * chamber App layer (renderer main entry) publishes the merged multi-source
 * projection and consumes open-session requests; the sidebar plugin
 * subscribes to the projection and publishes open-session requests. Both
 * import this module through `@dsh-chamber/dsh-client-ui-sidebar/shared`; a
 * vite shared chunk keeps the runtime single instance.
 *
 * One workspace group in the sidebar projection (computed by shared/derive.ts).
 * The synthetic trailing ungrouped bucket carries `ungrouped: true` and the
 * shared UNGROUPED_WORKSPACE_ID as its id.
 */
import type { InstanceSnapshot } from './instance-api.ts'
import type { ArchivedSessionMetaRow } from './derive.ts'
import { assertSingletonModule } from './singleton.ts'

assertSingletonModule('aggregate-store')

/** Fail-closed validation for the immutable Context proof bound by shell.ts. */
export function isValidProducerSourceFingerprint(sourceId: string, value: unknown): value is string {
  return sourceId === 'local'
    ? value === 'local'
    : typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

export interface ChamberServerWorkspace {
  id: string
  title: string
  /** True only for the synthetic trailing ungrouped bucket. */
  ungrouped?: boolean
  /**
   * True only for the fallback's cwd-derived groups (`__cwd__:` ids,
   * fetchInstanceSnapshot). Display-only: the host does not know these ids,
   * so the sidebar must disable every workspace-scoped mutation on them
   * (ungrouped-bucket parity).
   */
  synthetic?: boolean
  sessions: { id: string; title: string; running?: boolean; updatedAt?: number; blank?: boolean }[]
}

export interface ChamberServerAggregate {
  /** 'local' | '<target-kind>-<id>' (`ssh-<id>` remains a legacy dsh id). */
  id: string
  /** Opaque authoritative lifecycle proof for this exact source incarnation. */
  sourceFingerprint: string
  /** Target semantics, independent from the transport mechanism (design 17 §2). */
  kind: 'local' | 'dsh' | 'gateway'
  /** How this target is reached. Local has no remote transport. */
  transport: 'local' | 'ssh' | 'http'
  /** Registry identity used by desktop IPC. Never derive it by slicing a source-id prefix. */
  rawId?: string
  label: string
  /** Local: dsh ready; remote: tunnel phase ready; gateway: tunnel ready AND the managed dsh is not terminal-down. */
  connected: boolean
  /** Status text (ready/connecting/… projection). */
  phase: string
  /**
   * Gateway only: the managed dsh was probed into a terminal-down state while
   * the TRANSPORT was up (`stopped`/`error`/`restart-exhausted`). A dedicated
   * fact, never re-derived from `phase`: `phase` merges the managed state with
   * the transport phase and both vocabularies contain `error`, so classifying
   * the merged string would misdiagnose an SSH/tunnel failure as a stopped
   * managed dsh (2026-12 review BLOCKER). Absent = not a gateway, transport
   * down, probe missing, or a healthy/transient managed state (fail open).
   */
  managedRuntimeDown?: boolean
  workspaces: ChamberServerWorkspace[]
  /** True when the per-instance aggregate snapshot has actually landed
   *  (sessions; workspace groups derive from session cwd facts since
   *  workspace.list was deleted upstream) — git-derived rows must not render
   *  before the aggregate itself. Absent on older producers = not ready. */
  aggregateReady?: boolean
  /** Snapshot-fetch error text from the last per-instance pull; absent = ok/not-connected. */
  aggregateError?: string
  /** Runtime facts from the source's own ctx (design 06 §4); attached, never polled. */
  runtime?: InstanceRuntimeReport
  /**
   * Archived-session metadata rows of this source (design 24 revision
   * 2026-09 — the archive manager lists what is archived; 2026 revision:
   * rows additionally carry their workspace attribution for the manager's
   * grouped listing — see ArchivedSessionMetaRow). Present when the
   * per-instance aggregate snapshot has landed. `archiveSetKnown` says
   * whether an EMPTY rows list is a true "nothing archived" fact:
   * - known (true): the mounted workspace baseline projected the registry
   *   archive set — [] means genuinely nothing archived;
   * - absent/undefined: rows derive from a source whose snapshot has not
   *   landed (aggregate not ok) or carries no archive-set metadata;
   * - known (false): the unary-fallback view — its archive set is unknown
   *   (documented KNOWN DEGRADATION) — [] must NEVER be read as "no archived
   *   sessions"; the archive manager shows an honest degraded branch with no
   *   destructive action (no list to select; whole-set purge was retired
   *   with the standalone delete-all — 2026 user decision).
   */
  archivedSessions?: ArchivedSessionMetaRow[]
  archiveSetKnown?: boolean
  /**
   * dsh version fact. The old in-ctx host-producer channel was removed
   * (upstream deleted the connection handshake's host.describe), so the
   * LOCAL instance's version flows straight from the desktop bridge
   * (`window.dshChamber.dshVersion` → App hostFacts); remote instances stay
   * unknown until the control-plane `dsh --version` facts are projected
   * through the chamber bridge.
   */
  dshVersion?: string
  /** Renderer-local client-plugin boot health for this source. */
  pluginDiagnostic?: PluginGraphDiagnostic
  updatedAt: number
}

export type PluginGraphDiagnosticState =
  | 'ok'
  | 'not-injected'
  | 'graph-unreachable'
  | 'bundle-load-failed'
  | 'restart-required'
  /** Cross-instance dsh runtime version drift (design 09 §3.5): the same
   *  plugin id was first claimed on this page by a DIFFERENT instance at
   *  another rev — no app restart can switch it, the instances' dsh runtime
   *  versions must be aligned instead. */
  | 'instance-version-conflict'

export interface PluginGraphDiagnostic {
  state: PluginGraphDiagnosticState
  message?: string
  pluginId?: string
  updatedAt: number
}

export interface OpenSessionRequest {
  sourceId: string
  sessionId: string
}

/**
 * Terminal outcome of one App-layer open attempt, published back to every
 * sidebar shell (design 05 §3's request channel is one-way — the App layer
 * owns the dispatch budget and the failure; the sidebar owns the row).
 * Success carries no message; failure carries the dispatch's loud report.
 */
export interface OpenSessionOutcome extends OpenSessionRequest {
  /** Present only on failure: the terminal error report (App-wrapped text). */
  message?: string
}

/**
 * Per-instance runtime facts projected by the sidebar plugin of the source's
 * own ctx (design 06 §4): current session id plus per-session live rows. The
 * plugin is a STATELESS projection of the source's session-list snapshot —
 * every listed session carries its live `running` bit (the App layer derives
 * the completed-but-unread dot from running→idle edges itself, see App.tsx),
 * completed/pending ride the vendor armed state as sparse extras, and
 * `runningSubagents` carries the vendor lineage index's RUNNING subagent
 * descendant count per parent (06 §4.5 — a parent whose round ended while
 * background subagents still work must not render its completed dot; the
 * renderer shows the subagent-live ring instead). Attached to
 * ChamberServerAggregate.runtime as a separate channel — never polled by the
 * App layer.
 */
export interface InstanceRuntimeReport {
  current?: string
  /**
   * Every listed session (edge memory for the App's completed-dot
   * derivation), carrying the live running bit; completed/pending appear only
   * when the vendor runtime armed them, runningSubagents only when non-zero.
   */
  sessions: Record<string, {
    running?: boolean
    completed?: boolean
    pending?: 'approval' | 'plan-review' | 'question'
    /** Running subagent descendants (vendor runningSubagentCount semantics); absent = 0. */
    runningSubagents?: number
  }>
}

type Listener = () => void
type OpenListener = (request: OpenSessionRequest) => void
type OpenOutcomeListener = (outcome: OpenSessionOutcome) => void
type RefreshListener = (sourceId: string) => void
/**
 * Per-source session-list refresh request (archive-cleanup convergence, design
 * 24 §20): a source's MOUNTED ctx session summaries are the official client's
 * in-memory rows, refreshed only on connection generations — content purged by
 * the chamber host domain never triggers an official event (documented no-op),
 * so the deleted rows linger in the summaries and resurface in the sidebar
 * once the host removes their ids from the archived set (no filter covers them
 * anymore; opening one fails with the official session/not-found). The mounted
 * ctx of that source must re-run its OFFICIAL session-list refresh
 * (`ctx.sessions.refresh()`), which reconciles the summaries against the
 * server corpus (a per-call disk walk) and drops the deleted rows. Subscribers
 * are the sidebar plugins of every mounted ctx; each plugin acts only when its
 * own chamberInstanceId matches the requested source. Fired by the App's
 * ghost-row convergence machine (planSessionListRefresh — every ready mounted
 * push whose removed-archived rows are still listed) and by the archive
 * manager after every purge settle — see design 24 §20 / App.tsx.
 */
type SessionListRefreshListener = (sourceId: string) => void
type SourceListener = (sourceId: string) => void
/** Page-wide active-view fact: the source whose shell is on screen, undefined until the App publishes. */
type ActiveSourceListener = (sourceId: string | undefined) => void
type RuntimeReportListener = (
  sourceId: string,
  report: InstanceRuntimeReport | undefined,
  sourceFingerprint: string | undefined,
) => void
type SnapshotReportListener = (
  sourceId: string,
  snapshot: InstanceSnapshot | undefined,
  sourceFingerprint: string | undefined,
) => void
type PluginDiagnosticListener = (sourceId: string, diagnostic: PluginGraphDiagnostic | undefined) => void

const listeners = new Set<Listener>()
const openListeners = new Set<OpenListener>()
const openOutcomeListeners = new Set<OpenOutcomeListener>()
const refreshListeners = new Set<RefreshListener>()
const sessionListRefreshListeners = new Set<SessionListRefreshListener>()
const activateSourceListeners = new Set<SourceListener>()
const activeSourceListeners = new Set<ActiveSourceListener>()
const runtimeReportListeners = new Set<RuntimeReportListener>()
const snapshotReportListeners = new Set<SnapshotReportListener>()
const pluginDiagnosticListeners = new Set<PluginDiagnosticListener>()
let servers: ChamberServerAggregate[] = []
let activeSourceId: string | undefined
const runtimeReports: Record<string, InstanceRuntimeReport> = {}
const runtimeProducerTokens: Record<string, number> = {}
/** Boot generation of the ctx that currently owns each source's producers.
 *  Registration is order-gated by this (see registerInstanceRuntimeProducer):
 *  a hung earlier boot that resumes AFTER its successor registered must not
 *  steal the producer token — its teardown clear() would then silence the
 *  healthy successor for good (2026-12 review BLOCKER). */
const runtimeProducerGenerations: Record<string, number> = {}
const snapshotProducerGenerations: Record<string, number> = {}
const runtimeProducerFingerprints: Record<string, string> = {}
const instanceSnapshots: Record<string, InstanceSnapshot> = {}
const snapshotProducerTokens: Record<string, number> = {}
const snapshotProducerFingerprints: Record<string, string> = {}
const pluginDiagnostics: Record<string, PluginGraphDiagnostic> = {}
let nextRuntimeProducerToken = 0
let nextSnapshotProducerToken = 0

export const chamberBridge = {
  /** Latest published projection (non-authoritative; renderer-owned store). */
  getServers(): ChamberServerAggregate[] {
    return servers
  },

  /** Subscribe to projection refreshes; returns the unsubscribe. */
  subscribe(listener: Listener): () => void {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },

  /**
   * App-layer write: replace the projection and notify subscribers.
   *
   * 2026 性能核查（登记）：调用面已有多重收口，本层无需再做微任务单槽合并
   * ——App 发布前有 serversProjectionSignature 签名闸（等值不 publish），
   * 订阅侧（SidebarRoot）在 setState 前再比一次签名，refreshAggregate 等
   * 写路径 identity-preserving（同内容不换对象）。React 19 批处理已把同一
   * macrotask 内的多次 publish 合并为一次渲染，异步合并反而会引入
   * getServers() 读到中间态的竞态窗口。本入口只保留引用相等防御：publish
   * 语义是"换快照 + 通知"，同引用重发无任何增量（快照本身不可变）。
   * 不变式（2026 评审补注）：同引用重发布被静默丢弃——不可变快照下同引用
   * ≡ 无内容变化；若未来引入原地突变 + 同引用重发布（今日被不可变性禁止），
   * 此守卫会吞掉它——任何此类改动必须先改写本注释，而非绕过守卫。
   */
  publish(next: ChamberServerAggregate[]): void {
    if (next === servers) return
    servers = next
    for (const listener of [...listeners]) listener()
  },

  /** Ask the App layer to switch to the source shell and open the session. */
  requestOpenSession(sourceId: string, sessionId: string): void {
    for (const listener of [...openListeners]) listener({ sourceId, sessionId })
  },

  /** App-layer subscription to open-session requests; returns the unsubscribe. */
  onOpenSession(listener: OpenListener): () => void {
    openListeners.add(listener)
    return () => {
      openListeners.delete(listener)
    }
  },

  /** App-layer report that one requested open settled (failure carries the
   *  loud terminal message). Every sidebar shell receives the report and
   *  surfaces failures on the session row; success clears a stale failure. */
  reportOpenSessionOutcome(outcome: OpenSessionOutcome): void {
    for (const listener of [...openOutcomeListeners]) listener(outcome)
  },

  /** Sidebar subscription to open-outcome reports; returns the unsubscribe. */
  onOpenSessionOutcome(listener: OpenOutcomeListener): () => void {
    openOutcomeListeners.add(listener)
    return () => {
      openOutcomeListeners.delete(listener)
    }
  },

  /** Sidebar call after an action: unmounted/incomplete sources ask App for one pull; mounted stores push. */
  requestRefresh(sourceId: string): void {
    for (const listener of [...refreshListeners]) listener(sourceId)
  },

  /** App-layer subscription to refresh requests; returns the unsubscribe. */
  onRefresh(listener: RefreshListener): () => void {
    refreshListeners.add(listener)
    return () => {
      refreshListeners.delete(listener)
    }
  },

  /**
   * Ask the MOUNTED ctx of `sourceId` to refresh its official session list
   * (sidebar-plugin subscriber: only the plugin whose chamberInstanceId equals
   * `sourceId` acts). See the SessionListRefreshListener note — the convergence
   * net for rows of purged sessions lingering in the official client summaries.
   * Unmounted sources have no subscriber and need none (their rows ride the
   * unary list, which is authoritative per call).
   */
  requestSessionListRefresh(sourceId: string): void {
    for (const listener of [...sessionListRefreshListeners]) listener(sourceId)
  },

  /** Sidebar-plugin subscription to session-list refresh requests; returns the unsubscribe. */
  onRequestSessionListRefresh(listener: SessionListRefreshListener): () => void {
    sessionListRefreshListeners.add(listener)
    return () => {
      sessionListRefreshListeners.delete(listener)
    }
  },

  /** Sidebar call when the user clicks a source header: ask the App layer to switch the active view. */
  requestActivateSource(sourceId: string): void {
    for (const listener of [...activateSourceListeners]) listener(sourceId)
  },

  /** App-layer subscription to source-activation requests; returns the unsubscribe. */
  onActivateSource(listener: SourceListener): () => void {
    activateSourceListeners.add(listener)
    return () => {
      activateSourceListeners.delete(listener)
    }
  },

  /**
   * App-layer write: the source whose shell is currently on screen. This is
   * the authoritative active-view fact of the shared document — consumers that
   * must act for ONE view only (the ui-layout document theme projection, which
   * writes document-global `color-scheme`/palette state) gate on it instead of
   * guessing from DOM classes or mount order. Undefined means "not published":
   * consumers fail OPEN, so a boot without the App layer keeps its previous
   * unconditional behavior.
   */
  setActiveSource(sourceId: string | undefined): void {
    if (sourceId === activeSourceId) return
    activeSourceId = sourceId
    // Per-listener isolation (same discipline as the layout facts fan-out): a
    // throwing projector must not abort the publish for its siblings.
    for (const listener of [...activeSourceListeners]) {
      try {
        listener(activeSourceId)
      } catch (error) {
        console.error('[dsh-chamber] active-source subscriber threw:', error)
      }
    }
  },

  /** Page-wide active-view fact; undefined until the App publishes. */
  getActiveSource(): string | undefined {
    return activeSourceId
  },

  /** Subscribe to active-view changes (fires on change only); returns the unsubscribe. */
  onActiveSource(listener: ActiveSourceListener): () => void {
    activeSourceListeners.add(listener)
    return () => {
      activeSourceListeners.delete(listener)
    }
  },

  /**
   * Synchronously revoke every producer owned by one registry incarnation.
   * Shell disposal is async, so waiting for plugin cleanup leaves a window in
   * which the old ctx can report after the authoritative roster has already
   * re-added the same id. Delete both current tokens and caches now, then emit
   * explicit withdrawals. Old producer closures subsequently fail their
   * token checks even before a replacement producer registers.
   */
  retireInstanceProducers(sourceId: string): void {
    const runtimeFingerprint = runtimeProducerFingerprints[sourceId]
    const snapshotFingerprint = snapshotProducerFingerprints[sourceId]
    delete runtimeProducerTokens[sourceId]
    delete snapshotProducerTokens[sourceId]
    delete runtimeProducerGenerations[sourceId]
    delete snapshotProducerGenerations[sourceId]
    delete runtimeProducerFingerprints[sourceId]
    delete snapshotProducerFingerprints[sourceId]
    delete runtimeReports[sourceId]
    delete instanceSnapshots[sourceId]
    for (const listener of [...runtimeReportListeners]) listener(sourceId, undefined, runtimeFingerprint)
    for (const listener of [...snapshotReportListeners]) listener(sourceId, undefined, snapshotFingerprint)
  },

  /**
   * Register the runtime-facts producer owned by one mounted instance ctx.
   * Token gating makes async teardown generation-safe: an old ctx's late
   * clear/report can never erase or overwrite the replacement ctx's facts.
   */
  registerInstanceRuntimeProducer(
    sourceId: string,
    sourceFingerprint: string,
    bootGeneration?: number,
  ): {
    report: (report: InstanceRuntimeReport) => void
    clear: () => void
  } {
    // 代际栅栏：更老的 boot 迟到注册一律作废（返回惰性句柄）。两者都无代
    // （测试/非 chamber 挂载）时保持原"后注册者胜"的语义。
    const currentGeneration = runtimeProducerGenerations[sourceId]
    if (bootGeneration !== undefined && currentGeneration !== undefined && bootGeneration < currentGeneration) {
      return { report: () => undefined, clear: () => undefined }
    }
    if (bootGeneration !== undefined) runtimeProducerGenerations[sourceId] = bootGeneration
    const token = ++nextRuntimeProducerToken
    const previousFingerprint = runtimeProducerFingerprints[sourceId]
    runtimeProducerTokens[sourceId] = token
    runtimeProducerFingerprints[sourceId] = sourceFingerprint
    if (runtimeReports[sourceId] !== undefined) {
      delete runtimeReports[sourceId]
      for (const listener of [...runtimeReportListeners]) listener(sourceId, undefined, previousFingerprint)
    }
    return {
      report(report): void {
        if (runtimeProducerTokens[sourceId] !== token) return
        runtimeReports[sourceId] = report
        for (const listener of [...runtimeReportListeners]) listener(sourceId, report, sourceFingerprint)
      },
      clear(): void {
        if (runtimeProducerTokens[sourceId] !== token) return
        delete runtimeProducerTokens[sourceId]
        delete runtimeProducerFingerprints[sourceId]
        delete runtimeProducerGenerations[sourceId]
        if (runtimeReports[sourceId] === undefined) return
        delete runtimeReports[sourceId]
        for (const listener of [...runtimeReportListeners]) listener(sourceId, undefined, sourceFingerprint)
      },
    }
  },

  /** App-layer subscription to runtime-fact reports (report or clear); returns the unsubscribe. */
  onRuntimeReport(listener: RuntimeReportListener): () => void {
    runtimeReportListeners.add(listener)
    return () => {
      runtimeReportListeners.delete(listener)
    }
  },

  /**
   * Register the snapshot producer owned by one mounted instance ctx. The
   * token makes teardown generation-safe: a late cleanup from an old shell
   * cannot clear a newer shell's report for the same source.
   */
  registerInstanceSnapshotProducer(
    sourceId: string,
    sourceFingerprint: string,
    bootGeneration?: number,
  ): {
    report: (snapshot: InstanceSnapshot | undefined) => void
    clear: () => void
  } {
    // 同 runtime producer：代际栅栏，迟到的老 boot 不得夺走生产权。
    const currentGeneration = snapshotProducerGenerations[sourceId]
    if (bootGeneration !== undefined && currentGeneration !== undefined && bootGeneration < currentGeneration) {
      return { report: () => undefined, clear: () => undefined }
    }
    if (bootGeneration !== undefined) snapshotProducerGenerations[sourceId] = bootGeneration
    const token = ++nextSnapshotProducerToken
    const previousFingerprint = snapshotProducerFingerprints[sourceId]
    snapshotProducerTokens[sourceId] = token
    snapshotProducerFingerprints[sourceId] = sourceFingerprint
    if (instanceSnapshots[sourceId] !== undefined) {
      delete instanceSnapshots[sourceId]
      for (const listener of [...snapshotReportListeners]) listener(sourceId, undefined, previousFingerprint)
    }
    return {
      report(snapshot): void {
        if (snapshotProducerTokens[sourceId] !== token) return
        if (snapshot === undefined) {
          if (instanceSnapshots[sourceId] === undefined) return
          delete instanceSnapshots[sourceId]
        } else {
          instanceSnapshots[sourceId] = snapshot
        }
        for (const listener of [...snapshotReportListeners]) listener(sourceId, snapshot, sourceFingerprint)
      },
      clear(): void {
        if (snapshotProducerTokens[sourceId] !== token) return
        delete snapshotProducerTokens[sourceId]
        delete snapshotProducerFingerprints[sourceId]
        delete snapshotProducerGenerations[sourceId]
        if (instanceSnapshots[sourceId] === undefined) return
        delete instanceSnapshots[sourceId]
        for (const listener of [...snapshotReportListeners]) listener(sourceId, undefined, sourceFingerprint)
      },
    }
  },

  /** Current complete reports, used only as renderer-local attachment state. */
  getInstanceSnapshots(): Readonly<Record<string, InstanceSnapshot>> {
    return instanceSnapshots
  },

  /** Subscribe and synchronously replay all complete reports. */
  onInstanceSnapshot(listener: SnapshotReportListener): () => void {
    snapshotReportListeners.add(listener)
    for (const [sourceId, snapshot] of Object.entries(instanceSnapshots)) {
      listener(sourceId, snapshot, snapshotProducerFingerprints[sourceId])
    }
    return () => {
      snapshotReportListeners.delete(listener)
    }
  },

  reportPluginDiagnostic(sourceId: string, diagnostic: PluginGraphDiagnostic): void {
    pluginDiagnostics[sourceId] = diagnostic
    for (const listener of [...pluginDiagnosticListeners]) listener(sourceId, diagnostic)
  },

  clearPluginDiagnostic(sourceId: string): void {
    if (pluginDiagnostics[sourceId] === undefined) return
    delete pluginDiagnostics[sourceId]
    for (const listener of [...pluginDiagnosticListeners]) listener(sourceId, undefined)
  },

  getPluginDiagnostics(): Readonly<Record<string, PluginGraphDiagnostic>> {
    return pluginDiagnostics
  },

  onPluginDiagnostic(listener: PluginDiagnosticListener): () => void {
    pluginDiagnosticListeners.add(listener)
    for (const [sourceId, diagnostic] of Object.entries(pluginDiagnostics)) listener(sourceId, diagnostic)
    return () => {
      pluginDiagnosticListeners.delete(listener)
    }
  },
}
