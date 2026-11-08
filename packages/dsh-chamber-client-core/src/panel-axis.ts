/**
 * 页面级面板轴单例（N-ctx 多实例侧栏的 `sidebar.panellist` 跨壳视图）。
 *
 * 为什么必须页面级：每个挂载实例的侧栏插件都跑在自己的 ctx 里，`sidebar.panellist` 的注册
 * 台账也只属于那个 ctx 的 slots registry——活动来源的壳只能看到自己的注册。要让「A 活动时
 * hover B，B 的 server 头也显示 B 自己的面板入口」，就必须有一个**页面级**台账：每个挂载壳
 * 的侧栏把本 ctx 的条目快照发布到这里，任意壳的侧栏（活动壳也一样）读取它。与 chamberBridge
 * / open-intent 同属 vite shared chunk 上的一份单例，{@link assertSingletonModule} 只做重复
 * 实例化的漂移诊断，修不了打包重复。
 *
 * 两档真相（本模块只拥有第一档）：
 *  1. 已挂载来源：键存在 = 该来源的 ctx 已经报告过自己的面板轴。**空数组是合法事实**——已挂载
 *     但没有面板注册；读者必须用「键在不在」区分「已报告无面板」与「未报告」。
 *  2. 未挂载来源：键缺席，由侧栏自己按 pin 的默认组合回落一个快捷键入口。回落策略不在本模块
 *     （它依赖默认组合与 locale），本模块也绝不为未挂载来源合成条目。
 *
 * 一次性选中意图（requestPanelSelect → onPanelSelectRequest / consumePanelSelect）：点击非活动
 * 来源的面板入口时，侧栏先切到目标来源（chamberBridge），再写一条「由目标壳自己执行
 * selectPanel」的意图。目标壳已挂载且监听就绪时同步送达、当场消费；未挂载时意图留在 pending
 * 里，目标壳 boot 后 consumePanelSelect 取走——每来源至多一条（新的覆盖旧的），
 * {@link PANEL_SELECT_INTENT_TTL_MS} 内有效，过期即丢弃；TTL 内它仍可能落到同来源的一次
 * 手工激活上（每来源一条、15s 上限，这是本轮接受的取舍；TTL 外绝不可能）。
 * retire 只清轴、**不**清在飞意图：壳的异步释放/换代可能恰好落在一次点击之后，
 * 擦掉意图会让用户只切来源不开面板；意图由 15s TTL 与消费兜底（每来源至多一条）。
 *
 * TTL 是**从点击时刻起算**的绝对预算：consumePanelSelect 把原始 `at` 一并交出，消费方（目标壳）
 * 用它继续判定，回灌也沿用原时刻——多代壳 churn 不会把 15s 上限续期（TTL 外绝不可能自开）。
 *
 * 页面本地：不落盘、无 DOM、无 wire、无定时器；快照只在发布内容变化时重建（无变化时同一引用，
 * 供 useSyncExternalStore）。唯一生产消费者是 sidebar 包；测试直接 import 本模块。
 */
import { assertSingletonModule } from './singleton.ts'

assertSingletonModule('panel-axis')

/** 一个来源已注册的一个主面板条目（`sidebar.panellist` 的 {id, order, label} 投影）。 */
export interface PagePanelAxisEntry {
  /** 主面板 key（`ctx.layout.selectPanel` 的入参）。 */
  readonly id: string
  /** 面板轴内的排序位；排序由发布者负责（sidebar 发布前已按 order 排好），本模块不重排。 */
  readonly order: number
  /** 展示标签（发布者按当前 locale 解析后的纯文本；读者不得从 id 反推文案）。 */
  readonly label: string
}

/** 一次「切到目标来源后由目标壳执行 selectPanel」的意图。 */
export interface PanelSelectRequest {
  /** 目标来源（页面级 sourceId；只有该来源自己的壳会消费它）。 */
  readonly sourceId: string
  /** 目标主面板 id（目标壳自己按 ctx 面板台账校验可达性）。 */
  readonly panelId: string
}

/**
 * 目标壳 boot 窗口的一次性意图寿命：过期即丢弃——**过期后**绝不把旧意图落到之后的手工
 * 激活上（旧意图命中一次无关的手工切换到同一来源，就是面板凭空弹开这类惊吓）；TTL 内的
 * 新鲜意图仍可能被同来源一次手工激活消费，见模块头的已接受取舍。
 */
export const PANEL_SELECT_INTENT_TTL_MS = 15_000

/** sourceId → 该来源 ctx 最近一次报告的面板条目（值已冻结；键缺失 = 未报告/已卸载）。 */
const axes = new Map<string, readonly PagePanelAxisEntry[]>()

/** sourceId → 一次性选中意图（每来源一条，新的覆盖旧的）；at 是单调钟毫秒。 */
const pending = new Map<string, { panelId: string; at: number }>()

/** 面板轴订阅者（每个挂载壳的侧栏一个；页面上有 N 个）。 */
const axisListeners = new Set<() => void>()

/** 选中意图订阅者（每个挂载壳的侧栏一个；只消费自己 sourceId 的请求）。 */
const selectListeners = new Set<(request: PanelSelectRequest) => void>()

/** 空快照：首次发布前的稳定初值（冻结，防止读者把它当成可写单例）。 */
const EMPTY_SNAPSHOT: Readonly<Record<string, readonly PagePanelAxisEntry[]>> = Object.freeze({})

/**
 * 当前快照的稳定引用：唯一重建点是 {@link notifyAxes}，无变化时绝不换引用
 * （useSyncExternalStore 要求 getSnapshot 在未变化时返回同一个值）。
 */
let snapshot = EMPTY_SNAPSHOT

/** 逐字段（id/order/label）比较两次发布的内容；数组顺序本身就是面板轴顺序。 */
function sameEntries(left: readonly PagePanelAxisEntry[], right: readonly PagePanelAxisEntry[]): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    const current = left[index] as PagePanelAxisEntry
    const candidate = right[index] as PagePanelAxisEntry
    if (current.id !== candidate.id || current.order !== candidate.order || current.label !== candidate.label) return false
  }
  return true
}

/**
 * 复制并冻结一次发布：数组与每一项都 Object.freeze，且是**新对象**——发布者之后改写自己的
 * 数组/对象不会穿过共享快照（sidebar 的 store 每次 locale 变化都会重算一遍条目）。
 */
function freezeEntries(entries: readonly PagePanelAxisEntry[]): readonly PagePanelAxisEntry[] {
  return Object.freeze(entries.map(entry => Object.freeze({
    id: entry.id,
    order: entry.order,
    label: entry.label,
  })))
}

/** 重建快照后逐监听器通知：一个 listener 抛错不得影响其余 listener，也不得冒泡给 publisher。 */
function notifyAxes(): void {
  snapshot = Object.freeze(Object.fromEntries(axes))
  for (const listener of [...axisListeners]) {
    try {
      listener()
    } catch (error) {
      // Per-listener isolation（chamberBridge / resident-store 的同一纪律）。
      console.error('[dsh-chamber] panel-axis subscriber threw:', error)
    }
  }
}

/**
 * 发布一个来源的面板轴（该来源的侧栏在 syncPanels 后调用）。键存在即「该来源的 ctx 已报告过
 * 面板轴」——空数组是合法事实（已挂载但无面板注册），不会被当成「没有数据」删掉。
 * 内容逐字段相等时静默：不通知、不换快照（每次 locale 变化的重算不得惊动读者）。
 */
export function publishPanelAxis(sourceId: string, entries: readonly PagePanelAxisEntry[]): void {
  const previous = axes.get(sourceId)
  if (previous !== undefined && sameEntries(previous, entries)) return
  axes.set(sourceId, freezeEntries(entries))
  notifyAxes()
}

/**
 * 退役一个来源的面板轴（壳卸载/来源释放）：只删轴，**刻意不删 pending 意图**——壳的异步拆除
 * 可能正好落在「切来源 + 选中意图」点击之后：垂死壳的监听器未必还能消费，新壳也还没挂载，
 * 此时擦掉意图会让用户只切来源、面板不开。意图留在 core（每来源至多一条，15s TTL、消费即清）
 * 由目标壳下一次 apply 的 consumePanelSelect 兜底；换代不会无限继承。
 * 有轴变化才通知（pending 没有独立监听面，快照不变时安静）。
 */
export function retirePanelAxis(sourceId: string): void {
  const hadAxis = axes.delete(sourceId)
  if (hadAxis) notifyAxes()
}

/** 当前页面级面板轴快照（稳定引用；键存在 = 已发布，见模块头两档真相）。 */
export function getPanelAxesSnapshot(): Readonly<Record<string, readonly PagePanelAxisEntry[]>> {
  return snapshot
}

/** 订阅面板轴变化（不立即回调；返回幂等退订）。 */
export function subscribePanelAxes(listener: () => void): () => void {
  axisListeners.add(listener)
  return () => {
    axisListeners.delete(listener)
  }
}

/**
 * 请求「切到目标来源后由目标壳执行 selectPanel」。先把意图写进 pending（每来源一条，新的覆盖
 * 旧的），再**同步**通知 select 监听者：目标壳已挂载时当场消费并执行，未挂载时意图留给它的
 * boot 消费。监听器逐个隔离，错误不冒泡给点击方。
 */
export function requestPanelSelect(request: PanelSelectRequest, now = performance.now()): void {
  pending.set(request.sourceId, { panelId: request.panelId, at: now })
  for (const listener of [...selectListeners]) {
    try {
      listener(request)
    } catch (error) {
      console.error('[dsh-chamber] panel-select subscriber threw:', error)
    }
  }
}

/** 监听面板选中请求（每个挂载壳的侧栏注册一次；返回幂等退订）。 */
export function onPanelSelectRequest(listener: (request: PanelSelectRequest) => void): () => void {
  selectListeners.add(listener)
  return () => {
    selectListeners.delete(listener)
  }
}

/**
 * 取出并清除该来源的 pending 意图（目标壳 boot 时先来取一次，保证挂载前武装的意图不丢）。
 * 只有 `now - at <= PANEL_SELECT_INTENT_TTL_MS` 才返回 `{ panelId, at }`——`at` 是**原始点击时刻**
 * （注入时钟），消费方把它当自己本轮挂起时钟继续用，壳换代/再次消费都不会把 15s 上限重置；
 * 过期返回 undefined，而且无论新鲜与否都清除（过期意图不得残留，更不能落到之后的手工激活上）。
 */
export function consumePanelSelect(
  sourceId: string,
  now = performance.now(),
): { readonly panelId: string; readonly at: number } | undefined {
  const intent = pending.get(sourceId)
  if (intent === undefined) return undefined
  pending.delete(sourceId)
  return now - intent.at <= PANEL_SELECT_INTENT_TTL_MS ? { panelId: intent.panelId, at: intent.at } : undefined
}

/** 仅供测试：清空 axes/pending/listeners/snapshot（node 测试共享本模块实例）。 */
export function __resetPanelAxisForTests(): void {
  axes.clear()
  pending.clear()
  axisListeners.clear()
  selectListeners.clear()
  snapshot = EMPTY_SNAPSHOT
}
