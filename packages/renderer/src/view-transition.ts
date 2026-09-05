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
 * - `prefers-reduced-motion` 或不支持时降级为即时切换。
 *
 * 并发语义（perf T2，2026-09 修订——旧版"在途即按调用序顺延成链"）：每次
 * 在途调用都登记一节完整快照+动画，N 连点串行 N 节，被取代意图仍整段空转
 * （延迟 ≈ N×250ms）。现收敛为**键控单槽合并**：
 * - 每个意图键（视图切换 / settle）最多保留一个"最新意图"；在途期间同键
 *   新意图直接替换旧意图——被取代意图不执行、不进快照、不产生过渡节
 *   （尚未起节的在途前被丢弃；已随在途节出队的旧意图在回调认领时被最新
 *   意图融合取代，见下）；
 * - 过渡结束（`finished` resolve/reject 均继续，语义同旧版）后按键 FIFO
 *   补发下一键；同键突发连点实际过渡 ≤ 2 节（在途 1 节 + 补发 1 节）；
 * - **回调时认领**：补发过渡的更新回调执行瞬间才读取本键最新意图——回调
 *   前又到达的同键意图融合进本节（不额外起节），回调后到达的进入下一轮；
 * - 跨键隔离：视图切换与 settle 是不同意图流，互不吞并、按到达顺序落盘
 *   （settle 若被吞会导致骨架 veil 永驻——禁止）；
 * - 与 App 层 `pendingViewRef` 查重/撤销交互不变（点击旧视图 = 撤销意图，
 *   撤销意图本身就是"最新意图"，替换语义天然覆盖）；
 * - 防御：`startViewTransition` 调用包 try/catch（在途期间抛错语义随
 *   Chromium 版本有变）——异常时直接执行该键最新意图并清槽，绝不钉死切换。
 */
import { flushSync } from 'react-dom'

type Update = () => void

/** 每个意图键最新待发意图；Map 迭代序 = 键的首达顺序（FIFO 补发）。 */
const pending = new Map<string, Update>()
/** 当前在途过渡所属键；finished 前绝不起新节（浏览器单活跃过渡约束）。 */
let activeKey: string | null = null

function reducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** 直通模式：不支持 View Transition 或 prefers-reduced-motion（此时过渡节
 *  退化为即时执行；启动一个空转过渡节没有意义）。 */
function directMode(): boolean {
  const doc = document
  return doc.startViewTransition === undefined || reducedMotion()
}

/** 认领并执行某键的最新意图（无新意图时执行传入的原始意图）。 */
function claimAndApply(key: string, fallback: Update): void {
  const latest = pending.get(key)
  if (latest !== undefined) {
    pending.delete(key)
    flushSync(latest)
  } else {
    flushSync(fallback)
  }
}

function drainNext(): void {
  if (activeKey !== null || pending.size === 0) return
  const entry = pending.entries().next().value as [string, Update]
  const [key, update] = entry
  pending.delete(key)
  if (directMode()) {
    // 直通模式：无过渡节，认领最新意图并即时执行（空闲时与旧降级路径的
    // 同步 apply 完全一致；在途过渡结束后落到这里时同样即时、且经 claim
    // 取到最新意图——绝不产生「直通落地后被在途节的旧 fallback 覆盖」）。
    claimAndApply(key, update)
    return
  }
  activeKey = key
  const doc = document
  let transition: { finished: Promise<void>; updateCallbackDone: Promise<void> }
  try {
    transition = doc.startViewTransition(() => {
      claimAndApply(key, update)
    })
  } catch (error) {
    // 防御：在途/降级期间抛错语义随 Chromium 版本变化——直接执行最新意图，
    // 清槽并继续补发，绝不把切换钉死。claimAndApply 自身若因渲染错误同步
    // 抛出（复合异常），finally 仍保证清槽补发，绝不遗留钉死的 activeKey。
    console.error('[dsh-chamber] startViewTransition threw — applying directly:', error)
    try {
      claimAndApply(key, update)
    } finally {
      activeKey = null
      drainNext()
    }
    return
  }
  // 两条链都必须挂 catch：finished 在过渡被跳过（窗口隐藏/UA 跳过/回调抛错
  // 未被边界捕获）时 reject；updateCallbackDone 的 rejection 同样吞掉。
  // NOTE（2026-09 perf review n2）：回调内 claimAndApply 若因渲染抛错（flushSync
  // 抛），已 pop 的意图丢失且 updateCallbackDone 拒绝被吞——与旧链式实现同
  // 性质、非回归；队列继续，不遗留钉死状态。
  transition.updateCallbackDone.catch(() => undefined)
  void transition.finished.then(
    () => { activeKey = null; drainNext() },
    () => { activeKey = null; drainNext() },
  )
}

export function runViewTransition(update: () => void, key: string): void {
  // 同键替换（Map.set 保序：已在 map 中则原位更新值）——被取代意图到此为止。
  // **直通模式也走同一单槽队列**（drainNext 在直通下即时执行）：若
  // prefers-reduced-motion 恰在过渡在途期间翻转为 reduce，直通立即落地会
  // 让在途节的 claim 稍后用更旧的 fallback 覆盖新意图（末意图胜出被破坏）；
  // 入队后由在途过渡的 finished 处理落点即时执行，顺序与末意图语义保持。
  pending.set(key, update)
  drainNext()
}
