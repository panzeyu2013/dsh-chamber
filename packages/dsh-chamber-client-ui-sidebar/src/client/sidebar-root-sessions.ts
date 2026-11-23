/**
 * Session row actions over the source unary API: the in-flight "+" guard, and
 * fork/create/archive through the shared session-mutation funnels.
 */

import { useRef } from 'react'
import { chamberBridge, type ChamberServerAggregate } from '@dsh-chamber/dsh-chamber-client-core/aggregate-store'
import { archiveSessionForSource, createSessionForSource, forkSessionForSource, pinSessionForSource, unarchiveSessionForSource, unpinSessionForSource } from '@dsh-chamber/dsh-chamber-client-core/session-mutations'
import { classifyArchiveFailure, type SessionArchiveConfirmRequest } from './session-archive-confirm.ts'
import { markSessionForSource } from './session-status-marks.ts'
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

  /** 归档的每会话 in-flight 守卫（同 `newSessionRef`）：行菜单选中即关天然防连点，
   *  常驻图标钮没有——快速双击会发两次 workspace/archiveSession（活跃会话时第二次
   *  重复武装同一确认层），键与行错误槽同源 `<source>/session/<id>/archive`。 */
  const archiveActionRef = useRef(new Map<string, Promise<void>>())

  // 分叉：在最后完成的 turn 处 fork，随后 refresh 并打开子会话。Wire
  // session.fork 只收 { sessionId, atSeq? }；子会话标题由唯一出口
  // session-mutations 按同来源 skip-taken 定名并 rename（失败非致命：确定性
  // 失败以继承标题发回声并告警、结果未知保留意图，见 design 05 §2.2）。
  const onForkSession = (server: ChamberServerAggregate, session: { id: string; title: string }): void => {
    runAction(`${server.id}/session/${session.id}/fork`, async () => {
      const childId = await forkSessionForSource(
        server.id,
        session.id,
        session.title === '' ? {} : { increaseTitleFrom: session.title },
      )
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
  // 有补偿停止腿。动作的两个入口（行菜单项与行内悬停钮）共用这条漏斗；drag-end 尾随 click 守卫与按行 rowErrors
  // 归因不变；拒绝本身不写行错误，其它失败照旧。
  const onArchiveSession = (server: ChamberServerAggregate, sessionId: string, displayTitle: string): void => {
    const key = `${server.id}/session/${sessionId}/archive`
    if (archiveActionRef.current.has(key)) return
    const task = runAction(key, async () => {
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
    archiveActionRef.current.set(key, task)
    void task.finally(() => {
      if (archiveActionRef.current.get(key) === task) archiveActionRef.current.delete(key)
    })
  }
  /** 置顶的每会话 in-flight 守卫（同 `archiveActionRef`）：悬停钮常驻，快速双击会连发两次
   *  **同向**的幂等调用（无回声 ⇒ 行标记不会被本地翻转；宿主对重复/不存在都是 no-op）。守卫真正
   *  的收益是 pending 窗口内不再发第二条命令——代价是若权威推送先落定、行已翻成反向而守卫仍
   *  持有，紧接着的反向点击会被静默吞掉（需要再点一次）。键与行错误槽同源
   *  `<source>/session/<id>/pin`。 */
  const pinActionRef = useRef(new Map<string, Promise<void>>())

  // 置顶切换：与归档同构的一条漏斗（无确认层——上游 pin 是幂等单段，没有第二相位）。
  // 方向由点击那一刻行的置顶标记决定；成功后照常 requestRefresh，标记由挂载 follow 的
  // 权威置顶集落定（本仓刻意不做乐观回声）。
  const onPinSession = (server: ChamberServerAggregate, sessionId: string, currentlyPinned: boolean): void => {
    const key = `${server.id}/session/${sessionId}/pin`
    if (pinActionRef.current.has(key)) return
    const task = runAction(key, async () => {
      await (currentlyPinned ? unpinSessionForSource : pinSessionForSource)(server.id, sessionId)
      chamberBridge.requestRefresh(server.id)
    })
    pinActionRef.current.set(key, task)
    void task.finally(() => {
      if (pinActionRef.current.get(key) === task) pinActionRef.current.delete(key)
    })
  }
  /** 归档行的「恢复」出口（官方 workspace/unarchiveSession，管理器批量同款线面）：
   *  与归档同一条 keyed 漏斗，失败落行级 rowErrors 键 `<source>/session/<id>/unarchive`。 */
  const unarchiveActionRef = useRef(new Map<string, Promise<void>>())

  const onUnarchiveSession = (server: ChamberServerAggregate, sessionId: string): void => {
    const key = `${server.id}/session/${sessionId}/unarchive`
    if (unarchiveActionRef.current.has(key)) return
    const task = runAction(key, async () => {
      await unarchiveSessionForSource(server.id, sessionId)
      chamberBridge.requestRefresh(server.id)
    })
    unarchiveActionRef.current.set(key, task)
    void task.finally(() => {
      if (unarchiveActionRef.current.get(key) === task) unarchiveActionRef.current.delete(key)
    })
  }

  /** alpha.1 reading mark (行菜单已读/未读；页面级 unary 出口，跨源安全)：与 pin 同一条
   *  keyed 漏斗——同一行的并发点击 join 第一次，失败落行级 rowErrors 键
   *  `<source>/session/<id>/mark`。方向由调用方给「目标态」（unread=true/false），
   *  Host 端把 read 的 throughTurn 夹到自己的 completedTurn。 */
  const markActionRef = useRef(new Map<string, Promise<void>>())

  const onMarkSessionRead = (server: ChamberServerAggregate, sessionId: string, unread: boolean): void => {
    const key = `${server.id}/session/${sessionId}/mark`
    if (markActionRef.current.has(key)) return
    const task = runAction(key, async () => {
      await markSessionForSource(server.id, sessionId, unread)
      // 显式用户已读事实（design 06 §4.9）：成功写回后上报 App，清掉该行的 N-ctx 修正臂
      // （臂是推断，用户显式决定必须生效；只上报读方向，未读由官方 completionUnread 位接手）。
      if (!unread) chamberBridge.reportSessionMarkedRead(server.id, sessionId, server.sourceFingerprint)
    })
    markActionRef.current.set(key, task)
    void task.finally(() => {
      if (markActionRef.current.get(key) === task) markActionRef.current.delete(key)
    })
  }
  return { onForkSession, onNewSession, onArchiveSession, onUnarchiveSession, onPinSession, onMarkSessionRead }
}
