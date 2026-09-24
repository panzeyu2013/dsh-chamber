/**
 * 工作区变更的**唯一事实出口**——与会话出口（session-mutations.ts）同构件。
 * WHY 收口：工作区回声是未挂载来源工作区集合的**唯一非挂载读通道**——unary 兜底
 * 按会话 cwd 反推分组，刚建好的空工作区（0 会话）结构上不可见；已推送来源的工作
 * 区集合又由 mounted merge 冻结（commitAggregatePull），连轮询都不再发生。应用内
 * 其他生产者（Git worktree 插件的 workspace.create：create/adopt/两类 recovery 共
 * 四处）建出的行同样不可见，必须点开那个服务器。
 * 因此**任何** chamber 界面上的工作区变更都走这三个包装：各做一次 wire 调用，再
 * 发布对应的一次性事实（创建 / 撤销 / 改名回声）。包装刻意薄：无状态、无重试、
 * 不是第二事实源；投影唯一写者仍是 App 层，权威仍是挂载壳的 workspace/follow 基线。
 * createWorkspaceForSource 另带可选位置锚点 afterWorkspaceId：投影若先追加尾部、
 * 等挂载后再跳上去就是一次可见跳动（连续家族不变式按渲染序成立）。
 */
import { chamberBridge } from './aggregate-store.ts'
import {
  createWorkspace, deleteWorkspace, getInstanceClient, renameWorkspace,
  type CreateWorkspaceResult,
} from './instance-api.ts'

export interface WorkspaceCreationPlacement {
  /** 该新建工作区在投影里紧跟其后的宿主 workspace id（Git 插件主 checkout）；缺省 = 追加到列表尾部。 */
  afterWorkspaceId?: string
}

export interface WorkspaceCreationOptions extends WorkspaceCreationPlacement {
  /** 该次创建**意图**写入的标题（Git adopt 会把宿主标题改成分支名）：回声行生来
   *  就是最终标签；缺省 = 账本的路径 basename；权威 follow 基线始终压过两者。 */
  title?: string
  /**
   * 在**事实发布之前**、与 wire 结果同一个同步续体里运行：把"回声行首帧就必须
   * 成立"的事实先写好（Git 工作树 flag / 未注册块收敛）。顺序是契约不是优化——
   * 事实一到 App 立刻重派生，此刻行必须已是最终形态。抛错只记录、不中止：宿主上
   * 的创建**已经提交**，渲染期装饰绝不能把成功变成失败（saga 会走进补偿分支）。
   */
  beforePublish?: (created: CreateWorkspaceResult) => void
}

/** 对 `sourceId` 执行 workspace.create，并发布创建回声事实。 */
export async function createWorkspaceForSource(
  sourceId: string,
  path: string,
  options: WorkspaceCreationOptions = {},
): Promise<CreateWorkspaceResult> {
  const created = await createWorkspace(getInstanceClient(sourceId), path)
  if (options.beforePublish !== undefined) {
    try {
      options.beforePublish(created)
    } catch (error) {
      console.error('[dsh-chamber] workspace create decoration failed (best-effort):', error)
    }
  }
  chamberBridge.reportWorkspaceCreated({
    sourceId,
    workspaceId: created.workspaceId,
    path: created.path,
    ...(options.afterWorkspaceId === undefined ? {} : { afterWorkspaceId: options.afterWorkspaceId }),
    ...(options.title === undefined ? {} : { title: options.title }),
  })
  return created
}

/** 对 `sourceId` 执行 workspace.delete，并发布撤销回声事实。`path` 尽力而为：快照未报告该行时为空串（账本同时按 workspaceId 匹配）。 */
export async function deleteWorkspaceForSource(
  sourceId: string,
  workspaceId: string,
  path = '',
): Promise<void> {
  await deleteWorkspace(getInstanceClient(sourceId), workspaceId)
  chamberBridge.reportWorkspaceRemoved({ sourceId, workspaceId, path })
}

/** 对 `sourceId` 执行 workspace.rename，并发布改名回声事实（补丁回声行标题）。 */
export async function renameWorkspaceForSource(
  sourceId: string,
  workspaceId: string,
  title: string,
): Promise<void> {
  await renameWorkspace(getInstanceClient(sourceId), workspaceId, title)
  chamberBridge.reportWorkspaceRenamed({ sourceId, workspaceId, title })
}
