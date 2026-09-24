/**
 * 会话变更的**唯一事实出口**——工作区出口（workspace-mutations.ts）的会话侧同构件。
 * WHY 收口：会话回声（session-echo.ts）是「本窗口刚建出来的会话行」的唯一非挂载读
 * 通道。unary 侧建出来的会话只有宿主 `api-session/added` 广播能进挂载壳的官方
 * summaries，竞态窗内随后的挂载推送会用还不含它的 store 替换整份聚合；未挂载来源
 * 根本收不到该广播。事实必须由**任何**应用内创建者发布——侧栏 "+"、会话行菜单
 * fork、Git worktree 插件的创建（create/adopt/recovery）：漏发一个调用点，行就
 * 必须点开那个服务器才出现。包装刻意保持薄：无状态、无重试、不是第二事实源；
 * 投影的唯一写者仍是 App 层，权威仍是该来源挂载壳的会话列表 / 工作区 follow 基线。
 * 归档（archive）是这条链的撤下半：创建后立刻归档的行靠它退场（与工作区回声的
 * remove 半同理），而不是留到 TTL。
 */
import { chamberBridge } from './aggregate-store.ts'
import type { SessionCreationOrigin } from './session-create-ledger.ts'
import {
  archiveSession, createSession, forkSession, getInstanceClient,
} from './instance-api.ts'

export interface SessionCreationOptions {
  /** 调用方预分配的会话 id（多步 saga 重试复用；缺省 = 宿主自铸）。 */
  sessionId?: string
  /** 该次创建**意图**写入的显示标题（fork 的递增标题）：回声行生来就是最终标签，
   *  不必先渲染会话 id 再等 rename 翻转。缺省 = 官方 id 阶梯；权威行始终压过它。 */
  title?: string
  /** 归因：这次创建的**触发路径**；每个调用点都必须表态（'unknown' 是仪表覆盖缺口的信号）。 */
  origin?: SessionCreationOrigin
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
    // 标签是加法字段——未表态的调用方**不发**该键（事实形状逐字节不变），桥按 'unknown' 记账。
    ...(options.origin === undefined ? {} : { origin: options.origin }),
    ...(options.title === undefined ? {} : { title: options.title }),
  })
  return sessionId
}

/** 对 `sourceId` 执行 session.fork，并发布子会话的创建回声事实。子会话继承父内容，
 *  不是 blank 行；工作区成员位由 App 从 `parentSessionId` 解析。 */
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
    ...(options.origin === undefined ? {} : { origin: options.origin }),
    ...(options.title === undefined ? {} : { title: options.title }),
  })
  return childId
}

/** 对 `sourceId` 执行 workspace.archiveSession，并发布撤下事实。App 据此退休该会话的
 *  待定创建回声，并记一条本地**归档墓碑**（未挂载来源上刚归档的行也必须立刻消失——
 *  那条来源没有任何活通道能带出新的归档集）。 */
export async function archiveSessionForSource(sourceId: string, sessionId: string): Promise<void> {
  await archiveSession(getInstanceClient(sourceId), sessionId)
  chamberBridge.reportSessionRemoved({ sourceId, sessionId })
}
