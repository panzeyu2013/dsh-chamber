/**
 * 会话行渲染窗口。
 *
 * chamber 自绘会话列表对单工作区（含合成"未分组"桶）的会话行数无上限，行 DOM 随会话数
 * 线性膨胀。本模块给渲染层一个纯函数窗口：默认只渲染前 SESSION_ROWS_VISIBLE_FIRST 行，
 * 尾部以"还有 N 个会话"展开条承接（展开状态为本地浏览态、不持久化）。
 *
 * 纪律：窗口只在渲染层，数据面（derive 投影、server.workspaces）保持全量：搜索、拖拽排
 * 序、todo 区、信息卡、折叠、归档、rowErrors 等消费完整投影的功能不受影响（搜索有独立
 * 上限 SESSION_SEARCH_RESULT_LIMIT，不经本窗口）；当前会话行（aria-selected 高亮）不得
 * 被藏匿——currentIndex 在截断区外时窗口自动放大到覆盖它。
 */

/** 每工作区首屏渲染的会话行上限：200 行 ≈ 6–8 屏（行高 ~32px），远超实际首屏又远小于
 *  大列表全量（~1400 行 ≈ 45k px DOM）的线性膨胀段；展开条给出完整入口。 */
export const SESSION_ROWS_VISIBLE_FIRST = 200

export interface SessionRowWindowParams {
  total: number
  /** 当前会话行下标；-1 = 该工作区无当前会话（无保可见要求）。 */
  currentIndex: number
  expanded: boolean
  visibleFirst: number
}

export interface SessionRowWindowResult {
  renderCount: number
  hiddenCount: number
}

export function sessionRowWindow(params: SessionRowWindowParams): SessionRowWindowResult {
  const { total, currentIndex, expanded, visibleFirst } = params
  if (total <= 0) return { renderCount: 0, hiddenCount: 0 }
  if (expanded) return { renderCount: total, hiddenCount: 0 }
  const neededForCurrent = currentIndex >= 0 ? Math.min(total, currentIndex + 1) : 0
  const renderCount = Math.min(total, Math.max(visibleFirst, neededForCurrent))
  return { renderCount, hiddenCount: total - renderCount }
}

/** 位移动效 resetKey 的一个窗口分量（每工作区一条）。 */
export interface SessionRowWindowMotionGroup {
  /** 稳定身份 = 串里的键。**不能用数组下标**：任意一行的增删都会让后面的组看起来"变了"。 */
  workspaceId: string
  total: number
  currentIndex: number
  expanded: boolean
}

/**
 * 位移动效 `resetKey` 的**窗口分量**：只把「自动窗口真的被钳制」的工作区按 id 记进串
 * （`''` = 没有任何组被钳制）。渲染层把它与视图键（排序、折叠）一起交给 AnimatedRows；
 * App 与 client-core 都不持有状态。
 *
 * 签名的判据是 `SESSION_ROWS_VISIBLE_FIRST < renderCount < total`——**窗口被放大（当前行落在
 * 默认窗口之外迫使它长大）且放大后仍藏着行**。两端都不能签：
 * 1. 未钳制组（`renderCount === total`，这一版之前的写法是每个组都记 `renderCount`）：任何
 *    一行增删（新建会话行出现、归档、ghost 到期）都会改签名 ⇒ resetKey 变 ⇒ AnimatedRows 走
 *    "视图替换"分支 `clear()`，恰恰把要看的入场动画取消掉——把派生数据直接搬进键是错的。
 * 2. `renderCount === visibleFirst`：那是**默认上限**本身。一个恰好 200 行的组在点 + 之后变成
 *    201 行、新空行成为当前行——`renderCount` 仍是 200，但它与 total 的关系从"未钳制"翻成
 *    "被钳制"，同一提交里签名从 `''` 变成 `id:200`，入场动画同样被取消（201→200 归档同理）。
 *    默认窗口不是视图替换，**放大后**的窗口才是。
 * 上游的对应维 `sessionLimits` 只在用户视图动作里变（折叠组 / reveal / 展开条步进，vendor
 * WorkspaceBrowser），对数据抖动免疫；本函数就是本仓的那一半。副作用是组数/顺序变化不进串
 * （新增 workspace 行照旧动画），钳制组内的纯行数变化也保持稳定。
 */
export function sessionRowWindowMotionKey(groups: readonly SessionRowWindowMotionGroup[]): string {
  const clamped: string[] = []
  for (const group of groups) {
    const { renderCount } = sessionRowWindow({
      total: group.total,
      currentIndex: group.currentIndex,
      expanded: group.expanded,
      visibleFirst: SESSION_ROWS_VISIBLE_FIRST,
    })
    // 只签"放大且仍被钳制"：默认上限（= visibleFirst）本身不签，否则跨过 200 边界的那次
    // 行增删会在同一提交里翻键、取消点 + 的入场（见上方注释）。分量只带 workspace id，
    // **绝不带 renderCount**——后者由当前行下标派生：钳制组内"归档当前行上面一行"这类 churn
    // 会让下标上移、签名漂移，吃掉同提交的退出淡出/入场。进出放大态仍然翻键 ⇒ settle（那才是
    // 真正的视图替换）。 */
    if (renderCount > SESSION_ROWS_VISIBLE_FIRST && renderCount < group.total) {
      clamped.push(group.workspaceId)
    }
  }
  return clamped.length === 0 ? '' : JSON.stringify(clamped)
}

/**
 * 展开条自己的窗口：隐藏计数必须与「是否已展开」无关，否则展开后 `sessionRowWindow`
 * 返回 hiddenCount 0，点开一次就再无收起入口。与上游 vendor ui-workspace
 * `collapsedSessionRows` 同构（同样不看 expanded），故同一个控件给出收起。
 * @param params - 不含 expanded（本函数的语义即「未展开的窗口」）。
 */
export function sessionRowDisclosure(
  params: Omit<SessionRowWindowParams, 'expanded'>,
): SessionRowWindowResult {
  return sessionRowWindow({ ...params, expanded: false })
}
