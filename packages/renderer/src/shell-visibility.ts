/**
 * 壳窗口可见性事实（design 14 §D1「隐藏窗口不消耗前台算力」的宿主事实半边）。
 *
 * 事实唯一来源 = macOS Swift 壳经 evaluateJavaScript 派发的页面事件
 * `dsh-chamber:shell-visibility`（design 25 §5 E21；宿主事件契约与 macOS 验收项见
 * design 14 §D1）。detail = {visible, occluded, active?}：
 *  - visible：窗口在屏且未最小化 / 未隐藏（orderOut / 最小化 / Cmd+H → false）；
 *  - occluded：窗口被完全遮挡或不在当前可见 Space（只有 visible 为 true 时才载）；
 *  - active：应用是否激活（NSApp.isActive，additive 可选字段；design 14 §D1 注意力门）。
 *    旧壳 / 首帧 / 测试可能缺席——缺席不得伪造，页面注意力回退 document.hasFocus()
 *    （page-attention.ts）。
 *
 * 为什么需要它：WKWebView 在「另一 Space / 完全遮挡 / orderOut 隐藏」时
 * `document.visibilityState` 仍是 visible（宿主只有窗口级观察面），只读页面状态
 * 的前台相位门因此从不生效。无事件（浏览器直开 / SSR / 首帧竞态 / 无壳测试）默认
 * 按可见处理——绝不因缺事实停掉前台相位。相位判定只在 background-phase.ts（相位门
 * 只看 visible && !occluded，active 不进该门）；页面注意力门（相位 ∧ active/focus）
 * 只在 page-attention.ts，完成未读与完成横幅共用。恢复补偿另订阅本事件的相位边沿
 * （不新增第二前台门）。
 */
export interface ShellVisibilityDetail {
  /** 窗口在屏（未 orderOut、未最小化、应用未隐藏）。 */
  visible: boolean
  /** 窗口被完全遮挡或不在当前可见 Space。 */
  occluded: boolean
  /**
   * 应用是否激活（NSApp.isActive）。可选：旧壳 / 首帧 / 无壳测试可能缺席，缺席不得
   * 伪造——页面注意力回退 document.hasFocus()（page-attention.ts）。
   */
  active?: boolean
}

/** 宿主 → 页面事件名（跨语言契约：Swift 侧同一字面量）。 */
export const SHELL_VISIBILITY_EVENT = 'dsh-chamber:shell-visibility'

/**
 * 缺事实时的默认值：可见（保持门控旧行为）。active 刻意缺席（不是 active: false）：
 * 无壳 / 旧壳 / 首帧的注意力回退必须由页面事实（document.hasFocus）表达。
 */
export const SHELL_VISIBILITY_DEFAULT: ShellVisibilityDetail = Object.freeze({
  visible: true,
  occluded: false,
})

/** 事件 detail 归一（纯函数；异形 / 缺字段一律回落默认可见，不抛错）。 */
export function normalizeShellVisibilityDetail(detail: unknown): ShellVisibilityDetail {
  if (typeof detail !== 'object' || detail === null) return SHELL_VISIBILITY_DEFAULT
  const raw = detail as { visible?: unknown; occluded?: unknown; active?: unknown }
  if (typeof raw.visible !== 'boolean') return SHELL_VISIBILITY_DEFAULT
  return {
    visible: raw.visible,
    occluded: typeof raw.occluded === 'boolean' ? raw.occluded : false,
    // active 只认 boolean；缺省 / 非法 = **键缺席**（不是 active: undefined）——无壳 /
    // 旧壳的回退由 page-attention 的 hasFocus 分支表达，默认事实保持两键形状。
    ...(typeof raw.active === 'boolean' ? { active: raw.active } : {}),
  }
}

/** 前台相位是否允许：窗口可见且未被遮挡。 */
export function isShellVisible(detail: ShellVisibilityDetail = currentShellVisibility()): boolean {
  return detail.visible && !detail.occluded
}

let currentDetail: ShellVisibilityDetail = SHELL_VISIBILITY_DEFAULT

/** 当前事实（同步读；只由本模块安装的监听器更新）。 */
export function currentShellVisibility(): ShellVisibilityDetail {
  return currentDetail
}

type ShellVisibilitySubscriber = (detail: ShellVisibilityDetail) => void
const visibilitySubscribers = new Set<ShellVisibilitySubscriber>()

/**
 * 订阅后续可见性事实（恢复边沿用）。订阅者只读 detail、不改事实；任一订阅者抛错
 * 不得打断事实管道（逐个隔离）。返回退订函数。
 * @param subscriber - 收到归一后 detail 的订阅者。
 * @returns unsubscribe.
 */
export function subscribeShellVisibility(subscriber: ShellVisibilitySubscriber): () => void {
  visibilitySubscribers.add(subscriber)
  return () => { visibilitySubscribers.delete(subscriber) }
}

/** 事件监听目标的最小面（window 或测试假体；不依赖 DOM 全局）。 */
export interface ShellVisibilityEventTarget {
  addEventListener: (type: string, listener: (event: { detail?: unknown }) => void) => void
  removeEventListener: (type: string, listener: (event: { detail?: unknown }) => void) => void
}

/** 安装监听并返回卸载函数；生产在模块加载时对 window 安装一次。 */
export function installShellVisibilityListener(target: ShellVisibilityEventTarget): () => void {
  const listener = (event: { detail?: unknown }): void => {
    const detail = normalizeShellVisibilityDetail(event.detail)
    currentDetail = detail
    for (const subscriber of [...visibilitySubscribers]) {
      try { subscriber(detail) } catch { /* 订阅者异常不得打断事实管道 */ }
    }
  }
  target.addEventListener(SHELL_VISIBILITY_EVENT, listener)
  return () => target.removeEventListener(SHELL_VISIBILITY_EVENT, listener)
}

// 页面上下文自动接线；无 window 的环境不装（缺事件 → 默认可见，旧行为不变）。
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  installShellVisibilityListener(window as unknown as ShellVisibilityEventTarget)
}
