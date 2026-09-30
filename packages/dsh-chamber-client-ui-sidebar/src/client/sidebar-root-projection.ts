/**
 * Sidebar projection wiring: the chamberBridge subscription with its
 * rendered-signature dedupe, the shared view-prefs mirror, the per-source
 * order state and the two override reconciliation effects. Nothing here is
 * presentational.
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { chamberBridge, type ChamberServerAggregate } from '@dsh-chamber/dsh-chamber-client-core/aggregate-store'
import { nextUpdatedOrder, orderServersForDisplay, type ArchivedFilter, type SessionGroupBy, type SessionOrderBy } from '@dsh-chamber/dsh-chamber-client-core/derive'
import { flatAccountKey } from '@dsh-chamber/dsh-chamber-client-core/flat-account'
import { cachedServersProjectionSignature } from '@dsh-chamber/dsh-chamber-client-core/projection-signature-cache'
import {
  clearSourceBookkeeping, flushScheduledActivityWrites, getViewPrefs, peekScheduledActivityWrites, scheduleUpdatedOrderWrite,
  subscribeViewPrefs, updateViewPrefs, type ChamberSidebarViewPrefs,
} from '@dsh-chamber/dsh-chamber-client-core/view-prefs'
import { getWorkspaceGitFlagsVersion, subscribeWorkspaceGitFlags } from '@dsh-chamber/dsh-chamber-client-core/workspace-git-flags'

export function useSidebarProjection() {
  // chamber: the multi-source projection, published by the App layer on its
  // poll cycle; this shell subscribes and re-renders. Defense in depth: the
  // subscription re-checks the render-relevant signature before setState, so
  // an ungated publisher cannot re-render on unchanged content.
  // The dedupe baseline is the CURRENTLY RENDERED state (a ref), not
  // getServers(): a publish landing between useState's initializer and the
  // subscribe would otherwise count as "already seen" and the list would stay
  // stale forever — the publish gate never re-emits unchanged content.
  const [servers, setServers] = useState<ChamberServerAggregate[]>(() => chamberBridge.getServers())
  const serversRef = useRef(servers)
  serversRef.current = servers
  useEffect(() => {
    return chamberBridge.subscribe(() => {
      const next = chamberBridge.getServers()
      if (cachedServersProjectionSignature(next) === cachedServersProjectionSignature(serversRef.current)) return
      setServers(next)
    })
  }, [])

  // Re-render when the git plugin publishes per-workspace flags (worktree
  // fold-button swap / create-from-main gating). The flags store's MONOTONIC
  // VERSION is the snapshot: a constant snapshot would never trigger React.
  useSyncExternalStore(subscribeWorkspaceGitFlags, getWorkspaceGitFlagsVersion, getWorkspaceGitFlagsVersion)

  // View preferences (folded groups + ungrouped session order) live in ONE
  // shared in-memory store backed by localStorage; every ctx's sidebar reads
  // the same instance, so a fold toggle in ANY source propagates live to all
  // of them. Writes persist + notify; this component mirrors the store.
  const [viewPrefs, setViewPrefs] = useState<ChamberSidebarViewPrefs>(() => getViewPrefs())
  useEffect(() => subscribeViewPrefs(() => { setViewPrefs(getViewPrefs()) }), [])

  const toggleWorkspaceFold = (serverId: string, workspaceId: string): void => {
    const key = `${serverId}/${workspaceId}`
    updateViewPrefs((prev) => {
      const folded = { ...prev.folded }
      if (folded[key] === true) delete folded[key]
      else folded[key] = true
      return { ...prev, folded }
    })
  }

  // Server-level fold collapses the source's ENTIRE workspace list. It is a
  // SEPARATE preference from per-workspace `folded`: collapsing a server must
  // NOT fold each workspace's conversations, so expanding restores every
  // workspace as it was. Expanding the LAST folded source deletes the field
  // entirely — no permanent empty-object key in the persisted prefs.
  const toggleSourceFold = (serverId: string): void => {
    updateViewPrefs((prev) => {
      const sourceFolded = { ...prev.sourceFolded }
      if (sourceFolded[serverId] === true) {
        delete sourceFolded[serverId]
        if (Object.keys(sourceFolded).length === 0) {
          const next = { ...prev }
          delete next.sourceFolded
          return next
        }
        return { ...prev, sourceFolded }
      }
      sourceFolded[serverId] = true
      return { ...prev, sourceFolded }
    })
  }

  // Server groups render in the persisted display order when one exists (a
  // local view preference only: N-ctx residency/prewarm and the instance
  // registry are untouched, navigation is id-keyed). The rail dots share it.
  const orderedServers = useMemo(
    () => orderServersForDisplay(servers, viewPrefs.serverOrder),
    [servers, viewPrefs.serverOrder],
  )

  // Explicit per-source sort selection through the source-header menu; the
  // choice lives in the shared view prefs (`orderBy` keyed by sourceId,
  // default manual). Entering updated clears the source's activity
  // bookkeeping so the derivation below does ONE full recency sort while
  // keeping the existing updatedOrder accounts; the source's transient
  // session-order overrides are dropped either way (updated renders the
  // account order, manual restores wire order).
  const setOrderBy = (server: ChamberServerAggregate, mode: SessionOrderBy): void => {
    if ((viewPrefs.orderBy?.[server.id] ?? 'manual') === mode) return
    // 先终刷防抖窗内 pending 的 promotion 簿记再落盘——否则窗末 flush 会把刚被清掉的簿记重新合并回去，跳过一次性全量 recency 排序。
    flushScheduledActivityWrites()
    updateViewPrefs(prev => {
      const orderBy = { ...prev.orderBy, [server.id]: mode }
      if (mode !== 'updated') return { ...prev, orderBy }
      const cleared = clearSourceBookkeeping(prev.sessionUpdatedAtByAccount, server.id)
      return cleared === prev.sessionUpdatedAtByAccount
        ? { ...prev, orderBy }
        : { ...prev, orderBy, sessionUpdatedAtByAccount: cleared }
    })
    const prefix = `${server.id}/`
    setSessionOrderOverride(prev => {
      const hasAny = Object.keys(prev).some(key => key.startsWith(prefix))
      if (!hasAny) return prev
      const nextOverrides: Record<string, string[]> = {}
      for (const [key, override] of Object.entries(prev)) {
        if (key.startsWith(prefix)) continue
        nextOverrides[key] = override
      }
      return nextOverrides
    })
  }

  // 视图选项另外两轴（design 06 §3.4）：分组与归档筛选。都是 per-source 纯偏好
  // 写入（无 wire、无簿记）；flat 账号的 seed 与对账在渲染/拖拽侧按需进行。
  // 归档集未知（archiveSetKnown !== true）时本函数仍照常写入：存储值保留，禁用与
  // 默认渲染是菜单/渲染侧的规则（design 06 §3.4）。
  const setGroupBy = (server: ChamberServerAggregate, mode: SessionGroupBy): void => {
    if ((viewPrefs.groupBy?.[server.id] ?? 'workspace') === mode) return
    updateViewPrefs(prev => ({ ...prev, groupBy: { ...prev.groupBy, [server.id]: mode } }))
  }
  const setArchivedFilter = (server: ChamberServerAggregate, filter: ArchivedFilter): void => {
    if ((viewPrefs.archivedFilter?.[server.id] ?? 'default') === filter) return
    updateViewPrefs(prev => ({ ...prev, archivedFilter: { ...prev.archivedFilter, [server.id]: filter } }))
  }

  // Transient optimistic order overrides, applied at render while the wire
  // commit is in flight. Cleared PER KEY against each fresh projection — never
  // wholesale: a poll that has not seen the commit must not flash the old order
  // back, and the override drops only when workspace vanished / order equals /
  // membership differs (surviving while only the ORDER differs = stale poll).
  // MANUAL mode only: updated-mode drags write the shared updatedOrder account.
  const [sessionOrderOverride, setSessionOrderOverride] = useState<Record<string, string[]>>({})
  const [workspaceOrderOverride, setWorkspaceOrderOverride] = useState<Record<string, string[]>>({})
  useEffect(() => {
    const serversById = new Map(servers.map(server => [server.id, server]))
    setSessionOrderOverride(prev => {
      let changed = false
      const next: Record<string, string[]> = {}
      for (const [key, override] of Object.entries(prev)) {
        const slash = key.indexOf('/')
        const server = serversById.get(key.slice(0, slash))
        const workspace = server === undefined
          ? undefined
          : server.workspaces.find(candidate => candidate.id === key.slice(slash + 1))
        const wireIds = workspace === undefined ? undefined : workspace.sessions.map(session => session.id)
        // Hygiene: an override left over from a source since switched to
        // updated is dropped — updated renders the account order, never this map.
        if (server !== undefined && (viewPrefs.orderBy?.[server.id] ?? 'manual') === 'updated') {
          changed = true
          continue
        }
        const orderEqual = wireIds !== undefined
          && wireIds.length === override.length
          && wireIds.every((id, index) => override[index] === id)
        const membershipEqual = wireIds !== undefined
          && wireIds.length === override.length
          && override.every(id => wireIds.includes(id))
        if (wireIds === undefined || orderEqual || !membershipEqual) {
          changed = true
          continue
        }
        next[key] = override
      }
      return changed ? next : prev
    })
    setWorkspaceOrderOverride(prev => {
      let changed = false
      const next: Record<string, string[]> = {}
      for (const [sourceId, override] of Object.entries(prev)) {
        const server = serversById.get(sourceId)
        const wireIds = server === undefined
          ? undefined
          : server.workspaces.filter(workspace => workspace.ungrouped !== true && workspace.synthetic !== true)
            .map(workspace => workspace.id)
        const orderEqual = wireIds !== undefined
          && wireIds.length === override.length
          && wireIds.every((id, index) => override[index] === id)
        const membershipEqual = wireIds !== undefined
          && wireIds.length === override.length
          && override.every(id => wireIds.includes(id))
        if (wireIds === undefined || orderEqual || !membershipEqual) {
          changed = true
          continue
        }
        next[sourceId] = override
      }
      return changed ? next : prev
    })
    // 卫生扫描读 viewPrefs.orderBy（跨 shell 切到 updated 时立即清 manual override），
    // 故它也是依赖：只等下一次 servers 发布可能永远等不到（安静来源）。
  }, [servers, viewPrefs.orderBy])

  // Per-account updated-mode order derivation (official nextSessionOrderAccount
  // port), written through the SHARED view-prefs store, diff-guarded: an
  // unchanged account never triggers notify → re-render → effect loops, and
  // every shell converges. The recency sort triggers on first observation or a
  // switch to updated (setOrderBy clears the source's bookkeeping). Real
  // workspaces AND the ungrouped bucket are one account each. It reads the LIVE
  // shared store, not this render's snapshot: a stale snapshot would overwrite a
  // just-committed drag or a cleared bookkeeping (which must not be re-added).
  useEffect(() => {
    const current = getViewPrefs()
    const pendingOrder: Record<string, string[]> = {}
    const pendingTimestamps: Record<string, Record<string, number>> = {}
    // 账号写入的统一计划（workspace 账号与 flat 账号同一条规则）。归档筛选会让隐藏行离开成员集：
    // 若把它的 updatedAt 记账一并丢掉，重新显示（show/only 切换）会被当成"首次观测"重新置顶——
    // 只保留**仍在归档集**的隐藏 id（第四轮 F2：不再无界保留被删除的 id），于是再次曝光不触发
    // 提升，而清理/删除过的 id 自然离开。合并后的记账与 stored 序都没变就返回 undefined 让调用方
    // 跳过排写（否则 carried 会让 changed 永久为真，每个投影 tick 都排一次空写；第四轮 F9）。
    // 判等对象 = pending intent（若有）优先于缓存：否则旧 pending 写会在窗末覆盖本次跳过的新派生
    // 态（第四轮 correctness finding 2）。
    const planUpdatedCommit = (
      accountKey: string,
      next: ReturnType<typeof nextUpdatedOrder>,
      archivedSessions: ChamberServerAggregate['archivedSessions'],
    ): { order: string[]; timestamps: Record<string, number> } | undefined => {
      if (!next.changed) return undefined
      const archivedIds = new Set((archivedSessions ?? []).map(row => row.sessionId))
      const priorTs = current.sessionUpdatedAtByAccount?.[accountKey] ?? {}
      const carried: Record<string, number> = {}
      for (const [id, ts] of Object.entries(priorTs)) {
        if (!(id in next.updatedAt) && archivedIds.has(id)) carried[id] = ts
      }
      const mergedTs = { ...next.updatedAt, ...carried }
      const pendingIntent = peekScheduledActivityWrites()
      const priorOrder = pendingIntent.updatedOrder[accountKey] ?? current.updatedOrder?.[accountKey] ?? []
      const priorTsForCompare = pendingIntent.sessionUpdatedAtByAccount[accountKey] ?? priorTs
      const tsEqual = Object.keys(mergedTs).length === Object.keys(priorTsForCompare).length
        && Object.entries(mergedTs).every(([id, ts]) => priorTsForCompare[id] === ts)
      const orderEqual = next.order.length === priorOrder.length
        && next.order.every((id, index) => priorOrder[index] === id)
      if (tsEqual && orderEqual) return undefined
      return { order: next.order, timestamps: mergedTs }
    }
    for (const server of servers) {
      if (current.orderBy?.[server.id] !== 'updated') continue
      for (const workspace of server.workspaces) {
        const sessionIds = workspace.sessions.map(session => session.id)
        if (sessionIds.length === 0) continue
        const accountKey = `${server.id}/${workspace.id}`
        const next = nextUpdatedOrder({
          sessionIds,
          stored: current.updatedOrder?.[accountKey],
          previousUpdatedAt: current.sessionUpdatedAtByAccount?.[accountKey],
          byId: new Map(workspace.sessions.map(session => [session.id, session])),
        })
        const planned = planUpdatedCommit(accountKey, next, server.archivedSessions)
        if (planned === undefined) continue
        pendingOrder[accountKey] = planned.order
        pendingTimestamps[accountKey] = planned.timestamps
      }
      // 单列表账号的 updated 序（仅该来源处于 flat 模式时维护）：成员集 = 全部可见行。
      // 与各组 account 同一条 nextUpdatedOrder 推导与同一防抖写回。
      if ((current.groupBy?.[server.id] ?? 'workspace') === 'flat') {
        const flatSessions = server.workspaces.flatMap(workspace => workspace.sessions)
        if (flatSessions.length > 0) {
          const accountKey = flatAccountKey(server.id)
          const next = nextUpdatedOrder({
            sessionIds: flatSessions.map(session => session.id),
            stored: current.updatedOrder?.[accountKey],
            previousUpdatedAt: current.sessionUpdatedAtByAccount?.[accountKey],
            byId: new Map(flatSessions.map(session => [session.id, session] as const)),
          })
          const planned = planUpdatedCommit(accountKey, next, server.archivedSessions)
          if (planned !== undefined) {
            pendingOrder[accountKey] = planned.order
            pendingTimestamps[accountKey] = planned.timestamps
          }
        }
      }
    }
    if (Object.keys(pendingOrder).length === 0 && Object.keys(pendingTimestamps).length === 0) return
    // 置顶写回防抖：会话流式更新期间每个投影 tick 都推进 updatedAt，逐 tick
    // 直写会把落盘 + 全壳通知放大到更新频率。派生结果改经共享固定窗
    // （scheduleUpdatedOrderWrite）按账户合并、窗末终刷一次；合并目标是
    // updateViewPrefs 的 prev（共享缓存，非渲染快照），离散写前先 flush，
    // 窗末终刷不覆盖更新的用户手势。
    for (const [accountKey, order] of Object.entries(pendingOrder)) {
      scheduleUpdatedOrderWrite(accountKey, order, pendingTimestamps[accountKey])
    }
  }, [servers, viewPrefs])
  return {
    servers, viewPrefs, orderedServers, toggleWorkspaceFold, toggleSourceFold, setOrderBy, setGroupBy, setArchivedFilter,
    sessionOrderOverride, setSessionOrderOverride, workspaceOrderOverride, setWorkspaceOrderOverride,
  }
}
