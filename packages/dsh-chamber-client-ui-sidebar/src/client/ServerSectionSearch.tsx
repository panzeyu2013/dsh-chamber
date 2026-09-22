/**
 * The per-source search surface of the chamber sidebar ServerSection subtree:
 * the capsule input row and the search-results tree (with the projection-label /
 * running-bit / active-schedule lookups it reads). The section owns the shared
 * search controller mirror and passes the resolved values in.
 */
import { Fragment } from 'react'
import type { RefObject } from 'react'
import clsx from 'clsx'
import { SESSION_SEARCH_RESULT_LIMIT } from '@deepseek-ai/dsh-api-session-controller/client'
import { IconCloseOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChamberServerAggregate } from '../shared/aggregate-store.ts'
import type { SearchRow } from '../shared/instance-api.ts'
import { openErrorKey } from '../shared/open-outcome.ts'
import { clearSearch, setSearchQuery, type SourceSearchState } from '../shared/search-state.ts'
import { SEARCH_QUERY_MAX_CODE_UNITS } from '../shared/derive.ts'
import { SessionScheduleIndicator } from './server-section-controls.tsx'
import { useServerSectionSessionState } from './server-section-session-state.tsx'
import { useSidebarSection } from './sidebar-context.ts'
import cc from './sidebar-chamber.module.css'

export interface ServerSectionSearchCapsuleProps {
  server: ChamberServerAggregate
  search: SourceSearchState | undefined
  searchRoot: RefObject<HTMLDivElement | null>
  searchInput: RefObject<HTMLInputElement | null>
  capsuleHeldFocus: RefObject<boolean>
}

export function ServerSectionSearchCapsule({ server, search, searchRoot, searchInput, capsuleHeldFocus }: ServerSectionSearchCapsuleProps) {
  const { t, suppressClickRef } = useSidebarSection()
  return (
                  <div
                    ref={searchRoot}
                    className={cc.searchCapsule}
                    // 焦点归属必须**事件驱动**记录：effect 只在依赖变化时跑，采样
                    // 到的 activeElement 早已回落。
                    onFocusCapture={() => { capsuleHeldFocus.current = true }}
                    onBlurCapture={() => { capsuleHeldFocus.current = false }}
                  >
                    <input
                      ref={searchInput}
                      className={cc.searchInput}
                      type="text"
                      maxLength={SEARCH_QUERY_MAX_CODE_UNITS}
                      placeholder={t('search.placeholder')}
                      value={search?.query ?? ''}
                      // 不用 autoFocus：胶囊会因断连/恢复而卸载重挂，autoFocus
                      // 会在恢复时抢走用户当前焦点；用户主动展开的那条路径已由
                      // 搜索按钮显式 focus()。
                      onChange={(event) => setSearchQuery(server.id, event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key !== 'Escape') return
                        clearSearch(server.id)
                      }}
                    />
                    <button
                      type="button"
                      className={cc.searchClear}
                      aria-label={t('search.clear')}
                      onClick={() => {
                        // 拖拽尾随 click 守卫——dragend 后的合成 click
                        // 落在清除钮上不得清掉在途搜索（守卫控件清单补齐）。
                        if (suppressClickRef.current) return
                        clearSearch(server.id)
                      }}
                    >
                      <IconCloseOutline16 size={12} />
                    </button>
                  </div>
  )
}

export interface ServerSectionSearchResultsProps {
  server: ChamberServerAggregate
  merged: { items: SearchRow[]; hasMore: boolean }
  currentRemote: { status: 'idle' | 'loading' | 'ready' | 'error' }
  currentId: string | undefined
}

export function ServerSectionSearchResults({ server, merged, currentRemote, currentId }: ServerSectionSearchResultsProps) {
  const { t, rowErrors, openSession } = useSidebarSection()
  const { sessionStateLabel, sessionStatePending, sessionStateDot } = useServerSectionSessionState()
              // Search-result labels resolve from the source aggregate (title
              // may lag the latest snapshot by one poll — accepted, 06 §1.2).
              // The official display label, not the durable title: a hit
              // whose title the host could not read renders the directory name.
              const searchRowLabel = (sessionId: string): { title: string; workspaceLabel: string | undefined } => {
                for (const workspace of server.workspaces) {
                  const session = workspace.sessions.find(candidate => candidate.id === sessionId)
                  if (session === undefined) continue
                  return {
                    title: session.displayTitle,
                    workspaceLabel: workspace.ungrouped === true ? t('list.ungrouped') : workspace.title,
                  }
                }
                // Defensive: a hit outside every projected row still has an
                // honest label — the official ladder's last resort (id).
                return { title: sessionId, workspaceLabel: undefined }
              }
              // 搜索结果行的 running 位来自投影（mergeSearchResults
              // 的 visibleIds 过滤保证命中行一定在投影内，查得到即用投影位；查
              // 不到——防御——回落 false）。通道 running 不参与渲染（运行环
              // wire 权威,见 sessionStateLabel 注释）——sessionStateDot/Label
              // 直接使用此投影位。
              const projectedRunning = (sessionId: string): boolean => {
                for (const workspace of server.workspaces) {
                  const session = workspace.sessions.find(candidate => candidate.id === sessionId)
                  if (session === undefined) continue
                  return session.running === true
                }
                return false
              }
              // The same projection lookup for
              // the active-Schedule fact — upstream's search row renders the
              // marker too (vendor ui-workspace Rows.tsx:351). Not found ⇒
              // false (defensive: a hit outside the visible projection is not a
              // claim about that session's schedules).
              const projectedHasActiveSchedule = (sessionId: string): boolean => {
                for (const workspace of server.workspaces) {
                  const session = workspace.sessions.find(candidate => candidate.id === sessionId)
                  if (session === undefined) continue
                  return session.hasActiveSchedule === true
                }
                return false
              }
  return (
    <>
                        <div className={cc.searchResults} role="tree" aria-label={t('search.results.aria')}>
                          {merged.items.map((item) => {
                            const resolved = searchRowLabel(item.sessionId)
                            // 搜索行传投影 running 位（查不到回落
                            // false）；运行环 wire 权威——sessionStateDot/Label
                            // 直接使用此位,通道 running 不参与渲染（见
                            // sessionStateLabel 注释）。
                            const running = projectedRunning(item.sessionId)
                            const stateDot = sessionStateDot(server, { id: item.sessionId, running })
                            const stateLabel = sessionStateLabel(server, { id: item.sessionId, running })
                            const openError = rowErrors[openErrorKey(server.id, item.sessionId)]
                            return (
                              // chamber (打开失败可见性): the search tree replaces
                              // the workspace tree, so an open failure must also
                              // surface under the result row — Fragment keeps the
                              // button keyboard-activatable (official
                              // SearchResultItem 同款).
                              <Fragment key={item.sessionId}>
                                <button
                                  type="button"
                                  className={cc.searchResultRow}
                                  role="treeitem"
                                  aria-selected={item.sessionId === currentId}
                                  onClick={() => openSession(server.id, item.sessionId)}
                                >
                                  <span className={cc.searchResultHeading}>
                                    <span
                                      className={clsx(cc.sessionStateSlot, sessionStatePending(server, { id: item.sessionId }) !== undefined && cc.sessionStateSlotPending)}
                                      title={stateLabel}
                                      aria-label={stateLabel}
                                      // 空态不注册 live region（官方仅在有
                                      // 状态时放隐藏标签）——role 条件化避免 SR 噪音。
                                      role={stateDot !== null ? 'status' : undefined}
                                    >
                                      {stateDot}
                                    </span>
                                    <span className={cc.searchResultTitle}>{resolved.title}</span>
                                    {/* Upstream's
                                        search row carries the marker right after
                                        the title, inside the heading (vendor
                                        ui-workspace Rows.tsx:351), fed by
                                        tree.ts:161-163. This row applies NO blank gate
                                        of its own — the projection helper
                                        (`projectedHasActiveSchedule`) is the only
                                        gate, and it is false for a session the
                                        projection does not list. Upstream's
                                        SearchResultItem has no blank gate either
                                        and SearchResultNode carries no `blank`
                                        field: blank (provisional new-session)
                                        rows are excluded from content search by
                                        the query itself (vendor tree.ts:156-159),
                                        so there is nothing to gate here. */}
                                    {projectedHasActiveSchedule(item.sessionId) && (
                                      <SessionScheduleIndicator label={t('schedule.active')} />
                                    )}
                                  </span>
                                  {resolved.workspaceLabel !== undefined && (
                                    <span className={cc.searchResultWorkspace}>{resolved.workspaceLabel}</span>
                                  )}
                                  {item.snippet !== '' && (
                                    <span className={cc.searchResultSnippet}>{item.snippet}</span>
                                  )}
                                </button>
                                {openError !== undefined && (
                                  <div className={clsx(cc.rowError, cc.sessionNested)} role="alert">{openError}</div>
                                )}
                              </Fragment>
                            )
                          })}
                          {currentRemote.status === 'loading' && (
                            <div className={cc.searchStatus} role="status">{t('search.pending')}</div>
                          )}
                          {currentRemote.status === 'error' && (
                            <div className={cc.searchWarning} role="status">{t('search.unavailable')}</div>
                          )}
                          {currentRemote.status !== 'loading' && merged.items.length === 0 && (
                            <div className={cc.empty}>{t('search.noMatches')}</div>
                          )}
                          {merged.hasMore && (
                            <div className={cc.searchStatus}>
                              {t('search.hasMore', { n: SESSION_SEARCH_RESULT_LIMIT })}
                            </div>
                          )}
                        </div>
                        {/* 搜索进行中（query!==''）也在结果下方渲染
                            aggregateError——结果优先，错误行在下面，与顶部
                            注释声称的行为一致。 */}
                        {server.aggregateError !== undefined && (
                          <div className={cc.aggregateError} role="alert">{server.aggregateError}</div>
                        )}
    </>
  )
}
