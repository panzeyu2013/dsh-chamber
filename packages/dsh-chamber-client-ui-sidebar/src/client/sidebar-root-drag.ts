/**
 * In-source drag state machines and their commit helpers: session/workspace/
 * server drags, the native
 * drag acceptance, the drag-end trailing-click guard refs and the three
 * commits (wire/funnel calls with optimistic order overrides).
 */

import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { chamberBridge, type ChamberServerAggregate } from '../shared/aggregate-store.ts'
import { nextServerOrder, orderServersForDisplay, reconciledSessionOrder } from '../shared/derive.ts'
import { getInstanceClient, insertSessionBefore, insertWorkspaceBefore } from '../shared/instance-api.ts'
import { flushScheduledActivityWrites, getViewPrefs, updateViewPrefs, type ChamberSidebarViewPrefs } from '../shared/view-prefs.ts'
import { resolveWorkspaceDrop } from '../shared/workspace-drag-order.ts'
import {
  workspaceDropEnv, type ServerDragState, type SessionDragState, type WorkspaceDragState,
} from './sidebar-context.ts'
import type { RunAction } from './sidebar-root-actions.ts'

/**
 * Accept the native drag at document level while any row drag is active (06
 * §2.2, official useNativeDragAcceptance port): row hover still owns the
 * insertion marker, and releasing outside the list must not be rendered as a
 * rejected drop before dragend commits that last marker.
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
  // chamber (06 §2.2): in-source drag state. Cross-source drops are
  // structurally impossible — every target handler is gated on the drag's
  // sourceId matching the hovered group's source.
  const [sessionDrag, setSessionDrag] = useState<SessionDragState | null>(null)
  const [workspaceDrag, setWorkspaceDrag] = useState<WorkspaceDragState | null>(null)
  // chamber (06 §2.4): server-group drag state
  // (display-order preference only — commit writes view-prefs, no wire).
  const [serverDrag, setServerDrag] = useState<ServerDragState | null>(null)
  const sessionDropCommitted = useRef(false)
  const workspaceDropCommitted = useRef(false)
  const serverDropCommitted = useRef(false)
  /** Per-source tail of the workspace ORDER commits (see commitWorkspaceDrag):
   *  overlapping family-block moves must not interleave their per-member
   *  wire inserts on the host. */
  const orderCommitTail = useRef(new Map<string, Promise<void>>())
  // Some browsers dispatch a trailing `click` after an aborted drag or a
  // drop; the flag set on dragstart (and cleared a tick after dragend) keeps
  // that click from opening the session the row no longer represents.
  const suppressClickRef = useRef(false)
  // Whether the CURRENT pointer press started on a header BUTTON: dragstart's
  // `target` is the drag SOURCE (the header), not the pressed element, so the
  // press target is recorded on pointerdown and consulted on dragstart — a
  // gesture that began on a button (fold / sort / add-workspace / search / +
  // / kebab / git actions) must never initiate a header drag: a >4px
  // micro-drag on the fold toggle would swallow its click.
  const dragPressOnButtonRef = useRef(false)
  useNativeDragAcceptance(sessionDrag !== null || workspaceDrag !== null || serverDrag !== null)

  // chamber (06 §2.4): while a SERVER drag
  // is active, a pointer outside every source section clears the insert
  // marker — releasing outside the list cancels instead of committing the
  // last hovered marker. Session/workspace drags KEEP the §2.2 semantics
  // (release-outside commits); the server drag moves a WHOLE group, so the
  // blast radius warrants the stricter rule. Only the boolean flips the
  // effect; the functional updater keeps the closure stale-free.
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

  // chamber (06 §2.2): session-row drag commit. The anchor resolves from the
  // CURRENT rendered order (mode-aware: updated = the shared updated-order
  // account; manual = override-first), never the projection. Commit writes:
  // updated mode persists the drag into the account order (shared view-prefs,
  // NO wire — official「updated 下拖拽只落 account」, promotions stack on
  // top); manual mode persists the ungrouped bucket through view prefs and
  // real workspaces over the wire with an optimistic override that the next
  // pull replaces.
  const commitSessionDrag = (
    server: ChamberServerAggregate,
    activeDrag: SessionDragState,
    over: NonNullable<SessionDragState['over']>,
  ): void => {
    if (sessionDropCommitted.current) return
    sessionDropCommitted.current = true
    setSessionDrag(null)
    // Resolve by id AND the drag's ungrouped flag (see SessionDragState):
    // a real workspace whose wire id ever equaled UNGROUPED_WORKSPACE_ID must
    // not hijack a bucket drag's anchor into a wrong-workspace wire mutation.
    const workspace = server.workspaces.find(candidate =>
      candidate.id === activeDrag.accountKey && (candidate.ungrouped === true) === activeDrag.ungrouped)
    if (workspace === undefined) return
    const orderBy = viewPrefs.orderBy?.[server.id] ?? 'manual'
    const wireIds = workspace.sessions.map(session => session.id)
    const accountKey = `${server.id}/${workspace.id}`
    // Updated branch reads the LIVE store (like the derivation effect, not
    // this render's viewPrefs snapshot): a promotion write can land between
    // this render and the drop, and stale anchor math would then clobber the
    // un-rendered promotion on the same account key.
    // 先终刷防抖窗内 pending 的派生 order 再取锚点——否则窗末 flush 会用
    // tick 前派生的旧 order 整体覆盖本次拖拽提交（静默回退且不自愈）。
    if (orderBy === 'updated') flushScheduledActivityWrites()
    const renderedOrder = orderBy === 'updated'
      ? reconciledSessionOrder(getViewPrefs().updatedOrder?.[accountKey] ?? [], wireIds)
      : workspace.ungrouped === true
        ? reconciledSessionOrder(viewPrefs.ungroupedOrder[server.id] ?? [], wireIds)
        : sessionOrderOverride[accountKey] ?? wireIds
    // The order math is the same pure drop resolver the server-group drag
    // uses (nextServerOrder): null = no-op (vanished rows / already in
    // place), the caller writes the returned order into its own account.
    const nextOrder = nextServerOrder(renderedOrder, activeDrag.sessionId, over)
    if (nextOrder === null) return
    if (orderBy === 'updated') {
      // Updated mode: the drag mutates the account order (shared + persisted,
      // the ungrouped bucket included), no wire commit — the wire order is
      // the manual baseline, the promotion re-applies on top.
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
        // A failed commit must not keep masquerading as committed: drop the
        // optimistic override immediately, the projection shows wire truth.
        setSessionOrderOverride(prev => {
          const next = { ...prev }
          delete next[accountKey]
          return next
        })
        throw error
      }
    })
  }

  // chamber (06 §2.2): real-workspace drag commit — the drop resolver
  // (shared/workspace-drag-order.ts) is the single authority for the whole
  // drag surface (marker, onDragOver gate, this commit): it returns the next
  // full order, a no-op (vanished pieces / already in place) or blocked (a
  // drop that would split a contiguous repo family — e.g. a foreign workspace
  // into a worktree group's interior, or a worktree out of its own group;
  // design 08 §3.3). A blocked/no-op verdict leaves the order untouched. A
  // MOVE of a git family's main carries the whole family (moved = main first,
  // then its worktrees): each member is re-anchored in order, one wire call
  // per member (insertWorkspaceBefore is single-row; the optimistic override
  // shows the final order while the calls land).
  const commitWorkspaceDrag = (
    server: ChamberServerAggregate,
    activeDrag: WorkspaceDragState,
    over: NonNullable<WorkspaceDragState['over']>,
  ): void => {
    if (workspaceDropCommitted.current) return
    workspaceDropCommitted.current = true
    setWorkspaceDrag(null)
    // Synthetic cwd-derived groups (`__cwd__:` ids) have no host workspace
    // identity: they are neither draggable nor a drop target.
    const realWorkspaceIds = server.workspaces
      .filter(workspace => workspace.ungrouped !== true && workspace.synthetic !== true)
      .map(workspace => workspace.id)
    const env = workspaceDropEnv(server.id, realWorkspaceIds, workspaceOrderOverride[server.id], viewPrefs.folded)
    const verdict = resolveWorkspaceDrop(env, activeDrag.workspaceId, over)
    if (verdict.kind !== 'move') return
    setWorkspaceOrderOverride(prev => ({ ...prev, [server.id]: verdict.order }))
    // The wire anchor is the element the moved block lands BEFORE (undefined
    // = append); every member is anchored on it in block order, so the host
    // order ends up exactly `verdict.order`.
    const movedLast = verdict.moved[verdict.moved.length - 1]!
    const lastIndex = verdict.order.indexOf(movedLast)
    const wireAnchor = lastIndex === -1 || lastIndex + 1 >= verdict.order.length
      ? undefined
      : verdict.order[lastIndex + 1]
    // Order commits serialize PER SOURCE: a family-block move is one wire
    // insert per member, and two overlapping commits (a second drop while the
    // first is still in flight) must not interleave their anchors on the host
    // — that would split the family silently. The next commit waits for the
    // previous one; each insert anchors by id, so a queued commit still
    // converges to its own verdict order regardless of the earlier state.
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
        // A failed commit must not keep masquerading as committed: drop the
        // optimistic override immediately, the projection shows wire truth.
        // The refresh also converges a PARTIAL multi-member failure (some of
        // the family's rows moved before the error) to the host's real order.
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

  // chamber (06 §2.4): server-group
  // drag commit. Pure DISPLAY preference — persists the new order into the
  // shared `serverOrder` view pref (cross-ctx live sync), NO wire, NO
  // App-layer N-ctx/registry change (navigation is id-keyed, never
  // order-keyed). The anchor math lives in the pure `nextServerOrder`
  // (unit-tested); `null` = no-op (unchanged position / vanished target) —
  // the write is skipped. The anchor math runs INSIDE
  // the updateViewPrefs mutator against the FRESHEST stored order — another
  // ctx's commit landing between this render and the drop must not be
  // clobbered by a stale-render snapshot (the commitSessionDrag updated-mode
  // branch reads the live store for the same reason).
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
