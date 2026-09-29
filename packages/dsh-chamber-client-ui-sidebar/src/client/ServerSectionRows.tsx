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
  IconArchiveOutlineRegular, IconBranchOutlineRegular, IconEditOutlineRegular, IconEllipsisOutlineRegular,
  IconPinFillRegular, IconPinOutlineRegular, Menu,
  Tooltip, type MenuItem,
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
    onPinSession,
    toggleMenu,
    closeMenu,
    useShortcuts,
    renderSessionSeat,
    chamberInstanceId,
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
  // 行菜单条目（4 对象 + 4 元素 + 4 次 t()）每次渲染重建：按 t 与 session.pinned 记忆化——
  // 两者是文案与字形的全部输入，locale / 置顶态不变时同一数组跨渲染复用。
  const menuItems = useMemo((): MenuItem[] => [
    {
      // 上游 PinSession 的菜单入口（order 100，先于 rename 的 200）：本仓按该文件逐字移植
      // 菜单项形态（无分隔线/快捷键）。图标照上游 markup 传 14；本仓菜单是 compact 档，
      // `.compactList .itemIcon svg` 会把它覆盖成 12px（design 06 §7 的 pin 实测值）。
      id: 'pin',
      label: t(session.pinned === true ? 'menu.unpinSession' : 'menu.pinSession'),
      icon: session.pinned === true ? <IconPinFillRegular size={14} /> : <IconPinOutlineRegular size={14} />,
    },
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
    // 归档动词的两个出口之一（行菜单项；同文件另有行内悬停钮）：安静会话直接归档（只隐藏行，
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
  ], [t, session.pinned, renameShortcut, forkShortcut, archiveShortcut])
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
      {/* 座席转移（补丁 13）：座席只在**本实例**（当前页面 ctx 的拥有者）的行上求值——
          occupant（官方 ui-schedule 的 schedule-mark / 卡片任务列表）读的是本实例 Host 的
          catalog，把外来源 sessionId 交给它只会查空并压掉回落；外来源行因此直接走自有标记
          （与 A1 前一致）。位置与上游 Rows.tsx 的 `.slot` 同址——**标题之前**（状态位与它互斥的
          上游语义里两者共用一个 slot；本仓的状态槽在行尾，故这里只放座席）。自有标记只在活动
          Schedule 投影存在时作为 occupant 缺席的回落，两者永不并现。
          上游同址守卫照搬（Rows.tsx: `!row.archived && !row.blank`）：本仓行数据不带 archived
          （归档会话在管理器面呈现、不进入行列表），故只落 blank 半边；空白（新建）占位行整席
          不求值，与上游「归档/空白行槽留空」同语义。 */}
      {session.blank !== true
        && (server.id === chamberInstanceId
          ? renderSessionSeat(
            'sidebar.session.row.leading',
            { sessionId: session.id },
            session.hasActiveSchedule === true
              ? { fallback: <SessionScheduleIndicator label={t('schedule.active')} /> }
              : undefined,
          )
          : session.hasActiveSchedule === true
            ? <SessionScheduleIndicator label={t('schedule.active')} />
            : null)}
      <span ref={titleRef} className={cc.sessionTitle}>{session.blank === true ? t('session.new') : sessionTitleText}</span>
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
            // 与三个行内按钮同一条本仓约定：菜单在 portal 里，"按住 kebab 拖动行、在菜单上松手"
            // 的尾随 click 会被当成一次菜单选择。pin 是首项，最容易被这一击命中；四个动作共用此门。
            if (suppressClickRef.current) return
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
            } else if (id === 'pin') {
              onPinSession(server, session.id, session.pinned === true)
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
        {/* 独立归档钮：上游 `session-actions/ArchiveSession.tsx` 的
            `ArchiveSessionRowButton`（注册进 `sidebar.workspaces.session.row.action`，
            order 100）——同一动作簇里 kebab 之后的第二个成员，tooltip 用上游
            `actions.archive`、无障碍名按本仓行级政策参数化行名 `action.archive.aria`（上游同座席用泛化名——有意分歧，
      design 06 §7；行菜单项仍是 `menu.archiveSession`）。
            本仓不渲染官方座席，故按该文件逐字移植按钮形态（类名换成本仓
            `.actionIcon`）。上游的 unarchive 半个分支在本仓不可达：归档行根本不进
            导航投影（`derive.ts` 的 sessionVisible），恢复由归档管理器承担，
            因此这里只保留归档方向，不引入死分支。 */}
        <Tooltip label={t('actions.archive')} side="bottom" align="end" delayMs={500}>
          <button
            type="button"
            className={cc.actionIcon}
            aria-label={t('action.archive.aria', { name: session.displayTitle })}
            onClick={() => {
              // 本仓约定（上游该钮的 markup 无此门）：拖拽尾随 click 入口即生效，
              // 动作类控件必须自查——否则拖拽子项结束的一击会直接发起归档。
              if (suppressClickRef.current) return
              onArchiveSession(server, session.id, session.displayTitle)
            }}
          >
            <IconArchiveOutlineRegular size={14} />
          </button>
        </Tooltip>
        {/* 独立置顶钮：上游 `session-actions/PinSession.tsx` 的 `PinSessionRowButton`（注册进
            `sidebar.workspaces.session.row.action`，order 200 = 归档之后的最右成员）——
            tooltip 用 `actions.pin/unpin`、无障碍名照上游用行菜单同款 `menu.pinSession/
            unpinSession`（本仓的行名参数化只用在归档钮上，见上），字形 14。本仓不渲染官方
            座席，故按该文件逐字移植按钮形态（类名换 `.actionIcon`）。置顶集未知
            （`pinSetKnown !== true`）时行不宣称任何置顶事实：无标记，钮按 pin 方向出——
            宿主 pin 幂等，重复 pin 无害，反向才有假断言。 */}
        <Tooltip label={t(session.pinned === true ? 'actions.unpin' : 'actions.pin')} side="bottom" align="end" delayMs={500}>
          <button
            type="button"
            className={cc.actionIcon}
            aria-label={t(session.pinned === true ? 'menu.unpinSession' : 'menu.pinSession')}
            onClick={() => {
              // 与归档钮同一条本仓约定：拖拽尾随 click 入口即生效。
              if (suppressClickRef.current) return
              onPinSession(server, session.id, session.pinned === true)
            }}
          >
            {session.pinned === true ? <IconPinFillRegular size={14} /> : <IconPinOutlineRegular size={14} />}
          </button>
        </Tooltip>
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
      {/* 静息置顶标记：上游 `PinnedIndicator`（`row.pinned && !row.archived`，非交互
          `role="img"` span，无障碍名与 title 都是 `row.pinned`，14px 实心针）。上游把它
          放在 time 单元之后、与悬停动作簇共用行右缘同一格并在 hover 时一起隐藏；本仓的行
          右缘单元是状态槽，标记落在状态槽之后，并按同一条 hover 规则与状态槽同隐——CSS 里
          `.sessionRow:hover .pinSlot` 与状态槽选择器成对出现。 */}
      {session.pinned === true && (
        <span className={cc.pinSlot} role="img" aria-label={t('row.pinned')} title={t('row.pinned')}>
          <IconPinFillRegular size={14} />
        </span>
      )}
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
              {/* 座席转移（补丁 13）：hover 座席（官方 ui-schedule 的任务行）落在卡片内；
                  同上只对本实例的行求值（外来源行没有本实例 occupant 的事实面）。 */}
              {server.id === chamberInstanceId && renderSessionSeat('sidebar.session.row.hover', { sessionId: session.id })}
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
          ?? rowErrors[`${server.id}/session/${session.id}/pin`]
          ?? rowErrors[`${server.id}/session/${session.id}/fork`]
          // 打开失败落在同一槽位（低优先级——同一行的
          // rename/archive/pin/fork 失败优先，且每行只显示这一条），key 与写入方共享。
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
