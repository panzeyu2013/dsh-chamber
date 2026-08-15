/**
 * View Transition 切换包装（业界标准全屏视图过渡；Electron 43 = Chromium 140，
 * `document.startViewTransition` 原生可用）。
 *
 * 关键性质（设计 05 §4）：
 * - 更新前对旧视图拍**静态快照**，新视图渲染就绪后动画才开始——目标视图
 *   reveal 重排（content-visibility 缓存因隐藏期间流式更新而失效）期间屏幕
 *   保持旧快照，任何时刻无黑帧；
 * - 更新回调用 `flushSync` 同步提交 React 状态，保证新状态快照捕获到真实
 *   内容（而非过渡中的中间 DOM）；
 * - `prefers-reduced-motion` 或不支持时降级为即时切换；
 * - transition 已在途（`document.activeViewTransition` 非空）时不立即更新——
 *   在途 transition 的更新回调已被排入任务队列、稍后必然执行：立即更新会让
 *   该回调随后覆盖本次更新的新状态（快速连续点击时最后一次意图丢失）。
 *   改为挂到在途 transition 的 `finished` 上顺延——其回调先落地，本更新再按
 *   序应用（多个顺延自然串行成链，仍保持最后一次意图胜出）。
 */
import { flushSync } from 'react-dom'

export function runViewTransition(update: () => void): void {
  const doc = document
  if (
    doc.startViewTransition === undefined ||
    (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches)
  ) {
    update()
    return
  }
  const inFlight = doc.activeViewTransition
  if (inFlight !== null) {
    // `finished` 在动画结束后 resolve、被跳过（如页面隐藏）时 reject——
    // 两种情况下都要在途回调落地后再应用本次更新，保持调用顺序。
    void inFlight.finished.then(
      () => runViewTransition(update),
      () => runViewTransition(update),
    ).catch(() => undefined)
    return
  }
  // 更新回调抛错（渲染错误）由 ErrorBoundary 呈现；吞掉 transition promise
  // 的 rejection，避免未处理拒绝噪音——`finished` 在过渡被跳过（如窗口隐藏
  // 时 UA 跳过、或更新回调抛出未被边界捕获的异常）时同样 reject，两条链都
  // 必须挂 catch。对在途链的延迟回调无影响（它们各自持有 inFlight 的句柄）。
  const transition = doc.startViewTransition(() => {
    flushSync(update)
  })
  transition.updateCallbackDone.catch(() => undefined)
  transition.finished.catch(() => undefined)
}
