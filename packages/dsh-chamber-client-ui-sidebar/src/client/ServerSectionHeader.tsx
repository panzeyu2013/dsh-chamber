/**
 * One source’s header row of the chamber sidebar ServerSection subtree: the
 * connection dot/spinner, fold toggle, view-options menu, add-workspace/search/archive
 * actions, the single per-source source-note live region and the folded
 * open-failure hoist. Shell state comes from useSidebarSection().
 */
import { useMemo, useState, type RefObject } from 'react'
import clsx from 'clsx'
import {
  IconArchiveCheckOutlineRegular, IconArchiveOffOutlineRegular, IconChevronRightOutlineRegular,
  IconChevronsUpDownOutlineRegular, IconClockOutlineRegular, IconFlatListOutlineRegular,
  IconFolderCloseRegular, IconLoadingOutlineRegular, IconProjectAddOutlineRegular, IconQueueOutlineRegular,
  IconSearchOutlineRegular, IconSlidersTwoOutlineRegular, IconTrashOutlineRegular,
  IconWorkspaceTreeOutlineRegular, Menu, Tooltip, type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { chamberBridge } from '@dsh-chamber/dsh-chamber-client-core/aggregate-store'
import type { ChamberServerAggregate } from '@dsh-chamber/dsh-chamber-client-core/aggregate-store'
import { MANAGED_RUNTIME_TRANSIENT_STATES } from '@dsh-chamber/dsh-chamber-client-core/managed-runtime'
import { clearPendingClick } from '@dsh-chamber/dsh-chamber-client-core/pending-click'
import type { PrewarmIntent } from '@dsh-chamber/dsh-chamber-client-core/prewarm-intent'
import { collapseSearch, expandSearch, type SourceSearchState } from '@dsh-chamber/dsh-chamber-client-core/search-state'
import { sourceBootGapNote } from './source-boot-gap.ts'
import { IconMonitorOutline16 } from './icons.tsx'
import { sourceAccentStyle, useSidebarSection } from './sidebar-context.ts'
import { sourceHeaderActivatable, sourceHeaderTitle, sourceStatusKind, sourceStatusLabelKey } from './server-section-model.ts'
import cc from './sidebar-chamber.module.css'

export interface ServerSectionHeaderProps {
  server: ChamberServerAggregate
  sourceFolded: boolean
  search: SourceSearchState | undefined
  query: string
  serverOpenFailures: readonly { sessionId: string; message: string }[]
  prewarmIntent: () => PrewarmIntent
  foldToggleRef: RefObject<HTMLButtonElement | null>
  searchButton: RefObject<HTMLButtonElement | null>
  searchInput: RefObject<HTMLInputElement | null>
  focusSearchOnMount: RefObject<boolean>
}

export function ServerSectionHeader({ server, sourceFolded, search, query, serverOpenFailures, prewarmIntent, foldToggleRef, searchButton, searchInput, focusSearchOnMount }: ServerSectionHeaderProps) {
  const {
    t,
    chamberInstanceId,
    viewPrefs,
    toggleSourceFold,
    setOrderBy,
    setGroupBy,
    setArchivedFilter,
    openWorkspaceBrowser,
    onOpenArchiveCleanup,
    suppressClickRef,
    dragPressOnButtonRef,
    serverDrag,
    setServerDrag,
    commitServerDrag,
    serverDropCommitted,
    sortMenuOpen,
    setSortMenuOpen,
    useShortcuts,
  } = useSidebarSection()
  /**
   * 来源头部的键盘焦点揭示态（design 08 §3.2）：静息时图标簇 `display:none`，只靠
   * hover 揭示的话 Tab 永远进不去（来源头部本身是 `role="button"` + `tabIndex={0}`
   * 的可聚焦元素）。与 workspace 行同理，键盘态落到 JS 驱动的 `.sourceActionsVisible`
   * 类上——同一个类、同一条揭示路径；只认 `:focus-visible`，指针点击不触发常驻揭示。
   */
  const [keyboardFocus, setKeyboardFocus] = useState(false)
  // 头部动作的键帽来自页面快捷键目录（上游 WorkspaceBrowser 同款选择）：
  // 搜索 session.search、添加工作区 workspace.add；命令未注册时行缺席。
  const searchShortcut = useShortcuts(rows => rows.find(row => row.id === 'session.search'))
  const addWorkspaceShortcut = useShortcuts(rows => rows.find(row => row.id === 'workspace.add'))
  // 可激活入口判定与 title/aria 文案（托管 dsh 停机时说明原因，而不是"切换到该实例"）。
  const headerActivatable = sourceHeaderActivatable(server, chamberInstanceId)
  const headerTitle = sourceHeaderTitle(server, chamberInstanceId, t)
  // 头部控件用官方 Tooltip（不是借来的原生 title=）；触发器打开三轴视图选项菜单，
  // 气泡与可访问名都报 viewOptions.label，活动排序只由 .sortActive 着色承载。
  // 视图选项三轴的当前值（上游 ViewOptionsMenu 的 selectedIds）：分组 / 排序 / 筛选。
  // 归档集未知（archiveSetKnown !== true）时存储值保留，但选中态按实际渲染态
  // （hide-archived）呈现且筛选轴三项整体禁用（design 06 §3.4 的诚实规则）。
  const groupByMode = viewPrefs.groupBy?.[server.id] ?? 'workspace'
  const orderByMode = viewPrefs.orderBy?.[server.id] ?? 'manual'
  const storedArchivedFilter = viewPrefs.archivedFilter?.[server.id] ?? 'default'
  const archiveFilterKnown = server.archiveSetKnown === true
  const archivedSelection = archiveFilterKnown
    ? { default: 'hide-archived', show: 'show-archived', only: 'only-archived' }[storedArchivedFilter]
    : 'hide-archived'
  const viewOptionsLabel = t('viewOptions.label')
  // 三轴菜单条目（17 项 + 图标元素 + selectedIds 映射）按词典与当前轴值记忆化——与行内
  // kebab 菜单同一条纪律（ServerSectionRows 的 menuItems）。
  const viewOptionsItems = useMemo((): MenuEntry[] => [
    { type: 'label' as const, id: 'group-by', text: t('groupBy.label') },
    { id: 'workspace', label: t('groupBy.workspace'), icon: <IconFolderCloseRegular /> },
    { id: 'workspace-tree', label: t('groupBy.workspaceTree'), icon: <IconWorkspaceTreeOutlineRegular /> },
    { id: 'flat', label: t('groupBy.flat'), icon: <IconFlatListOutlineRegular /> },
    { type: 'separator' as const, id: 'order-by-separator' },
    { type: 'label' as const, id: 'order-by', text: t('orderBy.label') },
    { id: 'manual', label: t('orderBy.manual'), icon: <IconChevronsUpDownOutlineRegular /> },
    { id: 'updated', label: t('orderBy.updated'), icon: <IconClockOutlineRegular /> },
    { type: 'separator' as const, id: 'archived-filter-separator' },
    { type: 'label' as const, id: 'filter-by', text: t('filterBy.label') },
    // 归档集未知（archiveSetKnown !== true）时筛选轴三项整体禁用：非默认项不可用，默认项
    // 也不得可点——点它会写回 'default'，把存储值抹掉（要求保留存储值，恢复已知后自动生效）。
    { id: 'hide-archived', label: t('viewOptions.hideArchived'), icon: <IconArchiveOffOutlineRegular />, disabled: !archiveFilterKnown },
    { id: 'show-archived', label: t('viewOptions.showArchived'), icon: <IconQueueOutlineRegular />, disabled: !archiveFilterKnown },
    { id: 'only-archived', label: t('viewOptions.onlyArchived'), icon: <IconArchiveCheckOutlineRegular />, disabled: !archiveFilterKnown },
  ], [t, archiveFilterKnown])
  // 来源级"数据不可信"说明：单一定居 live region（见 sourceNote 的渲染与 CSS :empty），
  // 按优先级取一句：托管不可用 > 前端能力受限（boot 缺口）> 托管瞬态 > 基线未就绪；
  // 前两条不互斥（可能既停机、壳里又留着上次挂载的缺口事实），顺序即优先级；缺口事实
  // 仅存在于挂载/预热过的来源。内容变化时既有 live region 才可被 AT 播报。
  // 托管瞬态必须**按 kind 限定**：本地 /health 词表同样含 starting/restarting，
  // 只判 phase 会给本地源挂上网关专属文案；瞬态集合共用 managed-runtime 的常量。
  const managedTransient = server.kind === 'gateway'
    && (MANAGED_RUNTIME_TRANSIENT_STATES as readonly string[]).includes(server.phase)
  const bootGapNote = sourceBootGapNote(server, t)
  // 缺口分支按构造出的布尔选择，绝不比较渲染字符串：文案是词典拷贝，
  // 两个分支共用句子时比较会静默误判。
  const noteIsBootGap = server.managedRuntimeDown !== true && bootGapNote !== ''
  const sourceNote = server.managedRuntimeDown === true
    ? t('source.managedDown', { state: t(sourceStatusLabelKey(server)) })
    : noteIsBootGap
      ? bootGapNote
      : managedTransient
        // 托管 dsh 正在启动：此刻 connected=false 会隐藏整棵会话子树，必须说明，
        // 否则重启网关时侧栏整组凭空消失。
        ? t('source.managedStarting', { state: t(sourceStatusLabelKey(server)) })
        : server.connected && server.aggregateReady === true && server.archiveSetKnown !== true
          ? t('source.baselinePending')
          // 会话事实档位说明（最低优先级）：字段缺席 = 尚未投影 = 未知，绝不臆造为 full。
          : server.sessionFacts === 'degraded'
            // 成因必须按 kind 分叉：网关来源的 facts 走只读镜像，本地/SSH 走实例自身协议。
            ? t(server.kind === 'gateway' ? 'source.factsDegraded' : 'source.factsDegradedLocal')
            : server.sessionFacts === 'legacy'
              ? t('source.factsLegacy')
              : server.sessionFacts === 'disabled'
                ? t('source.factsDisabled')
                : ''
  // 两个门必须分开：① live region 角色——任何说明行在场，状态点就让位（一个来源只应
  // 有一个 live region）；② 状态词承载——只有把 {state} 写进句子的说明行才接管
  // aria-label。目前只有 managedDown 与 managedStarting 携带 phase；baselinePending
  // 与降级说明不含 phase，点必须继续用 aria-label 承担。gateway 瞬态且降级时胜出的
  // 是缺口句，该分支不说话，点同样保留 aria-label。
  const noteCarriesPhase = server.managedRuntimeDown === true || (managedTransient && !noteIsBootGap)
  // 每个已挂载壳各有一份侧栏 DOM：id 必须按壳限定，否则 aria-describedby 可能解析到另一份同名节点。
  const sourceNoteId = `chamber-source-note-${chamberInstanceId ?? 'unknown'}-${server.id}`
  return (
    <>
                <header
                  className={clsx(
                    cc.sourceHeader,
                    server.id === chamberInstanceId && cc.sourceActive,
                    headerActivatable && cc.sourceHeaderClickable,
                  )}
                  data-chamber-row={server.id}
                  // 能力档位的机器可读锚点（用户可见文案见 sourceNote 分支）。
                  data-chamber-facts-mode={server.sessionFacts}
                  // 断连来源仍渲染的只读事实——来源级 stale 标记。
                  data-chamber-stale={server.runtime?.stale === true || undefined}
                  style={sourceAccentStyle(server)}
                  title={headerTitle}
                  role={headerActivatable ? 'button' : undefined}
                  tabIndex={headerActivatable ? 0 : undefined}
                  // 非交互形态（托管停机）不给 generic 角色加 aria-label，改用
                  // aria-describedby 指向说明行。
                  aria-label={headerActivatable ? headerTitle : undefined}
                  aria-describedby={!headerActivatable && sourceNote !== '' ? sourceNoteId : undefined}
                  // 来源头部是服务器分组"显示顺序"拖拽的拖柄；与工作区头部同一尾随
                  // click 抑制：拖拽结束落在头部（或其按钮）上不得误触发激活/切换/动作。
                  draggable
                  // 来源头部 hover 的意图预热触点：React 的 pointerenter/leave 不因指针
                  // 移入子按钮而 leave（与 RowHoverCard 同款），移出 header 才 leave。
                  onPointerEnter={() => { prewarmIntent().enter() }}
                  onPointerLeave={() => { prewarmIntent().leave() }}
                  // 键盘焦点揭示（design 08 §3.2）：Tab 聚焦头部自身或其图标簇按钮时把
                  // `.sourceActionsVisible` 置位，离开头部才收；后代按钮的 focusin/focusout
                  // 同样冒泡到这里。
                  onFocus={(event) => {
                    if (event.target instanceof Element && event.target.matches(':focus-visible')) {
                      setKeyboardFocus(true)
                    }
                  }}
                  onBlur={(event) => {
                    const next = event.relatedTarget
                    if (!(next instanceof Node) || !event.currentTarget.contains(next)) {
                      setKeyboardFocus(false)
                    }
                  }}
                  onPointerDown={(event) => {
                    // dragstart 的 target 是拖拽源（header 本身）而非按下的元素，
                    // 故必须在此记录按压是否起于 header 按钮。
                    dragPressOnButtonRef.current = event.target instanceof Element && event.target.closest('button') !== null
                  }}
                  onDragStart={(event) => {
                    // 拖来源头部是"整理"而非"前往"：消费本次 hover 周期，drag 期间不再补发预热意图。
                    prewarmIntent().press()
                    // 起于 header 按钮的手势中止拖拽发起：按钮是点击设施，折叠钮上
                    // >4px 的微拖不得吞掉它的 click（release 时正常触发）。
                    if (dragPressOnButtonRef.current) {
                      dragPressOnButtonRef.current = false
                      event.preventDefault()
                      return
                    }
                    dragPressOnButtonRef.current = false
                    event.dataTransfer.effectAllowed = 'move'
                    event.dataTransfer.setData('text/plain', server.id)
                    suppressClickRef.current = true
                    serverDropCommitted.current = false
                    setServerDrag({ sourceId: server.id, over: null })
                  }}
                  onDragEnd={(event) => {
                    // ESC 取消的拖拽不得落盘最后的标记：dropEffect 'none' 表示用户明确取消；
                    // dragend 时 dataTransfer 为 null 同样算取消（只用 `?.` 会让
                    // undefined !== 'none' 误提交）。真实 drop 已由节段的 onDrop 先行提交。
                    if (serverDrag !== null && serverDrag.over !== null
                      && event.dataTransfer !== null && event.dataTransfer.dropEffect !== 'none') {
                      commitServerDrag(serverDrag, serverDrag.over)
                    } else {
                      setServerDrag(null)
                    }
                    serverDropCommitted.current = false
                    window.setTimeout(() => { suppressClickRef.current = false }, 0)
                  }}
                  onClick={() => {
                    // 点击（明确点开）消费本次 hover 周期；切换仍走 requestActivateSource，意图不得代行。
                    prewarmIntent().press()
                    if (suppressClickRef.current) return
                    // 远程来源头部切换活动 N-ctx 视图，不打开会话（切换归 App 层）。
                    // 托管停机的 gateway 不可激活：boot 必然 503，头部不得承诺 App
                    // 自身已拒绝预热/收割的切换（就地说明解释原因）。
                    if (headerActivatable) chamberBridge.requestActivateSource(server.id)
                  }}
                  onKeyDown={(event) => {
                    if (!headerActivatable) return
                    // 只响应 header 自身的焦点：来自内部按钮的 keydown 若被处理，
                    // preventDefault 会同时取消按钮的原生 Enter/Space 激活并切换视图。
                    if (event.target !== event.currentTarget) return
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      // 键盘激活同样消费本次 hover 周期。
                      prewarmIntent().press()
                      chamberBridge.requestActivateSource(server.id)
                    }
                  }}
                >
                  {/* 来源级折叠钮：静息用 MONITOR 字形（server = machine；共用文件夹字形
                      会被读成工作区而误导），hover/focus 换成折叠 chevron（同槽位、不位移）。
                      点击折叠该来源的整个工作区列表，不触碰任何工作区自身的会话折叠态；
                      stopPropagation 挡住头部的激活点击（及 pending-click 纪律）。 */}
                  <button
                    ref={foldToggleRef}
                    type="button"
                    className={clsx(cc.sourceFoldToggle, sourceFolded && cc.sourceFoldToggleFolded)}
                    aria-label={sourceFolded ? t('server.expand') : t('server.collapse')}
                    aria-expanded={!sourceFolded}
                    // 自带 tooltip：否则会继承头部的"切换到该实例"，对折叠钮语义误导。
                    title={sourceFolded ? t('server.expand') : t('server.collapse')}
                    onClick={(event) => {
                      event.stopPropagation()
                      if (suppressClickRef.current) return
                      clearPendingClick()
                      toggleSourceFold(server.id)
                    }}
                  >
                    <IconChevronRightOutlineRegular size={15} className={cc.sourceFoldChevron} />
                    <IconMonitorOutline16 size={15} className={cc.sourceFoldGlyph} />
                  </button>
                  <span className={cc.sourceLabel}>{server.label}</span>
                  {/* 插件运行诊断只在连接页/每实例插件对话框呈现；侧栏不为插件图条件渲染标记。 */}
                  {/* 连接状态点/加载圈：phase 文本不渲染，只由 hover/aria 承载。 */}
                  <span
                    className={cc.sourceStatus}
                    title={t(sourceStatusLabelKey(server))}
                    // 同上的两个门：live region 让位，但只有携带 phase 的说明行
                    // 才接管状态词。
                    aria-label={noteCarriesPhase ? undefined : t(sourceStatusLabelKey(server))}
                    role={sourceNote === '' ? 'status' : undefined}
                  >
                    {sourceStatusKind(server) === 'busy' ? (
                      <IconLoadingOutlineRegular className={cc.statusSpinner} size={12} />
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
                  {/* 头部动作（视图选项菜单 + 加工作区 + 来源搜索 + 归档清理）与会话行动作
                      一样 hover 才显形：静息时右侧是连接状态，悬停换成图标簇（visibility
                      切换，无重排）。搜索胶囊或视图选项菜单打开时图标簇常驻
                      （.sourceActionsVisible），图标才能收起/关闭；键盘焦点（Tab）同样
                      常驻——否则簇里的按钮永远不在 Tab 序里（见键盘焦点揭示态注释）。 */}
                  <span
                    className={clsx(
                      cc.sourceActions,
                      (search?.expanded === true || sortMenuOpen === server.id || keyboardFocus)
                        && cc.sourceActionsVisible,
                    )}
                  >
                    {/* 每来源视图选项菜单（上游 ViewOptionsMenu 三段形态）：分组方式 / 排序方式 /
                        筛选会话，各带 label 与 selectedIds 勾选；静息态由 tooltip + aria-label
                        + sortActive 着色承载（hover 才显形）。密度保持本仓 compact 档
                        （design 06 §7）。筛选轴在归档集未知时三项禁用、选中按实际渲染态
                        （hide-archived）呈现，存储值保留（design 06 §3.4）。 */}
                    {server.connected && (server.aggregateError === undefined || search?.expanded === true) && (
                      <Menu
                        // Menu 密度用原语 `compact`（24px 行 / 11px 字；design 06 §7）：
                        // 官方默认 item 34px、dense 30px，都比侧栏 26px 列表行高。
                        compact
                        portal
                        align="end"
                        open={sortMenuOpen === server.id}
                        onClose={() => { setSortMenuOpen(null) }}
                        onSelect={(id: string) => {
                          setSortMenuOpen(null)
                          if (id === 'manual' || id === 'updated') setOrderBy(server, id)
                          else if (id === 'workspace' || id === 'workspace-tree' || id === 'flat') setGroupBy(server, id)
                          else if (id === 'hide-archived') setArchivedFilter(server, 'default')
                          else if (id === 'show-archived') setArchivedFilter(server, 'show')
                          else if (id === 'only-archived') setArchivedFilter(server, 'only')
                        }}
                        items={viewOptionsItems}
                        selectedIds={[groupByMode, orderByMode, archivedSelection]}
                        anchor={(
                          <Tooltip label={viewOptionsLabel} side="bottom" delayMs={500}>
                            <button
                              type="button"
                              className={clsx(cc.actionIcon, viewPrefs.orderBy?.[server.id] === 'updated' && cc.sortActive)}
                              aria-label={viewOptionsLabel}
                              aria-haspopup="menu"
                              aria-expanded={sortMenuOpen === server.id}
                              onClick={(event) => {
                                event.stopPropagation()
                                if (suppressClickRef.current) return
                                // stopPropagation 也停掉原生事件，document 级 pending-click
                                // 监听看不见本次点击，故必须在此 clearPendingClick——
                                // 否则残留 pending 会让之后同会话的点击误入重命名。
                                clearPendingClick()
                                setSortMenuOpen(prev => (prev === server.id ? null : server.id))
                              }}
                            >
                              <IconSlidersTwoOutlineRegular size={14} />
                            </button>
                          </Tooltip>
                        )}
                      />
                    )}
                    {server.connected && (server.aggregateError === undefined || search?.expanded === true) && (
                      <Tooltip
                        label={t('action.addWorkspace')}
                        shortcutKeys={addWorkspaceShortcut?.keys}
                        side="bottom"
                        delayMs={500}
                      >
                        <button
                          type="button"
                          className={clsx(cc.actionIcon, cc.addWorkspace)}
                          aria-label={t('action.addWorkspace')}
                          aria-keyshortcuts={addWorkspaceShortcut?.aria}
                          onClick={(event) => {
                            event.stopPropagation()
                            if (suppressClickRef.current) return
                            clearPendingClick()
                            openWorkspaceBrowser(server.id)
                          }}
                        >
                          {/* 加的是 WORKSPACE 不是会话：用官方 project-add 字形，
                              不用通用 `+`。 */}
                          <IconProjectAddOutlineRegular size={14} />
                        </button>
                      </Tooltip>
                    )}
                    {server.connected && (server.aggregateError === undefined || search?.expanded === true) && (
                      <Tooltip
                        label={t('search.sessions.aria')}
                        shortcutKeys={searchShortcut?.keys}
                        side="bottom"
                        delayMs={500}
                        disabled={search?.expanded === true}
                      >
                        <button
                          type="button"
                          className={cc.searchButton}
                          aria-label={t('search.sessions.aria')}
                          aria-keyshortcuts={searchShortcut?.aria}
                          aria-expanded={search?.expanded === true}
                          ref={searchButton}
                          onClick={(event) => {
                            event.stopPropagation()
                            if (suppressClickRef.current) return
                            clearPendingClick()
                            if (search?.expanded === true) {
                              // 开关：空查询折叠胶囊，非空查询只失焦
                              //（不得静默丢弃进行中的过滤）。
                              if (query === '') {
                                collapseSearch(server.id)
                              } else {
                                searchInput.current?.blur()
                              }
                            } else {
                              expandSearch(server.id)
                              focusSearchOnMount.current = true
                            }
                          }}
                        >
                          <IconSearchOutlineRegular size={14} />
                        </button>
                      </Tooltip>
                    )}
                    {/* 来源行"归档管理器"：与同类动作同一 hover 显形纪律与门控；打开管理
                        对话框（列表 + 单行/多选删除；整集删除只经显式全选，没有独立
                        delete-all）。清理状态全在对话框内。 */}
                    {server.connected && (server.aggregateError === undefined || search?.expanded === true) && (
                      <Tooltip label={t('action.purgeArchived')} side="bottom" delayMs={500}>
                        <button
                          type="button"
                          className={cc.actionIcon}
                          aria-label={t('action.purgeArchived')}
                          onClick={(event) => {
                            event.stopPropagation()
                            if (suppressClickRef.current) return
                            clearPendingClick()
                            onOpenArchiveCleanup(server)
                          }}
                        >
                          <IconTrashOutlineRegular size={14} />
                        </button>
                      </Tooltip>
                    )}
                  </span>
                </header>
                {/* 两种"数据不可信"状态就地说明——避免托管 dsh 停机时只剩"空面板 +
                    红点"，也避免把 unary 兜底的降级列表当真实列表读；状态词复用既有
                    `status.*` 文案。 */}
                {/* 活动来源（本壳就是它的侧栏）的缺口事实已由框架面 `.boot-gap` 横幅
                    以 role="status" 播报，同一件事不再播两遍：仅"自己这一行"的缺口说明
                    降为 aria-live="off"（文本仍可浏览/读屏，视觉警示不变）；
                    其它行的缺口仍要播报——那些来源没有横幅，侧栏是唯一用户面。 */}
                <div
                  id={sourceNoteId}
                  className={clsx(cc.sourceNote, noteIsBootGap && cc.sourceNoteBootGap)}
                  role="status"
                  aria-live={noteIsBootGap && server.id === chamberInstanceId ? 'off' : 'polite'}
                >
                  {sourceNote}
                </div>
                {/* 来源折叠时屏幕上没有会话行（折叠门藏掉整个列表），打开失败上提到
                    header 之下——header 是唯一保持渲染的部分。 */}
                {sourceFolded && serverOpenFailures.map(failure => (
                  <div key={failure.sessionId} className={cc.rowError} role="alert">{failure.message}</div>
                ))}
    </>
  )
}
