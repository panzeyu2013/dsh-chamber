/**
 * Ambient typing for the dsh workspace packages the renderer bundles
 * (design 05 §2: workspace source compiled by vite via resolve aliases, see
 * vite.config.mjs). The vendor packages are excluded from the repository
 * typecheck (root tsconfig excludes vendor/), and their built type outputs do
 * not exist in the source-only vendor tree, so each specifier the renderer
 * imports is declared loosely here. The chamber-owned copies
 * (dsh-client-connection / dsh-client-web / dsh-chamber-client-ui-sidebar) are
 * typechecked by their own package projects; the renderer still consumes
 * their named types loosely here (cordis Context, AppWebEntry, chamber
 * bridge).
 */

declare module '@deepseek-ai/cordis' {
  /** Loose minimal shape, mirroring the cordis src/context.ts interface+class merge. */
  interface Context {
    plugin(...args: any[]): this
    inject(...args: any[]): this
    on(...args: any[]): this
    emit(...args: any[]): unknown
    get(...args: any[]): unknown
    provide(...args: any[]): unknown
    /** chamber v1: per-instance sessions runtime face (loose mirror of dsh-client-runtime ISessions). */
    sessions: {
      open(id: string): void
      list: { getSnapshot(): { byId?: Record<string, unknown> } }
    }
  }
  class Context {
    constructor()
    static is(value: unknown): value is Context
  }
}

declare module '@deepseek-ai/dsh-client-web' {
  /** Module transport hook (boot.ts BootSeams, Pick<ClientModuleCreateOptions, 'loadBundle'>). */
  export interface BootSeams {
    loadBundle?: (url: string) => Promise<void>
  }
  /**
   * chamber patch (05 §3.6 / design 09): mirror of boot.ts AppWebEntryOptions —
   * per-instance extra host-graph client-plugin rows (bundles pre-loaded by
   * the chamber shell; ids only merged into the boot rows here).
   */
  export interface AppWebEntryOptions extends BootSeams {
    extraRows?: { id: string; url: string; rev: string }[]
  }
  /**
   * chamber patch (2026-08 first-boot race fix, 05 §4): install-or-reuse the
   * page-level module system (window.__DSH_MODULES__ + the __ModuleLoader__
   * registration sink). shell.ts calls this BEFORE preloading any host-graph
   * bundle so the extra bundles' scripts always evaluate against an installed
   * sink; idempotent, run() adopts the same instance.
   */
  export function ensureWebModuleSystem(seams?: BootSeams): unknown
  /** The web shell kernel consumed by shell.ts (boot.ts). */
  export class AppWebEntry {
    constructor(el: HTMLElement, options?: AppWebEntryOptions)
    run(): Promise<unknown>
    dispose(): void
    /** chamber patch: settled runtime context (boot.ts accessor; session opens ride ctx.sessions; undefined after dispose). */
    runtimeCtx: Context | undefined
    /** chamber patch (2026-08, 05 §4 失败呈现修订): boot failure report — run() resolves on boot-chain failures by design (the dsh loading page renders the in-shell report), but the chamber shell must see it to present its own per-instance fallback; undefined while loading or after a clean settle. */
    bootError: string | undefined
  }
}

declare module '@deepseek-ai/dsh-client-connection/client'
declare module '@deepseek-ai/dsh-client-runtime/client'
declare module '@deepseek-ai/dsh-client-locale/client'
declare module '@deepseek-ai/dsh-client-modules/client'
declare module '@deepseek-ai/dsh-typert-registry/client'
declare module '@deepseek-ai/dsh-api-gateway/client'
declare module '@deepseek-ai/dsh-api-remotes/client'

declare module '@deepseek-ai/dsh-client-ui-agent-preset/client'
// rc.8 deferred-family client entries (design 09 §4; chamber-entry.ts
// registerDeferred dynamic imports): attachment (composer + message-image
// slot fills), brand-official (official brand occupants — gated on the
// 'official' build profile, a no-op in the chamber build), reference (the
// unified `@` input-trigger source).
declare module '@deepseek-ai/dsh-client-ui-attachment/client'
declare module '@deepseek-ai/dsh-client-ui-brand-official/client'
declare module '@deepseek-ai/dsh-client-ui-commands/client'
declare module '@deepseek-ai/dsh-client-ui-conversation/client'
declare module '@deepseek-ai/dsh-client-ui-deliverables/client'
declare module '@deepseek-ai/dsh-client-ui-directory-picker-browse/client'
declare module '@deepseek-ai/dsh-client-ui-goal/client'
declare module '@deepseek-ai/dsh-client-ui-input-trigger/client'
declare module '@deepseek-ai/dsh-client-ui-jobs/client'
declare module '@deepseek-ai/dsh-client-ui-layout/client'
declare module '@deepseek-ai/dsh-client-ui-message-feedback/client'
declare module '@deepseek-ai/dsh-client-ui-model-selection/client'
declare module '@deepseek-ai/dsh-client-ui-permission-presets/client'
declare module '@deepseek-ai/dsh-client-ui-plan/client'
// rc.8 page-own (design 09 §4): ui-renderer is adopted by the shell kernel
// (the boot mounts through its ctx.uiRenderer) — chamber-entry never imports
// it; declared for the ambient surface only.
declare module '@deepseek-ai/dsh-client-ui-reference/client'
declare module '@deepseek-ai/dsh-client-ui-renderer/client'
declare module '@deepseek-ai/dsh-client-ui-settings/client'
declare module '@deepseek-ai/dsh-client-ui-settings-general/client'
declare module '@deepseek-ai/dsh-client-ui-settings-models/client'
declare module '@deepseek-ai/dsh-client-ui-settings-plugin-inventory/client'
declare module '@deepseek-ai/dsh-client-ui-settings-plugins/client'
declare module '@deepseek-ai/dsh-client-ui-sidebar/client'
declare module '@deepseek-ai/dsh-client-ui-skill/client'
declare module '@deepseek-ai/dsh-client-ui-subagent/client'
declare module '@deepseek-ai/dsh-client-ui-theme/client'
declare module '@deepseek-ai/dsh-client-ui-tool/client'
declare module '@deepseek-ai/dsh-client-ui-trajectory/client'
declare module '@deepseek-ai/dsh-client-ui-user-questions/client'
declare module '@deepseek-ai/dsh-client-ui-workflow-run/client'
declare module '@deepseek-ai/dsh-client-ui-workspace/client'

/**
 * The chamber self-built sidebar plugin (packages/dsh-chamber-client-ui-sidebar, 05
 * §2): registers the layout 'sidebar' slot shell whose region renders the
 * multi-source session list. The renderer only plugs it into the per-instance
 * boot graph; loose face.
 */
declare module '@dsh-chamber/dsh-client-ui-sidebar/client' {
  export const inject: string[]
  export function apply(ctx: any): void
}

/** Chamber Git worktree sidebar occupant (design 08). */
declare module '@dsh-chamber/dsh-client-ui-git/client' {
  export const inject: string[]
  export function apply(ctx: any): void
}

/** Chamber open-in header button (design 16 + open-in extension). */
declare module '@dsh-chamber/dsh-client-ui-open-in/client' {
  export const inject: string[]
  export function apply(ctx: any): void
}

/**
 * The chamber-owned ui-layout fork (packages/dsh-chamber-client-ui-layout,
 * design 06): replaces the official layout's 'root' registration so the
 * sidebar width preference is shared across every shell boot and persisted.
 * The renderer only plugs it into the per-instance boot graph; loose face.
 */
declare module '@dsh-chamber/dsh-client-ui-layout/client' {
  export const inject: string[]
  export function apply(ctx: any): void
}

/**
 * The chamber self-built connections settings section plugin
 * (packages/dsh-chamber-client-ui-settings-connections, 05 §5): registers the
 * 'settings.section' entry id 'connections' — local instance card + remote
 * host management. The renderer only plugs it into the per-instance boot
 * graph; loose face.
 */
declare module '@dsh-chamber/dsh-client-ui-settings-connections/client' {
  export const inject: string[]
  export function apply(ctx: any): void
}

/**
 * The chamber self-built settings shell plugin
 * (packages/dsh-chamber-client-ui-settings-bridge): registers the 'sidebar.settings'
 * entry id 'chamber-shell' at priority -1, shadowing the official
 * SettingsRoot — a server dropdown over the selected instance's official
 * settings sections, plus the fixed chamber-global connections entry. The
 * renderer only plugs it into the per-instance boot graph; loose face.
 */
declare module '@dsh-chamber/dsh-client-ui-settings-bridge/client' {
  export const inject: string[]
  export function apply(ctx: any): void
}

/**
 * The chamber shared faces (packages/dsh-chamber-client-ui-sidebar/src/shared, 05
 * §2/§3): the per-instance unary wire client (migrated from the former
 * renderer src/instance-api.ts) and the chamberBridge singleton. Loose mirror
 * of the real exports; the chamber App layer (App.tsx) and the sidebar plugin
 * consume this single copy.
 */
declare module '@dsh-chamber/dsh-client-ui-sidebar/shared' {
  export interface WorkspaceRow {
    workspaceId: string
    path: string
    title: string
    sessionIds: string[]
    createdAt: string
    updatedAt: string
  }
  export interface SessionRow {
    sessionId: string
    /** Optional: the wire omits it when absent (never coerced to 0, which would render "54y ago"). */
    updatedAt?: number
    running: boolean
    blank: boolean
    origin?: 'subagent'
    cwd?: string
    title?: string
    parentSessionId?: string
  }
  export interface InstanceSnapshot {
    workspaces: WorkspaceRow[]
    sessions: SessionRow[]
    archivedSessionIds: string[]
  }
  export type InstanceAggregateState = 'ok' | 'error' | 'not-connected'
  export interface InstanceAggregate extends InstanceSnapshot {
    state: InstanceAggregateState
    error: string | null
  }
  export function emptyAggregate(state: InstanceAggregateState, error?: string | null): InstanceAggregate
  export function getInstanceClient(instanceId: string): unknown
  export function releaseInstanceClient(instanceId: string): void
  export function fetchInstanceSnapshot(client: unknown): Promise<InstanceSnapshot>
  export function isInstanceUnavailable(err: unknown): boolean
  export class InstanceRpcError extends Error {
    readonly code: string
    readonly details: unknown
  }
  export function createSession(client: unknown, workspaceId: string, sessionId?: string): Promise<string>
  export function renameSession(client: unknown, sessionId: string, title: string): Promise<void>
  export function archiveSession(client: unknown, sessionId: string): Promise<void>
  export interface CreateWorkspaceResult {
    workspaceId: string
    path: string
    created: boolean
  }
  export function createWorkspace(client: unknown, path: string): Promise<CreateWorkspaceResult>
  export function renameWorkspace(client: unknown, workspaceId: string, title: string): Promise<void>
  export function deleteWorkspace(client: unknown, workspaceId: string): Promise<void>
  export interface SearchRow {
    sessionId: string
    snippet: string
  }
  export function searchSessions(
    client: unknown,
    query: string,
    signal: AbortSignal,
  ): Promise<{ items: SearchRow[]; hasMore: boolean }>
  export function insertSessionBefore(
    client: unknown,
    workspaceId: string,
    sessionId: string,
    beforeSessionId?: string,
  ): Promise<void>
  export function insertWorkspaceBefore(
    client: unknown,
    workspaceId: string,
    beforeWorkspaceId?: string,
  ): Promise<void>
  export interface ChamberServerWorkspace {
    id: string
    title: string
    ungrouped?: boolean
    sessions: { id: string; title: string; running?: boolean; updatedAt?: number; blank?: boolean }[]
  }
  export interface InstanceRuntimeReport {
    current?: string
    sessions: Record<string, {
      running?: boolean
      completed?: boolean
      pending?: 'approval' | 'plan-review' | 'question'
      runningSubagents?: number
    }>
  }
  export interface InstanceHostReport {
    dshVersion?: string
  }
  export type PluginGraphDiagnosticState = 'ok' | 'not-injected' | 'graph-unreachable' | 'bundle-load-failed' | 'restart-required'
  export interface PluginGraphDiagnostic {
    state: PluginGraphDiagnosticState
    message?: string
    pluginId?: string
    updatedAt: number
  }
  export interface ChamberServerAggregate {
    id: string
    kind: 'local' | 'dsh' | 'gateway'
    transport: 'local' | 'ssh' | 'http'
    rawId?: string
    label: string
    connected: boolean
    phase: string
    workspaces: ChamberServerWorkspace[]
    aggregateReady?: boolean
    aggregateError?: string
    runtime?: InstanceRuntimeReport
    dshVersion?: string
    pluginDiagnostic?: PluginGraphDiagnostic
    updatedAt: number
  }
  export interface OpenSessionRequest {
    sourceId: string
    sessionId: string
  }
  export const UNGROUPED_WORKSPACE_ID: string
  export function deriveServerWorkspaces(
    snapshot: InstanceSnapshot,
    serverId: string,
    ungroupedTitle: string,
    currentSessionId?: string,
  ): ChamberServerWorkspace[]
  export function sanitizeSearchQuery(query: string): string
  export function reconciledSessionOrder(stored: readonly string[], wireIds: readonly string[]): string[]
  export function projectRuntimeFacts(
    snapshot: {
      current?: string
      byId?: Record<string, {
        running?: boolean
        completed?: boolean
        pendingInteraction?: 'approval' | 'plan-review' | 'question'
      }>
    },
    subagentRunning?: ReadonlyMap<string, number>,
  ): InstanceRuntimeReport
  export function reconcileCompletedFacts(params: {
    sessions: Record<string, { running?: boolean }>
    nextRunning: Record<string, boolean>
    prevRunning: Record<string, boolean>
    prevCompleted: Record<string, boolean>
    readingCurrent: string | undefined
  }): { completed: Record<string, boolean>; changed: boolean }
  export function mergeRuntimeFacts(
    runtime: InstanceRuntimeReport | undefined,
    completedBySource: Record<string, boolean> | undefined,
  ): InstanceRuntimeReport | undefined
  export function instanceSnapshotSignature(
    snapshot: Pick<InstanceSnapshot, 'workspaces' | 'sessions' | 'archivedSessionIds'>,
  ): string
  export function runtimeReportSignature(
    report: InstanceRuntimeReport | undefined,
    onlyIds?: ReadonlySet<string>,
  ): string
  export function serversProjectionSignature(servers: readonly ChamberServerAggregate[]): string
  export const SEARCH_QUERY_MAX_CODE_UNITS: number
  export interface RelativeTimeBucket {
    unit: 'now' | 'minutes' | 'hours' | 'days' | 'months' | 'years'
    n: number
  }
  export function relativeTimeBucket(updatedAt: number, now: number): RelativeTimeBucket
  export interface DirectoryEntryRow {
    name: string
    path: string
    hidden: boolean
  }
  export interface DirectoryListingRow {
    path: string
    home: string
    crumbs: DirectoryEntryRow[]
    entries: DirectoryEntryRow[]
    truncated: boolean
  }
  export function listHostDirectory(
    client: unknown,
    path: string | undefined,
    signal?: AbortSignal,
  ): Promise<DirectoryListingRow>
  export function createHostDirectory(client: unknown, path: string, name: string): Promise<string>
  export function __resetViewPrefsForTests(): void
  export interface ChamberSidebarViewPrefs {
    v: 1
    folded: Record<string, boolean>
    ungroupedOrder: Record<string, string[]>
    seenSources: string[]
    /** Page-wide sidebar width preference in px (design 06 ui-layout fork); absent = never dragged. */
    sidebarWidth?: number
  }
  export interface StorageLike {
    getItem(key: string): string | null
    setItem(key: string, value: string): void
  }
  export const VIEW_PREFS_KEY: string
  export function loadViewPrefs(storage?: StorageLike): ChamberSidebarViewPrefs
  export function saveViewPrefs(prefs: ChamberSidebarViewPrefs, storage?: StorageLike): void
  export function getViewPrefs(): ChamberSidebarViewPrefs
  export function subscribeViewPrefs(listener: () => void): () => void
  export function updateViewPrefs(mutator: (prev: ChamberSidebarViewPrefs) => ChamberSidebarViewPrefs): void
  export interface SourceSearchState {
    expanded: boolean
    query: string
    status: 'idle' | 'loading' | 'ready' | 'error'
    items: { sessionId: string; snippet: string }[]
    hasMore: boolean
  }
  export function getSearchStates(): ReadonlyMap<string, SourceSearchState>
  export function subscribeSearch(listener: () => void): () => void
  export function expandSearch(sourceId: string): void
  export function collapseSearch(sourceId: string): void
  export function setSearchQuery(sourceId: string, query: string): void
  export function clearSearch(sourceId: string): void
  export type SearchFetcher = (
    sourceId: string,
    query: string,
    signal: AbortSignal,
  ) => Promise<{ items: { sessionId: string; snippet: string }[]; hasMore: boolean }>
  export function setSearchFetcher(fetcher: SearchFetcher): void
  export const chamberBridge: {
    getServers(): ChamberServerAggregate[]
    subscribe(listener: () => void): () => void
    publish(servers: ChamberServerAggregate[]): void
    requestOpenSession(sourceId: string, sessionId: string): void
    onOpenSession(listener: (request: OpenSessionRequest) => void): () => void
    requestRefresh(sourceId: string): void
    onRefresh(listener: (sourceId: string) => void): () => void
    requestActivateSource(sourceId: string): void
    onActivateSource(listener: (sourceId: string) => void): () => void
    reportInstanceRuntime(sourceId: string, report: InstanceRuntimeReport): void
    clearInstanceRuntime(sourceId: string): void
    onRuntimeReport(listener: (sourceId: string, report: InstanceRuntimeReport | undefined) => void): () => void
    registerInstanceHostProducer(sourceId: string): {
      report(report: InstanceHostReport | undefined): void
      clear(): void
    }
    onInstanceHost(listener: (sourceId: string, report: InstanceHostReport | undefined) => void): () => void
    onInstanceSnapshot(listener: (sourceId: string, snapshot: InstanceSnapshot | undefined) => void): () => void
    reportPluginDiagnostic(sourceId: string, diagnostic: PluginGraphDiagnostic): void
    clearPluginDiagnostic(sourceId: string): void
    getPluginDiagnostics(): Readonly<Record<string, PluginGraphDiagnostic>>
    onPluginDiagnostic(listener: (sourceId: string, diagnostic: PluginGraphDiagnostic | undefined) => void): () => void
  }
}

/** window.__DSH_BASE_PATH__ (chamber per-instance knob; see shell.ts). */
declare global {
  interface Window {
    __DSH_BASE_PATH__?: string
  }
}
