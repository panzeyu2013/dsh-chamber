/**
 * 常驻壳页面级单例 residentBridge（N-ctx 壳常驻重构 v1.1，design 05 常驻策略面）。
 *
 * 一个页面一份状态：常驻阀（renderer 的 use-resident-guard）把当前挂载壳快照
 * **publish** 到这里；设置面的「性能与内存」面板 **get/subscribe** 它来渲染常驻表，
 * 并通过 **requestRelease** 发出「释放某个壳」的页面级命令（单向命令通道：面板不执行业务，
 * 释放/回收由 App 的 reclaimView 单一入口完成，成功后阀用下一次 publish 带 lastRelease 回来）。
 *
 * 契约约束：
 * - publish 同引用即静默（阀每次 effect 都会发布，引用未变不得惊动订阅者）；
 * - 订阅/释放/刷新监听各自隔离：一个 listener 抛错不得影响其余 listener，也不得冒泡给 publisher；
 * - subscriberCount 是发布端的预算信号：DOM 节点数等昂贵事实只在有面板订阅时采集；
 * - requestRefresh 让面板打开瞬间补一帧完整快照（subscribe 本身不触发发布）；
 * - 不落盘、无 wire、无时钟依赖：本模块只拥有监听者集合与最近一次快照；
 * - 快照按发布者的不可变约定处理（类型全 readonly，本模块从不改写发布对象）。
 */
import { assertSingletonModule } from './singleton.ts'

assertSingletonModule('resident-store')

/** 一个来源壳的页面级状态（设置面板的展示词表；'released' 由面板按历史标注）。 */
export type ResidentShellState = 'active' | 'resident' | 'booting' | 'failed' | 'released'

/** 一个来源壳的事实（阀每次发布全量快照；字段缺席 = 该事实不可得）。 */
export interface ResidentSourceFact {
  id: string
  /** 展示标签（roster 标签；面板不得从 id 反推来源身份）。 */
  label: string
  state: ResidentShellState
  /** 已隐藏时长（单调钟毫秒；state === 'active' 或未 settle 时缺席）。 */
  hiddenSinceMs?: number
  /** 该壳在当前文档中的 DOM 节点数（估读；不可得时缺席）。 */
  domNodes?: number
  /** 系统自动预热（投机）挂载的壳：常驻阀同窗优先释放。 */
  autoPrewarmed?: boolean
  /** 设置面板当前的目标来源：面板打开期间该壳排除出一切释放路径（面板渲染其 boot ctx 台账）。 */
  settingsTarget?: boolean
  /** 最近一次活跃时刻（单调钟毫秒；面板据此显示隐藏时长与 LRU 调试）。 */
  lastActiveAt?: number
}

/** 最后一次释放（面板据此提示「已释放」；一次快照只带最近一条）。 */
export interface ResidentReleaseFact {
  sourceId: string
  reason: 'manual' | 'cap' | 'pressure'
  at: number
}

/** 页面级常驻快照。counts 由生产者算好（本模块不重算、不补默认值）。
 *  sources = 挂载壳（挂载序，local 在列）+ 已释放但仍注册的来源（state 'released'，追加在末尾）；
 *  hiddenSinceMs/lastActiveAt 只在 state === 'resident' 的壳上携带（不把屏上壳读成隐藏）。 */
export interface ResidentSnapshot {
  sources: readonly ResidentSourceFact[]
  counts: { mounted: number; resident: number; active: number; released: number }
  lastRelease?: ResidentReleaseFact
}

/** 空快照：阀首次发布前的稳定初值（冻结，防止读者把它当成可写单例）。 */
const EMPTY_SNAPSHOT: ResidentSnapshot = Object.freeze({
  sources: Object.freeze([]) as readonly ResidentSourceFact[],
  counts: Object.freeze({ mounted: 0, resident: 0, active: 0, released: 0 }),
})

/** 观察者抛错隔离日志（诊断面；publisher 的语义不得被坏 listener 改变）。 */
function reportListenerError(error: unknown): void {
  console.error('[dsh-chamber] residentBridge listener 抛错已隔离：', error)
}

let current: ResidentSnapshot = EMPTY_SNAPSHOT
const listeners = new Set<() => void>()
const releaseListeners = new Set<(sourceId: string) => void>()
const refreshListeners = new Set<() => void>()

/**
 * 页面级常驻桥（唯一实例；vite shared chunk 去重由 {@link assertSingletonModule} 诊断）。
 */
export const residentBridge = {
  /** 当前快照（返回最近一次 publish 的引用；未发布过 = 冻结空快照）。 */
  get(): ResidentSnapshot {
    return current
  },
  /** 发布新快照；同引用静默。 */
  publish(next: ResidentSnapshot): void {
    if (next === current) return
    current = next
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch (error) {
        reportListenerError(error)
      }
    }
  },
  /** 订阅快照变化（不立即回调；返回幂等退订）。 */
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  /** 当前快照订阅者数（发布端据此决定是否采集 DOM 计数等昂贵事实；release/refresh 监听不计）。 */
  subscriberCount(): number {
    return listeners.size
  },
  /** 请求发布端立即重发一次快照（面板打开时用它补一帧带 DOM 计数的快照；没人监听时静默）。 */
  requestRefresh(): void {
    for (const listener of [...refreshListeners]) {
      try {
        listener()
      } catch (error) {
        reportListenerError(error)
      }
    }
  },
  /** 监听刷新请求（阀注册一次；返回幂等退订）。 */
  onRefresh(listener: () => void): () => void {
    refreshListeners.add(listener)
    return () => {
      refreshListeners.delete(listener)
    }
  },
  /** 设置面板请求释放某个来源壳（单向命令；没有监听者时静默）。 */
  requestRelease(sourceId: string): void {
    for (const listener of [...releaseListeners]) {
      try {
        listener(sourceId)
      } catch (error) {
        reportListenerError(error)
      }
    }
  },
  /** 监听释放请求（阀注册一次；返回幂等退订）。 */
  onReleaseRequest(listener: (sourceId: string) => void): () => void {
    releaseListeners.add(listener)
    return () => {
      releaseListeners.delete(listener)
    }
  },
}
