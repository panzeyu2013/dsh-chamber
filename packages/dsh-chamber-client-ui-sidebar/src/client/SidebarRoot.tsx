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
 * (--chamber-source-accent). A session row click asks
 * the App layer to switch to that source's
 * shell and open the session (chamberBridge.requestOpenSession); clicking a
 * remote source's header asks the App layer to switch the active N-ctx view
 * WITHOUT opening a session (chamberBridge.requestActivateSource). Session
 * rows show a state indicator in a fixed TRAILING slot at the row's very end
 * (normal = empty; running = the official dsh ongoing blue RING; pending
 * interactions = a distinguishable 14px icon badge — question `?`,
 * plan-review checklist, approval warning triangle; completed-but-unread = the
 * official StateDot `done` DOT — 2026-09-11 upstream-alignment T10, the
 * bespoke brand-blue 6px dot is gone — the slot is not a
 * server-identity marker; identity rides the source header accent (fold
 * glyph + active inset) and the rail dots — the old header identity DOT was
 * removed (user feedback)). Hover swaps
 * are TRUE replacements: the actions take no layout space at rest
 * (display:none), so the state icon really sits at the end; hovering swaps
 * the state slot for the row actions (source header: status ↔
 * sort menu + search + add-workspace; workspace header: count ↔ `+`+kebab).
 * Hover actions are
 * icon-based: a
 * workspace header carries a `+`
 * (new session) and a three-dot kebab menu (rename/delete); a session row
 * carries a three-dot kebab menu whose entries are rename / fork / archive —
 * 2026-09-11 upstream-alignment T2a: the archive verb lives in the row menu
 * (a second hover button is upstream's explicit anti-pattern, and archiving
 * needs no confirm because it only hides the row);
 * the add-workspace button lives in the source header (source-level creation,
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
 * renders one named, operable button per source (the source color dot + the
 * active accent ring are unchanged; 2026-09-11 upstream-alignment T7).
 * Workspace groups fold/unfold via a header
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
import type { ReactNode } from 'react'
import clsx from 'clsx'
import {
  BrandWordmark, FishLogo, IconNewChatOutline16, IconPanelLeftOutline16, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarRootComponentProps } from './contract/slots.ts'
import { chamberBridge } from '../shared/aggregate-store.ts'
import { getInstanceClient, searchSessions } from '../shared/instance-api.ts'
import { setSearchFetcher } from '../shared/search-state.ts'
import { SessionTodoArea } from './SessionTodoArea.tsx'
import { ServerSection, sourceHeaderActivatable, sourceHeaderTitle } from './ServerSection.tsx'
import { SidebarSectionContext, sourceAccentStyle, type SidebarSectionContextValue } from './sidebar-context.ts'
import { ChamberListBoundary, PanelRow, sourceDotStyle, type PanelsHook } from './sidebar-root-chrome.tsx'
import { useSidebarCollapse } from './sidebar-root-collapse.ts'
import { useSidebarProjection } from './sidebar-root-projection.ts'
import { useSidebarActions } from './sidebar-root-actions.ts'
import { useSidebarDrags } from './sidebar-root-drag.ts'
import { useSidebarGhost } from './sidebar-root-ghost.ts'
import { useSidebarClickGuard } from './sidebar-root-click-guard.ts'
import { useSidebarOpenOutcomes } from './sidebar-root-open-outcomes.ts'
import { useSidebarMenus } from './sidebar-root-menus.ts'
import { useSidebarSessionActions } from './sidebar-root-sessions.ts'
import { SidebarRootDialogs, useSidebarDialogs } from './sidebar-root-dialogs.tsx'
import css from './SidebarRoot.module.css'
import cc from './sidebar-chamber.module.css'

// Wire the shared search controller's wire fetch once at module scope (the
// controller stays a pure, plain-node-testable state machine; instance-api's
// unary client is browser/vite-only).
setSearchFetcher((sourceId, query, signal) => searchSessions(getInstanceClient(sourceId), query, signal))

export function SidebarRoot({
  collapsed,
  width,
  startSession,
  toggleSidebar,
  selectPanel,
  usePanels,
  usePanelInfo,
  chamberInstanceId,
  directoryBrowserT,
  t,
  renderSlot,
}: SidebarRootComponentProps) {
  // alpha.2 global panel axis: the shell renders one row per registration
  // (empty by default). The selector hook keeps a row's re-render scoped to
  // its own selection state.
  const panels = (usePanels as PanelsHook)(snapshot => snapshot)
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

  // The shell cross-cutting state is owned by per-subject hooks (2026-12
  // split). Each hook is called unconditionally in the order of the block it
  // was extracted from, so the effect ordering is unchanged.
  const { wide, column, lastWideWidth, everWide, pointerInside, setPointerInside, cancelLinger, armLinger } =
    useSidebarCollapse(collapsed, width)
  const {
    servers, viewPrefs, orderedServers, toggleWorkspaceFold, toggleSourceFold, setOrderBy,
    sessionOrderOverride, setSessionOrderOverride, workspaceOrderOverride, setWorkspaceOrderOverride,
  } = useSidebarProjection()
  const { rowErrors, setRowErrors, runAction, runActionWithOutcome } = useSidebarActions()
  const {
    sessionDrag, setSessionDrag, workspaceDrag, setWorkspaceDrag, serverDrag, setServerDrag,
    commitSessionDrag, commitWorkspaceDrag, commitServerDrag,
    sessionDropCommitted, workspaceDropCommitted, serverDropCommitted,
    suppressClickRef, dragPressOnButtonRef,
  } = useSidebarDrags({
    servers, viewPrefs, sessionOrderOverride, setSessionOrderOverride,
    workspaceOrderOverride, setWorkspaceOrderOverride, runAction,
  })
  const { ghostExpiry, armBlankGhostForClick } = useSidebarGhost({ servers, chamberInstanceId })
  useSidebarClickGuard()
  const { clearOpenRowError } = useSidebarOpenOutcomes({ setRowErrors })
  const {
    renaming, setRenaming, menuOpen, toggleMenu, closeMenu, sortMenuOpen, setSortMenuOpen, commitRename,
  } = useSidebarMenus({ servers, runAction })
  const { onForkSession, onNewSession, onArchiveSession } = useSidebarSessionActions({ runAction })
  const dialogs = useSidebarDialogs({ servers, runActionWithOutcome, setRowErrors })
  const { onOpenArchiveCleanup, openWorkspaceBrowser, onDeleteWorkspace } = dialogs

  const openSession = (serverId: string, sessionId: string): void => {
    // A fresh click dismisses any stale failure text on the row immediately
    // (the dispatch outcome will re-report it if it fails again).
    clearOpenRowError(serverId, sessionId)
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
    onOpenArchiveCleanup,
    openWorkspaceBrowser,
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
            {/* alpha.2 brand holes: the shell keeps the chamber wordmark as
                the mark fallback and renders nothing for an unregistered
                name occupant. */}
            <span className={css.brandIdentity} aria-hidden="true">
              <span className={css.brandMark}>
                {renderSlot('sidebar.brand.mark', { size: 24 }, { fallback: <BrandWordmark /> })}
              </span>
              {/* No name fallback: the chamber wordmark already carries the
                  product name in the mark hole, so an unoccupied name hole
                  renders nothing rather than duplicating it. */}
              <span className={css.brandName}>
                {renderSlot('sidebar.brand.name', {}, { fallback: null })}
              </span>
            </span>
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
            {!wide && (
              <span className={css.railMark} aria-hidden="true">
                {renderSlot('sidebar.brand.mark', { size: 24 }, { fallback: <FishLogo className={css.railFish} size={24} /> })}
              </span>
            )}
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

      {/* alpha.2 global panel axis: rows appear only when some plugin
          registers into `sidebar.panellist` (upstream ships none). */}
      {panels.length > 0 && (
        <nav className={css.panelList} aria-label={t('panels.label')}>
          {panels.map(panel => (
            <PanelRow
              key={panel.id}
              id={panel.id}
              label={panel.label}
              wide={wide}
              usePanelInfo={usePanelInfo}
              selectPanel={selectPanel}
              renderSlot={renderSlot}
            />
          ))}
        </nav>
      )}

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
          /* 2026-09-11 upstream-alignment T7: the rail renders one NAMED,
             operable button per source (upstream rail controls are buttons with
             an accessible name, vendor ui-sidebar SidebarRoot.tsx:63-68) — the
             inert title-only span is gone. The status display is unchanged: the
             coloured source dot and the active-source accent ring still paint on
             the inner span; the span→button swap changed no geometry — the dot
             PITCH stays the 20px the rail always had: the buttonization's own
             `margin: -4px 0` takes the 16px button box back down to the old 8px
             dot element, and only the 2026-09 rim pass's gap widening (12 →
             16px) was rolled back on 2026-09-14; the geometry contract is 06 §7's
             (the visual-lock suite that pinned it was retired in 2026-12).
             Operability mirrors the wide source header: activating a remote,
             usable source asks the App layer to switch the N-ctx view, the
             current source is marked aria-current, and a managed-down source
             stays non-activatable (its reason rides the accessible name — the
             header's own refusal, 2026-12 review MAJOR-2). */
          <div className={cc.railDots}>
            {orderedServers.map((server) => {
              const active = server.id === chamberInstanceId
              const hint = sourceHeaderTitle(server, chamberInstanceId, t)
              const activatable = sourceHeaderActivatable(server, chamberInstanceId)
              const label = hint === undefined ? server.label : `${server.label} · ${hint}`
              return (
                <Tooltip key={server.id} label={label} side="right" delayMs={500}>
                  <button
                    type="button"
                    className={cc.railDotButton}
                    aria-label={label}
                    aria-current={active ? 'true' : undefined}
                    aria-disabled={!active && !activatable ? true : undefined}
                    onClick={() => {
                      if (!activatable) return
                      chamberBridge.requestActivateSource(server.id)
                    }}
                  >
                    <span
                      className={clsx(cc.railDot, active && cc.railDotActive)}
                      style={{ ...sourceDotStyle(server), ...sourceAccentStyle(server) }}
                      // Decorative: the button's own aria-label carries the
                      // source identity + activation hint (upstream panel rows
                      // hide their glyph slot the same way).
                      aria-hidden="true"
                    />
                  </button>
                </Tooltip>
              )
            })}
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


      {/* The three chamber dialog layers (add-workspace browser / archive
          manager / workspace-delete confirm) are extracted to
          sidebar-root-dialogs.tsx, where the single-dialog-layer rule and all
          of their wiring live. */}
      <SidebarRootDialogs
        dialogs={dialogs}
        servers={servers}
        t={t}
        directoryBrowserT={directoryBrowserT}
      />

    </div>
  )
}
