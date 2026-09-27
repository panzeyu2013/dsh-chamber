/**
 * Session row actions over the source unary API: the in-flight "+" guard, and
 * fork/create/archive through the shared session-mutation funnels.
 */

import { useRef } from 'react'
import { chamberBridge, type ChamberServerAggregate } from '@dsh-chamber/dsh-chamber-client-core/aggregate-store'
import { increasedForkTitle } from '@dsh-chamber/dsh-chamber-client-core/derive'
import { getInstanceClient, renameSession } from '@dsh-chamber/dsh-chamber-client-core/instance-api'
import { archiveSessionForSource, createSessionForSource, forkSessionForSource } from '@dsh-chamber/dsh-chamber-client-core/session-mutations'
import { classifyArchiveFailure, type SessionArchiveConfirmRequest } from './session-archive-confirm.ts'
import type { RunAction } from './sidebar-root-actions.ts'

export function useSidebarSessionActions({ runAction, openArchiveConfirm }: {
  runAction: RunAction
  /** Arms the archive-active confirmation (owner: useSidebarDialogs). Returns
   *  false when the single-dialog-layer rule refused the arm. */
  openArchiveConfirm: (request: SessionArchiveConfirmRequest) => boolean
}) {
  /** Per-workspace in-flight "+" resolution (upstream `connectWorkspace`'s
   *  `connecting` map): a second click joins the first. Keyed like the
   *  row-error key `<source>/workspace/<id>/new`. */
  const newSessionRef = useRef(new Map<string, Promise<void>>())

  // 分叉：在最后完成的 turn 处 fork，随后 refresh 并打开子会话。Wire
  // session.fork 只收 { sessionId, atSeq? }，子会话标题先取源标题；成功后按
  // 官方 runtime service 移植的 increasedForkTitle 做递增 rename，失败非致命
  // （fork 已成功、子会话已创建并打开；runAction 只吃 fork 自身的失败）。
  const onForkSession = (server: ChamberServerAggregate, session: { id: string; title: string }): void => {
    runAction(`${server.id}/session/${session.id}/fork`, async () => {
      const client = getInstanceClient(server.id)
      // 会话回声：意图标题（递增后的父标题）随事实一起发布，权威行到达前
      // 子行即渲染最终标签；随后的 rename 仍照旧执行（失败只告警，不阻断）。
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
    // 与上游 connectWorkspace 的每工作区 in-flight map 同款：两次点击读到
    // 同一创建前快照，没有守卫就会各发一次 session/create，多出的空行会
    // 永远成为不可见垃圾。
    const key = `${server.id}/workspace/${workspaceId}/new`
    const inFlight = newSessionRef.current.get(key)
    if (inFlight !== undefined) return
    const task = runAction(key, async () => {
      // 与上游一致：先复用该工作区已有的空会话，没有才创建；候选来自投影
      // （findReusableBlankSession），因此投影变化必须让签名移动。
      const reusable = server.workspaces
        .find(workspace => workspace.id === workspaceId)?.reusableBlankSessionId
      if (reusable !== undefined) {
        // 无需 refresh：行已在投影里，打开即成为当前（可见）空行。
        chamberBridge.requestOpenSession(server.id, reusable)
        return
      }
      // 创建事实由唯一出口在 wire 成功后立即发布：App 把该行并入该工作区并
      // 立即渲染；官方 summaries 看不见它时，回声账本保证下一次挂载推送不丢行。
      const sessionId = await createSessionForSource(server.id, workspaceId, { origin: 'user' })
      // App 重拉快照让该来源其它行收敛；新建行本身走上面的回声事实。
      chamberBridge.requestRefresh(server.id)
      chamberBridge.requestOpenSession(server.id, sessionId)
    })
    newSessionRef.current.set(key, task)
    void task.finally(() => {
      if (newSessionRef.current.get(key) === task) newSessionRef.current.delete(key)
    })
  }

  // 归档两段式，对齐上游 workspace UI：首调只发 workspace/archiveSession
  // { sessionId }。安静会话一次成功（无确认、宿主直接归档）；宿主因仍有活跃
  // 工作而拒绝（workspace/session-active）时，details 列出将被停止的工作，武装
  // 归档确认层；用户确认后由 dialogs.confirmArchive 带 stopActivity 重发，停止
  // 交给宿主自己的 provider（回合/子代理后代/后台任务/定时提醒）——客户端不再
  // 有补偿停止腿。动作仍在行菜单上，drag-end 尾随 click 守卫与按行 rowErrors
  // 归因不变；拒绝本身不写行错误，其它失败照旧。
  const onArchiveSession = (server: ChamberServerAggregate, sessionId: string, displayTitle: string): void => {
    runAction(`${server.id}/session/${sessionId}/archive`, async () => {
      // 唯一出口：归档同时撤下该会话的待定回声，创建后立即归档不留幽灵行。
      try {
        await archiveSessionForSource(server.id, sessionId)
      } catch (error) {
        const attempt = classifyArchiveFailure(error)
        // 非拒绝、或 details 不可解码：保持行级失败上报（绝不弹空/残缺列表）。
        if (attempt.kind === 'reject') throw error
        // 标题是点击那一行的 displayTitle（aggregate 的会话挂在 server.workspaces[*].sessions
        // 下，本就没有 server.sessions）：确认打开期间行可能卸载，仍需点击时的可读标题。
        const title = displayTitle === '' ? sessionId : displayTitle
        // 单层规则拒绝武装时保留原始上报：用户的动作绝不静默消失。
        if (!openArchiveConfirm({ sourceId: server.id, sessionId, displayTitle: title, activity: attempt.activity })) throw error
        return
      }
      chamberBridge.requestRefresh(server.id)
    })
  }
  return { onForkSession, onNewSession, onArchiveSession }
}
