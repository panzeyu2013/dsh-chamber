/**
 * chamberBridge — the renderer-shared single instance (design 05 §3). The
 * chamber App layer (renderer main entry) publishes the merged multi-source
 * projection and consumes open-session requests; the sidebar plugin
 * subscribes to the projection and publishes open-session requests. Both
 * import this module through `@dsh-chamber/dsh-chamber-client-ui-sidebar/shared`; a
 * vite shared chunk keeps the runtime single instance.
 *
 * One workspace group in the sidebar projection (computed by shared/derive.ts).
 * The synthetic trailing ungrouped bucket carries `ungrouped: true` and the
 * shared UNGROUPED_WORKSPACE_ID as its id.
 */
import type { InstanceSnapshot } from './instance-api.ts'
import type { ArchivedSessionMetaRow } from './aggregate-types.ts'
import type { GoalFact, SubagentActivity } from './session-row-state.ts'
import type { SessionAuthoritySnapshot } from './session-fact-reconcile.ts'
import { assertSingletonModule } from './singleton.ts'
import {
  publishSessionCreationInstrument, sessionCreationLedger, type SessionCreationOrigin,
} from './session-create-ledger.ts'

assertSingletonModule('aggregate-store')

/**
 * 事实未到（投影缺席）——**绝不折叠为 'idle'**（未连接）。App 的 deriveServers 在
 * `remoteStatus[statusKey]` 缺席时发布本常量：'idle' 是"手动断开"的合法事实，折叠
 * 会让 hover/aria 把一次投影延迟/拉取失败说成"未连接"；'unknown' 在侧栏读作
 * 「状态未知」文案，而 transportUsable 对二者同为 false（行为面不变，只是不再撒谎）。
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
   * True only for the fallback's cwd-derived groups (`__cwd__:` ids,
   * fetchInstanceSnapshot). Display-only: the host does not know these ids,
   * so the sidebar must disable every workspace-scoped mutation on them
   * (ungrouped-bucket parity).
   */
  synthetic?: boolean
  sessions: {
    id: string
    /** Durable title projection — '' when the session has none. Rename/fork copy uses THIS. */
    title: string
    /**
     * Official display label (I3): `title ?? basename(cwd) ?? id`, resolved by
     * `derive.ts sessionDisplayTitle` and NEVER empty. This is what row labels,
     * hover copy, aria names and todo rows render — a session whose title the
     * host could not read shows its project directory name, never
     * 「未命名会话」.
     */
    displayTitle: string
    running?: boolean
    updatedAt?: number
    blank?: boolean
    /**
     * The session owns at least one active
     * schedule — projected from the session's `schedule` projection
     * (`derive.ts hasActiveScheduleOf`, upstream ui-workspace tree.ts:161-163)
     * so the row can render the official active-Schedule marker. Sparse: absent
     * means no active schedule.
     */
    hasActiveSchedule?: boolean
  }[]
  /**
   * Official reuse-or-create resolution for this workspace's "+" (I2), computed
   * by `derive.ts findReusableBlankSession` over the RAW snapshot: a blank,
   * non-archived member session in the workspace's own directory that upstream
   * `connectWorkspace` would reopen instead of creating another one. Absent
   * means "create" — either no such row, or the archive set is unknown
   * (unary fallback), where create is the honest degradation.
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
   * Gateway only: the managed dsh was probed into a terminal-down state while
   * the TRANSPORT was up (`stopped`/`error`/`restart-exhausted`). A dedicated
   * fact, never re-derived from `phase`: `phase` merges the managed state with
   * the transport phase and both vocabularies contain `error`, so classifying
   * the merged string would misdiagnose an SSH/tunnel failure as a stopped
   * managed dsh. Absent = not a gateway, transport
   * down, probe missing, or a healthy/transient managed state (fail open).
   */
  managedRuntimeDown?: boolean
  /**
   * 能力一览：本来源的**会话事实档位**，由桌面侧事实源
   * 探测/观测得出，只读展示，绝不参与判定（判定只用事实本身）。
   * - `full`：镜像可用且版本兼容，完成/未读是观测事实；
   * - `degraded`：镜像可用但受限（尾巴不可读 / 事件静默 / 轮询模式 / 特性缺失）；
   * - `legacy`：该网关未升级（路由 404，无镜像）；
   * - `disabled`：该网关的观察面被关闭（503 或 `mode:'off'`）。
   * 缺席 = 未知（未探测 / 该部署形态无此面）——绝不臆造为 full。
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
   * Archived-session metadata rows of this source (design 24 revision —
   * the archive manager lists what is archived; rows additionally carry their
   * workspace attribution for the manager's
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
   *   destructive action (no list to select; no standalone delete-all).
   */
  archivedSessions?: ArchivedSessionMetaRow[]
  archiveSetKnown?: boolean
  /**
   * dsh version fact. The LOCAL instance's version flows straight from the
   * desktop bridge
   * (`window.dshChamber.dshVersion` → App hostFacts); remote instances stay
   * unknown until the control-plane `dsh --version` facts are projected
   * through the chamber bridge.
   */
  dshVersion?: string
  /** Renderer-local client-plugin boot health for this source. */
  pluginDiagnostic?: PluginGraphDiagnostic
  /**
   * Settled-boot GAP of this source's mounted shell (design 05 §4
   * 「降级呈现」/ design 09 §3.2): the shell settled successfully while a whole
   * surface is missing.
   *
   * A SEPARATE fact from {@link pluginDiagnostic} on purpose. The diagnostic
   * channel describes the host boot-GRAPH channel (`ok` legitimately means "the
   * graph was fetched and every row that arrived applied"); the classic gap —
   * the graph arrived but `ui-chat`'s `sidebarRight` was never provided — leaves
   * that channel at `ok` while the conversation view never registers. Overloading
   * one channel with both meanings would either lie ("正常" next to an empty
   * conversation) or make the recheck/self-heal classification ambiguous.
   *
   * Structured facts only (never the producer's diagnostic sentence): each
   * rendering package writes its own copy from `kind` + the ids (STATUS
   * 「跨边界诊断文案」). Absent = no gap reported for the current mount.
   */
  bootGap?: ServerBootGap
  updatedAt: number
}

/** Why a mounted shell is known to be incomplete (see {@link ChamberServerAggregate.bootGap}). */
export type ServerBootGapKind =
  | 'graph-unavailable'
  /**
   * The LOCAL instance's client-graph endpoint answered 404 / method-missing.
   * The chamber-managed local host always injects its graph (the seed row), so
   * this is a chamber-side installation/seed fact — the gateway/mobile shapes,
   * whose missing endpoint is legitimate, keep producing NO fact.
   */
  | 'local-graph-not-injected'
  | 'required-services-missing'
  | 'deferred-registration-failed'

/**
 * The cross-package face of one settled-boot gap. Producers (the renderer's
 * shell seam) hand these fields over; consumers render their own sentences.
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
 * sidebar shell (design 05 §3's request channel is one-way — the App layer
 * owns the dispatch budget and the failure; the sidebar owns the row).
 * Success carries no message; failure carries the dispatch's loud report.
 */
export interface OpenSessionOutcome extends OpenSessionRequest {
  /** Present only on failure: the terminal error report (App-wrapped text). */
  message?: string
}

/**
 * One successful in-app workspace creation for a source whose shell may not be
 * mounted (design 05 §2.2 revision). The unary `workspace.create`
 * result is the ONLY trustworthy "this workspace now exists on that host" fact
 * available without a shell: the App layer echoes the row into the projection
 * immediately (shared/workspace-echo.ts) while the authoritative
 * `workspace/follow` baseline converges later — for an unmounted source the
 * unary fallback cannot express an empty workspace at all (no session carries
 * its cwd yet).
 *
 * Every in-app producer goes through shared/workspace-mutations.ts (the single
 * funnel: the sidebar's own dialogs AND the Git worktree plugin's create/adopt
 * sagas). Publishing per call site is the failure mode this funnel removes.
 */
export interface WorkspaceCreatedFact {
  sourceId: string
  workspaceId: string
  path: string
  /**
   * Optional placement anchor: the host
   * workspace id this creation sits immediately AFTER in the projection — the
   * Git plugin registers a new worktree right below its main checkout
   * (workspace.insertBefore) while the projection would otherwise append the
   * echoed row at the tail and make it jump once the source mounts. Absent =
   * append at the tail (every sidebar-issued creation, whose host order is
   * "last created is last").
   */
  afterWorkspaceId?: string
  /**
   * Optional label this creation INTENDS for the row: the Git
   * plugin's adopt path renames the workspace to the branch right after the
   * saga, and without the hint the echoed row would be born with the path
   * basename and flip a few RPCs later. Absent = the ledger's path-basename
   * rule; the mounted follow baseline still wins over both.
   */
  title?: string
}

/**
 * One successful sidebar-issued workspace deletion —
 * the WITHDRAW half of the workspace echo. The sidebar owns `workspace.delete`
 * for the same sources it can create on, and without this fact the echo has no
 * way to be retired: for a source whose shell is not mounted there is no
 * authoritative baseline that lists the workspace yet, so
 * `reconcilePendingWorkspaces` cannot match it, and the deleted row survives as
 * a GHOST with real-id actions enabled until the 10-minute TTL. `path` is
 * best-effort (empty when the source's mounted snapshot has not reported the
 * workspace) — the ledger matches by `workspaceId` as well.
 */
export interface WorkspaceRemovedFact {
  sourceId: string
  workspaceId: string
  path: string
}

/**
 * One successful sidebar-issued workspace rename — the
 * PATCH half of the workspace echo. An echo row's title is `basenameOf(path)`,
 * so a rename against a not-yet-mounted source would look like a no-op (the row
 * keeps the path basename until the mount push lands). The sidebar owns
 * `workspace.rename`, so it publishes the new title here.
 */
export interface WorkspaceRenamedFact {
  sourceId: string
  workspaceId: string
  title: string
}

/**
 * One successful in-app session creation (design 05 §2.2 revision) —
 * the session-side sibling of {@link WorkspaceCreatedFact}, published by the
 * single funnel `shared/session-mutations.ts` for the sidebar's "+", the
 * session row menu's fork, and the Git plugin's own session creations.
 *
 * WHY the fact exists: a session minted over the source's UNARY client reaches
 * neither producer of that source's projection in time — the mounted ctx push
 * carries the official session-summary store, whose only out-of-band update is
 * the host's ASYNCHRONOUS `api-session/added` broadcast (in the race window the
 * push replaces the aggregate from a store that does not list the id yet, and
 * an UNMOUNTED source never receives the broadcast at all), while the 30s unary
 * fallback's merge keeps a pushed source's workspace membership frozen, so the
 * new id can only appear as an unaccounted stray (hidden while it is the
 * provisional blank row of a non-current source). The App records the host id
 * in its session-echo ledger, projects the row into its workspace immediately,
 * and converges on the authoritative view (the official session-list refresh
 * this fact triggers — the seam that forces the summaries to re-read the
 * corpus — or the source's next mount).
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
   * first turn, so navigation surfaces it only while it is that source's
   * CURRENT session — upstream semantics, deliberately not overridden by the
   * echo), false for a fork child, which inherits content.
   */
  blank: boolean
  /** 归因：触发路径标签；缺席 = unknown（仪表覆盖缺口）。 */
  origin?: SessionCreationOrigin
}

/**
 * One successful sidebar-issued session ARCHIVE. Two jobs, both local-fact
 * keeping for a source whose shell may not be mounted:
 * - the WITHDRAW half of the creation echo (a create → archive inside the same
 *   echo window must not leave a phantom row until the TTL), and
 * - the trigger of the local ARCHIVE TOMBSTONE (session-echo.ts
 *   PendingArchive): for an unmounted source no channel carries the new archive
 *   set at all — the mounted merge keeps the frozen pushed set and the unary
 *   fallback has no archive wire — so the archived row would stay listed and
 *   open into the official empty (archived-current-cleared) view.
 */
export interface SessionRemovedFact {
  sourceId: string
  sessionId: string
}

/**
 * Per-instance runtime facts projected by the sidebar plugin of the source's
 * own ctx (design 06 §4): current session id plus per-session live rows. The
 * plugin projects the source's session-list snapshot (minus the ids it has
 * tombstoned as purged — design 24 §12) —
 * every listed session carries its live `running` bit — the producer's
 * resolveSessionRunning result — the App layer derives the completed-but-unread dot
 * from running→idle edges itself (App.tsx), `pending` rides the official
 * `sessionStatus` projection, `completed` is injected by the App ledger at merge
 * time and never by the channel, and `runningSubagents` carries the lineage index's RUNNING subagent
 * descendant count per parent (06 §4.5 — a parent whose round ended while
 * background subagents still work must not render its completed dot). Attached to
 * ChamberServerAggregate.runtime as a separate channel — never polled by the App.
 */
export interface InstanceRuntimeReport {
  current?: string
  /**
   * Every listed session (edge memory for the App's completed-dot derivation):
   * the live running bit, a sparse `pending` from the official sessionStatus
   * projection, `completed` injected at merge time by the App ledger only, and a
   * non-zero `runningSubagents`.
   */
  sessions: Record<string, {
    running?: boolean
    completed?: boolean
    pending?: 'approval' | 'plan-review' | 'question'
    /**
     * Run identity of this row's current/last episode (I1): the producer mints
     * ONE chamber-family SessionRunId per observed run episode, so the App keys
     * runtime-edge notifications by identity instead of a watermark guess. A row
     * keeps its last run id after the run ends (the completion still belongs to
     * it); a fresh run mints a new one.
     */
    runId?: string
    /** Host-domain `updatedAt` of this row (read ordering anchor for the App's
     *  runtime-completion adoption; never a read watermark). */
    updatedAt?: number
    /** Running subagent descendants (vendor runningSubagentCount semantics); absent = 0. */
    runningSubagents?: number
    /** 子代理活动三值：none（索引在场且为零）| running | unknown（索引缺席或来源 stale）。 */
    subagentActivity?: SubagentActivity
    /**
     * Goal 三值事实（design 19 §3.2.1）：**字段缺席 = unknown**
     * （投影还没给出 goal 键 / 形状不符），`null` = 明确无 goal，对象 = 有 goal。
     * 生产者按来源代回填最后已知值并合并 §2.2 的 activation 事件缓存；
     * 呈现门 `goalSuppressesPresentation` 只读相位（active 即压制，含 unknown）。
     */
    goal?: GoalFact | null
    /** 观察者刷新这一行事实的 host 域毫秒（0/缺席 = 无观察者事实）。 */
    factAt?: number
  }>
  /**
   * 会话事实单一权威（P2，design 06 §4）的快照；
   * 缺席 = 本记录内从未请求过。App 的升级 ladder 只读它的事实（runningSince /
   * stuckSince / progressStamp）决定 reconnect 与 notice——策略不在 App 侧。
   * 执行端是 shared/session-fact-reconcile.ts（reducer + probe ladder + I/O）。
   */
  sessionAuthority?: SessionAuthoritySnapshot
  /**
   * Whether `sessions` came from a COMPLETE session-list baseline:
   * the mounted producer projects the official list store's arrival
   * phase (`phase === 'ready'`, vendor
   * dsh-api-session-controller/lib/types/client/sessions/manager.js:41,387 —
   * pending until the first successful list, never rolled back by a later
   * error). Only `true` is an authoritative "a session absent here is
   * GONE" gate for the App's unread pruning; absent/undefined means "not
   * proven complete" and must retain state (never prune on a shrinking list
   * that is merely unverified). It is a JUDGMENT input, not a rendered fact —
   * the sidebar projection does not carry it (shared/derive.ts
   * runtimeReportSignature signs it on the identity path only).
   */
  listComplete?: boolean
  /**
   * These facts are retained READ-ONLY facts of a source that is
   * disconnected right now (the App attaches them past its `connected` gate
   * and marks them stale). Consumers may render them but must label them as
   * stale / offline instead of presenting them as live; a report without the
   * flag keeps today's semantics exactly (unknown ≠ attention).
   */
  stale?: boolean
}

type Listener = () => void
type OpenListener = (request: OpenSessionRequest) => void
/** 「全部已读」请求（插件→App）：读水位是 App 的权威，插件不持有读标记。 */
type MarkAllReadListener = (request: { sourceId: string }) => void
/**
 * 意图预热（插件→App）：「指针在该来源头部停留过」这一
 * 优先级提示。它不是打开/挂载请求：App 侧只把它折算成"既有后台预热队列里
 * 该来源优先"，是否真的 boot 仍由 App 的 eligible/抑制/收割纪律决定。
 */
type IntentPrewarmListener = (request: { sourceId: string }) => void
type OpenOutcomeListener = (outcome: OpenSessionOutcome) => void
type RefreshListener = (sourceId: string) => void
/**
 * Per-source session-list refresh request (archive-cleanup convergence, design
 * 24 §12): a source's MOUNTED ctx session summaries are the official client's
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
 * manager after every purge settle — see design 24 §12 / App.tsx. Since §12
 * the PRODUCER also triggers the same verified chain directly from its own
 * archive-set shrink observation (the channel is a backstop, not the only
 * trigger), and the official refresh MUST be invoked as a method on the
 * service object (`ctx.sessions.refresh()` — a detached call loses `this`).
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
 * ~20 channels cannot drift and so EVERY channel shares one dispatch
 * discipline — a throwing listener is reported and the remaining listeners
 * still run (before this extraction only sessionListRefresh and activeSource
 * isolated; one bad subscriber could starve its siblings on the other 18
 * channels). Listeners are snapshotted per emit, so subscribing/unsubscribing
 * during dispatch never affects the in-flight fan-out. `label` names the
 * channel (and may use the emit arguments) in the console diagnostic.
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
 *  Registration is order-gated by this (see registerInstanceRuntimeProducer):
 *  a hung earlier boot that resumes AFTER its successor registered must not
 *  steal the producer token — its teardown clear() would then silence the
 *  healthy successor for good. */
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
   * 调用面已有多重收口，本层无需再做微任务单槽合并
   * ——App 发布前有 serversProjectionSignature 签名闸（等值不 publish），
   * 订阅侧（SidebarRoot）在 setState 前再比一次签名，refreshAggregate 等
   * 写路径 identity-preserving（同内容不换对象）。React 19 批处理已把同一
   * macrotask 内的多次 publish 合并为一次渲染，异步合并反而会引入
   * getServers() 读到中间态的竞态窗口。本入口只保留引用相等防御：publish
   * 语义是"换快照 + 通知"，同引用重发无任何增量（快照本身不可变）。
   * 不变式：同引用重发布被静默丢弃——不可变快照下同引用
   * ≡ 无内容变化；若未来引入原地突变 + 同引用重发布（今日被不可变性禁止），
   * 此守卫会吞掉它——任何此类改动必须先改写本注释，而非绕过守卫。
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
   * Call after a successful `workspace.create` (single funnel:
   * shared/workspace-mutations.ts): publish the host workspace identity so the
   * App layer can echo the row into that source's projection without waiting
   * for a mount (`withWorkspaceEcho`). The App layer remains the only owner of
   * the projection; this channel is a one-way fact, never a request to mutate
   * the host.
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
   * App layer can retire the echo row of that workspace
   * (`removePendingWorkspace`). Same one-way shape as the create counterpart,
   * and the only retirement path for an echo whose source never mounted: no
   * authoritative baseline lists the workspace yet, so reconciliation cannot
   * match it and the deleted row would stay visible with real-id actions
   * enabled until the TTL.
   */
  reportWorkspaceRemoved(fact: WorkspaceRemovedFact): void {
    workspaceRemovedChannel.emit(fact)
  },

  /** App-layer subscription to workspace-removal facts; returns the unsubscribe. */
  onWorkspaceRemoved(listener: WorkspaceRemovedListener): () => void {
    return workspaceRemovedChannel.subscribe(listener)
  },

  /**
   * Sidebar call after a successful `workspace.rename`: publish the new title
   * so the App layer can patch the echo row (`renamePendingWorkspace`). An echo
   * row's title is derived from its path, so without this fact the rename
   * looked like a no-op on an unmounted source until the mount push arrived.
   */
  reportWorkspaceRenamed(fact: WorkspaceRenamedFact): void {
    workspaceRenamedChannel.emit(fact)
  },

  /** App-layer subscription to workspace-rename facts; returns the unsubscribe. */
  onWorkspaceRenamed(listener: WorkspaceRenamedListener): () => void {
    return workspaceRenamedChannel.subscribe(listener)
  },

  /**
   * Call after a successful in-app session creation (single funnel:
   * shared/session-mutations.ts): publish the HOST session id so the App layer
   * can project the row into that source's workspace immediately
   * (session-echo ledger) instead of waiting for a producer that cannot see it
   * — see {@link SessionCreatedFact}. Same one-way fact shape as the workspace
   * echo; the App remains the only writer of the projection.
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
   * session's pending creation echo AND records the local archive tombstone
   * ({@link SessionRemovedFact}). Published by the same funnel, fenced by the
   * App exactly like the create fact.
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
   * (`undefined` when the panel closed). The App layer answers by MOUNTING
   * that source's shell if it is not mounted yet and by holding it out of the
   * retention harvest while it stays the target — the panel renders that
   * source's OWN boot-ctx ledger (design 05 §5), so the
   * mounted shell IS the surface. Activation is deliberately not implied: the
   * active view keeps following the user, not the dropdown.
   */
  setSettingsTarget(sourceId: string | undefined): void {
    settingsTargetChannel.emit(sourceId)
  },

  /** App-layer subscription to settings-target changes; returns the unsubscribe. */
  onSettingsTarget(listener: SettingsTargetListener): () => void {
    return settingsTargetChannel.subscribe(listener)
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
