/**
 * Sidebar projection wiring: the chamberBridge subscription with its
 * rendered-signature dedupe, the shared view-prefs mirror, the per-source
 * order state and the two override reconciliation effects. Nothing here is
 * presentational.
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { chamberBridge, type ChamberServerAggregate } from '@dsh-chamber/dsh-chamber-client-core/aggregate-store'
import { nextUpdatedOrder, orderServersForDisplay, serversProjectionSignature, type SessionOrderBy } from '@dsh-chamber/dsh-chamber-client-core/derive'
import {
  clearSourceBookkeeping, flushScheduledActivityWrites, getViewPrefs, scheduleUpdatedOrderWrite,
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
      if (serversProjectionSignature(next) === serversProjectionSignature(serversRef.current)) return
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
  }, [servers])

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
        if (!next.changed) continue
        pendingOrder[accountKey] = next.order
        pendingTimestamps[accountKey] = next.updatedAt
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
    servers, viewPrefs, orderedServers, toggleWorkspaceFold, toggleSourceFold, setOrderBy,
    sessionOrderOverride, setSessionOrderOverride, workspaceOrderOverride, setWorkspaceOrderOverride,
  }
}
