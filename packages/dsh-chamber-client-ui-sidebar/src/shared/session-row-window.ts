/**
 * 会话行渲染窗口（2026 性能整改 B2）。
 *
 * chamber 自绘会话列表对单工作区（含合成"未分组"桶）的会话行数无上限，行
 * DOM 随会话数线性膨胀。本模块给渲染层一个纯函数窗口：默认只渲染前
 * SESSION_ROWS_VISIBLE_FIRST 行，尾部以"还有 N 个会话"展开条承接（ServerSection
 * 接线，展开状态为本地浏览态、不持久化）。
 *
 * 纪律：
 * - 窗口只在渲染层——数据面（shared/derive 投影、server.workspaces）保持全
 *   量：搜索、拖拽排序、todo 区、信息卡、折叠、归档、rowErrors 等一切消费
 *   完整投影的功能不受窗口影响（搜索结果有独立上限
 *   SESSION_SEARCH_RESULT_LIMIT，不经本窗口）；
 * - 当前会话行（树形 aria-selected 高亮）不得被窗口藏匿：currentIndex 在截
 *   断区外时窗口自动放大到覆盖它（大列表 + 老当前会话的罕见情形放宽渲染，
 *   会话浮顶后回落）；
 * - 纯函数、无 DOM 依赖，node 直跑单测。
 */

/** 每工作区首屏渲染的会话行上限。取值理由（2026 评审补注）：200 行 ≈
 *  6–8 屏（行高 ~32px），远超实际首屏（性能目标在此）又远小于大列表全量
 *  （~32px/行 × 1400 行 ≈ 45k px DOM 的线性膨胀段），展开条给出完整入口；
 *  值被单测/文档引用，调整须同步。 */
export const SESSION_ROWS_VISIBLE_FIRST = 200

export interface SessionRowWindowParams {
  /** 该工作区显示序（排序后）的会话行总数。 */
  total: number
  /** 当前会话行下标；-1 = 该工作区无当前会话（无保可见要求）。 */
  currentIndex: number
  /** 用户已展开全部（"还有 N 个会话"条被点击）。 */
  expanded: boolean
  /** 首屏行上限。 */
  visibleFirst: number
}

export interface SessionRowWindowResult {
  /** 本次应渲染的行数（slice 上界）。 */
  renderCount: number
  /** 被窗口截断的行数（展开条文案用）。 */
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
