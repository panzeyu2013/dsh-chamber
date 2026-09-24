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
