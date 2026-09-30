/**
 * facts apply 的纯机制：**每来源步骤闸** + **最新载荷槽**（design 19 §3.7 的接线叶子）。
 *
 * WHY（React #185 环）：`apply-session-facts` 末尾写 factsStore（`useSyncExternalStore`
 * 订阅面），写入触发的同步渲染若在同一次调用栈再回调本步即成嵌套更新环；React 以 #185
 * 中止、异常被 never-throw 守卫吞掉后**整拍作废**（历史证据见
 * `dsh-chamber.authority-log.v1`）。闸的契约（非重入同步、重入去重并微任务补跑）在
 * `step-gate.ts`；本模块只把「每来源一把闸 + 每来源最新载荷」组合成可直测的纯叶子。
 *
 * 载荷语义：快照是**累积**的且游标单调（见 session-facts-source 的游标门），因此重入被
 * 延后时只保留**最新**一份是安全的——延迟补跑绝不会用旧帧覆盖新帧。
 *
 * 纪律：零 React、零 DOM、零全局状态（除了注入的 defer 默认 queueMicrotask）。
 */
import { createStepGate, type StepDefer } from '../step-gate.ts'

/** 每来源「最新待应用载荷」槽。`take` 即清；`found` 区分「登记为 undefined」与「未登记」。 */
export interface LatestSlot<T> {
  set(id: string, value: T): void
  take(id: string): { found: true; value: T } | { found: false }
  forget(id: string): void
  size(): number
}

export function createLatestSlot<T>(): LatestSlot<T> {
  const slots = new Map<string, { value: T }>()
  return {
    set(id, value) { slots.set(id, { value }) },
    take(id) {
      const entry = slots.get(id)
      if (entry === undefined) return { found: false }
      slots.delete(id)
      return { found: true, value: entry.value }
    },
    forget(id) { slots.delete(id) },
    size() { return slots.size },
  }
}

/** 每来源一把闸的池：同源串行（跨步骤嵌套被打断），异源互不延后。 */
export interface StepPool {
  /** 请求跑该来源的步骤；非重入同步执行，重入去重并 defer 补跑。 */
  request(id: string): void
  /** 来源撤回：丢弃该来源的闸与待补跑请求。 */
  forget(id: string): void
  size(): number
}

export function createStepPool(run: (id: string) => void, defer?: StepDefer): StepPool {
  const gates = new Map<string, ReturnType<typeof createStepGate>>()
  return {
    request(id) {
      let gate = gates.get(id)
      if (gate === undefined) {
        gate = defer === undefined ? createStepGate(() => { run(id) }) : createStepGate(() => { run(id) }, defer)
        gates.set(id, gate)
      }
      gate.request(id)
    },
    forget(id) { gates.delete(id) },
    size() { return gates.size },
  }
}
