/**
 * 步骤重入闸：打断「步骤 → 写 store → 同步渲染 → 步骤」的 React #185 嵌套更新环。
 *
 * WHY：步骤体末尾写 useSyncExternalStore 订阅面（App 的完成点/修正臂 store）。若这次写入
 * 触发的 React 更新在**同一次调用栈**里再回调步骤（flushSync / 同步 lane），就形成嵌套更新
 * 环；React 以 #185（Maximum update depth exceeded）中止，被步骤守卫吞掉后整拍作废。
 *
 * 契约：步骤体**永不嵌套执行**；重入请求按 id 去重、按请求序在微任务里补跑（同一 tick 不丢
 * 请求）。非重入调用（正常桥事件/effect）保持同步执行，行为不变。直测见
 * test/wiring/step-gate.test.ts。
 */

/** 补跑调度器（默认微任务；测试注入手动队列）。 */
export type StepDefer = (run: () => void) => void

export interface StepGate {
  /** 请求跑一次 step(id)。正在跑时只登记，当前这次结束后在微任务里补跑。 */
  request(id: string): void
}

export function createStepGate(
  step: (id: string) => void,
  defer: StepDefer = queueMicrotask,
): StepGate {
  let active = false
  const queued: string[] = []
  const queuedSet = new Set<string>()
  const drain = (): void => {
    const ids = [...queued]
    queued.length = 0
    queuedSet.clear()
    for (const id of ids) request(id)
  }
  const request = (id: string): void => {
    if (active) {
      if (!queuedSet.has(id)) {
        queuedSet.add(id)
        queued.push(id)
      }
      return
    }
    active = true
    try {
      step(id)
    } finally {
      active = false
      if (queued.length > 0) defer(drain)
    }
  }
  return { request }
}
