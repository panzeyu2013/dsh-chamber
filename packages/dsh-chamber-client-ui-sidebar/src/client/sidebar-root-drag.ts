/** In-source drag state machines and their commit helpers: session/workspace/
 *  server drags, native drag acceptance, trailing-click guards, wire commits. */

import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { chamberBridge, type ChamberServerAggregate } from '@dsh-chamber/dsh-chamber-client-core/aggregate-store'
import { nextServerOrder, orderServersForDisplay, reconciledSessionOrder } from '@dsh-chamber/dsh-chamber-client-core/derive'
import { getInstanceClient, insertSessionBefore, insertWorkspaceBefore } from '@dsh-chamber/dsh-chamber-client-core/instance-api'
import { flatAccountKey } from '@dsh-chamber/dsh-chamber-client-core/flat-account'
import { flushScheduledActivityWrites, getViewPrefs, updateViewPrefs, type ChamberSidebarViewPrefs } from '@dsh-chamber/dsh-chamber-client-core/view-prefs'
import { resolveWorkspaceDrop } from '@dsh-chamber/dsh-chamber-client-core/workspace-drag-order'
import {
  orderWithOverride, workspaceDropEnv, type ServerDragState, type SessionDragState, type WorkspaceDragState,
} from './sidebar-context.ts'
import type { RunAction } from './sidebar-root-actions.ts'

/**
 * Accept the native drag at document level while any row drag is active: row
 * hover still owns the insertion marker, and a release outside the list must not
 * render as a rejected drop before dragend commits that marker.
 */
function useNativeDragAcceptance(active: boolean): void {
  useEffect(() => {
    if (!active) return
    const acceptDrag = (event: DragEvent): void => {
      event.preventDefault()
      if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'move'
    }
    const acceptDrop = (event: DragEvent): void => { event.preventDefault() }
    document.addEventListener('dragover', acceptDrag)
    document.addEventListener('drop', acceptDrop)
    return () => {
      document.removeEventListener('dragover', acceptDrag)
      document.removeEventListener('drop', acceptDrop)
    }
  }, [active])
}

export function useSidebarDrags({ servers, viewPrefs, sessionOrderOverride, setSessionOrderOverride, workspaceOrderOverride, setWorkspaceOrderOverride, runAction }: {
  servers: readonly ChamberServerAggregate[]
  viewPrefs: ChamberSidebarViewPrefs
  sessionOrderOverride: Readonly<Record<string, string[]>>
  setSessionOrderOverride: Dispatch<SetStateAction<Record<string, string[]>>>
  workspaceOrderOverride: Readonly<Record<string, string[]>>
  setWorkspaceOrderOverride: Dispatch<SetStateAction<Record<string, string[]>>>
  runAction: RunAction
}) {
  // In-source drag state: cross-source drops are structurally impossible (every
  // target handler is gated on the drag's sourceId matching the hovered group).
  const [sessionDrag, setSessionDrag] = useState<SessionDragState | null>(null)
  const [workspaceDrag, setWorkspaceDrag] = useState<WorkspaceDragState | null>(null)
  // Server-group drag state (display-order preference only; commit writes view-prefs, no wire).
  const [serverDrag, setServerDrag] = useState<ServerDragState | null>(null)
  const sessionDropCommitted = useRef(false)
  const workspaceDropCommitted = useRef(false)
  const serverDropCommitted = useRef(false)
  /** Per-source tail of workspace ORDER commits: overlapping family-block moves
   *  must not interleave their per-member wire inserts on the host. */
  const orderCommitTail = useRef(new Map<string, Promise<void>>())
  // A trailing `click` after an aborted drag/drop would open the session the row
  // no longer represents; the flag is set on dragstart, cleared after dragend.
  const suppressClickRef = useRef(false)
  // Whether the CURRENT press started on a header BUTTON: dragstart's `target` is
  // the drag SOURCE (the header), not the pressed element, so the press target is
  // recorded on pointerdown — a gesture begun on a button must never initiate a
  // header drag (a >4px micro-drag on the fold toggle would swallow its click).
  const dragPressOnButtonRef = useRef(false)
  useNativeDragAcceptance(sessionDrag !== null || workspaceDrag !== null || serverDrag !== null)

  // 看门狗：拖拽期间源从投影消失 / 断连（行卸载、外部归档、来源停机）时，dragend 可能落在
  // 已卸载的源节点上而不达 React 的根代理处理器——拖拽态与 suppressClickRef 会永久悬留，
  // 侧栏所有受保护点击被静音。投影变化即清（含点击抑制的兜底清）。
  useEffect(() => {
    const sourceAlive = (sourceId: string): boolean =>
      servers.some(server => server.id === sourceId && server.connected === true)
    // 实体级：源健康但**被拖的行/工作区**已离开投影（外部归档、推送刷新、行卸载）同样算丢——
    // 否则 dragend 不达 React 时点击抑制会永久卡死（第四轮 medium）。
    const sessionAlive = (drag: SessionDragState): boolean =>
      sourceAlive(drag.sourceId)
      && (servers.find(server => server.id === drag.sourceId)?.workspaces
        .some(workspace => workspace.sessions.some(session => session.id === drag.sessionId)) ?? false)
    const workspaceAlive = (drag: WorkspaceDragState): boolean =>
      sourceAlive(drag.sourceId)
      && (servers.find(server => server.id === drag.sourceId)?.workspaces
        .some(workspace => workspace.id === drag.workspaceId) ?? false)
    const lost = (sessionDrag !== null && !sessionAlive(sessionDrag))
      || (workspaceDrag !== null && !workspaceAlive(workspaceDrag))
      || (serverDrag !== null && !sourceAlive(serverDrag.sourceId))
    if (!lost) return
    suppressClickRef.current = false
    setSessionDrag(null)
    setWorkspaceDrag(null)
    setServerDrag(null)
  }, [servers, sessionDrag, workspaceDrag, serverDrag])

  // While a SERVER drag is active, a pointer outside every source section clears
  // the marker — releasing outside cancels instead of committing the last one.
  // Session/workspace drags keep release-outside-commits; a whole-group move's
  // blast radius warrants the stricter rule.
  useEffect(() => {
    if (serverDrag === null) return
    const clearMarkerOutsideSections = (event: DragEvent): void => {
      if (!(event.target instanceof Element)) return
      if (event.target.closest('[data-chamber-section]') !== null) return
      setServerDrag(current => (current === null || current.over === null ? current : { ...current, over: null }))
    }
    document.addEventListener('dragover', clearMarkerOutsideSections)
    return () => document.removeEventListener('dragover', clearMarkerOutsideSections)
  }, [serverDrag === null])

  // Session-row drag commit. The anchor resolves from the CURRENT rendered order
  // (updated = the shared account order, manual = override-first), never the
  // projection. Updated mode persists into the account order (no wire — 「updated
  // 下拖拽只落 account」); manual mode persists the ungrouped bucket via view prefs
  // and real workspaces over the wire with an optimistic override.
  const commitSessionDrag = (
    server: ChamberServerAggregate,
    activeDrag: SessionDragState,
    over: NonNullable<SessionDragState['over']>,
  ): void => {
    if (sessionDropCommitted.current) return
    // 置顶门（选项1，提交侧防御）：置顶块内拖拽/跨块守卫未实现，任何涉及置顶行的提交都
    // 必须落空——显示序是分区后的，未分区的锚点会算出反向位置并写进账号/wire。
    const allSessions = server.workspaces.flatMap(workspace => workspace.sessions)
    const targetSession = allSessions.find(candidate => candidate.id === over.id)
    const sourceSession = allSessions.find(candidate => candidate.id === activeDrag.sessionId)
    // 源与目标的**当前** pinned 都重读（拖拽中途被别的 shell 置顶时同样落空；上游 Rows/WorkspaceBrowser
    // 同规则），dragstart 快照只作兜底。
    if (activeDrag.pinned || sourceSession?.pinned === true || targetSession?.pinned === true) return
    // blank 落点半边归一（上游：blank 目标一律 after）。
    const half: 'before' | 'after' = targetSession?.blank === true ? 'after' : over.half
    const overTarget = { id: over.id, half }
    sessionDropCommitted.current = true
    setSessionDrag(null)
    // 单列表账号：没有 workspace 行可解析；顺序只落本地账号（manual → flatOrder，
    // updated → flatAccountKey(sourceId) 哨兵账号），不发 wire（上游 flat 账号同规则）。
    if (activeDrag.flat) {
      const orderBy = viewPrefs.orderBy?.[server.id] ?? 'manual'
      // 成员序与渲染侧同一规则（override-aware orderedWorkspaces + 未分组桶尾）：否则有
      // 工作区序 override 时锚点会算在不同列表上，持久化错误的平铺序（第四轮 F3）。
      const realWorkspaces = server.workspaces.filter(workspace => workspace.ungrouped !== true)
      const ungroupedWorkspace = server.workspaces.find(workspace => workspace.ungrouped === true)
      const flatWorkspaces = [
        ...orderWithOverride(realWorkspaces, workspaceOrderOverride[server.id], workspace => workspace.id),
        ...(ungroupedWorkspace === undefined ? [] : [ungroupedWorkspace]),
      ]
      const memberIds = flatWorkspaces.flatMap(workspace => workspace.sessions.map(session => session.id))
      const accountKey = flatAccountKey(server.id)
      if (orderBy === 'updated') flushScheduledActivityWrites()
      const renderedOrder = orderBy === 'updated'
        ? reconciledSessionOrder(getViewPrefs().updatedOrder?.[accountKey] ?? [], memberIds)
        : reconciledSessionOrder(viewPrefs.flatOrder?.[server.id] ?? [], memberIds)
      const nextOrder = nextServerOrder(renderedOrder, activeDrag.sessionId, overTarget)
      if (nextOrder === null) return
      if (orderBy === 'updated') {
        updateViewPrefs(prev => ({ ...prev, updatedOrder: { ...prev.updatedOrder, [accountKey]: nextOrder } }))
      } else {
        updateViewPrefs(prev => ({ ...prev, flatOrder: { ...prev.flatOrder, [server.id]: nextOrder } }))
      }
      return
    }
    // Resolve by id AND the drag's ungrouped flag: a real workspace whose wire id
    // ever equaled UNGROUPED_WORKSPACE_ID must not hijack a bucket drag's anchor.
    const workspace = server.workspaces.find(candidate =>
      candidate.id === activeDrag.accountKey && (candidate.ungrouped === true) === activeDrag.ungrouped)
    if (workspace === undefined) return
    const orderBy = viewPrefs.orderBy?.[server.id] ?? 'manual'
    const wireIds = workspace.sessions.map(session => session.id)
    const accountKey = `${server.id}/${workspace.id}`
    // Updated branch reads the LIVE store (not this render's snapshot): a
    // promotion can land between render and drop, and stale anchor math would
    // clobber it. 先终刷防抖窗内 pending 的派生 order 再取锚点——否则窗末 flush
    // 会用 tick 前派生的旧 order 覆盖本次提交（静默回退且不自愈）。
    if (orderBy === 'updated') flushScheduledActivityWrites()
    const renderedOrder = orderBy === 'updated'
      ? reconciledSessionOrder(getViewPrefs().updatedOrder?.[accountKey] ?? [], wireIds)
      : workspace.ungrouped === true
        ? reconciledSessionOrder(viewPrefs.ungroupedOrder[server.id] ?? [], wireIds)
        : sessionOrderOverride[accountKey] ?? wireIds
    // Same pure drop resolver as the server-group drag: null = no-op (vanished rows / already in place).
    const nextOrder = nextServerOrder(renderedOrder, activeDrag.sessionId, overTarget)
    if (nextOrder === null) return
    if (orderBy === 'updated') {
      // Updated mode mutates the account order (shared + persisted, bucket
      // included), no wire commit — the wire order is the manual baseline.
      updateViewPrefs(prev => ({ ...prev, updatedOrder: { ...prev.updatedOrder, [accountKey]: nextOrder } }))
      return
    }
    if (workspace.ungrouped === true) {
      updateViewPrefs(prev => ({ ...prev, ungroupedOrder: { ...prev.ungroupedOrder, [server.id]: nextOrder } }))
      return
    }
    setSessionOrderOverride(prev => ({ ...prev, [accountKey]: nextOrder }))
    const sessionIndex = nextOrder.indexOf(activeDrag.sessionId)
    const anchor = sessionIndex === -1 || sessionIndex + 1 >= nextOrder.length
      ? undefined
      : nextOrder[sessionIndex + 1]
    runAction(`${server.id}/session-drag/${activeDrag.sessionId}`, async () => {
      try {
        await insertSessionBefore(getInstanceClient(server.id), workspace.id, activeDrag.sessionId, anchor)
        chamberBridge.requestRefresh(server.id)
      } catch (error) {
        // A failed commit must not masquerade as committed: drop the override (wire truth shows).
        setSessionOrderOverride(prev => {
          const next = { ...prev }
          delete next[accountKey]
          return next
        })
        throw error
      }
    })
  }

  // Real-workspace drag commit: the drop resolver (shared/workspace-drag-order)
  // is the single authority for the whole drag surface — it returns the next full
  // order, a no-op (vanished pieces / already in place) or blocked (a drop that
  // would split a contiguous repo family). A blocked/no-op verdict leaves the
  // order untouched; a git family's main carries the whole family, one wire call per member.
  const commitWorkspaceDrag = (
    server: ChamberServerAggregate,
    activeDrag: WorkspaceDragState,
    over: NonNullable<WorkspaceDragState['over']>,
  ): void => {
    if (workspaceDropCommitted.current) return
    workspaceDropCommitted.current = true
    setWorkspaceDrag(null)
    // Synthetic cwd-derived groups (`__cwd__:` ids) are neither draggable nor a target.
    const realWorkspaceIds = server.workspaces
      .filter(workspace => workspace.ungrouped !== true && workspace.synthetic !== true)
      .map(workspace => workspace.id)
    const env = workspaceDropEnv(server.id, realWorkspaceIds, workspaceOrderOverride[server.id], viewPrefs.folded)
    const verdict = resolveWorkspaceDrop(env, activeDrag.workspaceId, over)
    if (verdict.kind !== 'move') return
    setWorkspaceOrderOverride(prev => ({ ...prev, [server.id]: verdict.order }))
    // The wire anchor is the element the moved block lands BEFORE (undefined =
    // append); anchoring every member on it in block order yields `verdict.order`.
    const movedLast = verdict.moved[verdict.moved.length - 1]!
    const lastIndex = verdict.order.indexOf(movedLast)
    const wireAnchor = lastIndex === -1 || lastIndex + 1 >= verdict.order.length
      ? undefined
      : verdict.order[lastIndex + 1]
    // Order commits serialize PER SOURCE: a family-block move is one wire insert
    // per member, and overlapping commits must not interleave their anchors on
    // the host — that would split the family silently. Each insert anchors by id,
    // so a queued commit still converges to its own verdict order.
    const tail = orderCommitTail.current.get(server.id) ?? Promise.resolve()
    const commit = runAction(`${server.id}/workspace-drag/${activeDrag.workspaceId}`, async () => {
      await tail
      try {
        const client = getInstanceClient(server.id)
        for (const workspaceId of verdict.moved) {
          await insertWorkspaceBefore(client, workspaceId, wireAnchor)
        }
        chamberBridge.requestRefresh(server.id)
      } catch (error) {
        // A failed commit must not masquerade as committed: drop the override,
        // and refresh again to converge a PARTIAL multi-member failure.
        setWorkspaceOrderOverride(prev => {
          const next = { ...prev }
          delete next[server.id]
          return next
        })
        chamberBridge.requestRefresh(server.id)
        throw error
      }
    })
    orderCommitTail.current.set(server.id, commit)
    void commit.finally(() => {
      if (orderCommitTail.current.get(server.id) === commit) orderCommitTail.current.delete(server.id)
    })
  }

  // Server-group drag commit: a pure DISPLAY preference persisted into the shared
  // `serverOrder` view pref (cross-ctx live sync), NO wire and no N-ctx/registry
  // change (navigation is id-keyed). `null` from `nextServerOrder` = no-op, so
  // the write is skipped. The anchor math runs INSIDE the updateViewPrefs mutator
  // against the FRESHEST stored order — another ctx's commit must not be clobbered.
  const commitServerDrag = (
    activeDrag: ServerDragState,
    over: NonNullable<ServerDragState['over']>,
  ): void => {
    if (serverDropCommitted.current) return
    serverDropCommitted.current = true
    setServerDrag(null)
    updateViewPrefs(prev => {
      const renderedOrder = orderServersForDisplay(servers, prev.serverOrder).map(server => server.id)
      const nextOrder = nextServerOrder(renderedOrder, activeDrag.sourceId, over)
      if (nextOrder === null) return prev
      return { ...prev, serverOrder: nextOrder }
    })
  }
  return {
    sessionDrag, setSessionDrag, workspaceDrag, setWorkspaceDrag, serverDrag, setServerDrag,
    commitSessionDrag, commitWorkspaceDrag, commitServerDrag,
    sessionDropCommitted, workspaceDropCommitted, serverDropCommitted,
    suppressClickRef, dragPressOnButtonRef,
  }
}
