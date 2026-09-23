/**
 * One source’s header row of the chamber sidebar ServerSection subtree: the
 * connection dot/spinner, fold toggle, sort menu, add-workspace/search/archive
 * actions, the single per-source source-note live region and the folded
 * open-failure hoist. Cross-cutting shell state comes from
 * useSidebarSection() and the section-local values are props.
 */
import type { RefObject } from 'react'
import clsx from 'clsx'
import {
  IconChevronRightOutline14, IconLoadingOutline16, IconPersonalizationOutline16,
  IconProjectAddOutline16, IconSearchOutline16, IconTrashOutline16, Menu, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { chamberBridge } from '@dsh-chamber/dsh-chamber-client-core/aggregate-store'
import type { ChamberServerAggregate } from '@dsh-chamber/dsh-chamber-client-core/aggregate-store'
import { clearPendingClick } from '@dsh-chamber/dsh-chamber-client-core/pending-click'
import type { PrewarmIntent } from '@dsh-chamber/dsh-chamber-client-core/prewarm-intent'
import { collapseSearch, expandSearch, type SourceSearchState } from '@dsh-chamber/dsh-chamber-client-core/search-state'
import type { SidebarKey } from './locales.ts'
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
  } = useSidebarSection()
  // 头部是否为可激活入口，以及其
  // title/aria 文案（托管 dsh 停机时说明原因，而不是"切换到该实例"）。
  const headerActivatable = sourceHeaderActivatable(server, chamberInstanceId)
  const headerTitle = sourceHeaderTitle(server, chamberInstanceId, t)
  // The source-header controls carry the
  // OFFICIAL Tooltip instead of the borrowed native title= (upstream wraps
  // the same ViewOptionsMenu trigger in `<Tooltip side="bottom" delayMs={500}>`,
  // vendor ui-workspace WorkspaceBrowser.tsx:198-203). The sort trigger names
  // the active mode, so the bubble and the accessible name carry it.
  const sortModeKey: SidebarKey = viewPrefs.orderBy?.[server.id] === 'updated' ? 'orderBy.updated' : 'orderBy.manual'
  const sortLabel = `${t('action.sort')} · ${t(sortModeKey)}`
  // 来源级"数据不可信"说明：单一定居 live region（见下方 sourceNote 的渲染与
  // CSS :empty）。一个来源只应有一个 live region，所以降级
  // 说明也**并入同一条**，按优先级取一句：托管不可用 > 前端能力受限（boot 缺口）
  // > 托管瞬态 > 基线未就绪。前两条不互斥（来源可能既停机、壳里又留着上一次挂载
  // 的缺口事实），故顺序即优先级；缺口事实来自本来源当前挂载的壳，仅在挂载/预热过
  // 的来源上存在（STATUS 已登记的覆盖边界）。
  // 内容变化时既有的 live region 才可被 AT 播报（"插入即带内容"不会播报）。
  // 托管瞬态：必须**按 kind 限定**——本地 /health 的词表同样含 starting/
  // restarting，只判 phase 会给本地源挂上网关专属文案。
  const managedTransient = server.kind === 'gateway'
    && (server.phase === 'starting' || server.phase === 'restarting')
  const bootGapNote = sourceBootGapNote(server, t)
  // The gap branch is selected by CONSTRUCTION (a boolean), never by comparing
  // the rendered strings: the note text is dictionary copy and comparing it
  // would silently mis-tone the line the day two branches share a sentence.
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
          // 能力一览：最低优先级的一句「会话事实档位」说明。字段缺席时
          // 桌面侧尚未投影 = 未知，绝不臆造为 full。
          : server.sessionFacts === 'degraded'
            ? t('source.factsDegraded')
            : server.sessionFacts === 'legacy'
              ? t('source.factsLegacy')
              : server.sessionFacts === 'disabled'
                ? t('source.factsDisabled')
                : ''
  // 两个门必须分开（下方状态点注释即其判据）：
  // ①**live region 角色**：任何说明行在场，点就让位（一个来源只应有一个 live
  //   region——见渲染处的 `role={sourceNote === '' ? 'status' : undefined}`）；
  // ②**状态词的承载**：只有把 `{state}` 写进句子的说明行才接管 aria-label——
  //   目前只有 managedDown 与 managedStarting 携带 phase；baselinePending 与
  //   降级说明（boot 缺口）都**不含** phase，点必须继续用 aria-label 承担它。
  // 有降级说明的来源不能因此丢掉状态词：`sourceNote !== ''` 判据会让点既无 role
  // 也无 label，故按"是否携带 phase"取值。
  // …but "carries the state word" depends on WHICH note won the cascade above: a
  // gateway source that is transient (starting/restarting) AND degraded renders
  // the GAP sentence, so the dot must keep its aria-label there — the transient
  // branch never gets to speak (folded in the gap branch).
  const noteCarriesPhase = server.managedRuntimeDown === true || (managedTransient && !noteIsBootGap)
  // 每个已挂载壳各有一份侧栏 DOM（同一来源会出现多份）：id 必须按壳限定，
  // 否则 aria-describedby 可能解析到另一份（隐藏壳）的同名节点。
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
                  // 能力档位的机器可读锚点（验收仪器/诊断读取；用户可见文案见下方 sourceNote 分支）。
                  data-chamber-facts-mode={server.sessionFacts}
                  // 断连来源仍渲染的只读事实——来源级 stale 标记。
                  data-chamber-stale={server.runtime?.stale === true || undefined}
                  style={sourceAccentStyle(server)}
                  title={headerTitle}
                  role={headerActivatable ? 'button' : undefined}
                  tabIndex={headerActivatable ? 0 : undefined}
                  // 非交互形态（托管停机）不给 generic 角色加 aria-label（命名对
                  // generic 无效）——改用 aria-describedby
                  // 指向下方说明行。
                  aria-label={headerActivatable ? headerTitle : undefined}
                  aria-describedby={!headerActivatable && sourceNote !== '' ? sourceNoteId : undefined}
                  // chamber (06 §2.4 — option
                  // 1): the source header is the drag handle for the
                  // server-group display-order drag. The same trailing-click
                  // suppression as the workspace header: a drop ending over
                  // the header (or its buttons) must not fire a spurious
                  // activate/toggle/action.
                  draggable
                  // 来源头部 hover 的意图预热触点。React 的 pointerenter/leave
                  // 不因指针移入子按钮而 leave（与 RowHoverCard 同款用法），移出
                  // header 才 leave；真正的"是否值得优先"由 App 端既有纪律裁决。
                  onPointerEnter={() => { prewarmIntent().enter() }}
                  onPointerLeave={() => { prewarmIntent().leave() }}
                  onPointerDown={(event) => {
                    // Record whether the press started
                    // on a header BUTTON. dragstart's target is the drag
                    // SOURCE (the header itself), not the pressed element, so
                    // the press target must be captured here, at pointerdown.
                    dragPressOnButtonRef.current = event.target instanceof Element && event.target.closest('button') !== null
                  }}
                  onDragStart={(event) => {
                    // 拖动来源头部是"整理"而不是"前往"——它消费本次 hover
                    // 周期，drag 期间不再补发预热意图（机器语义：一次 press）。
                    prewarmIntent().press()
                    // A gesture that STARTED on a header
                    // button (fold / sort / add-workspace / search /
                    // archive-cleanup manager) aborts the
                    // drag initiation — buttons are click affordances, a >4px
                    // micro-drag on the fold toggle must not swallow its click
                    // (the click then fires normally on release). Dragging
                    // from the header's non-button area is unaffected.
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
                    // An ESC-cancelled drag must not persist the last marker —
                    // dropEffect 'none' means the user explicitly cancelled.
                    // A NULL dataTransfer at dragend (Safari has done
                    // this) must also count as cancelled — with `?.` alone,
                    // undefined !== 'none' would wrongly commit. The section
                    // onDrop path is unaffected: a real drop commits there
                    // first, and the serverDropCommitted guard makes this
                    // no-op.
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
                    // 点击（明确点开）消费本次 hover 周期——切换本身走既有的
                    // requestActivateSource → selectView 原路，意图不得代行。
                    prewarmIntent().press()
                    if (suppressClickRef.current) return
                    // A remote source's header switches the active N-ctx view
                    // without opening a session (App layer owns the switch).
                    // A managed-down gateway is NOT activatable: its boot is
                    // guaranteed to fail (gateway 503), so the header must not
                    // promise a switch the App itself refuses to prewarm/harvest
                    // (the inline note explains why).
                    if (headerActivatable) chamberBridge.requestActivateSource(server.id)
                  }}
                  onKeyDown={(event) => {
                    if (!headerActivatable) return
                    // Only respond to the header's OWN focus. A keydown
                    // bubbling from an inner button (fold toggle / sort /
                    // add-workspace / search) must not be swallowed:
                    // preventDefault here would cancel the button's native
                    // Enter/Space activation AND switch the active N-ctx
                    // view.
                    if (event.target !== event.currentTarget) return
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      // 键盘激活同样消费本次 hover 周期（与点击同义）。
                      prewarmIntent().press()
                      chamberBridge.requestActivateSource(server.id)
                    }
                  }}
                >
                  {/* chamber (06 §2.4): the server-level fold
                      toggle — a MONITOR glyph at rest (server = machine, NOT
                      the workspace folder glyph — the shared folder reads as
                      a workspace and misleads), swapping to the collapse
                      chevron on header hover/focus (same slot, nothing
                      shifts). Clicking collapses/expands the source's ENTIRE
                      workspace list without touching any workspace's own
                      conversation fold state. stopPropagation keeps the
                      header's activate click (and the pending-click
                      discipline) out. */}
                  <button
                    ref={foldToggleRef}
                    type="button"
                    className={clsx(cc.sourceFoldToggle, sourceFolded && cc.sourceFoldToggleFolded)}
                    aria-label={sourceFolded ? t('server.expand') : t('server.collapse')}
                    aria-expanded={!sourceFolded}
                    // Own tooltip — without it the
                    // header's inherited title ("切换到该实例") would show on
                    // hover, semantically misleading for a fold toggle.
                    title={sourceFolded ? t('server.expand') : t('server.collapse')}
                    onClick={(event) => {
                      event.stopPropagation()
                      if (suppressClickRef.current) return
                      clearPendingClick()
                      toggleSourceFold(server.id)
                    }}
                  >
                    <IconChevronRightOutline14 size={15} className={cc.sourceFoldChevron} />
                    <IconMonitorOutline16 size={15} className={cc.sourceFoldGlyph} />
                  </button>
                  <span className={cc.sourceLabel}>{server.label}</span>
                  {/* chamber: the source-header plugin diagnostic marker was
                      REMOVED per user decision: the plugin runtime
                      diagnostic (states + plugin id + reason) is surfaced ONLY
                      on the connections page / per-instance plugin dialog
                      (design 09 §3.5 detail surface) — the sidebar never
                      renders an exclamation for plugin-graph conditions,
                      informational or abnormal. */}
                  {/* chamber: connection status as a dot/spinner — the phase
                      text is never rendered, only carried on hover/aria. */}
                  <span
                    className={cc.sourceStatus}
                    title={t(sourceStatusLabelKey(server))}
                    // 两个门要分开：live region 角色只要有说明行
                    // 就让位（一个来源一个 live region），但**状态词的承载**只有携带
                    // phase 的说明行才接管——baselinePending 不含 phase，点必须继续
                    // 通过 aria-label 承担它。
                    aria-label={noteCarriesPhase ? undefined : t(sourceStatusLabelKey(server))}
                    role={sourceNote === '' ? 'status' : undefined}
                  >
                    {sourceStatusKind(server) === 'busy' ? (
                      <IconLoadingOutline16 className={cc.statusSpinner} size={12} />
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
                  {/* chamber: header actions (sort menu + add-workspace `+` +
                      per-source search + archive-cleanup manager — design 24 §6)
                      are hover-revealed like the session rows' actions: at rest the connection status occupies the
                      right side; hovering the header swaps in the icon cluster
                      (visibility swap, no reflow). While a search capsule is
                      open OR the sort menu is open the cluster stays visible
                      (.sourceActionsVisible) so the icon can collapse/close. */}
                  <span
                    className={clsx(
                      cc.sourceActions,
                      (search?.expanded === true || sortMenuOpen === server.id) && cc.sourceActionsVisible,
                    )}
                  >
                    {/* chamber (06 §3.1): per-source
                        session sort MENU (official ViewOptionsMenu pattern —
                        replaces the blind manual↔updated cycle). The menu
                        shows both options with a checkmark on the current one
                        (selectedIds), so the active order is visible the
                        moment it opens; the title + aria-label + sortActive
                        tint carry the current mode at rest (hover-revealed).
                        Selecting a mode goes through setOrderBy (switch
                        bookkeeping + override drop). */}
                    {server.connected && (server.aggregateError === undefined || search?.expanded === true) && (
                      <Menu
                        // Menu density: `compact` (26px rows, 12px type)
                        // instead of the primitive's `dense` variant that the
                        // ViewOptionsMenu copies, whose menu rows are taller
                        // than our own 26px list rows; the radius/background
                        // stay the official ones the variant ships with.
                        compact
                        portal
                        align="end"
                        open={sortMenuOpen === server.id}
                        onClose={() => { setSortMenuOpen(null) }}
                        onSelect={(id: string) => {
                          setSortMenuOpen(null)
                          // 「全部已读」：只把意图发给 App（读水位与落盘在 App 手里），
                          // 插件不自己写读数——同一份权威，两个载体不重复实现。
                          if (id === 'mark-all-read') {
                            chamberBridge.requestMarkAllRead(server.id)
                            return
                          }
                          if (id === 'manual' || id === 'updated') setOrderBy(server, id)
                        }}
                        items={[
                          { type: 'label' as const, id: 'sort-label', text: t('orderBy.label') },
                          { id: 'manual', label: t('orderBy.manual') },
                          { id: 'updated', label: t('orderBy.updated') },
                          { id: 'mark-all-read', label: t('source.markAllRead') },
                        ]}
                        selectedIds={[viewPrefs.orderBy?.[server.id] ?? 'manual']}
                        anchor={(
                          <Tooltip label={sortLabel} side="bottom" delayMs={500}>
                            <button
                              type="button"
                              className={clsx(cc.actionIcon, viewPrefs.orderBy?.[server.id] === 'updated' && cc.sortActive)}
                              aria-label={sortLabel}
                              aria-haspopup="menu"
                              aria-expanded={sortMenuOpen === server.id}
                              onClick={(event) => {
                                event.stopPropagation()
                                if (suppressClickRef.current) return
                                // stopPropagation also stops the NATIVE event, so
                                // the document-level pending-click listener never
                                // sees this click — clear the pending here like
                                // every other row-internal button (else a pending
                                // survives and a later click on the same session
                                // spuriously renames).
                                clearPendingClick()
                                setSortMenuOpen(prev => (prev === server.id ? null : server.id))
                              }}
                            >
                              <IconPersonalizationOutline16 size={14} />
                            </button>
                          </Tooltip>
                        )}
                      />
                    )}
                    {server.connected && (server.aggregateError === undefined || search?.expanded === true) && (
                      <Tooltip label={t('action.addWorkspace')} side="bottom" delayMs={500}>
                        <button
                          type="button"
                          className={clsx(cc.actionIcon, cc.addWorkspace)}
                          aria-label={t('action.addWorkspace')}
                          onClick={(event) => {
                            event.stopPropagation()
                            if (suppressClickRef.current) return
                            clearPendingClick()
                            openWorkspaceBrowser(server.id)
                          }}
                        >
                          {/* chamber (design 05 §2.2): adding a WORKSPACE, not a
                              session — the official project-add glyph
                              (IconProjectAddOutline16, vendor ui-primitives
                              icons/index.tsx), not the generic `+`. */}
                          <IconProjectAddOutline16 size={14} />
                        </button>
                      </Tooltip>
                    )}
                    {server.connected && (server.aggregateError === undefined || search?.expanded === true) && (
                      <Tooltip label={t('search.sessions.aria')} side="bottom" delayMs={500}>
                        <button
                          type="button"
                          className={cc.searchButton}
                          aria-label={t('search.sessions.aria')}
                          aria-expanded={search?.expanded === true}
                          ref={searchButton}
                          onClick={(event) => {
                            event.stopPropagation()
                            if (suppressClickRef.current) return
                            clearPendingClick()
                            if (search?.expanded === true) {
                              // Toggle: an open capsule's icon collapses it (empty
                              // query) or just blurs the input (a non-empty query
                              // must not silently drop the in-progress filter).
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
                          <IconSearchOutline16 size={14} />
                        </button>
                      </Tooltip>
                    )}
                    {/* chamber (design 24 §6): server-row
                        "archive manager" — same hover-reveal discipline and
                        gating as the sibling actions; opens the manager
                        dialog (list + per-row / multi-select delete; whole-set
                        deletion only via explicit select-all — no standalone
                        delete-all). All cleanup state lives INSIDE the
                        dialog. */}
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
                          <IconTrashOutline16 size={14} />
                        </button>
                      </Tooltip>
                    )}
                  </span>
                </header>
                {/* 两种"数据不可信"
                    状态就地说明——避免托管 dsh 停机时只剩"空面板 + 红点"，
                    以及把 unary 兜底的降级列表当真实列表读。状态词复用既有
                    `status.*` 文案，不引入新词。 */}
                {/* 缺口说明是这条 live region 的一个分支；但**活动来源**（本壳就是它的
                    侧栏）的同一事实已由框架面的 `.boot-gap` 横幅以 role="status" 播报，
                    再播一次就是同一件事说两遍。故仅对"自己这一行"的缺口说明把区域降为
                    aria-live="off"（文本仍可被浏览/读屏逐行读到，视觉警示不变）；
                    其它行的缺口仍要播报——那些来源没有横幅，侧栏是唯一用户面。 */}
                <div
                  id={sourceNoteId}
                  className={clsx(cc.sourceNote, noteIsBootGap && cc.sourceNoteBootGap)}
                  role="status"
                  aria-live={noteIsBootGap && server.id === chamberInstanceId ? 'off' : 'polite'}
                >
                  {sourceNote}
                </div>
                {/* chamber (打开失败可见性): with the source folded no session
                    row exists on screen (the fold gate hides the whole list),
                    so open failures hoist under the header — the header is
                    the one part that stays rendered. */}
                {sourceFolded && serverOpenFailures.map(failure => (
                  <div key={failure.sessionId} className={cc.rowError} role="alert">{failure.message}</div>
                ))}
    </>
  )
}
