/**
 * 页面注意力事实：页面级「用户此刻是否在看前台」的单一派生（design 14 §D1 /
 * design 06 §4.2 / design 19 §3.3）。
 *
 * 两条门不得混用：
 *  - 相位门（background-phase.ts）：文档可见 ∧ 壳窗口在屏未遮挡 —— 后台算力 /
 *    keep-awake 的判据；active 不进该门。
 *  - 注意力门（本模块）：相位 ∧ (应用激活 active ?? 页面聚焦 hasFocus) —— 完成未读
 *    与完成横幅共用的「正在看」事实。
 *
 * 单向依赖：page-attention → shell-visibility（复用其事实与订阅）；shell-visibility
 * 不得反向 import 本模块（verify:import-cycles 的值环禁令）。
 */
import {
  currentShellVisibility,
  isShellVisible,
  subscribeShellVisibility,
  type ShellVisibilityDetail,
} from './shell-visibility.ts'

/** 页面文档事实（document 的可注入面；测试不依赖 DOM 全局）。 */
export interface PageDocFacts {
  visibilityState: DocumentVisibilityState
  hasFocus: boolean
}

/** 焦点 / 可见性事件目标的最小面（window / document 或测试假体；不依赖 DOM 全局）。 */
export interface PageAttentionEventTarget {
  addEventListener: (type: string, listener: () => void) => void
  removeEventListener: (type: string, listener: () => void) => void
}

/** 订阅注入面：不传 = 生产（window 焦点 / document 可见性 / 实时文档事实）。 */
export interface PageAttentionSubscribeDeps {
  /** 测试注入：一个同时承接 focus / blur / visibilitychange 的事件目标。 */
  focusTarget?: PageAttentionEventTarget
  /** 测试注入：文档事实读取（缺省读 document；无 DOM 时按可见且聚焦）。 */
  docFacts?: () => PageDocFacts
}

/**
 * 缺省文档事实：无 DOM（node / 首帧前 / SSR）按可见 + 聚焦处理——绝不因缺事实停掉
 * 注意力门；有 DOM 时读实时 document 事实。
 */
function defaultDocFacts(): PageDocFacts {
  if (typeof document === 'undefined') return { visibilityState: 'visible', hasFocus: true }
  return { visibilityState: document.visibilityState, hasFocus: document.hasFocus() }
}

/**
 * 页面注意力纯函数：文档可见 ∧ 壳窗口在屏未遮挡 ∧ (应用激活 ?? 页面聚焦)。
 *
 * 壳事实缺 active（旧壳 / web 直开 / 首帧 / 测试默认值）时回退 document.hasFocus()，
 * 绝不伪造 active；真值只由参数决定，不读模块全局事实（真值表可注入）。
 * @param detail - 壳窗口可见性事实（含可选 active）。
 * @param docFacts - 页面文档事实。
 * @returns 用户此刻是否在页面前台。
 */
export function pageForegroundOf(detail: ShellVisibilityDetail, docFacts: PageDocFacts): boolean {
  return docFacts.visibilityState === 'visible'
    && isShellVisible(detail)
    && (detail.active ?? docFacts.hasFocus)
}

/** 当前页面注意力（同步读；无 DOM 安全返回，壳事实缺席默认前台）。 */
export function currentPageForeground(): boolean {
  return pageForegroundOf(currentShellVisibility(), defaultDocFacts())
}

/**
 * 订阅页面注意力边沿：派生布尔变化才通知（同值边沿去重），基准 = 订阅时派生值，
 * 初始不通知（挂载本身不是「返回前台」）。
 *
 * 监听 = subscribeShellVisibility（复用唯一壳事件通道，不装第二份壳监听）+ focus /
 * blur + visibilitychange（生产：焦点在 window、可见性在 document；测试注入单目标）。
 * 无 window（node）时 no-op；返回退订函数，卸载本次新增的全部监听。
 * @param listener - 收到派生注意力布尔（只在变化时调用）。
 * @param deps - 测试注入面（事件目标 / 文档事实）。
 * @returns unsubscribe.
 */
export function subscribePageForeground(
  listener: (foreground: boolean) => void,
  deps: PageAttentionSubscribeDeps = {},
): () => void {
  const focusTarget = deps.focusTarget
    ?? (typeof window === 'undefined' ? undefined : (window as unknown as PageAttentionEventTarget))
  if (focusTarget === undefined) return () => {}
  const visibilityTarget = deps.focusTarget
    ?? (typeof document === 'undefined' ? undefined : (document as unknown as PageAttentionEventTarget))
  const docFacts = deps.docFacts ?? defaultDocFacts
  let last = pageForegroundOf(currentShellVisibility(), docFacts())
  const notify = (): void => {
    const next = pageForegroundOf(currentShellVisibility(), docFacts())
    if (next === last) return
    last = next
    listener(next)
  }
  const unsubscribeShell = subscribeShellVisibility(() => { notify() })
  focusTarget.addEventListener('focus', notify)
  focusTarget.addEventListener('blur', notify)
  visibilityTarget?.addEventListener('visibilitychange', notify)
  return () => {
    unsubscribeShell()
    focusTarget.removeEventListener('focus', notify)
    focusTarget.removeEventListener('blur', notify)
    visibilityTarget?.removeEventListener('visibilitychange', notify)
  }
}
