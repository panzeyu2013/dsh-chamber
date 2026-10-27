/**
 * Prewarm queue replenishment: keep only still-eligible ids in the queue, drop intent-priority
 * keys that lost eligibility (opened/suppressed/retired/harvest-parked), append every eligible
 * remote that is not queued yet, then drain once. The activeView dependency is deliberate: a
 * pure activation frees the retention slot, and missing it would silently starve the next
 * speculative prewarm. Extracted from App.tsx (B1-3l).
 */
import { useEffect } from 'react'
import type { KindedInstance } from '../transport-source.ts'
import { sourceIdForInstance } from '../transport-source.ts'

export interface PrewarmQueueInputs {
  remoteInstances: readonly KindedInstance[]
  remoteStatus: Record<string, unknown>
  mountedViews: readonly string[]
  activeView: string
  drainPrewarm: () => void
  prewarmEligibleRef: { current: ReadonlySet<string> }
  prewarmQueueRef: { current: string[] }
  intentPriorityRef: { current: Set<string> }
}

export function usePrewarmQueue(inputs: PrewarmQueueInputs): void {
  const {
    remoteInstances, remoteStatus, mountedViews, activeView, drainPrewarm,
    prewarmEligibleRef, prewarmQueueRef, intentPriorityRef,
  } = inputs
  useEffect(() => {
    const eligible = prewarmEligibleRef.current
    prewarmQueueRef.current = prewarmQueueRef.current.filter(id => eligible.has(id))
    // 已不再 eligible 的意图优先级键（被点开、被抑制、退役、harvest 停车）就地作废——悬停不得让已落下的纪律复活。
    for (const id of [...intentPriorityRef.current]) {
      if (!eligible.has(id)) intentPriorityRef.current.delete(id)
    }
    for (const instance of remoteInstances) {
      const id = sourceIdForInstance(instance)
      if (!eligible.has(id)) continue
      const queue = prewarmQueueRef.current
      if (!queue.includes(id)) queue.push(id)
    }
    drainPrewarm()
    // activeView 依赖：保留槽可经「纯激活」释放——用户点开一个已挂载的隐藏温壳（mountedViews 不变、
    // 无 settle/roster/可见性事件）。eligible 随 activeView 变化增长，而队列补种与 drain 都在此
    // effect；缺该依赖会静默饿死下一次投机预热。
  }, [remoteInstances, remoteStatus, mountedViews, activeView, drainPrewarm])

}
