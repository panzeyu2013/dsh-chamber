/**
 * 文档级输入活动观察席位（N-ctx 常驻策略的输入保护窗，v1.1）。
 *
 * 一个文档只装一次监听（常驻阀 useResidentGuard 挂载时安装一次）：capture + passive 地接
 * `beforeinput` / `input` / `compositionstart`，按事件目标最近的 `[data-instance]` 壳根
 * 归属来源 id，把「该来源最近一次输入」写进模块级 Map。常驻阀在下一次 tick 用
 * {@link lastInputAt} 填充 ReleaseContext.lastInputAt：最近 INPUT_GRACE_MS 内输入过的壳不释放。
 *
 * 刻意零 React 状态更新（不写组件状态、不触发重渲染）：输入是高频事件，观察值只在释放
 * 判定时被读取；零更新也保证输入不会打断正在进行的渲染提交。
 */
import { useEffect } from 'react'

/** 壳根节点的唯一归属属性（InstanceView 渲染的 `data-instance`）。 */
const INSTANCE_SELECTOR = '[data-instance]'
/** 归属属性名（读取与选择器必须同一字符串，见上）。 */
const INSTANCE_ATTRIBUTE = 'data-instance'
/** 会话输入族的三个事件：组合输入在 compositionstart 即算「用户在场」，不等待最终 input。 */
const INPUT_EVENTS = ['beforeinput', 'input', 'compositionstart'] as const

/** 每个来源最近一次输入时刻（单调钟毫秒；无记录 = 从未观察到输入）。 */
const lastInputAtById = new Map<string, number>()

/** App 与常驻阀共用同一时钟（performance.now 单调，缺失平台退化 Date.now）。 */
function monotonicNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
}

/** 事件目标 → 所属壳根节点的 `data-instance`（不在任何壳内 = null）。 */
function attributeInstanceId(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null
  const element = target.closest(INSTANCE_SELECTOR)
  if (element === null) return null
  const id = element.getAttribute(INSTANCE_ATTRIBUTE)
  return id === null || id === '' ? null : id
}

/** 某来源最近一次输入时刻（单调钟毫秒；undefined = 无记录）。 */
export function lastInputAt(id: string): number | undefined {
  return lastInputAtById.get(id)
}

/** 丢弃某来源的输入记录（壳释放后调用，避免 Map 无界增长）。 */
export function clearInput(id: string): void {
  lastInputAtById.delete(id)
}

/** 输入活动席位面：模块级导出的同一对函数（返回值保持稳定引用，可直接放进 deps）。 */
export interface InputActivityHandle {
  readonly lastInputAt: (id: string) => number | undefined
  readonly clearInput: (id: string) => void
}

const HANDLE: InputActivityHandle = Object.freeze({ lastInputAt, clearInput })

/**
 * 安装文档级输入观察（每个 App 生命周期一次）。零 React 状态更新：只写模块级 Map；
 * 卸载时按同一 capture 语义移除监听。返回值与模块级导出是同一对函数，供接线直接引用。
 */
export function useInputActivity(): InputActivityHandle {
  useEffect(() => {
    const record = (event: Event): void => {
      const id = attributeInstanceId(event.target)
      if (id !== null) lastInputAtById.set(id, monotonicNow())
    }
    for (const type of INPUT_EVENTS) {
      document.addEventListener(type, record, { capture: true, passive: true })
    }
    return () => {
      for (const type of INPUT_EVENTS) {
        document.removeEventListener(type, record, { capture: true })
      }
    }
  }, [])
  return HANDLE
}
