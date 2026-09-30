/**
 * Chamber sidebar per-source section: ONE server's subtree of the multi-source
 * session list — source header (dot/spinner + hover status, server fold, sort
 * menu, git alert, add-workspace, search capsule with results), workspace
 * groups and session rows with in-source drag ordering and ghost rows.
 * Cross-cutting state/actions come through useSidebarSection(): the shell owns
 * every store/effect/commit below and provides ONE context value per render.
 * This file owns the per-section structure — the shared-search mirror, capsule
 * DOM refs, the outside-click collapse effect, the workspace/session
 * composition and the sort-menu anchor-cleanup; the header, search surface,
 * rows and pure helpers live in the sibling ServerSection* / server-section-*.
 */
import { Fragment, memo, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react'
import clsx from 'clsx'
import { SESSION_SEARCH_RESULT_LIMIT } from '@deepseek-ai/dsh-api-session-controller/client'
import {
  IconBranchOutlineRegular, IconChevronRightOutlineRegular, IconEditOutlineRegular, IconEllipsisOutlineRegular,
  IconFolderCloseRegular, IconFolderOpenOutlineRegular, IconNewChatOutlineRegular, IconTrashOutlineRegular, Menu, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { RowHoverCard } from './RowHoverCard.tsx'
import { chamberBridge, type ChamberServerAggregate, type ChamberServerWorkspace } from '@dsh-chamber/dsh-chamber-client-core/aggregate-store'
import {
  deriveLocalSearchMatches, mergeSearchResults, orderUngroupedSessions,
  sanitizeSearchQuery, workspaceAccentStyle,
} from '@dsh-chamber/dsh-chamber-client-core/derive'
import { type SearchRow } from '@dsh-chamber/dsh-chamber-client-core/instance-api'
import {
  collapseSearch, getSearchStates, subscribeSearch,
  type SourceSearchState,
} from '@dsh-chamber/dsh-chamber-client-core/search-state'
import { clearPendingClick } from '@dsh-chamber/dsh-chamber-client-core/pending-click'
import { FLAT_ACCOUNT_KEY, flatAccountKey } from '@dsh-chamber/dsh-chamber-client-core/flat-account'
import { partitionPinnedSessions } from '@dsh-chamber/dsh-chamber-client-core/pin-partition'
import { createPrewarmIntent, type PrewarmIntent } from '@dsh-chamber/dsh-chamber-client-core/prewarm-intent'
import { openErrorKey } from '@dsh-chamber/dsh-chamber-client-core/open-outcome'
import { getSourceRepoLayouts, getWorkspaceGitFlag, getWorkspaceGitFlagsVersion, hiddenByMainWorkspaceFold, isSourceGitFlagsLoaded, subscribeWorkspaceGitFlags } from '@dsh-chamber/dsh-chamber-client-core/workspace-git-flags'
import { resolveWorkspaceDrop } from '@dsh-chamber/dsh-chamber-client-core/workspace-drag-order'
import { workspaceTreeDepths, workspaceTreeParents } from '@dsh-chamber/dsh-chamber-client-core/workspace-tree'
import {
  sessionRowDisclosure, sessionRowWindow, sessionRowWindowMotionKey, SESSION_ROWS_VISIBLE_FIRST,
} from '@dsh-chamber/dsh-chamber-client-core/session-row-window'
import { orderWithOverride, useSidebarSection, workspaceDropEnv } from './sidebar-context.ts'
import { ServerSectionHeader } from './ServerSectionHeader.tsx'
import { ServerSectionSearchCapsule, ServerSectionSearchResults } from './ServerSectionSearch.tsx'
import { ServerSectionSessionRows } from './ServerSectionRows.tsx'
// Row motion is upstream's own animator, ported verbatim into ./rows (the vendor
// file is an `export class`, so registry C16's vendor-source pass-through — which
// only admits a relative import of an `export function` — cannot register it).
// The port's constants and body are locked against the pinned source by
// test/session-rows/animated-rows.test.ts.
import { AnimatedRows } from './rows/animated-rows.tsx'
import { useHoverMotionGate } from './use-hover-motion-gate.ts'
import { ServerSectionRenameForm } from './server-section-controls.tsx'
import { createdLabel, dragOverState, projectionHasSession, projectionToLocalSearchSnapshot, rowHalf } from './server-section-model.ts'
import cc from './sidebar-chamber.module.css'

export const ServerSection = memo(function ServerSection({ server }: { server: ChamberServerAggregate }) {
  const {
    wide,
    t,
    chamberInstanceId,
    useShortcuts,
    renderWorkspaceGit,
    viewPrefs,
    toggleWorkspaceFold,
    sessionOrderOverride,
    workspaceOrderOverride,
    sessionDrag,
    workspaceDrag,
    setWorkspaceDrag,
    serverDrag,
    setServerDrag,
    commitServerDrag,
    commitWorkspaceDrag,
    suppressClickRef,
    dragPressOnButtonRef,
    workspaceDropCommitted,
    rowErrors,
    menuOpen,
    toggleMenu,
    closeMenu,
    renaming,
    setRenaming,
    onNewSession,
    onDeleteWorkspace,
    setArchivedFilter,
    onUnarchiveSession,
    notices,
    dismissNotice,
  } = useSidebarSection()
  // 工作区行的 New Session 键帽/aria 来自页面快捷键目录（上游 ProjectRowItem 同款选择）。
  const newSessionShortcut = useShortcuts(rows => rows.find(row => row.id === 'session.new'))
  // 归档筛选三态（per-source 视图选项）：搜索腿、only 空态、提示条与行集都由它决定。
  // **降级出处门**：归档集未知（archiveSetKnown !== true）时按 default 渲染、存储值保留
  // （菜单侧同样把选中呈现为 default 并禁用整轴，两边同一条规则，design 06 §3.4）。
  const archivedFilter = server.archiveSetKnown === true
    ? (viewPrefs.archivedFilter?.[server.id] ?? 'default')
    : 'default'
  // 分组轴（per-source）：'workspace'（默认）| 'workspace-tree' | 'flat'。
  const groupByMode = viewPrefs.groupBy?.[server.id] ?? 'workspace'
  const flatGroupBy = groupByMode === 'flat'
  // git flags 是独立于 servers 投影的通道（flags 更新不产生新 server 身份）：**订阅**它，
  // 否则 ctxValue 稳定后树家族锚点 / main-fold 隐藏 / worktree 字形会冻结到下一次无关渲染。
  const gitFlagsVersion = useSyncExternalStore(
    subscribeWorkspaceGitFlags, getWorkspaceGitFlagsVersion, getWorkspaceGitFlagsVersion,
  )
  // 「按工作区树」：父级/深度一次算好（家族优先；无家族信息 = 上游纯前缀），与渲染解耦。
  // 依赖 = 工作区集合 / 轴 / git flags 版本（flags 变化必须重算家族锚点）；非树态零成本。
  const treeDepths = useMemo(
    () => groupByMode !== 'workspace-tree' ? undefined : workspaceTreeDepths(workspaceTreeParents(
      server.workspaces.map(workspace => ({
        id: workspace.id,
        ...(workspace.path === undefined ? {} : { path: workspace.path }),
        ...(workspace.synthetic === true ? { synthetic: true } : {}),
        ...(workspace.ungrouped === true ? { ungrouped: true } : {}),
      })),
      id => getWorkspaceGitFlag(server.id, id)?.mainWorkspaceId,
    )),
    [server.workspaces, server.id, groupByMode, gitFlagsVersion],
  )

  // Per-source search state (capsule/query/results) and its debounced fetch
  // jobs live in ONE shared controller, so a search survives view switches and
  // shells never duplicate fetches. This section only mirrors the state for
  // rendering and owns the capsule DOM refs (containment + focus).
  const [searchState, setSearchState] = useState<ReadonlyMap<string, SourceSearchState>>(() => getSearchStates())
  useEffect(() => subscribeSearch(() => { setSearchState(getSearchStates()) }), [])
  const searchRoot = useRef<HTMLDivElement | null>(null)
  const searchInput = useRef<HTMLInputElement | null>(null)
  /** 展开搜索时聚焦输入框；必须在胶囊挂载后（见下方 effect）。 */
  const focusSearchOnMount = useRef(false)
  // 搜索胶囊因断连卸载时的焦点落点（见下方 focus-restore）。
  const foldToggleRef = useRef<HTMLButtonElement | null>(null)
  const prevSearchCapsuleMounted = useRef(false)
  /** 上次渲染时焦点是否在胶囊内——卸载后 activeElement 会回落，必须提前记。 */
  const capsuleHeldFocus = useRef(false)
  const searchButton = useRef<HTMLButtonElement | null>(null)

  /**
   * 行位移门控的根（design 06 §7）：一次提交把某 keyed 行搬到静止指针下时，浏览器会为该行
   * 合成 pointerenter（实测 t≈347ms、0 个 pointermove），于是 :hover 揭示树 / 悬停卡 /
   * 标题跑马灯会在用户并未指向该行时触发——"删除会话时对应的 workspace 闪一下"。机器在每次
   * 提交后的 layout 阶段扫描本 section 的 keyed 行动画，只门控"被搬进指针下"的行
   * （位移前已在指针下的行保留揭示），真实 pointermove/pointerdown 即解除。
   * 机理、实测与残余见 hover-motion-gate.ts 头注。
   */
  const sectionRef = useRef<HTMLElement | null>(null)
  useHoverMotionGate(sectionRef)
  /**
   * 键盘焦点揭示态（design 08 §3.2）：键盘揭示**只能**落在 JS 驱动的
   * `.rowActionsVisible` 类上——与 kebab 展开同一个类、同一条揭示路径，簇里的按钮才
   * 真的可聚焦。CSS `:has(:focus-visible)` 那条路已被本仓删除：Blink 的 Tab 导航看不到
   * 由 `:has()` 失效触发的 display 变化（受控对照：同页里 `:focus-within` 驱动的簇 Tab
   * 能进、`:has(:focus-visible)` 驱动的簇被跳过，强制出帧也一样），规则在也只会"看得见、
   * 进不去"。只认 `:focus-visible`：指针点中折叠钮留下的是"聚焦但不可见"的焦点，不该
   * 常驻揭示（当年否掉 `:focus-within` 的理由）。
   */
  const [keyboardFocusKey, setKeyboardFocusKey] = useState<string | null>(null)

  /**
   * 本轮渲染实际出现的 workspace 行键。Chromium 在"持焦行被移除"时不发 blur（键盘触发
   * 的清理、来源消失……），悬留的键会在该 workspace 再现的瞬间把簇点亮；故每轮渲染后核对
   * 一次：键还在、行没了就归零（design 08 §3.2 的键盘揭示态）。
   */
  // 集合本体驻留 ref（不再每渲染新建 Set）；walk 每渲染重填，填前先清空。
  const liveWorkspaceKeys = useRef<Set<string>>(new Set())
  liveWorkspaceKeys.current.clear()
  useEffect(() => {
    if (keyboardFocusKey !== null && !liveWorkspaceKeys.current.has(keyboardFocusKey)) setKeyboardFocusKey(null)
  })

  /**
   * 行内重命名表单的 input 带 autoFocus（文本输入聚焦即匹配 `:focus-visible`，本行的
   * `onFocus` 因此会把键置为本行），而四条结束路径（提交 / Escape / 取消 / 保存）都在焦点
   * 仍在行内时卸载表单：Chromium 不发 blur、React 也不为被移除的 target 合成 onBlur，悬留
   * 的键会让该行的 hover 簇常驻、计数徽标同被换出。重命名一结束就清（design 08 §3.2）。
   */
  const inlineRenameActive = renaming !== null && renaming.sourceId === server.id
  const prevInlineRenameActive = useRef(false)
  useEffect(() => {
    if (prevInlineRenameActive.current && !inlineRenameActive) setKeyboardFocusKey(null)
    prevInlineRenameActive.current = inlineRenameActive
  })

  /**
   * 意图预热：**本来源头部** hover 的 120ms dwell 机器，一台机器一个来源，
   * 首次指针进入才创建（非 hover 路径零成本）。`onIntent` 只经 chamberBridge
   * 发一条单向请求——队列/预算/抑制纪律全在 App 消费端，这一侧只回答指针
   * 是否真的停留。
   */
  const prewarmIntentRef = useRef<PrewarmIntent | null>(null)
  const prewarmIntent = (): PrewarmIntent => {
    if (prewarmIntentRef.current === null) {
      prewarmIntentRef.current = createPrewarmIntent({
        onIntent: () => { chamberBridge.requestIntentPrewarm(server.id) },
      })
    }
    return prewarmIntentRef.current
  }
  // StrictMode（dev）会 setup→cleanup→setup：dispose 后必须把 ref 置空，否则
  // 第二次挂载会复用一台永久 inert 的机器，hover 意图静默失效。
  useEffect(() => () => {
    prewarmIntentRef.current?.dispose()
    prewarmIntentRef.current = null
  }, [])

  // 会话行渲染窗口的"已展开"标记：每工作区一个本地浏览态布尔（不持久化、不跨 ctx 同步）。
  const [sessionRowsExpanded, setSessionRowsExpanded] = useState<Record<string, boolean>>({})

  // Outside-click closes an expanded capsule only while its query is empty — a
  // non-empty query must not silently drop the filter. The header's search button
  // is containment-checked too, or clicking it would expand then collapse.
  useEffect(() => {
    if (!wide) return
    const onClick = (event: MouseEvent): void => {
      if (!(event.target instanceof Node)) return
      const state = searchState.get(server.id)
      if (state === undefined || state.expanded !== true) return
      const root = searchRoot.current
      if (root !== null && root.contains(event.target)) return
      const button = searchButton.current
      if (button !== null && button.contains(event.target)) return
      if (sanitizeSearchQuery(state.query) !== '') return
      collapseSearch(server.id)
    }
    document.addEventListener('click', onClick)
    return () => { document.removeEventListener('click', onClick) }
  }, [wide, server.id, searchState])

              // The query is sanitized by construction; the loading fallback covers expand-without-query.
              const search = searchState.get(server.id)
              const query = sanitizeSearchQuery(search?.query ?? '')
              // 胶囊卸载（托管 dsh 停机）会让焦点掉到 body（键盘用户迷路）：把焦点
              // 交还给折叠按钮——该头部唯一恒在的键盘入口。
              const searchCapsuleMounted = server.connected
                && viewPrefs.sourceFolded?.[server.id] !== true
                && search?.expanded === true
              // 展开后聚焦输入框：挂载前 ref 为空，必须等这一轮提交后再聚焦。flag 在提交后的
              // effect 里消费——渲染期消费会在被丢弃的并发渲染里把 flag 花掉（微任务还可能早于
              // 提交），胶囊展开却不聚焦。
              useEffect(() => {
                if (!searchCapsuleMounted || !focusSearchOnMount.current) return
                focusSearchOnMount.current = false
                searchInput.current?.focus()
              }, [searchCapsuleMounted])
              useEffect(() => {
                // 仅当焦点确实落在胶囊里才回交给折叠按钮：任何断连都不该把用户从
                // 别处抢回头部。判定必须在卸载之后（activeElement 已回落到 body），
                // 用卸载前记录的"胶囊是否持有焦点"。断连会在同一批清掉搜索状态，
                // 判定条件必须是"连接事实"而不是 expanded——折叠路径不会误抢。
                // wasMounted 必须在更新 prev 之前取：胶囊挂载的那次提交里自动聚焦会让
                // onFocusCapture 记下 held=true，旧写法在同一次提交里又把记录清掉，导致断连
                // 卸载时焦点掉到 body。只在"挂载 → 卸载"的转换上清记录。
                const wasMounted = prevSearchCapsuleMounted.current
                prevSearchCapsuleMounted.current = searchCapsuleMounted
                if (wasMounted && !searchCapsuleMounted
                  && capsuleHeldFocus.current && server.connected !== true) {
                  foldToggleRef.current?.focus()
                }
                if (wasMounted && !searchCapsuleMounted) capsuleHeldFocus.current = false
              }, [searchCapsuleMounted, server.connected])
              const currentRemote = search !== undefined && search.query === query
                ? search
                : { query, status: 'loading' as const, items: [] as SearchRow[], hasMore: false }
              // Render-side merge: the aggregate's LOCAL metadata matches
              // (title/workspace-label substring over the visible projection)
              // plus the remote content-search page. 远程腿按可见集过滤——投影已
              // 过滤 subagent 与 blank-non-current；归档行按 archivedFilter 进出投影，
              // 因此 show/only 下归档命中同样进入可见集（搜索跟随筛选，上游同规则）；
              // 空集（断连/未就绪）时 mergeSearchResults 降级为不过滤。
              // 空 query 短路在调用点：结果树只由 query !== '' 渲染，整投影快照
              // （projectionToLocalSearchSnapshot）与可见集都只在这条分支里构建。
              let merged: { items: SearchRow[]; hasMore: boolean } | undefined
              if (query !== '') {
                const visibleIds = new Set<string>()
                for (const workspace of server.workspaces) {
                  for (const session of workspace.sessions) visibleIds.add(session.id)
                }
                merged = mergeSearchResults(
                  deriveLocalSearchMatches(projectionToLocalSearchSnapshot(server), query, archivedFilter),
                  currentRemote,
                  SESSION_SEARCH_RESULT_LIMIT,
                  visibleIds,
                  server.aggregateReady === true,
                )
              }
              // Current-session highlight is channel-based (no store subscription)
              // and single-selection: only the source owning THIS visible ctx
              // renders it — one global selection marker.
              const currentId = server.id === chamberInstanceId ? server.runtime?.current : undefined
              // Server-level fold hides the ENTIRE workspace list; per-workspace
              // folds are untouched (see toggleSourceFold), so expand restores them.
              const sourceFolded = viewPrefs.sourceFolded?.[server.id] === true
              // This server's open-failure rows from the outcome channel. Both
              // key ends are anchored literals (`${server.id}/session/` … '/open'),
              // so the slice recovers any embedded session id verbatim; the
              // rename/archive/fork family shares the prefix but ends in its own
              // suffix, and no other key family ends in '/open'.
              const serverOpenFailures: { sessionId: string; message: string }[] = []
              // 空错误账本直接留下空数组：绝大多数渲染没有任何行失败，不扫描全表。
              if (Object.keys(rowErrors).length > 0) {
                const openErrorPrefix = `${server.id}/session/`
                for (const [key, message] of Object.entries(rowErrors)) {
                  if (!key.startsWith(openErrorPrefix) || !key.endsWith('/open')) continue
                  serverOpenFailures.push({
                    sessionId: key.slice(openErrorPrefix.length, key.length - '/open'.length),
                    message,
                  })
                }
              }
              // The ghost predicate is hoisted so the header count reuses the SAME
              // rule: a ghost is a blank "New Session" row that stopped being current
              // (invisible layout slot during BLANK_GHOST_GRACE_MS). The count must
              // not drift from what the rows render.
              const isGhostSession = (session: ChamberServerWorkspace['sessions'][number]): boolean =>
                session.blank === true && session.id !== currentId
              // Real workspaces render in wire order unless a transient drag override exists; the ungrouped bucket trails.
              const orderedWorkspaces = (() => {
                const real = server.workspaces.filter(workspace => workspace.ungrouped !== true)
                const ungrouped = server.workspaces.find(workspace => workspace.ungrouped === true)
                // 顺序规则与 drop 环境同源（sidebar-context 的 orderWithOverride）：
                // 覆盖表外的新建行按宿主 PREPEND 语义前置，渲染序与拖拽锚点才看同一个头。
                const ordered: ChamberServerWorkspace[] = orderWithOverride(
                  real, workspaceOrderOverride[server.id], workspace => workspace.id,
                )
                return ungrouped === undefined ? ordered : [...ordered, ungrouped]
              })()
              // Folding a git MAIN workspace folds the WHOLE repository group: derived
              // (worktree) rows — those whose git flag carries mainWorkspaceId — hide
              // while the main is folded and return on expand; worktrees of an
              // unregistered main stay visible. Once the main's registration vanishes
              // (external deletion) the stale fold pref must not lock derived rows
              // hidden with no expand control. Rows carry no destructive in-flight
              // state (git saga surfaces at source level, rowErrors restore on expand).
              // Computed ONCE here because BOTH consumers must agree on the row set:
              // the walk below renders it, and the motion resetKey describes it.
              const visibleOrderedWorkspaces = (() => {
                const liveWorkspaceIds = new Set(server.workspaces.map(row => row.id))
                return orderedWorkspaces.filter(workspace => {
                  if (workspace.ungrouped === true || workspace.synthetic === true) return true
                  const flag = getWorkspaceGitFlag(server.id, workspace.id)
                  const mainId = flag?.mainWorkspaceId
                  if (mainId === undefined) return true
                  const foldedMain = viewPrefs.folded[`${server.id}/${mainId}`] === true
                  const mainPresent = liveWorkspaceIds.has(mainId)
                  return !hiddenByMainWorkspaceFold(flag, foldedMain, mainPresent)
                })
              })()
              // The first insertion boundary of the list draws a top indicator while
              // the marker on the first real group is suppressed. The boundary is the
              // first VISIBLE row of the DISPLAY order (override- and fold-aware);
              // synthetic cwd-derived groups are never drop targets.
              // 拖拽环境只为**本来源正在拖工作区**时构建（Set + 序数组 + 两个闭包 + 线性
              // hidden() 扫描否则每渲染白付）；消费方都已在 workspaceDrag 门内。
              const workspaceDragLive = workspaceDrag !== null && workspaceDrag.sourceId === server.id
              const dropEnv = workspaceDragLive
                ? workspaceDropEnv(
                  server.id,
                  server.workspaces
                    .filter(workspace => workspace.ungrouped !== true && workspace.synthetic !== true)
                    .map(workspace => workspace.id),
                  workspaceOrderOverride[server.id],
                  viewPrefs.folded,
                )
                : undefined
              const firstDropRow = dropEnv?.order.find(id => !dropEnv.hidden(id))
              const workspaceDropAtListStart = firstDropRow !== undefined
                && workspaceDrag !== null
                && workspaceDrag.sourceId === server.id
                && workspaceDrag.over !== null
                && workspaceDrag.over.id === firstDropRow
                && workspaceDrag.over.half === 'before'
              // shared/workspace-drag-order.ts is the single authority every surface
              // asks (marker, onDragOver gate, top indicator, commit): blocked
              // positions — a drop splitting a contiguous repo family — never render
              // a marker and never become the target.
              const workspaceDropBlocked = (targetId: string, half: 'before' | 'after'): boolean => {
                if (dropEnv === undefined || workspaceDrag === null || workspaceDrag.sourceId !== server.id) return false
                const verdict = resolveWorkspaceDrop(dropEnv, workspaceDrag.workspaceId, { id: targetId, half })
                return verdict.kind === 'blocked'
              }
              const workspaceDragMarker = (workspace: ChamberServerWorkspace): 'before' | 'after' | null => {
                if (workspace.ungrouped === true || workspace.synthetic === true || workspaceDrag === null
                  || workspaceDrag.sourceId !== server.id || workspaceDrag.over === null) return null
                if (workspaceDrag.over.id !== workspace.id) return null
                if (workspaceDropAtListStart && workspace.id === firstDropRow) return null
                if (workspaceDropBlocked(workspace.id, workspaceDrag.over.half)) return null
                return workspaceDrag.over.half
              }
              // Ordering is a view key too: the motion resetKey below settles an
              // order swap instead of gliding every row (hoisted out of sessionsOf
              // for that reason).
              const orderBy = viewPrefs.orderBy?.[server.id] ?? 'manual'
              // 置顶分区（Phase 4，纯渲染；选项1：不写账号）：集合未知（pinSetKnown !== true）
              // 时 pinnedOrder/pinnedIds 都为 undefined ⇒ 无置顶块（blank 占位行仍按上游无条件
              // 提前）、行也不宣称标记。
              const pinnedOrder = server.pinSetKnown === true ? server.pinnedSessionIds : undefined
              const pinnedIds = pinnedOrder === undefined ? undefined : new Set(pinnedOrder)
              // 置顶分区选项（上游 sectionMembers 的位置）：manual 的块内序取宿主「最近置顶在前」，
              // updated 保留该模式自己的 account 序；sessionsOf 与 flat 两个消费点共用这一份。
              const pinOptions = {
                ...(pinnedIds === undefined ? {} : { pinnedIds }),
                ...(pinnedOrder === undefined || orderBy === 'updated' ? {} : { pinOrder: pinnedOrder }),
              }
              const sessionsInOrder = (workspace: ChamberServerWorkspace): ChamberServerWorkspace['sessions'] => {
                const wire = workspace.sessions
                // updated = 手动序 + 活动置顶：渲染序取共享的 updated-order account
                // （推导 effect 已写回 seeding/recency sort/promotion），account 不存在
                // 时（切换后首帧、effect 尚未落盘）回退 wire 序。**重入 updated** 时
                // 首帧保留旧 account 序，下一帧才整列重排（render-then-sort，菜单关闭
                // 动画内不可感知）。manual 模式：未分组桶用存储序，工作区 override 优先。
                if (orderBy === 'updated') {
                  const stored = viewPrefs.updatedOrder?.[`${server.id}/${workspace.id}`]
                  return stored === undefined ? wire : orderUngroupedSessions(wire, stored)
                }
                if (workspace.ungrouped === true) {
                  return orderUngroupedSessions(wire, viewPrefs.ungroupedOrder[server.id])
                }
                const override = sessionOrderOverride[`${server.id}/${workspace.id}`]
                return override === undefined ? wire : orderUngroupedSessions(wire, override)
              }
              // 置顶分区叠加在模式自身的序之上（上游 sectionMembers 的位置）：manual 的块内
              // 序取宿主「最近置顶在前」，updated 保留该模式自己的 account 序。
              // 每渲染每工作区只算一次：resetKey 与 walk 共用同一结果（pin-partition 锁锚在
              // 下面这行 partition 调用上）。缓存存活在本渲染的闭包里，随下一渲染整体丢弃。
              const sessionsCache = new Map<string, ChamberServerWorkspace['sessions']>()
              const sessionsOf = (workspace: ChamberServerWorkspace): ChamberServerWorkspace['sessions'] => {
                const cached = sessionsCache.get(workspace.id)
                if (cached !== undefined) return cached
                const next = partitionPinnedSessions(sessionsInOrder(workspace), pinOptions)
                sessionsCache.set(workspace.id, next)
                return next
              }
              // 单列表（flat）：整源一个平铺账号（上游 FLAT_SESSION_ORDER_KEY 的 per-source
              // 对应物）。顺序 = 存过的账号序（manual: flatOrder；updated: flatAccountKey(server.id) 哨兵账号）
              // 按成员集对账；没存过就用合成序（各组显示序 → 组内会话序）。
              const flatUpdatedAccountKey = flatAccountKey(server.id)
              // flat 成员与 workspace 折叠无关（上游 sessionMemberIds(list)）：用未做
              // main-fold 过滤的 orderedWorkspaces；flat 下没有表头可展开被折叠的 main。
              const flatMemberSessions = flatGroupBy
                ? orderedWorkspaces.flatMap(workspace => workspace.sessions)
                : []
              const flatSessions = (() => {
                if (!flatGroupBy) return []
                const stored = orderBy === 'updated'
                  ? viewPrefs.updatedOrder?.[flatUpdatedAccountKey]
                  : viewPrefs.flatOrder?.[server.id]
                const ordered = stored === undefined ? flatMemberSessions : orderUngroupedSessions(flatMemberSessions, stored)
                // flat 列表同样叠加置顶分区（上游 flat 账号 + sectionMembers 同规则）。
                return partitionPinnedSessions(ordered, pinOptions)
              })()
              // 空态种子键与空态门同一条表达式（flat 下工作区可能都在、可见行却为零）。
              const rowKeys: string[] = (flatGroupBy ? flatSessions.length === 0 : server.workspaces.length === 0)
                ? ['empty']
                : []
              const flatWorkspace: ChamberServerWorkspace = { id: FLAT_ACCOUNT_KEY, title: '', sessions: flatSessions }
              return (
              <section
                ref={sectionRef}
                key={server.id}
                className={clsx(
                  cc.sourceGroup,
                  // Server-group drag marker on the SECTION boundary (before = above
                  // the header, after = below the whole group).
                  serverDrag !== null && serverDrag.over?.id === server.id && serverDrag.over.half === 'before' && cc.dropBefore,
                  serverDrag !== null && serverDrag.over?.id === server.id && serverDrag.over.half === 'after' && cc.dropAfter,
                )}
                role="group"
                aria-label={server.label}
                // Marks a source SECTION for the server-drag outside-list
                // cancel; any descendant counts as "inside the list".
                data-chamber-section={server.id}
                // The fold state's a11y surface is the fold BUTTON's own
                // aria-expanded — the group carries no expand semantics.
                onDragOver={serverDrag === null
                  ? undefined
                  : (event) => {
                    event.preventDefault()
                    event.dataTransfer.dropEffect = 'move'
                    const half = rowHalf(event)
                    setServerDrag(current => dragOverState(current, server.id, half))
                  }}
                onDrop={serverDrag === null
                  ? undefined
                  : (event) => {
                    event.preventDefault()
                    if (serverDrag === null) return
                    commitServerDrag(serverDrag, { id: server.id, half: rowHalf(event) })
                  }}
              >
                <ServerSectionHeader
                  server={server}
                  sourceFolded={sourceFolded}
                  search={search}
                  query={query}
                  serverOpenFailures={serverOpenFailures}
                  prewarmIntent={prewarmIntent}
                  foldToggleRef={foldToggleRef}
                  searchButton={searchButton}
                  searchInput={searchInput}
                  focusSearchOnMount={focusSearchOnMount}
                />
                {/* The source-level fold hides only the BROWSING region below
                    (capsule, source-scope git alert, workspace list); the panel
                    axis lives in the header itself (design 06 §4.7), and the
                    search state is untouched, so expanding remounts the capsule
                    with its query intact. */}
                {!sourceFolded && (
                <>
                {/* The search capsule row beneath the header; Escape clears and
                    collapses, the clear button does the same. */}
                {/* 断连/托管停机的源不渲染搜索胶囊：留一个活输入框是键盘死路，
                    结果与状态分支本就被 connected 门挡住。 */}
                {server.connected && search?.expanded === true && (
                  <ServerSectionSearchCapsule
                    server={server}
                    search={search}
                    searchRoot={searchRoot}
                    searchInput={searchInput}
                    capsuleHeldFocus={capsuleHeldFocus}
                  />
                )}
                {server.connected ? (() => {
                  // Per-repo layouts drive the unregistered-worktree blocks and the orphan badge.
                  const repoLayouts = getSourceRepoLayouts(server.id)
                  const notice = notices[server.id]
                  return (
                  <>
                  {/* Source-level Git alert mount (workspaceId '' = source
                      scope), OUTSIDE the list tree (a tree must not carry
                      non-treeitem direct children): the Git plugin renders the
                      source's recovery/action errors here — visible even when
                      no workspace has git rows, so the source can never
                      silently lock or lie. */}
                  {renderWorkspaceGit('sidebar.workspace.git', { wide }, {
                    hookContext: { sourceId: server.id, workspaceId: '' },
                  })}
                  {/* Open failures whose session has NO row in the current
                      projection (e.g. a child that never surfaced while the
                      runtime was wedged) surface above the list, outside the
                      tree. Known bound: a failure whose session IS in the
                      projection but whose only render anchor vanished stays
                      invisible for the 10s window (the inline slot is
                      suppressed identically). */}
                  {serverOpenFailures.filter(failure => !projectionHasSession(server, failure.sessionId)).map(failure => (
                    <div key={failure.sessionId} className={cc.rowError} role="alert">{failure.message}</div>
                  ))}
                  {/* 来源级归档提示条（上游 RowActionToast 的 section 内实例化，D5）：
                      归档成功 / 停止并归档 → 撤销 + 筛选（筛选已生效时隐藏）；点击归档行
                      不可打开 → 纯提示。自动过期，per-shell 瞬态。 */}
                  {notice !== undefined && (
                    <div className={cc.archiveNotice} role="alert">
                      <span className={cc.archiveNoticeText}>
                        {notice.kind === 'archivedNotOpenable'
                          ? t('toast.archivedNotOpenable')
                          : t(notice.kind === 'stoppedAndArchived' ? 'toast.stoppedAndArchived' : 'toast.archived')}
                      </span>
                      {notice.kind !== 'archivedNotOpenable' && (
                        <>
                          <button
                            type="button"
                            className={cc.archiveNoticeAction}
                            onClick={() => {
                              dismissNotice(server.id)
                              onUnarchiveSession(server, notice.sessionId)
                            }}
                          >
                            {t('toast.archivedUndo')}
                          </button>
                          {/* 降级出处门：归档集未知时该来源筛选轴整轴禁用（保护存储值），
                              提示条的「筛选」捷径同样不得写 show——否则会静默覆盖存储的 only。 */}
                          {archivedFilter === 'default' && server.archiveSetKnown === true && (
                            <>
                              <span className={cc.archiveNoticeText}>{t('toast.archivedOr')}</span>
                              <button
                                type="button"
                                className={cc.archiveNoticeAction}
                                onClick={() => {
                                  dismissNotice(server.id)
                                  setArchivedFilter(server, 'show')
                                }}
                              >
                                {t('toast.archivedFilter')}
                              </button>
                            </>
                          )}
                        </>
                      )}
                    </div>
                  )}
                  {merged !== undefined ? (
                    // An active query (query !== '', the only branch that builds
                    // 'merged') replaces the whole workspace list (header/status
                    // stay; fold and add-workspace hidden). Results outrank the
                    // snapshot-fetch error: a content-search failure still shows the
                    // local metadata hits, with the error banner below them. The
                    // search list names its own tree, so no motion wrapper here.
                    <div className={cc.workspaceList}>
                      <ServerSectionSearchResults
                        server={server}
                        merged={merged}
                        currentRemote={currentRemote}
                        currentId={currentId}
                      />
                    </div>
                  ) : server.aggregateError !== undefined ? (
                    <div className={cc.workspaceList}>
                      <div className={cc.aggregateError} role="alert">{server.aggregateError}</div>
                    </div>
                  ) : (
                    <AnimatedRows
                      className={cc.workspaceList}
                      // The browse tree keeps the tree/treeitem semantics the search
                      // branch replaces with its own named tree.
                      label={t('section.sessions')}
                      rowKeys={rowKeys}
                      // Motion only while the list is the interaction target: a drag
                      // in flight moves rows by hand, not by data (upstream gates on
                      // its native-drag flag the same way).
                      ready={server.aggregateReady === true && workspaceDrag === null && sessionDrag === null}
                      // View keys only: the order, the per-group session disclosure,
                      // and the auto window of groups it actually CLAMPS
                      // (sessionRowWindowMotionKey — a >visibleFirst group whose
                      // window grows around the current session is a view
                      // replacement and must settle instead of gliding; an
                      // unclamped group contributes nothing, so data churn never
                      // resigns the list). Neither the current id nor a per-group
                      // row count may enter: a new session row becomes visible
                      // exactly when it becomes current, and keying that commit
                      // cancels the "+" entrance animation (design 06 §7).
                      resetKey={JSON.stringify([orderBy, groupByMode, archivedFilter, sessionRowsExpanded, sessionRowWindowMotionKey(
                        // 与 walk 同源：键描述的行集就是渲染行集。flat 用**平铺账号**一个分量
                        // （分组列表在 flat 下根本不渲染），其余模式用 visibleOrderedWorkspaces。
                        // 折叠的组再滤一层：per-workspace 折叠只渲染组头、不渲染任何会话行，它的窗口
                        // 分量对视图毫无影响，却会因当前行移走而翻键、取消别处的入场动画。
                        // 代价 = 每工作区每渲染一次 sessionsOf（updated 模式含一次排列），且本渲染内与
                        // walk 共用 sessionsCache；只在本浏览分支求值。
                        flatGroupBy
                          ? [{
                            workspaceId: FLAT_ACCOUNT_KEY,
                            total: flatSessions.length,
                            currentIndex: currentId === undefined
                              ? -1
                              : flatSessions.findIndex(session => session.id === currentId),
                            expanded: sessionRowsExpanded[flatAccountKey(server.id)] === true,
                          }]
                          : visibleOrderedWorkspaces
                          .filter(workspace => viewPrefs.folded[`${server.id}/${workspace.id}`] !== true)
                          .map(workspace => {
                          const sessions = sessionsOf(workspace)
                          return {
                            workspaceId: workspace.id,
                            total: sessions.length,
                            currentIndex: currentId === undefined
                              ? -1
                              : sessions.findIndex(session => session.id === currentId),
                            expanded: sessionRowsExpanded[`${server.id}/${workspace.id}`] === true,
                          }
                        }),
                      )])}
                    >
                      <>
                        {workspaceDropAtListStart && firstDropRow !== undefined
                          && !workspaceDropBlocked(firstDropRow, 'before') && (
                          <span className={cc.listTopDropIndicator} aria-hidden="true" />
                        )}
                        {(() => {
                          // flat：整个来源是一条平铺列表（伪账号替换分组列表，标题/表头不渲染）。
                          return (flatGroupBy ? [flatWorkspace] : visibleOrderedWorkspaces).map(workspace => {
                          const workspaceKey = `${server.id}/${workspace.id}`
                          // 树模式下的缩进层级（0 = 顶级；家族优先的结果已折进 parents）。
                          const treeDepth = treeDepths?.get(workspace.id) ?? 0
                          // flat 伪账号：不渲染工作区表头，也不接工作区拖拽（会话行拖拽照常）。
                          const flatAccount = flatGroupBy && workspace.id === FLAT_ACCOUNT_KEY
                          // 视图状态键：flat 伪账号不得与真实 __flat__ 工作区共享 key（同 flatAccountKey
                          // 的理由）——folded / 窗口展开都走哨兵键；DOM/motion 键仍用 workspaceKey
                          // （与 data-row-key/rowKeys 同一套）。
                          const accountStateKey = flatAccount ? flatAccountKey(server.id) : workspaceKey
                          liveWorkspaceKeys.current.add(workspaceKey)
                          const folded = viewPrefs.folded[accountStateKey] === true
                          // While THIS workspace's inline rename is active the header row
                          // hosts the edit form in place (no added list row); the flag
                          // gates form embedding, drag-off, double-click re-entry,
                          // HoverCard off while typing and .workspaceRenaming.
                          const renamingThisWorkspace = renaming !== null
                            && renaming.sourceId === server.id
                            && renaming.kind === 'workspace' && renaming.id === workspace.id
                          // Derived (worktree) workspaces drop the kebab and rename (only
                          // delete + new-session remain) and seed the icon accent.
                          const gitFlag = getWorkspaceGitFlag(server.id, workspace.id)
                          // The accent waits for the source's git identity to be RESOLVED
                          // (first snapshot): until then a git workspace would flash an
                          // independent hue before flipping to its family hue, so default
                          // ink renders; every workspace settles at the resolve moment.
                          const workspaceAccent = isSourceGitFlagsLoaded(server.id)
                            ? workspaceAccentStyle(server.id, workspace.id, gitFlag)
                            : undefined
                          const isWorktree = gitFlag?.isWorktree === true
                          // flat 直接用已对账+已分区的 flatSessions，不再走 sessionsOf（否则同一
                          // 账号在本渲染里被 reconcile+partition 第二遍，见性能修订）。
                          const sessions = flatAccount ? flatSessions : sessionsOf(workspace)
                          // sessionsOf may include a departed blank GHOST row, so the count
                          // would be +1 for up to BLANK_GHOST_GRACE_MS; count only
                          // non-ghost sessions (the same predicate the rows use).
                          const visibleSessionCount = sessions.reduce(
                            (count, session) => count + (isGhostSession(session) ? 0 : 1),
                            0,
                          )
                          // 会话行渲染窗口——行 DOM 不随会话数无界膨胀。组头
                          // 徽标与一切数据面操作仍用全量 sessions；这里只决定
                          // 渲染行数与展开条文案。当前会话行不被藏匿（窗口自动
                          // 覆盖之）。
                          const rowsExpanded = sessionRowsExpanded[accountStateKey] === true
                          const currentSessionIndex = currentId === undefined
                            ? -1
                            : sessions.findIndex(row => row.id === currentId)
                          const sessionWindow = sessionRowWindow({
                            total: sessions.length,
                            currentIndex: currentSessionIndex,
                            expanded: rowsExpanded,
                            visibleFirst: SESSION_ROWS_VISIBLE_FIRST,
                          })
                          const visibleSessions = sessionWindow.hiddenCount === 0
                            ? sessions
                            : sessions.slice(0, sessionWindow.renderCount)
                          // 展开条文案按「可见（非 ghost）会话」计：直接复用窗口 hiddenCount
                          // 会在幽灵期内与组头徽标（visibleSessionCount 已去 ghost）漂移
                          // ±幽灵数；窗口切片仍保留 ghost 行（占位防回流），仅对外文案
                          // 减去窗口内 ghost 数。disclosure 自己的窗口忽略展开标记，所以
                          // 展开时仍知道折叠后的数量，同一控件可显示 `sessions.collapse`。
                          const disclosureWindow = sessionRowDisclosure({
                            total: sessions.length,
                            currentIndex: currentSessionIndex,
                            visibleFirst: SESSION_ROWS_VISIBLE_FIRST,
                          })
                          const hiddenVisibleCount = disclosureWindow.hiddenCount === 0
                            ? 0
                            : Math.max(0, visibleSessionCount - sessions
                              .slice(0, disclosureWindow.renderCount)
                              .reduce((count, session) => count + (isGhostSession(session) ? 0 : 1), 0))
                          const marker = workspaceDragMarker(workspace)
                          const activeSessionDrag = sessionDrag !== null
                            && sessionDrag.sourceId === server.id
                            && sessionDrag.accountKey === workspace.id
                          const sessionMarker = (sessionId: string): 'before' | 'after' | null =>
                            activeSessionDrag && sessionDrag.over !== null && sessionDrag.over.id === sessionId
                              ? sessionDrag.over.half
                              : null
                          // Action-keyed errors (new/rename/delete share the workspace key family).
                          const workspaceError = rowErrors[`${server.id}/workspace/${workspace.id}/new`]
                            ?? rowErrors[`${server.id}/workspace/${workspace.id}/rename`]
                            ?? rowErrors[`${server.id}/workspace/${workspace.id}/delete`]
                          const workspaceDragError = rowErrors[`${server.id}/workspace-drag/${workspace.id}`]
                          // Session open failures whose row the fold/window gate hides
                          // are hoisted below the header (a failure survives a
                          // mid-flight fold); visible rows render the error inline.
                          const hoistedOpenErrors = sessions.filter(session =>
                            rowErrors[openErrorKey(server.id, session.id)] !== undefined
                            && (folded || !visibleSessions.some(visible => visible.id === session.id)))
                          // Motion contract (vendor AnimatedRows): keys are pushed in
                          // the SAME order the rows render (the zero-workspace seed 'empty'
                          // is the one exception: it only feeds membership/array equality). Ghost rows are keyed even
                          // when the row component drops an expired one — a stale key
                          // never clones a live row, a missing key would.
                          // flat 伪账号不渲染 workspace 表头，也就不该占一个 rowKeys 位
                          // （AnimatedRows 的 rowKeys↔data-row-key 契约）。
                          if (!flatAccount) rowKeys.push(`workspace:${workspace.id}`)
                          if (workspaceError !== undefined) rowKeys.push(`error:workspace:${workspace.id}`)
                          if (workspaceDragError !== undefined) rowKeys.push(`error:workspace-drag:${workspace.id}`)
                          for (const session of hoistedOpenErrors) rowKeys.push(`error:open:${session.id}`)
                          if (!folded) {
                            for (const session of visibleSessions) rowKeys.push(`session:${session.id}`)
                            if (hiddenVisibleCount > 0) rowKeys.push(`more:${workspace.id}`)
                          }
                          // The workspace header row, hoisted so real workspaces wrap it
                          // in a HoverCard (the ungrouped bucket has no workspace and no
                          // rename). Double click enters inline rename, whose form replaces
                          // the trailing content INSIDE this row; inner-button clicks never
                          // trigger it, and single clicks need no delay — the header itself
                          // is not clickable (fold is on the chevron).
                          const workspaceHeader = (
                            <div
                              className={clsx(cc.workspaceHeader, renamingThisWorkspace && cc.workspaceRenaming)}
                              // Per-workspace icon accent: deterministic and
                              // selection-independent (the current-session row carries its
                              // own selected tint); undefined for the ungrouped bucket, so
                              // CSS falls back to the default ink.
                              style={workspaceAccent}
                              data-chamber-row={workspaceKey}
                              data-row-key={`workspace:${workspace.id}`}
                              role="treeitem"
                              aria-expanded={!folded}
                              draggable={!renamingThisWorkspace
                                && workspace.ungrouped !== true && workspace.synthetic !== true}
                              // The git occupant (create/remove) cannot reach
                              // suppressClickRef, so the whole header swallows clicks in the
                              // drag-end trailing-click window, like the guarded fold/+/kebab.
                              onClickCapture={(event) => {
                                if (suppressClickRef.current) {
                                  event.preventDefault()
                                  event.stopPropagation()
                                }
                              }}
                              onDoubleClick={(event) => {
                                if (suppressClickRef.current) return
                                // While this workspace's rename is active a second double
                                // click must not re-arm from the stale title (it would wipe
                                // the text being typed).
                                if (renamingThisWorkspace) return
                                if (menuOpen[workspaceKey] === true || workspace.ungrouped === true
                                  || workspace.synthetic === true) return
                                if (getWorkspaceGitFlag(server.id, workspace.id)?.isWorktree === true) return
                                if (event.target instanceof HTMLElement && event.target.closest('button') !== null) return
                                setRenaming({
                                  sourceId: server.id,
                                  kind: 'workspace',
                                  id: workspace.id,
                                  value: workspace.title,
                                })
                              }}
                              // 键盘焦点揭示（design 08 §3.2）：Tab 进入本行、以及随后进入簇内按钮时
                              // 把 `.rowActionsVisible` 置位；焦点离开整行才收。React 的 onFocus/onBlur
                              // 就是 focusin/focusout，后代按钮获得的焦点同样会冒泡到这里。
                              onFocus={(event) => {
                                if (event.target instanceof Element && event.target.matches(':focus-visible')) {
                                  setKeyboardFocusKey(workspaceKey)
                                }
                              }}
                              onBlur={(event) => {
                                const next = event.relatedTarget
                                if (!(next instanceof Node) || !event.currentTarget.contains(next)) {
                                  setKeyboardFocusKey(current => (current === workspaceKey ? null : current))
                                }
                              }}
                              onPointerDown={workspace.ungrouped === true || workspace.synthetic === true
                                ? undefined
                                : (event) => {
                                  // Same press-target guard as the source header: a gesture
                                  // that STARTED on a workspace-header button never initiates
                                  // the drag (a >4px micro-drag on the fold toggle must not
                                  // swallow its click).
                                  dragPressOnButtonRef.current = event.target instanceof Element && event.target.closest('button') !== null
                                }}
                              onDragStart={workspace.ungrouped === true || workspace.synthetic === true
                                ? undefined
                                : (event) => {
                                  // Abort drags that began on a button —
                                  // buttons stay pure click affordances.
                                  if (dragPressOnButtonRef.current) {
                                    dragPressOnButtonRef.current = false
                                    event.preventDefault()
                                    return
                                  }
                                  dragPressOnButtonRef.current = false
                                  event.dataTransfer.effectAllowed = 'move'
                                  event.dataTransfer.setData('text/plain', workspace.id)
                                  // Suppress the trailing click like session rows do: a drop
                                  // ending over the guarded controls (fold/+/kebab) must not
                                  // fire a spurious toggle/menu.
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
                                  // 镜像会话行复位：拖拽结束后一个 tick 清除抑制位，
                                  // 否则尾随 click 会短路来源切换/排序/加工作区/搜索/
                                  // 折叠/新建/kebab/归档/会话打开。
                                  window.setTimeout(() => { suppressClickRef.current = false }, 0)
                                }}
                            >
                              <button
                                type="button"
                                className={clsx(
                                  cc.foldToggle,
                                  folded && cc.foldToggleFolded,
                                  // A worktree (derived) workspace shows the git-branch glyph
                                  // at rest and the collapse chevron on hover; a normal
                                  // workspace shows a FOLDER glyph whose artwork carries the
                                  // fold state (open / closed, upstream ui-workspace parity);
                                  // the ungrouped bucket keeps the plain chevron.
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
                                <IconChevronRightOutlineRegular size={14} className={cc.foldChevron} />
                                {isWorktree && (
                                  <IconBranchOutlineRegular size={14} className={cc.foldBranch} />
                                )}
                                {/* Upstream ui-workspace ProjectRowItem STATE-MECHANISM parity:
                                    the resting folder glyph itself carries the group's state —
                                    OPEN while the group is expanded, CLOSED while folded. The
                                    open artwork stays the primitives' 1px-stroke
                                    IconFolderOpenOutlineRegular (upstream's pair is fill open /
                                    stroke close); the hover chevron swap above stays exactly as
                                    it was. */}
                                {!isWorktree && workspace.ungrouped !== true && (
                                  folded
                                    ? <IconFolderCloseRegular size={14} className={cc.foldFolder} />
                                    : <IconFolderOpenOutlineRegular size={14} className={cc.foldFolder} />
                                )}
                              </button>
                              {renamingThisWorkspace ? (
                                // In-place rename: the form replaces the header's trailing
                                // content INSIDE the row — fold toggle + gutter stay, so the
                                // row keeps its identity and no input row is appended.
                                <ServerSectionRenameForm placeholder={workspace.title} mode="workspaceHeader" />
                              ) : (
                                <>
                                  <span className={clsx(cc.workspaceTitle, isWorktree && cc.workspaceTitleGit)}>
                                    {workspace.ungrouped ? t('list.ungrouped') : workspace.title}
                                  </span>
                                  {gitFlag?.orphaned === true && (
                                    // The workspace's path no longer exists (externally
                                    // deleted worktree left a ghost). The badge is the
                                    // resident status marker AND one of the two cleanup
                                    // entries; both call the same opener.
                                    <button
                                      type="button"
                                      className={cc.orphanBadge}
                                      title={t('confirm.deleteOrphan', { title: workspace.title })}
                                      onClick={() => {
                                        if (suppressClickRef.current) return
                                        onDeleteWorkspace(server, workspace.id, workspace.title)
                                      }}
                                    >
                                      {t('list.orphaned')}
                                    </button>
                                  )}
                                  {gitFlag?.orphaned === true && isWorktree
                                    && !workspace.ungrouped && !workspace.synthetic && (
                                    // The conventional half of the same cleanup, and the
                                    // one that matters here: a worktree row has no kebab
                                    // (design 08 §3.2), and the Git occupant renders
                                    // NOTHING once the worktree record is gone (no snapshot
                                    // row -> no Git-side delete control), so without this
                                    // button the "Missing" capsule was the row's only exit.
                                    //
                                    // Resident ON PURPOSE - never inside the hover cluster:
                                    // a broken row must not hide its only delete behind
                                    // hover (design 06 §7). Same opener as the badge, so the
                                    // orphan confirm copy and the single-Modal gate apply.
                                    //
                                    // Flag history can be absent (cold start AFTER the record was
                                    // pruned): isWorktree then falls back to false, this button
                                    // does not render, and the row keeps its kebab instead - the
                                    // entry survives, only the row's shape differs (design 06 §11).
                                    <button
                                      type="button"
                                      className={clsx(cc.actionIcon, cc.actionIconDanger, cc.orphanCleanup)}
                                      title={t('confirm.deleteOrphan', { title: workspace.title })}
                                      aria-label={t('action.orphanedCleanup.aria', { name: workspace.title })}
                                      onClick={() => {
                                        if (suppressClickRef.current) return
                                        onDeleteWorkspace(server, workspace.id, workspace.title)
                                      }}
                                    >
                                      <IconTrashOutlineRegular size={14} />
                                    </button>
                                  )}
                                  {visibleSessionCount > 0 && (
                                    <span className={cc.workspaceCount}>{visibleSessionCount}</span>
                                  )}
                                  {workspace.ungrouped !== true && workspace.synthetic !== true && (
                                    // The per-workspace Git occupant sits INSIDE the header row
                                    // as the `.rowActions` cluster's SIBLING right before it (the
                                    // worktree/branch surface is the row itself): the mount renders
                                    // the create/delete action, and a workspace with no git facts
                                    // renders nothing at all. The mount carries `data-git-occupant`
                                    // so the sidebar keeps it OUT of the layout at rest — an in-flow
                                    // zero-width item still consumes the header's 4px gap and would
                                    // park this row's count badge off the shared right column
                                    // (design 08 §3.2).
                                    renderWorkspaceGit('sidebar.workspace.git', { wide }, {
                                      hookContext: { sourceId: server.id, workspaceId: workspace.id },
                                    })
                                  )}
                                  {!workspace.ungrouped && !workspace.synthetic && (
                                    <span
                                      className={clsx(
                                        cc.rowActions,
                                        (menuOpen[workspaceKey] === true || keyboardFocusKey === workspaceKey)
                                          && cc.rowActionsVisible,
                                      )}
                                      onClick={(event) => {
                                        // INVARIANT (pending-click.ts): a control that stops
                                        // propagation MUST clear the pending itself — the
                                        // document-level listener never sees the native event,
                                        // and a surviving pending makes a later click on the
                                        // same session spuriously enter rename.
                                        event.stopPropagation()
                                        clearPendingClick()
                                      }}
                                    >
                                      {/* Upstream ProjectRowItem: the per-workspace New Session
                                          control is the new-chat glyph in a bottom-aligned tooltip that
                                          carries the effective `session.new` keycap; the tooltip label is
                                          upstream's own `actions.newSession` key. */}
                                      <Tooltip
                                        label={t('actions.newSession')}
                                        shortcutKeys={newSessionShortcut?.keys}
                                        side="bottom"
                                        align="end"
                                        delayMs={500}
                                      >
                                        <button
                                          type="button"
                                          className={cc.actionIcon}
                                          // The row name rides the accessible name — a bare
                                          // "新建会话" repeated per row tells AT nothing.
                                          aria-keyshortcuts={newSessionShortcut?.aria}
                                          aria-label={t('action.newSession.aria', { name: workspace.title })}
                                          onClick={() => {
                                            if (suppressClickRef.current) return
                                            clearPendingClick()
                                            onNewSession(server, workspace.id)
                                          }}
                                        >
                                          <IconNewChatOutlineRegular />
                                        </button>
                                      </Tooltip>
                                      {!isWorktree && (
                                      <Menu
                                        // `closeOnPointerLeave` matches upstream; `compact` is the
                                        // primitives' compact list (24px row / 11px type —
                                        // default item 34px, denseList item 30px, both taller
                                        // than the sidebar's 26px rows).
                                        compact
                                        portal
                                        closeOnPointerLeave
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
                                            icon: <IconEditOutlineRegular size={14} />,
                                          },
                                          {
                                            id: 'delete',
                                            // Upstream's copy for the workspace delete entry.
                                            label: t('delete.workspace'),
                                            danger: true,
                                            icon: <IconTrashOutlineRegular size={14} />,
                                          },
                                        ]}
                                        anchor={(
                                          <button
                                            type="button"
                                            className={cc.actionIcon}
                                            aria-label={t('action.menu.workspace', { name: workspace.title })}
                                            aria-haspopup="menu"
                                            aria-expanded={menuOpen[workspaceKey] === true}
                                            onClick={(event) => {
                                              event.stopPropagation()
                                              if (suppressClickRef.current) return
                                              clearPendingClick()
                                              toggleMenu(workspaceKey)
                                            }}
                                          >
                                            <IconEllipsisOutlineRegular size={16} />
                                          </button>
                                        )}
                                      />
                                      )}
                                    </span>
                                  )}
                                </>
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
                                treeDepth > 0 && cc.workspaceTreeNested,
                                marker === 'before' && cc.dropBefore,
                                marker === 'after' && cc.dropAfter,
                              )}
                              // 缩进深度走 CSS 变量（同一规则服务任意层数），并留机器可读锚点。
                              style={treeDepth > 0 ? ({ '--chamber-tree-depth': String(treeDepth) } as CSSProperties) : undefined}
                              data-chamber-tree-depth={treeDepth > 0 ? treeDepth : undefined}
                              role="group"
                              onDragOver={flatAccount || workspace.ungrouped === true || workspace.synthetic === true
                                || workspaceDrag === null
                                || workspaceDrag.sourceId !== server.id
                                ? undefined
                                : (event) => {
                                  event.preventDefault()
                                  event.dataTransfer.dropEffect = 'move'
                                  const half = rowHalf(event)
                                  if (workspaceDropBlocked(workspace.id, half)) {
                                    // A blocked zone never becomes the target.
                                    return
                                  }
                                  setWorkspaceDrag(current => dragOverState(current, workspace.id, half))
                                }}
                              onDrop={flatAccount || workspace.ungrouped === true || workspace.synthetic === true
                                || workspaceDrag === null
                                || workspaceDrag.sourceId !== server.id
                                ? undefined
                                : (event) => {
                                  event.preventDefault()
                                  if (workspaceDrag === null) return
                                  commitWorkspaceDrag(server, workspaceDrag, { id: workspace.id, half: rowHalf(event) })
                                }}
                            >
                              {flatAccount ? null : workspace.createdAt === undefined ? (
                                // Upstream's own gate (`row.createdAt === void 0`): no
                                // creation fact, no card. derive leaves createdAt sparse
                                // for an unparseable wire value ('' on the cwd-derived
                                // synthetic groups) and the ungrouped bucket is built
                                // without one, so NaN never reaches the verbatim
                                // createdLabel.
                                workspaceHeader
                              ) : (
                                <RowHoverCard
                                  anchor={workspaceHeader}
                                  // Upstream WorkspaceHoverContent: title, display path,
                                  // absolute creation time; the whole card copies the cwd.
                                  content={(
                                    <div className={cc.hoverContent}>
                                      <div className={cc.hoverTitle}>{workspace.title}</div>
                                      <div className={cc.hoverPath}>{workspace.path}</div>
                                      <div className={cc.hoverTime}>{createdLabel(workspace.createdAt, t)}</div>
                                    </div>
                                  )}
                                  openDelayMs={800}
                                  disabled={menuOpen[workspaceKey] === true || renamingThisWorkspace
                                    || workspaceDrag !== null || sessionDrag !== null || serverDrag !== null}
                                  copyText={workspace.path}
                                  copyLabel={t('action.copy')}
                                  copiedLabel={t('hover.copied')}
                                />
                              )}
                            {/* Workspace-scoped failures are hoisted OUT of the
                                fold gate: new-session/rename/delete/drag
                                failures must surface even while the group is
                                folded, since all of those are reachable from a
                                folded header. */}
                            {workspaceError !== undefined && (
                              <div className={cc.rowError} role="alert"
                                data-row-key={`error:workspace:${workspace.id}`}>{workspaceError}</div>
                            )}
                            {workspaceDragError !== undefined && (
                              <div className={cc.rowError} role="alert"
                                data-row-key={`error:workspace-drag:${workspace.id}`}>{workspaceDragError}</div>
                            )}
                            {/* The hoisted open failures (see the key block above);
                                visible rows render the error inline below. */}
                            {hoistedOpenErrors.map(session => (
                              <div key={session.id} className={clsx(cc.rowError, cc.sessionNested)} role="alert"
                                data-row-key={`error:open:${session.id}`}>
                                {rowErrors[openErrorKey(server.id, session.id)]}
                              </div>
                            ))}
                            {!folded && (
                            <>
                              <ServerSectionSessionRows
                                server={server}
                                workspace={workspace}
                                sessions={visibleSessions}
                                currentId={currentId}
                                sessionMarker={sessionMarker}
                                activeSessionDrag={activeSessionDrag}
                                isGhostSession={isGhostSession}
                                flat={flatAccount}
                              />
                              {hiddenVisibleCount > 0 && (
                                <button
                                  type="button"
                                  className={cc.sessionRowsMore}
                                  data-row-key={`more:${workspace.id}`}
                                  // A real two-way disclosure: the control
                                  // reports its state and collapses again.
                                  aria-expanded={rowsExpanded}
                                  onClick={() => {
                                    setSessionRowsExpanded(prev => ({ ...prev, [accountStateKey]: !rowsExpanded }))
                                  }}
                                >
                                  {rowsExpanded
                                    ? t('sessions.collapse')
                                    : t('sessions.expand', { n: hiddenVisibleCount })}
                                </button>
                              )}
                            </>
                            )}
                          </div>
                          </Fragment>
                          )
                          })
                        })()}
                        {(() => {
                          // ALL unregistered worktrees render at the very end of the list,
                          // one block per repository. The block must NOT beat the workspace
                          // list: git facts arrive before the aggregate, so gate on the
                          // aggregate having landed.
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
                        {(flatGroupBy ? flatSessions.length === 0 : server.workspaces.length === 0) && (
                          // 空态键在**渲染行数**上（上游同规则）：flat 模式下工作区可能都在、
                          // 但没有任何可见行（全部被折叠/筛选隐藏），此时同样要给空态。
                          // 空态只有一个键位（AnimatedRows 的种子键只有一份）：only 空态
                          // 在这唯一的 empty 元素内分支，绝不渲染第二个键。
                          <div className={cc.empty} data-row-key="empty">
                            {archivedFilter === 'only'
                              ? (
                                <>
                                  <span>{t('empty.noneArchived')}</span>
                                  <button
                                    type="button"
                                    className={cc.archiveNoticeAction}
                                    onClick={() => { setArchivedFilter(server, 'default') }}
                                  >
                                    {t('empty.viewOthers')}
                                  </button>
                                </>
                              )
                              : t('list.noWorkspaces')}
                          </div>
                        )}
                        {query === '' && rowErrors[`${server.id}/add-workspace`] !== undefined && (
                          <div className={cc.rowError} role="alert">{rowErrors[`${server.id}/add-workspace`]}</div>
                        )}
                      </>
                    </AnimatedRows>
                  )}
                  </>
                  )
                })() : (
                  // Disconnected source: header + status icon only (phase on hover/aria);
                  // the settings page carries the detailed logSummary.
                  null
                )}
                </>
                )}
              </section>
              )

})
