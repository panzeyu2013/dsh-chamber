/**
 * One workspace group’s session-row list of the chamber sidebar ServerSection
 * subtree: the ghost-gated rows, their HoverCards, inline rename swap and the
 * per-row action-error slots. The section passes the windowed session list and
 * its resolved per-workspace values in.
 */
import { Fragment } from 'react'
import clsx from 'clsx'
import {
  IconArchiveOutline20, IconBranchOutline16, IconEditOutline16, IconEllipsisOutline16, Menu,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChamberServerAggregate, ChamberServerWorkspace } from '../shared/aggregate-store.ts'
import { relativeTimeBucket } from '../shared/derive.ts'
import { openErrorKey } from '../shared/open-outcome.ts'
import { clearPendingClick, noteSessionRowClick } from '../shared/pending-click.ts'
import { RowHoverCard } from './RowHoverCard.tsx'
import { ServerSectionRenameForm, SessionScheduleIndicator } from './server-section-controls.tsx'
import { dragOverState, rowHalf } from './server-section-model.ts'
import { useServerSectionSessionState } from './server-section-session-state.tsx'
import { useSidebarSection } from './sidebar-context.ts'
import cc from './sidebar-chamber.module.css'

export interface ServerSectionSessionRowsProps {
  server: ChamberServerAggregate
  workspace: ChamberServerWorkspace
  sessions: readonly ChamberServerWorkspace['sessions'][number][]
  currentId: string | undefined
  sessionMarker: (sessionId: string) => 'before' | 'after' | null
  activeSessionDrag: boolean
  now: number
  isGhostSession: (session: ChamberServerWorkspace['sessions'][number]) => boolean
}

export function ServerSectionSessionRows({ server, workspace, sessions, currentId, sessionMarker, activeSessionDrag, now, isGhostSession }: ServerSectionSessionRowsProps) {
  const {
    t,
    rowErrors,
    menuOpen,
    renaming,
    setRenaming,
    sessionDrag,
    workspaceDrag,
    serverDrag,
    setSessionDrag,
    commitSessionDrag,
    suppressClickRef,
    sessionDropCommitted,
    ghostExpiry,
    armBlankGhostForClick,
    openSession,
    onForkSession,
    onArchiveSession,
    toggleMenu,
    closeMenu,
  } = useSidebarSection()
  const { sessionStateLabel, sessionStatePending, sessionStateMarker, sessionStateDot } = useServerSectionSessionState()
  /** chamber (06): localized hover-card relative time ("刚刚"/"5分钟前" zh; "now"/"5min ago" en). */
  const hoverTimeLabel = (updatedAt: number, now: number): string => {
    const { unit, n } = relativeTimeBucket(updatedAt, now)
    return unit === 'now' ? t('time.now') : t('time.ago', { t: t(`time.${unit}`, { n }) })
  }
  return (
    <>
      {sessions.map((session) => {
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
                                // One row-title
                                // resolution shared by the row label and the row
                                // actions' accessible names (the blank label stays
                                // rendered-only — a blank row carries no actions).
                                // The OFFICIAL display label (never empty),
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
                                        setSessionDrag(current => dragOverState(current, session.id, half))
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
                                    {/* The
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
                                        // Same as the workspace menu above —
                                        // `closeOnPointerLeave` kept (Rows.tsx:487),
                                        // `compact`.
                                        compact
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
                                            // No title argument — the verb runs
                                            // immediately and nothing reads it.
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
                                            // The
                                            // archive verb lives HERE, in the row
                                            // menu — upstream keeps no second hover
                                            // button because archiving only hides the
                                            // row (it never touches the session log),
                                            // so it is neither destructive nor
                                            // confirm-gated (vendor ui-workspace
                                            // Rows.tsx:412-421). Glyph size is a
                                            // deliberate optical exception to the
                                            // compact slot: `compact` shrinks the
                                            // icon slot to 14px, but the 20-native
                                            // archive glyph stays at 16 so it keeps
                                            // the same visual weight as the
                                            // 16-native glyphs drawn at 14 beside
                                            // it (the flex slot tolerates +2px).
                                            id: 'archive',
                                            label: t('menu.archiveSession'),
                                            icon: <IconArchiveOutline20 size={16} />,
                                          },
                                        ]}
                                        anchor={(
                                          <button
                                            type="button"
                                            className={cc.actionIcon}
                                            // The row
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
                                            <IconEllipsisOutline16 size={16} />
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
                                      // 状态与出处（验收 DOM 判据；不参与渲染）。
                                      data-chamber-session-state={sessionStateMarker(server, session).state}
                                      // 这一行事实的观察时刻（host 域 ms；缺席 = 无观察者事实）。
                                      data-chamber-fact-at={server.runtime?.sessions[session.id]?.factAt}
                                      data-chamber-state-source={sessionStateMarker(server, session).source}
                                      // goal 呈现门生效标记（v5 §4 可选属性）：相位 active 即出现
                                      // ——含 activation unknown；压制中 state 绝不报 completed。
                                      data-chamber-goal-active={sessionStateMarker(server, session).goalActive ? '' : undefined}
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
                                    <ServerSectionRenameForm placeholder={session.title} mode="sessionRow" />
                                  ) : (
                                    <RowHoverCard
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
    </>
  )
}
