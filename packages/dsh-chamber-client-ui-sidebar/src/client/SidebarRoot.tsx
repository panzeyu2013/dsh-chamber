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
 * derived from the source id (hue hash); the local source omits the accent
 * and falls back to the default ink. The accent also feeds the active
 * source/session left inset through a per-element CSS variable
 * (--dsh-source-accent). A session row click asks
 * the App layer to switch to that source's
 * shell and open the session (chamberBridge.requestOpenSession); clicking a
 * remote source's header asks the App layer to switch the active N-ctx view
 * WITHOUT opening a session (chamberBridge.requestActivateSource). Session
 * rows show a state indicator in a fixed TRAILING slot at the row's very end
 * (normal = empty; running = the official dsh ongoing blue RING; pending
 * interactions = a distinguishable 14px icon badge — question `?`,
 * plan-review checklist, approval warning triangle; completed-but-unread = a
 * persistent blue DOT — the slot is not a
 * server-identity marker; identity rides the source header accent (fold
 * glyph + active inset) and the rail dots — the old header identity DOT was
 * removed (user feedback)). Hover swaps
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
 * the derived workspace list (grouped from session/list cwd facts)
 * instead of pretending there are no workspaces (an
 * active search query keeps its results visible above that error).
 * Disconnected sources render the header (the status dot/spinner always
 * shows the phase kind — no status text, the raw transport reason never
 * surfaces on the main surface (the connections settings page carries the
 * detailed logSummary)); with every source disconnected the list appends
 * the empty hint under the groups. The rail
 * renders the source color dots. Workspace groups fold/unfold via a header
 * chevron toggle; fold state + ungrouped order live in ONE shared live store
 * (view prefs, 06 §3: getViewPrefs/subscribeViewPrefs/
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
 * runtime facts through a tokenized chamberBridge runtime producer, the App layer
 * merges them into server.runtime, and this shell highlights the matching
 * row (official selected tint) and marks its workspace group with an accent
 * chevron — without subscribing to any store. The highlight is
 * single-selection: only the source owning this visible ctx
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
 *
 * Chamber fourth round (会话待办区): a PINNED attention block above
 * the scroll region (wide only) — the pure projection derivation
 * (shared/todo-attention.ts) over the SAME merged runtime facts the rows
 * render: completed-but-unread sessions and sessions waiting for an
 * interaction (approval / plan-review / question). Cap 3 +「还有 N 项」
 * expand; click = the authoritative open path (switch source shell if
 * needed + open the conversation) — removal is projection-driven (read /
 * interaction resolved), never optimistic and never dependent on list
 * visibility; the strip never mutates shared fold/view prefs. The master
 * switch + per-kind gates live in the chamber-global「通用」settings
 * (sessionTodo block) and are mirrored read-only here
 * (shared/todo-prefs.ts).
 */
import { Component, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  BrandWordmark, FishLogo, IconNewChatOutline16, IconPanelLeftOutline16, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarRootComponentProps } from './contract/slots.ts'
import { chamberBridge, type ChamberServerAggregate } from '../shared/aggregate-store.ts'
import {
  armBlankGhost, BLANK_GHOST_GRACE_MS, increasedForkTitle, nextServerOrder, nextUpdatedOrder,
  orderServersForDisplay, reconciledSessionOrder, serversProjectionSignature, sourceAccentColor,
  type SessionOrderBy,
} from '../shared/derive.ts'
import {
  archiveSession, createHostDirectory, createSession, createWorkspace, deleteWorkspace,
  forkSession, getInstanceClient, insertSessionBefore, insertWorkspaceBefore, listHostDirectory,
  previewArchiveCleanup, purgeArchivedSessions, renameSession, renameWorkspace, searchSessions,
} from '../shared/instance-api.ts'
import { DirectoryBrowser } from '@deepseek-ai/dsh-client-ui-directory-picker-browse/client/DirectoryBrowser.tsx'
import { setSearchFetcher, getSearchStates, subscribeSearch } from '../shared/search-state.ts'
import { SessionTodoArea } from './SessionTodoArea.tsx'
import {
  clearSourceBookkeeping, flushScheduledActivityWrites, getViewPrefs, scheduleUpdatedOrderWrite,
  subscribeViewPrefs, updateViewPrefs,
  type ChamberSidebarViewPrefs,
} from '../shared/view-prefs.ts'
import { clearPendingClick, isClickInsidePendingRow } from '../shared/pending-click.ts'
import { getWorkspaceGitFlag, getWorkspaceGitFlagsVersion, subscribeWorkspaceGitFlags } from '../shared/workspace-git-flags.ts'
import { resolveWorkspaceDrop } from '../shared/workspace-drag-order.ts'
import { ServerSection } from './ServerSection.tsx'
import {
  SidebarSectionContext, sourceAccentStyle, workspaceDropEnv,
  type RenameTarget, type ServerDragState, type SessionDragState, type SidebarSectionContextValue,
  type WorkspaceDragState,
} from './sidebar-context.ts'
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
 * Remote sources carry the derived accent; the local source keeps the default
 * dot. Soft palette: 34% saturation at 61% lightness, matching the workspace
 * icon accents. The source-header identity DOT is gone (user feedback); this
 * color survives on the rail dots, the active-source left inset and the
 * source fold-toggle glyph only. ONE palette definition: shared/derive.ts
 * sourceAccentColor (the session-todo source dot consumes the same helper).
 */
function sourceDotStyle(server: ChamberServerAggregate): CSSProperties | undefined {
  const color = sourceAccentColor(server.id)
  return color === undefined ? undefined : { backgroundColor: color }
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
  // flags (worktree fold-button swap / create-from-main gating). The flags
  // store's MONOTONIC VERSION is the snapshot: a store change re-renders — a
  // constant snapshot would never trigger React.
  useSyncExternalStore(subscribeWorkspaceGitFlags, getWorkspaceGitFlagsVersion, getWorkspaceGitFlagsVersion)

  // chamber (06 §3 — cross-ctx live sync): view preferences (folded
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

  // chamber (06 §2.4): server-level fold — collapses the source's ENTIRE
  // workspace list (all workspace groups hidden). Deliberately a SEPARATE
  // preference from per-workspace `folded`: collapsing the server must NOT
  // fold each workspace's conversations, so expanding the server restores
  // every workspace with its sessions exactly as they were (user rule: 不要
  // 折叠 workspace 中的对话). Expanding the LAST folded source deletes the
  // field entirely — no permanent empty-object key in the persisted prefs.
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

  // chamber (06 §2.4): the server groups render in the user's persisted
  // display order when one exists (local view preference only — the App's
  // N-ctx residency/prewarm order and the instance registry are untouched;
  // navigation is id-keyed). The rail dots share the same order so both
  // views agree.
  const orderedServers = useMemo(
    () => orderServersForDisplay(servers, viewPrefs.serverOrder),
    [servers, viewPrefs.serverOrder],
  )

  // chamber (06 §3.1): explicit per-source sort selection through the
  // source-header menu (official ViewOptionsMenu pattern). The choice lives
  // in the shared view prefs (`orderBy` keyed by sourceId, default manual).
  // Entering updated clears the source's activity BOOKKEEPING
  // (sessionUpdatedAtByAccount) so the derivation effect below does ONE full
  // recency sort (official switchedToUpdated) while keeping the existing
  // updatedOrder accounts (re-entry re-sorts them). The source's transient
  // session-order overrides are dropped either way: entering updated renders
  // the account order — an in-flight manual wire commit is only reflected if
  // it lands before the next projection; entering manual restores wire order.
  const setOrderBy = (server: ChamberServerAggregate, mode: SessionOrderBy): void => {
    if ((viewPrefs.orderBy?.[server.id] ?? 'manual') === mode) return
    // 先终刷防抖窗内 pending 的 promotion 簿记再落盘——否则窗末 flush 会把
    // 刚被清掉的簿记重新合并回去，一次性全量 recency 排序被跳过。
    flushScheduledActivityWrites()
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
  // (stale poll data). Overrides are MANUAL-mode only —
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
        // Hygiene: an override left over from a source that has since
        // switched to updated is dropped — updated mode renders the account
        // order, never this map (setOrderBy drops the source's in-flight
        // overrides at switch time); manual mode still reconciles against
        // the wire confirmation.
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
          : server.workspaces.filter(workspace => workspace.ungrouped !== true && workspace.synthetic !== true)
            .map(workspace => workspace.id)
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

  // chamber (06 §3.1 — updated = manual + activity
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
    // 置顶写回**防抖**——会话流式更新期间每个投影 tick 都推进 updatedAt，
    // 逐 tick 直写会把整份 prefs 的落盘 + 全壳通知放大到更新频率。派生结果
    // 改经共享固定窗（scheduleUpdatedOrderWrite，view-prefs.ts）按账户合并、
    // 窗末终刷一次；末 tick 自窗基态重派生、结果自洽（与逐 tick 落盘在交错
    // 突发/首观察窗存在排序级差异，无数据丢失）。合并目标仍是 updateViewPrefs
    // 的 prev（共享缓存，非渲染快照）——其它 shell 的落盘不被覆盖；离散写
    // （拖拽/排序切换）写前先 flush，窗末终刷绝不覆盖更新的用户手势。
    for (const [accountKey, order] of Object.entries(pendingOrder)) {
      scheduleUpdatedOrderWrite(accountKey, order, pendingTimestamps[accountKey])
    }
  }, [servers, viewPrefs])

  // chamber (06 §2.2): in-source drag state. Cross-source drops are
  // structurally impossible — every target handler is gated on the drag's
  // sourceId matching the hovered group's source.
  const [sessionDrag, setSessionDrag] = useState<SessionDragState | null>(null)
  const [workspaceDrag, setWorkspaceDrag] = useState<WorkspaceDragState | null>(null)
  // chamber (06 §2.4): server-group drag state
  // (display-order preference only — commit writes view-prefs, no wire).
  const [serverDrag, setServerDrag] = useState<ServerDragState | null>(null)
  const sessionDropCommitted = useRef(false)
  const workspaceDropCommitted = useRef(false)
  const serverDropCommitted = useRef(false)
  /** Per-source tail of the workspace ORDER commits (see commitWorkspaceDrag):
   *  overlapping family-block moves must not interleave their per-member
   *  wire inserts on the host. */
  const orderCommitTail = useRef(new Map<string, Promise<void>>())
  // Some browsers dispatch a trailing `click` after an aborted drag or a
  // drop; the flag set on dragstart (and cleared a tick after dragend) keeps
  // that click from opening the session the row no longer represents.
  const suppressClickRef = useRef(false)
  // Whether the CURRENT pointer press started on a header BUTTON: dragstart's
  // `target` is the drag SOURCE (the header), not the pressed element, so the
  // press target is recorded on pointerdown and consulted on dragstart — a
  // gesture that began on a button (fold / sort / add-workspace / search / +
  // / kebab / git actions) must never initiate a header drag: a >4px
  // micro-drag on the fold toggle would swallow its click.
  const dragPressOnButtonRef = useRef(false)
  useNativeDragAcceptance(sessionDrag !== null || workspaceDrag !== null || serverDrag !== null)

  // chamber (06 §2.4): while a SERVER drag
  // is active, a pointer outside every source section clears the insert
  // marker — releasing outside the list cancels instead of committing the
  // last hovered marker. Session/workspace drags KEEP the §2.2 semantics
  // (release-outside commits); the server drag moves a WHOLE group, so the
  // blast radius warrants the stricter rule. Only the boolean flips the
  // effect; the functional updater keeps the closure stale-free.
  useEffect(() => {
    if (serverDrag === null) return
    const clearMarkerOutsideSections = (event: DragEvent): void => {
      if (!(event.target instanceof Element)) return
      if (event.target.closest('[data-chamber-section]') !== null) return
      setServerDrag(current => (current === null || current.over === null ? current : { ...current, over: null }))
    }
    document.addEventListener('dragover', clearMarkerOutsideSections)
    return () => document.removeEventListener('dragover', clearMarkerOutsideSections)
  }, [serverDrag === null])

  // chamber (design 06 §2.2): blank-row GHOST slot — the
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

  // chamber (06): the session row's single click opens the session IMMEDIATELY
  // (zero delay); double-click-to-rename is detected by click timestamps on
  // the SAME session id — no timer ever delays an open (the OpenChamber row
  // behavior this N-ctx design drew from). The DOUBLE_CLICK_WINDOW_MS window
  // is kept only as a RENAME guard: the pending is a module-global
  // { sessionId, at } slot, a second click within the window on the same
  // session enters inline rename, and every other click opens right away.
  // openSession is idempotent, so a misjudged slow second click only re-opens
  // (no-op) and can NEVER accidentally rename.
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
  // The document-wide click listener only guards the rename window: a click
  // anywhere OUTSIDE the pending row
  // drops the pending — the row's own onClick runs before this listener and
  // consumes/replaces the pending itself, so only outside clicks reach here.
  // suppressClickRef (drag-end trailing click) is honored on the way in;
  // row-internal buttons (fold toggle / new-session / kebabs / archive) AND
  // the source-header action buttons (sort / add-workspace / search /
  // archive-cleanup purge — design 24 §6) clear the pending in their own
  // handlers (stopPropagation + clearPendingClick) —
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
  // chamber (06 §3.1): close the sort menu when its source can no longer
  // render the anchor (source vanished, disconnected, or a snapshot-fetch
  // error with no open search capsule) — otherwise the state leaks and the
  // menu pops open unprompted on reconnect. Runs shell-wide because the
  // per-source sections are UNMOUNTED on the rail (collapsed): a disconnect
  // while collapsed must still close the menu id.
  const searchStates = useSyncExternalStore(subscribeSearch, getSearchStates, getSearchStates)
  useEffect(() => {
    if (sortMenuOpen === null) return
    const server = servers.find(candidate => candidate.id === sortMenuOpen)
    if (server === undefined) {
      setSortMenuOpen(null)
      return
    }
    const search = searchStates.get(sortMenuOpen)
    if (!server.connected || (server.aggregateError !== undefined && search?.expanded !== true)) {
      setSortMenuOpen(null)
    }
  }, [servers, sortMenuOpen, searchStates])

  // chamber (行内重命名): a rename armed on a row that leaves the projection
  // (workspace deleted by another ctx, source snapshot dropped / disconnect,
  // …) must not stay armed invisibly — it would re-materialize the stale
  // form (with its typed text) when the id reappears. Mirrors the sort-menu
  // cleanup above: drop the target once its row no longer exists.
  useEffect(() => {
    if (renaming === null) return
    const server = servers.find(candidate => candidate.id === renaming.sourceId)
    const alive = server !== undefined && (renaming.kind === 'workspace'
      ? server.workspaces.some(workspace => workspace.id === renaming.id)
      : server.workspaces.some(workspace => workspace.sessions.some(session => session.id === renaming.id)))
    if (!alive) setRenaming(null)
  }, [servers, renaming])
  const [addingWorkspace, setAddingWorkspace] = useState<string | null>(null)
  const [addingWorkspaceBusy, setAddingWorkspaceBusy] = useState(false)
  // Design 24 §6: per-server archive-cleanup in-flight stage ('preview' |
  // 'purge') and the server-level info line (empty state / skipped / partial
  // results). Errors ride the generic rowErrors map under the
  // `<serverId>/archive-cleanup` key.
  const [purgeInFlight, setPurgeInFlight] = useState<Record<string, 'preview' | 'purge'>>({})
  const [cleanupNotes, setCleanupNotes] = useState<Record<string, string>>({})

  // Design 24 (review follow-up F9): mounted guard for the purge flow's async
  // continuations. A preview/purge can outlive this tree (ctx close / runtime
  // restart while the wire call is in flight), and the continuations must not
  // run the three purge state setters after unmount — benign under React 18
  // today, but undocumented. The unmount cleanup flips the ref; every
  // post-await write below checks it. chamberBridge.requestRefresh is NOT
  // gated here: its App-side consumers are global/generation-fenced (the App
  // layer owns refresh fan-out per instance, not this tree's state), and the
  // host purge may still have completed — a live App generation should pull.
  const disposedRef = useRef(false)
  useEffect(() => {
    disposedRef.current = false
    return () => { disposedRef.current = true }
  }, [])

  /** Run one keyed action; the returned promise resolves AFTER the action
   *  settled (a rejection already wrote its message into rowErrors) — callers
   *  use it to serialize dependent commits. */
  const runAction = (key: string, action: () => Promise<void>): Promise<void> => {
    setRowErrors((prev) => {
      const next = { ...prev }
      delete next[key]
      return next
    })
    return action().catch((reason: unknown) => {
      const message = reason instanceof Error ? reason.message : String(reason)
      setRowErrors((prev) => ({ ...prev, [key]: message }))
    })
  }

  const openSession = (serverId: string, sessionId: string): void => {
    chamberBridge.requestOpenSession(serverId, sessionId)
  }

  // chamber (会话待办区): the strip's guarded open — same authority
  // as a row click, plus the two guards a row click already gets at its call
  // site: the drag-end trailing-click suppression (suppressClickRef) and the
  // same-session inline-rename exclusion (opening the session whose rename
  // form is on screen would discard the edit mid-typing).
  const requestTodoOpen = (sourceId: string, sessionId: string): void => {
    if (suppressClickRef.current) return
    if (renaming !== null && renaming.kind === 'session'
      && renaming.sourceId === sourceId && renaming.id === sessionId) return
    openSession(sourceId, sessionId)
  }

  /**
   * chamber (design 06 §2.2): arm the blank-row GHOST
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
    armBlankGhost(active.id, current)
    ghostExpiry.current.set(current, Date.now() + BLANK_GHOST_GRACE_MS)
    // The one-shot timer trims itself from the ref once it fires, so repeated
    // armings (rare, but each timer outlives the 450ms grace) cannot grow
    // ghostTimers unboundedly.
    const timerId = window.setTimeout(() => {
      setGhostTick(tick => tick + 1)
      const index = ghostTimers.current.indexOf(timerId)
      if (index >= 0) ghostTimers.current.splice(index, 1)
    }, BLANK_GHOST_GRACE_MS)
    ghostTimers.current.push(timerId)
  }

  // chamber (06): fork a session at its last completed turn, refresh, and
  // open the child — the official row-menu fork→open flow (设计 06 §0 原判
  // 「回合尾部 forkAt 覆盖、侧边栏不做」本轮契约反转：行内 kebab 增加分叉入口).
  // Wire session.fork 只收 { sessionId, atSeq? }（increaseTitle 非 wire
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

  /** Design 24 §6: server-row "delete archived content" action. Full-flow
   *  per-server single-flight (preview → confirm → purge); preview is a
   *  point-in-time snapshot for the confirm copy only — the purge re-reads
   *  authoritative state. Liveness is re-checked before the confirm (a
   *  stale preview after a mid-flight disconnect never confirms). Errors
   *  land in rowErrors; empty/skipped/partial results land in cleanupNotes
   *  (both rendered in the header-under slot, fold- and search-independent). */
  const onPurgeArchived = (server: ChamberServerAggregate): void => {
    const key = `${server.id}/archive-cleanup`
    if (purgeInFlight[server.id] !== undefined) return
    setPurgeInFlight(prev => ({ ...prev, [server.id]: 'preview' }))
    setCleanupNotes(prev => {
      if (!(server.id in prev)) return prev
      const next = { ...prev }
      delete next[server.id]
      return next
    })
    setRowErrors(prev => {
      if (!(key in prev)) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })
    void (async () => {
      try {
        const preview = await previewArchiveCleanup(getInstanceClient(server.id))
        // F9 (review follow-up): the tree may have unmounted while the wire
        // call was in flight (ctx close / runtime restart) — skip every state
        // write AND the confirm on a dead tree. The liveness re-check below
        // covers disconnects; this covers unmount.
        if (disposedRef.current) return
        // Re-check liveness after the async preview (never confirm stale).
        // aggregateError no longer gates (E-m2): it only reflects the list
        // snapshot — a succeeded preview is itself wire-health proof.
        const latest = serversRef.current.find(candidate => candidate.id === server.id)
        if (latest === undefined || !latest.connected) {
          // Source vanished/disconnected mid-preview: drop silently — the
          // disconnect effect clears leftovers and nothing stale may
          // resurface after a reconnect (E-m3 write-time discipline).
          return
        }
        if (preview.deletableSessions === 0 && preview.deletableSubagents === 0) {
          setCleanupNotes(prev => ({
            ...prev,
            [server.id]: preview.skippedRunning > 0
              ? `没有可删除的已归档会话（${preview.skippedRunning} 项因运行中被跳过）。`
              : '没有可删除的已归档会话。',
          }))
          return
        }
        const baseConfirm = t('confirm.purgeArchived', {
          sessions: preview.deletableSessions,
          subagents: preview.deletableSubagents,
        })
        const skippedSuffix = preview.skippedRunning > 0
          ? t(preview.skippedRunning === 1
            ? 'confirm.purgeArchivedSkipped.one'
            : 'confirm.purgeArchivedSkipped.other', { skipped: preview.skippedRunning })
          : ''
        if (!window.confirm(baseConfirm + skippedSuffix)) return
        setPurgeInFlight(prev => ({ ...prev, [server.id]: 'purge' }))
        const result = await purgeArchivedSessions(getInstanceClient(server.id))
        // F9: the refresh is deliberately UNCONDITIONAL — even on a dead tree
        // the host purge may have completed, and chamberBridge's App-side
        // consumers are global/generation-fenced (a refresh is a global
        // mutation-pull request for this instance, never this tree's state),
        // so a late request is safe and possibly still wanted.
        chamberBridge.requestRefresh(server.id)
        if (disposedRef.current) return
        // E-m3: write-time liveness check — nothing written after a
        // disconnect (the effect may have already run; stale messages must
        // not resurface on reconnect).
        const stillLive = serversRef.current.some(candidate => candidate.id === server.id && candidate.connected)
        const lines: string[] = []
        if (result.deletedSessions > 0 || result.deletedSubagents > 0) {
          lines.push(`清理完成：删除 ${result.deletedSessions} 个会话 / ${result.deletedSubagents} 个子代理内容。`)
        }
        if (result.skippedRunning > 0) {
          lines.push(`已跳过 ${result.skippedRunning} 项运行中的会话（未删除）。`)
        }
        if (result.truncated === true && result.errors.length >= 1000) {
          lines.push('失败明细过多，仅显示前 1000 项。')
        }
        if (result.errors.length > 0) {
          // Partial failure is never silent: warnings ride the error slot.
          lines.push(`${result.errors.length} 项失败，可重试（重复执行安全）。`)
          if (stillLive) setRowErrors(prev => ({ ...prev, [key]: lines.join(' ') }))
          return
        }
        if (lines.length === 0 && stillLive) {
          // E-n2: another shell may have purged between preview and this run
          // — an empty outcome must never be silent.
          lines.push('没有可删除的已归档会话。')
        }
        if (lines.length > 0 && stillLive) setCleanupNotes(prev => ({ ...prev, [server.id]: lines.join(' ') }))
      } catch (error) {
        if (disposedRef.current) return
        // E-m6: a second shell's busy refusal gets one friendly line.
        const message = error instanceof Error ? error.message : String(error)
        const friendly = message.startsWith('busy:')
          ? '该实例正在执行另一处清理，请稍后重试。'
          : message
        const stillLive = serversRef.current.some(candidate => candidate.id === server.id && candidate.connected)
        if (stillLive) setRowErrors(prev => ({ ...prev, [key]: friendly }))
      } finally {
        if (!disposedRef.current) {
          setPurgeInFlight(prev => {
            const next = { ...prev }
            delete next[server.id]
            return next
          })
        }
      }
    })()
  }

  // Design 24 §6: drop server-level cleanup errors/info when the source is
  // gone or disconnected (stale messages must not resurface after a
  // reconnect). The in-flight stage is also cleared — a reconnect starts a
  // fresh flow. ACKNOWLEDGED WINDOW (review follow-up F9; design 24 §6 step-2
  // / §8 accept it): a disconnect mid-flow clears the local in-flight marker
  // while the HOST purge may still be running (client timeout ≠ host stop),
  // so a reconnected shell can re-confirm and re-run a purge on top of that
  // earlier run — the resulting reconnect double-confirm window is bounded by
  // the host `busy` single-flight backstop (a concurrent second purge gets
  // ok:false busy → the friendly E-m6 line) and by purge idempotency (an
  // earlier run that already finished makes the rerun a safe no-op). No local
  // serialization is attempted across reconnects by design.
  useEffect(() => {
    const liveIds = new Set(servers.filter(server => server.connected).map(server => server.id))
    setCleanupNotes(prev => {
      const stale = Object.keys(prev).filter(id => !liveIds.has(id))
      if (stale.length === 0) return prev
      const next = { ...prev }
      for (const id of stale) delete next[id]
      return next
    })
    setRowErrors(prev => {
      const suffix = '/archive-cleanup'
      const stale = Object.keys(prev).filter(key =>
        key.endsWith(suffix) && !liveIds.has(key.slice(0, -suffix.length)))
      if (stale.length === 0) return prev
      const next = { ...prev }
      for (const key of stale) delete next[key]
      return next
    })
    setPurgeInFlight(prev => {
      const stale = Object.keys(prev).filter(id => !liveIds.has(id))
      if (stale.length === 0) return prev
      const next = { ...prev }
      for (const id of stale) delete next[id]
      return next
    })
  }, [servers])

  const onDeleteWorkspace = (server: ChamberServerAggregate, workspaceId: string, title: string): void => {
    // An ORPHANED workspace (path gone) needs an explicit confirm —
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

  // Add-workspace directory browser (05 §4, unified in-app dialog): the
  // dialog drives the browsing source's own unary client (directoryPicker.list
  // / directoryPicker.createDirectory — the browse capability every managed
  // host serves, v0.1.2-alpha.1 namespace). The browse calls are
  // useCallback-stabilized: the vendor dialog
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
    // 先终刷防抖窗内 pending 的派生 order 再取锚点——否则窗末 flush 会用
    // tick 前派生的旧 order 整体覆盖本次拖拽提交（静默回退且不自愈）。
    if (orderBy === 'updated') flushScheduledActivityWrites()
    const renderedOrder = orderBy === 'updated'
      ? reconciledSessionOrder(getViewPrefs().updatedOrder?.[accountKey] ?? [], wireIds)
      : workspace.ungrouped === true
        ? reconciledSessionOrder(viewPrefs.ungroupedOrder[server.id] ?? [], wireIds)
        : sessionOrderOverride[accountKey] ?? wireIds
    // The order math is the same pure drop resolver the server-group drag
    // uses (nextServerOrder): null = no-op (vanished rows / already in
    // place), the caller writes the returned order into its own account.
    const nextOrder = nextServerOrder(renderedOrder, activeDrag.sessionId, over)
    if (nextOrder === null) return
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
    const sessionIndex = nextOrder.indexOf(activeDrag.sessionId)
    const anchor = sessionIndex === -1 || sessionIndex + 1 >= nextOrder.length
      ? undefined
      : nextOrder[sessionIndex + 1]
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

  // chamber (06 §2.2): real-workspace drag commit — the drop resolver
  // (shared/workspace-drag-order.ts) is the single authority for the whole
  // drag surface (marker, onDragOver gate, this commit): it returns the next
  // full order, a no-op (vanished pieces / already in place) or blocked (a
  // drop that would split a contiguous repo family — e.g. a foreign workspace
  // into a worktree group's interior, or a worktree out of its own group;
  // design 08 §11). A blocked/no-op verdict leaves the order untouched. A
  // MOVE of a git family's main carries the whole family (moved = main first,
  // then its worktrees): each member is re-anchored in order, one wire call
  // per member (insertWorkspaceBefore is single-row; the optimistic override
  // shows the final order while the calls land).
  const commitWorkspaceDrag = (
    server: ChamberServerAggregate,
    activeDrag: WorkspaceDragState,
    over: NonNullable<WorkspaceDragState['over']>,
  ): void => {
    if (workspaceDropCommitted.current) return
    workspaceDropCommitted.current = true
    setWorkspaceDrag(null)
    // Synthetic cwd-derived groups (`__cwd__:` ids) have no host workspace
    // identity: they are neither draggable nor a drop target.
    const realWorkspaceIds = server.workspaces
      .filter(workspace => workspace.ungrouped !== true && workspace.synthetic !== true)
      .map(workspace => workspace.id)
    const env = workspaceDropEnv(server.id, realWorkspaceIds, workspaceOrderOverride[server.id], viewPrefs.folded)
    const verdict = resolveWorkspaceDrop(env, activeDrag.workspaceId, over)
    if (verdict.kind !== 'move') return
    setWorkspaceOrderOverride(prev => ({ ...prev, [server.id]: verdict.order }))
    // The wire anchor is the element the moved block lands BEFORE (undefined
    // = append); every member is anchored on it in block order, so the host
    // order ends up exactly `verdict.order`.
    const movedLast = verdict.moved[verdict.moved.length - 1]!
    const lastIndex = verdict.order.indexOf(movedLast)
    const wireAnchor = lastIndex === -1 || lastIndex + 1 >= verdict.order.length
      ? undefined
      : verdict.order[lastIndex + 1]
    // Order commits serialize PER SOURCE: a family-block move is one wire
    // insert per member, and two overlapping commits (a second drop while the
    // first is still in flight) must not interleave their anchors on the host
    // — that would split the family silently. The next commit waits for the
    // previous one; each insert anchors by id, so a queued commit still
    // converges to its own verdict order regardless of the earlier state.
    const tail = orderCommitTail.current.get(server.id) ?? Promise.resolve()
    const commit = runAction(`${server.id}/workspace-drag/${activeDrag.workspaceId}`, async () => {
      await tail
      try {
        const client = getInstanceClient(server.id)
        for (const workspaceId of verdict.moved) {
          await insertWorkspaceBefore(client, workspaceId, wireAnchor)
        }
        chamberBridge.requestRefresh(server.id)
      } catch (error) {
        // A failed commit must not keep masquerading as committed: drop the
        // optimistic override immediately, the projection shows wire truth.
        // The refresh also converges a PARTIAL multi-member failure (some of
        // the family's rows moved before the error) to the host's real order.
        setWorkspaceOrderOverride(prev => {
          const next = { ...prev }
          delete next[server.id]
          return next
        })
        chamberBridge.requestRefresh(server.id)
        throw error
      }
    })
    orderCommitTail.current.set(server.id, commit)
    void commit.finally(() => {
      if (orderCommitTail.current.get(server.id) === commit) orderCommitTail.current.delete(server.id)
    })
  }

  // chamber (06 §2.4): server-group
  // drag commit. Pure DISPLAY preference — persists the new order into the
  // shared `serverOrder` view pref (cross-ctx live sync), NO wire, NO
  // App-layer N-ctx/registry change (navigation is id-keyed, never
  // order-keyed). The anchor math lives in the pure `nextServerOrder`
  // (unit-tested); `null` = no-op (unchanged position / vanished target) —
  // the write is skipped. The anchor math runs INSIDE
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

  // chamber: ONE context value per render — every per-source section reads
  // its cross-cutting state/actions through the provider (sidebar-context.ts)
  // instead of threading ~40 props through three component levels. The shell
  // owns every store/effect/commit below; ServerSection only consumes.
  const ctxValue: SidebarSectionContextValue = {
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
    purgeInFlight,
    cleanupNotes,
    onPurgeArchived,
    setAddingWorkspace,
    openSession,
    onNewSession,
    onArchiveSession,
    onForkSession,
    onDeleteWorkspace,
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
        {/* chamber (会话待办区): the pinned attention block above the
            scroll region — wide only, renders only while it has entries (pure
            projection derivation, see SessionTodoArea.tsx). INSIDE the region
            boundary: a malformed projection or a translate throw must never
            take the whole shell down (boundary discipline). */}
        {wide ? (
          <>
          <SessionTodoArea
            servers={orderedServers}
            chamberInstanceId={chamberInstanceId ?? ''}
            requestOpen={requestTodoOpen}
            t={t}
          />
        {/* chamber (scroll sync): the scroll container carries
            data-chamber-sidebar-scroll + each row data-chamber-row so the
            renderer's sidebar-scroll-sync can anchor the outgoing shell's
            scroll and restore the same rows at the same screen position in
            the incoming shell on N-ctx view switch. */}
          <div className={cc.chamberList} data-chamber-sidebar-scroll="">
            <SidebarSectionContext.Provider value={ctxValue}>
            {orderedServers.map((server) => (
              <ServerSection key={server.id} server={server} />
            ))}

            {servers.every((server) => !server.connected) && (
              <div className={cc.empty}>{t('list.empty')}</div>
            )}
            </SidebarSectionContext.Provider>
          </div>
          </>
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
