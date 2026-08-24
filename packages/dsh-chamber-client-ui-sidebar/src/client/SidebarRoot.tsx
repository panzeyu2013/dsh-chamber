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
 * sort menu + search+`+`; workspace header: count ↔ `+`+kebab). Hover actions are
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
import { Component, Fragment, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import clsx from 'clsx'
import { SESSION_SEARCH_RESULT_LIMIT } from '@deepseek-ai/dsh-client-connection/client'
import {
  BrandWordmark, FishLogo, HoverCard, IconArchiveOutline20, IconBranchOutline16, IconChecklistOutline14,
  IconChevronRightOutline14, IconCloseOutline16, IconEditOutline16, IconEllipsisOutline16, IconLoadingOutline16,
  IconNewChatOutline16, IconPanelLeftOutline16, IconPersonalizationOutline16, IconPlusOutline16, IconQuestionOutline14,
  IconFolderOpenOutline16, IconSearchOutline16, IconTrashOutline16, IconWarningOutline16, Menu, StateDot, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarRootComponentProps } from './contract/slots.ts'
import type { SidebarKey } from './locales.ts'
import { chamberBridge, type ChamberServerAggregate, type ChamberServerWorkspace } from '../shared/aggregate-store.ts'
import {
  armBlankGhost, BLANK_GHOST_GRACE_MS, deriveLocalSearchMatches, hashString, increasedForkTitle, mergeSearchResults,
  nextServerOrder, nextUpdatedOrder, orderServersForDisplay, orderUngroupedSessions, reconciledSessionOrder, relativeTimeBucket,
  runningRingVisible, sanitizeSearchQuery, serversProjectionSignature, SEARCH_QUERY_MAX_CODE_UNITS, workspaceAccentStyle,
  type SessionOrderBy,
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
import {
  clearSourceBookkeeping, getViewPrefs, subscribeViewPrefs, updateViewPrefs, type ChamberSidebarViewPrefs,
} from '../shared/view-prefs.ts'
import { clearPendingClick, isClickInsidePendingRow, noteSessionRowClick } from '../shared/pending-click.ts'
import { getSourceRepoLayouts, getWorkspaceGitFlag, getWorkspaceGitFlagsVersion, subscribeWorkspaceGitFlags, type RepoGitLayout } from '../shared/workspace-git-flags.ts'
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
  return hashString(sourceId) % 360
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
  /**
   * Whether the row's workspace is the synthetic ungrouped bucket. Carried in
   * the drag state (not re-derived from the id) so commitSessionDrag resolves
   * the workspace by id + flag — a real workspace whose wire id ever equaled
   * UNGROUPED_WORKSPACE_ID could otherwise hijack a bucket drag's anchor and
   * route it to a wrong-workspace wire mutation (impossible with the pinned
   * UUID host, kept as a cheap landmine guard).
   */
  ungrouped: boolean
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
 * In-flight server-group drag (2026-09, docs/todo/server-drag-sort.md —
 * option 1): the dragged source id plus the current insert marker. The whole
 * server list is ONE account (no cross-source gating needed — every section
 * is a valid target; the dragged server's own section no-ops in the commit).
 */
interface ServerDragState {
  sourceId: string
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
  // The sidebar's own typecheck program resolves the slots render share
  // through the loose ambient seam (renderSlot is a 2-arg signature there),
  // so the contextual 3-arg occurrence is narrowed locally. The runtime
  // signature is `(key, owner, opts)` and dispatch is by key — the cast is
  // only a type-level lift, never a runtime change.
  const renderWorkspaceGit = renderSlot as (
    key: 'sidebar.workspace.git',
    owner: { wide: boolean },
    opts: { hookContext: { sourceId: string; workspaceId: string; repoKey?: string } },
  ) => ReactNode

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
  //
  // The box is measured into a CACHED ref, never per pointermove: each
  // getBoundingClientRect() is a forced synchronous layout read, and the
  // pointer stream delivers far more events than the box changes. The column's
  // rect only changes on collapse/expand (width prop / collapsed flag — the
  // effect re-runs and re-measures) and window resize (a rAF-throttled
  // re-measure refreshes it at most once per frame while the pointer moves,
  // one frame of staleness is invisible to a 2s linger timer).
  const columnRect = useRef<DOMRect | null>(null)
  useEffect(() => {
    if (!pointerInside) return
    const measure = (): void => {
      raf = 0
      columnRect.current = column.current?.getBoundingClientRect() ?? null
    }
    let raf = 0
    measure()
    const onMove = (event: PointerEvent): void => {
      // Throttle the re-measure to one per frame; the decision below uses the
      // cached rect (at most one frame stale — imperceptible for a 2s linger).
      if (raf === 0) raf = requestAnimationFrame(measure)
      const rect = columnRect.current
      if (rect === null) return
      const inside = event.clientX >= rect.left && event.clientX < rect.right
        && event.clientY >= rect.top && event.clientY < rect.bottom
      if (inside) cancelLinger()
      else armLinger()
    }
    document.addEventListener('pointermove', onMove)
    return () => {
      if (raf !== 0) cancelAnimationFrame(raf)
      document.removeEventListener('pointermove', onMove)
      cancelLinger()
    }
  }, [pointerInside, width, collapsed])

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

  // chamber (08 §11): re-render when the git plugin publishes per-workspace
  // flags (worktree fold-button swap / create-from-main gating).
  // The flags store's MONOTONIC VERSION is the snapshot: a store change
  // re-renders (a constant snapshot would never trigger React — review P1).
  useSyncExternalStore(subscribeWorkspaceGitFlags, getWorkspaceGitFlagsVersion, getWorkspaceGitFlagsVersion)

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

  // chamber (2026-09, docs/todo/server-drag-sort.md): server-level fold —
  // collapses the source's ENTIRE workspace list (all workspace groups
  // hidden). Deliberately a SEPARATE preference from per-workspace `folded`:
  // collapsing the server must NOT fold each workspace's conversations, so
  // expanding the server restores every workspace with its sessions exactly
  // as they were (user rule: 不要折叠 workspace 中的对话). P3 (review
  // 2026-09): expanding the LAST folded source deletes the field entirely —
  // no permanent empty-object key in the persisted prefs.
  const toggleSourceFold = (serverId: string): void => {
    updateViewPrefs((prev) => {
      const sourceFolded = { ...prev.sourceFolded }
      if (sourceFolded[serverId] === true) {
        delete sourceFolded[serverId]
        if (Object.keys(sourceFolded).length === 0) {
          const next = { ...prev }
          delete next.sourceFolded
          return next
        }
        return { ...prev, sourceFolded }
      }
      sourceFolded[serverId] = true
      return { ...prev, sourceFolded }
    })
  }

  // chamber (2026-09, docs/todo/server-drag-sort.md — option 1): the server
  // groups render in the user's persisted display order when one exists
  // (local view preference only — the App's N-ctx residency/prewarm order
  // and the instance registry are untouched; navigation is id-keyed). The
  // rail dots share the same order so both views agree.
  const orderedServers = useMemo(
    () => orderServersForDisplay(servers, viewPrefs.serverOrder),
    [servers, viewPrefs.serverOrder],
  )

  // chamber (06 §3.1, 2026-08 C档 alignment): explicit per-source sort
  // selection through the source-header menu (official ViewOptionsMenu
  // pattern — no more blind cycling). The choice lives in the shared view
  // prefs (`orderBy` keyed by sourceId, default manual). Entering updated
  // clears the source's activity BOOKKEEPING (sessionUpdatedAtByAccount) so
  // the derivation effect below does ONE full recency sort (official
  // switchedToUpdated) while keeping the existing updatedOrder accounts
  // (re-entry re-sorts them). The source's transient session-order overrides
  // are dropped either way (P2-5 hygiene): entering updated renders the
  // account order — an in-flight manual wire commit is only reflected if it
  // lands before the next projection; entering manual restores wire order.
  const setOrderBy = (server: ChamberServerAggregate, mode: SessionOrderBy): void => {
    if ((viewPrefs.orderBy?.[server.id] ?? 'manual') === mode) return
    updateViewPrefs(prev => {
      const orderBy = { ...prev.orderBy, [server.id]: mode }
      if (mode !== 'updated') return { ...prev, orderBy }
      const cleared = clearSourceBookkeeping(prev.sessionUpdatedAtByAccount, server.id)
      return cleared === prev.sessionUpdatedAtByAccount
        ? { ...prev, orderBy }
        : { ...prev, orderBy, sessionUpdatedAtByAccount: cleared }
    })
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
  // (stale poll data). 2026-08 C档: overrides are MANUAL-mode only now —
  // updated-mode drags write the shared updatedOrder account (见
  // commitSessionDrag) instead, so this map never carries an unconfirmable
  // entry; the updated-branch drop below stays as hygiene for a source
  // switched to updated while an override was still in flight.
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
        // 2026-08 C档 hygiene: an override left over from a source that has
        // since switched to updated is dropped — updated mode renders the
        // account order, never this map (setOrderBy drops the source's
        // in-flight overrides at switch time; an override's wire commit is
        // only reflected if it lands before the next projection). manual
        // mode still reconciles against the wire confirmation.
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

  // chamber (06 §3.1, 2026-08 C档 alignment — updated = manual + activity
  // promotion): per-account updated-mode order derivation, the official
  // ui-workspace nextSessionOrderAccount port. Runs on every projection /
  // view-prefs change and writes the promoted account orders + activity
  // bookkeeping through the SHARED view-prefs store, diff-guarded: an
  // unchanged account never triggers a notify → re-render → effect loop, and
  // every shell converges on the same accounts. The recency-sort trigger
  // (no bookkeeping) = first observation OR the user just picked 最近更新 in
  // the sort menu (setOrderBy clears the source's bookkeeping — official
  // switchedToUpdated). Real workspaces AND the ungrouped bucket are one
  // account each (`${server.id}/${workspace.id}`; the bucket's id is
  // UNGROUPED_WORKSPACE_ID), so the bucket's updated-mode drags and
  // promotions persist in updatedOrder instead of the manual ungroupedOrder.
  //
  // The derivation reads the LIVE shared store (getViewPrefs — the same cache
  // updateViewPrefs mutates), NOT this render's viewPrefs snapshot: the
  // effect can flush after a drag commit or another shell's setOrderBy
  // landed, and a stale-snapshot derivation would silently overwrite the
  // fresher account — a just-committed updated-mode drag, or a cleared
  // bookkeeping (which must not be re-added, or the one-time recency sort on
  // switching to updated would be skipped).
  useEffect(() => {
    const current = getViewPrefs()
    const pendingOrder: Record<string, string[]> = {}
    const pendingTimestamps: Record<string, Record<string, number>> = {}
    for (const server of servers) {
      if (current.orderBy?.[server.id] !== 'updated') continue
      for (const workspace of server.workspaces) {
        const sessionIds = workspace.sessions.map(session => session.id)
        if (sessionIds.length === 0) continue
        const accountKey = `${server.id}/${workspace.id}`
        const next = nextUpdatedOrder({
          sessionIds,
          stored: current.updatedOrder?.[accountKey],
          previousUpdatedAt: current.sessionUpdatedAtByAccount?.[accountKey],
          byId: new Map(workspace.sessions.map(session => [session.id, session])),
        })
        if (!next.changed) continue
        pendingOrder[accountKey] = next.order
        pendingTimestamps[accountKey] = next.updatedAt
      }
    }
    if (Object.keys(pendingOrder).length === 0 && Object.keys(pendingTimestamps).length === 0) return
    // Merge into prev (not the render snapshot) so a concurrent write from
    // another shell on a key we did not touch is never clobbered.
    updateViewPrefs(prev => ({
      ...prev,
      ...(Object.keys(pendingOrder).length > 0
        ? { updatedOrder: { ...prev.updatedOrder, ...pendingOrder } }
        : {}),
      ...(Object.keys(pendingTimestamps).length > 0
        ? { sessionUpdatedAtByAccount: { ...prev.sessionUpdatedAtByAccount, ...pendingTimestamps } }
        : {}),
    }))
  }, [servers, viewPrefs])

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
  // chamber (2026-09, docs/todo/server-drag-sort.md): server-group drag state
  // (display-order preference only — commit writes view-prefs, no wire).
  const [serverDrag, setServerDrag] = useState<ServerDragState | null>(null)
  const sessionDropCommitted = useRef(false)
  const workspaceDropCommitted = useRef(false)
  const serverDropCommitted = useRef(false)
  // Some browsers dispatch a trailing `click` after an aborted drag or a
  // drop; the flag set on dragstart (and cleared a tick after dragend) keeps
  // that click from opening the session the row no longer represents (P2-8).
  const suppressClickRef = useRef(false)
  useNativeDragAcceptance(sessionDrag !== null || workspaceDrag !== null || serverDrag !== null)

  // chamber (2026-08 review fix, design 06 §2.2): blank-row GHOST slot — the
  // local grace clock that bounds how long a departed blank "new session" row
  // keeps its (invisible) layout slot. The App's projection holds the ghost
  // for BLANK_GHOST_GRACE_MS (derive.ts armBlankGhost/sessionVisible) so the
  // list cannot shift inside the 350ms double-click window; this component
  // mirrors the same expiry and stops RENDERING the ghost when it passes —
  // the App may not re-derive for another poll cycle and the invisible
  // placeholder must not linger. A one-shot timer per arming bumps the tick
  // so the render re-evaluates the expiries (armings are rare: only a click
  // on a real session while a blank row is current).
  const ghostExpiry = useRef<Map<string, number>>(new Map())
  const ghostTimers = useRef<number[]>([])
  const [, setGhostTick] = useState(0)
  useEffect(() => {
    const timers = ghostTimers.current
    return () => { for (const timer of timers) window.clearTimeout(timer) }
  }, [])

  // chamber (06, P2-11 — 2026-08 revision, aligned with OpenChamber): the
  // session row's single click now opens the session IMMEDIATELY (zero delay)
  // and double-click-to-rename is detected by click timestamps on the SAME
  // session id — no timer ever delays an open. OpenChamber (the external
  // project this N-ctx design drew from, SessionNodeItem.tsx) opens on the
  // single click and renames on the second click of a double click; this shell
  // keeps a DOUBLE_CLICK_WINDOW_MS window but only as a RENAME guard: the
  // pending is a module-global { sessionId, at } slot, the second click within
  // the window on the same session enters inline rename, and every other click
  // opens right away. openSession is idempotent, so a misjudged slow second
  // click only re-opens (no-op) and can NEVER accidentally rename — strictly
  // safer than the old delayed-open model, where a misjudged double click
  // cancelled the pending open and renamed.
  //
  // The pending lives in a MODULE-level singleton (shared/pending-click.ts,
  // vite shared chunk) shared by every N-ctx shell: each server boot mounts
  // its own SidebarRoot React tree, and a CROSS-SOURCE double-click (click1 on
  // a row of a non-active server switches the visible shell BETWEEN click1 and
  // click2) would land click2 in a DIFFERENT tree — a per-tree ref would never
  // see click1 and the second click would re-open instead of renaming. Keyed
  // by sessionId (NOT a DOM node): session rows render data-session-id, and
  // the outside-click cancellation matches that attribute via closest(), so it
  // works even when the pending row lives in another shell's DOM.
  //
  // The document-wide click listener only guards the rename window (no
  // "pending open" exists anymore): a click anywhere OUTSIDE the pending row
  // drops the pending — the row's own onClick runs before this listener and
  // consumes/replaces the pending itself, so only outside clicks reach here.
  // suppressClickRef (drag-end trailing click) is honored on the way in;
  // row-internal buttons (fold toggle / new-session / kebabs / archive) AND
  // the source-header action buttons (sort / add-workspace / search) clear
  // the pending in their own handlers (stopPropagation + clearPendingClick) —
  // React's stopPropagation also stops the native event, so the document
  // listener never sees those clicks and a surviving pending would make a
  // later click on the same session spuriously enter rename.
  useEffect(() => {
    const onDocumentClick = (event: MouseEvent): void => {
      if (!(event.target instanceof Node)) return
      if (isClickInsidePendingRow(event.target)) return
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
  // Sort menu open state — DEDICATED (sourceId | null) instead of a
  // `menuOpen` key: a `${sourceId}/…`-shaped key would collide with a real
  // workspace's key (workspace ids are wire directory names — one could be
  // literally `sort`), cross-opening the workspace kebab and the sort menu.
  // A separate state also allows only ONE sort menu across sources.
  const [sortMenuOpen, setSortMenuOpen] = useState<string | null>(null)
  // Close the sort menu when its source can no longer render the anchor
  // (disconnect, or a snapshot-fetch error with no open search capsule) —
  // otherwise the state leaks and the menu pops open unprompted on reconnect.
  useEffect(() => {
    if (sortMenuOpen === null) return
    const server = servers.find(candidate => candidate.id === sortMenuOpen)
    if (server === undefined) {
      setSortMenuOpen(null)
      return
    }
    const search = searchState.get(sortMenuOpen)
    if (!server.connected || (server.aggregateError !== undefined && search?.expanded !== true)) {
      setSortMenuOpen(null)
    }
  }, [servers, sortMenuOpen, searchState])
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

  /**
   * chamber (2026-08 review fix, design 06 §2.2): arm the blank-row GHOST
   * slot. Called SYNCHRONOUSLY in a session-row onClick BEFORE the open —
   * opening any real session moves the active source's current away from its
   * blank "new session" row (or a cross-source click switches the view, which
   * also un-currents it), and the App re-derives on the runtime-facts report
   * a moment later. The ghost keeps the departed blank row in the projection
   * for BLANK_GHOST_GRACE_MS, so the rows below never shift inside the
   * double-click window and the second click still lands on the target row.
   * The local expiry (ghostExpiry) bounds the RENDER side at the same
   * deadline; the one-shot timer closes the invisible gap even if the App
   * does not re-derive until the next poll cycle.
   */
  const armBlankGhostForClick = (): void => {
    // Only the ACTIVE source can currently hold a blank provisional row (the
    // App passes current only for the active view, 06 §4.3 single-selection).
    const active = servers.find(server => server.id === chamberInstanceId)
    if (active === undefined) return
    const current = active.runtime?.current
    if (current === undefined) return
    const isBlankCurrent = active.workspaces.some(workspace =>
      workspace.sessions.some(session => session.id === current && session.blank === true))
    if (!isBlankCurrent) return
    armBlankGhost(current)
    ghostExpiry.current.set(current, Date.now() + BLANK_GHOST_GRACE_MS)
    // chamber (third-wave review, R2-1#5): the one-shot timer is trimmed from
    // the ref after it fires, so repeated armings (rare, but each timer
    // outlives the 450ms grace) cannot grow ghostTimers unboundedly.
    const timerId = window.setTimeout(() => {
      setGhostTick(tick => tick + 1)
      const index = ghostTimers.current.indexOf(timerId)
      if (index >= 0) ghostTimers.current.splice(index, 1)
    }, BLANK_GHOST_GRACE_MS)
    ghostTimers.current.push(timerId)
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
    // Plan A: an ORPHANED workspace (path gone) needs an explicit confirm —
    // the deletion only removes the durable registration.
    if (getWorkspaceGitFlag(server.id, workspaceId)?.orphaned === true) {
      if (!window.confirm(t('confirm.deleteOrphan', { title }))) return
    } else if (!window.confirm(t('confirm.delete', { title }))) {
      return
    }
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
      onClick={(event) => {
        // chamber (third-wave review, W1#3): stopPropagation also stops the
        // native event, so the document-level pending-click canceller never
        // sees this click — every propagation-stopping control must clear the
        // pending itself (pending-click.ts INVARIANT). Harmless today (the
        // pending is consumed before the form opens) but closes the foot-gun.
        event.stopPropagation()
        clearPendingClick()
      }}
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
  // and this shell re-renders on chamberBridge publishes (status/snapshot
  // pushes + fallback refreshes), so an inline arrow would wipe the user's
  // browsing on refresh. A
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
  // CURRENT rendered order (mode-aware: updated = the shared updated-order
  // account; manual = override-first), never the projection. Commit writes:
  // updated mode persists the drag into the account order (shared view-prefs,
  // NO wire — official「updated 下拖拽只落 account」, promotions stack on
  // top); manual mode persists the ungrouped bucket through view prefs and
  // real workspaces over the wire with an optimistic override that the next
  // pull replaces.
  const commitSessionDrag = (
    server: ChamberServerAggregate,
    activeDrag: SessionDragState,
    over: NonNullable<SessionDragState['over']>,
  ): void => {
    if (sessionDropCommitted.current) return
    sessionDropCommitted.current = true
    setSessionDrag(null)
    // Resolve by id AND the drag's ungrouped flag (see SessionDragState):
    // a real workspace whose wire id ever equaled UNGROUPED_WORKSPACE_ID must
    // not hijack a bucket drag's anchor into a wrong-workspace wire mutation.
    const workspace = server.workspaces.find(candidate =>
      candidate.id === activeDrag.accountKey && (candidate.ungrouped === true) === activeDrag.ungrouped)
    if (workspace === undefined) return
    const orderBy = viewPrefs.orderBy?.[server.id] ?? 'manual'
    const wireIds = workspace.sessions.map(session => session.id)
    const accountKey = `${server.id}/${workspace.id}`
    // Updated branch reads the LIVE store (like the derivation effect, not
    // this render's viewPrefs snapshot): a promotion write can land between
    // this render and the drop, and stale anchor math would then clobber the
    // un-rendered promotion on the same account key.
    const renderedOrder = orderBy === 'updated'
      ? reconciledSessionOrder(getViewPrefs().updatedOrder?.[accountKey] ?? [], wireIds)
      : workspace.ungrouped === true
        ? reconciledSessionOrder(viewPrefs.ungroupedOrder[server.id] ?? [], wireIds)
        : sessionOrderOverride[accountKey] ?? wireIds
    const targetIndex = renderedOrder.findIndex(id => id === over.id)
    if (targetIndex === -1) return
    const anchor = over.half === 'before' ? over.id : renderedOrder[targetIndex + 1]
    if (anchor === activeDrag.sessionId) return
    const sourceIndex = renderedOrder.findIndex(id => id === activeDrag.sessionId)
    // P2 (review 2026-09): a dragged row that vanished from the rendered
    // order is a NO-OP — never re-insert the ghost into the persisted order
    // (aligns with nextServerOrder's contract; the old guard only skipped
    // the no-op check and then spliced the vanished id back in).
    if (sourceIndex === -1) return
    const anchorIndex = anchor === undefined ? renderedOrder.length : renderedOrder.findIndex(id => id === anchor)
    if (anchorIndex === sourceIndex || anchorIndex === sourceIndex + 1) return
    const nextOrder = renderedOrder.filter(id => id !== activeDrag.sessionId)
    const insertAt = anchor === undefined ? nextOrder.length : nextOrder.indexOf(anchor)
    nextOrder.splice(insertAt === -1 ? nextOrder.length : insertAt, 0, activeDrag.sessionId)
    if (orderBy === 'updated') {
      // Updated mode: the drag mutates the account order (shared + persisted,
      // the ungrouped bucket included), no wire commit — the wire order is
      // the manual baseline, the promotion re-applies on top.
      updateViewPrefs(prev => ({ ...prev, updatedOrder: { ...prev.updatedOrder, [accountKey]: nextOrder } }))
      return
    }
    if (workspace.ungrouped === true) {
      updateViewPrefs(prev => ({ ...prev, ungroupedOrder: { ...prev.ungroupedOrder, [server.id]: nextOrder } }))
      return
    }
    setSessionOrderOverride(prev => ({ ...prev, [accountKey]: nextOrder }))
    runAction(`${server.id}/session-drag/${activeDrag.sessionId}`, async () => {
      try {
        await insertSessionBefore(getInstanceClient(server.id), workspace.id, activeDrag.sessionId, anchor)
        chamberBridge.requestRefresh(server.id)
      } catch (error) {
        // A failed commit must not keep masquerading as committed: drop the
        // optimistic override immediately, the projection shows wire truth.
        setSessionOrderOverride(prev => {
          const next = { ...prev }
          delete next[accountKey]
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
    // P2 (review 2026-09): a dragged workspace that vanished from the
    // rendered order is a NO-OP — never re-insert the ghost into the
    // persisted order (aligns with nextServerOrder's contract).
    if (sourceIndex === -1) return
    const anchorIndex = anchor === undefined ? renderedOrder.length : renderedOrder.findIndex(id => id === anchor)
    if (anchorIndex === sourceIndex || anchorIndex === sourceIndex + 1) return
    const nextOrder = renderedOrder.filter(id => id !== activeDrag.workspaceId)
    const insertAt = anchor === undefined ? nextOrder.length : nextOrder.indexOf(anchor)
    nextOrder.splice(insertAt === -1 ? nextOrder.length : insertAt, 0, activeDrag.workspaceId)
    // chamber (08 §11): a DERIVED workspace can never precede its main
    // checkout — clamp the optimistic order so the visual matches the rule.
    const dragFlag = getWorkspaceGitFlag(server.id, activeDrag.workspaceId)
    if (dragFlag?.isWorktree === true && dragFlag.mainWorkspaceId !== undefined) {
      const mainIndex = nextOrder.indexOf(dragFlag.mainWorkspaceId)
      const draggedIndex = nextOrder.indexOf(activeDrag.workspaceId)
      if (mainIndex !== -1 && draggedIndex !== -1 && draggedIndex < mainIndex) {
        nextOrder.splice(draggedIndex, 1)
        nextOrder.splice(mainIndex, 0, activeDrag.workspaceId)
      }
    }
    // chamber (08 §11, P2-5): the MAIN checkout must likewise stay BEFORE
    // every derived worktree of the same repository — dragging it below them
    // would violate the rule in the other direction.
    if (dragFlag?.isMain === true) {
      const mainIndex = nextOrder.indexOf(activeDrag.workspaceId)
      const firstDerivedIndex = nextOrder
        .findIndex(id => getWorkspaceGitFlag(server.id, id)?.mainWorkspaceId === activeDrag.workspaceId)
      if (mainIndex !== -1 && firstDerivedIndex !== -1 && mainIndex > firstDerivedIndex) {
        nextOrder.splice(mainIndex, 1)
        nextOrder.splice(firstDerivedIndex, 0, activeDrag.workspaceId)
      }
    }
    // chamber (08 §11, 2026-08): a derived workspace can ONLY reorder within
    // its own repo group — if the drop landed beyond the group's last member
    // (dragged into another group), clamp it back to sit right after that
    // member so the persisted order stays group-contiguous.
    if (dragFlag?.isWorktree === true && dragFlag.mainWorkspaceId !== undefined) {
      const mainIndex = nextOrder.indexOf(dragFlag.mainWorkspaceId)
      const draggedIndex = nextOrder.indexOf(activeDrag.workspaceId)
      if (mainIndex !== -1 && draggedIndex !== -1) {
        let groupEnd = mainIndex
        for (let i = 0; i < nextOrder.length; i += 1) {
          const id = nextOrder[i]
          if (id === activeDrag.workspaceId) continue
          if (getWorkspaceGitFlag(server.id, id)?.mainWorkspaceId === dragFlag.mainWorkspaceId && i > groupEnd) {
            groupEnd = i
          }
        }
        if (draggedIndex > groupEnd) {
          nextOrder.splice(draggedIndex, 1)
          nextOrder.splice(groupEnd + 1, 0, activeDrag.workspaceId)
        }
      }
    }
    // The wire anchor follows the CLAMPED order (the element right after the
    // dragged workspace), so the persisted order matches what the user sees.
    const finalIndex = nextOrder.indexOf(activeDrag.workspaceId)
    const wireAnchor = finalIndex === -1 ? undefined : nextOrder[finalIndex + 1]
    setWorkspaceOrderOverride(prev => ({ ...prev, [server.id]: nextOrder }))
    runAction(`${server.id}/workspace-drag/${activeDrag.workspaceId}`, async () => {
      try {
        await insertWorkspaceBefore(getInstanceClient(server.id), activeDrag.workspaceId, wireAnchor)
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

  // chamber (2026-09, docs/todo/server-drag-sort.md — option 1): server-group
  // drag commit. Pure DISPLAY preference — persists the new order into the
  // shared `serverOrder` view pref (cross-ctx live sync), NO wire, NO
  // App-layer N-ctx/registry change (navigation is id-keyed, never
  // order-keyed). The anchor math lives in the pure `nextServerOrder`
  // (unit-tested); `null` = no-op (unchanged position / vanished target) —
  // the write is skipped. P2 (review 2026-09): the anchor math runs INSIDE
  // the updateViewPrefs mutator against the FRESHEST stored order — another
  // ctx's commit landing between this render and the drop must not be
  // clobbered by a stale-render snapshot (the commitSessionDrag updated-mode
  // branch reads the live store for the same reason).
  const commitServerDrag = (
    activeDrag: ServerDragState,
    over: NonNullable<ServerDragState['over']>,
  ): void => {
    if (serverDropCommitted.current) return
    serverDropCommitted.current = true
    setServerDrag(null)
    updateViewPrefs(prev => {
      const renderedOrder = orderServersForDisplay(servers, prev.serverOrder).map(server => server.id)
      const nextOrder = nextServerOrder(renderedOrder, activeDrag.sourceId, over)
      if (nextOrder === null) return prev
      return { ...prev, serverOrder: nextOrder }
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
  // > running — interaction/subagent/completion facts first, the aggregate
  // snapshot's running ring last. Both reports derive from the mounted ctx's
  // same sessions store but can land one React commit apart; the priority
  // prevents that transient skew from hiding a user-relevant state.
  // 2026-08 (running-subagent fix, 06 §4.5): the official
  // sessionStatuses renders a session whose round ended but whose BACKGROUND
  // subagents still work as ONGOING (runningSubagentCount outranks
  // node.completed) — a parent's own running bit goes false the moment its
  // round returns, so the App-armed completed dot would light up blue while
  // the children are still at work. `runningSubagents` (live channel, vendor
  // lineage index) therefore outranks the completed dot and running ring.
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
        {/* chamber (2026-08 scroll sync): the scroll container carries
            data-chamber-sidebar-scroll + each row data-chamber-row so the
            renderer's sidebar-scroll-sync can anchor the outgoing shell's
            scroll and restore the same rows at the same screen position in
            the incoming shell on N-ctx view switch. */}
        {wide ? (
          <div className={cc.chamberList} data-chamber-sidebar-scroll="">
            {orderedServers.map((server) => {
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
              // chamber (2026-09, docs/todo/server-drag-sort.md): server-level
              // fold — hides the ENTIRE workspace list below the header. The
              // per-workspace conversation folds are NOT touched (see
              // toggleSourceFold), so expanding restores every workspace with
              // its sessions as they were.
              const sourceFolded = viewPrefs.sourceFolded?.[server.id] === true
              // chamber (third-wave review, R2-1#4): the row-render ghost
              // predicate hoisted so the workspace header count reuses the
              // SAME rule — a ghost is a blank "New Session" row that stopped
              // being current (the projection still carries it as an invisible
              // layout slot during BLANK_GHOST_GRACE_MS, see derive.ts
              // armBlankGhost/sessionVisible). Single source of truth: the
              // count must not drift from what the rows render.
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
              // suppressed (official list-top drop treatment).
              const firstReal = server.workspaces.find(workspace => workspace.ungrouped !== true)
              const workspaceDropAtListStart = firstReal !== undefined
                && workspaceDrag !== null
                && workspaceDrag.sourceId === server.id
                && workspaceDrag.over !== null
                && workspaceDrag.over.id === firstReal.id
                && workspaceDrag.over.half === 'before'
              // chamber (08 §11): would inserting the dragged worktree at the
              // target put it AT or ABOVE its main checkout? Shared by the
              // drop marker, the onDragOver gate and the top indicator so the
              // visual, the accepted drop and the committed order agree.
              const dropBlockedByMain = (draggedWorkspaceId: string, targetWorkspaceId: string, half: 'before' | 'after'): boolean => {
                const dragFlag = getWorkspaceGitFlag(server.id, draggedWorkspaceId)
                if (!(dragFlag?.isWorktree === true && dragFlag.mainWorkspaceId !== undefined)) return false
                const renderedOrder = workspaceOrderOverride[server.id]
                  ?? server.workspaces.filter(row => row.ungrouped !== true).map(row => row.id)
                const mainIndex = renderedOrder.indexOf(dragFlag.mainWorkspaceId)
                if (mainIndex === -1) return false
                const targetIndex = renderedOrder.indexOf(targetWorkspaceId)
                const insertIndex = targetIndex + (half === 'after' ? 1 : 0)
                // Blocked when inserting AT or ABOVE the main checkout.
                if (insertIndex <= mainIndex) return true
                // Also blocked when inserting BEYOND the group's last member —
                // a derived workspace reorders only within its own repo group.
                let groupEnd = mainIndex
                for (let i = 0; i < renderedOrder.length; i += 1) {
                  const id = renderedOrder[i]
                  if (id === draggedWorkspaceId) continue
                  if (getWorkspaceGitFlag(server.id, id)?.mainWorkspaceId === dragFlag.mainWorkspaceId && i > groupEnd) {
                    groupEnd = i
                  }
                }
                return insertIndex > groupEnd + 1
              }
              const workspaceDragMarker = (workspace: ChamberServerWorkspace): 'before' | 'after' | null => {
                if (workspace.ungrouped === true || workspaceDrag === null
                  || workspaceDrag.sourceId !== server.id || workspaceDrag.over === null) return null
                if (workspaceDrag.over.id !== workspace.id) return null
                if (workspaceDropAtListStart && workspace.id === firstReal?.id) return null
                if (dropBlockedByMain(workspaceDrag.workspaceId, workspace.id, workspaceDrag.over.half)) return null
                return workspaceDrag.over.half
              }
              const sessionsOf = (workspace: ChamberServerWorkspace): ChamberServerWorkspace['sessions'] => {
                const wire = workspace.sessions
                const orderBy = viewPrefs.orderBy?.[server.id] ?? 'manual'
                // 2026-08 C档（对齐官方）：updated = 手动序 + 活动置顶。渲染序
                // 直接取共享的 updated-order account（推导 effect 已把 seeding/
                // recency sort/promotion 写回，见上）；account 尚不存在时（切换
                // 后首帧、effect 尚未落盘）回退 wire 序。**重入 updated**（account
                // 已保留、簿记刚被清）时首帧渲染保留的旧 account 序，effect 的
                // 整列 recency 排序下一帧才落——与官方同构（render-then-sort），
                // 菜单关闭动画内不可感知。manual 模式：未分组桶用存储序（P2-9），
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
              // 2026-08 修订:搜索结果行的 running 位来自投影（mergeSearchResults
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
              return (
              <section
                key={server.id}
                className={clsx(
                  cc.sourceGroup,
                  // chamber (2026-09, docs/todo/server-drag-sort.md): the
                  // server-group drag marker lives on the SECTION boundary
                  // (before = above the header, after = below the whole
                  // group) — mirroring the workspace-group marker.
                  serverDrag !== null && serverDrag.over?.id === server.id && serverDrag.over.half === 'before' && cc.dropBefore,
                  serverDrag !== null && serverDrag.over?.id === server.id && serverDrag.over.half === 'after' && cc.dropAfter,
                )}
                role="group"
                aria-label={server.label}
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
                    server.id !== chamberInstanceId && cc.sourceHeaderClickable,
                  )}
                  data-chamber-row={server.id}
                  style={sourceAccentStyle(server)}
                  title={server.id === chamberInstanceId ? undefined : t('list.activate')}
                  role={server.id === chamberInstanceId ? undefined : 'button'}
                  tabIndex={server.id === chamberInstanceId ? undefined : 0}
                  aria-label={server.id === chamberInstanceId ? undefined : t('list.activate')}
                  // chamber (2026-09, docs/todo/server-drag-sort.md — option
                  // 1): the source header is the drag handle for the
                  // server-group display-order drag. The same trailing-click
                  // suppression as the workspace header: a drop ending over
                  // the header (or its buttons) must not fire a spurious
                  // activate/toggle/action.
                  draggable
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = 'move'
                    event.dataTransfer.setData('text/plain', server.id)
                    suppressClickRef.current = true
                    serverDropCommitted.current = false
                    setServerDrag({ sourceId: server.id, over: null })
                  }}
                  onDragEnd={(event) => {
                    // P2 (review 2026-09): an ESC-cancelled drag must not
                    // persist the last marker — dropEffect 'none' means the
                    // user explicitly cancelled (the section onDrop path is
                    // unaffected: a real drop commits there first, and the
                    // serverDropCommitted guard makes this no-op).
                    if (serverDrag !== null && serverDrag.over !== null && event.dataTransfer?.dropEffect !== 'none') {
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
                    if (server.id !== chamberInstanceId) chamberBridge.requestActivateSource(server.id)
                  }}
                  onKeyDown={(event) => {
                    if (server.id === chamberInstanceId) return
                    // P1 (review 2026-09): only respond to the header's OWN
                    // focus. A keydown bubbling from an inner button (fold
                    // toggle / sort / add-workspace / search) must not be
                    // swallowed: preventDefault here would cancel the
                    // button's native Enter/Space activation AND switch the
                    // active N-ctx view — the fold toggle was unreachable by
                    // keyboard on remote sources.
                    if (event.target !== event.currentTarget) return
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      chamberBridge.requestActivateSource(server.id)
                    }
                  }}
                >
                  {/* chamber (2026-09, docs/todo/server-drag-sort.md): the
                      server-level fold toggle — workspace parity: a FOLDER
                      glyph at rest, swapping to the collapse chevron on
                      header hover/focus (same slot, nothing shifts). Clicking
                      collapses/expands the source's ENTIRE workspace list
                      without touching any workspace's own conversation fold
                      state. stopPropagation keeps the header's activate
                      click (and the pending-click discipline) out. */}
                  <button
                    type="button"
                    className={clsx(cc.sourceFoldToggle, sourceFolded && cc.sourceFoldToggleFolded)}
                    aria-label={sourceFolded ? t('server.expand') : t('server.collapse')}
                    aria-expanded={!sourceFolded}
                    onClick={(event) => {
                      event.stopPropagation()
                      if (suppressClickRef.current) return
                      clearPendingClick()
                      toggleSourceFold(server.id)
                    }}
                  >
                    <IconChevronRightOutline14 size={14} className={cc.sourceFoldChevron} />
                    <IconFolderOpenOutline16 size={14} className={cc.sourceFoldFolder} />
                  </button>
                  <span
                    className={clsx(cc.sourceDot)}
                    style={sourceDotStyle(server)}
                  />
                  <span className={cc.sourceLabel}>{server.label}</span>
                  {server.pluginDiagnostic !== undefined && server.pluginDiagnostic.state !== 'ok' && (
                    <span
                      className={cc.pluginDiagnosticBadge}
                      title={t('status.pluginsAbnormal')}
                      aria-label={t('status.pluginsAbnormal')}
                      role="status"
                    >!</span>
                  )}
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
                  {/* chamber: header actions (sort menu + add-workspace `+` +
                      per-source search) are hover-revealed like the session
                      rows' actions: at rest the connection status occupies the
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
                    {/* chamber (06 §3.1, 2026-08 C档 alignment): per-source
                        session sort MENU (official ViewOptionsMenu pattern —
                        replaces the blind manual↔updated cycle). The menu
                        shows both options with a checkmark on the current one
                        (selectedIds), so the active order is visible the
                        moment it opens; the title + aria-label + sortActive
                        tint carry the current mode at rest (hover-revealed).
                        Selecting a mode goes through setOrderBy (switch
                        bookkeeping + P2-5 override drop). */}
                    {server.connected && (server.aggregateError === undefined || search?.expanded === true) && (
                      <Menu
                        compact
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
                          <button
                            type="button"
                            className={clsx(cc.actionIcon, viewPrefs.orderBy?.[server.id] === 'updated' && cc.sortActive)}
                            aria-label={`${t('action.sort')} · ${t(viewPrefs.orderBy?.[server.id] === 'updated' ? 'orderBy.updated' : 'orderBy.manual')}`}
                            aria-haspopup="menu"
                            aria-expanded={sortMenuOpen === server.id}
                            title={`${t('action.sort')} · ${t(viewPrefs.orderBy?.[server.id] === 'updated' ? 'orderBy.updated' : 'orderBy.manual')}`}
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
                        )}
                      />
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
                          clearPendingClick()
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
                          clearPendingClick()
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
                {/* chamber (2026-09, docs/todo/server-drag-sort.md): the
                    server-level fold hides EVERYTHING below the header —
                    search capsule, source-scope git alert and the workspace
                    list (search results included). The search state itself is
                    untouched (shared search-state store): expanding the
                    server remounts the capsule with its query intact. */}
                {!sourceFolded && (
                <>
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
                {server.connected ? (() => {
                  // chamber (08 §11 Plan A): per-repo layouts drive the
                  // unregistered-worktree blocks + the orphan badge.
                  const repoLayouts = getSourceRepoLayouts(server.id)
                  return (
                  <>
                  {/* chamber (08 §11): one source-level Git alert mount
                      (workspaceId '' = source scope), OUTSIDE the list tree
                      (review P3-3: a tree must not carry non-treeitem direct
                      children). The chamber Git plugin renders the source's
                      recovery/action errors here — visible even when no
                      workspace has git rows so the source can never silently
                      lock or lie. */}
                  {renderWorkspaceGit('sidebar.workspace.git', { wide }, {
                    hookContext: { sourceId: server.id, workspaceId: '' },
                  })}
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
                            // 2026-08 修订:搜索行传投影 running 位（查不到回落
                            // false）；运行环 wire 权威——sessionStateDot/Label
                            // 直接使用此位,通道 running 不参与渲染（见
                            // sessionStateLabel 注释）。
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
                        {workspaceDropAtListStart && !(workspaceDrag !== null && firstReal !== undefined
                          && dropBlockedByMain(workspaceDrag.workspaceId, firstReal.id, 'before')) && (
                          <span className={cc.listTopDropIndicator} aria-hidden="true" />
                        )}
                        {(() => {
                          return orderedWorkspaces.map((workspace, index) => {
                          const workspaceKey = `${server.id}/${workspace.id}`
                          const folded = viewPrefs.folded[workspaceKey] === true
                          // chamber (08 §11): derived (worktree) workspaces
                          // drop the kebab/rename — OpenChamber worktree
                          // groups keep only delete + new-session. The flag
                          // also seeds the per-workspace icon accent (family
                          // hue for worktree/main workspaces).
                          const gitFlag = getWorkspaceGitFlag(server.id, workspace.id)
                          const isWorktree = gitFlag?.isWorktree === true
                          const sessions = sessionsOf(workspace)
                          // chamber (third-wave review, R2-1#4): sessionsOf
                          // includes the projection's departed blank GHOST
                          // row, so the header count would be +1 for up to
                          // BLANK_GHOST_GRACE_MS. Count only non-ghost
                          // sessions (the same predicate the rows use).
                          const visibleSessionCount = sessions.reduce(
                            (count, session) => count + (isGhostSession(session) ? 0 : 1),
                            0,
                          )
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
                              className={clsx(cc.workspaceHeader)}
                              // chamber (2026-09): per-workspace icon accent —
                              // deterministic, selection-independent (the
                              // current-session row carries its own official
                              // selected tint); undefined for the ungrouped
                              // bucket, so CSS falls back to the default ink.
                              style={workspaceAccentStyle(server.id, workspace.id, gitFlag)}
                              data-chamber-row={workspaceKey}
                              role="treeitem"
                              aria-expanded={!folded}
                              draggable={workspace.ungrouped !== true}
                              // P2-5 (2026-08 client review): the git occupant
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
                                if (menuOpen[workspaceKey] === true || workspace.ungrouped === true) return
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
                              <span className={clsx(cc.workspaceTitle, isWorktree && cc.workspaceTitleGit)}>
                                {workspace.ungrouped ? t('list.ungrouped') : workspace.title}
                              </span>
                              {getWorkspaceGitFlag(server.id, workspace.id)?.orphaned === true && (
                                // Plan A: the workspace's path no longer exists
                                // (externally deleted worktree left a ghost).
                                // The badge doubles as the cleanup entry — an
                                // orphaned WORKTREE keeps its worktree row
                                // (no kebab), so the badge click opens the
                                // dedicated delete confirm (review 2026-08).
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
                              {workspace.ungrouped !== true && (
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
                              {!workspace.ungrouped && (
                                <span
                                  className={clsx(cc.rowActions, menuOpen[workspaceKey] === true && cc.rowActionsVisible)}
                                  onClick={(event) => {
                                    // INVARIANT (pending-click.ts header): any
                                    // control that stops propagation MUST clear
                                    // the pending itself (2026-08 review fix) —
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
                                  {!isWorktree && (
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
                                  )}
                                </span>
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
                              onDragOver={workspace.ungrouped === true || workspaceDrag === null
                                || workspaceDrag.sourceId !== server.id
                                ? undefined
                                : (event) => {
                                  event.preventDefault()
                                  event.dataTransfer.dropEffect = 'move'
                                  const half = rowHalf(event)
                                  if (workspaceDrag !== null
                                    && dropBlockedByMain(workspaceDrag.workspaceId, workspace.id, half)) {
                                    // A suppressed zone never becomes the
                                    // target — the commit then leaves the
                                    // order unchanged (P2-5).
                                    return
                                  }
                                  setWorkspaceDrag(current => {
                                    if (current === null) return current
                                    if (current.over?.id === workspace.id && current.over.half === half) return current
                                    return { ...current, over: { id: workspace.id, half } }
                                  })
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
                                  disabled={menuOpen[workspaceKey] === true || workspaceDrag !== null || sessionDrag !== null || serverDrag !== null}
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
                                // chamber (2026-08 review fix, design 06 §2.2):
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
                                // chamber (06, P2-11 — 2026-08): the session row
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
                                // listener, P2-11). The row renders
                                // data-session-id so the outside-click
                                // containment check works across shells.
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
                                    draggable={!ghost}
                                    onDragStart={ghost
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
                                      // chamber (06, P2-11 — 2026-08): single
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
                                      if (noteSessionRowClick(session.id)) {
                                        // P2-10 同款 blank 门控（2026-08
                                        // review）：空白"新建会话"占位行无内容可
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
                                      // 2026-08 review（ghost slot）：打开任何
                                      // 真实会话都会把活动来源的 current 从空白
                                      // 行切走，App 随后重派生——同步先 arm ghost
                                      // 槽占住该行的布局位，列表在 350ms 双击窗口
                                      // 内不位移，第二次点击仍落在目标行上。
                                      armBlankGhostForClick()
                                      openSession(server.id, session.id)
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
                                      onClick={(event) => {
                                        // INVARIANT (pending-click.ts header):
                                        // stopPropagation must be paired with
                                        // clearPendingClick (2026-08 review fix)
                                        // — see the workspace rowActions note.
                                        event.stopPropagation()
                                        clearPendingClick()
                                      }}
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
                                      disabled={menuOpen[sessionKey] === true || sessionDrag !== null || workspaceDrag !== null || serverDrag !== null}
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
                          </Fragment>
                          )
                          })
                        })()}
                        {(() => {
                          // chamber (08 §11 Plan A): ALL unregistered worktrees
                          // render at the very end of the workspace list — one
                          // block per repository (user decision 2026-08: not
                          // after the main checkout, not after the repo group).
                          // The block must NOT beat the workspace list: the git
                          // facts (fast snapshot) arrive before the aggregate
                          // (workspace.list + sessions.list) — gate on the
                          // aggregate having landed so the worktrees never
                          // appear ahead of the workspaces (2026-08 report).
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
            })}
            {servers.every((server) => !server.connected) && (
              <div className={cc.empty}>{t('list.empty')}</div>
            )}
          </div>
        ) : (
          <div className={cc.railDots}>
            {orderedServers.map((server) => (
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
