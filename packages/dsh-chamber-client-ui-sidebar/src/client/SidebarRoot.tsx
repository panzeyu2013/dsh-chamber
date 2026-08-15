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
 * chevron toggle; fold state persists in localStorage (view prefs, 06 §3 —
 * read once on mount, written back on change with a fresh merge against
 * other ctxs' writes plus stale-entry pruning, no cross-ctx live sync).
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
import {
  BrandWordmark, FishLogo, IconArchiveOutline20, IconChecklistOutline14, IconChevronRightOutline14,
  IconCloseOutline16, IconEditOutline16, IconEllipsisOutline16, IconLoadingOutline16,
  IconNewChatOutline16, IconPanelLeftOutline16, IconPlusOutline16, IconQuestionOutline14,
  IconSearchOutline16, IconTrashOutline16, IconWarningOutline16, Menu, StateDot, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarRootComponentProps } from './contract/slots.ts'
import type { SidebarKey } from './locales.ts'
import { chamberBridge, type ChamberServerAggregate, type ChamberServerWorkspace } from '../shared/aggregate-store.ts'
import {
  reconciledSessionOrder, sanitizeSearchQuery, SEARCH_QUERY_MAX_CODE_UNITS,
} from '../shared/derive.ts'
import {
  archiveSession, createHostDirectory, createSession, createWorkspace, deleteWorkspace,
  getInstanceClient, insertSessionBefore, insertWorkspaceBefore, listHostDirectory,
  renameSession, renameWorkspace, searchSessions, type SearchRow,
} from '../shared/instance-api.ts'
import { DirectoryBrowser } from '@deepseek-ai/dsh-client-ui-directory-picker-browse/client/DirectoryBrowser.tsx'
import { loadViewPrefs, saveViewPrefs, type ChamberSidebarViewPrefs } from '../shared/view-prefs.ts'
import css from './SidebarRoot.module.css'
import cc from './sidebar-chamber.module.css'

/** Wide-content unmount delay; matches the 150ms wide-content fade-out. */
const COLLAPSE_SETTLE_MS = 150

/**
 * How long the column's scrollbars stay drawn after the pointer leaves it.
 * The bar is a pointer affordance here, and hiding it on the leave event
 * itself makes it blink out while the pointer is only crossing the column's
 * edge — on the way to the conversation, or around a portalled menu.
 */
const SCROLLBAR_LINGER_MS = 2000

/** Pause between the latest keystroke and a Host content-search request (06 §1.2). */
const SEARCH_DEBOUNCE_MS = 250

/** Caller-side search deadline (06 §1.1 — the wire merges its own 30s). */
const SEARCH_TIMEOUT_MS = 30_000

/**
 * Wire search-result page bound (dsh-host-apiproxy session-search.ts) —
 * only the hasMore copy renders it; the wire caps the actual page.
 */
const SESSION_SEARCH_RESULT_LIMIT = 20

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

/** One source's debounced remote search page (06 §1.2). */
interface RemoteSearchState {
  query: string
  status: 'idle' | 'loading' | 'ready' | 'error'
  items: SearchRow[]
  hasMore: boolean
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
  // it on its poll cycle; this shell just subscribes and re-renders.
  const [servers, setServers] = useState<ChamberServerAggregate[]>(() => chamberBridge.getServers())
  useEffect(() => chamberBridge.subscribe(() => { setServers(chamberBridge.getServers()) }), [])

  // chamber (06 §3): view preferences (folded workspace groups + the
  // ungrouped session order) persist under one localStorage key. Read once on
  // mount; every change writes back. No cross-ctx live propagation — a
  // refresh/reopen picks the latest write (06 §5). The write re-reads and
  // MERGES with whatever other ctxs persisted meanwhile (a stale snapshot
  // must not drop unrelated keys) and prunes entries against the CURRENT
  // projection (fold keys whose workspace vanished, ungrouped ids the source
  // no longer holds) — the projection, not the prefs, decides existence.
  const [viewPrefs, setViewPrefs] = useState<ChamberSidebarViewPrefs>(() => loadViewPrefs())
  useEffect(() => {
    const fresh = loadViewPrefs()
    const folded = { ...fresh.folded, ...viewPrefs.folded }
    const ungroupedOrder = { ...fresh.ungroupedOrder, ...viewPrefs.ungroupedOrder }
    const liveFoldKeys = new Set<string>()
    const liveSessionIds = new Map<string, Set<string>>()
    for (const server of chamberBridge.getServers()) {
      const universe = new Set<string>()
      for (const workspace of server.workspaces) {
        if (workspace.ungrouped !== true) liveFoldKeys.add(`${server.id}/${workspace.id}`)
        for (const session of workspace.sessions) universe.add(session.id)
      }
      liveSessionIds.set(server.id, universe)
    }
    for (const key of Object.keys(folded)) {
      if (!liveFoldKeys.has(key)) delete folded[key]
    }
    for (const [sourceId, ids] of Object.entries(ungroupedOrder)) {
      const universe = liveSessionIds.get(sourceId)
      if (universe === undefined) {
        delete ungroupedOrder[sourceId]
        continue
      }
      const pruned = ids.filter(id => universe.has(id))
      if (pruned.length === ids.length) continue
      if (pruned.length === 0) delete ungroupedOrder[sourceId]
      else ungroupedOrder[sourceId] = pruned
    }
    saveViewPrefs({ v: 1, folded, ungroupedOrder })
  }, [viewPrefs])

  const toggleWorkspaceFold = (serverId: string, workspaceId: string): void => {
    const key = `${serverId}/${workspaceId}`
    setViewPrefs((prev) => {
      const folded = { ...prev.folded }
      if (folded[key] === true) delete folded[key]
      else folded[key] = true
      return { ...prev, folded }
    })
  }

  // chamber (06 §2.2): transient optimistic order overrides, applied at
  // render over the projection while the wire commit is in flight. Cleared
  // PER KEY against each fresh projection — never wholesale: a poll that has
  // not yet seen the commit must not flash the optimistic order back (the
  // pull model self-heals on the confirming pull, 06 §5). A key drops when
  // its workspace vanished, the projection order now equals the override
  // (commit confirmed), or the membership differs (a row was deleted
  // meanwhile); it survives while only the ORDER differs (stale poll data).
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

  // chamber (06 §1.2): per-source search state (wide only — the region is
  // the only place the capsule can render). The query outlives collapse of
  // the sidebar itself, but is dropped when the capsule collapses.
  const [searchExpanded, setSearchExpanded] = useState<Record<string, boolean>>({})
  const [searchQuery, setSearchQuery] = useState<Record<string, string>>({})
  const [searchRemote, setSearchRemote] = useState<Record<string, RemoteSearchState>>({})
  const searchRoots = useRef<Record<string, HTMLDivElement | null>>({})
  const searchInputs = useRef<Record<string, HTMLInputElement | null>>({})
  const searchButtons = useRef<Record<string, HTMLButtonElement | null>>({})

  // chamber (R3): a disconnected source drops its per-source search state, so
  // a reconnect starts from a clean collapsed capsule instead of re-expanding
  // and re-searching with the stale query. The prune is identity-preserving
  // (returns prev when nothing changes), so the push-driven projection
  // updates never churn the state.
  useEffect(() => {
    const gone = servers.filter((server) => !server.connected).map((server) => server.id)
    if (gone.length === 0) return
    const prune = <T,>(state: Record<string, T>): Record<string, T> => {
      if (gone.every((id) => state[id] === undefined)) return state
      const next = { ...state }
      for (const id of gone) delete next[id]
      return next
    }
    setSearchExpanded(prune)
    setSearchQuery(prune)
    setSearchRemote(prune)
  }, [servers])

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
        if (searchExpanded[server.id] !== true) continue
        const root = searchRoots.current[server.id]
        if (root !== null && root !== undefined && root.contains(event.target)) continue
        const button = searchButtons.current[server.id]
        if (button !== null && button !== undefined && button.contains(event.target)) continue
        if (sanitizeSearchQuery(searchQuery[server.id] ?? '') !== '') continue
        setSearchExpanded((prev) => {
          if (prev[server.id] !== true) return prev
          const next = { ...prev }
          delete next[server.id]
          return next
        })
      }
    }
    document.addEventListener('click', onClick)
    return () => { document.removeEventListener('click', onClick) }
  }, [wide, servers, searchExpanded, searchQuery])

  // Debounced per-source remote search: a stable job key (source id + query,
  // only for expanded connected sources with a non-empty query) drives one
  // effect so sibling keystrokes debounce together while polls do not
  // restart in-flight searches. In-flight jobs live in a per-source registry
  // ref: a keystroke in ONE source must not abort or restart another
  // source's in-flight search (re-arm guard, P2-6) — the effect only
  // re-creates a job when its query changed, and jobs for sources that are
  // no longer expanded/connected/query-carrying are aborted and reset to
  // idle. Empty/not-expanded sources reset to idle.
  const searchJobsKey = servers
    .filter(server => server.connected && searchExpanded[server.id] === true)
    .map(server => `${server.id}\u0000${sanitizeSearchQuery(searchQuery[server.id] ?? '')}`)
    .filter(pair => !pair.endsWith('\u0000'))
    .join('|')
  const searchJobsRef = useRef<Record<string, {
    query: string
    timer: number
    timeout: number
    controller: AbortController
  }>>({})
  useEffect(() => {
    const jobs = searchJobsRef.current
    // Wanted jobs for THIS render: expanded + connected + non-empty query.
    const wanted = new Map<string, string>()
    for (const server of servers) {
      if (!server.connected) continue
      const query = sanitizeSearchQuery(searchQuery[server.id] ?? '')
      if (searchExpanded[server.id] !== true || query === '') continue
      wanted.set(server.id, query)
    }
    // Abort jobs that are no longer wanted (collapsed, disconnected, emptied
    // or re-queried) and reset their idle state — the CHANGED source only.
    for (const [sourceId, job] of Object.entries(jobs)) {
      if (wanted.get(sourceId) === job.query) continue
      window.clearTimeout(job.timer)
      window.clearTimeout(job.timeout)
      job.controller.abort()
      delete jobs[sourceId]
      if (!wanted.has(sourceId)) {
        setSearchRemote((prev) => {
          if (prev[sourceId] === undefined) return prev
          const next = { ...prev }
          delete next[sourceId]
          return next
        })
      }
    }
    // Arm jobs for new queries only — an existing same-query job is left in
    // flight (its own completion updates the state; re-creating it here
    // would abort and restart every other source's search on each keystroke).
    for (const [sourceId, query] of wanted) {
      if (jobs[sourceId] !== undefined) continue
      const controller = new AbortController()
      setSearchRemote((prev) => ({
        ...prev,
        [sourceId]: { query, status: 'loading', items: [], hasMore: false },
      }))
      const timer = window.setTimeout(() => {
        searchSessions(getInstanceClient(sourceId), query, controller.signal)
          .then((result) => {
            if (controller.signal.aborted) return
            setSearchRemote((prev) => ({
              ...prev,
              [sourceId]: { query, status: 'ready', items: result.items, hasMore: result.hasMore },
            }))
          })
          .catch(() => {
            // 30s 调用方超时（SEARCH_TIMEOUT_MS）会 abort：若本 job 仍持有该
            // controller（未被新查询替换/删除），这是「超时」而非「被取消」——
            // 必须落 error 态，绝不永久停留在 search.pending（P2-6 竞态修复）。
            // 被替换/收起的 job（jobs[sourceId] 已换新 controller 或已删除）
            // 则静默退出，其状态由新 job/清理接管。
            if (controller.signal.aborted && jobs[sourceId]?.controller !== controller) return
            setSearchRemote((prev) => ({
              ...prev,
              [sourceId]: { query, status: 'error', items: [], hasMore: false },
            }))
          })
      }, SEARCH_DEBOUNCE_MS)
      const timeout = window.setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS)
      jobs[sourceId] = { query, timer, timeout, controller }
    }
    return () => {
      // Cleanup on the next run / unmount: abort the jobs whose query this
      // run no longer wants (the changed sources) — registry entries for
      // untouched sources survive, keeping their in-flight searches alive.
      for (const [sourceId, job] of Object.entries(jobs)) {
        if (wanted.get(sourceId) === job.query) continue
        window.clearTimeout(job.timer)
        window.clearTimeout(job.timeout)
        job.controller.abort()
        delete jobs[sourceId]
      }
    }
  }, [searchJobsKey])

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
      setViewPrefs(prev => ({ ...prev, ungroupedOrder: { ...prev.ungroupedOrder, [server.id]: nextOrder } }))
      return
    }
    setSessionOrderOverride(prev => ({ ...prev, [`${server.id}/${workspace.id}`]: nextOrder }))
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
  const sessionStateLabel = (server: ChamberServerAggregate, session: { id: string; running?: boolean }): string | undefined => {
    const facts = server.runtime?.sessions[session.id]
    const pending = facts?.pending
    if (pending !== undefined) {
      return pending === 'approval' ? t('status.waitingApproval')
        : pending === 'plan-review' ? t('status.planReview')
        : t('status.waitingAnswer')
    }
    if (session.running === true) return t('status.running')
    if (facts?.completed === true) return t('status.completed')
    return undefined
  }
  /** Pending-interaction kind of the row, or undefined when not pending. */
  const sessionStatePending = (server: ChamberServerAggregate, session: { id: string }): 'approval' | 'plan-review' | 'question' | undefined =>
    server.runtime?.sessions[session.id]?.pending
  const sessionStateDot = (server: ChamberServerAggregate, session: { id: string; running?: boolean }): ReactNode => {
    const facts = server.runtime?.sessions[session.id]
    const pending = facts?.pending
    if (pending === undefined && session.running !== true && facts?.completed !== true) return null
    if (pending === 'approval') {
      return <IconWarningOutline16 className={cc.statePendingApproval} />
    }
    if (pending === 'plan-review') {
      return <IconChecklistOutline14 className={cc.statePendingPlan} />
    }
    if (pending === 'question') {
      return <IconQuestionOutline14 className={cc.statePendingQuestion} />
    }
    if (session.running === true) {
      return <StateDot state="ongoing" size={10} />
    }
    return <span className={cc.stateCompleted} />
  }

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
              const query = sanitizeSearchQuery(searchQuery[server.id] ?? '')
              const remote = searchRemote[server.id]
              const currentRemote = remote !== undefined && remote.query === query
                ? remote
                : { query, status: 'loading' as const, items: [] as SearchRow[], hasMore: false }
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
                if (workspace.ungrouped === true) {
                  const stored = viewPrefs.ungroupedOrder[server.id]
                  if (stored === undefined) return wire
                  const order = reconciledSessionOrder(stored, wire.map(session => session.id))
                  const byId = new Map(wire.map(session => [session.id, session]))
                  return order.flatMap(id => { const session = byId.get(id); return session === undefined ? [] : [session] })
                }
                const override = sessionOrderOverride[`${server.id}/${workspace.id}`]
                if (override === undefined) return wire
                const byId = new Map(wire.map(session => [session.id, session]))
                return override.flatMap(id => { const session = byId.get(id); return session === undefined ? [] : [session] })
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
              return (
              <section key={server.id} className={cc.sourceGroup}>
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
                    className={clsx(cc.sourceActions, searchExpanded[server.id] === true && cc.sourceActionsVisible)}
                  >
                    {server.connected && (server.aggregateError === undefined || searchExpanded[server.id] === true) && (
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
                    {server.connected && (server.aggregateError === undefined || searchExpanded[server.id] === true) && (
                      <button
                        type="button"
                        className={cc.searchButton}
                        aria-label={t('search.sessions.aria')}
                        aria-expanded={searchExpanded[server.id] === true}
                        ref={(node) => { searchButtons.current[server.id] = node }}
                        onClick={(event) => {
                          event.stopPropagation()
                          if (suppressClickRef.current) return
                          if (searchExpanded[server.id] === true) {
                            // Toggle: an open capsule's icon collapses it (empty
                            // query) or just blurs the input (a non-empty query
                            // must not silently drop the in-progress filter).
                            if (query === '') {
                              setSearchExpanded(prev => {
                                if (prev[server.id] !== true) return prev
                                const next = { ...prev }
                                delete next[server.id]
                                return next
                              })
                            } else {
                              searchInputs.current[server.id]?.blur()
                            }
                          } else {
                            setSearchExpanded(prev => ({ ...prev, [server.id]: true }))
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
                {searchExpanded[server.id] === true && (
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
                      value={searchQuery[server.id] ?? ''}
                      autoFocus
                      onChange={(event) => setSearchQuery(prev => ({ ...prev, [server.id]: sanitizeSearchQuery(event.target.value) }))}
                      onKeyDown={(event) => {
                        if (event.key !== 'Escape') return
                        setSearchQuery((prev) => { const next = { ...prev }; delete next[server.id]; return next })
                        setSearchExpanded((prev) => { const next = { ...prev }; delete next[server.id]; return next })
                      }}
                    />
                    <button
                      type="button"
                      className={cc.searchClear}
                      aria-label={t('search.clear')}
                      onClick={() => {
                        setSearchQuery((prev) => { const next = { ...prev }; delete next[server.id]; return next })
                        setSearchExpanded((prev) => { const next = { ...prev }; delete next[server.id]; return next })
                      }}
                    >
                      <IconCloseOutline16 size={12} />
                    </button>
                  </div>
                )}
                {server.connected ? (
                  <div className={cc.workspaceList}>
                    {query !== '' ? (
                      // chamber (06 §1.2): an active query replaces the whole
                      // workspace list (header/status stay; fold and the
                      // add-workspace affordance are hidden while searching).
                      // The results branch outranks the snapshot-fetch error:
                      // an open search keeps showing results even when a later
                      // pull fails (the error line stays in the gap below).
                      <div className={cc.searchResults} role="list" aria-label={t('search.results.aria')}>
                        {currentRemote.items.map((item) => {
                          const resolved = searchRowLabel(item.sessionId)
                          return (
                            <div
                              key={item.sessionId}
                              className={cc.searchResultRow}
                              onClick={() => openSession(server.id, item.sessionId)}
                            >
                              <span className={cc.searchResultTitle}>{resolved.title}</span>
                              {resolved.workspaceLabel !== undefined && (
                                <span className={cc.searchResultWorkspace}>{resolved.workspaceLabel}</span>
                              )}
                              {item.snippet !== '' && (
                                <span className={cc.searchResultSnippet}>{item.snippet}</span>
                              )}
                            </div>
                          )
                        })}
                        {currentRemote.status === 'loading' && (
                          <div className={cc.searchStatus} role="status">{t('search.pending')}</div>
                        )}
                        {currentRemote.status === 'error' && (
                          <div className={cc.searchWarning} role="status">{t('search.unavailable')}</div>
                        )}
                        {currentRemote.status === 'ready' && currentRemote.items.length === 0 && (
                          <div className={cc.empty}>{t('search.noMatches')}</div>
                        )}
                        {currentRemote.status === 'ready' && currentRemote.hasMore && (
                          <div className={cc.searchStatus}>
                            {t('search.hasMore', { n: SESSION_SEARCH_RESULT_LIMIT })}
                          </div>
                        )}
                      </div>
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
                          return (
                          <div
                            key={workspace.id}
                            className={clsx(
                              cc.workspaceGroup,
                              workspace.ungrouped && cc.ungroupedGroup,
                              marker === 'before' && cc.dropBefore,
                              marker === 'after' && cc.dropAfter,
                            )}
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
                            <div
                              className={clsx(
                                cc.workspaceHeader,
                                sessions.some(session => session.id === currentId) && cc.groupContainsCurrent,
                              )}
                              draggable={workspace.ungrouped !== true}
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
                                }}
                            >
                              <button
                                type="button"
                                className={clsx(cc.foldToggle, folded && cc.foldToggleFolded)}
                                aria-label={folded ? t('workspace.expand') : t('workspace.collapse')}
                                onClick={() => {
                                  if (suppressClickRef.current) return
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
                                return (
                                <Fragment key={session.id}>
                                  {renaming !== null && renaming.sourceId === server.id
                                  && renaming.kind === 'session' && renaming.id === session.id ? (
                                    renameForm(server.id, 'session', session.id, session.title, true)
                                  ) : (
                                    <div
                                      className={clsx(
                                        cc.sessionRow,
                                        session.id === currentId && cc.sessionActive,
                                        sessionMarker(session.id) === 'before' && cc.dropBefore,
                                        sessionMarker(session.id) === 'after' && cc.dropAfter,
                                      )}
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
                                      onClick={() => {
                                        if (suppressClickRef.current) return
                                        openSession(server.id, session.id)
                                      }}
                                    >
                                      <span className={cc.sessionTitle}>{session.blank === true ? t('session.new') : (session.title || t('list.unnamed'))}</span>
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
                                          onSelect={() => {
                                            closeMenu(sessionKey)
                                            setRenaming({
                                              sourceId: server.id,
                                              kind: 'session',
                                              id: session.id,
                                              value: session.title,
                                            })
                                          }}
                                          items={[
                                            {
                                              id: 'rename',
                                              label: t('action.rename'),
                                              icon: <IconEditOutline16 size={14} />,
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
                                            onArchiveSession(server, session.id, session.blank === true ? t('session.new') : session.title)
                                          }}
                                        >
                                          <IconArchiveOutline20 size={14} />
                                        </button>
                                      </span>
                                      {/* Trailing state slot: the ring/dot at the
                                          row's right edge — never replaced by the
                                          hover actions (those take the time cell's
                                          place). */}
                                      <span
                                        className={clsx(cc.sessionStateSlot, sessionStatePending(server, session) !== undefined && cc.sessionStateSlotPending)}
                                        title={sessionStateLabel(server, session)}
                                        aria-label={sessionStateLabel(server, session)}
                                        role="status"
                                      >
                                        {sessionStateDot(server, session)}
                                      </span>
                                    </div>
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
