/**
 * Per-source search surface of the ServerSection subtree: the capsule input
 * row and the search-results tree (projection-label / running-bit /
 * active-schedule lookups); the section owns the shared controller mirror.
 */
import { Fragment } from 'react'
import type { RefObject } from 'react'
import clsx from 'clsx'
import { SESSION_SEARCH_RESULT_LIMIT } from '@deepseek-ai/dsh-api-session-controller/client'
import { IconCloseOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChamberServerAggregate } from '@dsh-chamber/dsh-chamber-client-core/aggregate-store'
import type { SearchRow } from '@dsh-chamber/dsh-chamber-client-core/instance-api'
import { openErrorKey } from '@dsh-chamber/dsh-chamber-client-core/open-outcome'
import { clearSearch, setSearchQuery, type SourceSearchState } from '@dsh-chamber/dsh-chamber-client-core/search-state'
import { SEARCH_QUERY_MAX_CODE_UNITS } from '@dsh-chamber/dsh-chamber-client-core/derive'
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
                    // 焦点归属必须事件驱动记录：effect 只在依赖变化时跑，采样到的 activeElement 早已回落。
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
                      // 不用 autoFocus：断连/恢复重挂时它会抢走用户当前焦点；主动展开路径已显式 focus()。
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
                        // 拖拽尾随 click 守卫：dragend 后的合成 click 不得清掉在途搜索。
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
              // 标签来自来源 aggregate（可能比最新快照滞后一轮 poll）；用官方
              // display label——host 读不到标题时渲染目录名。
              const searchRowLabel = (sessionId: string): { title: string; workspaceLabel: string | undefined } => {
                for (const workspace of server.workspaces) {
                  const session = workspace.sessions.find(candidate => candidate.id === sessionId)
                  if (session === undefined) continue
                  return {
                    title: session.displayTitle,
                    workspaceLabel: workspace.ungrouped === true ? t('list.ungrouped') : workspace.title,
                  }
                }
                // 防御：不在任何投影行内的命中仍给诚实标签——官方阶梯最后一级（id）。
                return { title: sessionId, workspaceLabel: undefined }
              }
              // 结果行的 running 位来自投影（visibleIds 过滤保证命中行在投影内，
              // 查不到——防御——回落 false）；运行环 wire 权威，通道 running 不
              // 参与渲染，sessionStateDot/Label 直接用此投影位。
              const projectedRunning = (sessionId: string): boolean => {
                for (const workspace of server.workspaces) {
                  const session = workspace.sessions.find(candidate => candidate.id === sessionId)
                  if (session === undefined) continue
                  return session.running === true
                }
                return false
              }
              // 同一投影查询给 active-Schedule 事实（上游搜索行同样渲染该标记）；
              // 查不到 ⇒ false——不在可见投影内不构成对该会话日程的断言。
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
                            const running = projectedRunning(item.sessionId)
                            const stateDot = sessionStateDot(server, { id: item.sessionId, running })
                            const stateLabel = sessionStateLabel(server, { id: item.sessionId, running })
                            const openError = rowErrors[openErrorKey(server.id, item.sessionId)]
                            return (
                              // 搜索树替换工作区树，打开失败也必须在该结果行下可见；
                              // Fragment 保持 button 可键盘激活（官方同款）。
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
                                      // 空态不注册 live region：role 条件化避免 SR 噪音。
                                      role={stateDot !== null ? 'status' : undefined}
                                    >
                                      {stateDot}
                                    </span>
                                    <span className={cc.searchResultTitle}>{resolved.title}</span>
                                    {/* 上游在标题后、heading 内渲染该标记，本行没有
                                        额外的 blank 门——blank（临时新会话）行已被查询
                                        本身排除在内容搜索外。 */}
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
                        {/* query!=='' 时也在结果下方渲染 aggregateError：结果优先，错误行在下。 */}
                        {server.aggregateError !== undefined && (
                          <div className={cc.aggregateError} role="alert">{server.aggregateError}</div>
                        )}
    </>
  )
}
