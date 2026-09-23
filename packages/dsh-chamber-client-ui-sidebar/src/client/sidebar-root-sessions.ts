/**
 * Session row actions over the source unary API: the in-flight "+" guard,
 * fork/create/archive through the shared session-mutation funnels, plus their
 * refreshes.
 */

import { useRef } from 'react'
import { chamberBridge, type ChamberServerAggregate } from '@dsh-chamber/dsh-chamber-client-core/aggregate-store'
import { increasedForkTitle } from '@dsh-chamber/dsh-chamber-client-core/derive'
import { getInstanceClient, renameSession, stopArchivedSubtree } from '@dsh-chamber/dsh-chamber-client-core/instance-api'
import { archiveSessionForSource, createSessionForSource, forkSessionForSource } from '@dsh-chamber/dsh-chamber-client-core/session-mutations'
import type { RunAction } from './sidebar-root-actions.ts'

export function useSidebarSessionActions({ runAction }: { runAction: RunAction }) {
  /** Per-workspace in-flight "+" resolution (upstream `connectWorkspace`'s
   *  `connecting` map): a second click joins the first instead of creating a
   *  second empty session. Keyed like the row-error key
   *  `<source>/workspace/<id>/new`. */
  const newSessionRef = useRef(new Map<string, Promise<void>>())

  // chamber (06): fork a session at its last completed turn, refresh, and
  // open the child — the official row-menu fork→open flow (现行契约见
  // design 05 §2.2：行内 kebab 增加分叉入口).
  // Wire session.fork 只收 { sessionId, atSeq? }（increaseTitle 非 wire
  // 字段），子会话标题 = 源标题；chamber 侧按官方 runtime service 移植的
  // increasedForkTitle 在 fork 成功后对子会话做标题递增 rename（经该来源
  // unary client）。递增失败非致命：fork 已成功、子会话已创建并打开（下方
  // requestRefresh/requestOpenSession 照常执行），仅标题不递增——inline
  // rowErrors 不阻断（runAction 只吃 fork 自身的失败）。
  const onForkSession = (server: ChamberServerAggregate, session: { id: string; title: string }): void => {
    runAction(`${server.id}/session/${session.id}/fork`, async () => {
      const client = getInstanceClient(server.id)
      // 会话回声：子行与 "+" 的新建行走同一条唯一出口。意图标题（递增后
      // 的父标题）随事实一起发布，权威行到达之前子行就渲染最终标签；随后的 rename
      // 仍照旧执行（失败只告警，不阻断）。
      const intendedTitle = session.title === '' ? undefined : increasedForkTitle(session.title)
      const childId = await forkSessionForSource(
        server.id,
        session.id,
        intendedTitle === undefined ? {} : { title: intendedTitle },
      )
      if (session.title !== '') {
        try {
          await renameSession(client, childId, increasedForkTitle(session.title))
        } catch {
          // 非致命：fork 已成功，仅子会话标题不递增。
        }
      }
      chamberBridge.requestRefresh(server.id)
      chamberBridge.requestOpenSession(server.id, childId)
    })
  }

  const onNewSession = (server: ChamberServerAggregate, workspaceId: string): void => {
    // Upstream's `connectWorkspace` keeps a per-workspace in-flight map
    // (`connecting`) and returns the SAME promise to a second caller, so a
    // double click can never mint two sessions (vendor ui-workspace/src/client/
    // navigation.ts:116-131). The sidebar needs the same guard: both clicks read
    // the same pre-create snapshot, so without it each one issues
    // `session/create` and one of the two empty rows is invisible garbage
    // forever — the exact I2 defect this handler exists to remove.
    const key = `${server.id}/workspace/${workspaceId}/new`
    const inFlight = newSessionRef.current.get(key)
    if (inFlight !== undefined) return
    const task = runAction(key, async () => {
      // Reuse first, EXACTLY like upstream: reopen an existing blank member of
      // this workspace; only create when there is none. The candidate comes from
      // the projection (`findReusableBlankSession` over the raw snapshot), which
      // is why the projection signature above must move when it changes.
      const reusable = server.workspaces
        .find(workspace => workspace.id === workspaceId)?.reusableBlankSessionId
      if (reusable !== undefined) {
        // No refresh needed: the row already exists in the projection; opening
        // it makes it the current (and therefore visible) blank row.
        chamberBridge.requestOpenSession(server.id, reusable)
        return
      }
      // 05 §2.2：创建事实由唯一出口在 wire 成功后立即发布——App
      // 把该行并入这个工作区并立即渲染；官方 summaries 看不见它时（unary 侧栏创建
      // 的会话不在挂载壳的会话列表里），回声账本保证行不会在下一次挂载推送时消失。
      // I10 归因：这是用户点「+」触发的创建（不是 boot 交接 / 预热兜底）。
      const sessionId = await createSessionForSource(server.id, workspaceId, { origin: 'user' })
      // The App layer re-pulls the snapshot so every OTHER row of that source
      // converges; the created row itself rides the echo fact above.
      chamberBridge.requestRefresh(server.id)
      chamberBridge.requestOpenSession(server.id, sessionId)
    })
    newSessionRef.current.set(key, task)
    void task.finally(() => {
      if (newSessionRef.current.get(key) === task) newSessionRef.current.delete(key)
    })
  }

  // chamber (06 §2.2): archive runs
  // IMMEDIATELY — no confirmation dialog. Upstream states the reason
  // explicitly: archiving only hides the row (the session log is never
  // touched), so it is not destructive and needs no confirm (vendor
  // ui-workspace Rows.tsx:412-421). The verb rides the session row MENU, not a
  // second hover button (same reference); the action gating (drag-end trailing
  // click suppression + pending-click clear at the call site) and the keyed
  // rowErrors reporting are unchanged.
  const onArchiveSession = (server: ChamberServerAggregate, sessionId: string): void => {
    runAction(`${server.id}/session/${sessionId}/archive`, async () => {
      // 唯一出口：归档同时撤下该会话的待定回声——创建后立刻归档的行
      // 不会留成幽灵。
      await archiveSessionForSource(server.id, sessionId)
      // 归档即终止（「已归档的对话应该终止」，与删除侧同一
      // 纪律）：归档成功后**就地**停止该会话及其 subagent 闭包。归档会把"正在
      // 查看"的选中清空（vendor `clearArchivedCurrent`），卡在提问/权限的回合
      // 因此永远等不到回答——不终止就会变成永久 running 的僵尸，之后任何一次
      // 删除都会被 running 守卫整树跳过。停止是 advisory：归档已生效，停止失败
      // 只告警（删除侧还会再停一次），绝不回滚归档——连同"停止腿自身抛错"也
      // 一并吞掉并告警：归档动作已成功，它不得被一个建议性失败改判为失败。
      try {
        const stop = await stopArchivedSubtree(getInstanceClient(server.id), sessionId)
        if (stop.unavailable || stop.stillRunning.length > 0) {
          console.warn(`[chamber] archived ${sessionId} on ${server.id} but its subtree did not settle:`,
            stop.unavailable ? 'session list unreadable' : `still running: ${stop.stillRunning.join(', ')}`)
        }
      } catch (error) {
        console.warn(`[chamber] archived ${sessionId} on ${server.id} but the stop pass threw (advisory):`, error)
      }
      chamberBridge.requestRefresh(server.id)
    })
  }
  return { onForkSession, onNewSession, onArchiveSession }
}
