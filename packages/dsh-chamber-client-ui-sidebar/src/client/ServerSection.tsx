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
import { Fragment, useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { SESSION_SEARCH_RESULT_LIMIT } from '@deepseek-ai/dsh-api-session-controller/client'
import {
  IconBranchOutlineRegular, IconChevronRightOutlineRegular, IconEditOutlineRegular, IconEllipsisOutlineRegular,
  IconFolderOpenOutlineRegular, IconPlusOutlineRegular, IconTrashOutlineRegular, Menu,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { RowHoverCard } from './RowHoverCard.tsx'
import { chamberBridge, type ChamberServerAggregate, type ChamberServerWorkspace } from '@dsh-chamber/dsh-chamber-client-core/aggregate-store'
import {
  deriveLocalSearchMatches, mergeSearchResults, orderUngroupedSessions, reconciledSessionOrder,
  sanitizeSearchQuery, workspaceAccentStyle,
} from '@dsh-chamber/dsh-chamber-client-core/derive'
import { type SearchRow } from '@dsh-chamber/dsh-chamber-client-core/instance-api'
import {
  collapseSearch, getSearchStates, subscribeSearch,
  type SourceSearchState,
} from '@dsh-chamber/dsh-chamber-client-core/search-state'
import { clearPendingClick } from '@dsh-chamber/dsh-chamber-client-core/pending-click'
import { createPrewarmIntent, type PrewarmIntent } from '@dsh-chamber/dsh-chamber-client-core/prewarm-intent'
import { openErrorKey } from '@dsh-chamber/dsh-chamber-client-core/open-outcome'
import { getSourceRepoLayouts, getWorkspaceGitFlag, hiddenByMainWorkspaceFold, isSourceGitFlagsLoaded } from '@dsh-chamber/dsh-chamber-client-core/workspace-git-flags'
import { resolveWorkspaceDrop } from '@dsh-chamber/dsh-chamber-client-core/workspace-drag-order'
import { sessionRowDisclosure, sessionRowWindow, SESSION_ROWS_VISIBLE_FIRST } from '@dsh-chamber/dsh-chamber-client-core/session-row-window'
import { useSidebarSection, workspaceDropEnv } from './sidebar-context.ts'
import { ServerSectionHeader } from './ServerSectionHeader.tsx'
import { ServerSectionSearchCapsule, ServerSectionSearchResults } from './ServerSectionSearch.tsx'
import { ServerSectionSessionRows } from './ServerSectionRows.tsx'
import { ServerSectionRenameForm } from './server-section-controls.tsx'
import { dragOverState, projectionToLocalSearchSnapshot, rowHalf } from './server-section-model.ts'
import cc from './sidebar-chamber.module.css'

export { sourceHeaderActivatable, sourceHeaderTitle } from './server-section-model.ts'

export function ServerSection({ server }: { server: ChamberServerAggregate }) {
  const {
    wide,
    t,
    chamberInstanceId,
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
  } = useSidebarSection()

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

  // Hover-card relative times share one render-time clock.
  const now = Date.now()

              // The query is sanitized by construction; the loading fallback covers expand-without-query.
              const search = searchState.get(server.id)
              const query = sanitizeSearchQuery(search?.query ?? '')
              // 胶囊卸载（托管 dsh 停机）会让焦点掉到 body（键盘用户迷路）：把焦点
              // 交还给折叠按钮——该头部唯一恒在的键盘入口。
              const searchCapsuleMounted = server.connected
                && viewPrefs.sourceFolded?.[server.id] !== true
                && search?.expanded === true
              // 展开后聚焦输入框：挂载前 ref 为空，必须等这一轮提交后再聚焦
              if (searchCapsuleMounted && focusSearchOnMount.current) {
                focusSearchOnMount.current = false
                queueMicrotask(() => searchInput.current?.focus())
              }
              useEffect(() => {
                // 仅当焦点确实落在胶囊里才回交给折叠按钮：任何断连都不该把用户从
                // 别处抢回头部。判定必须在卸载之后（activeElement 已回落到 body），
                // 用卸载前记录的"胶囊是否持有焦点"。断连会在同一批清掉搜索状态，
                // 判定条件必须是"连接事实"而不是 expanded——折叠路径不会误抢。
                if (prevSearchCapsuleMounted.current && !searchCapsuleMounted
                  && capsuleHeldFocus.current && server.connected !== true) {
                  foldToggleRef.current?.focus()
                }
                prevSearchCapsuleMounted.current = searchCapsuleMounted
                if (searchCapsuleMounted) capsuleHeldFocus.current = false
              }, [searchCapsuleMounted, server.connected])
              const currentRemote = search !== undefined && search.query === query
                ? search
                : { query, status: 'loading' as const, items: [] as SearchRow[], hasMore: false }
              // Render-side merge: the aggregate's LOCAL metadata matches
              // (title/workspace-label substring over the visible projection)
              // plus the remote content-search page. 远程腿按可见集过滤——投影已
              // 过滤 subagent/archived/blank-non-current，"在投影里"即"可见"；
              // 空集（断连/未就绪）时 mergeSearchResults 降级为不过滤。
              const visibleIds = new Set<string>()
              for (const workspace of server.workspaces) {
                for (const session of workspace.sessions) visibleIds.add(session.id)
              }
              const merged = mergeSearchResults(
                deriveLocalSearchMatches(projectionToLocalSearchSnapshot(server), query),
                currentRemote,
                SESSION_SEARCH_RESULT_LIMIT,
                visibleIds,
                server.aggregateReady === true,
              )
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
              const openErrorPrefix = `${server.id}/session/`
              for (const [key, message] of Object.entries(rowErrors)) {
                if (!key.startsWith(openErrorPrefix) || !key.endsWith('/open')) continue
                serverOpenFailures.push({
                  sessionId: key.slice(openErrorPrefix.length, key.length - '/open'.length),
                  message,
                })
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
              // The first insertion boundary of the list draws a top indicator while
              // the marker on the first real group is suppressed. The boundary is the
              // first VISIBLE row of the DISPLAY order (override- and fold-aware);
              // synthetic cwd-derived groups are never drop targets.
              const realWorkspaceIds = server.workspaces
                .filter(workspace => workspace.ungrouped !== true && workspace.synthetic !== true)
                .map(workspace => workspace.id)
              const dropEnv = workspaceDropEnv(server.id, realWorkspaceIds, workspaceOrderOverride[server.id], viewPrefs.folded)
              const firstDropRow = dropEnv.order.find(id => !dropEnv.hidden(id))
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
                if (workspaceDrag === null || workspaceDrag.sourceId !== server.id) return false
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
              const sessionsOf = (workspace: ChamberServerWorkspace): ChamberServerWorkspace['sessions'] => {
                const wire = workspace.sessions
                const orderBy = viewPrefs.orderBy?.[server.id] ?? 'manual'
                // updated = 手动序 + 活动置顶：渲染序取共享的 updated-order account
                // （推导 effect 已写回 seeding/recency sort/promotion），account 不存在
                // 时（切换后首帧、effect 尚未落盘）回退 wire 序。**重入 updated** 时
                // 首帧保留旧 account 序，下一帧才整列重排（render-then-sort，菜单关闭
                // 动画内不可感知）。manual 模式：未分组桶用存储序，工作区 override 优先。
                if (orderBy === 'updated') {
                  const stored = viewPrefs.updatedOrder?.[`${server.id}/${workspace.id}`]
                  if (stored === undefined) return wire
                  const byId = new Map(wire.map(session => [session.id, session]))
                  return reconciledSessionOrder(stored, wire.map(session => session.id)).flatMap(id => {
                    const session = byId.get(id)
                    return session === undefined ? [] : [session]
                  })
                }
                if (workspace.ungrouped === true) {
                  return orderUngroupedSessions(wire, viewPrefs.ungroupedOrder[server.id])
                }
                const override = sessionOrderOverride[`${server.id}/${workspace.id}`]
                if (override !== undefined) {
                  const byId = new Map(wire.map(session => [session.id, session]))
                  return override.flatMap(id => { const session = byId.get(id); return session === undefined ? [] : [session] })
                }
                return wire
              }
              return (
              <section
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
                {/* The server-level fold hides EVERYTHING below the header —
                    capsule, source-scope git alert and workspace list. The
                    search state itself is untouched, so expanding remounts the
                    capsule with its query intact. */}
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
                  {serverOpenFailures.filter(failure => !visibleIds.has(failure.sessionId)).map(failure => (
                    <div key={failure.sessionId} className={cc.rowError} role="alert">{failure.message}</div>
                  ))}
                  <div
                    className={cc.workspaceList}
                    // The browse list is one tree; an active query replaces it with the
                    // search-results tree and the fetch-error branch renders no tree.
                    // The browse tree carries an accessible name like its sibling.
                    role={query === '' && server.aggregateError === undefined ? 'tree' : undefined}
                    aria-label={query === '' && server.aggregateError === undefined ? t('section.sessions') : undefined}
                  >
                    {query !== '' ? (
                      // An active query replaces the whole workspace list (header/status
                      // stay; fold and add-workspace hidden). Results outrank the
                      // snapshot-fetch error: a content-search failure still shows the
                      // local metadata hits, with the error banner below them.
                      <ServerSectionSearchResults
                        server={server}
                        merged={merged}
                        currentRemote={currentRemote}
                        currentId={currentId}
                      />
                    ) : server.aggregateError !== undefined ? (
                      <div className={cc.aggregateError} role="alert">{server.aggregateError}</div>
                    ) : (
                      <>
                        {workspaceDropAtListStart && firstDropRow !== undefined
                          && !workspaceDropBlocked(firstDropRow, 'before') && (
                          <span className={cc.listTopDropIndicator} aria-hidden="true" />
                        )}
                        {(() => {
                          // Folding a git MAIN workspace folds the WHOLE repository
                          // group: derived (worktree) rows — those whose git flag
                          // carries mainWorkspaceId — hide while the main is folded
                          // and return on expand; worktrees of an unregistered main
                          // stay visible. Once the main's registration vanishes
                          // (external deletion) the stale fold pref must not lock
                          // derived rows hidden with no expand control. Rows carry
                          // no destructive in-flight state (git saga surfaces at
                          // source level, rowErrors restore on expand).
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
                          return visibleOrderedWorkspaces.map(workspace => {
                          const workspaceKey = `${server.id}/${workspace.id}`
                          const folded = viewPrefs.folded[workspaceKey] === true
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
                          const sessions = sessionsOf(workspace)
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
                          const rowsExpanded = sessionRowsExpanded[workspaceKey] === true
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
                                  // workspace shows a FOLDER glyph; the ungrouped bucket
                                  // keeps the plain chevron.
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
                                {!isWorktree && workspace.ungrouped !== true && (
                                  <IconFolderOpenOutlineRegular size={14} className={cc.foldFolder} />
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
                                  {getWorkspaceGitFlag(server.id, workspace.id)?.orphaned === true && (
                                    // The workspace's path no longer exists (externally
                                    // deleted worktree left a ghost). The badge doubles as
                                    // the cleanup entry: an orphaned WORKTREE keeps its row
                                    // but has no kebab, so the badge opens the delete confirm.
                                    <button
                                      type="button"
                                      className={cc.orphanBadge}
                                      title={t('confirm.deleteOrphan', { title: workspace.title })}
                                      onClick={() => onDeleteWorkspace(server, workspace.id, workspace.title)}
                                    >
                                      {t('list.orphaned')}
                                    </button>
                                  )}
                                  {visibleSessionCount > 0 && (
                                    <span className={cc.workspaceCount}>{visibleSessionCount}</span>
                                  )}
                                  {workspace.ungrouped !== true && workspace.synthetic !== true && (
                                    // The per-workspace Git occupant lives INSIDE the header
                                    // row (the worktree/branch surface is the row itself):
                                    // branch chip plus create/delete; non-git workspaces get
                                    // an empty mount.
                                    renderWorkspaceGit('sidebar.workspace.git', { wide }, {
                                      hookContext: { sourceId: server.id, workspaceId: workspace.id },
                                    })
                                  )}
                                  {!workspace.ungrouped && !workspace.synthetic && (
                                    <span
                                      className={clsx(cc.rowActions, menuOpen[workspaceKey] === true && cc.rowActionsVisible)}
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
                                      <button
                                        type="button"
                                        className={cc.actionIcon}
                                        // The row name rides the accessible name — a bare
                                        // "新建会话" repeated per row tells AT nothing.
                                        aria-label={t('action.newSession.aria', { name: workspace.title })}
                                        title={t('action.newSession.aria', { name: workspace.title })}
                                        onClick={() => {
                                          if (suppressClickRef.current) return
                                          clearPendingClick()
                                          onNewSession(server, workspace.id)
                                        }}
                                      >
                                        <IconPlusOutlineRegular size={16} />
                                      </button>
                                      {!isWorktree && (
                                      <Menu
                                        // `closeOnPointerLeave` matches upstream; `compact`
                                        // keeps the 26px/12px density instead of the official
                                        // 40px/14px.
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
                                marker === 'before' && cc.dropBefore,
                                marker === 'after' && cc.dropAfter,
                              )}
                              role="group"
                              onDragOver={workspace.ungrouped === true || workspace.synthetic === true
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
                              onDrop={workspace.ungrouped === true || workspace.synthetic === true
                                || workspaceDrag === null
                                || workspaceDrag.sourceId !== server.id
                                ? undefined
                                : (event) => {
                                  event.preventDefault()
                                  if (workspaceDrag === null) return
                                  commitWorkspaceDrag(server, workspaceDrag, { id: workspace.id, half: rowHalf(event) })
                                }}
                            >
                              {workspace.ungrouped === true ? (
                                workspaceHeader
                              ) : (
                                <RowHoverCard
                                  anchor={workspaceHeader}
                                  // Read-only: the projection carries no cwd, so there is
                                  // nothing to copy and no copy props that could render.
                                  content={(
                                    <div className={cc.hoverContent}>
                                      <div className={cc.hoverTitle}>{workspace.title}</div>
                                      {sessions.length > 0 && (
                                        <div className={cc.hoverTime}>{t('hover.sessionCount', { n: sessions.length })}</div>
                                      )}
                                    </div>
                                  )}
                                  disabled={menuOpen[workspaceKey] === true || renamingThisWorkspace
                                    || workspaceDrag !== null || sessionDrag !== null || serverDrag !== null}
                                />
                              )}
                            {/* Workspace-scoped failures are hoisted OUT of the
                                fold gate: new-session/rename/delete/drag
                                failures must surface even while the group is
                                folded, since all of those are reachable from a
                                folded header. */}
                            {workspaceError !== undefined && (
                              <div className={cc.rowError} role="alert">{workspaceError}</div>
                            )}
                            {rowErrors[`${server.id}/workspace-drag/${workspace.id}`] !== undefined && (
                              <div className={cc.rowError} role="alert">{rowErrors[`${server.id}/workspace-drag/${workspace.id}`]}</div>
                            )}
                            {/* Session open failures whose row the fold/window
                                gate hides are hoisted the same way, so a
                                failure survives a mid-flight fold; visible rows
                                render the error inline below themselves. */}
                            {sessions
                              .filter(session => rowErrors[openErrorKey(server.id, session.id)] !== undefined
                                && (folded || !visibleSessions.some(visible => visible.id === session.id)))
                              .map(session => (
                                <div key={session.id} className={clsx(cc.rowError, cc.sessionNested)} role="alert">
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
                                now={now}
                                isGhostSession={isGhostSession}
                              />
                              {hiddenVisibleCount > 0 && (
                                <button
                                  type="button"
                                  className={cc.sessionRowsMore}
                                  // A real two-way disclosure: the control
                                  // reports its state and collapses again.
                                  aria-expanded={rowsExpanded}
                                  onClick={() => {
                                    setSessionRowsExpanded(prev => ({ ...prev, [workspaceKey]: !rowsExpanded }))
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
                        {server.workspaces.length === 0 && <div className={cc.empty}>{t('list.noWorkspaces')}</div>}
                        {query === '' && rowErrors[`${server.id}/add-workspace`] !== undefined && (
                          <div className={cc.rowError} role="alert">{rowErrors[`${server.id}/add-workspace`]}</div>
                        )}
                      </>
                    )}
                  </div>
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

}