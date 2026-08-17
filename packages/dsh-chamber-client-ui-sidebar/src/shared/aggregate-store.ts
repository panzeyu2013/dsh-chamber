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
  /** 'local' | 'ssh-<id>' */
  id: string
  kind: 'local' | 'ssh'
  label: string
  /** Local: dsh ready; remote: tunnel phase ready. */
  connected: boolean
  /** Status text (ready/connecting/… projection). */
  phase: string
  workspaces: ChamberServerWorkspace[]
  /** Snapshot-fetch error text from the last per-instance pull; absent = ok/not-connected. */
  aggregateError?: string
  /** Runtime facts from the source's own ctx (design 06 §4); attached, never polled. */
  runtime?: InstanceRuntimeReport
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

const listeners = new Set<Listener>()
const openListeners = new Set<OpenListener>()
const refreshListeners = new Set<RefreshListener>()
const activateSourceListeners = new Set<SourceListener>()
const runtimeReportListeners = new Set<RuntimeReportListener>()
let servers: ChamberServerAggregate[] = []
const runtimeReports: Record<string, InstanceRuntimeReport> = {}

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

  /** Sidebar call after a successful action: ask the App layer to re-pull the source snapshot. */
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
}
