/**
 * Chamber sidebar shell (design 05 §2): column geometry owned by the shell,
 * region replaced with the chamber multi-source session list.
 *
 * Kept from the official shell: logo row (wide/rail), New Session (rides the
 * runtime action of THIS ctx — always the current source), the fold
 * state machine (slide + crossfade, rail-in animation, frozen-width fade),
 * the pointer-followed scrollbar discipline, and the foot
 * (sidebar.footer.action + sidebar.settings).
 *
 * The region (was the `sidebar.workspaces` registrant's browser) now renders
 * every source's sessions in ONE equal list, grouped by source only: source
 * header (label + connection-status dot/spinner — green ready, red
 * error/stopped, gray idle/unknown, spinner while connecting/starting/
 * restarting/degraded (the reconnect cycle folds into one stable "trying"
 * state — no spinner/dot flicker on every retry attempt); the phase text
 * lives on hover only; active source highlighted) →
 * workspace groups → session rows. Remote sources carry a stable accent
 * derived from the source id (hue hash); the local source uses the default
 * dot. The accent also feeds the active source/session left inset through a
 * per-element CSS variable (--dsh-source-accent). A session row click asks
 * the App layer to switch to that source's
 * shell and open the session (chamberBridge.requestOpenSession); clicking a
 * remote source's header asks the App layer to switch the active N-ctx view
 * WITHOUT opening a session (chamberBridge.requestActivateSource). Session
 * rows show a state indicator in a fixed TRAILING slot at the row's very end
 * (normal = empty; running = the official dsh ongoing blue RING; pending
 * interactions = a distinguishable 14px icon badge — question `?`,
 * plan-review checklist, approval warning triangle; completed-but-unread = a
 * persistent blue DOT — the slot is not a
 * server-identity marker, the source header dot owns identity). Hover swaps
 * are TRUE replacements: the actions take no layout space at rest
 * (display:none), so the state icon really sits at the end; hovering swaps
 * the state slot for the kebab+archive actions (source header: status ↔
 * search+`+`; workspace header: count ↔ `+`+kebab). Hover actions are
 * icon-based: a
 * workspace header carries a `+`
 * (new session) and a three-dot kebab menu (rename/delete); a session row
 * carries a three-dot kebab menu (rename) plus a dedicated archive button;
 * the add-workspace `+` lives in the source header (source-level creation,
 * next to the per-source search). Actions run over that
 * source's own unary API (v1
 * minimal set: session rename/archive; workspace new-session/rename/delete);
 * failures surface inline, never silently. A trailing synthetic bucket
 * renders stray sessions as an ungrouped group (sessions only — no workspace
 * actions). Every successful action asks the App layer to re-pull that
 * source's snapshot (chamberBridge.requestRefresh); connected sources also
 * offer an add-workspace entry — one in-app directory-browser dialog per
 * source (05 §4; every managed host serves the browse capability) — through
 * the source-header `+`.
 * When a connected source's snapshot fetch failed, its error text replaces
 * the workspace list instead of pretending there are no workspaces (an
 * active search query keeps its results visible above that error).
 * Disconnected sources render the header (the status dot/spinner always
 * shows the phase kind — no status text, the raw transport reason never
 * surfaces on the main surface (the connections settings page carries the
 * detailed logSummary)); with every source disconnected the list appends
 * the empty hint under the groups. The rail
 * renders the source color dots. Workspace groups fold/unfold via a header
 * chevron toggle; fold state + ungrouped order live in ONE shared live store
 * (view prefs, 06 §3, 2026-08 revision: getViewPrefs/subscribeViewPrefs/
 * updateViewPrefs — single vite-shared instance across every ctx's sidebar,
 * write-through localStorage + notify, cross-ctx LIVE sync; a fold toggle in
 * any source's sidebar propagates to all sources immediately, no per-ctx
 * stale copy, no write-back resurrecting another ctx's newer state).
 *
 * Chamber third round (06): per-source session search (wide only, 06 §1) —
 * the source header carries a search icon (hidden for disconnected sources
 * and for sources whose snapshot pull failed, unless the capsule is open so
 * it can be collapsed); expanding renders a capsule input row beneath the
 * header (debounced content search over the source's unary API, one 30s-
 * aborted job per query, results replace the workspace list while a query is
 * active); clicking the icon on an open capsule collapses it (empty query)
 * or just blurs the input. In-source HTML5 drag ordering (06 §2): session
 * rows (real workspaces AND the ungrouped bucket) and real workspace group
 * headers drag within their own source only; commits move
 * sessions/workspaces through the wire methods with an optimistic transient
 * order override that self-heals on the next pull (dropped per key only when
 * the pull confirms the commit, the key's workspace vanished, or the wire
 * commit failed; a stale poll never resets it), while the ungrouped order
 * persists through view prefs. The current-session highlight is now
 * channel-based (06 §4): each ctx's plugin reports its own
 * runtime facts through chamberBridge.reportInstanceRuntime, the App layer
 * merges them into server.runtime, and this shell highlights the matching
 * row (official selected tint) and marks its workspace group with an accent
 * chevron — without subscribing to any store. The highlight is
 * single-selection (2026-08): only the source owning this visible ctx
 * renders it, so globally exactly one session — the one being viewed —
 * is highlighted.
 *
 * Collapse is a slide plus crossfade: content freezes at its expanded width
 * (inline style) and fades out in place while the sliding column (AppFrame
 * grid tracks) clips it — nothing reflows mid-slide. At settle the wide-only
 * content unmounts and the four upper controls enter the 56px rail from the
 * same horizontal offset (one icon each, same top-down order) on one fade
 * that ends with the slide. The bottom-pinned settings control only fades.
 *
 * The column also owns whether the scroll regions nested in it draw a
 * scrollbar at all: the shell tracks the pointer and rebinds ui-theme's
 * scrollbar indirection away while it is elsewhere, so a list the user is not
 * pointing at carries no bar.
 */
import { Component, Fragment, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import clsx from 'clsx'
import { SESSION_SEARCH_RESULT_LIMIT } from '@deepseek-ai/dsh-client-connection/client'
import {
  BrandWordmark, FishLogo, HoverCard, IconArchiveOutline20, IconBranchOutline16, IconChecklistOutline14,
  IconChevronRightOutline14, IconCloseOutline16, IconEditOutline16, IconEllipsisOutline16, IconLoadingOutline16,
  IconNewChatOutline16, IconPanelLeftOutline16, IconPersonalizationOutline16, IconPlusOutline16, IconQuestionOutline14,
  IconSearchOutline16, IconTrashOutline16, IconWarningOutline16, Menu, StateDot, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarRootComponentProps } from './contract/slots.ts'
import type { SidebarKey } from './locales.ts'
import { chamberBridge, type ChamberServerAggregate, type ChamberServerWorkspace } from '../shared/aggregate-store.ts'
import {
  deriveLocalSearchMatches, increasedForkTitle, mergeSearchResults, orderUngroupedSessions, reconciledSessionOrder, relativeTimeBucket,
  sanitizeSearchQuery, serversProjectionSignature, SEARCH_QUERY_MAX_CODE_UNITS, sortWorkspaceSessions,
} from '../shared/derive.ts'
import {
  archiveSession, createHostDirectory, createSession, createWorkspace, deleteWorkspace,
  forkSession, getInstanceClient, insertSessionBefore, insertWorkspaceBefore, listHostDirectory,
  renameSession, renameWorkspace, searchSessions, type InstanceSnapshot, type SearchRow,
} from '../shared/instance-api.ts'
import { DirectoryBrowser } from '@deepseek-ai/dsh-client-ui-directory-picker-browse/client/DirectoryBrowser.tsx'
import {
  clearSearch, collapseSearch, expandSearch, getSearchStates, setSearchFetcher, setSearchQuery, subscribeSearch,
  type SourceSearchState,
} from '../shared/search-state.ts'
import { getViewPrefs, subscribeViewPrefs, updateViewPrefs, type ChamberSidebarViewPrefs } from '../shared/view-prefs.ts'
import css from './SidebarRoot.module.css'
import cc from './sidebar-chamber.module.css'

// Wire the shared search controller's wire fetch once at module scope (the
// controller stays a pure, plain-node-testable state machine; instance-api's
// unary client is browser/vite-only).
setSearchFetcher((sourceId, query, signal) => searchSessions(getInstanceClient(sourceId), query, signal))

/** Wide-content unmount delay; matches the 150ms wide-content fade-out. */
const COLLAPSE_SETTLE_MS = 150

/**
 * How long the column's scrollbars stay drawn after the pointer leaves it.
 * The bar is a pointer affordance here, and hiding it on the leave event
 * itself makes it blink out while the pointer is only crossing the column's
 * edge — on the way to the conversation, or around a portalled menu.
 */
const SCROLLBAR_LINGER_MS = 2000

/**
 * Wire search-result page bound — SESSION_SEARCH_RESULT_LIMIT comes from the
 * wire re-export (dsh-host-apiproxy session-search.ts, design 06 §1.1); only
 * the hasMore copy renders it; the wire caps the actual page.
 */

/** Stable per-source accent: deterministic hue hash of the source id (05 §2). */
function sourceHue(sourceId: string): number {
  let hash = 0
  for (let i = 0; i < sourceId.length; i += 1) hash = (hash * 31 + sourceId.charCodeAt(i)) >>> 0
  return hash % 360
}

/** Remote sources carry the derived accent; the local source keeps the default dot. */
function sourceDotStyle(server: ChamberServerAggregate): CSSProperties | undefined {
  if (server.kind === 'local') return undefined
  return { backgroundColor: `hsl(${sourceHue(server.id)} 65% 52%)` }
}

/**
 * Per-element accent CSS variable for the active source/session left inset:
 * the remote source's hue string, omitted for the local source so the CSS
 * falls back to the default ink (visual audit P2-3).
 */
function sourceAccentStyle(server: ChamberServerAggregate): { '--dsh-source-accent': string } | undefined {
  const dot = sourceDotStyle(server)
  return dot === undefined ? undefined : { '--dsh-source-accent': dot.backgroundColor ?? '' }
}

/** Connection-status visual kind: dot colors plus the connecting spinner. */
type SourceStatusKind = 'ok' | 'busy' | 'err' | 'idle'

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

/** In-progress inline rename target. */
interface RenameTarget {
  sourceId: string
  kind: 'session' | 'workspace'
  id: string
  value: string
}

/**
 * Region-scoped error boundary around the chamber list (design 05 §2): an
 * unexpected render error — e.g. an interaction state (drag) meeting a
 * malformed projection — must never take the whole shell (and with it the
 * app) down. The column shell stays intact; the list region shows the error
 * text inline, which both keeps the UI alive and surfaces the root cause to
 * the user instead of a blank. The region remounts on the next sidebar
 * expand/collapse cycle, which clears the boundary.
 */
class ChamberListBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  constructor(props: { children: ReactNode }) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error: Error): { error: Error | null } {
    return { error }
  }

  render(): ReactNode {
    if (this.state.error !== null) {
      return <div className={cc.boundaryError} role="alert">{String(this.state.error.message || this.state.error)}</div>
    }
    return this.props.children
  }
}

/** In-flight session-row drag: source identity plus the current insert marker (06 §2.2). */
interface SessionDragState {
  /** Source the drag started in — cross-source drops are structurally impossible. */
  sourceId: string
  /** Workspace id, or the ungrouped bucket id for the source-local loose-session account. */
  accountKey: string
  sessionId: string
  /** Row the marker sits on and which half (insert above/below it). */
  over: { id: string; half: 'before' | 'after' } | null
}

/** In-flight real-workspace drag: source identity plus the current marker (06 §2.2). */
interface WorkspaceDragState {
  sourceId: string
  workspaceId: string
  over: { id: string; half: 'before' | 'after' } | null
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

/**
 * Accept the native drag at document level while any row drag is active (06
 * §2.2, official useNativeDragAcceptance port): row hover still owns the
 * insertion marker, and releasing outside the list must not be rendered as a
 * rejected drop before dragend commits that last marker.
 */
function useNativeDragAcceptance(active: boolean): void {
  useEffect(() => {
    if (!active) return
    const acceptDrag = (event: DragEvent): void => {
      event.preventDefault()
      if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'move'
    }
    const acceptDrop = (event: DragEvent): void => { event.preventDefault() }
    document.addEventListener('dragover', acceptDrag)
    document.addEventListener('drop', acceptDrop)
    return () => {
      document.removeEventListener('dragover', acceptDrag)
      document.removeEventListener('drop', acceptDrop)
    }
  }, [active])
}

/** Render the sidebar column shell. */
export function SidebarRoot({
  collapsed,
  width,
  startSession,
  toggleSidebar,
  chamberInstanceId,
  directoryBrowserT,
  t,
  renderSlot,
}: SidebarRootComponentProps) {
  // Wide content stays mounted while the collapse animates (fading via
  // .collapsed .wide), unmounts at settle, and remounts right away on expand.
  const [settled, setSettled] = useState(collapsed)
  useEffect(() => {
    if (!collapsed) { setSettled(false); return }
    const timer = window.setTimeout(() => { setSettled(true) }, COLLAPSE_SETTLE_MS)
    return () => { window.clearTimeout(timer) }
  }, [collapsed])
  const wide = !collapsed || !settled

  // Freeze the content at its expanded width while it fades out (collapsed
  // && wide): the sliding column then clips it instead of reflowing it. The
  // rail layout (.collapsed styles) only applies once the fade settles.
  const lastWideWidth = useRef(width)
  if (!collapsed) lastWideWidth.current = width

  // Rail-in only crossfades a live collapse: a refresh straight into the
  // collapsed state renders the rail statically (no delay-hidden icons).
  const everWide = useRef(!collapsed)
  if (!collapsed) everWide.current = true

  // Scrollbars in the column follow the pointer (.quietBars rebinds them
  // away): drawn while it is inside, and for SCROLLBAR_LINGER_MS after it
  // leaves. A pointer that returns within that window cancels the pending
  // hide rather than restarting from a hidden bar.
  const column = useRef<HTMLDivElement>(null)
  const [pointerInside, setPointerInside] = useState(false)
  const lingerTimer = useRef<number | undefined>(undefined)
  const armLinger = (): void => {
    if (lingerTimer.current !== undefined) return
    lingerTimer.current = window.setTimeout(() => {
      lingerTimer.current = undefined
      setPointerInside(false)
    }, SCROLLBAR_LINGER_MS)
  }
  const cancelLinger = (): void => {
    window.clearTimeout(lingerTimer.current)
    lingerTimer.current = undefined
  }
  // Leaving is decided by the column's BOX, not by DOM containment, and only
  // while the bars are drawn. ui-settings renders its full-viewport panel as a
  // fixed-position DESCENDANT of this column, so a pointer moved onto that
  // panel — or onto the conversation once it closes — fires no `pointerleave`
  // here, and the bars would stay drawn over a column nobody is pointing at.
  // The element's own leave stays as the one signal geometry cannot give: a
  // pointer that leaves the window emits no further moves.
  useEffect(() => {
    if (!pointerInside) return
    const onMove = (event: PointerEvent): void => {
      const rect = column.current?.getBoundingClientRect()
      if (rect === undefined) return
      const inside = event.clientX >= rect.left && event.clientX < rect.right
        && event.clientY >= rect.top && event.clientY < rect.bottom
      if (inside) cancelLinger()
      else armLinger()
    }
    document.addEventListener('pointermove', onMove)
    return () => {
      document.removeEventListener('pointermove', onMove)
      cancelLinger()
    }
  }, [pointerInside])

  // chamber: the multi-source projection (05 §3) — the App layer publishes
  // it on its poll cycle (now signature-gated, see App.tsx); this shell just
  // subscribes and re-renders. Defense in depth: the subscription re-checks
  // the render-relevant signature before setState, so even an ungated
  // publisher can never make this list re-render on unchanged content
  // (mirrors the settings bridge's subscribeServers dedupe).
  //
  // The dedupe baseline is the CURRENTLY RENDERED state (mirrored in a ref,
  // not getServers()): a publish landing in the window between useState's
  // initializer and this effect's subscribe would otherwise be treated as
  // "already seen" (its signature would match the post-publish getServers())
  // and the list would stay stale forever — the App's publish gate never
  // re-emits unchanged content, so there would be no later self-heal.
  // Comparing against the rendered state makes that first mid-window publish
  // apply, while identical content stays a no-op.
  const [servers, setServers] = useState<ChamberServerAggregate[]>(() => chamberBridge.getServers())
  const serversRef = useRef(servers)
  serversRef.current = servers
  useEffect(() => {
    return chamberBridge.subscribe(() => {
      const next = chamberBridge.getServers()
      if (serversProjectionSignature(next) === serversProjectionSignature(serversRef.current)) return
      setServers(next)
    })
  }, [])

  // chamber (06 §3, 2026-08 — cross-ctx live sync): view preferences (folded
  // workspace groups + the ungrouped session order) live in ONE shared
  // in-memory store (shared/view-prefs.ts) backed by localStorage. Every ctx's
  // sidebar reads the same store instance (vite shared chunk), so a fold
  // toggle in ANY source's sidebar propagates live to every other source's
  // sidebar — no per-ctx stale copy, no write-back resurrecting another ctx's
  // newer state. Writes persist + notify all subscribers; this component just
  // mirrors the store into local state for rendering.
  const [viewPrefs, setViewPrefs] = useState<ChamberSidebarViewPrefs>(() => getViewPrefs())
  useEffect(() => subscribeViewPrefs(() => { setViewPrefs(getViewPrefs()) }), [])

  const toggleWorkspaceFold = (serverId: string, workspaceId: string): void => {
    const key = `${serverId}/${workspaceId}`
    updateViewPrefs((prev) => {
      const folded = { ...prev.folded }
      if (folded[key] === true) delete folded[key]
      else folded[key] = true
      return { ...prev, folded }
    })
  }

  // chamber (06 §3.1): per-source session sort toggle (manual ↔ updated). The
  // choice lives in the shared view prefs (`orderBy` keyed by sourceId,
  // default manual); a click cycles to the other mode. P2-5: 切换即丢弃该来源
  // 的全部会话级 override——updated 模式下拖拽的 override 无 wire 背书、永远
  // 不会被确认，若不随模式切换清掉，切回 manual 后它会成为永久孤儿 override
  // （显示序脱离 wire 序且不自愈）；manual 模式下尚未被投影确认的乐观序同样
  // 随切换作废（wire 序或 updated 排序接管，提交本身不受影响）。
  const toggleSessionSort = (server: ChamberServerAggregate): void => {
    const next = viewPrefs.orderBy?.[server.id] === 'updated' ? 'manual' : 'updated'
    updateViewPrefs(prev => ({ ...prev, orderBy: { ...prev.orderBy, [server.id]: next } }))
    const prefix = `${server.id}/`
    setSessionOrderOverride(prev => {
      const hasAny = Object.keys(prev).some(key => key.startsWith(prefix))
      if (!hasAny) return prev
      const nextOverrides: Record<string, string[]> = {}
      for (const [key, override] of Object.entries(prev)) {
        if (key.startsWith(prefix)) continue
        nextOverrides[key] = override
      }
      return nextOverrides
    })
  }

  // chamber (06 §2.2): transient optimistic order overrides, applied at
  // render over the projection while the wire commit is in flight. Cleared
  // PER KEY against each fresh projection — never wholesale: a poll that has
  // not yet seen the commit must not flash the optimistic order back (a
  // manual-mode override drops only when the confirming pull proves the
  // commit). A key drops when its workspace vanished, the projection order
  // now equals the override (commit confirmed), or the membership differs
  // (a row was deleted meanwhile); it survives while only the ORDER differs
  // (stale poll data). updated 模式的拖拽 override 是瞬态（P2-5）：拖拽只落
  // override、不提交 wire，wire 永远无法确认它——下一次**内容变化**的投影
  // （servers state 变化）即丢（下方 updated 分支；App publish 签名闸下内容
  // 不变的轮询不改变 servers state、effect 不重跑，故精确语义是"内容变化的
  // 投影"），不再有旧注释的"自愈"一说；否则该工作区会永久用 override 序
  // 绕过 updated 排序。
  const [sessionOrderOverride, setSessionOrderOverride] = useState<Record<string, string[]>>({})
  const [workspaceOrderOverride, setWorkspaceOrderOverride] = useState<Record<string, string[]>>({})
  useEffect(() => {
    const serversById = new Map(servers.map(server => [server.id, server]))
    setSessionOrderOverride(prev => {
      let changed = false
      const next: Record<string, string[]> = {}
      for (const [key, override] of Object.entries(prev)) {
        const slash = key.indexOf('/')
        const server = serversById.get(key.slice(0, slash))
        const workspace = server === undefined
          ? undefined
          : server.workspaces.find(candidate => candidate.id === key.slice(slash + 1))
        const wireIds = workspace === undefined ? undefined : workspace.sessions.map(session => session.id)
        // P2-5: updated 模式（含拖拽后才切到 updated 的来源）的 override 直接
        // 丢弃——不提交 wire 的 override 永远等不到确认，等确认只会让该工作区
        // 永久脱离 updated 排序。manual 模式仍按 wire 确认核对。
        if (server !== undefined && (viewPrefs.orderBy?.[server.id] ?? 'manual') === 'updated') {
          changed = true
          continue
        }
        const orderEqual = wireIds !== undefined
          && wireIds.length === override.length
          && wireIds.every((id, index) => override[index] === id)
        const membershipEqual = wireIds !== undefined
          && wireIds.length === override.length
          && override.every(id => wireIds.includes(id))
        if (wireIds === undefined || orderEqual || !membershipEqual) {
          changed = true
          continue
        }
        next[key] = override
      }
      return changed ? next : prev
    })
    setWorkspaceOrderOverride(prev => {
      let changed = false
      const next: Record<string, string[]> = {}
      for (const [sourceId, override] of Object.entries(prev)) {
        const server = serversById.get(sourceId)
        const wireIds = server === undefined
          ? undefined
          : server.workspaces.filter(workspace => workspace.ungrouped !== true).map(workspace => workspace.id)
        const orderEqual = wireIds !== undefined
          && wireIds.length === override.length
          && wireIds.every((id, index) => override[index] === id)
        const membershipEqual = wireIds !== undefined
          && wireIds.length === override.length
          && override.every(id => wireIds.includes(id))
        if (wireIds === undefined || orderEqual || !membershipEqual) {
          changed = true
          continue
        }
        next[sourceId] = override
      }
      return changed ? next : prev
    })
  }, [servers])

  // chamber (06 §1.2, 2026-08 — cross-ctx live sync): per-source search state
  // (capsule/query/results) AND the debounced fetch jobs live in ONE shared
  // controller (shared/search-state.ts) — the same instance every ctx's
  // sidebar sees through the vite shared chunk. A search started in ANY
  // source's sidebar survives view switches (the visible sidebar changes
  // shell, the shared state does not); a single owner arms the jobs, so
  // shells never duplicate fetches. This component only mirrors the state for
  // rendering and owns the DOM refs (capsule root / input / button for
  // outside-click containment + focus).
  const [searchState, setSearchState] = useState<ReadonlyMap<string, SourceSearchState>>(() => getSearchStates())
  useEffect(() => subscribeSearch(() => { setSearchState(getSearchStates()) }), [])
  const searchRoots = useRef<Record<string, HTMLDivElement | null>>({})
  const searchInputs = useRef<Record<string, HTMLInputElement | null>>({})
  const searchButtons = useRef<Record<string, HTMLButtonElement | null>>({})

  // Outside-click closes an expanded capsule only while its query is empty
  // (official semantics): a non-empty query must not silently drop the
  // in-progress filter. The search button itself is outside the capsule root
  // (it lives in the source header), so it is containment-checked too —
  // otherwise a click on it would expand and immediately re-collapse.
  useEffect(() => {
    if (!wide) return
    const onClick = (event: MouseEvent): void => {
      if (!(event.target instanceof Node)) return
      for (const server of servers) {
        const state = searchState.get(server.id)
        if (state === undefined || state.expanded !== true) continue
        const root = searchRoots.current[server.id]
        if (root !== null && root !== undefined && root.contains(event.target)) continue
        const button = searchButtons.current[server.id]
        if (button !== null && button !== undefined && button.contains(event.target)) continue
        if (sanitizeSearchQuery(state.query) !== '') continue
        collapseSearch(server.id)
      }
    }
    document.addEventListener('click', onClick)
    return () => { document.removeEventListener('click', onClick) }
  }, [wide, servers, searchState])

  // chamber (06 §2.2): in-source drag state. Cross-source drops are
  // structurally impossible — every target handler is gated on the drag's
  // sourceId matching the hovered group's source.
  const [sessionDrag, setSessionDrag] = useState<SessionDragState | null>(null)
  const [workspaceDrag, setWorkspaceDrag] = useState<WorkspaceDragState | null>(null)
  const sessionDropCommitted = useRef(false)
  const workspaceDropCommitted = useRef(false)
  // Some browsers dispatch a trailing `click` after an aborted drag or a
  // drop; the flag set on dragstart (and cleared a tick after dragend) keeps
  // that click from opening the session the row no longer represents (P2-8).
  const suppressClickRef = useRef(false)
  useNativeDragAcceptance(sessionDrag !== null || workspaceDrag !== null)

  // chamber (06, P2-11): double-click rename. A row's single click is DELAYED
  // ~350ms (DOUBLE_CLICK_WINDOW_MS; raised from 250ms — the old threshold was
  // too aggressive: a slow double click / trackpad tap was misjudged as a
  // second click and jumped into inline rename) — a second click within the
  // window cancels the pending action and enters inline rename; the timer
  // expiring fires the action. ONE shared pending slot (keyed by the target
  // session id, holding the clicked row's DOM node): rows are many, the
  // pending count is at most one, and a fresh click always supersedes an
  // older pending. Cancellation is document-wide (P2-11): a click anywhere
  // OUTSIDE the pending row (not the row, not its inner buttons) drops the
  // pending — the session never opens after the user has moved their
  // attention elsewhere; row-internal buttons (kebab/archive) clear it in
  // their own handlers (stopPropagation + clearPendingClick). suppressClickRef
  // is honored on the way in AND in the timer callback — a drag-end trailing
  // click never arms, and a drag started between click and expiry never opens.
  const DOUBLE_CLICK_WINDOW_MS = 350
  const pendingClickRef = useRef<{ key: string; timer: number; row: HTMLElement | null } | null>(null)
  const clearPendingClick = (): void => {
    if (pendingClickRef.current === null) return
    window.clearTimeout(pendingClickRef.current.timer)
    pendingClickRef.current = null
  }
  useEffect(() => () => {
    if (pendingClickRef.current !== null) window.clearTimeout(pendingClickRef.current.timer)
  }, [])
  // P2-11: pending 期间的行外点击取消。点击发生在 pending 行内部时不动
  // （行内按钮已自行 clearPendingClick；行本身再次点击由行 onClick 的双击
  // 逻辑接管——行 onClick 先于 document 监听触发，pending 已被消费/替换）。
  // 点击行外任意位置即取消 pending，绝不延迟弹出被用户放弃的会话。
  useEffect(() => {
    const onDocumentClick = (event: MouseEvent): void => {
      const pending = pendingClickRef.current
      if (pending === null) return
      if (!(event.target instanceof Node)) return
      if (pending.row !== null && pending.row.contains(event.target)) return
      clearPendingClick()
    }
    document.addEventListener('click', onDocumentClick)
    return () => { document.removeEventListener('click', onDocumentClick) }
  }, [])

  // Hover-action state: the inline rename target, the per-row failure text,
  // the open kebab menus (keyed by workspace/session), and the add-workspace
  // directory-browser dialog (target source + whether the workspace.create
  // confirm is in flight — the dialog's busy freeze).
  const [renaming, setRenaming] = useState<RenameTarget | null>(null)
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})
  const [menuOpen, setMenuOpen] = useState<Record<string, boolean>>({})
  const toggleMenu = (key: string): void => {
    setMenuOpen(prev => ({ ...prev, [key]: prev[key] !== true }))
  }
  const closeMenu = (key: string): void => {
    setMenuOpen(prev => {
      if (prev[key] !== true) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })
  }
  const [addingWorkspace, setAddingWorkspace] = useState<string | null>(null)
  const [addingWorkspaceBusy, setAddingWorkspaceBusy] = useState(false)

  const runAction = (key: string, action: () => Promise<void>): void => {
    setRowErrors((prev) => {
      const next = { ...prev }
      delete next[key]
      return next
    })
    action().catch((reason: unknown) => {
      const message = reason instanceof Error ? reason.message : String(reason)
      setRowErrors((prev) => ({ ...prev, [key]: message }))
    })
  }

  const openSession = (serverId: string, sessionId: string): void => {
    chamberBridge.requestOpenSession(serverId, sessionId)
  }

  /** chamber (06): localized hover-card relative time ("刚刚"/"5分钟前" zh; "now"/"5min ago" en). */
  const hoverTimeLabel = (updatedAt: number, now: number): string => {
    const { unit, n } = relativeTimeBucket(updatedAt, now)
    return unit === 'now' ? t('time.now') : t('time.ago', { t: t(`time.${unit}`, { n }) })
  }

  // chamber (06): fork a session at its last completed turn, refresh, and
  // open the child — the official row-menu fork→open flow (设计 06 §0 原判
  // 「回合尾部 forkAt 覆盖、侧边栏不做」本轮契约反转：行内 kebab 增加分叉入口).
  // P1-4: wire session.fork 只收 { sessionId, atSeq? }（increaseTitle 非 wire
  // 字段），子会话标题 = 源标题；chamber 侧按官方 runtime service 移植的
  // increasedForkTitle 在 fork 成功后对子会话做标题递增 rename（经该来源
  // unary client）。递增失败非致命：fork 已成功、子会话已创建并打开（下方
  // requestRefresh/requestOpenSession 照常执行），仅标题不递增——inline
  // rowErrors 不阻断（runAction 只吃 fork 自身的失败）。
  const onForkSession = (server: ChamberServerAggregate, session: { id: string; title: string }): void => {
    runAction(`${server.id}/session/${session.id}/fork`, async () => {
      const client = getInstanceClient(server.id)
      const childId = await forkSession(client, session.id)
      if (session.title !== '') {
        try {
          await renameSession(client, childId, increasedForkTitle(session.title))
        } catch {
          // 非致命：fork 已成功，仅子会话标题不递增。
        }
      }
      chamberBridge.requestRefresh(server.id)
      chamberBridge.requestOpenSession(server.id, childId)
    })
  }

  const onNewSession = (server: ChamberServerAggregate, workspaceId: string): void => {
    runAction(`${server.id}/workspace/${workspaceId}/new`, async () => {
      const client = getInstanceClient(server.id)
      const sessionId = await createSession(client, workspaceId)
      // 05 §2.2: created under this workspace, then open it on that source.
      // The App layer re-pulls the snapshot so the new session shows here.
      chamberBridge.requestRefresh(server.id)
      chamberBridge.requestOpenSession(server.id, sessionId)
    })
  }

  const onArchiveSession = (server: ChamberServerAggregate, sessionId: string, title: string): void => {
    if (!window.confirm(t('confirm.archive', { title }))) return
    runAction(`${server.id}/session/${sessionId}/archive`, async () => {
      await archiveSession(getInstanceClient(server.id), sessionId)
      chamberBridge.requestRefresh(server.id)
    })
  }

  const onDeleteWorkspace = (server: ChamberServerAggregate, workspaceId: string, title: string): void => {
    if (!window.confirm(t('confirm.delete', { title }))) return
    runAction(`${server.id}/workspace/${workspaceId}/delete`, async () => {
      await deleteWorkspace(getInstanceClient(server.id), workspaceId)
      chamberBridge.requestRefresh(server.id)
    })
  }

  const commitRename = (): void => {
    if (renaming === null) return
    const target = renaming
    setRenaming(null)
    runAction(`${target.sourceId}/${target.kind}/${target.id}/rename`, async () => {
      const client = getInstanceClient(target.sourceId)
      if (target.kind === 'session') await renameSession(client, target.id, target.value)
      else await renameWorkspace(client, target.id, target.value)
      chamberBridge.requestRefresh(target.sourceId)
    })
  }

  const renameForm = (sourceId: string, kind: RenameTarget['kind'], id: string, placeholder: string, nested = false) => (
    <form
      className={clsx(cc.inlineForm, nested && cc.sessionNested)}
      onClick={(event) => event.stopPropagation()}
      onSubmit={(event) => { event.preventDefault(); commitRename() }}
    >
      <input
        className={cc.inlineInput}
        autoFocus
        placeholder={placeholder}
        value={renaming?.value ?? ''}
        onChange={(event) => setRenaming((prev) => prev === null ? prev : { ...prev, value: event.target.value })}
        onKeyDown={(event) => { if (event.key === 'Escape') setRenaming(null) }}
      />
      <button type="submit" className={cc.actionButton}>{t('action.save')}</button>
      <button type="button" className={cc.actionButton} onClick={() => setRenaming(null)}>{t('action.cancel')}</button>
    </form>
  )

  // Add-workspace directory browser (05 §4, unified in-app dialog): the
  // dialog drives the browsing source's own unary client (host.listDirectory
  // / host.createDirectory — the browse capability every managed host
  // serves). The browse calls are useCallback-stabilized: the vendor dialog
  // resets its whole navigation on every change of its `navigate` closure,
  // and this shell re-renders on every chamberBridge publish (status pushes
  // + the 10s aggregate poll), so an inline arrow would wipe the user's
  // browsing every poll. A
  // confirmed path commits workspace.create against that source; failures
  // close the dialog and surface inline (never hidden behind the modal
  // mask), never silently.
  const browseClient = useMemo(
    () => (addingWorkspace === null ? null : getInstanceClient(addingWorkspace)),
    [addingWorkspace],
  )
  const browseListDirectory = useCallback(
    (path: string | undefined, signal?: AbortSignal) => {
      if (browseClient === null) return Promise.reject(new Error('no instance'))
      return listHostDirectory(browseClient, path, signal)
    },
    [browseClient],
  )
  const browseCreateDirectory = useCallback(
    (path: string, name: string) => {
      if (browseClient === null) return Promise.reject(new Error('no instance'))
      return createHostDirectory(browseClient, path, name)
    },
    [browseClient],
  )
  const browsePick = useCallback(
    (path: string) => {
      const sourceId = addingWorkspace
      if (sourceId === null || browseClient === null) return
      setAddingWorkspaceBusy(true)
      const key = `${sourceId}/add-workspace`
      setRowErrors((prev) => {
        const next = { ...prev }
        delete next[key]
        return next
      })
      createWorkspace(browseClient, path)
        .then(() => {
          setAddingWorkspace(null)
          chamberBridge.requestRefresh(sourceId)
        })
        .catch((reason: unknown) => {
          const message = reason instanceof Error ? reason.message : String(reason)
          setRowErrors((prev) => ({ ...prev, [key]: message }))
          setAddingWorkspace(null)
        })
        .finally(() => {
          setAddingWorkspaceBusy(false)
        })
    },
    [addingWorkspace, browseClient],
  )
  const browseClose = useCallback(() => {
    setAddingWorkspace(null)
    setAddingWorkspaceBusy(false)
  }, [])

  // chamber (06 §2.2): session-row drag commit. The anchor resolves from the
  // CURRENT rendered order (override-first), never the projection; ungrouped
  // commits persist locally through view prefs, real workspaces commit over
  // the wire with an optimistic override that the next pull replaces.
  const commitSessionDrag = (
    server: ChamberServerAggregate,
    activeDrag: SessionDragState,
    over: NonNullable<SessionDragState['over']>,
  ): void => {
    if (sessionDropCommitted.current) return
    sessionDropCommitted.current = true
    setSessionDrag(null)
    const workspace = server.workspaces.find(candidate => candidate.id === activeDrag.accountKey)
    if (workspace === undefined) return
    const wireIds = workspace.sessions.map(session => session.id)
    const renderedOrder = workspace.ungrouped === true
      ? reconciledSessionOrder(viewPrefs.ungroupedOrder[server.id] ?? [], wireIds)
      : sessionOrderOverride[`${server.id}/${workspace.id}`] ?? wireIds
    const targetIndex = renderedOrder.findIndex(id => id === over.id)
    if (targetIndex === -1) return
    const anchor = over.half === 'before' ? over.id : renderedOrder[targetIndex + 1]
    if (anchor === activeDrag.sessionId) return
    const sourceIndex = renderedOrder.findIndex(id => id === activeDrag.sessionId)
    const anchorIndex = anchor === undefined ? renderedOrder.length : renderedOrder.findIndex(id => id === anchor)
    if (sourceIndex !== -1 && (anchorIndex === sourceIndex || anchorIndex === sourceIndex + 1)) return
    const nextOrder = renderedOrder.filter(id => id !== activeDrag.sessionId)
    const insertAt = anchor === undefined ? nextOrder.length : nextOrder.indexOf(anchor)
    nextOrder.splice(insertAt === -1 ? nextOrder.length : insertAt, 0, activeDrag.sessionId)
    if (workspace.ungrouped === true) {
      updateViewPrefs(prev => ({ ...prev, ungroupedOrder: { ...prev.ungroupedOrder, [server.id]: nextOrder } }))
      return
    }
    setSessionOrderOverride(prev => ({ ...prev, [`${server.id}/${workspace.id}`]: nextOrder }))
    // updated 模式拖拽对齐官方（ui-workspace commitSessionDrag 在
    // orderBy==='updated' 时只写本地序、跳过 insertSessionBefore）：只落乐观
    // override，不提交 wire、不 requestRefresh——wire 序由 updated 排序接管；
    // 该 override 是瞬态（P2-5）：下一次投影到达（servers 变化）时由清理
    // effect 直接丢弃（wire 永远无法确认它，旧注释的"自愈"不成立）。
    if (viewPrefs.orderBy?.[server.id] === 'updated') return
    runAction(`${server.id}/session-drag/${activeDrag.sessionId}`, async () => {
      try {
        await insertSessionBefore(getInstanceClient(server.id), workspace.id, activeDrag.sessionId, anchor)
        chamberBridge.requestRefresh(server.id)
      } catch (error) {
        // A failed commit must not keep masquerading as committed: drop the
        // optimistic override immediately, the projection shows wire truth.
        setSessionOrderOverride(prev => {
          const next = { ...prev }
          delete next[`${server.id}/${workspace.id}`]
          return next
        })
        throw error
      }
    })
  }

  // chamber (06 §2.2): real-workspace drag commit — same anchor math over the
  // real workspace list (the ungrouped bucket has no wire identity and is
  // neither draggable nor a target).
  const commitWorkspaceDrag = (
    server: ChamberServerAggregate,
    activeDrag: WorkspaceDragState,
    over: NonNullable<WorkspaceDragState['over']>,
  ): void => {
    if (workspaceDropCommitted.current) return
    workspaceDropCommitted.current = true
    setWorkspaceDrag(null)
    const realWorkspaces = server.workspaces.filter(workspace => workspace.ungrouped !== true)
    const targetIndex = realWorkspaces.findIndex(workspace => workspace.id === over.id)
    if (targetIndex === -1) return
    const anchor = over.half === 'before' ? over.id : realWorkspaces[targetIndex + 1]?.id
    if (anchor === activeDrag.workspaceId) return
    const renderedOrder = workspaceOrderOverride[server.id] ?? realWorkspaces.map(workspace => workspace.id)
    const sourceIndex = renderedOrder.findIndex(id => id === activeDrag.workspaceId)
    const anchorIndex = anchor === undefined ? renderedOrder.length : renderedOrder.findIndex(id => id === anchor)
    if (sourceIndex !== -1 && (anchorIndex === sourceIndex || anchorIndex === sourceIndex + 1)) return
    const nextOrder = renderedOrder.filter(id => id !== activeDrag.workspaceId)
    const insertAt = anchor === undefined ? nextOrder.length : nextOrder.indexOf(anchor)
    nextOrder.splice(insertAt === -1 ? nextOrder.length : insertAt, 0, activeDrag.workspaceId)
    setWorkspaceOrderOverride(prev => ({ ...prev, [server.id]: nextOrder }))
    runAction(`${server.id}/workspace-drag/${activeDrag.workspaceId}`, async () => {
      try {
        await insertWorkspaceBefore(getInstanceClient(server.id), activeDrag.workspaceId, anchor)
        chamberBridge.requestRefresh(server.id)
      } catch (error) {
        // A failed commit must not keep masquerading as committed: drop the
        // optimistic override immediately, the projection shows wire truth.
        setWorkspaceOrderOverride(prev => {
          const next = { ...prev }
          delete next[server.id]
          return next
        })
        throw error
      }
    })
  }

  // chamber (06 §4.3, revised 2026-08): per-row STATE indicator — the leading
  // slot is NOT a server-identity marker (the source header dot owns
  // identity). Normal sessions show nothing; running sessions show the
  // official StateDot ongoing RING; completed-but-unread sessions show a
  // persistent DOT. Pending interactions (approval / plan-review / question)
  // render a distinguishable 14px icon badge INSTEAD of the running ring — a
  // session waiting for the user must be recognizable at a glance (question
  // `?`, plan-review checklist, approval warning triangle; the ask-user state
  // is the plan's motivating case). The caller wraps the result in the fixed
  // 10px slot so titles stay aligned (pending rows widen the slot to 14px).
  // Priority (both functions below): pending > runningSubagents > completed
  // > running — live channel facts first (pending interaction, subagent
  // liveness, completion), the 10s-polled running bit last (see the inline
  // comments for the channel-truth rationale).
  // 2026-08 (remote completed-dot fix): `completed` comes from the LIVE
  // runtime channel while `running` comes from the 10s aggregate poll — the
  // two can disagree right after a completion (the aggregate lags up to a
  // poll cycle, longer when its pulls fail). The completed dot is the
  // channel truth (the vendor disarms the reminder while running), so it
  // outranks a stale running ring; the ring shows only when no completion
  // fact exists. 2026-08 (running-subagent fix, 06 §4.5): the official
  // sessionStatuses renders a session whose round ended but whose BACKGROUND
  // subagents still work as ONGOING (runningSubagentCount outranks
  // node.completed) — a parent's own running bit goes false the moment its
  // round returns, so the App-armed completed dot would light up blue while
  // the children are still at work. `runningSubagents` (live channel, vendor
  // lineage index) therefore outranks the completed dot AND the stale polled
  // running ring — live facts (pending > runningSubagents > completed) beat
  // the 10s poll, the established channel-truth rule.
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
    // P2-9: 实时通道优先（06 §4.3「实时通道为真」）——channel 的 running 位
    // （每会话全量投影）胜过 10s 聚合轮询位，轮询可能滞后一个周期。
    const running = facts?.running ?? session.running
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
    // P2-9: 实时通道优先（06 §4.3）——channel running 位胜过轮询位。
    const running = facts?.running ?? session.running
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
      return <span className={cc.stateCompleted} />
    }
    return <StateDot state="ongoing" size={10} />
  }

  // chamber (06): hover-card relative times share one render-time clock.
  const now = Date.now()

  return (
    <div
      ref={column}
      className={clsx(
        css.root, !wide && css.collapsed, !wide && everWide.current && css.railIn,
        collapsed && wide && css.fading, !pointerInside && css.quietBars,
      )}
      style={wide ? { width: collapsed ? lastWideWidth.current : width } : undefined}
      onPointerEnter={() => {
        cancelLinger()
        setPointerInside(true)
      }}
      onPointerLeave={() => { armLinger() }}
    >
      <div className={css.logoRow}>
        {/* Expanded, the wordmark doubles as a New Session shortcut; the
            collapsed rail's logo is the expand toggle below instead. */}
        {wide && (
          <button
            type="button"
            className={clsx(css.brand, css.wide)}
            aria-label={t('session.new.label')}
            onClick={() => { startSession() }}
          >
            <BrandWordmark />
          </button>
        )}
        {/* Rail resting state is the whale mark; hovering swaps in the panel
            icon (the expand affordance). */}
        <Tooltip label={collapsed ? t('toggle.open') : t('toggle.collapse')} delayMs={500}>
          <button
            type="button"
            className={clsx(css.iconButton, css.toggle)}
            aria-label={collapsed ? t('toggle.open') : t('toggle.collapse')}
            onClick={() => { toggleSidebar() }}
          >
            {!wide && <FishLogo className={css.railFish} size={24} />}
            {/* Rail icons render at 18 (figma rail spec); expanded keeps the glyph-native sizes. */}
            <IconPanelLeftOutline16 className={css.panelIcon} size={wide ? 16 : 18} />
          </button>
        </Tooltip>
      </div>

      {/* Expanded, the button carries its own label — tooltip only on the rail. */}
      <Tooltip label={t('session.new.label')} delayMs={500} disabled={wide}>
        <button
          type="button"
          className={css.newSession}
          aria-label={t('session.new.label')}
          onClick={() => { startSession() }}
        >
          <IconNewChatOutline16 size={wide ? 14 : 18} />
          {wide && <span className={clsx(css.newSessionLabel, css.wide)}>{t('session.new')}</span>}
        </button>
      </Tooltip>

      {/* The browsing region fills the column between the controls and the
          foot in both states. chamber patch: the multi-source session list
          replaces the official `sidebar.workspaces` occupant. The list is
          wrapped in a region boundary — an unexpected render error must not
          take the shell (or the app) down. */}
      <div className={css.regionArea}>
        <ChamberListBoundary>
        {wide ? (
          <div className={cc.chamberList}>
            {servers.map((server) => {
              // chamber (06 §1.2): per-source search read from the shared
              // controller (survives view switches). The state's query is the
              // sanitized current value by construction; the loading fallback
              // covers the expand-without-query render pass defensively.
              const search = searchState.get(server.id)
              const query = sanitizeSearchQuery(search?.query ?? '')
              const currentRemote = search !== undefined && search.query === query
                ? search
                : { query, status: 'loading' as const, items: [] as SearchRow[], hasMore: false }
              // chamber (06 §1.2 render-side merge): merge the source
              // aggregate's LOCAL metadata matches (title/workspace-label
              // substring over the visible projection) with the remote
              // content-search page — the official deriveSearchResults port.
              // P1-2: 远程腿按可见集过滤——投影已过滤 subagent/archived/
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
              )
              // chamber (06 §4): the current-session highlight is channel-based
              // — no direct store subscription — and single-selection: only the
              // source owning THIS visible ctx (the active view's shell) renders
              // its current-session highlight; the other sources' last-opened
              // sessions stay unhighlighted (one global selection marker).
              const currentId = server.id === chamberInstanceId ? server.runtime?.current : undefined
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
              // suppressed (official list-top drop treatment).
              const firstReal = server.workspaces.find(workspace => workspace.ungrouped !== true)
              const workspaceDropAtListStart = firstReal !== undefined
                && workspaceDrag !== null
                && workspaceDrag.sourceId === server.id
                && workspaceDrag.over !== null
                && workspaceDrag.over.id === firstReal.id
                && workspaceDrag.over.half === 'before'
              const workspaceDragMarker = (workspace: ChamberServerWorkspace): 'before' | 'after' | null => {
                if (workspace.ungrouped === true || workspaceDrag === null
                  || workspaceDrag.sourceId !== server.id || workspaceDrag.over === null) return null
                if (workspaceDrag.over.id !== workspace.id) return null
                if (workspaceDropAtListStart && workspace.id === firstReal?.id) return null
                return workspaceDrag.over.half
              }
              const sessionsOf = (workspace: ChamberServerWorkspace): ChamberServerWorkspace['sessions'] => {
                const wire = workspace.sessions
                const orderBy = viewPrefs.orderBy?.[server.id] ?? 'manual'
                // 会话级 override（拖拽乐观序）优先于 updated 排序——用户拖拽
                // 意图永远第一（06 §3.1）；updated 模式下 override 是瞬态（下次
                // 内容变化的投影即丢，P2-5），无 override 且 orderBy==='updated'
                // 时按 updatedAt 倒序。未分组桶顺序解析抽为纯函数
                // orderUngroupedSessions（P2-9，updated 按 recency 无视存储序、
                // manual 用存储序——与真实工作区 updated 行为一致，updated 排序
                // 接管一切）。
                if (workspace.ungrouped === true) {
                  return orderUngroupedSessions(wire, viewPrefs.ungroupedOrder[server.id], orderBy)
                }
                const override = sessionOrderOverride[`${server.id}/${workspace.id}`]
                if (override !== undefined) {
                  const byId = new Map(wire.map(session => [session.id, session]))
                  return override.flatMap(id => { const session = byId.get(id); return session === undefined ? [] : [session] })
                }
                return orderBy === 'updated' ? sortWorkspaceSessions(wire, orderBy) : wire
              }
              // Search-result titles resolve from the source aggregate (title
              // may lag the latest snapshot by one poll — accepted, 06 §1.2).
              const searchRowLabel = (sessionId: string): { title: string; workspaceLabel: string | undefined } => {
                for (const workspace of server.workspaces) {
                  const session = workspace.sessions.find(candidate => candidate.id === sessionId)
                  if (session === undefined) continue
                  return {
                    title: session.title || t('list.unnamed'),
                    workspaceLabel: workspace.ungrouped === true ? t('list.ungrouped') : workspace.title,
                  }
                }
                return { title: t('list.unnamed'), workspaceLabel: undefined }
              }
              // P2-9: 搜索结果行的 running 位来自投影（mergeSearchResults 的
              // visibleIds 过滤保证命中行一定在投影内，查得到即用投影位；查
              // 不到——防御——回落 false）。通道实时位由 sessionStateDot/
              // sessionStateLabel 内部 facts.running 优先接管。
              const projectedRunning = (sessionId: string): boolean => {
                for (const workspace of server.workspaces) {
                  const session = workspace.sessions.find(candidate => candidate.id === sessionId)
                  if (session === undefined) continue
                  return session.running === true
                }
                return false
              }
              return (
              <section key={server.id} className={cc.sourceGroup} role="group" aria-label={server.label}>
                <header
                  className={clsx(
                    cc.sourceHeader,
                    server.id === chamberInstanceId && cc.sourceActive,
                    server.id !== chamberInstanceId && cc.sourceHeaderClickable,
                  )}
                  style={sourceAccentStyle(server)}
                  title={server.id === chamberInstanceId ? undefined : t('list.activate')}
                  role={server.id === chamberInstanceId ? undefined : 'button'}
                  tabIndex={server.id === chamberInstanceId ? undefined : 0}
                  aria-label={server.id === chamberInstanceId ? undefined : t('list.activate')}
                  onClick={() => {
                    if (suppressClickRef.current) return
                    // A remote source's header switches the active N-ctx view
                    // without opening a session (App layer owns the switch).
                    if (server.id !== chamberInstanceId) chamberBridge.requestActivateSource(server.id)
                  }}
                  onKeyDown={(event) => {
                    if (server.id === chamberInstanceId) return
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      chamberBridge.requestActivateSource(server.id)
                    }
                  }}
                >
                  <span
                    className={clsx(cc.sourceDot)}
                    style={sourceDotStyle(server)}
                  />
                  <span className={cc.sourceLabel}>{server.label}</span>
                  {/* chamber: connection status as a dot/spinner — the phase
                      text is never rendered, only carried on hover/aria. */}
                  <span
                    className={cc.sourceStatus}
                    title={t(sourceStatusLabelKey(server))}
                    aria-label={t(sourceStatusLabelKey(server))}
                    role="status"
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
                  {/* chamber: header actions (add-workspace `+` + per-source
                      search) are hover-revealed like the session rows'
                      actions: at rest the connection status occupies the
                      right side; hovering the header swaps in the icon
                      cluster (visibility swap, no reflow). While a search
                      capsule is open the cluster stays visible
                      (.sourceActionsVisible) so the icon can collapse it. */}
                  <span
                    className={clsx(cc.sourceActions, search?.expanded === true && cc.sourceActionsVisible)}
                  >
                    {/* chamber (06 §3.1): per-source session sort toggle
                        (manual ↔ updated). The cycle lives in the shared view
                        prefs; aria-pressed carries the updated state. The
                        title shows the CURRENT mode (P2-5 — the pressed state
                        is also styled visibly in CSS). */}
                    {server.connected && (server.aggregateError === undefined || search?.expanded === true) && (
                      <button
                        type="button"
                        className={cc.actionIcon}
                        aria-label={t('action.sort')}
                        aria-pressed={viewPrefs.orderBy?.[server.id] === 'updated'}
                        title={`${t('action.sort')} · ${t(viewPrefs.orderBy?.[server.id] === 'updated' ? 'orderBy.updated' : 'orderBy.manual')}`}
                        onClick={(event) => {
                          event.stopPropagation()
                          if (suppressClickRef.current) return
                          toggleSessionSort(server)
                        }}
                      >
                        <IconPersonalizationOutline16 size={14} />
                      </button>
                    )}
                    {server.connected && (server.aggregateError === undefined || search?.expanded === true) && (
                      <button
                        type="button"
                        className={clsx(cc.actionIcon, cc.addWorkspace)}
                        aria-label={t('action.addWorkspace')}
                        title={t('action.addWorkspace')}
                        onClick={(event) => {
                          event.stopPropagation()
                          if (suppressClickRef.current) return
                          setAddingWorkspace(server.id)
                        }}
                      >
                        <IconPlusOutline16 size={14} />
                      </button>
                    )}
                    {server.connected && (server.aggregateError === undefined || search?.expanded === true) && (
                      <button
                        type="button"
                        className={cc.searchButton}
                        aria-label={t('search.sessions.aria')}
                        aria-expanded={search?.expanded === true}
                        ref={(node) => { searchButtons.current[server.id] = node }}
                        onClick={(event) => {
                          event.stopPropagation()
                          if (suppressClickRef.current) return
                          if (search?.expanded === true) {
                            // Toggle: an open capsule's icon collapses it (empty
                            // query) or just blurs the input (a non-empty query
                            // must not silently drop the in-progress filter).
                            if (query === '') {
                              collapseSearch(server.id)
                            } else {
                              searchInputs.current[server.id]?.blur()
                            }
                          } else {
                            expandSearch(server.id)
                            searchInputs.current[server.id]?.focus()
                          }
                        }}
                    >
                      <IconSearchOutline16 size={14} />
                    </button>
                    )}
                  </span>
                </header>
                {/* chamber (06 §1.2): the search capsule row beneath the header.
                    Escape clears and collapses; the clear button does the same. */}
                {search?.expanded === true && (
                  <div
                    ref={(node) => { searchRoots.current[server.id] = node }}
                    className={cc.searchCapsule}
                  >
                    <input
                      ref={(node) => { searchInputs.current[server.id] = node }}
                      className={cc.searchInput}
                      type="text"
                      maxLength={SEARCH_QUERY_MAX_CODE_UNITS}
                      placeholder={t('search.placeholder')}
                      value={search?.query ?? ''}
                      autoFocus
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
                        // P2-7: 拖拽尾随 click 守卫——dragend 后的合成 click
                        // 落在清除钮上不得清掉在途搜索（守卫控件清单补齐）。
                        if (suppressClickRef.current) return
                        clearSearch(server.id)
                      }}
                    >
                      <IconCloseOutline16 size={12} />
                    </button>
                  </div>
                )}
                {server.connected ? (
                  <div
                    className={cc.workspaceList}
                    // The browse list is one tree (official .list role="tree");
                    // an active query replaces it with the search-results tree
                    // (own role below), and the fetch-error branch renders no
                    // tree at all.
                    role={query === '' && server.aggregateError === undefined ? 'tree' : undefined}
                  >
                    {query !== '' ? (
                      // chamber (06 §1.2): an active query replaces the whole
                      // workspace list (header/status stay; fold and the
                      // add-workspace affordance are hidden while searching).
                      // The results branch outranks the snapshot-fetch error
                      // (06 §1.2): an open search keeps showing results even
                      // when a later pull fails — the aggregateError line
                      // renders BELOW the results (P2-7), so a content-search
                      // failure still shows the local metadata hits, with the
                      // error banner below them.
                      <>
                        <div className={cc.searchResults} role="tree" aria-label={t('search.results.aria')}>
                          {merged.items.map((item) => {
                            const resolved = searchRowLabel(item.sessionId)
                            // P2-9: 搜索行传投影 running 位（查不到回落
                            // false）；通道实时位由 sessionStateDot/Label 内部
                            // facts.running 优先接管。
                            const running = projectedRunning(item.sessionId)
                            const stateDot = sessionStateDot(server, { id: item.sessionId, running })
                            const stateLabel = sessionStateLabel(server, { id: item.sessionId, running })
                            return (
                              // P2-8: 行是 <button role="treeitem">（官方
                              // SearchResultItem 同款）——键盘可激活（Enter/
                              // 空格）；状态槽恒渲染（空态占位，标题对齐，
                              // 官方 slot 同款）。
                              <button
                                type="button"
                                key={item.sessionId}
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
                                    // P2-8: 空态不注册 live region（官方仅在有
                                    // 状态时放隐藏标签）——role 条件化避免 SR 噪音。
                                    role={stateDot !== null ? 'status' : undefined}
                                  >
                                    {stateDot}
                                  </span>
                                  <span className={cc.searchResultTitle}>{resolved.title}</span>
                                </span>
                                {resolved.workspaceLabel !== undefined && (
                                  <span className={cc.searchResultWorkspace}>{resolved.workspaceLabel}</span>
                                )}
                                {item.snippet !== '' && (
                                  <span className={cc.searchResultSnippet}>{item.snippet}</span>
                                )}
                              </button>
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
                        {/* P2-7: 搜索进行中（query!==''）也在结果下方渲染
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
                        {workspaceDropAtListStart && (
                          <span className={cc.listTopDropIndicator} aria-hidden="true" />
                        )}
                        {orderedWorkspaces.map((workspace) => {
                          const workspaceKey = `${server.id}/${workspace.id}`
                          const folded = viewPrefs.folded[workspaceKey] === true
                          const sessions = sessionsOf(workspace)
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
                          // card). Double click enters inline rename (the
                          // ungrouped bucket has no rename; a click on the inner
                          // buttons never triggers it). Single clicks need no
                          // delay — the header itself is not clickable (fold
                          // lives on the chevron button).
                          const workspaceHeader = (
                            <div
                              className={clsx(
                                cc.workspaceHeader,
                                sessions.some(session => session.id === currentId) && cc.groupContainsCurrent,
                              )}
                              role="treeitem"
                              aria-expanded={!folded}
                              draggable={workspace.ungrouped !== true}
                              onDoubleClick={(event) => {
                                if (suppressClickRef.current) return
                                if (menuOpen[workspaceKey] === true || workspace.ungrouped === true) return
                                if (event.target instanceof HTMLElement && event.target.closest('button') !== null) return
                                setRenaming({
                                  sourceId: server.id,
                                  kind: 'workspace',
                                  id: workspace.id,
                                  value: workspace.title,
                                })
                              }}
                              onDragStart={workspace.ungrouped === true
                                ? undefined
                                : (event) => {
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
                                  // P1-1: 镜像会话行复位——拖拽结束后一个 tick
                                  // 清掉抑制位，否则本次 workspace 头拖拽后的
                                  // 尾随 click 会永久短路来源切换/排序/加工作区/
                                  // 搜索/折叠/新建/kebab/归档/会话打开（唯一复位
                                  // 在会话行 onDragEnd，workspace 头漏了）。
                                  window.setTimeout(() => { suppressClickRef.current = false }, 0)
                                }}
                            >
                              <button
                                type="button"
                                className={clsx(cc.foldToggle, folded && cc.foldToggleFolded)}
                                aria-label={folded ? t('workspace.expand') : t('workspace.collapse')}
                                onClick={() => {
                                  if (suppressClickRef.current) return
                                  clearPendingClick()
                                  toggleWorkspaceFold(server.id, workspace.id)
                                }}
                              >
                                <IconChevronRightOutline14 size={12} />
                              </button>
                              <span className={cc.workspaceTitle}>
                                {workspace.ungrouped ? t('list.ungrouped') : workspace.title}
                              </span>
                              {sessions.length > 0 && (
                                <span className={cc.workspaceCount}>{sessions.length}</span>
                              )}
                              {!workspace.ungrouped && (
                                <span
                                  className={clsx(cc.rowActions, menuOpen[workspaceKey] === true && cc.rowActionsVisible)}
                                  onClick={(event) => event.stopPropagation()}
                                >
                                  <button
                                    type="button"
                                    className={cc.actionIcon}
                                    aria-label={t('action.newSession')}
                                    title={t('action.newSession')}
                                    onClick={() => {
                                      if (suppressClickRef.current) return
                                      clearPendingClick()
                                      onNewSession(server, workspace.id)
                                    }}
                                  >
                                    <IconPlusOutline16 size={14} />
                                  </button>
                                  <Menu
                                    compact
                                    portal
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
                                        label: t('action.delete'),
                                        danger: true,
                                        icon: <IconTrashOutline16 size={14} />,
                                      },
                                    ]}
                                    anchor={(
                                      <button
                                        type="button"
                                        className={cc.actionIcon}
                                        aria-label={t('action.menu')}
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
                                </span>
                              )}
                            </div>
                            )
                            return (
                            <div
                              key={workspace.id}
                              className={clsx(
                                cc.workspaceGroup,
                                workspace.ungrouped && cc.ungroupedGroup,
                                marker === 'before' && cc.dropBefore,
                                marker === 'after' && cc.dropAfter,
                              )}
                              role="group"
                              onDragOver={workspace.ungrouped === true || workspaceDrag === null
                                || workspaceDrag.sourceId !== server.id
                                ? undefined
                                : (event) => {
                                  event.preventDefault()
                                  event.dataTransfer.dropEffect = 'move'
                                  const half = rowHalf(event)
                                  setWorkspaceDrag(current => current === null
                                    ? current
                                    : { ...current, over: { id: workspace.id, half } })
                                }}
                              onDrop={workspace.ungrouped === true || workspaceDrag === null
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
                                  content={(
                                    <div className={cc.hoverContent}>
                                      <div className={cc.hoverTitle}>{workspace.title}</div>
                                      {sessions.length > 0 && (
                                        <div className={cc.hoverTime}>{t('hover.sessionCount', { n: sessions.length })}</div>
                                      )}
                                    </div>
                                  )}
                                  disabled={menuOpen[workspaceKey] === true || workspaceDrag !== null || sessionDrag !== null}
                                />
                              )}
                            {!folded && (
                            <>
                              {renaming !== null && renaming.sourceId === server.id
                                && renaming.kind === 'workspace' && renaming.id === workspace.id
                                && renameForm(server.id, 'workspace', workspace.id, workspace.title)}
                              {workspaceError !== undefined && (
                                <div className={cc.rowError} role="alert">{workspaceError}</div>
                              )}
                              {rowErrors[`${server.id}/workspace-drag/${workspace.id}`] !== undefined && (
                                <div className={cc.rowError} role="alert">{rowErrors[`${server.id}/workspace-drag/${workspace.id}`]}</div>
                              )}
                              {sessions.map((session) => {
                                const sessionKey = `${server.id}/session/${session.id}`
                                const sessionDragError = rowErrors[`${server.id}/session-drag/${session.id}`]
                                const sessionActionError = rowErrors[`${server.id}/session/${session.id}/rename`]
                                  ?? rowErrors[`${server.id}/session/${session.id}/archive`]
                                  ?? rowErrors[`${server.id}/session/${session.id}/fork`]
                                // chamber (06, P2-11): the session row (hoisted so
                                // the HoverCard can wrap it). The single click is
                                // DELAYED ~350ms (DOUBLE_CLICK_WINDOW_MS) — a
                                // second click within the window cancels the
                                // pending open and enters inline rename
                                // (double-click rename); the timer expiring opens
                                // the session. suppressClickRef (drag-end trailing
                                // click) is honored on the way in and in the timer
                                // callback; clicks outside the pending row cancel
                                // it (document listener, P2-11).
                                const sessionRow = (
                                  <div
                                    className={clsx(
                                      cc.sessionRow,
                                      session.id === currentId && cc.sessionActive,
                                      sessionMarker(session.id) === 'before' && cc.dropBefore,
                                      sessionMarker(session.id) === 'after' && cc.dropAfter,
                                    )}
                                    role="treeitem"
                                    aria-selected={session.id === currentId}
                                    draggable
                                    onDragStart={(event) => {
                                      event.dataTransfer.effectAllowed = 'move'
                                      event.dataTransfer.setData('text/plain', session.id)
                                      suppressClickRef.current = true
                                      sessionDropCommitted.current = false
                                      setSessionDrag({ sourceId: server.id, accountKey: workspace.id, sessionId: session.id, over: null })
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
                                        setSessionDrag(current => current === null
                                          ? current
                                          : { ...current, over: { id: session.id, half } })
                                      }}
                                    onDrop={!activeSessionDrag
                                      ? undefined
                                      : (event) => {
                                        event.preventDefault()
                                        if (sessionDrag === null) return
                                        commitSessionDrag(server, sessionDrag, { id: session.id, half: rowHalf(event) })
                                      }}
                                    onClick={(event) => {
                                      if (suppressClickRef.current) return
                                      // 菜单展开 / 本行重命名进行中：忽略整次点击
                                      //（不 arm、不开会话）。
                                      if (menuOpen[sessionKey] === true || (renaming !== null
                                        && renaming.sourceId === server.id && renaming.kind === 'session' && renaming.id === session.id)) return
                                      const pending = pendingClickRef.current
                                      if (pending !== null && pending.key === session.id) {
                                        clearPendingClick()
                                        setRenaming({
                                          sourceId: server.id,
                                          kind: 'session',
                                          id: session.id,
                                          value: session.title,
                                        })
                                        return
                                      }
                                      if (pending !== null) clearPendingClick()
                                      pendingClickRef.current = {
                                        key: session.id,
                                        // P2-11: 记录被点击的行 DOM，document 级
                                        // 行外点击监听据此判断"行外"。
                                        row: event.currentTarget,
                                        timer: window.setTimeout(() => {
                                          pendingClickRef.current = null
                                          if (suppressClickRef.current) return
                                          openSession(server.id, session.id)
                                        }, DOUBLE_CLICK_WINDOW_MS),
                                      }
                                    }}
                                  >
                                    <span className={cc.sessionTitle}>{session.blank === true ? t('session.new') : (session.title || t('list.unnamed'))}</span>
                                    {/* P2-10: blank（新建）行是临时占位——内容
                                        不存在，kebab（含 fork）/归档都作用于
                                        不存在的内容，隐藏整簇（官方 Rows.tsx
                                        `!row.blank && <rowActions>` L436-462）。 */}
                                    {session.blank !== true && (
                                    <span
                                      className={clsx(cc.rowActions, menuOpen[sessionKey] === true && cc.rowActionsVisible)}
                                      onClick={(event) => event.stopPropagation()}
                                    >
                                      <Menu
                                        compact
                                        portal
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
                                        ]}
                                        anchor={(
                                          <button
                                            type="button"
                                            className={cc.actionIcon}
                                            aria-label={t('action.menu')}
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
                                      <button
                                        type="button"
                                        className={cc.actionIcon}
                                        aria-label={t('action.archive')}
                                        title={t('action.archive')}
                                        onClick={() => {
                                          if (suppressClickRef.current) return
                                          clearPendingClick()
                                          onArchiveSession(server, session.id, session.blank === true ? t('session.new') : session.title)
                                        }}
                                      >
                                        <IconArchiveOutline20 size={14} />
                                      </button>
                                    </span>
                                    )}
                                    {/* Trailing state slot: the ring/dot at the
                                        row's right edge. On hover the row action
                                        cluster (kebab + archive) swaps in and this
                                        slot swaps out (CSS hover replace, 06 §4.3
                                        /§7) — the slot is a true replace, no
                                        placeholder. role is conditional so an
                                        empty (no-state) slot does not register a
                                        live region (P2-8 consistency: same rule
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
                                    renameForm(server.id, 'session', session.id, session.title, true)
                                  ) : (
                                    <HoverCard
                                      anchor={sessionRow}
                                      content={(
                                        <div className={cc.hoverContent}>
                                          <div className={cc.hoverTitle}>{session.blank === true ? t('session.new') : (session.title || t('list.unnamed'))}</div>
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
                                      disabled={menuOpen[sessionKey] === true || sessionDrag !== null || workspaceDrag !== null}
                                      copyText={session.blank === true ? undefined : (session.title || t('list.unnamed'))}
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
                            </>
                            )}
                          </div>
                          )
                        })}
                        {server.workspaces.length === 0 && <div className={cc.empty}>{t('list.noWorkspaces')}</div>}
                        {query === '' && rowErrors[`${server.id}/add-workspace`] !== undefined && (
                          <div className={cc.rowError} role="alert">{rowErrors[`${server.id}/add-workspace`]}</div>
                        )}
                      </>
                    )}
                  </div>
                ) : (
                  // Disconnected source: header + status icon only (dot or
                  // spinner — the phase lives on hover/aria; no status text
                  // on the main surface, the connections settings page
                  // carries the detailed logSummary).
                  null
                )}
              </section>
              )
            })}
            {servers.every((server) => !server.connected) && (
              <div className={cc.empty}>{t('list.empty')}</div>
            )}
          </div>
        ) : (
          <div className={cc.railDots}>
            {servers.map((server) => (
              <span
                key={server.id}
                className={clsx(
                  cc.railDot,
                  server.id === chamberInstanceId && cc.railDotActive,
                )}
                style={{ ...sourceDotStyle(server), ...sourceAccentStyle(server) }}
                title={server.label}
              />
            ))}
          </div>
        )}
        </ChamberListBoundary>
      </div>

      {/* Footer actions stack above Settings in both sidebar widths. */}
      <div className={css.footArea}>
        <div className={css.footerActions}>
          {renderSlot('sidebar.footer.action', { wide })}
        </div>
        <div className={css.settingsArea}>
          {renderSlot('sidebar.settings', { wide })}
        </div>
      </div>

      {/* Add-workspace directory browser (single instance; mounted only while
          a target source is chosen — a fresh mount resets the dialog). */}
      {addingWorkspace !== null && (
        <DirectoryBrowser
          open
          listDirectory={browseListDirectory}
          createDirectory={browseCreateDirectory}
          busy={addingWorkspaceBusy}
          t={directoryBrowserT}
          onOpen={browsePick}
          onClose={browseClose}
        />
      )}
    </div>
  )
}
