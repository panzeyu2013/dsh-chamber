/**
 * One workspace group's session-row list of the chamber sidebar ServerSection
 * subtree: ghost-gated rows, their HoverCards, inline rename swap and the
 * per-row action-error slots. Each row is a module-level `memo` component whose
 * props are per-row VALUES (the stable server/session references plus booleans,
 * the drop marker and the error strings), so re-rendering the group skips every
 * row whose inputs are unchanged. The hover card's relative timestamp is
 * sampled when the card OPENS (RowHoverCard's content function) instead of
 * being passed down as a render-time clock: a `now` prop changes every render
 * and would defeat the memo.
 */
import { Fragment, memo, useMemo, useRef } from 'react'
import clsx from 'clsx'
import {
  IconArchiveOutlineRegular, IconBranchOutlineRegular, IconEditOutlineRegular, IconEllipsisOutlineRegular, Menu,
  type MenuItem,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChamberServerAggregate, ChamberServerWorkspace } from '@dsh-chamber/dsh-chamber-client-core/aggregate-store'
import { relativeTimeBucket } from '@dsh-chamber/dsh-chamber-client-core/derive'
import { openErrorKey } from '@dsh-chamber/dsh-chamber-client-core/open-outcome'
import { clearPendingClick, noteSessionRowClick } from '@dsh-chamber/dsh-chamber-client-core/pending-click'
import { RowHoverCard } from './RowHoverCard.tsx'
import { ServerSectionRenameForm, SessionScheduleIndicator } from './server-section-controls.tsx'
import { dragOverState, rowHalf } from './server-section-model.ts'
import { useTitleMarquee } from './session-title-marquee.ts'
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
  isGhostSession: (session: ChamberServerWorkspace['sessions'][number]) => boolean
}

type SidebarSession = ChamberServerWorkspace['sessions'][number]

/**
 * ONE session row, memoized. Every prop is a value (or the stable server /
 * session reference) so a row whose inputs did not change is skipped without
 * re-running its 9-12 state readings, the menu construction and the drag
 * wiring. `now` is deliberately NOT a prop — see the file header.
 */
interface SessionRowProps {
  server: ChamberServerAggregate
  session: SidebarSession
  current: boolean
  ghost: boolean
  marker: 'before' | 'after' | null
  activeSessionDrag: boolean
  menuOpenRow: boolean
  renamingRow: boolean
  sessionDragError: string | undefined
  sessionActionError: string | undefined
  /** Owning account (workspace) facts the row writes into the drag envelope. */
  accountKey: string
  synthetic: boolean
  ungrouped: boolean
}

const SessionRow = memo(function SessionRow({
  server, session, current, ghost, marker, activeSessionDrag, menuOpenRow, renamingRow,
  sessionDragError, sessionActionError, accountKey, synthetic, ungrouped,
}: SessionRowProps) {
  const {
    t,
    setRenaming,
    sessionDrag,
    workspaceDrag,
    serverDrag,
    setSessionDrag,
    commitSessionDrag,
    suppressClickRef,
    sessionDropCommitted,
    armBlankGhostForClick,
    openSession,
    onForkSession,
    onArchiveSession,
    toggleMenu,
    closeMenu,
    useShortcuts,
  } = useSidebarSection()
  // 菜单键帽来自页面快捷键目录（上游 RenameSessionMenuItem / ForkSessionMenuItem /
  // ArchiveSessionMenuItem 同款选择）：命令未注册时行缺席，键帽与 aria 一并消失。
  const renameShortcut = useShortcuts(rows => rows.find(row => row.id === 'session.rename'))
  const forkShortcut = useShortcuts(rows => rows.find(row => row.id === 'session.fork'))
  const archiveShortcut = useShortcuts(rows => rows.find(row => row.id === 'session.archive'))
  const { sessionStateLabel, sessionStatePending, sessionStateMarker, sessionStateDot } = useServerSectionSessionState()
  /** 悬停卡片的本地化相对时间（"刚刚"/"5分钟前"），在卡片打开时采样。 */
  const hoverTimeLabel = (updatedAt: number, now: number): string => {
    const { unit, n } = relativeTimeBucket(updatedAt, now)
    return unit === 'now' ? t('time.now') : t('time.ago', { t: t(`time.${unit}`, { n }) })
  }
  // 行菜单条目（3 对象 + 3 元素 + 3 次 t()）每次渲染重建：按 t 记忆化——t 是
  // 文案的唯一依赖，locale 不变时同一数组跨渲染复用。
  const menuItems = useMemo((): MenuItem[] => [
    {
      id: 'rename',
      label: t('action.rename'),
      shortcut: renameShortcut,
      icon: <IconEditOutlineRegular size={14} />,
    },
    {
      id: 'fork',
      label: t('menu.fork'),
      shortcut: forkShortcut,
      icon: <IconBranchOutlineRegular size={14} />,
    },
    {
    // 归档动词只在这里的行菜单：安静会话直接归档（只隐藏行，
    // 不触碰会话日志）；宿主因仍有活跃工作而拒绝时才走两段式——
    // 行菜单武装确认层，确认后带 stopActivity 重发。字形尺寸是对
    // compact 槽位的刻意光学例外：compact 把图标槽缩到 14px，但 20
    // 原生的归档字形保持 16，才与旁边按 14 画的 16 原生字形同视觉
    // 重量（flex 槽容忍 +2px）。
      id: 'archive',
      label: t('menu.archiveSession'),
      shortcut: archiveShortcut,
      icon: <IconArchiveOutlineRegular size={16} />,
    },
  ], [t, renameShortcut, forkShortcut, archiveShortcut])
  const sessionKey = `${server.id}/session/${session.id}`
  // 会话行（上提以便 HoverCard 包裹）。单击立即打开、零延迟；
  // 模块级 pending（按 sessionId 记）只判定同一会话在
  // DOUBLE_CLICK_WINDOW_MS 内的第二次点击 → 内联重命名，其余点击记
  // pending 后立即打开。suppressClickRef（拖拽尾随 click）入口即生效，
  // 行外点击取消 pending（document 监听）；行渲染 data-session-id 供壳
  // 做包含判定；标题用官方 displayTitle（绝不渲染"未命名会话"）。
  const sessionTitleText = session.displayTitle
  // 标题跑马灯（上游 ui-workspace Rows.tsx 同款）：悬停时让被裁切的标题匀速爬行并
  // 打 data-scrolled / data-clipped 两个渐隐钩子；离开一步回到起点。
  const titleRef = useRef<HTMLSpanElement | null>(null)
  const marquee = useTitleMarquee(titleRef)
  const sessionRow = (
    <div
      className={clsx(
        cc.sessionRow,
        ghost && cc.sessionGhost,
        current && cc.sessionActive,
        menuOpenRow && cc.sessionMenuOpen,
        marker === 'before' && cc.dropBefore,
        marker === 'after' && cc.dropAfter,
      )}
      role="treeitem"
      aria-selected={current}
      data-session-id={session.id}
      data-chamber-row={sessionKey}
      // Vendor motion contract (AnimatedRows): the key is the row's identity in
      // DOM order, shared with the parent's rowKeys walk.
      data-row-key={`session:${session.id}`}
      data-chamber-ghost={ghost ? '' : undefined}
      // 合成的 cwd 派生分组仅用于显示：其中的会话行既不能拖也不能放
      // （wire 提交会在宿主上以 workspace/not-found 失败）。
      draggable={!ghost && !synthetic}
      onDragStart={ghost || synthetic
        ? undefined
        : (event) => {
          event.dataTransfer.effectAllowed = 'move'
          event.dataTransfer.setData('text/plain', session.id)
          suppressClickRef.current = true
          sessionDropCommitted.current = false
          setSessionDrag({
            sourceId: server.id,
            accountKey,
            ungrouped,
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
        if (menuOpenRow || renamingRow) return
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
      onPointerEnter={marquee.enter}
      onPointerLeave={marquee.leave}
    >
      <span ref={titleRef} className={cc.sessionTitle}>{session.blank === true ? t('session.new') : sessionTitleText}</span>
      {/* 活动 Schedule 标记位于标题与尾部单元之间；只对有该投影的行渲染，普通行几何/间距不变。 */}
      {session.hasActiveSchedule === true && (
        <SessionScheduleIndicator label={t('schedule.active')} />
      )}
      {/* 空白（新建）行是临时占位：kebab（含 fork/归档）作用于不存在的内容，整簇隐藏。 */}
      {session.blank !== true && (
      <span
        className={clsx(cc.rowActions, menuOpenRow && cc.rowActionsVisible)}
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
          open={menuOpenRow}
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
            // 标题随行传入：拒绝相位（两段式确认）要用它。
              onArchiveSession(server, session.id, session.displayTitle)
            }
          }}
          items={menuItems}
          anchor={(
            <button
              type="button"
              className={cc.actionIcon}
              // 行标题即无障碍名。
              aria-label={t('action.menu.session', { name: sessionTitleText })}
              aria-haspopup="menu"
              aria-expanded={menuOpenRow}
              onClick={(event) => {
                event.stopPropagation()
                if (suppressClickRef.current) return
                clearPendingClick()
                toggleMenu(sessionKey)
              }}
            >
              <IconEllipsisOutlineRegular size={16} />
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
    <Fragment>
      {renamingRow ? (
        <ServerSectionRenameForm placeholder={session.title} mode="sessionRow" />
      ) : (
        <RowHoverCard
          anchor={sessionRow}
          content={(now: number) => (
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
          openDelayMs={800}
          disabled={menuOpenRow || sessionDrag !== null || workspaceDrag !== null || serverDrag !== null}
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
})

export function ServerSectionSessionRows({ server, workspace, sessions, currentId, sessionMarker, activeSessionDrag, isGhostSession }: ServerSectionSessionRowsProps) {
  const { rowErrors, menuOpen, renaming, ghostExpiry } = useSidebarSection()
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
        return (
          <SessionRow
            key={session.id}
            server={server}
            session={session}
            current={session.id === currentId}
            ghost={ghost}
            marker={sessionMarker(session.id)}
            activeSessionDrag={activeSessionDrag}
            menuOpenRow={menuOpen[sessionKey] === true}
            renamingRow={renaming !== null && renaming.sourceId === server.id
              && renaming.kind === 'session' && renaming.id === session.id}
            sessionDragError={sessionDragError}
            sessionActionError={sessionActionError}
            accountKey={workspace.id}
            synthetic={workspace.synthetic === true}
            ungrouped={workspace.ungrouped === true}
          />
        )
      })}
    </>
  )
}
