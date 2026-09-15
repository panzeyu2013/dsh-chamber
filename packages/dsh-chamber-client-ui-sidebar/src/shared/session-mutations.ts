/**
 * 会话变更的**唯一事实出口**（design 05 §2.2，2026-12 修订）——工作区出口
 * （shared/workspace-mutations.ts）的会话侧同构件。
 *
 * WHY 收口而不是每个调用点各发一次：会话回声（shared/session-echo.ts）是
 * 「本窗口刚建出来的会话行」的唯一非挂载读通道。unary 侧建出来的会话只有一条
 * 异步通道能进挂载壳的官方 summaries（宿主 `api-session/added` 广播），竞态窗
 * 内随后的挂载推送会用这份还不含它的 store 替换整份聚合；而未挂载来源（收割后的
 * 稳态，工作区行仍是真实推送行、"+" 仍可点）根本收不到该广播，unary 兜底又保不住
 * 已推送来源的工作区成员位——两条分支都刷不出这一行（真机反馈：新建的会话不出现，
 * 要切到那个服务器才刷新出来）。事实必须由**任何**应用内创建者发布：侧栏的
 * "+"、会话行菜单的 fork，以及 Git worktree 插件的会话创建（create/adopt/
 * recovery）——工作区回声的第二入口教训（漏发一个调用点，行就必须点开那个
 * 服务器才出现）在这里同样成立。
 *
 * 包装刻意保持薄：无状态、无重试、不是第二事实源；投影的唯一写者仍是 App 层，
 * 权威仍是该来源挂载壳的会话列表/工作区 follow 基线（收敛规则见
 * shared/session-echo.ts）。
 *
 * 归档（archive）是这条链的**撤下**半：单一回声没有退场机制，创建后立刻归档
 * 的行会留在投影里直到 TTL——与工作区回声的 remove 半同理。
 */
import { chamberBridge } from './aggregate-store.ts'
import {
  archiveSession, createSession, forkSession, getInstanceClient,
} from './instance-api.ts'

export interface SessionCreationOptions {
  /**
   * 调用方预分配的会话 id（多步 saga 重试时复用，避免宿主已提交但响应丢失后
   * 再铸一个新会话）。缺省 = 宿主自铸。
   */
  sessionId?: string
  /**
   * 该次创建**意图**写入的显示标题（fork 的递增标题）。回声行因此生来就是
   * 最终标签，不必先渲染成会话 id 再等一次 rename/title 投影翻转。缺省 =
   * 官方 id 阶梯；权威行始终压过它。
   */
  title?: string
}

/** 对 `sourceId` 执行 session.create，并发布创建回声事实（blank = 官方临时行）。 */
export async function createSessionForSource(
  sourceId: string,
  workspaceId: string,
  options: SessionCreationOptions = {},
): Promise<string> {
  const sessionId = await createSession(getInstanceClient(sourceId), workspaceId, options.sessionId)
  chamberBridge.reportSessionCreated({
    sourceId,
    sessionId,
    workspaceId,
    blank: true,
    ...(options.title === undefined ? {} : { title: options.title }),
  })
  return sessionId
}

/**
 * 对 `sourceId` 执行 session.fork，并发布子会话的创建回声事实。
 * 子会话继承父会话的已有内容，因此不是官方临时（blank）行；其工作区成员位由
 * App 从父会话的归属解析（`parentSessionId`）。
 */
export async function forkSessionForSource(
  sourceId: string,
  sessionId: string,
  options: SessionCreationOptions = {},
): Promise<string> {
  const childId = await forkSession(getInstanceClient(sourceId), sessionId)
  chamberBridge.reportSessionCreated({
    sourceId,
    sessionId: childId,
    parentSessionId: sessionId,
    blank: false,
    ...(options.title === undefined ? {} : { title: options.title }),
  })
  return childId
}

/**
 * 对 `sourceId` 执行 workspace.archiveSession，并发布撤下事实。App 端由这一条事实
 * 做两件事：退休该会话的待定创建回声（创建后立刻归档不留幽灵行），以及记一条本地
 * **归档墓碑**（未挂载来源上刚归档的行也必须立刻消失——那条来源没有任何活通道能带出
 * 新的归档集，见 shared/session-echo.ts 的 PendingArchive）。
 */
export async function archiveSessionForSource(sourceId: string, sessionId: string): Promise<void> {
  await archiveSession(getInstanceClient(sourceId), sessionId)
  chamberBridge.reportSessionRemoved({ sourceId, sessionId })
}
