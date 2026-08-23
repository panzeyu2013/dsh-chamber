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
import { assertSingletonModule } from './singleton.ts'

assertSingletonModule('aggregate-store')
export interface ChamberServerWorkspace {
  id: string
  title: string
  /** True only for the synthetic trailing ungrouped bucket. */
  ungrouped?: boolean
  sessions: { id: string; title: string; running?: boolean; updatedAt?: number; blank?: boolean }[]
}

export interface ChamberServerAggregate {
  /** 'local' | '<transport-kind>-<id>' */
  id: string
  kind: 'local' | 'ssh' | 'gateway'
  label: string
  /** Local: dsh ready; remote: tunnel phase ready. */
  connected: boolean
  /** Status text (ready/connecting/… projection). */
  phase: string
  workspaces: ChamberServerWorkspace[]
  /** True when the per-instance aggregate snapshot has actually landed
   *  (workspace.list + sessions.list) — git-derived rows must not render
   *  before the workspace list itself (2026-08 user report). Absent on
   *  older producers = not ready. */
  aggregateReady?: boolean
  /** Snapshot-fetch error text from the last per-instance pull; absent = ok/not-connected. */
  aggregateError?: string
  /** Runtime facts from the source's own ctx (design 06 §4); attached, never polled. */
  runtime?: InstanceRuntimeReport
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
type RefreshListener = (sourceId: string) => void
type SourceListener = (sourceId: string) => void
type RuntimeReportListener = (sourceId: string, report: InstanceRuntimeReport | undefined) => void
type SnapshotReportListener = (sourceId: string, snapshot: InstanceSnapshot | undefined) => void
type PluginDiagnosticListener = (sourceId: string, diagnostic: PluginGraphDiagnostic | undefined) => void

const listeners = new Set<Listener>()
const openListeners = new Set<OpenListener>()
const refreshListeners = new Set<RefreshListener>()
const activateSourceListeners = new Set<SourceListener>()
const runtimeReportListeners = new Set<RuntimeReportListener>()
const snapshotReportListeners = new Set<SnapshotReportListener>()
const pluginDiagnosticListeners = new Set<PluginDiagnosticListener>()
let servers: ChamberServerAggregate[] = []
const runtimeReports: Record<string, InstanceRuntimeReport> = {}
const instanceSnapshots: Record<string, InstanceSnapshot> = {}
const snapshotProducerTokens: Record<string, number> = {}
const pluginDiagnostics: Record<string, PluginGraphDiagnostic> = {}
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

  /** App-layer write: replace the projection and notify subscribers. */
  publish(next: ChamberServerAggregate[]): void {
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

  /** Per-ctx sidebar plugin write: publish the source's runtime facts (design 06 §4.2). */
  reportInstanceRuntime(sourceId: string, report: InstanceRuntimeReport): void {
    runtimeReports[sourceId] = report
    for (const listener of [...runtimeReportListeners]) listener(sourceId, report)
  },

  /** Per-ctx sidebar plugin write: drop the source's runtime facts (effect teardown). */
  clearInstanceRuntime(sourceId: string): void {
    if (runtimeReports[sourceId] === undefined) return
    delete runtimeReports[sourceId]
    for (const listener of [...runtimeReportListeners]) listener(sourceId, undefined)
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
  registerInstanceSnapshotProducer(sourceId: string): {
    report: (snapshot: InstanceSnapshot | undefined) => void
    clear: () => void
  } {
    const token = ++nextSnapshotProducerToken
    snapshotProducerTokens[sourceId] = token
    if (instanceSnapshots[sourceId] !== undefined) {
      delete instanceSnapshots[sourceId]
      for (const listener of [...snapshotReportListeners]) listener(sourceId, undefined)
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
        for (const listener of [...snapshotReportListeners]) listener(sourceId, snapshot)
      },
      clear(): void {
        if (snapshotProducerTokens[sourceId] !== token) return
        delete snapshotProducerTokens[sourceId]
        if (instanceSnapshots[sourceId] === undefined) return
        delete instanceSnapshots[sourceId]
        for (const listener of [...snapshotReportListeners]) listener(sourceId, undefined)
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
    for (const [sourceId, snapshot] of Object.entries(instanceSnapshots)) listener(sourceId, snapshot)
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
