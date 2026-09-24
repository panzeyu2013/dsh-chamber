/**
 * One workspace group's session-row list of the chamber sidebar ServerSection
 * subtree: ghost-gated rows, their HoverCards, inline rename swap and the
 * per-row action-error slots. The section passes the windowed session list and
 * its resolved per-workspace values in.
 */
import { Fragment } from 'react'
import clsx from 'clsx'
import {
  IconArchiveOutline20, IconBranchOutline16, IconEditOutline16, IconEllipsisOutline16, Menu,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChamberServerAggregate, ChamberServerWorkspace } from '@dsh-chamber/dsh-chamber-client-core/aggregate-store'
import { relativeTimeBucket } from '@dsh-chamber/dsh-chamber-client-core/derive'
import { openErrorKey } from '@dsh-chamber/dsh-chamber-client-core/open-outcome'
import { clearPendingClick, noteSessionRowClick } from '@dsh-chamber/dsh-chamber-client-core/pending-click'
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
  /** 悬停卡片的本地化相对时间（"刚刚"/"5分钟前"）。 */
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
                                  // 打开失败落在同一槽位（低优先级——同一行的
                                  // rename/archive/fork 失败优先），key 模板与写入方共享。
                                  ?? rowErrors[openErrorKey(server.id, session.id)]
                                // 空白行在不再 current 后仍被投影 = GHOST：App 按
                                // BLANK_GHOST_GRACE_MS 保留它，使列表在双击窗口内不位移。
                                // 本地过期在渲染侧兜底：宽限过后即使 App 还没重派生也丢弃该
                                // 不可见占位（下次发布起从投影消失；两种情况都不显示陈旧行）。
                                const ghost = isGhostSession(session)
                                const ghostLive = ghost && (ghostExpiry.current.get(session.id) ?? 0) > Date.now()
                                if (ghost && !ghostLive) return null
                                // 会话行（上提以便 HoverCard 包裹）。单击立即打开、零延迟；
                                // 模块级 pending（按 sessionId 记）只判定同一会话在
                                // DOUBLE_CLICK_WINDOW_MS 内的第二次点击 → 内联重命名，其余点击记
                                // pending 后立即打开。suppressClickRef（拖拽尾随 click）入口即生效，
                                // 行外点击取消 pending（document 监听）；行渲染 data-session-id 供壳
                                // 做包含判定；标题用官方 displayTitle（绝不渲染"未命名会话"）。
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
                                    // 合成的 cwd 派生分组仅用于显示：其中的会话行既不能拖也不能放
                                    // （wire 提交会在宿主上以 workspace/not-found 失败）。
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
                                      // ghost 行是不可交互的布局占位（visibility:hidden，点击到不了）；防御性守卫。
                                      if (ghost) return
                                      // 菜单展开或本行重命名进行中：忽略整次点击（不 arm、不开会话）。
                                      if (menuOpen[sessionKey] === true || (renaming !== null
                                        && renaming.sourceId === server.id && renaming.kind === 'session' && renaming.id === session.id)) return
                                      // 单击立即打开（零延迟）：pending 只回答"是否同一会话在窗口内的
                                      // 第二次点击"，那次进入内联重命名；其余记 pending 后立即打开。
                                      // openSession 幂等，误判的慢第二次点击只重开（no-op），绝不可能误改名。
                                      if (noteSessionRowClick(server.id, session.id)) {
                                        // 空白"新建会话"占位行无内容可改名——双击不得进入内联重命名（会把暂存会话改名写到 wire）。
                                        if (session.blank === true) return
                                        setRenaming({
                                          sourceId: server.id,
                                          kind: 'session',
                                          id: session.id,
                                          value: session.title,
                                        })
                                        return
                                      }
                                      // 打开真实会话会把活动 current 从空白行切走，App 随后重派生——同步先 arm
                                      // ghost 槽占住布局位，列表在双击窗口内不位移，第二次点击仍落在目标行。
                                      armBlankGhostForClick()
                                      openSession(server.id, session.id)
                                    }}
                                  >
                                    <span className={cc.sessionTitle}>{session.blank === true ? t('session.new') : sessionTitleText}</span>
                                    {/* 活动 Schedule 标记位于标题与尾部单元之间；只对有该投影的行渲染，普通行几何/间距不变。 */}
                                    {session.hasActiveSchedule === true && (
                                      <SessionScheduleIndicator label={t('schedule.active')} />
                                    )}
                                    {/* 空白（新建）行是临时占位：kebab（含 fork/归档）作用于不存在的内容，整簇隐藏。 */}
                                    {session.blank !== true && (
                                    <span
                                      className={clsx(cc.rowActions, menuOpen[sessionKey] === true && cc.rowActionsVisible)}
                                      onClick={(event) => {
                                        // 不变量（见 pending-click.ts 头）：stopPropagation 必须与 clearPendingClick 成对。
                                        event.stopPropagation()
                                        clearPendingClick()
                                      }}
                                    >
                                      <Menu
                                        // 同上：保留 `closeOnPointerLeave`，用 `compact`。
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
                                          // 不传标题：动词立即执行，无人读取它。
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
                                          // 归档动词只在这里的行菜单：归档只隐藏行（不触碰会话日志），
                                          // 故既不破坏性也无确认门控。字形尺寸是对 compact 槽位的刻意
                                          // 光学例外：compact 把图标槽缩到 14px，但 20 原生的归档字形保持
                                          // 16，才与旁边按 14 画的 16 原生字形同视觉重量（flex 槽容忍 +2px）。
                                            id: 'archive',
                                            label: t('menu.archiveSession'),
                                            icon: <IconArchiveOutline20 size={16} />,
                                          },
                                        ]}
                                        anchor={(
                                          <button
                                            type="button"
                                            className={cc.actionIcon}
                                            // 行标题即无障碍名。
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
                                    {/* 尾部状态槽：行右缘的圆环/圆点。hover 时行动作簇换入、本槽换出
                                        （真正的替换，无占位）；role 条件式，空槽不得注册 live region。 */}
                                    <span
                                      className={clsx(cc.sessionStateSlot, sessionStatePending(server, session) !== undefined && cc.sessionStateSlotPending)}
                                      // 状态与出处的机器可读镜像（不参与渲染）。
                                      data-chamber-session-state={sessionStateMarker(server, session).state}
                                      // 该行事实的观察时刻（host 域 ms；缺席 = 无观察者事实）。
                                      data-chamber-fact-at={server.runtime?.sessions[session.id]?.factAt}
                                      data-chamber-state-source={sessionStateMarker(server, session).source}
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
