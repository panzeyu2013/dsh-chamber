/**
 * Chamber sidebar per-source section (design 05 §2; chamber rounds 06/08/24):
 * ONE server's subtree of the multi-source session list — the source header
 * (connection dot/spinner + hover status, server fold, sort menu, git alert,
 * add-workspace, per-source search capsule with results, design-24
 * archive-cleanup manager), the workspace groups and the session rows with their
 * in-source drag ordering and ghost rows. Extracted from the SidebarRoot
 * shell; cross-cutting state/actions are consumed through useSidebarSection()
 * (sidebar-context.ts — the shell owns every store/effect/commit below and
 * provides ONE context value per render). This file owns only what is
 * per-section: the search-state mirror (shared controller), the capsule DOM
 * refs, the outside-click collapse effect, the sort-menu anchor-cleanup, and
 * the module-scope helpers only this subtree uses (status kind/label
 * mapping, the projection→local-search-snapshot rebuild, rowHalf).
 */

import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { SESSION_SEARCH_RESULT_LIMIT } from '@deepseek-ai/dsh-api-session-controller/client'
import {
  HoverCard, IconAlarmClockOutline16, IconArchiveOutline20, IconBranchOutline16, IconChecklistOutline14,
  IconChevronRightOutline14, IconCloseOutline16, IconEditOutline16, IconEllipsisOutline16,
  IconFolderOpenOutline16, IconLoadingOutline16,
  IconPersonalizationOutline16, IconPlusOutline16, IconProjectAddOutline16, IconQuestionOutline14,
  IconSearchOutline16, IconTrashOutline16, IconWarningOutline16, Menu, StateDot, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarKey } from './locales.ts'
import { IconMonitorOutline16 } from './icons.tsx'
import { chamberBridge, type ChamberServerAggregate, type ChamberServerWorkspace } from '../shared/aggregate-store.ts'
import {
  deriveLocalSearchMatches, mergeSearchResults, orderUngroupedSessions, reconciledSessionOrder, relativeTimeBucket,
  runningRingVisible, sanitizeSearchQuery, SEARCH_QUERY_MAX_CODE_UNITS, workspaceAccentStyle,
} from '../shared/derive.ts'
import { type InstanceSnapshot, type SearchRow } from '../shared/instance-api.ts'
import {
  clearSearch, collapseSearch, expandSearch, getSearchStates, setSearchQuery, subscribeSearch,
  type SourceSearchState,
} from '../shared/search-state.ts'
import { clearPendingClick, noteSessionRowClick } from '../shared/pending-click.ts'
import { MANAGED_RUNTIME_TRANSIENT_STATES } from '../shared/managed-runtime.ts'
import { openErrorKey } from '../shared/open-outcome.ts'
import { getSourceRepoLayouts, getWorkspaceGitFlag, hiddenByMainWorkspaceFold, isSourceGitFlagsLoaded } from '../shared/workspace-git-flags.ts'
import { resolveWorkspaceDrop } from '../shared/workspace-drag-order.ts'
import { sessionRowDisclosure, sessionRowWindow, SESSION_ROWS_VISIBLE_FIRST } from '../shared/session-row-window.ts'
import { sourceAccentStyle, useSidebarSection, workspaceDropEnv } from './sidebar-context.ts'
import cc from './sidebar-chamber.module.css'

/** Connection-status visual kind: dot colors plus the connecting spinner. */
type SourceStatusKind = 'ok' | 'busy' | 'err' | 'idle'

/**
 * Non-interactive active-Schedule marker (2026-09-11 upstream-alignment T7).
 *
 * Mirrors the official `ActiveScheduleIndicator` verbatim (vendor ui-workspace
 * Rows.tsx:284-296): a `role="img"` span carrying the localized
 * `schedule.active` copy as both its accessible name and its native title,
 * wrapping the 16px alarm-clock glyph — the enclosing row stays the only
 * action. Upstream keeps that component module-local (it is NOT exported from
 * the vendor package), so this is a markup/token mirror of it, not a second
 * behaviour: it renders only where the fact says so
 * (`ChamberServerWorkspace.sessions[].hasActiveSchedule`, projected from the
 * session's `schedule` projection — see `hasActiveScheduleOf`).
 * @param props.label - the localized `schedule.active` copy.
 * @returns the marker element.
 */
function SessionScheduleIndicator({ label }: { label: string }) {
  return (
    <span className={cc.scheduleIndicator} role="img" aria-label={label} title={label}>
      <IconAlarmClockOutline16 size={16} />
    </span>
  )
}

/**
 * Rebuild an InstanceSnapshot-shaped view of ONE source aggregate for the
 * LOCAL search matcher (06 §1.2 render-side merge). The render layer only
 * has the ChamberServerAggregate projection — no raw InstanceSnapshot, no
 * archivedSessionIds — so the snapshot is rebuilt from the VISIBLE rows:
 * every projected session is already post-filter (subagent-origin /
 * archived / blank-non-current rows never enter the projection), therefore
 * the archived filter gets the EMPTY set (nothing archived can be matched
 * here). Wire paths/createdAt are absent from the projection and irrelevant
 * to title/workspace-label substring matching — empty strings.
 */
function projectionToLocalSearchSnapshot(server: ChamberServerAggregate): InstanceSnapshot {
  return {
    workspaces: server.workspaces.map(workspace => ({
      workspaceId: workspace.id,
      path: '',
      title: workspace.title,
      sessionIds: workspace.sessions.map(session => session.id),
      createdAt: '',
      updatedAt: '',
    })),
    sessions: server.workspaces.flatMap(workspace => workspace.sessions.map(session => ({
      sessionId: session.id,
      running: session.running === true,
      blank: session.blank === true,
      ...(session.updatedAt === undefined ? {} : { updatedAt: session.updatedAt }),
      ...(session.title === '' ? {} : { title: session.title }),
      // The label is what search matches on, so the resolved display title
      // rides the local snapshot (I3): a directory-named row is searchable by
      // the name the user actually sees.
      displayTitle: session.displayTitle,
    }))),
    archivedSessionIds: [],
  }
}

/**
 * Map the projected phase (local /health status; remote tunnel phase) to a
 * visual kind: ready → green dot; connecting/starting/restarting/degraded →
 * spinner (the reconnect cycle folds into ONE stable "trying" state — the
 * main surface must never flicker between spinner and dot on every retry
 * attempt); error/stopped/restart-exhausted → red dot; the pre-first-poll
 * placeholders (idle/unknown) → gray dot. The text itself is never
 * rendered — hover carries it (tooltip + aria-label).
 */
function sourceStatusKind(server: ChamberServerAggregate): SourceStatusKind {
  const phase = server.phase
  if (phase === 'ready') return 'ok'
  if (phase === 'connecting' || phase === 'starting' || phase === 'restarting' || phase === 'degraded') return 'busy'
  if (phase === 'error' || phase === 'stopped' || phase === 'restart-exhausted') return 'err'
  return 'idle'
}


/**
 * Header title/aria text: the managed-down reason replaces "switch to this
 * instance". Exported for the collapsed rail (2026-09-11 upstream-alignment
 * T7): its per-source dot buttons are operable controls now and must carry the
 * SAME activation contract as the wide header — one definition, no rail copy
 * that can drift.
 */
export function sourceHeaderTitle(
  server: ChamberServerAggregate,
  chamberInstanceId: string | undefined,
  t: (key: SidebarKey, params?: Record<string, string | number>) => string,
): string | undefined {
  if (server.id === chamberInstanceId) return undefined
  if (server.managedRuntimeDown === true) {
    return t('source.managedDown', { state: t(sourceStatusLabelKey(server)) })
  }
  // 瞬态托管态同样不可激活：title 不能还宣称"切换到该实例"（2026-12 复查 MINOR）。
  if (server.kind === 'gateway' && (server.phase === 'starting' || server.phase === 'restarting')) {
    return t('source.managedStarting', { state: t(sourceStatusLabelKey(server)) })
  }
  return t('list.activate')
}

/** Whether a source header is an activation affordance (not self, not
 *  managed-down). Exported beside {@link sourceHeaderTitle} for the rail's
 *  named source buttons (2026-09-11 upstream-alignment T7). */
export function sourceHeaderActivatable(server: ChamberServerAggregate, chamberInstanceId: string | undefined): boolean {
  // 终态停机与瞬态 starting/restarting 都不可激活：两者的壳 boot 必然 503
  // （App 侧同样按 managedRuntimeUnusable 拒绝预热/收割），头部不应承诺切换。
  const managedUnusable = server.managedRuntimeDown === true
    || (server.kind === 'gateway'
      // Shared constant, not a second literal set (2026-09 audit): the
      // transient states live in managed-runtime.ts, and a set that grows
      // there must reach this header without a second edit.
      && (MANAGED_RUNTIME_TRANSIENT_STATES as readonly string[]).includes(server.phase))
  return server.id !== chamberInstanceId && !managedUnusable
}

/** Localized status-label key for a projected phase (tooltip/aria only). */
function sourceStatusLabelKey(server: ChamberServerAggregate): SidebarKey {
  const phase = server.phase
  if (phase === 'ready') return 'status.ready'
  if (phase === 'connecting') return 'status.connecting'
  if (phase === 'starting') return 'status.starting'
  if (phase === 'restarting') return 'status.restarting'
  if (phase === 'degraded') return 'status.reconnecting'
  if (phase === 'error') return 'status.error'
  if (phase === 'stopped') return 'status.stopped'
  if (phase === 'restart-exhausted') return 'status.restartExhausted'
  if (phase === 'idle') return 'status.idle'
  return 'status.unknown'
}

/**
 * Pointer-position half of a row (insert line above or below). Must only be
 * called synchronously inside a handler: React nulls `currentTarget` on a
 * synthetic event as soon as dispatch returns, so reading it from a setState
 * updater (executed on a later render) crashes.
 */
function rowHalf(event: { clientY: number; currentTarget: HTMLElement | null }): 'before' | 'after' {
  // A detached row (unmounted mid-drag re-render) has no geometry — treat
  // the pointer as being past it, never as a before-boundary (defensive).
  if (event.currentTarget === null) return 'after'
  const rect = event.currentTarget.getBoundingClientRect()
  // A zero-height row (mid-drag re-render edge) has no halves — treat the
  // pointer as being past it, never as a before-boundary (defensive).
  if (rect.height <= 0) return 'after'
  return event.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
}

export function ServerSection({ server }: { server: ChamberServerAggregate }) {
  const {
    wide,
    t,
    chamberInstanceId,
    renderWorkspaceGit,
    viewPrefs,
    toggleWorkspaceFold,
    toggleSourceFold,
    setOrderBy,
    sessionOrderOverride,
    workspaceOrderOverride,
    sessionDrag,
    setSessionDrag,
    workspaceDrag,
    setWorkspaceDrag,
    serverDrag,
    setServerDrag,
    commitSessionDrag,
    commitWorkspaceDrag,
    commitServerDrag,
    suppressClickRef,
    dragPressOnButtonRef,
    sessionDropCommitted,
    workspaceDropCommitted,
    serverDropCommitted,
    ghostExpiry,
    armBlankGhostForClick,
    rowErrors,
    menuOpen,
    toggleMenu,
    closeMenu,
    sortMenuOpen,
    setSortMenuOpen,
    renaming,
    setRenaming,
    commitRename,
    onOpenArchiveCleanup,
    // 2026-09-11 review-fix finding 2 (symmetric closure): the GUARDED
    // add-workspace opener — the shell refuses it while another chamber dialog
    // layer is up, so this section can never stack a second Modal.
    openWorkspaceBrowser,
    openSession,
    onNewSession,
    onArchiveSession,
    onForkSession,
    onDeleteWorkspace,
  } = useSidebarSection()

  // chamber (06 §1.2): per-source search state (capsule/query/results) AND
  // the debounced fetch jobs live in ONE shared controller
  // (shared/search-state.ts) — a search survives view switches (the visible
  // sidebar changes shell, the shared state does not), and a single owner
  // arms the jobs, so shells never duplicate fetches. This section only
  // mirrors the state for rendering and owns the DOM refs (capsule root /
  // input / button for outside-click containment + focus).
  const [searchState, setSearchState] = useState<ReadonlyMap<string, SourceSearchState>>(() => getSearchStates())
  useEffect(() => subscribeSearch(() => { setSearchState(getSearchStates()) }), [])
  const searchRoot = useRef<HTMLDivElement | null>(null)
  const searchInput = useRef<HTMLInputElement | null>(null)
  /** 用户展开搜索时把焦点送进输入框（必须在胶囊挂载后，见下方 effect）。 */
  const focusSearchOnMount = useRef(false)
  // 断连导致搜索胶囊卸载时的焦点落点（见下方 focus-restore）。
  const foldToggleRef = useRef<HTMLButtonElement | null>(null)
  const prevSearchCapsuleMounted = useRef(false)
  /** 上一轮渲染时焦点是否在搜索胶囊内（卸载后 activeElement 会回落，必须提前记）。 */
  const capsuleHeldFocus = useRef(false)
  const searchButton = useRef<HTMLButtonElement | null>(null)

  // chamber (2026 性能整改 B2)：会话行渲染窗口的"已展开"标记——每工作区一
  // 个本地浏览态布尔（不持久化、不跨 ctx 同步；窗口只在渲染层，见
  // shared/session-row-window.ts）。
  const [sessionRowsExpanded, setSessionRowsExpanded] = useState<Record<string, boolean>>({})

  // Outside-click closes an expanded capsule only while its query is empty
  // (official semantics): a non-empty query must not silently drop the
  // in-progress filter. The search button itself is outside the capsule root
  // (it lives in the source header), so it is containment-checked too —
  // otherwise a click on it would expand and immediately re-collapse.
  useEffect(() => {
    if (!wide) return
    const onClick = (event: MouseEvent): void => {
      if (!(event.target instanceof Node)) return
      const state = searchState.get(server.id)
      if (state === undefined || state.expanded !== true) return
      const root = searchRoot.current
      if (root !== null && root.contains(event.target)) return
      const button = searchButton.current
      if (button !== null && button.contains(event.target)) return
      if (sanitizeSearchQuery(state.query) !== '') return
      collapseSearch(server.id)
    }
    document.addEventListener('click', onClick)
    return () => { document.removeEventListener('click', onClick) }
  }, [wide, server.id, searchState])

  /** chamber (06): localized hover-card relative time ("刚刚"/"5分钟前" zh; "now"/"5min ago" en). */
  const hoverTimeLabel = (updatedAt: number, now: number): string => {
    const { unit, n } = relativeTimeBucket(updatedAt, now)
    return unit === 'now' ? t('time.now') : t('time.ago', { t: t(`time.${unit}`, { n }) })
  }

  // The rename edit UI, rendered in place at the renamed entity:
  // 'sessionRow' swaps a session row's slot (row replaced by the form,
  // indented at the session level); 'workspaceHeader' embeds the form
  // INSIDE the workspace header row where the title/orphan-badge/count/git
  // occupant/hover actions used to sit (行内编辑 — no extra list row
  // appears; the header keeps its fold toggle/gutter). Enter commits;
  // Escape cancels from anywhere inside the form; 取消 always cancels.
  const renameForm = (placeholder: string, mode: 'sessionRow' | 'workspaceHeader') => (
    <form
      className={clsx(
        cc.inlineForm,
        mode === 'sessionRow' && cc.sessionNested,
        mode === 'workspaceHeader' && cc.workspaceInlineForm,
      )}
      onClick={(event) => {
        // stopPropagation also stops the native event, so the document-level
        // pending-click canceller never sees this click — every
        // propagation-stopping control clears the pending itself
        // (pending-click.ts INVARIANT).
        event.stopPropagation()
        clearPendingClick()
      }}
      onSubmit={(event) => { event.preventDefault(); commitRename() }}
      // Escape cancels wherever the focus sits inside the form (input, or
      // the save/cancel buttons) — not only while the input is focused.
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        setRenaming(null)
      }}
    >
      <input
        className={cc.inlineInput}
        autoFocus
        // The treeitem label (title span) is swapped out while editing, so
        // the input itself carries the rename action as its accessible name
        // (both the session-row and the workspace-header form share this).
        aria-label={t('action.rename')}
        placeholder={placeholder}
        value={renaming?.value ?? ''}
        onChange={(event) => setRenaming((prev) => prev === null ? prev : { ...prev, value: event.target.value })}
      />
      <button type="submit" className={cc.actionButton}>{t('action.save')}</button>
      <button type="button" className={cc.actionButton} onClick={() => setRenaming(null)}>{t('action.cancel')}</button>
    </form>
  )

  // chamber (06 §4.3/§4.5): per-row STATE indicator — the leading slot is NOT
  // a server-identity marker (the source header dot owns identity). Normal
  // sessions show nothing; running sessions show the official StateDot
  // ongoing RING; completed-but-unread sessions show the official StateDot
  // `done` DOT (2026-09-11 upstream-alignment T10 — the bespoke 6px brand dot
  // is gone).
  // Pending interactions (approval / plan-review / question) render a
  // distinguishable 14px icon badge INSTEAD of the running ring — a session
  // waiting for the user must be recognizable at a glance. The caller wraps
  // the result in the fixed 10px slot so titles stay aligned (pending rows
  // widen the slot to 14px). Priority (both functions below): pending >
  // runningSubagents > completed > running. A parent's own running bit goes
  // false the moment its round returns even while BACKGROUND subagents still
  // work (official sessionStatuses: runningSubagentCount outranks completed),
  // so `runningSubagents` (live channel) must outrank the completed dot and
  // the running ring; both reports derive from the same sessions store and
  // can land one commit apart, and the fixed priority keeps that transient
  // skew from hiding a user-relevant state.
  const sessionStateLabel = (server: ChamberServerAggregate, session: { id: string; running?: boolean }): string | undefined => {
    const facts = server.runtime?.sessions[session.id]
    const pending = facts?.pending
    if (pending !== undefined) {
      return pending === 'approval' ? t('status.waitingApproval')
        : pending === 'plan-review' ? t('status.planReview')
        : t('status.waitingAnswer')
    }
    const runningSubagents = facts?.runningSubagents ?? 0
    if (runningSubagents > 0) {
      return t(runningSubagents === 1 ? 'status.subagentsRunning.one' : 'status.subagentsRunning.other', { n: runningSubagents })
    }
    if (facts?.completed === true) return t('status.completed')
    // 运行环只信完整聚合 snapshot 的 running 字段；runtime facts 不参与
    // OR/优先级合并，避免同一渲染事实出现双权威。已挂载来源的 snapshot 由
    // ctx store 在 host-frame 事件上即时上报，未挂载来源走 30s unary 兜底。
    const running = runningRingVisible(facts?.running, session.running)
    if (running === true) return t('status.running')
    return undefined
  }
  /** Pending-interaction kind of the row, or undefined when not pending. */
  const sessionStatePending = (server: ChamberServerAggregate, session: { id: string }): 'approval' | 'plan-review' | 'question' | undefined =>
    server.runtime?.sessions[session.id]?.pending
  const sessionStateDot = (server: ChamberServerAggregate, session: { id: string; running?: boolean }): ReactNode => {
    const facts = server.runtime?.sessions[session.id]
    const pending = facts?.pending
    const runningSubagents = facts?.runningSubagents ?? 0
    // 运行环只信完整 snapshot（runningRingVisible，见 sessionStateLabel）。
    const running = runningRingVisible(facts?.running, session.running)
    if (pending === undefined && runningSubagents === 0 && facts?.completed !== true && running !== true) return null
    if (pending === 'approval') {
      return <IconWarningOutline16 className={cc.statePendingApproval} />
    }
    if (pending === 'plan-review') {
      return <IconChecklistOutline14 className={cc.statePendingPlan} />
    }
    if (pending === 'question') {
      return <IconQuestionOutline14 className={cc.statePendingQuestion} />
    }
    if (runningSubagents > 0) {
      // 后台子 agent 存活：父回合虽已结束，会话仍处工作中（官方语义——
      // 子 agent 计数压过父 completed），绝不让蓝色完成点在此阶段亮起。
      return <StateDot state="ongoing" size={10} />
    }
    if (facts?.completed === true) {
      // 2026-09-11 upstream-alignment T10: completed rides the OFFICIAL
      // StateDot `done` tone (green, --dsw-alias-state-success-primary,
      // vendor ui-primitives StateDot.module.css .dot[data-state='done']) —
      // the hand-drawn 6px brand dot this used to paint was a chamber
      // invention that read as a second "ongoing" mark.
      return <StateDot state="done" size={10} />
    }
    return <StateDot state="ongoing" size={10} />
  }

  // chamber (06): hover-card relative times share one render-time clock.
  const now = Date.now()
  // 2026-12（复查 MAJOR-2/BLOCKER）：头部是否为可激活入口，以及其
  // title/aria 文案（托管 dsh 停机时改为说明原因，而不是"切换到该实例"）。
  const headerActivatable = sourceHeaderActivatable(server, chamberInstanceId)
  const headerTitle = sourceHeaderTitle(server, chamberInstanceId, t)
  // 2026-09-11 upstream-alignment T7: the source-header controls carry the
  // OFFICIAL Tooltip instead of the borrowed native title= (upstream wraps
  // the same ViewOptionsMenu trigger in `<Tooltip side="bottom" delayMs={500}>`,
  // vendor ui-workspace WorkspaceBrowser.tsx:198-203). The sort trigger names
  // the active mode, so the bubble and the accessible name carry it.
  const sortModeKey: SidebarKey = viewPrefs.orderBy?.[server.id] === 'updated' ? 'orderBy.updated' : 'orderBy.manual'
  const sortLabel = `${t('action.sort')} · ${t(sortModeKey)}`
  // 来源级"数据不可信"说明：单一定居 live region（见下方 sourceNote 的渲染与
  // CSS :empty）。两条说明互斥（managedDown ⇒ connected=false），所以一个区域
  // 足够；内容变化时既有的 live region 才可被 AT 播报（"插入即带内容"不会播报，
  // 2026-12 复查 MINOR）。
  // 托管瞬态：必须**按 kind 限定**——本地 /health 的词表同样含 starting/
  // restarting（2026-12 复查 MAJOR），只判 phase 会给本地源挂上网关专属文案。
  const managedTransient = server.kind === 'gateway'
    && (server.phase === 'starting' || server.phase === 'restarting')
  const sourceNote = server.managedRuntimeDown === true
    ? t('source.managedDown', { state: t(sourceStatusLabelKey(server)) })
    : managedTransient
      // 托管 dsh 正在启动：此刻 connected=false 会隐藏整棵会话子树，必须说明，
      // 否则重启网关时侧栏整组凭空消失（2026-12 复查 MINOR）。
      ? t('source.managedStarting', { state: t(sourceStatusLabelKey(server)) })
      : server.connected && server.aggregateReady === true && server.archiveSetKnown !== true
        ? t('source.baselinePending')
        : ''
  // 说明行是否携带了状态词（决定状态点要不要让出 live region 角色）。任何说明行
  // 在场时点都让位：一个来源只应有一个 live region（2026-12 复查 NIT）。
  const noteCarriesPhase = sourceNote !== ''
  // 每个已挂载壳各有一份侧栏 DOM（同一来源会出现多份）：id 必须按壳限定，
  // 否则 aria-describedby 可能解析到另一份（隐藏壳）的同名节点。
  const sourceNoteId = `chamber-source-note-${chamberInstanceId ?? 'unknown'}-${server.id}`

              // chamber (06 §1.2): the state's query is the sanitized current
              // value by construction; the loading fallback covers the
              // expand-without-query render pass defensively.
              const search = searchState.get(server.id)
              const query = sanitizeSearchQuery(search?.query ?? '')
              // 搜索胶囊的挂载条件含 `server.connected`：托管 dsh 停机时胶囊会被
              // 卸载，焦点随之掉到 body（键盘用户迷路）。这里把焦点交还给折叠
              // 按钮——该头部唯一恒在的键盘入口（2026-12 复查 MINOR）。
              const searchCapsuleMounted = server.connected
                && viewPrefs.sourceFolded?.[server.id] !== true
                && search?.expanded === true
              // 展开后聚焦输入框：挂载前 ref 为空，只能等这一轮提交后再聚焦
              // （2026-12 复查 MINOR）。
              if (searchCapsuleMounted && focusSearchOnMount.current) {
                focusSearchOnMount.current = false
                queueMicrotask(() => searchInput.current?.focus())
              }
              useEffect(() => {
                // 仅当焦点确实落在胶囊里才回交给折叠按钮：任何断连都不该把用户
                // 从别处（会话行等）抢回头部（2026-12 复查 MINOR）。判定必须发生
                // 在卸载之后，此时 activeElement 已回落到 body——所以用卸载前
                // 记录的"胶囊是否持有焦点"。
                // 断连会让搜索状态在同一批里被清掉（search-state 只保留已连接来源），
                // 所以判定条件必须是"连接事实"而不是 expanded（2026-12 复查 MINOR）；
                // 折叠路径 connected 仍为 true，不会误抢焦点。
                if (prevSearchCapsuleMounted.current && !searchCapsuleMounted
                  && capsuleHeldFocus.current && server.connected !== true) {
                  foldToggleRef.current?.focus()
                }
                prevSearchCapsuleMounted.current = searchCapsuleMounted
                if (searchCapsuleMounted) capsuleHeldFocus.current = false
              }, [searchCapsuleMounted, server.connected])
              const currentRemote = search !== undefined && search.query === query
                ? search
                : { query, status: 'loading' as const, items: [] as SearchRow[], hasMore: false }
              // chamber (06 §1.2 render-side merge): merge the source
              // aggregate's LOCAL metadata matches (title/workspace-label
              // substring over the visible projection) with the remote
              // content-search page — the official deriveSearchResults port.
              // 远程腿按可见集过滤——投影已过滤 subagent/archived/
              // blank-non-current，"在投影里"即"可见"（官方对 content 腿逐条
              // sessionVisible，tree.ts L370-373）；空集（断连/未就绪）时
              // mergeSearchResults 降级为不过滤。
              const visibleIds = new Set<string>()
              for (const workspace of server.workspaces) {
                for (const session of workspace.sessions) visibleIds.add(session.id)
              }
              const merged = mergeSearchResults(
                deriveLocalSearchMatches(projectionToLocalSearchSnapshot(server), query),
                currentRemote,
                SESSION_SEARCH_RESULT_LIMIT,
                visibleIds,
                server.aggregateReady === true,
              )
              // chamber (06 §4): the current-session highlight is channel-based
              // — no direct store subscription — and single-selection: only the
              // source owning THIS visible ctx (the active view's shell) renders
              // its current-session highlight; the other sources' last-opened
              // sessions stay unhighlighted (one global selection marker).
              const currentId = server.id === chamberInstanceId ? server.runtime?.current : undefined
              // chamber (06 §2.4): server-level
              // fold — hides the ENTIRE workspace list below the header. The
              // per-workspace conversation folds are NOT touched (see
              // toggleSourceFold), so expanding restores every workspace with
              // its sessions as they were.
              const sourceFolded = viewPrefs.sourceFolded?.[server.id] === true
              // chamber (打开失败可见性): this server's open-failure rows
              // currently held by the outcome channel (SidebarRoot writes
              // rowErrors under shared/open-outcome.ts keys). Both key ends
              // are anchored literals (`${server.id}/session/` … '/open'), so
              // the slice recovers any embedded session id verbatim; the
              // rename/archive/fork family shares the prefix but ends in its
              // own suffix, and no other key family ends in '/open'.
              const serverOpenFailures: { sessionId: string; message: string }[] = []
              const openErrorPrefix = `${server.id}/session/`
              for (const [key, message] of Object.entries(rowErrors)) {
                if (!key.startsWith(openErrorPrefix) || !key.endsWith('/open')) continue
                serverOpenFailures.push({
                  sessionId: key.slice(openErrorPrefix.length, key.length - '/open'.length),
                  message,
                })
              }
              // chamber: the row-render ghost predicate is hoisted so the
              // workspace header count reuses the SAME rule — a ghost is a
              // blank "New Session" row that stopped being current (the
              // projection still carries it as an invisible layout slot
              // during BLANK_GHOST_GRACE_MS, see derive.ts
              // armBlankGhost/sessionVisible); the count must not drift from
              // what the rows render.
              const isGhostSession = (session: ChamberServerWorkspace['sessions'][number]): boolean =>
                session.blank === true && session.id !== currentId
              // chamber (06 §2.2): real workspaces render in wire order unless
              // a transient drag override exists; the ungrouped bucket trails.
              const orderedWorkspaces = (() => {
                const real = server.workspaces.filter(workspace => workspace.ungrouped !== true)
                const ungrouped = server.workspaces.find(workspace => workspace.ungrouped === true)
                const override = workspaceOrderOverride[server.id]
                let ordered: ChamberServerWorkspace[] = real
                if (override !== undefined) {
                  const byId = new Map(real.map(workspace => [workspace.id, workspace]))
                  const placed = new Set<string>()
                  const next: ChamberServerWorkspace[] = []
                  for (const id of override) {
                    const workspace = byId.get(id)
                    if (workspace === undefined || placed.has(id)) continue
                    next.push(workspace)
                    placed.add(id)
                  }
                  for (const workspace of real) {
                    if (placed.has(workspace.id)) continue
                    next.push(workspace)
                  }
                  ordered = next
                }
                return ungrouped === undefined ? ordered : [...ordered, ungrouped]
              })()
              // The first insertion boundary of the workspace list draws a
              // top indicator while the marker on the first real group is
              // suppressed (official list-top drop treatment). The boundary
              // is the first VISIBLE row of the DISPLAY order (override-aware
              // and fold-aware — synthetic cwd-derived groups are never drop
              // targets, so they never qualify either).
              const realWorkspaceIds = server.workspaces
                .filter(workspace => workspace.ungrouped !== true && workspace.synthetic !== true)
                .map(workspace => workspace.id)
              const dropEnv = workspaceDropEnv(server.id, realWorkspaceIds, workspaceOrderOverride[server.id], viewPrefs.folded)
              const firstDropRow = dropEnv.order.find(id => !dropEnv.hidden(id))
              const workspaceDropAtListStart = firstDropRow !== undefined
                && workspaceDrag !== null
                && workspaceDrag.sourceId === server.id
                && workspaceDrag.over !== null
                && workspaceDrag.over.id === firstDropRow
                && workspaceDrag.over.half === 'before'
              // The drop resolver (shared/workspace-drag-order.ts) is the
              // single authority for every surface — the marker below, the
              // onDragOver gate, the top indicator and the commit all ask
              // the same verdict: blocked positions (a drop that would split
              // a contiguous repo family, design 08 §3.3) never render a
              // marker and never become the target.
              const workspaceDropBlocked = (targetId: string, half: 'before' | 'after'): boolean => {
                if (workspaceDrag === null || workspaceDrag.sourceId !== server.id) return false
                const verdict = resolveWorkspaceDrop(dropEnv, workspaceDrag.workspaceId, { id: targetId, half })
                return verdict.kind === 'blocked'
              }
              const workspaceDragMarker = (workspace: ChamberServerWorkspace): 'before' | 'after' | null => {
                if (workspace.ungrouped === true || workspace.synthetic === true || workspaceDrag === null
                  || workspaceDrag.sourceId !== server.id || workspaceDrag.over === null) return null
                if (workspaceDrag.over.id !== workspace.id) return null
                if (workspaceDropAtListStart && workspace.id === firstDropRow) return null
                if (workspaceDropBlocked(workspace.id, workspaceDrag.over.half)) return null
                return workspaceDrag.over.half
              }
              const sessionsOf = (workspace: ChamberServerWorkspace): ChamberServerWorkspace['sessions'] => {
                const wire = workspace.sessions
                const orderBy = viewPrefs.orderBy?.[server.id] ?? 'manual'
                // updated = 手动序 + 活动置顶。渲染序
                // 直接取共享的 updated-order account（推导 effect 已把 seeding/
                // recency sort/promotion 写回，见上）；account 尚不存在时（切换
                // 后首帧、effect 尚未落盘）回退 wire 序。**重入 updated**（account
                // 已保留、簿记刚被清）时首帧渲染保留的旧 account 序，effect 的
                // 整列 recency 排序下一帧才落——与官方同构（render-then-sort），
                // 菜单关闭动画内不可感知。manual 模式：未分组桶用存储序，
                // 真实工作区 override（拖拽乐观序）优先于 wire 序。
                if (orderBy === 'updated') {
                  const stored = viewPrefs.updatedOrder?.[`${server.id}/${workspace.id}`]
                  if (stored === undefined) return wire
                  const byId = new Map(wire.map(session => [session.id, session]))
                  return reconciledSessionOrder(stored, wire.map(session => session.id)).flatMap(id => {
                    const session = byId.get(id)
                    return session === undefined ? [] : [session]
                  })
                }
                if (workspace.ungrouped === true) {
                  return orderUngroupedSessions(wire, viewPrefs.ungroupedOrder[server.id])
                }
                const override = sessionOrderOverride[`${server.id}/${workspace.id}`]
                if (override !== undefined) {
                  const byId = new Map(wire.map(session => [session.id, session]))
                  return override.flatMap(id => { const session = byId.get(id); return session === undefined ? [] : [session] })
                }
                return wire
              }
              // Search-result labels resolve from the source aggregate (title
              // may lag the latest snapshot by one poll — accepted, 06 §1.2).
              // The official display label (I3), not the durable title: a hit
              // whose title the host could not read renders the directory name.
              const searchRowLabel = (sessionId: string): { title: string; workspaceLabel: string | undefined } => {
                for (const workspace of server.workspaces) {
                  const session = workspace.sessions.find(candidate => candidate.id === sessionId)
                  if (session === undefined) continue
                  return {
                    title: session.displayTitle,
                    workspaceLabel: workspace.ungrouped === true ? t('list.ungrouped') : workspace.title,
                  }
                }
                // Defensive: a hit outside every projected row still has an
                // honest label — the official ladder's last resort (id).
                return { title: sessionId, workspaceLabel: undefined }
              }
              // 搜索结果行的 running 位来自投影（mergeSearchResults
              // 的 visibleIds 过滤保证命中行一定在投影内，查得到即用投影位；查
              // 不到——防御——回落 false）。通道 running 不参与渲染（运行环
              // wire 权威,见 sessionStateLabel 注释）——sessionStateDot/Label
              // 直接使用此投影位。
              const projectedRunning = (sessionId: string): boolean => {
                for (const workspace of server.workspaces) {
                  const session = workspace.sessions.find(candidate => candidate.id === sessionId)
                  if (session === undefined) continue
                  return session.running === true
                }
                return false
              }
              // 2026-09-11 upstream-alignment T7: the same projection lookup for
              // the active-Schedule fact — upstream's search row renders the
              // marker too (vendor ui-workspace Rows.tsx:351). Not found ⇒
              // false (defensive: a hit outside the visible projection is not a
              // claim about that session's schedules).
              const projectedHasActiveSchedule = (sessionId: string): boolean => {
                for (const workspace of server.workspaces) {
                  const session = workspace.sessions.find(candidate => candidate.id === sessionId)
                  if (session === undefined) continue
                  return session.hasActiveSchedule === true
                }
                return false
              }
              return (
              <section
                key={server.id}
                className={clsx(
                  cc.sourceGroup,
                  // chamber (06 §2.4): the
                  // server-group drag marker lives on the SECTION boundary
                  // (before = above the header, after = below the whole
                  // group) — mirroring the workspace-group marker.
                  serverDrag !== null && serverDrag.over?.id === server.id && serverDrag.over.half === 'before' && cc.dropBefore,
                  serverDrag !== null && serverDrag.over?.id === server.id && serverDrag.over.half === 'after' && cc.dropAfter,
                )}
                role="group"
                aria-label={server.label}
                // Identifies a source SECTION for the
                // server-drag outside-list cancel (document dragover scope
                // check) — any descendant counts as "inside the list".
                data-chamber-section={server.id}
                // The fold state's a11y surface is the fold BUTTON's own
                // aria-expanded (the group carries no expand semantics — a
                // focusable button is the operable, announced control).
                onDragOver={serverDrag === null
                  ? undefined
                  : (event) => {
                    event.preventDefault()
                    event.dataTransfer.dropEffect = 'move'
                    const half = rowHalf(event)
                    setServerDrag(current => {
                      if (current === null) return current
                      if (current.over?.id === server.id && current.over.half === half) return current
                      return { ...current, over: { id: server.id, half } }
                    })
                  }}
                onDrop={serverDrag === null
                  ? undefined
                  : (event) => {
                    event.preventDefault()
                    if (serverDrag === null) return
                    commitServerDrag(serverDrag, { id: server.id, half: rowHalf(event) })
                  }}
              >
                <header
                  className={clsx(
                    cc.sourceHeader,
                    server.id === chamberInstanceId && cc.sourceActive,
                    headerActivatable && cc.sourceHeaderClickable,
                  )}
                  data-chamber-row={server.id}
                  style={sourceAccentStyle(server)}
                  title={headerTitle}
                  role={headerActivatable ? 'button' : undefined}
                  tabIndex={headerActivatable ? 0 : undefined}
                  // 非交互形态（托管停机）不给 generic 角色加 aria-label（命名对
                  // generic 无效，2026-12 复查 MINOR）——改用 aria-describedby
                  // 指向下方说明行。
                  aria-label={headerActivatable ? headerTitle : undefined}
                  aria-describedby={!headerActivatable && sourceNote !== '' ? sourceNoteId : undefined}
                  // chamber (06 §2.4 — option
                  // 1): the source header is the drag handle for the
                  // server-group display-order drag. The same trailing-click
                  // suppression as the workspace header: a drop ending over
                  // the header (or its buttons) must not fire a spurious
                  // activate/toggle/action.
                  draggable
                  onPointerDown={(event) => {
                    // Record whether the press started
                    // on a header BUTTON. dragstart's target is the drag
                    // SOURCE (the header itself), not the pressed element, so
                    // the press target must be captured here, at pointerdown.
                    dragPressOnButtonRef.current = event.target instanceof Element && event.target.closest('button') !== null
                  }}
                  onDragStart={(event) => {
                    // A gesture that STARTED on a header
                    // button (fold / sort / add-workspace / search /
                    // archive-cleanup manager) aborts the
                    // drag initiation — buttons are click affordances, a >4px
                    // micro-drag on the fold toggle must not swallow its click
                    // (the click then fires normally on release). Dragging
                    // from the header's non-button area is unaffected.
                    if (dragPressOnButtonRef.current) {
                      dragPressOnButtonRef.current = false
                      event.preventDefault()
                      return
                    }
                    dragPressOnButtonRef.current = false
                    event.dataTransfer.effectAllowed = 'move'
                    event.dataTransfer.setData('text/plain', server.id)
                    suppressClickRef.current = true
                    serverDropCommitted.current = false
                    setServerDrag({ sourceId: server.id, over: null })
                  }}
                  onDragEnd={(event) => {
                    // An ESC-cancelled drag must not persist the last marker —
                    // dropEffect 'none' means the user explicitly cancelled.
                    // A NULL dataTransfer at dragend (Safari has done
                    // this) must also count as cancelled — with `?.` alone,
                    // undefined !== 'none' would wrongly commit. The section
                    // onDrop path is unaffected: a real drop commits there
                    // first, and the serverDropCommitted guard makes this
                    // no-op.
                    if (serverDrag !== null && serverDrag.over !== null
                      && event.dataTransfer !== null && event.dataTransfer.dropEffect !== 'none') {
                      commitServerDrag(serverDrag, serverDrag.over)
                    } else {
                      setServerDrag(null)
                    }
                    serverDropCommitted.current = false
                    window.setTimeout(() => { suppressClickRef.current = false }, 0)
                  }}
                  onClick={() => {
                    if (suppressClickRef.current) return
                    // A remote source's header switches the active N-ctx view
                    // without opening a session (App layer owns the switch).
                    // A managed-down gateway is NOT activatable: its boot is
                    // guaranteed to fail (gateway 503), so the header must not
                    // promise a switch the App itself refuses to prewarm/harvest
                    // (2026-12 review MAJOR-2). The inline note explains why.
                    if (headerActivatable) chamberBridge.requestActivateSource(server.id)
                  }}
                  onKeyDown={(event) => {
                    if (!headerActivatable) return
                    // Only respond to the header's OWN focus. A keydown
                    // bubbling from an inner button (fold toggle / sort /
                    // add-workspace / search) must not be swallowed:
                    // preventDefault here would cancel the button's native
                    // Enter/Space activation AND switch the active N-ctx
                    // view.
                    if (event.target !== event.currentTarget) return
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      chamberBridge.requestActivateSource(server.id)
                    }
                  }}
                >
                  {/* chamber (06 §2.4): the server-level fold
                      toggle — a MONITOR glyph at rest (server = machine, NOT
                      the workspace folder glyph — the shared folder reads as
                      a workspace and misleads), swapping to the collapse
                      chevron on header hover/focus (same slot, nothing
                      shifts). Clicking collapses/expands the source's ENTIRE
                      workspace list without touching any workspace's own
                      conversation fold state. stopPropagation keeps the
                      header's activate click (and the pending-click
                      discipline) out. */}
                  <button
                    ref={foldToggleRef}
                    type="button"
                    className={clsx(cc.sourceFoldToggle, sourceFolded && cc.sourceFoldToggleFolded)}
                    aria-label={sourceFolded ? t('server.expand') : t('server.collapse')}
                    aria-expanded={!sourceFolded}
                    // Own tooltip — without it the
                    // header's inherited title ("切换到该实例") would show on
                    // hover, semantically misleading for a fold toggle.
                    title={sourceFolded ? t('server.expand') : t('server.collapse')}
                    onClick={(event) => {
                      event.stopPropagation()
                      if (suppressClickRef.current) return
                      clearPendingClick()
                      toggleSourceFold(server.id)
                    }}
                  >
                    <IconChevronRightOutline14 size={15} className={cc.sourceFoldChevron} />
                    <IconMonitorOutline16 size={15} className={cc.sourceFoldGlyph} />
                  </button>
                  <span className={cc.sourceLabel}>{server.label}</span>
                  {/* chamber: the source-header plugin diagnostic marker was
                      REMOVED per user decision: the plugin runtime
                      diagnostic (states + plugin id + reason) is surfaced ONLY
                      on the connections page / per-instance plugin dialog
                      (design 09 §3.5 detail surface) — the sidebar never
                      renders an exclamation for plugin-graph conditions,
                      informational or abnormal. */}
                  {/* chamber: connection status as a dot/spinner — the phase
                      text is never rendered, only carried on hover/aria. */}
                  <span
                    className={cc.sourceStatus}
                    title={t(sourceStatusLabelKey(server))}
                    // 两个门要分开（2026-12 复查 MINOR）：live region 角色只要有说明行
                    // 就让位（一个来源一个 live region），但**状态词的承载**只有携带
                    // phase 的说明行才接管——baselinePending 不含 phase，点必须继续
                    // 通过 aria-label 承担它。
                    aria-label={noteCarriesPhase ? undefined : t(sourceStatusLabelKey(server))}
                    role={sourceNote === '' ? 'status' : undefined}
                  >
                    {sourceStatusKind(server) === 'busy' ? (
                      <IconLoadingOutline16 className={cc.statusSpinner} size={12} />
                    ) : (
                      <span
                        className={clsx(
                          cc.statusDot,
                          sourceStatusKind(server) === 'ok' && cc.statusOk,
                          sourceStatusKind(server) === 'err' && cc.statusErr,
                          sourceStatusKind(server) === 'idle' && cc.statusIdle,
                        )}
                      />
                    )}
                  </span>
                  {/* chamber: header actions (sort menu + add-workspace `+` +
                      per-source search + archive-cleanup manager — design 24 §6)
                      are hover-revealed like the session rows' actions: at rest the connection status occupies the
                      right side; hovering the header swaps in the icon cluster
                      (visibility swap, no reflow). While a search capsule is
                      open OR the sort menu is open the cluster stays visible
                      (.sourceActionsVisible) so the icon can collapse/close. */}
                  <span
                    className={clsx(
                      cc.sourceActions,
                      (search?.expanded === true || sortMenuOpen === server.id) && cc.sourceActionsVisible,
                    )}
                  >
                    {/* chamber (06 §3.1): per-source
                        session sort MENU (official ViewOptionsMenu pattern —
                        replaces the blind manual↔updated cycle). The menu
                        shows both options with a checkmark on the current one
                        (selectedIds), so the active order is visible the
                        moment it opens; the title + aria-label + sortActive
                        tint carry the current mode at rest (hover-revealed).
                        Selecting a mode goes through setOrderBy (switch
                        bookkeeping + override drop). */}
                    {server.connected && (server.aggregateError === undefined || search?.expanded === true) && (
                      <Menu
                        // 2026-09-11 upstream-alignment T12: the official
                        // primitive's `compact` typography is not what upstream
                        // ships here — its ViewOptionsMenu sets `dense`
                        // (WorkspaceBrowser.tsx:192-197) and its row menus set
                        // neither. Follow the ViewOptionsMenu form for this
                        // trigger.
                        dense
                        portal
                        align="end"
                        open={sortMenuOpen === server.id}
                        onClose={() => { setSortMenuOpen(null) }}
                        onSelect={(id: string) => {
                          setSortMenuOpen(null)
                          if (id === 'manual' || id === 'updated') setOrderBy(server, id)
                        }}
                        items={[
                          { type: 'label' as const, id: 'sort-label', text: t('orderBy.label') },
                          { id: 'manual', label: t('orderBy.manual') },
                          { id: 'updated', label: t('orderBy.updated') },
                        ]}
                        selectedIds={[viewPrefs.orderBy?.[server.id] ?? 'manual']}
                        anchor={(
                          <Tooltip label={sortLabel} side="bottom" delayMs={500}>
                            <button
                              type="button"
                              className={clsx(cc.actionIcon, viewPrefs.orderBy?.[server.id] === 'updated' && cc.sortActive)}
                              aria-label={sortLabel}
                              aria-haspopup="menu"
                              aria-expanded={sortMenuOpen === server.id}
                              onClick={(event) => {
                                event.stopPropagation()
                                if (suppressClickRef.current) return
                                // stopPropagation also stops the NATIVE event, so
                                // the document-level pending-click listener never
                                // sees this click — clear the pending here like
                                // every other row-internal button (else a pending
                                // survives and a later click on the same session
                                // spuriously renames).
                                clearPendingClick()
                                setSortMenuOpen(prev => (prev === server.id ? null : server.id))
                              }}
                            >
                              <IconPersonalizationOutline16 size={14} />
                            </button>
                          </Tooltip>
                        )}
                      />
                    )}
                    {server.connected && (server.aggregateError === undefined || search?.expanded === true) && (
                      <Tooltip label={t('action.addWorkspace')} side="bottom" delayMs={500}>
                        <button
                          type="button"
                          className={clsx(cc.actionIcon, cc.addWorkspace)}
                          aria-label={t('action.addWorkspace')}
                          onClick={(event) => {
                            event.stopPropagation()
                            if (suppressClickRef.current) return
                            clearPendingClick()
                            openWorkspaceBrowser(server.id)
                          }}
                        >
                          {/* chamber (design 05 §2.2): adding a WORKSPACE, not a
                              session — the official project-add glyph
                              (2026-09-11 upstream-alignment T7:
                              IconProjectAddOutline16, vendor ui-primitives
                              icons/index.tsx), not the generic `+`. */}
                          <IconProjectAddOutline16 size={14} />
                        </button>
                      </Tooltip>
                    )}
                    {server.connected && (server.aggregateError === undefined || search?.expanded === true) && (
                      <Tooltip label={t('search.sessions.aria')} side="bottom" delayMs={500}>
                        <button
                          type="button"
                          className={cc.searchButton}
                          aria-label={t('search.sessions.aria')}
                          aria-expanded={search?.expanded === true}
                          ref={searchButton}
                          onClick={(event) => {
                            event.stopPropagation()
                            if (suppressClickRef.current) return
                            clearPendingClick()
                            if (search?.expanded === true) {
                              // Toggle: an open capsule's icon collapses it (empty
                              // query) or just blurs the input (a non-empty query
                              // must not silently drop the in-progress filter).
                              if (query === '') {
                                collapseSearch(server.id)
                              } else {
                                searchInput.current?.blur()
                              }
                            } else {
                              expandSearch(server.id)
                              focusSearchOnMount.current = true
                            }
                          }}
                        >
                          <IconSearchOutline16 size={14} />
                        </button>
                      </Tooltip>
                    )}
                    {/* chamber (design 24 §6, revision 2026-09): server-row
                        "archive manager" — same hover-reveal discipline and
                        gating as the sibling actions; opens the manager
                        dialog (list + per-row / multi-select delete; whole-set
                        deletion only via explicit select-all — no standalone
                        delete-all). All cleanup state lives INSIDE the
                        dialog. */}
                    {server.connected && (server.aggregateError === undefined || search?.expanded === true) && (
                      <Tooltip label={t('action.purgeArchived')} side="bottom" delayMs={500}>
                        <button
                          type="button"
                          className={cc.actionIcon}
                          aria-label={t('action.purgeArchived')}
                          onClick={(event) => {
                            event.stopPropagation()
                            if (suppressClickRef.current) return
                            clearPendingClick()
                            onOpenArchiveCleanup(server)
                          }}
                        >
                          <IconTrashOutline16 size={14} />
                        </button>
                      </Tooltip>
                    )}
                  </span>
                </header>
                {/* 2026-12（诚实投影，用户视角复查 M1/M4）：两种"数据不可信"
                    状态就地说明——避免托管 dsh 停机时只剩"空面板 + 红点"，
                    以及把 unary 兜底的降级列表当真实列表读。状态词复用既有
                    `status.*` 文案，不引入新词。 */}
                <div id={sourceNoteId} className={cc.sourceNote} role="status" aria-live="polite">
                  {sourceNote}
                </div>
                {/* chamber (打开失败可见性): with the source folded no session
                    row exists on screen (the fold gate hides the whole list),
                    so open failures hoist under the header — the header is
                    the one part that stays rendered. */}
                {sourceFolded && serverOpenFailures.map(failure => (
                  <div key={failure.sessionId} className={cc.rowError} role="alert">{failure.message}</div>
                ))}
                {/* chamber (06 §2.4): the
                    server-level fold hides EVERYTHING below the header —
                    search capsule, source-scope git alert and the workspace
                    list (search results included). The search state itself is
                    untouched (shared search-state store): expanding the
                    server remounts the capsule with its query intact. */}
                {!sourceFolded && (
                <>
                {/* chamber (06 §1.2): the search capsule row beneath the header.
                    Escape clears and collapses; the clear button does the same. */}
                {/* 断连/托管停机的源不渲染搜索胶囊（2026-12 复查 MINOR）：结果
                    与状态分支本就被 connected 门挡住，留一个活输入框是键盘死路。 */}
                {server.connected && search?.expanded === true && (
                  <div
                    ref={searchRoot}
                    className={cc.searchCapsule}
                    // 焦点归属必须**事件驱动**记录：effect 只在依赖变化时跑，采样
                    // 到的 activeElement 早已回落（2026-12 复查 MINOR）。
                    onFocusCapture={() => { capsuleHeldFocus.current = true }}
                    onBlurCapture={() => { capsuleHeldFocus.current = false }}
                  >
                    <input
                      ref={searchInput}
                      className={cc.searchInput}
                      type="text"
                      maxLength={SEARCH_QUERY_MAX_CODE_UNITS}
                      placeholder={t('search.placeholder')}
                      value={search?.query ?? ''}
                      // 不用 autoFocus：胶囊会因断连/恢复而卸载重挂，autoFocus
                      // 会在恢复时抢走用户当前焦点；用户主动展开的那条路径已由
                      // 搜索按钮显式 focus()（2026-12 复查 MINOR）。
                      onChange={(event) => setSearchQuery(server.id, event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key !== 'Escape') return
                        clearSearch(server.id)
                      }}
                    />
                    <button
                      type="button"
                      className={cc.searchClear}
                      aria-label={t('search.clear')}
                      onClick={() => {
                        // 拖拽尾随 click 守卫——dragend 后的合成 click
                        // 落在清除钮上不得清掉在途搜索（守卫控件清单补齐）。
                        if (suppressClickRef.current) return
                        clearSearch(server.id)
                      }}
                    >
                      <IconCloseOutline16 size={12} />
                    </button>
                  </div>
                )}
                {server.connected ? (() => {
                  // chamber (08 §11 Plan A): per-repo layouts drive the
                  // unregistered-worktree blocks + the orphan badge.
                  const repoLayouts = getSourceRepoLayouts(server.id)
                  return (
                  <>
                  {/* chamber (08 §11): one source-level Git alert mount
                      (workspaceId '' = source scope), OUTSIDE the list tree
                      (a tree must not carry non-treeitem direct
                      children). The chamber Git plugin renders the source's
                      recovery/action errors here — visible even when no
                      workspace has git rows so the source can never silently
                      lock or lie. */}
                  {renderWorkspaceGit('sidebar.workspace.git', { wide }, {
                    hookContext: { sourceId: server.id, workspaceId: '' },
                  })}
                  {/* chamber (打开失败可见性): open failures whose session has
                      NO row in the current projection (e.g. a fork/commit/new-
                      session child that never surfaced while the runtime was
                      wedged) — the row slot cannot render them, so they
                      surface above the list, outside the tree (same
                      discipline as the git alert above). Known bound (F1
                      review, 非回归): a failure whose session IS in the
                      projection but whose only render anchor vanished — a
                      worktree group hidden behind a folded git MAIN workspace,
                      or an active search that no longer matches the session —
                      stays invisible for the 10s window (pre-F1 the inline
                      slot was suppressed identically). */}
                  {serverOpenFailures.filter(failure => !visibleIds.has(failure.sessionId)).map(failure => (
                    <div key={failure.sessionId} className={cc.rowError} role="alert">{failure.message}</div>
                  ))}
                  <div
                    className={cc.workspaceList}
                    // The browse list is one tree (official .list role="tree");
                    // an active query replaces it with the search-results tree
                    // (own role below), and the fetch-error branch renders no
                    // tree at all. 2026-09-11 upstream-alignment T7: the browse
                    // tree carries an accessible name like its search-results
                    // sibling — upstream names this tree with `section.sessions`
                    // (vendor ui-workspace WorkspaceBrowser.tsx:457-458).
                    role={query === '' && server.aggregateError === undefined ? 'tree' : undefined}
                    aria-label={query === '' && server.aggregateError === undefined ? t('section.sessions') : undefined}
                  >
                    {query !== '' ? (
                      // chamber (06 §1.2): an active query replaces the whole
                      // workspace list (header/status stay; fold and the
                      // add-workspace affordance are hidden while searching).
                      // The results branch outranks the snapshot-fetch error
                      // (06 §1.2): an open search keeps showing results even
                      // when a later pull fails — the aggregateError line
                      // renders BELOW the results, so a content-search
                      // failure still shows the local metadata hits, with the
                      // error banner below them.
                      <>
                        <div className={cc.searchResults} role="tree" aria-label={t('search.results.aria')}>
                          {merged.items.map((item) => {
                            const resolved = searchRowLabel(item.sessionId)
                            // 搜索行传投影 running 位（查不到回落
                            // false）；运行环 wire 权威——sessionStateDot/Label
                            // 直接使用此位,通道 running 不参与渲染（见
                            // sessionStateLabel 注释）。
                            const running = projectedRunning(item.sessionId)
                            const stateDot = sessionStateDot(server, { id: item.sessionId, running })
                            const stateLabel = sessionStateLabel(server, { id: item.sessionId, running })
                            const openError = rowErrors[openErrorKey(server.id, item.sessionId)]
                            return (
                              // chamber (打开失败可见性): the search tree replaces
                              // the workspace tree, so an open failure must also
                              // surface under the result row — Fragment keeps the
                              // button keyboard-activatable (official
                              // SearchResultItem 同款).
                              <Fragment key={item.sessionId}>
                                <button
                                  type="button"
                                  className={cc.searchResultRow}
                                  role="treeitem"
                                  aria-selected={item.sessionId === currentId}
                                  onClick={() => openSession(server.id, item.sessionId)}
                                >
                                  <span className={cc.searchResultHeading}>
                                    <span
                                      className={clsx(cc.sessionStateSlot, sessionStatePending(server, { id: item.sessionId }) !== undefined && cc.sessionStateSlotPending)}
                                      title={stateLabel}
                                      aria-label={stateLabel}
                                      // 空态不注册 live region（官方仅在有
                                      // 状态时放隐藏标签）——role 条件化避免 SR 噪音。
                                      role={stateDot !== null ? 'status' : undefined}
                                    >
                                      {stateDot}
                                    </span>
                                    <span className={cc.searchResultTitle}>{resolved.title}</span>
                                    {/* 2026-09-11 upstream-alignment T7: upstream's
                                        search row carries the marker right after
                                        the title, inside the heading (vendor
                                        ui-workspace Rows.tsx:351), fed by
                                        tree.ts:161-163. 2026-09-11 review-fix
                                        finding 5b: this row applies NO blank gate
                                        of its own — the projection helper
                                        (`projectedHasActiveSchedule`) is the only
                                        gate, and it is false for a session the
                                        projection does not list. Upstream's
                                        SearchResultItem has no blank gate either
                                        and SearchResultNode carries no `blank`
                                        field: blank (provisional new-session)
                                        rows are excluded from content search by
                                        the query itself (vendor tree.ts:156-159),
                                        so there is nothing to gate here. */}
                                    {projectedHasActiveSchedule(item.sessionId) && (
                                      <SessionScheduleIndicator label={t('schedule.active')} />
                                    )}
                                  </span>
                                  {resolved.workspaceLabel !== undefined && (
                                    <span className={cc.searchResultWorkspace}>{resolved.workspaceLabel}</span>
                                  )}
                                  {item.snippet !== '' && (
                                    <span className={cc.searchResultSnippet}>{item.snippet}</span>
                                  )}
                                </button>
                                {openError !== undefined && (
                                  <div className={clsx(cc.rowError, cc.sessionNested)} role="alert">{openError}</div>
                                )}
                              </Fragment>
                            )
                          })}
                          {currentRemote.status === 'loading' && (
                            <div className={cc.searchStatus} role="status">{t('search.pending')}</div>
                          )}
                          {currentRemote.status === 'error' && (
                            <div className={cc.searchWarning} role="status">{t('search.unavailable')}</div>
                          )}
                          {currentRemote.status !== 'loading' && merged.items.length === 0 && (
                            <div className={cc.empty}>{t('search.noMatches')}</div>
                          )}
                          {merged.hasMore && (
                            <div className={cc.searchStatus}>
                              {t('search.hasMore', { n: SESSION_SEARCH_RESULT_LIMIT })}
                            </div>
                          )}
                        </div>
                        {/* 搜索进行中（query!==''）也在结果下方渲染
                            aggregateError——结果优先，错误行在下面，与顶部
                            注释声称的行为一致。 */}
                        {server.aggregateError !== undefined && (
                          <div className={cc.aggregateError} role="alert">{server.aggregateError}</div>
                        )}
                      </>
                    ) : server.aggregateError !== undefined ? (
                      <div className={cc.aggregateError} role="alert">{server.aggregateError}</div>
                    ) : (
                      <>
                        {workspaceDropAtListStart && firstDropRow !== undefined
                          && !workspaceDropBlocked(firstDropRow, 'before') && (
                          <span className={cc.listTopDropIndicator} aria-hidden="true" />
                        )}
                        {(() => {
                          // chamber (08 §11.7, user decision): folding
                          // a git MAIN workspace folds the WHOLE repository
                          // group — its derived (worktree) workspace rows
                          // render hidden while the main's row is folded and
                          // return on expand (each with its own saved state).
                          // A derived row is a registered workspace whose git
                          // flag carries mainWorkspaceId (workspace-git-flags
                          // .ts); worktrees of an unregistered main (no main
                          // row to fold) and non-git workspaces stay visible.
                          // The main must still EXIST in the aggregate: once
                          // its registration vanishes (external deletion),
                          // the stale fold pref must not lock the derived
                          // rows hidden with no expand control — they surface
                          // again until the next git snapshot re-publish
                          // drops the mainWorkspaceId association. Rows
                          // carry no destructive in-flight state: git saga
                          // progress/errors surface through the source-level
                          // coordinator strip and rowErrors restore as-is on
                          // expand, so hiding loses nothing.
                          const visibleOrderedWorkspaces = (() => {
                            const liveWorkspaceIds = new Set(server.workspaces.map(row => row.id))
                            return orderedWorkspaces.filter(workspace => {
                              if (workspace.ungrouped === true || workspace.synthetic === true) return true
                              const flag = getWorkspaceGitFlag(server.id, workspace.id)
                              const mainId = flag?.mainWorkspaceId
                              if (mainId === undefined) return true
                              const foldedMain = viewPrefs.folded[`${server.id}/${mainId}`] === true
                              const mainPresent = liveWorkspaceIds.has(mainId)
                              return !hiddenByMainWorkspaceFold(flag, foldedMain, mainPresent)
                            })
                          })()
                          return visibleOrderedWorkspaces.map(workspace => {
                          const workspaceKey = `${server.id}/${workspace.id}`
                          const folded = viewPrefs.folded[workspaceKey] === true
                          // chamber: while THIS workspace's inline rename is
                          // active, the header row itself hosts the edit form
                          // (title -> input in place, no added list row). The
                          // flag gates every structural decision below: form
                          // embedding, drag-off, double-click re-entry guard,
                          // HoverCard off while typing, and the
                          // .workspaceRenaming class (height relax + glyph
                          // hover-swap suppression).
                          const renamingThisWorkspace = renaming !== null
                            && renaming.sourceId === server.id
                            && renaming.kind === 'workspace' && renaming.id === workspace.id
                          // chamber (08 §11): derived (worktree) workspaces
                          // drop the kebab/rename — OpenChamber worktree
                          // groups keep only delete + new-session. The flag
                          // also seeds the per-workspace icon accent (family
                          // hue for worktree/main workspaces).
                          const gitFlag = getWorkspaceGitFlag(server.id, workspace.id)
                          // design 06 §2.4: the accent
                          // is gated on the source's git identity being
                          // RESOLVED (first snapshot published) — until then
                          // a git workspace would first render an independent
                          // hue that later flips to its family hue (the
                          // one-time startup flash). Default ink renders
                          // instead; every workspace settles to its FINAL
                          // color at the same identity-resolve moment.
                          const workspaceAccent = isSourceGitFlagsLoaded(server.id)
                            ? workspaceAccentStyle(server.id, workspace.id, gitFlag)
                            : undefined
                          const isWorktree = gitFlag?.isWorktree === true
                          const sessions = sessionsOf(workspace)
                          // chamber: sessionsOf
                          // includes the projection's departed blank GHOST
                          // row, so the header count would be +1 for up to
                          // BLANK_GHOST_GRACE_MS. Count only non-ghost
                          // sessions (the same predicate the rows use).
                          const visibleSessionCount = sessions.reduce(
                            (count, session) => count + (isGhostSession(session) ? 0 : 1),
                            0,
                          )
                          // chamber (2026 性能整改 B2)：会话行渲染窗口——行
                          // DOM 不随会话数无界膨胀。组头徽标（上方
                          // visibleSessionCount）与一切数据面操作仍用全量
                          // sessions；这里只决定渲染行数与展开条文案。当前
                          // 会话行不被藏匿（窗口自动覆盖之，见
                          // shared/session-row-window.ts）。
                          const rowsExpanded = sessionRowsExpanded[workspaceKey] === true
                          const currentSessionIndex = currentId === undefined
                            ? -1
                            : sessions.findIndex(row => row.id === currentId)
                          const sessionWindow = sessionRowWindow({
                            total: sessions.length,
                            currentIndex: currentSessionIndex,
                            expanded: rowsExpanded,
                            visibleFirst: SESSION_ROWS_VISIBLE_FIRST,
                          })
                          const visibleSessions = sessionWindow.hiddenCount === 0
                            ? sessions
                            : sessions.slice(0, sessionWindow.renderCount)
                          // 展开条文案按「可见（非 ghost）会话」计（2026 评审
                          // 修复）：sessions 含短暂 blank-ghost 占位（≤
                          // BLANK_GHOST_GRACE_MS，渲染期跳过），直接复用窗口
                          // hiddenCount 会让「还有 N 个会话」在幽灵期内与组头
                          // 徽标（visibleSessionCount 已去 ghost）漂移 ±幽灵数。
                          // 窗口切片仍保留 ghost 行（占位防回流，见上），仅
                          // 对外文案减去窗口内的 ghost 数。
                          //
                          // 2026-09-11 upstream-alignment T11: the disclosure's
                          // OWN window ignores the expansion flag (upstream's
                          // collapsedSessionRows is expansion-independent,
                          // vendor ui-workspace WorkspaceBrowser.tsx:46-57), so
                          // the collapsed count stays known while expanded and
                          // the SAME control can offer `sessions.collapse`.
                          const disclosureWindow = sessionRowDisclosure({
                            total: sessions.length,
                            currentIndex: currentSessionIndex,
                            visibleFirst: SESSION_ROWS_VISIBLE_FIRST,
                          })
                          const hiddenVisibleCount = disclosureWindow.hiddenCount === 0
                            ? 0
                            : Math.max(0, visibleSessionCount - sessions
                              .slice(0, disclosureWindow.renderCount)
                              .reduce((count, session) => count + (isGhostSession(session) ? 0 : 1), 0))
                          const marker = workspaceDragMarker(workspace)
                          const activeSessionDrag = sessionDrag !== null
                            && sessionDrag.sourceId === server.id
                            && sessionDrag.accountKey === workspace.id
                          const sessionMarker = (sessionId: string): 'before' | 'after' | null =>
                            activeSessionDrag && sessionDrag.over !== null && sessionDrag.over.id === sessionId
                              ? sessionDrag.over.half
                              : null
                          // Action-keyed errors (new/rename/delete share the
                          // workspace's key family, suffixed per action kind).
                          const workspaceError = rowErrors[`${server.id}/workspace/${workspace.id}/new`]
                            ?? rowErrors[`${server.id}/workspace/${workspace.id}/rename`]
                            ?? rowErrors[`${server.id}/workspace/${workspace.id}/delete`]
                          // chamber (06): the workspace header row (hoisted
                          // so real workspaces wrap it in a HoverCard; the
                          // ungrouped bucket has no backing workspace, hence no
                          // card). Double click enters inline rename — the edit
                          // form then embeds INSIDE this row, replacing the
                          // trailing content (title/orphan badge/count/git
                          // occupant/hover actions; the ungrouped
                          // bucket has no rename; a click on the inner
                          // buttons never triggers it). Single clicks need no
                          // delay — the header itself is not clickable (fold
                          // lives on the chevron button).
                          const workspaceHeader = (
                            <div
                              className={clsx(cc.workspaceHeader, renamingThisWorkspace && cc.workspaceRenaming)}
                              // chamber: per-workspace icon accent —
                              // deterministic, selection-independent (the
                              // current-session row carries its own official
                              // selected tint); undefined for the ungrouped
                              // bucket, so CSS falls back to the default ink.
                              style={workspaceAccent}
                              data-chamber-row={workspaceKey}
                              role="treeitem"
                              aria-expanded={!folded}
                              draggable={!renamingThisWorkspace
                                && workspace.ungrouped !== true && workspace.synthetic !== true}
                              // The git occupant
                              // (create/remove buttons) cannot reach the
                              // plugin's suppressClickRef, so the whole header
                              // swallows clicks inside the drag-end trailing-
                              // click window — mirroring the guarded controls
                              // (fold / + / kebab / rename) in 06 §2.2.
                              onClickCapture={(event) => {
                                if (suppressClickRef.current) {
                                  event.preventDefault()
                                  event.stopPropagation()
                                }
                              }}
                              onDoubleClick={(event) => {
                                if (suppressClickRef.current) return
                                // While this workspace's rename is already
                                // active a second double click must not re-arm
                                // from the stale title (that would wipe the
                                // text being typed).
                                if (renamingThisWorkspace) return
                                if (menuOpen[workspaceKey] === true || workspace.ungrouped === true
                                  || workspace.synthetic === true) return
                                // Derived (worktree) workspaces have no rename
                                // (OpenChamber parity — kebab removed too).
                                if (getWorkspaceGitFlag(server.id, workspace.id)?.isWorktree === true) return
                                if (event.target instanceof HTMLElement && event.target.closest('button') !== null) return
                                setRenaming({
                                  sourceId: server.id,
                                  kind: 'workspace',
                                  id: workspace.id,
                                  value: workspace.title,
                                })
                              }}
                              onPointerDown={workspace.ungrouped === true || workspace.synthetic === true
                                ? undefined
                                : (event) => {
                                  // Same press-target
                                  // guard as the source header — a gesture
                                  // that STARTED on a workspace-header button
                                  // (fold / orphan badge / git actions / + /
                                  // kebab) never initiates the workspace drag
                                  // (a >4px micro-drag on the fold toggle must
                                  // not swallow its click).
                                  dragPressOnButtonRef.current = event.target instanceof Element && event.target.closest('button') !== null
                                }}
                              onDragStart={workspace.ungrouped === true || workspace.synthetic === true
                                ? undefined
                                : (event) => {
                                  // Abort drags that began on a button —
                                  // buttons stay pure click affordances.
                                  if (dragPressOnButtonRef.current) {
                                    dragPressOnButtonRef.current = false
                                    event.preventDefault()
                                    return
                                  }
                                  dragPressOnButtonRef.current = false
                                  event.dataTransfer.effectAllowed = 'move'
                                  event.dataTransfer.setData('text/plain', workspace.id)
                                  // Workspace-header drags must suppress the
                                  // trailing click like session rows do (06 §2.2
                                  // lists the fold chevron / + / kebab / source
                                  // header among the guarded controls) — a drop
                                  // ending over them must not fire a spurious
                                  // toggle/open/menu.
                                  suppressClickRef.current = true
                                  workspaceDropCommitted.current = false
                                  setWorkspaceDrag({ sourceId: server.id, workspaceId: workspace.id, over: null })
                                }}
                              onDragEnd={workspace.ungrouped === true
                                ? undefined
                                : () => {
                                  if (workspaceDrag !== null && workspaceDrag.over !== null) {
                                    commitWorkspaceDrag(server, workspaceDrag, workspaceDrag.over)
                                  } else {
                                    setWorkspaceDrag(null)
                                  }
                                  workspaceDropCommitted.current = false
                                  // 镜像会话行复位——拖拽结束后一个 tick
                                  // 清掉抑制位，否则本次 workspace 头拖拽后的
                                  // 尾随 click 会永久短路来源切换/排序/加工作区/
                                  // 搜索/折叠/新建/kebab/归档/会话打开（唯一复位
                                  // 在会话行 onDragEnd，workspace 头漏了）。
                                  window.setTimeout(() => { suppressClickRef.current = false }, 0)
                                }}
                            >
                              <button
                                type="button"
                                className={clsx(
                                  cc.foldToggle,
                                  folded && cc.foldToggleFolded,
                                  // OpenChamber SessionGroupSection swap: a
                                  // worktree (derived) workspace shows the
                                  // git-branch glyph at rest and the collapse
                                  // chevron on hover; a normal workspace shows
                                  // a FOLDER glyph (project-row parity); the
                                  // ungrouped bucket keeps the plain chevron.
                                  isWorktree
                                    ? cc.foldToggleGit
                                    : (workspace.ungrouped !== true && cc.foldToggleFolder),
                                )}
                                aria-label={folded ? t('workspace.expand') : t('workspace.collapse')}
                                onClick={() => {
                                  if (suppressClickRef.current) return
                                  clearPendingClick()
                                  toggleWorkspaceFold(server.id, workspace.id)
                                }}
                              >
                                <IconChevronRightOutline14 size={14} className={cc.foldChevron} />
                                {isWorktree && (
                                  <IconBranchOutline16 size={14} className={cc.foldBranch} />
                                )}
                                {!isWorktree && workspace.ungrouped !== true && (
                                  <IconFolderOpenOutline16 size={14} className={cc.foldFolder} />
                                )}
                              </button>
                              {renamingThisWorkspace ? (
                                // In-place rename: the edit form replaces the
                                // header's trailing content (title / orphan
                                // badge / count / git occupant / hover
                                // actions) INSIDE the header row — the fold
                                // toggle + gutter stay, so the row keeps its
                                // identity and position and no extra input
                                // row is appended below it.
                                renameForm(workspace.title, 'workspaceHeader')
                              ) : (
                                <>
                                  <span className={clsx(cc.workspaceTitle, isWorktree && cc.workspaceTitleGit)}>
                                    {workspace.ungrouped ? t('list.ungrouped') : workspace.title}
                                  </span>
                                  {getWorkspaceGitFlag(server.id, workspace.id)?.orphaned === true && (
                                    // Plan A: the workspace's path no longer exists
                                    // (externally deleted worktree left a ghost).
                                    // The badge doubles as the cleanup entry — an
                                    // orphaned WORKTREE keeps its worktree row
                                    // (no kebab), so the badge click opens the
                                    // dedicated delete confirm.
                                    <button
                                      type="button"
                                      className={cc.orphanBadge}
                                      title={t('confirm.deleteOrphan', { title: workspace.title })}
                                      onClick={() => onDeleteWorkspace(server, workspace.id, workspace.title)}
                                    >
                                      {t('list.orphaned')}
                                    </button>
                                  )}
                                  {visibleSessionCount > 0 && (
                                    <span className={cc.workspaceCount}>{visibleSessionCount}</span>
                                  )}
                                  {workspace.ungrouped !== true && workspace.synthetic !== true && (
                                    // chamber (08 §11): the per-workspace Git
                                    // occupant lives INSIDE the workspace header
                                    // row (OpenChamber-style: the worktree/branch
                                    // surface is the row itself, not a separate
                                    // line). It renders the worktree-workspace's
                                    // branch chip plus the create/delete actions;
                                    // non-git workspaces get an empty mount.
                                    renderWorkspaceGit('sidebar.workspace.git', { wide }, {
                                      hookContext: { sourceId: server.id, workspaceId: workspace.id },
                                    })
                                  )}
                                  {!workspace.ungrouped && !workspace.synthetic && (
                                    <span
                                      className={clsx(cc.rowActions, menuOpen[workspaceKey] === true && cc.rowActionsVisible)}
                                      onClick={(event) => {
                                        // INVARIANT (pending-click.ts header): any
                                        // control that stops propagation MUST clear
                                        // the pending itself —
                                        // stopPropagation stops the native event, so
                                        // the document-level listener never sees it,
                                        // and a surviving pending would make a later
                                        // click on the same session spuriously enter
                                        // rename.
                                        event.stopPropagation()
                                        clearPendingClick()
                                      }}
                                    >
                                      <button
                                        type="button"
                                        className={cc.actionIcon}
                                        // 2026-09-11 upstream-alignment T5: the row
                                        // name rides the accessible name (upstream
                                        // `actions.newSession.aria`, vendor
                                        // ui-workspace Rows.tsx:179) — a bare
                                        // "新建会话" repeated per row tells AT nothing.
                                        aria-label={t('action.newSession.aria', { name: workspace.title })}
                                        title={t('action.newSession.aria', { name: workspace.title })}
                                        onClick={() => {
                                          if (suppressClickRef.current) return
                                          clearPendingClick()
                                          onNewSession(server, workspace.id)
                                        }}
                                      >
                                        <IconPlusOutline16 size={14} />
                                      </button>
                                      {!isWorktree && (
                                      <Menu
                                        // 2026-09-11 upstream-alignment T12: upstream
                                        // always passes closeOnPointerLeave and never
                                        // compact (vendor ui-workspace Rows.tsx:174).
                                        portal
                                        closeOnPointerLeave
                                        align="end"
                                        open={menuOpen[workspaceKey] === true}
                                        onClose={() => closeMenu(workspaceKey)}
                                        onSelect={(id: string) => {
                                          closeMenu(workspaceKey)
                                          if (id === 'rename') {
                                            setRenaming({
                                              sourceId: server.id,
                                              kind: 'workspace',
                                              id: workspace.id,
                                              value: workspace.title,
                                            })
                                          } else if (id === 'delete') {
                                            onDeleteWorkspace(server, workspace.id, workspace.title)
                                          }
                                        }}
                                        items={[
                                          {
                                            id: 'rename',
                                            label: t('action.rename'),
                                            icon: <IconEditOutline16 size={14} />,
                                          },
                                          {
                                            id: 'delete',
                                            // Upstream's workspace menu entry copy
                                            // (T7 wording: `delete.workspace`,
                                            // vendor ui-workspace Rows.tsx:131).
                                            label: t('delete.workspace'),
                                            danger: true,
                                            icon: <IconTrashOutline16 size={14} />,
                                          },
                                        ]}
                                        anchor={(
                                          <button
                                            type="button"
                                            className={cc.actionIcon}
                                            aria-label={t('action.menu.workspace', { name: workspace.title })}
                                            aria-haspopup="menu"
                                            aria-expanded={menuOpen[workspaceKey] === true}
                                            onClick={(event) => {
                                              event.stopPropagation()
                                              if (suppressClickRef.current) return
                                              clearPendingClick()
                                              toggleMenu(workspaceKey)
                                            }}
                                          >
                                            <IconEllipsisOutline16 className={cc.verticalDots} size={14} />
                                          </button>
                                        )}
                                      />
                                      )}
                                    </span>
                                  )}
                                </>
                              )}
                            </div>
                            )
                            return (
                            <Fragment key={workspace.id}>
                            <div
                              key={workspace.id}
                              className={clsx(
                                cc.workspaceGroup,
                                workspace.ungrouped && cc.ungroupedGroup,
                                marker === 'before' && cc.dropBefore,
                                marker === 'after' && cc.dropAfter,
                              )}
                              role="group"
                              onDragOver={workspace.ungrouped === true || workspace.synthetic === true
                                || workspaceDrag === null
                                || workspaceDrag.sourceId !== server.id
                                ? undefined
                                : (event) => {
                                  event.preventDefault()
                                  event.dataTransfer.dropEffect = 'move'
                                  const half = rowHalf(event)
                                  if (workspaceDropBlocked(workspace.id, half)) {
                                    // A suppressed zone never becomes the
                                    // target — the drop/commit no-ops there.
                                    return
                                  }
                                  setWorkspaceDrag(current => {
                                    if (current === null) return current
                                    if (current.over?.id === workspace.id && current.over.half === half) return current
                                    return { ...current, over: { id: workspace.id, half } }
                                  })
                                }}
                              onDrop={workspace.ungrouped === true || workspace.synthetic === true
                                || workspaceDrag === null
                                || workspaceDrag.sourceId !== server.id
                                ? undefined
                                : (event) => {
                                  event.preventDefault()
                                  if (workspaceDrag === null) return
                                  commitWorkspaceDrag(server, workspaceDrag, { id: workspace.id, half: rowHalf(event) })
                                }}
                            >
                              {workspace.ungrouped === true ? (
                                workspaceHeader
                              ) : (
                                <HoverCard
                                  anchor={workspaceHeader}
                                  copyLabel={t('action.copy')}
                                  copiedLabel={t('hover.copied')}
                                  content={(
                                    <div className={cc.hoverContent}>
                                      <div className={cc.hoverTitle}>{workspace.title}</div>
                                      {sessions.length > 0 && (
                                        <div className={cc.hoverTime}>{t('hover.sessionCount', { n: sessions.length })}</div>
                                      )}
                                    </div>
                                  )}
                                  disabled={menuOpen[workspaceKey] === true || renamingThisWorkspace
                                    || workspaceDrag !== null || sessionDrag !== null || serverDrag !== null}
                                />
                              )}
                            {/* Workspace-scoped failures are hoisted OUT of the
                                fold gate (both lines): a new-session/rename/
                                delete/drag failure must surface even while the
                                group is folded — rename (dblclick or kebab),
                                delete (kebab/orphan badge), workspace drags
                                and the header `+` are all reachable from a
                                folded header. */}
                            {workspaceError !== undefined && (
                              <div className={cc.rowError} role="alert">{workspaceError}</div>
                            )}
                            {rowErrors[`${server.id}/workspace-drag/${workspace.id}`] !== undefined && (
                              <div className={cc.rowError} role="alert">{rowErrors[`${server.id}/workspace-drag/${workspace.id}`]}</div>
                            )}
                            {/* chamber (打开失败可见性): session open failures
                                whose row this group's fold/window gate hides —
                                hoisted like the workspace errors above, so a
                                failure survives a mid-flight fold (or a row
                                windowed out of the visible slice). Visible
                                rows render the error inline below themselves
                                instead. */}
                            {sessions
                              .filter(session => rowErrors[openErrorKey(server.id, session.id)] !== undefined
                                && (folded || !visibleSessions.some(visible => visible.id === session.id)))
                              .map(session => (
                                <div key={session.id} className={clsx(cc.rowError, cc.sessionNested)} role="alert">
                                  {rowErrors[openErrorKey(server.id, session.id)]}
                                </div>
                              ))}
                            {!folded && (
                            <>
                              {visibleSessions.map((session) => {
                                const sessionKey = `${server.id}/session/${session.id}`
                                const sessionDragError = rowErrors[`${server.id}/session-drag/${session.id}`]
                                const sessionActionError = rowErrors[`${server.id}/session/${session.id}/rename`]
                                  ?? rowErrors[`${server.id}/session/${session.id}/archive`]
                                  ?? rowErrors[`${server.id}/session/${session.id}/fork`]
                                  // chamber (打开失败可见性): open failures land
                                  // in the same slot (SidebarRoot reports the
                                  // App-layer outcome; low precedence — a
                                  // rename/archive/fork failure of the same row
                                  // wins). Key template shared with the writer
                                  // (shared/open-outcome.ts).
                                  ?? rowErrors[openErrorKey(server.id, session.id)]
                                // chamber (design 06 §2.2):
                                // a blank row the projection still carries after
                                // it stopped being current is a GHOST — the App
                                // holds it for BLANK_GHOST_GRACE_MS so the list
                                // cannot shift inside the double-click window.
                                // The local expiry bounds the RENDER side: once
                                // the grace passes, the invisible placeholder is
                                // dropped even if the App has not re-derived yet
                                // (the next publish drops it from the projection
                                // for good — the row is invisible either way, so
                                // skipping it never shows a stale row).
                                const ghost = isGhostSession(session)
                                const ghostLive = ghost && (ghostExpiry.current.get(session.id) ?? 0) > Date.now()
                                if (ghost && !ghostLive) return null
                                // chamber (06): the session row
                                // (hoisted so the HoverCard can wrap it). The
                                // single click opens IMMEDIATELY — no
                                // double-click-window delay (OpenChamber
                                // model); the module-global pending click
                                // (shared/pending-click.ts, keyed by
                                // sessionId) only guards the SECOND click
                                // within DOUBLE_CLICK_WINDOW_MS on the SAME
                                // session, which enters inline rename.
                                // suppressClickRef (drag-end trailing click)
                                // is honored on the way in; a click outside
                                // the pending row cancels it (document
                                // listener). The row renders
                                // data-session-id so the outside-click
                                // containment check works across shells.
                                // 2026-09-11 upstream-alignment T5: one row-title
                                // resolution shared by the row label and the row
                                // actions' accessible names (the blank label stays
                                // rendered-only — a blank row carries no actions).
                                // I3: the OFFICIAL display label (never empty),
                                // so "unknown title" can never render 「未命名会话」.
                                const sessionTitleText = session.displayTitle
                                const sessionRow = (
                                  <div
                                    className={clsx(
                                      cc.sessionRow,
                                      ghost && cc.sessionGhost,
                                      session.id === currentId && cc.sessionActive,
                                      sessionMarker(session.id) === 'before' && cc.dropBefore,
                                      sessionMarker(session.id) === 'after' && cc.dropAfter,
                                    )}
                                    role="treeitem"
                                    aria-selected={session.id === currentId}
                                    data-session-id={session.id}
                                    data-chamber-row={sessionKey}
                                    data-chamber-ghost={ghost ? '' : undefined}
                                    // Synthetic cwd-derived groups are
                                    // display-only: session rows inside them
                                    // neither drag nor accept drops (a wire
                                    // commit would fail
                                    // workspace/not-found on the host).
                                    draggable={!ghost && workspace.synthetic !== true}
                                    onDragStart={ghost || workspace.synthetic === true
                                      ? undefined
                                      : (event) => {
                                        event.dataTransfer.effectAllowed = 'move'
                                        event.dataTransfer.setData('text/plain', session.id)
                                        suppressClickRef.current = true
                                        sessionDropCommitted.current = false
                                        setSessionDrag({
                                          sourceId: server.id,
                                          accountKey: workspace.id,
                                          ungrouped: workspace.ungrouped === true,
                                          sessionId: session.id,
                                          over: null,
                                        })
                                      }}
                                    onDragEnd={() => {
                                      if (sessionDrag !== null && sessionDrag.over !== null) {
                                        commitSessionDrag(server, sessionDrag, sessionDrag.over)
                                      } else {
                                        setSessionDrag(null)
                                      }
                                      sessionDropCommitted.current = false
                                      window.setTimeout(() => { suppressClickRef.current = false }, 0)
                                    }}
                                    onDragOver={!activeSessionDrag
                                      ? undefined
                                      : (event) => {
                                        event.preventDefault()
                                        event.dataTransfer.dropEffect = 'move'
                                        const half = rowHalf(event)
                                        setSessionDrag(current => {
                                          if (current === null) return current
                                          if (current.over?.id === session.id && current.over.half === half) return current
                                          return { ...current, over: { id: session.id, half } }
                                        })
                                      }}
                                    onDrop={!activeSessionDrag
                                      ? undefined
                                      : (event) => {
                                        event.preventDefault()
                                        if (sessionDrag === null) return
                                        commitSessionDrag(server, sessionDrag, { id: session.id, half: rowHalf(event) })
                                      }}
                                    onClick={() => {
                                      if (suppressClickRef.current) return
                                      // A ghost row is a non-interactive layout
                                      // placeholder (visibility:hidden — clicks
                                      // never reach it); guard defensively.
                                      if (ghost) return
                                      // 菜单展开 / 本行重命名进行中：忽略整次点击
                                      //（不 arm、不开会话）。
                                      if (menuOpen[sessionKey] === true || (renaming !== null
                                        && renaming.sourceId === server.id && renaming.kind === 'session' && renaming.id === session.id)) return
                                      // chamber (06): single
                                      // click opens IMMEDIATELY — zero delay
                                      // (OpenChamber model). The module-global
                                      // pending (keyed by sessionId) only
                                      // answers "is this the SECOND click of a
                                      // double click on the same session within
                                      // DOUBLE_CLICK_WINDOW_MS" — that one
                                      // enters inline rename; any other click
                                      // records the pending and opens right
                                      // away. openSession is idempotent, so a
                                      // misjudged slow second click just
                                      // re-opens (no-op) and can NEVER
                                      // accidentally rename.
                                      if (noteSessionRowClick(server.id, session.id)) {
                                        // 空白"新建会话"占位行无内容可
                                        // 改名——双击不得进入内联重命名（否则会
                                        // 把暂存会话的改名写到 wire 上）。
                                        if (session.blank === true) return
                                        setRenaming({
                                          sourceId: server.id,
                                          kind: 'session',
                                          id: session.id,
                                          value: session.title,
                                        })
                                        return
                                      }
                                      // 打开任何
                                      // 真实会话都会把活动来源的 current 从空白
                                      // 行切走，App 随后重派生——同步先 arm ghost
                                      // 槽占住该行的布局位，列表在 350ms 双击窗口
                                      // 内不位移，第二次点击仍落在目标行上。
                                      armBlankGhostForClick()
                                      openSession(server.id, session.id)
                                    }}
                                  >
                                    <span className={cc.sessionTitle}>{session.blank === true ? t('session.new') : sessionTitleText}</span>
                                    {/* 2026-09-11 upstream-alignment T7: the
                                        active-Schedule marker sits exactly where
                                        upstream puts it — between the row title
                                        and the trailing cells (vendor
                                        ui-workspace Rows.tsx:468). Renders only
                                        for rows whose projection says so, so an
                                        ordinary row's geometry/pitch is
                                        untouched. */}
                                    {session.hasActiveSchedule === true && (
                                      <SessionScheduleIndicator label={t('schedule.active')} />
                                    )}
                                    {/* blank（新建）行是临时占位——内容
                                        不存在，kebab（含 fork/归档）作用于
                                        不存在的内容，隐藏整簇（官方 Rows.tsx
                                        `!row.blank && <rowActions>` L436-462）。 */}
                                    {session.blank !== true && (
                                    <span
                                      className={clsx(cc.rowActions, menuOpen[sessionKey] === true && cc.rowActionsVisible)}
                                      onClick={(event) => {
                                        // INVARIANT (pending-click.ts header):
                                        // stopPropagation must be paired with
                                        // clearPendingClick — see the workspace rowActions note.
                                        event.stopPropagation()
                                        clearPendingClick()
                                      }}
                                    >
                                      <Menu
                                        // 2026-09-11 upstream-alignment T12: upstream
                                        // always passes closeOnPointerLeave and never
                                        // compact (vendor ui-workspace Rows.tsx:487).
                                        portal
                                        closeOnPointerLeave
                                        align="end"
                                        open={menuOpen[sessionKey] === true}
                                        onClose={() => closeMenu(sessionKey)}
                                        onSelect={(id: string) => {
                                          closeMenu(sessionKey)
                                          if (id === 'rename') {
                                            setRenaming({
                                              sourceId: server.id,
                                              kind: 'session',
                                              id: session.id,
                                              value: session.title,
                                            })
                                          } else if (id === 'fork') {
                                            onForkSession(server, session)
                                          } else if (id === 'archive') {
                                            // 2026-09-11 review-fix finding 5d:
                                            // no title argument — the verb runs
                                            // immediately (T2a) and nothing reads it.
                                            onArchiveSession(server, session.id)
                                          }
                                        }}
                                        items={[
                                          {
                                            id: 'rename',
                                            label: t('action.rename'),
                                            icon: <IconEditOutline16 size={14} />,
                                          },
                                          {
                                            id: 'fork',
                                            label: t('menu.fork'),
                                            icon: <IconBranchOutline16 size={14} />,
                                          },
                                          {
                                            // 2026-09-11 upstream-alignment T2a: the
                                            // archive verb lives HERE, in the row
                                            // menu — upstream keeps no second hover
                                            // button because archiving only hides the
                                            // row (it never touches the session log),
                                            // so it is neither destructive nor
                                            // confirm-gated (vendor ui-workspace
                                            // Rows.tsx:412-421). The 20-native glyph
                                            // rides the menu's 16px icon slot.
                                            id: 'archive',
                                            label: t('menu.archiveSession'),
                                            icon: <IconArchiveOutline20 size={16} />,
                                          },
                                        ]}
                                        anchor={(
                                          <button
                                            type="button"
                                            className={cc.actionIcon}
                                            // 2026-09-11 upstream-alignment T5: the row
                                            // title is the accessible name (upstream
                                            // `actions.session.aria`, vendor
                                            // ui-workspace Rows.tsx:492).
                                            aria-label={t('action.menu.session', { name: sessionTitleText })}
                                            aria-haspopup="menu"
                                            aria-expanded={menuOpen[sessionKey] === true}
                                            onClick={(event) => {
                                              event.stopPropagation()
                                              if (suppressClickRef.current) return
                                              clearPendingClick()
                                              toggleMenu(sessionKey)
                                            }}
                                          >
                                            <IconEllipsisOutline16 className={cc.verticalDots} size={14} />
                                          </button>
                                        )}
                                      />
                                    </span>
                                    )}
                                    {/* Trailing state slot: the ring/dot at the
                                        row's right edge. On hover the row action
                                        cluster (the kebab menu) swaps in and this
                                        slot swaps out (CSS hover replace, 06 §4.3
                                        /§7) — the slot is a true replace, no
                                        placeholder. role is conditional so an
                                        empty (no-state) slot does not register a
                                        live region (same rule
                                        as the search-result rows). */}
                                    <span
                                      className={clsx(cc.sessionStateSlot, sessionStatePending(server, session) !== undefined && cc.sessionStateSlotPending)}
                                      title={sessionStateLabel(server, session)}
                                      aria-label={sessionStateLabel(server, session)}
                                      role={sessionStateDot(server, session) !== null ? 'status' : undefined}
                                    >
                                      {sessionStateDot(server, session)}
                                    </span>
                                  </div>
                                )
                                return (
                                <Fragment key={session.id}>
                                  {renaming !== null && renaming.sourceId === server.id
                                  && renaming.kind === 'session' && renaming.id === session.id ? (
                                    renameForm(session.title, 'sessionRow')
                                  ) : (
                                    <HoverCard
                                      anchor={sessionRow}
                                      content={(
                                        <div className={cc.hoverContent}>
                                          <div className={cc.hoverTitle}>{session.blank === true ? t('session.new') : sessionTitleText}</div>
                                          {session.blank !== true && session.updatedAt !== undefined && session.updatedAt > 0 && (
                                            <div className={cc.hoverTime}>{hoverTimeLabel(session.updatedAt, now)}</div>
                                          )}
                                          {sessionStateLabel(server, session) !== undefined && (
                                            <div className={cc.hoverStatus}>
                                              <span className={clsx(cc.sessionStateSlot, sessionStatePending(server, session) !== undefined && cc.sessionStateSlotPending)}>
                                                {sessionStateDot(server, session)}
                                              </span>
                                              <span>{sessionStateLabel(server, session)}</span>
                                            </div>
                                          )}
                                        </div>
                                      )}
                                      disabled={menuOpen[sessionKey] === true || sessionDrag !== null || workspaceDrag !== null || serverDrag !== null}
                                      copyText={session.blank === true ? undefined : sessionTitleText}
                                      copyLabel={t('action.copy')}
                                      copiedLabel={t('hover.copied')}
                                    />
                                  )}
                                  {sessionDragError !== undefined && (
                                    <div className={clsx(cc.rowError, cc.sessionNested)} role="alert">{sessionDragError}</div>
                                  )}
                                  {sessionActionError !== undefined && (
                                    <div className={clsx(cc.rowError, cc.sessionNested)} role="alert">{sessionActionError}</div>
                                  )}
                                </Fragment>
                                )
                              })}
                              {hiddenVisibleCount > 0 && (
                                <button
                                  type="button"
                                  className={cc.sessionRowsMore}
                                  // 2026-09-11 upstream-alignment T11: a real
                                  // two-way disclosure (upstream
                                  // WorkspaceBrowser.tsx:598-609) — the control
                                  // reports its state and collapses again.
                                  aria-expanded={rowsExpanded}
                                  onClick={() => {
                                    setSessionRowsExpanded(prev => ({ ...prev, [workspaceKey]: !rowsExpanded }))
                                  }}
                                >
                                  {rowsExpanded
                                    ? t('sessions.collapse')
                                    : t('sessions.expand', { n: hiddenVisibleCount })}
                                </button>
                              )}
                            </>
                            )}
                          </div>
                          </Fragment>
                          )
                          })
                        })()}
                        {(() => {
                          // chamber (08 §11 Plan A): ALL unregistered worktrees
                          // render at the very end of the workspace list — one
                          // block per repository (user decision: not
                          // after the main checkout, not after the repo group).
                          // The block must NOT beat the workspace list: the git
                          // facts (fast snapshot) arrive before the aggregate
                          // (workspace.list + sessions.list) — gate on the
                          // aggregate having landed so the worktrees never
                          // appear ahead of the workspaces.
                          if (server.aggregateReady !== true) return []
                          return repoLayouts
                            .filter(layout => layout.unregistered.length > 0)
                            .map(layout => (
                              <Fragment key={layout.repoKey}>
                                {renderWorkspaceGit('sidebar.workspace.git', { wide }, {
                                  hookContext: { sourceId: server.id, workspaceId: '', repoKey: layout.repoKey },
                                })}
                              </Fragment>
                            ))
                        })()}
                        {server.workspaces.length === 0 && <div className={cc.empty}>{t('list.noWorkspaces')}</div>}
                        {query === '' && rowErrors[`${server.id}/add-workspace`] !== undefined && (
                          <div className={cc.rowError} role="alert">{rowErrors[`${server.id}/add-workspace`]}</div>
                        )}
                      </>
                    )}
                  </div>
                  </>
                  )
                })() : (
                  // Disconnected source: header + status icon only (dot or
                  // spinner — the phase lives on hover/aria; no status text
                  // on the main surface, the connections settings page
                  // carries the detailed logSummary).
                  null
                )}
                </>
                )}
              </section>
              )

}
