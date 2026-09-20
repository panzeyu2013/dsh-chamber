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

/**
 * 该过渡节的绘制意图（2026-12 P2 过渡作用域）：
 * - `crossfade`：默认 UA 交叉淡入（温壳互切仍由旧快照遮盖 reveal 重排）；
 * - `cut`：命名组硬切——切向一个尚未 settle、必定显示遮罩的视图时使用，
 *   杜绝旧视图快照（含它的输入栏）与新遮罩 crossfade 混色。
 * 通过文档根的 `data-vt-intent` 暴露给 CSS（styles.css 的
 * `html[data-vt-intent='cut']::view-transition-*(active-instance)`）：
 * 不依赖 View Transition `types` 的引擎支持面，且无过渡节时无副作用。
 */
export type PaintIntent = 'crossfade' | 'cut'

/**
 * 认领时求值的绘制意图（2026-12 review 修订）：'cut' 的正确判据是"目标**落地后**
 * 是否显示遮罩"这一 DOM 事实，而不是起节时对目标状态的猜测（目标可以已 settle 却
 * 仍被 P1/P3 的持有门罩着）。resolver 在 flushSync 提交之后、回程调用前求值。
 */
export type PaintResolver = () => PaintIntent

/** 每个意图键最新待发意图 + 其绘制意图；Map 迭代序 = 键的首达顺序（FIFO 补发）。 */
interface PendingIntent {
  update: Update
  paint: PaintIntent | PaintResolver
}

const pending = new Map<string, PendingIntent>()
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

/**
 * 把本次过渡节的绘制意图写到文档根（CSS 据此作用域化命名组动画）。
 * 失败安全：node 单测的 fake document 没有 documentElement，静默跳过。
 */
function writePaintIntent(paint: PaintIntent): void {
  try {
    const root = document.documentElement
    if (root === null || root === undefined) return
    if (paint === 'cut') root.setAttribute('data-vt-intent', 'cut')
    else root.removeAttribute('data-vt-intent')
  } catch {
    // 非 DOM 环境：没有过渡节可作用域化。
  }
}

/**
 * 静默吞掉一条 promise 链的拒绝（2026-12 二轮 review 防御面）：句柄缺字段、字段非
 * thenable 都当"没有这条链"，绝不因此抛出而把过渡槽钉死。
 */
function settleQuietly(candidate: unknown): void {
  if (candidate === null || candidate === undefined) return
  const catchFn = (candidate as { catch?: unknown }).catch
  if (typeof catchFn !== 'function') return
  try {
    void (catchFn as (this: unknown) => Promise<unknown>).call(candidate).catch(() => undefined)
  } catch {
    // 非规约对象：忽略；槽的收尾由调用方的 finish 负责。
  }
}

/** 清掉过渡意图标记（过渡结束/抛错/被跳过都必须清，绝不留给下一次）。 */
function clearPaintIntent(): void {
  try {
    document.documentElement?.removeAttribute('data-vt-intent')
  } catch {
    // 同上。
  }
}

/** resolver 求值（抛错一律降级 crossfade：绝不因为判据失败把切换钉死）。 */
function resolvePaint(paint: PaintIntent | PaintResolver): PaintIntent {
  if (typeof paint !== 'function') return paint
  try {
    return paint()
  } catch (error) {
    console.error('[dsh-chamber] paint resolver threw — falling back to crossfade:', error)
    return 'crossfade'
  }
}

/** 起节前的临时值：静态意图直接用；resolver 结果未知时保守取 'cut'（宁可硬切也不混色）。 */
function provisionalPaint(paint: PaintIntent | PaintResolver): PaintIntent {
  return typeof paint === 'function' ? 'cut' : paint
}

/**
 * 认领并执行某键的最新意图（无新意图时执行传入的原始意图）。
 *
 * 认领结果可能不是起节时的那一个（起节 → 浏览器回调之间还隔着 ≤1 帧，期间同键的新
 * 意图会替换掉它）：因此这里在 flushSync 之后按**实际执行**的意图重写绘制标记，
 * 否则"末意图胜出"在 paint 维度不成立（review 发现的双向错配）。
 */
function claimAndApply(key: string, fallback: PendingIntent, writePaint = true): void {
  const latest = pending.get(key)
  const claimed = latest ?? fallback
  if (latest !== undefined) pending.delete(key)
  flushSync(claimed.update)
  // 两种情况下不写标记：①直通模式（无过渡节 / reduced-motion）——没有伪元素树可
  // 作用域化，写了只会留下没人清的残留；②槽已被收尾（activeKey 不再是本键）——非规约
  // 句柄会让本键在回调到达前就走完 finish，迟到的回调不得再写一个无人清理的属性。
  if (writePaint && activeKey === key) writePaintIntent(resolvePaint(claimed.paint))
}

function drainNext(): void {
  if (activeKey !== null || pending.size === 0) return
  const entry = pending.entries().next().value as [string, PendingIntent]
  const [key, intent] = entry
  pending.delete(key)
  if (directMode()) {
    // 直通模式：无过渡节，认领最新意图并即时执行（空闲时与旧降级路径的
    // 同步 apply 完全一致；在途过渡结束后落到这里时同样即时、且经 claim
    // 取到最新意图——绝不产生「直通落地后被在途节的旧 fallback 覆盖」）。
    claimAndApply(key, intent, false)
    return
  }
  activeKey = key
  const doc = document
  // P2：意图标记必须在 startViewTransition **之前**写好——伪元素树在过渡节
  // 建立时就要带上动画作用域；认领到与临时值不同的意图时在回调内覆盖（见
  // claimAndApply）。静态意图在此就是最终值，resolver 则先取保守的 'cut'。
  writePaintIntent(provisionalPaint(intent.paint))
  // 过渡槽的**唯一**收尾出口（2026-12 二轮 review 加固）：任何"句柄不规约 / 没有结算链"
  // 的路径都必须走它，否则 activeKey 会被永久钉死——之后所有 runViewTransition 静默
  // no-op（setActiveView/setShell 永不执行），比"硬切"严重得多。
  const finish = (): void => {
    clearPaintIntent()
    activeKey = null
    drainNext()
  }
  let handle: unknown
  try {
    handle = doc.startViewTransition(() => {
      claimAndApply(key, intent)
    })
  } catch (error) {
    // 防御：在途/降级期间抛错语义随 Chromium 版本变化——直接执行最新意图，
    // 清槽并继续补发，绝不把切换钉死。claimAndApply 自身若因渲染错误同步
    // 抛出（复合异常），finally 仍保证清槽补发，绝不遗留钉死的 activeKey。
    console.error('[dsh-chamber] startViewTransition threw — applying directly:', error)
    try {
      claimAndApply(key, intent)
    } finally {
      finish()
    }
    return
  }
  if (handle === null || typeof handle !== 'object') {
    // 非规约返回值（undefined / null / 基元）：没有过渡节可等，立即收尾并补发。
    finish()
    return
  }
  const record = handle as { finished?: unknown; updateCallbackDone?: unknown; ready?: unknown }
  // 三条链都必须挂 catch（2026-12 review 订正）：**跳过**过渡时 finished 仍然
  // fulfill（端态照样到达、清槽照常执行）；**开始不了**（同名 view-transition-name、
  // 回调抛错）时 reject 的是 ready —— 回调内 flushSync 抛错正是本模块显式预期的
  // 路径，不挂 catch 会留下一条 unhandled rejection。
  // NOTE（2026-09 perf review n2）：回调内 claimAndApply 若因渲染抛错（flushSync
  // 抛），已 pop 的意图丢失且 updateCallbackDone 拒绝被吞——与旧链式实现同
  // 性质、非回归；队列继续，不遗留钉死状态。
  settleQuietly(record.updateCallbackDone)
  settleQuietly(record.ready)
  const finished = record.finished
  if (finished !== null && typeof finished === 'object' && typeof (finished as { then?: unknown }).then === 'function') {
    try {
      void (finished as { then: (ok: () => void, err: () => void) => unknown }).then(finish, finish)
    } catch (error) {
      console.error('[dsh-chamber] transition.finished.then threw — finishing the slot directly:', error)
      finish()
    }
  } else {
    // 缺 finished（非规约句柄）：没有结算链可挂 ⇒ 立即当它已结束。
    finish()
  }
}

/**
 * 运行一次视图过渡（键控单槽合并，语义见模块头注）。
 *
 * @param update - 同步提交新状态的更新函数（经 flushSync 认领最新意图后执行）。
 * @param key - 意图键（'view' / 'settle' 跨键隔离）。
 * @param paint - 绘制意图（P2）：`'cut'` 用于"落地面是遮罩的切换"，让命名组硬切、
 *   旧视图快照不与新遮罩混色；缺省 `'crossfade'` 保持 UA 默认交叉淡入。也可以传
 *   {@link PaintResolver}：判据需要"目标落地后的 DOM 事实"（遮罩是否真的在目标视图里）
 *   时用它——起节前先写保守的 'cut'，认领后按求值结果覆盖。
 */
export function runViewTransition(
  update: () => void,
  key: string,
  paint: PaintIntent | PaintResolver = 'crossfade',
): void {
  // 同键替换（Map.set 保序：已在 map 中则原位更新值）——被取代意图到此为止。
  // **直通模式也走同一单槽队列**（drainNext 在直通下即时执行）：若
  // prefers-reduced-motion 恰在过渡在途期间翻转为 reduce，直通立即落地会
  // 让在途节的 claim 稍后用更旧的 fallback 覆盖新意图（末意图胜出被破坏）；
  // 入队后由在途过渡的 finished 处理落点即时执行，顺序与末意图语义保持。
  pending.set(key, { update, paint })
  drainNext()
}
