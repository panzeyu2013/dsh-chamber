/**
 * chamberBridge — the renderer-shared single instance: the App layer publishes
 * the merged multi-source projection and consumes open-session requests; the
 * sidebar plugin subscribes and publishes open requests. Both import this module
 * through `@dsh-chamber/dsh-chamber-client-core` (vite shared chunk keeps the
 * runtime single instance).
 * One workspace group in the sidebar projection (computed by derive.ts); the
 * synthetic trailing ungrouped bucket carries `ungrouped: true` and the shared
 * UNGROUPED_WORKSPACE_ID.
 */
import type { InstanceSnapshot } from './instance-api.ts'
import type { ArchivedSessionMetaRow } from './aggregate-types.ts'
import type { SubagentActivity } from './session-row-state.ts'
import type { SessionAuthoritySnapshot } from './session-fact-reconcile.ts'
import { assertSingletonModule } from './singleton.ts'
import {
  publishSessionCreationInstrument, sessionCreationLedger, type SessionCreationOrigin,
} from './session-create-ledger.ts'

assertSingletonModule('aggregate-store')

/**
 * 事实未到（投影缺席）——**绝不折叠为 'idle'**：'idle' 是"手动断开"的合法事实，
 * 折叠会把一次投影延迟/拉取失败说成"未连接"。'unknown' 读作「状态未知」，
 * transportUsable 对二者同为 false。
 */
export const SOURCE_PHASE_UNKNOWN = 'unknown'

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
   * True only for the fallback's cwd-derived groups (`__cwd__:` ids): the host
   * does not know these ids, so the sidebar must disable every workspace-scoped
   * mutation on them.
   */
  synthetic?: boolean
  sessions: {
    id: string
    /** Durable title projection — '' when the session has none. Rename/fork copy uses THIS. */
    title: string
    /**
     * Official display label (`title ?? basename(cwd) ?? id`, never empty) —
     * what row labels, hover copy, aria names and todo rows render.
     */
    displayTitle: string
    running?: boolean
    updatedAt?: number
    blank?: boolean
    /**
     * The session owns at least one active schedule (from the session's
     * `schedule` projection), so the row can render the official marker.
     * Sparse: absent means no active schedule.
     */
    hasActiveSchedule?: boolean
  }[]
  /**
   * Official reuse-or-create resolution for this workspace's "+", computed over
   * the RAW snapshot: a blank, non-archived member session in the workspace's own
   * directory that upstream would reopen. Absent = create (no such row, or the
   * archive set is unknown, where create is the honest degradation).
   */
  reusableBlankSessionId?: string
}

/** 会话事实档位（判定与展示分离：判定只用事实本身）。 */
export type SourceSessionFactsMode = 'full' | 'degraded' | 'legacy' | 'disabled'

export interface ChamberServerAggregate {
  /** 'local' | '<target-kind>-<id>' (`ssh-<id>` remains a legacy dsh id). */
  id: string
  /** Opaque authoritative lifecycle proof for this exact source incarnation. */
  sourceFingerprint: string
  /** Target semantics, independent from the transport mechanism. */
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
   * Gateway only: the managed dsh is terminal-down (`stopped`/`error`/
   * `restart-exhausted`) while the TRANSPORT is up. A dedicated fact, never
   * re-derived from `phase` (both vocabularies contain `error`, so classifying
   * the merged string would misdiagnose a tunnel failure as a stopped managed
   * dsh). Absent = not a gateway / transport down / healthy state (fail open).
   */
  managedRuntimeDown?: boolean
  /**
   * 能力一览：本来源的会话事实档位，只读展示，绝不参与判定。`full` = 镜像可用且
   * 兼容；`degraded` = 镜像受限（尾巴不可读 / 事件静默 / 轮询模式 / 特性缺失）；
   * `legacy` = 该网关未升级（路由 404）；`disabled` = 观察面关闭（503 或
   * `mode:'off'`）。缺席 = 未知，绝不臆造为 full。
   */
  sessionFacts?: SourceSessionFactsMode
  workspaces: ChamberServerWorkspace[]
  /** True when the per-instance aggregate has actually landed (workspace groups
   *  derive from session cwd facts since workspace.list was deleted upstream);
   *  git-derived rows must not render before it. Absent = not ready. */
  aggregateReady?: boolean
  /** Snapshot-fetch error text from the last per-instance pull; absent = ok/not-connected. */
  aggregateError?: string
  /** Runtime facts from the source's own ctx; attached, never polled. */
  runtime?: InstanceRuntimeReport
  /**
   * Archived-session metadata rows of this source, with workspace attribution
   * for the manager's grouped listing. `archiveSetKnown` says whether an EMPTY
   * list is a true "nothing archived" fact: true = the mounted workspace
   * baseline projected the registry archive set; absent = the snapshot has not
   * landed or carries no archive-set metadata; false = the unary fallback's
   * unknown set — [] must NEVER be read as "no archived sessions" (the manager
   * shows a degraded branch with no destructive action).
   */
  archivedSessions?: ArchivedSessionMetaRow[]
  archiveSetKnown?: boolean
  /**
   * dsh version fact: the LOCAL instance's version flows from the desktop
   * bridge; remote instances stay unknown until control-plane `dsh --version`
   * facts are projected through the chamber bridge.
   */
  dshVersion?: string
  /** Renderer-local client-plugin boot health for this source. */
  pluginDiagnostic?: PluginGraphDiagnostic
  /**
   * Settled-boot GAP of this source's mounted shell: the shell settled
   * successfully while a whole surface is missing.
   *
   * SEPARATE from {@link pluginDiagnostic} on purpose: that channel describes the
   * host boot-GRAPH (`ok` means the graph was fetched and every arriving row
   * applied), while a missing `ui-chat`/`sidebarRight` leaves it at `ok` though
   * the conversation view never registers — overloading one channel would either
   * lie ("正常" next to an empty conversation) or blur the recheck classification.
   * Structured facts only (each package renders its own sentence from `kind` +
   * ids). Absent = no gap reported.
   */
  bootGap?: ServerBootGap
  updatedAt: number
}

/** Why a mounted shell is known to be incomplete (see {@link ChamberServerAggregate.bootGap}). */
export type ServerBootGapKind =
  | 'graph-unavailable'
  /**
   * The LOCAL instance's client-graph endpoint answered 404 / method-missing:
   * a chamber-side installation/seed fact (the managed local host always injects
   * its graph). Gateway/mobile shapes keep producing NO fact.
   */
  | 'local-graph-not-injected'
  | 'required-services-missing'
  | 'deferred-registration-failed'

/**
 * The cross-package face of one settled-boot gap. Producers hand these fields
 * over; consumers render their own sentences.
 */
export interface ServerBootGap {
  kind: ServerBootGapKind
  /** `required-services-missing`: the unprovided composite services, roster order. */
  services?: readonly string[]
  injectedBy?: readonly string[]
  failedIds?: readonly string[]
}

export type PluginGraphDiagnosticState =
  | 'ok'
  | 'not-injected'
  | 'graph-unreachable'
  | 'bundle-load-failed'
  | 'restart-required'
  /** Cross-instance dsh runtime version drift: the same plugin id was first
   *  claimed on this page by a DIFFERENT instance at another rev — no app
   *  restart can switch it, the instances' runtime versions must be aligned. */
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
 * sidebar shell (the request channel is one-way; the App owns dispatch and
 * failure, the sidebar owns the row). Failure carries the loud report.
 */
export interface OpenSessionOutcome extends OpenSessionRequest {
  /** Present only on failure: the terminal error report (App-wrapped text). */
  message?: string
}

/**
 * One successful in-app workspace creation for a source whose shell may not be
 * mounted. The unary `workspace.create` result is the ONLY trustworthy "this
 * workspace now exists on that host" fact available without a shell: the App
 * echoes the row into the projection immediately while the authoritative
 * `workspace/follow` baseline converges later (for an unmounted source the
 * unary fallback cannot express an empty workspace at all).
 *
 * Every in-app producer goes through shared/workspace-mutations.ts (the single
 * funnel: the sidebar's dialogs AND the Git plugin's create/adopt sagas).
 */
export interface WorkspaceCreatedFact {
  sourceId: string
  workspaceId: string
  path: string
  /**
   * Optional placement anchor: the host workspace id this creation sits
   * immediately AFTER in the projection (the Git plugin registers a new worktree
   * right below its main checkout, while the echo would otherwise be appended
   * and jump once the source mounts). Absent = append at the tail.
   */
  afterWorkspaceId?: string
  /**
   * Optional label this creation INTENDS for the row (the Git plugin's adopt
   * renames to the branch right after the saga). Absent = the ledger's
   * path-basename rule; the mounted baseline still wins over both.
   */
  title?: string
}

/**
 * One successful sidebar-issued workspace deletion — the WITHDRAW half of the
 * workspace echo. Without it the echo has no way to retire: on a source whose
 * shell is not mounted no authoritative baseline lists the workspace yet, so
 * reconciliation cannot match it and the deleted row survives as a GHOST with
 * real-id actions until the TTL. `path` is best-effort; the ledger also matches
 * by `workspaceId`.
 */
export interface WorkspaceRemovedFact {
  sourceId: string
  workspaceId: string
  path: string
}

/**
 * One successful sidebar-issued workspace rename — the PATCH half of the echo.
 * An echo row's title is `basenameOf(path)`, so without this fact a rename
 * against a not-yet-mounted source looks like a no-op until the mount push.
 */
export interface WorkspaceRenamedFact {
  sourceId: string
  workspaceId: string
  title: string
}

/**
 * One successful in-app session creation — the session-side sibling of
 * {@link WorkspaceCreatedFact}, published by the single funnel
 * `shared/session-mutations.ts` (sidebar "+", row menu fork, Git plugin
 * creations).
 *
 * A session minted over the source's UNARY client reaches neither producer of
 * that source's projection in time: the mounted push carries the official
 * summary store whose only out-of-band update is the ASYNCHRONOUS
 * `api-session/added` broadcast, and an unmounted source never receives it; the
 * 30s fallback's merge keeps a pushed source's membership frozen, so the id
 * could only appear as an unaccounted stray. The App records the host id in its
 * session-echo ledger, projects the row immediately, and converges on the
 * authoritative view (the session-list refresh it triggers, or the next mount).
 */
export interface SessionCreatedFact {
  sourceId: string
  /** HOST session id — the only trustworthy "this session now exists" proof. */
  sessionId: string
  /** Host workspace id the session was created under; absent for a fork (the
   *  child's workspace resolves from {@link parentSessionId}). */
  workspaceId?: string
  /** Parent session id (fork), for the App's membership resolution. */
  parentSessionId?: string
  /** Display-title hint (fork intent); absent = the official id ladder. */
  title?: string
  /**
   * Official provisional-row fact: true for `session.create` (blank until the
   * first turn, so navigation surfaces it only while it is the source's CURRENT
   * session), false for a fork child, which inherits content.
   */
  blank: boolean
  /** 归因：触发路径标签；缺席 = unknown（仪表覆盖缺口）。 */
  origin?: SessionCreationOrigin
}

/**
 * One successful sidebar-issued session ARCHIVE: the WITHDRAW half of the
 * creation echo (create → archive inside the echo window must not leave a
 * phantom row until the TTL) and the trigger of the local ARCHIVE TOMBSTONE.
 * For an unmounted source no channel carries the new archive set (the mounted
 * merge keeps the frozen pushed set, the unary fallback has no archive wire),
 * so the row would stay listed and open into the official empty view.
 */
export interface SessionRemovedFact {
  sourceId: string
  sessionId: string
}

/**
 * Per-instance runtime facts projected by the sidebar plugin of the source's
 * own ctx: current session id plus per-session live rows. Every listed session
 * carries its live `running` bit (the App derives the completed-but-unread dot
 * from running→idle edges itself), completed/pending ride the vendor armed state
 * as sparse extras, and `runningSubagents` carries the vendor lineage index's
 * RUNNING descendant count per parent (a parent whose round ended while
 * background subagents work must show the subagent-live ring, not the completed
 * dot). Attached as a separate channel — never polled by the App.
 */
export interface InstanceRuntimeReport {
  current?: string
  /**
   * Every listed session (edge memory for the App's completed-dot derivation).
   * completed/pending appear only when the vendor runtime armed them;
   * runningSubagents only when non-zero.
   */
  sessions: Record<string, {
    running?: boolean
    completed?: boolean
    pending?: 'approval' | 'plan-review' | 'question'
    /** Running subagent descendants (vendor runningSubagentCount semantics); absent = 0. */
    runningSubagents?: number
    /** 子代理活动三值：none（索引在场且为零）| running | unknown（索引缺席或来源 stale）。 */
    subagentActivity?: SubagentActivity
    /** 观察者刷新这一行事实的 host 域毫秒（0/缺席 = 无观察者事实）。 */
    factAt?: number
  }>
  /**
   * 会话事实单一权威（P2）的快照；
   * 缺席 = 本记录内从未请求过。App 的升级 ladder 只读它的事实（runningSince /
   * stuckSince / progressStamp）决定 reconnect 与 notice——策略不在 App 侧。
   * 执行端是 shared/session-fact-reconcile.ts（reducer + probe ladder + I/O）。
   */
  sessionAuthority?: SessionAuthoritySnapshot
  /**
   * Whether `sessions` came from a COMPLETE session-list baseline: the mounted
   * producer projects the official list store's arrival phase (ready only after
   * the first successful list, never rolled back). Only `true` is an
   * authoritative "a session absent here is GONE" gate for the App's unread
   * pruning; absent means "not proven complete" and must retain state. A
   * JUDGMENT input, not a rendered fact (the sidebar projection does not carry
   * it).
   */
  listComplete?: boolean
  /**
   * These are retained READ-ONLY facts of a source that is disconnected right now
   * (the App attaches them past its `connected` gate and marks them stale).
   * Consumers may render them but must label them stale/offline, never as live;
   * absence keeps today's semantics exactly.
   */
  stale?: boolean
}

type Listener = () => void
type OpenListener = (request: OpenSessionRequest) => void
/** 「全部已读」请求（插件→App）：读水位是 App 的权威，插件不持有读标记。 */
type MarkAllReadListener = (request: { sourceId: string }) => void
/**
 * 意图预热（插件→App）：「指针在该来源头部停留过」的优先级提示。它不是打开/挂载
 * 请求：App 只把它折算成"既有后台预热队列里该来源优先"，是否 boot 仍由 App 的
 * eligible/抑制/收割纪律决定。
 */
type IntentPrewarmListener = (request: { sourceId: string }) => void
type OpenOutcomeListener = (outcome: OpenSessionOutcome) => void
type RefreshListener = (sourceId: string) => void
/**
 * Per-source session-list refresh request (archive-cleanup convergence): a
 * source's MOUNTED ctx session summaries are the official client's in-memory
 * rows, refreshed only on connection generations — content purged by the chamber
 * host domain triggers no official event, so deleted rows linger and resurface in
 * the sidebar once the host removes their ids from the archived set (opening one
 * then fails with session/not-found). The mounted ctx must re-run its OFFICIAL
 * `ctx.sessions.refresh()` (reconciles against the server corpus, drops the
 * deleted rows; MUST be invoked as a method on the service object — a detached
 * call loses `this`). Subscribers are the sidebar plugins of every mounted ctx,
 * each acting only when its own chamberInstanceId matches. Fired by the App's
 * ghost-row convergence machine, by the archive manager after every purge settle,
 * and directly by the producer's archive-set shrink observation (the channel is a
 * backstop).
 */
type SessionListRefreshListener = (sourceId: string) => void
/** One successful sidebar-issued workspace creation (see WorkspaceCreatedFact). */
type WorkspaceCreatedListener = (fact: WorkspaceCreatedFact) => void
/** One successful sidebar-issued workspace deletion (see WorkspaceRemovedFact). */
type WorkspaceRemovedListener = (fact: WorkspaceRemovedFact) => void
/** One successful sidebar-issued workspace rename (see WorkspaceRenamedFact). */
type WorkspaceRenamedListener = (fact: WorkspaceRenamedFact) => void
/** One successful in-app session creation (see SessionCreatedFact). */
type SessionCreatedListener = (fact: SessionCreatedFact) => void
/** One successful sidebar-issued session archive (the echo's withdraw half). */
type SessionRemovedListener = (fact: SessionRemovedFact) => void
type SourceListener = (sourceId: string) => void
type SettingsTargetListener = (sourceId: string | undefined) => void
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

/**
 * One fan-out channel: the chamberBridge subscriber plumbing, extracted so the
 * ~20 channels cannot drift and every channel shares one dispatch discipline — a
 * throwing listener is reported and the remaining listeners still run. Listeners
 * are snapshotted per emit, so subscribing/unsubscribing during dispatch never
 * affects the in-flight fan-out. `label` names the channel in the console
 * diagnostic.
 */
function createChannel<Args extends unknown[]>(label: (args: Args) => string) {
  const listeners = new Set<(...args: Args) => void>()
  return {
    subscribe(listener: (...args: Args) => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    emit(...args: Args): void {
      for (const listener of [...listeners]) {
        try {
          listener(...args)
        } catch (error) {
          console.error(`${label(args)}:`, error)
        }
      }
    },
  }
}

const serversChannel = createChannel<Parameters<Listener>>(() => '[dsh-chamber] bridge subscriber threw')
const openChannel = createChannel<Parameters<OpenListener>>(() => '[dsh-chamber] open-session listener threw')
const openOutcomeChannel = createChannel<Parameters<OpenOutcomeListener>>(() => '[dsh-chamber] open-outcome listener threw')
const markAllReadChannel = createChannel<Parameters<MarkAllReadListener>>(() => '[dsh-chamber] mark-all-read listener threw')
const intentPrewarmChannel = createChannel<Parameters<IntentPrewarmListener>>(() => '[dsh-chamber] intent-prewarm listener threw')
const refreshChannel = createChannel<Parameters<RefreshListener>>(() => '[dsh-chamber] refresh listener threw')
const sessionListRefreshChannel = createChannel<Parameters<SessionListRefreshListener>>(
  ([sourceId]) => `[chamber] session-list refresh listener failed for ${sourceId}`)
const workspaceCreatedChannel = createChannel<Parameters<WorkspaceCreatedListener>>(() => '[dsh-chamber] workspace-created listener threw')
const workspaceRemovedChannel = createChannel<Parameters<WorkspaceRemovedListener>>(() => '[dsh-chamber] workspace-removed listener threw')
const workspaceRenamedChannel = createChannel<Parameters<WorkspaceRenamedListener>>(() => '[dsh-chamber] workspace-renamed listener threw')
const sessionCreatedChannel = createChannel<Parameters<SessionCreatedListener>>(() => '[dsh-chamber] session-created listener threw')
const sessionRemovedChannel = createChannel<Parameters<SessionRemovedListener>>(() => '[dsh-chamber] session-removed listener threw')
const activateSourceChannel = createChannel<Parameters<SourceListener>>(() => '[dsh-chamber] activate-source listener threw')
const settingsTargetChannel = createChannel<Parameters<SettingsTargetListener>>(() => '[dsh-chamber] settings-target listener threw')
const activeSourceChannel = createChannel<Parameters<ActiveSourceListener>>(() => '[dsh-chamber] active-source subscriber threw')
const runtimeReportChannel = createChannel<Parameters<RuntimeReportListener>>(() => '[dsh-chamber] runtime-report listener threw')
const snapshotReportChannel = createChannel<Parameters<SnapshotReportListener>>(() => '[dsh-chamber] snapshot-report listener threw')
const pluginDiagnosticChannel = createChannel<Parameters<PluginDiagnosticListener>>(() => '[dsh-chamber] plugin-diagnostic listener threw')
let servers: ChamberServerAggregate[] = []
let activeSourceId: string | undefined
const runtimeReports: Record<string, InstanceRuntimeReport> = {}
const runtimeProducerTokens: Record<string, number> = {}
/** Boot generation of the ctx that currently owns each source's producers.
 *  Registration is order-gated by this: a hung earlier boot that resumes AFTER
 *  its successor registered must not steal the producer token — its teardown
 *  clear() would silence the healthy successor for good. */
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
    return serversChannel.subscribe(listener)
  },

  /**
   * App-layer write: replace the projection and notify subscribers.
   *
   * No microtask single-slot merge here: the App has a projection signature gate,
   * the sidebar re-checks the signature before setState, and write paths are
   * identity-preserving; React 19 batching already merges same-macrotask
   * publishes, while async merging would open a getServers() mid-state race. Only
   * a reference-equality guard remains: same-reference republish is silenced (an
   * immutable snapshot means no content change). Any future in-place-mutation
   * design MUST rewrite this note rather than bypass it.
   */
  publish(next: ChamberServerAggregate[]): void {
    if (next === servers) return
    servers = next
    serversChannel.emit()
  },

  /** Ask the App layer to switch to the source shell and open the session. */
  requestOpenSession(sourceId: string, sessionId: string): void {
    openChannel.emit({ sourceId, sessionId })
  },

  /** App-layer subscription to open-session requests; returns the unsubscribe. */
  onOpenSession(listener: OpenListener): () => void {
    return openChannel.subscribe(listener)
  },

  /** App-layer report that one requested open settled (failure carries the loud
   *  terminal message, surfaced on the session row; success clears it). */
  reportOpenSessionOutcome(outcome: OpenSessionOutcome): void {
    openOutcomeChannel.emit(outcome)
  },

  /** Sidebar subscription to open-outcome reports; returns the unsubscribe. */
  onOpenSessionOutcome(listener: OpenOutcomeListener): () => void {
    return openOutcomeChannel.subscribe(listener)
  },

  /** 请 App 把一个来源整体标记为已读（单向：插件→App）。读标记与落盘都在 App
   *  手里，插件只发意图。 */
  requestMarkAllRead(sourceId: string): void {
    markAllReadChannel.emit({ sourceId })
  },

  /** App 层订阅「全部已读」请求；返回取消订阅。 */
  onMarkAllRead(listener: MarkAllReadListener): () => void {
    return markAllReadChannel.subscribe(listener)
  },

  /** 来源头部 hover dwell 留驻后，侧栏发出的单向优先级提示。绝不挂载/打开任何
   *  东西：App 只把它折算成"既有预热队列里该来源优先"，是否 boot 由 App 的
   *  eligible/抑制/收割纪律与每会话计费决定。 */
  requestIntentPrewarm(sourceId: string): void {
    intentPrewarmChannel.emit({ sourceId })
  },

  /** App 层订阅意图预热请求；返回取消订阅。 */
  onIntentPrewarm(listener: IntentPrewarmListener): () => void {
    return intentPrewarmChannel.subscribe(listener)
  },

  /** Sidebar call after an action: unmounted/incomplete sources ask App for one pull; mounted stores push. */
  requestRefresh(sourceId: string): void {
    refreshChannel.emit(sourceId)
  },

  /** App-layer subscription to refresh requests; returns the unsubscribe. */
  onRefresh(listener: RefreshListener): () => void {
    return refreshChannel.subscribe(listener)
  },

  /** Ask the MOUNTED ctx of `sourceId` to refresh its official session list
   *  (only the plugin whose chamberInstanceId equals `sourceId` acts). See the
   *  SessionListRefreshListener note. */
  requestSessionListRefresh(sourceId: string): void {
    // 逐监听器隔离（与 setActiveSource 同纪律）：这条广播同时驱动归档收敛链与
    // 运行位活性守卫的 L1，一个抛错的监听器不得中断整轮广播。
    sessionListRefreshChannel.emit(sourceId)
  },

  /** Sidebar-plugin subscription to session-list refresh requests; returns the unsubscribe. */
  onRequestSessionListRefresh(listener: SessionListRefreshListener): () => void {
    return sessionListRefreshChannel.subscribe(listener)
  },

  /**
   * Call after a successful `workspace.create` (single funnel
   * shared/workspace-mutations.ts): publish the host workspace identity so the
   * App can echo the row into that source's projection without waiting for a
   * mount. One-way fact, never a request to mutate the host.
   */
  reportWorkspaceCreated(fact: WorkspaceCreatedFact): void {
    workspaceCreatedChannel.emit(fact)
  },

  /** App-layer subscription to workspace-creation facts; returns the unsubscribe. */
  onWorkspaceCreated(listener: WorkspaceCreatedListener): () => void {
    return workspaceCreatedChannel.subscribe(listener)
  },

  /**
   * Sidebar call after a successful `workspace.delete`: publish the fact so the
   * App can retire the echo row. Same one-way shape as create, and the only
   * retirement path for an echo whose source never mounted (no baseline lists the
   * workspace yet, so reconciliation cannot match it).
   */
  reportWorkspaceRemoved(fact: WorkspaceRemovedFact): void {
    workspaceRemovedChannel.emit(fact)
  },

  /** App-layer subscription to workspace-removal facts; returns the unsubscribe. */
  onWorkspaceRemoved(listener: WorkspaceRemovedListener): () => void {
    return workspaceRemovedChannel.subscribe(listener)
  },

  /**
   * Sidebar call after a successful `workspace.rename`: publish the new title so
   * the App can patch the echo row. An echo row's title derives from its path, so
   * without this fact the rename looks like a no-op until mount.
   */
  reportWorkspaceRenamed(fact: WorkspaceRenamedFact): void {
    workspaceRenamedChannel.emit(fact)
  },

  /** App-layer subscription to workspace-rename facts; returns the unsubscribe. */
  onWorkspaceRenamed(listener: WorkspaceRenamedListener): () => void {
    return workspaceRenamedChannel.subscribe(listener)
  },

  /**
   * Call after a successful in-app session creation (single funnel
   * shared/session-mutations.ts): publish the HOST session id so the App can
   * project the row into that workspace immediately (session-echo ledger) instead
   * of waiting for a producer that cannot see it. One-way fact.
   */
  reportSessionCreated(fact: SessionCreatedFact): void {
    // I10：每次应用内创建都进归因账本（含 blank），只读仪表挂到页面全局一次。
    sessionCreationLedger.record({
      sourceId: fact.sourceId,
      sessionId: fact.sessionId,
      blank: fact.blank,
      origin: fact.origin ?? 'unknown',
      at: Date.now(),
    })
    publishSessionCreationInstrument()
    sessionCreatedChannel.emit(fact)
  },

  /** App-layer subscription to session-creation facts; returns the unsubscribe. */
  onSessionCreated(listener: SessionCreatedListener): () => void {
    return sessionCreatedChannel.subscribe(listener)
  },

  /**
   * Sidebar call after a successful `workspace.archiveSession`: retires that
   * session's pending creation echo AND records the local archive tombstone.
   * Published by the same funnel, fenced by the App like the create fact.
   */
  reportSessionRemoved(fact: SessionRemovedFact): void {
    sessionRemovedChannel.emit(fact)
  },

  /** App-layer subscription to session-removal (archive) facts; returns the unsubscribe. */
  onSessionRemoved(listener: SessionRemovedListener): () => void {
    return sessionRemovedChannel.subscribe(listener)
  },

  /** Sidebar call when the user clicks a source header: ask the App layer to switch the active view. */
  requestActivateSource(sourceId: string): void {
    activateSourceChannel.emit(sourceId)
  },

  /** App-layer subscription to source-activation requests; returns the unsubscribe. */
  onActivateSource(listener: SourceListener): () => void {
    return activateSourceChannel.subscribe(listener)
  },

  /**
   * Settings-panel call: the source whose settings surface is on screen
   * (`undefined` when closed). The App answers by MOUNTING that source's shell if
   * needed and holding it out of the retention harvest while it stays the target
   * — the panel renders that source's OWN boot-ctx ledger. Activation is
   * deliberately not implied: the active view keeps following the user.
   */
  setSettingsTarget(sourceId: string | undefined): void {
    settingsTargetChannel.emit(sourceId)
  },

  /** App-layer subscription to settings-target changes; returns the unsubscribe. */
  onSettingsTarget(listener: SettingsTargetListener): () => void {
    return settingsTargetChannel.subscribe(listener)
  },

  /**
   * App-layer write: the source whose shell is currently on screen — the
   * authoritative active-view fact of the shared document. Consumers that must
   * act for ONE view only gate on it instead of guessing from DOM classes or
   * mount order. Undefined means "not published": consumers fail OPEN, so a boot
   * without the App layer keeps its previous unconditional behavior.
   */
  setActiveSource(sourceId: string | undefined): void {
    if (sourceId === activeSourceId) return
    activeSourceId = sourceId
    // Per-listener isolation (same discipline as the layout facts fan-out): a
    // throwing projector must not abort the publish for its siblings.
    activeSourceChannel.emit(activeSourceId)
  },

  /** Page-wide active-view fact; undefined until the App publishes. */
  getActiveSource(): string | undefined {
    return activeSourceId
  },

  /** Subscribe to active-view changes (fires on change only); returns the unsubscribe. */
  onActiveSource(listener: ActiveSourceListener): () => void {
    return activeSourceChannel.subscribe(listener)
  },

  /**
   * Synchronously revoke every producer owned by one registry incarnation. Shell
   * disposal is async, so waiting for plugin cleanup leaves a window in which the
   * old ctx can report after the authoritative roster re-added the same id.
   * Delete tokens and caches now, then emit explicit withdrawals; old closures
   * subsequently fail their token checks.
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
    runtimeReportChannel.emit(sourceId, undefined, runtimeFingerprint)
    snapshotReportChannel.emit(sourceId, undefined, snapshotFingerprint)
    // Diagnostics are per-source renderer state too: roster retirement must drop
    // them or a deleted source keeps a stale pluginDiagnostic entry forever.
    if (pluginDiagnostics[sourceId] !== undefined) {
      delete pluginDiagnostics[sourceId]
      pluginDiagnosticChannel.emit(sourceId, undefined)
    }
  },

  /**
   * Register the runtime-facts producer owned by one mounted instance ctx. Token
   * gating makes async teardown generation-safe: an old ctx's late clear/report
   * can never erase the replacement's facts.
   */
  registerInstanceRuntimeProducer(
    sourceId: string,
    sourceFingerprint: string,
    bootGeneration?: number,
  ): {
    report: (report: InstanceRuntimeReport) => void
    clear: () => void
  } {
    // 代际栅栏：更老的 boot 迟到注册一律作废（返回惰性句柄）；两者都无代
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
      runtimeReportChannel.emit(sourceId, undefined, previousFingerprint)
    }
    return {
      report(report): void {
        if (runtimeProducerTokens[sourceId] !== token) return
        runtimeReports[sourceId] = report
        runtimeReportChannel.emit(sourceId, report, sourceFingerprint)
      },
      clear(): void {
        if (runtimeProducerTokens[sourceId] !== token) return
        delete runtimeProducerTokens[sourceId]
        delete runtimeProducerFingerprints[sourceId]
        delete runtimeProducerGenerations[sourceId]
        if (runtimeReports[sourceId] === undefined) return
        delete runtimeReports[sourceId]
        runtimeReportChannel.emit(sourceId, undefined, sourceFingerprint)
      },
    }
  },

  /** App-layer subscription to runtime-fact reports (report or clear); returns the unsubscribe. */
  onRuntimeReport(listener: RuntimeReportListener): () => void {
    return runtimeReportChannel.subscribe(listener)
  },

  /**
   * Register the snapshot producer owned by one mounted instance ctx. The token
   * makes teardown generation-safe: a late cleanup from an old shell cannot clear
   * a newer shell's report for the same source.
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
      snapshotReportChannel.emit(sourceId, undefined, previousFingerprint)
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
        snapshotReportChannel.emit(sourceId, snapshot, sourceFingerprint)
      },
      clear(): void {
        if (snapshotProducerTokens[sourceId] !== token) return
        delete snapshotProducerTokens[sourceId]
        delete snapshotProducerFingerprints[sourceId]
        delete snapshotProducerGenerations[sourceId]
        if (instanceSnapshots[sourceId] === undefined) return
        delete instanceSnapshots[sourceId]
        snapshotReportChannel.emit(sourceId, undefined, sourceFingerprint)
      },
    }
  },

  /** Current complete reports, used only as renderer-local attachment state. */
  getInstanceSnapshots(): Readonly<Record<string, InstanceSnapshot>> {
    return instanceSnapshots
  },

  /** Subscribe and synchronously replay all complete reports. */
  onInstanceSnapshot(listener: SnapshotReportListener): () => void {
    const unsubscribe = snapshotReportChannel.subscribe(listener)
    for (const [sourceId, snapshot] of Object.entries(instanceSnapshots)) {
      try {
        listener(sourceId, snapshot, snapshotProducerFingerprints[sourceId])
      } catch (error) {
        console.error(`[dsh-chamber] snapshot replay for ${sourceId} threw:`, error)
      }
    }
    return unsubscribe
  },

  reportPluginDiagnostic(sourceId: string, diagnostic: PluginGraphDiagnostic): void {
    pluginDiagnostics[sourceId] = diagnostic
    pluginDiagnosticChannel.emit(sourceId, diagnostic)
  },

  clearPluginDiagnostic(sourceId: string): void {
    if (pluginDiagnostics[sourceId] === undefined) return
    delete pluginDiagnostics[sourceId]
    pluginDiagnosticChannel.emit(sourceId, undefined)
  },

  getPluginDiagnostics(): Readonly<Record<string, PluginGraphDiagnostic>> {
    return pluginDiagnostics
  },

  onPluginDiagnostic(listener: PluginDiagnosticListener): () => void {
    const unsubscribe = pluginDiagnosticChannel.subscribe(listener)
    for (const [sourceId, diagnostic] of Object.entries(pluginDiagnostics)) {
      try {
        listener(sourceId, diagnostic)
      } catch (error) {
        console.error(`[dsh-chamber] plugin-diagnostic replay for ${sourceId} threw:`, error)
      }
    }
    return unsubscribe
  },
}
