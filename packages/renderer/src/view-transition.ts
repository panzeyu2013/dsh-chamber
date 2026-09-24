/**
 * View Transition 切换包装（Electron 43 = Chromium 140，`document.startViewTransition` 原生可用）。
 *
 * 关键性质：更新前对旧视图拍**静态快照**，新视图渲染就绪后才动画（reveal 重排期间屏幕
 * 保持旧快照，无黑帧）；更新回调用 `flushSync` 同步提交 React 状态，保证新状态快照
 * 捕获真实内容；`prefers-reduced-motion` 或不支持时降级为即时切换。
 *
 * 并发语义（**键控单槽合并**）：每个意图键（视图切换 / settle）最多保留一个"最新意图"，
 * 在途期间同键新意图替换旧意图；过渡结束后按键 FIFO 补发下一键，同键突发连点实际过渡
 * ≤ 2 节；**回调时认领**（回调前到达的同键意图融合进本节）；跨键隔离（settle 若被吞会
 * 导致骨架 veil 永驻——禁止）。`startViewTransition` 调用包 try/catch，异常时直接执行
 * 该键最新意图并清槽，绝不钉死切换。
 */
import { flushSync } from 'react-dom'

type Update = () => void

/**
 * 该过渡节的绘制意图：`crossfade` 默认交叉淡入；`cut` 命名组硬切（切向必定显示遮罩的视图），
 * 杜绝旧视图快照与新遮罩混色。经文档根 `data-vt-intent` 暴露给 CSS；无过渡节时无副作用。
 */
export type PaintIntent = 'crossfade' | 'cut'

/** 认领时求值的绘制意图：'cut' 的判据是"目标**落地后**是否显示遮罩"这一 DOM 事实，在 flushSync 提交之后求值。 */
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

/** 直通模式：不支持 View Transition 或 prefers-reduced-motion（空闲过渡节没有意义）。 */
function directMode(): boolean {
  const doc = document
  return doc.startViewTransition === undefined || reducedMotion()
}

/** 把绘制意图写到文档根（CSS 据此作用域化命名组动画）；非 DOM 环境静默跳过。 */
function writePaintIntent(paint: PaintIntent): void {
  try {
    const root = document.documentElement
    if (root === null || root === undefined) return
    if (paint === 'cut') root.setAttribute('data-vt-intent', 'cut')
    else root.removeAttribute('data-vt-intent')
  } catch {
  }
}

/** 静默吞掉一条 promise 链的拒绝：句柄缺字段/非 thenable 都当"没有这条链"，绝不钉死过渡槽。 */
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
 * 认领并执行某键的最新意图（无新意图时用传入的原始意图）。起节 → 浏览器回调之间同键
 * 新意图会替换它，因此 flushSync 之后按**实际执行**的意图重写绘制标记，否则"末意图
 * 胜出"在 paint 维度不成立。
 */
function claimAndApply(key: string, fallback: PendingIntent, writePaint = true): void {
  const latest = pending.get(key)
  const claimed = latest ?? fallback
  if (latest !== undefined) pending.delete(key)
  flushSync(claimed.update)
  // 不写标记的两种情况：①直通模式（没有伪元素树可作用域化）；②槽已被收尾。
  if (writePaint && activeKey === key) writePaintIntent(resolvePaint(claimed.paint))
}

function drainNext(): void {
  if (activeKey !== null || pending.size === 0) return
  const entry = pending.entries().next().value as [string, PendingIntent]
  const [key, intent] = entry
  pending.delete(key)
  if (directMode()) {
    // 直通模式：无过渡节，认领最新意图并即时执行（绝不产生「直通落地后被在途节的
    // 旧 fallback 覆盖」）。
    claimAndApply(key, intent, false)
    return
  }
  activeKey = key
  const doc = document
  // 意图标记必须在 startViewTransition **之前**写好（伪元素树建立时就带动画作用域）；
  // 认领到不同意图时在回调内覆盖（见 claimAndApply）。
  writePaintIntent(provisionalPaint(intent.paint))
  // 过渡槽的**唯一**收尾出口：任何"句柄不规约/没有结算链"的路径都必须走它，否则
  // activeKey 被永久钉死，之后所有 runViewTransition 静默 no-op，比"硬切"严重得多。
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
    // 防御：抛错语义随 Chromium 版本变化——直接执行最新意图、清槽补发；finally 保证绝不遗留钉死的 activeKey。
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
  // 三条链都必须挂 catch：跳过过渡时 finished 仍 fulfill；开始不了（同名
  // view-transition-name、回调抛错）时 reject 的是 ready——不挂 catch 会留下 unhandled
  // rejection。回调内 claimAndApply 抛错时已 pop 的意图丢失，但队列继续，不遗留钉死状态。
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
 * `key` = 意图键（'view' / 'settle' 跨键隔离）；`paint` 缺省 'crossfade'，'cut'
 * 用于"落地面是遮罩的切换"（命名组硬切，旧快照不与新遮罩混色）；传
 * {@link PaintResolver} 时起节前先写保守 'cut'、认领后按求值结果覆盖。
 */
export function runViewTransition(
  update: () => void,
  key: string,
  paint: PaintIntent | PaintResolver = 'crossfade',
): void {
  // 同键替换（Map.set 保序）——被取代意图到此为止。**直通模式也走同一单槽队列**：若
  // reduced-motion 恰在在途期间翻转，直通立即落地会让在途节的 claim 稍后用更旧的
  // fallback 覆盖新意图；入队后由在途过渡的 finished 落点即时执行，顺序保持。
  pending.set(key, { update, paint })
  drainNext()
}
