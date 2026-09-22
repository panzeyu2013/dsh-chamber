/**
 * Sidebar projection wiring: the chamberBridge subscription with its
 * rendered-signature dedupe, the shared view-prefs mirror, the per-source
 * order state and the two override reconciliation effects. Nothing here is
 * presentational.
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { chamberBridge, type ChamberServerAggregate } from '../shared/aggregate-store.ts'
import { nextUpdatedOrder, orderServersForDisplay, serversProjectionSignature, type SessionOrderBy } from '../shared/derive.ts'
import {
  clearSourceBookkeeping, flushScheduledActivityWrites, getViewPrefs, scheduleUpdatedOrderWrite,
  subscribeViewPrefs, updateViewPrefs, type ChamberSidebarViewPrefs,
} from '../shared/view-prefs.ts'
import { getWorkspaceGitFlagsVersion, subscribeWorkspaceGitFlags } from '../shared/workspace-git-flags.ts'

export function useSidebarProjection() {
  // chamber: the multi-source projection (05 §3) — the App layer publishes
  // it on its poll cycle (signature-gated, see App.tsx); this shell just
  // subscribes and re-renders. Defense in depth: the subscription re-checks
  // the render-relevant signature before setState, so even an ungated
  // publisher can never make this list re-render on unchanged content
  // (mirrors the settings bridge's subscribeServers dedupe).
  // The dedupe baseline is the CURRENTLY RENDERED state (mirrored in a ref,
  // not getServers()): a publish landing in the window between useState's
  // initializer and this effect's subscribe would otherwise be treated as
  // "already seen" (its signature would match the post-publish getServers())
  // and the list would stay stale forever — the App's publish gate never
  // re-emits unchanged content, so there would be no later self-heal.
  // Comparing against the rendered state makes that first mid-window publish
  // apply, while identical content stays a no-op.
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

  // chamber (08 §11): re-render when the git plugin publishes per-workspace
  // flags (worktree fold-button swap / create-from-main gating). The flags
  // store's MONOTONIC VERSION is the snapshot: a store change re-renders — a
  // constant snapshot would never trigger React.
  useSyncExternalStore(subscribeWorkspaceGitFlags, getWorkspaceGitFlagsVersion, getWorkspaceGitFlagsVersion)

  // chamber (06 §3 — cross-ctx live sync): view preferences (folded
  // workspace groups + the ungrouped session order) live in ONE shared
  // in-memory store (shared/view-prefs.ts) backed by localStorage. Every ctx's
  // sidebar reads the same store instance (vite shared chunk), so a fold
  // toggle in ANY source's sidebar propagates live to every other source's
  // sidebar — no per-ctx stale copy, no write-back resurrecting another ctx's
  // newer state. Writes persist + notify all subscribers; this component just
  // mirrors the store into local state for rendering.
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

  // chamber (06 §2.4): server-level fold — collapses the source's ENTIRE
  // workspace list (all workspace groups hidden). Deliberately a SEPARATE
  // preference from per-workspace `folded`: collapsing the server must NOT
  // fold each workspace's conversations, so expanding the server restores
  // every workspace with its sessions exactly as they were (user rule: 不要
  // 折叠 workspace 中的对话). Expanding the LAST folded source deletes the
  // field entirely — no permanent empty-object key in the persisted prefs.
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

  // chamber (06 §2.4): the server groups render in the user's persisted
  // display order when one exists (local view preference only — the App's
  // N-ctx residency/prewarm order and the instance registry are untouched;
  // navigation is id-keyed). The rail dots share the same order so both
  // views agree.
  const orderedServers = useMemo(
    () => orderServersForDisplay(servers, viewPrefs.serverOrder),
    [servers, viewPrefs.serverOrder],
  )

  // chamber (06 §3.1): explicit per-source sort selection through the
  // source-header menu (official ViewOptionsMenu pattern). The choice lives
  // in the shared view prefs (`orderBy` keyed by sourceId, default manual).
  // Entering updated clears the source's activity BOOKKEEPING
  // (sessionUpdatedAtByAccount) so the derivation effect below does ONE full
  // recency sort (official switchedToUpdated) while keeping the existing
  // updatedOrder accounts (re-entry re-sorts them). The source's transient
  // session-order overrides are dropped either way: entering updated renders
  // the account order — an in-flight manual wire commit is only reflected if
  // it lands before the next projection; entering manual restores wire order.
  const setOrderBy = (server: ChamberServerAggregate, mode: SessionOrderBy): void => {
    if ((viewPrefs.orderBy?.[server.id] ?? 'manual') === mode) return
    // 先终刷防抖窗内 pending 的 promotion 簿记再落盘——否则窗末 flush 会把
    // 刚被清掉的簿记重新合并回去，一次性全量 recency 排序被跳过。
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

  // chamber (06 §2.2): transient optimistic order overrides, applied at
  // render over the projection while the wire commit is in flight. Cleared
  // PER KEY against each fresh projection — never wholesale: a poll that has
  // not yet seen the commit must not flash the optimistic order back (a
  // manual-mode override drops only when the confirming pull proves the
  // commit). A key drops when its workspace vanished, the projection order
  // now equals the override (commit confirmed), or the membership differs
  // (a row was deleted meanwhile); it survives while only the ORDER differs
  // (stale poll data). Overrides are MANUAL-mode only —
  // updated-mode drags write the shared updatedOrder account (见
  // commitSessionDrag) instead, so this map never carries an unconfirmable
  // entry; the updated-branch drop below stays as hygiene for a source
  // switched to updated while an override was still in flight.
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
        // Hygiene: an override left over from a source that has since
        // switched to updated is dropped — updated mode renders the account
        // order, never this map (setOrderBy drops the source's in-flight
        // overrides at switch time); manual mode still reconciles against
        // the wire confirmation.
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

  // chamber (06 §3.1 — updated = manual + activity
  // promotion): per-account updated-mode order derivation, the official
  // ui-workspace nextSessionOrderAccount port. Runs on every projection /
  // view-prefs change and writes the promoted account orders + activity
  // bookkeeping through the SHARED view-prefs store, diff-guarded: an
  // unchanged account never triggers a notify → re-render → effect loop, and
  // every shell converges on the same accounts. The recency-sort trigger
  // (no bookkeeping) = first observation OR the user just picked 最近更新 in
  // the sort menu (setOrderBy clears the source's bookkeeping — official
  // switchedToUpdated). Real workspaces AND the ungrouped bucket are one
  // account each (`${server.id}/${workspace.id}`; the bucket's id is
  // UNGROUPED_WORKSPACE_ID), so the bucket's updated-mode drags and
  // promotions persist in updatedOrder instead of the manual ungroupedOrder.
  // The derivation reads the LIVE shared store (getViewPrefs — the same cache
  // updateViewPrefs mutates), NOT this render's viewPrefs snapshot: the
  // effect can flush after a drag commit or another shell's setOrderBy
  // landed, and a stale-snapshot derivation would silently overwrite the
  // fresher account — a just-committed updated-mode drag, or a cleared
  // bookkeeping (which must not be re-added, or the one-time recency sort on
  // switching to updated would be skipped).
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
    // 置顶写回**防抖**——会话流式更新期间每个投影 tick 都推进 updatedAt，
    // 逐 tick 直写会把整份 prefs 的落盘 + 全壳通知放大到更新频率。派生结果
    // 改经共享固定窗（scheduleUpdatedOrderWrite，view-prefs.ts）按账户合并、
    // 窗末终刷一次；末 tick 自窗基态重派生、结果自洽（与逐 tick 落盘在交错
    // 突发/首观察窗存在排序级差异，无数据丢失）。合并目标仍是 updateViewPrefs
    // 的 prev（共享缓存，非渲染快照）——其它 shell 的落盘不被覆盖；离散写
    // （拖拽/排序切换）写前先 flush，窗末终刷绝不覆盖更新的用户手势。
    for (const [accountKey, order] of Object.entries(pendingOrder)) {
      scheduleUpdatedOrderWrite(accountKey, order, pendingTimestamps[accountKey])
    }
  }, [servers, viewPrefs])
  return {
    servers, viewPrefs, orderedServers, toggleWorkspaceFold, toggleSourceFold, setOrderBy,
    sessionOrderOverride, setSessionOrderOverride, workspaceOrderOverride, setWorkspaceOrderOverride,
  }
}
