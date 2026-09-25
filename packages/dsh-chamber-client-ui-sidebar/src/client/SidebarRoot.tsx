/**
 * Chamber sidebar shell: column geometry owned by the shell; the region renders every
 * source's sessions in ONE grouped list (source header → workspace groups → session rows)
 * instead of the official `sidebar.workspaces` occupant. Remote sources carry a per-element
 * `--chamber-source-accent` (source-id hue hash); the local source omits it.
 * Invariants: row click = switch shell + open (`requestOpenSession`), source-header click
 * = activate without opening; the current-session highlight is channel-based (per-ctx
 * runtime producer merged by the App) and single-selection — only the source owning the
 * visible ctx renders it; fold state + ungrouped order live in ONE shared live store
 * (cross-ctx live sync); drag commits go through the wire with an optimistic override that
 * self-heals on the next pull; search is a debounced per-source unary content search (one
 * 30s-aborted job per query); the pinned 待办区 is a pure projection over the SAME merged facts. */
import type { ReactNode } from 'react'
import clsx from 'clsx'
import {
  BrandWordmark, FishLogo, IconNewChatOutlineRegular, IconPanelLeftOutlineRegular, Tooltip, isDarwinDesktop,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarRootComponentProps } from './contract/slots.ts'
import { chamberBridge } from '@dsh-chamber/dsh-chamber-client-core/aggregate-store'
import { getInstanceClient, searchSessions } from '@dsh-chamber/dsh-chamber-client-core/instance-api'
import { setSearchFetcher } from '@dsh-chamber/dsh-chamber-client-core/search-state'
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

// 在模块作用域把共享 search controller 的 wire fetch 接一次（controller 保持纯的、
// 可用 plain node 测试的状态机；instance-api 的 unary client 仅限浏览器/vite）。
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
  // 全局面板轴：每个注册渲染一行（默认空）；selector hook 把行重渲染限制在自身选中态。
  const panels = (usePanels as PanelsHook)(snapshot => snapshot)
  // 本包的 typecheck program 经 loose ambient seam 解析 slots 渲染共享（那里 renderSlot 是
  // 2 参签名），故在此收窄为上下文的 3 参；运行时签名是 (key, owner, opts)、按 key 分发，
  // 该 cast 只是类型层提升，绝不改变运行时。
  const renderWorkspaceGit = renderSlot as (
    key: 'sidebar.workspace.git',
    owner: { wide: boolean },
    opts: { hookContext: { sourceId: string; workspaceId: string; repoKey?: string } },
  ) => ReactNode

  // 跨切面状态由各主题 hook 持有；每个 hook 无条件按固定顺序调用，effect 顺序稳定。
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
    // 新点击立即清掉该行陈旧失败文案（若再次失败，dispatch 结果会重报）。
    clearOpenRowError(serverId, sessionId)
    chamberBridge.requestOpenSession(serverId, sessionId)
  }

  // chamber（会话待办区）：受守卫的打开——与行点击同一权威，另加行点击已有的两道守卫：
  // 拖拽尾部点击抑制（suppressClickRef）与同会话内联重命名排除（打开正在编辑的会话会丢编辑）。
  const requestTodoOpen = (sourceId: string, sessionId: string): void => {
    if (suppressClickRef.current) return
    if (renaming !== null && renaming.kind === 'session'
      && renaming.sourceId === sourceId && renaming.id === sessionId) return
    openSession(sourceId, sessionId)
  }

  // chamber：每次渲染一个 context value——各 per-source section 经 provider
  // （sidebar-context.ts）读取跨切面状态/动作，而不是穿三层组件传 ~40 个 prop；
  // store/effect/commit 全归 shell，ServerSection 只消费。
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

  // macOS 隐藏标题栏（红绿灯浮在侧栏顶，Swift 壳 titlebarAppearsTransparent；上游官方
  // 桌面 titleBarStyle:'hiddenInset' 同形）：该带与红绿灯同一行，展开/折叠两态都把面板
  // 开关停在这一行——上游同一块（ui-sidebar SidebarRoot.tsx 的 darwin 分支）；chamber
  // fork 此前整块缺失，字标因此直接贴在红绿灯下沿（web 无窗控件，同一布局看着正常）。
  // 判定读壳写的 <html data-platform>（Electron preload / Swift bridge-shim 的
  // markDocumentPlatform，documentStart 注入 + DOMContentLoaded 兜底）；侧栏经 client-plugin
  // 图加载后才挂载，此刻标记必已就位，故渲染期直读即可（上游同款读法）。
  const darwinDesktop = isDarwinDesktop()
  // rail 静息态是鲸鱼标；悬停换成面板图标（展开入口）。
  const toggle = (
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
        <IconPanelLeftOutlineRegular className={css.panelIcon} size={wide ? 16 : 18} />
      </button>
    </Tooltip>
  )

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
      {/* macOS 隐藏标题栏：带内只有面板开关（红绿灯由原生窗画在同一行的左端）。 */}
      {darwinDesktop && <div className={css.topStrip}>{toggle}</div>}

      <div className={css.logoRow}>
        {/* 展开时 wordmark 兼作 New Session 快捷方式（rail 的展开入口在 toggle 内）。 */}
        {wide && (
          <button
            type="button"
            className={clsx(css.brand, css.wide)}
            aria-label={t('session.new.label')}
            onClick={() => { startSession() }}
          >
            {/* 品牌洞：mark 回退保持 chamber wordmark，name 洞未注册则不渲染。 */}
            <span className={css.brandIdentity} aria-hidden="true">
              <span className={css.brandMark}>
                {renderSlot('sidebar.brand.mark', { size: 24 }, { fallback: <BrandWordmark /> })}
              </span>
              {/* 无 name 回退：mark 洞已带产品名，未占用的 name 洞渲染空而非重复。 */}
              <span className={css.brandName}>
                {renderSlot('sidebar.brand.name', {}, { fallback: null })}
              </span>
            </span>
          </button>
        )}
        {/* macOS 已把开关停在顶部带内；其余平台仍停在 logo 行右端。 */}
        {!darwinDesktop && toggle}
      </div>

      {/* Expanded, the button carries its own label — tooltip only on the rail. */}
      <Tooltip label={t('session.new.label')} delayMs={500} disabled={wide}>
        <button
          type="button"
          className={css.newSession}
          aria-label={t('session.new.label')}
          onClick={() => { startSession() }}
        >
          <IconNewChatOutlineRegular size={wide ? 14 : 18} />
          {wide && <span className={clsx(css.newSessionLabel, css.wide)}>{t('session.new')}</span>}
        </button>
      </Tooltip>

      {/* 全局面板轴：只有插件注册进 `sidebar.panellist` 时才有行（上游不带任何）。 */}
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

      {/* 浏览区在两态都填满控件与 foot 之间的列。chamber patch：多来源会话列表替代官方
          `sidebar.workspaces`；列表包在 region boundary 内——意外渲染错误不得拖垮壳或应用。 */}
      <div className={css.regionArea}>
        <ChamberListBoundary>
        {/* chamber（会话待办区）：滚动区之上的固定 attention 块，仅宽态、仅在有条目时渲染
            （纯投影派生）。在 region boundary 内：派生异常不得拖垮整个壳。 */}
        {wide ? (
          <>
          <SessionTodoArea
            servers={orderedServers}
            chamberInstanceId={chamberInstanceId ?? ''}
            requestOpen={requestTodoOpen}
            t={t}
          />
        {/* chamber（scroll sync）：滚动容器带 data-chamber-sidebar-scroll、每行带
            data-chamber-row，供 renderer 的 sidebar-scroll-sync 在 N-ctx 切换时锚定/恢复滚动位置。 */}
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
          /* rail 为每个来源渲染一个有名字、可操作的按钮：彩色来源点与当前来源 accent 环画在
             内层 span；点距 20px（按钮自身 `margin: -4px 0` 把 16px 按钮盒压到 8px 点元素）。
             可操作性镜像宽态来源头：远程可用来源请求切换 N-ctx 视图，当前来源标 aria-current，
             受管停止的来源不可激活（原因进 accessible name——来源头自己的拒绝）。 */
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
                      // 装饰性：按钮自己的 aria-label 承载来源身份与激活提示。
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


      {/* 三层 chamber 对话框（添加工作区浏览器 / 归档管理器 / 工作区删除确认）在
          sidebar-root-dialogs.tsx，单层规则与全部接线在那里。 */}
      <SidebarRootDialogs
        dialogs={dialogs}
        servers={servers}
        t={t}
        directoryBrowserT={directoryBrowserT}
      />

    </div>
  )
}
