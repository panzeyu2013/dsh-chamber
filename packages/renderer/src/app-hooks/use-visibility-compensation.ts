/**
 * Foreground-resume compensation: hidden -> visible immediately advances one aggregate
 * watchdog round, refreshes the connection rows and the registry, and - only after the
 * managed-runtime probe settles and one macrotask passes (React commits the probe's state
 * on the next macrotask) - drains the prewarm queue and runs the conditional hang/harvest
 * sweep. Skipped
 * probes during hidden time would otherwise let the drain act on a stale projection.
 * Split out of App.tsx (B1-3g); all dependencies arrive as refs.
 *
 * Both edges (page visibilitychange and the shell's visible edge) share ONE round: the
 * predicate runs before the 250ms dedupe so an edge that arrives while the shell is still
 * hidden never consumes the dedupe slot of the real shell resume edge (P2-2).
 */
import { useEffect } from 'react'
import { shouldRunBackgroundPhase } from '../background-phase.ts'
import { subscribeShellVisibility } from '../shell-visibility.ts'

/** 同一恢复边沿可能同时到达页面 visibilitychange 与宿主事件；一轮补偿只跑一次。 */
const COMPENSATION_DEDUPE_MS = 250

export interface VisibilityCompensationInputs {
  runStalenessWatchdogRef: { current: () => void }
  refreshConnectionsRef: { current: () => Promise<unknown> }
  refreshRemotesRef: { current: () => Promise<unknown> }
  probeManagedRuntimeRef: { current: () => Promise<unknown> }
  drainPrewarmRef: { current: () => void }
  reclaimHiddenViewsRef: { current: () => void }
}

export function useVisibilityCompensation(inputs: VisibilityCompensationInputs): void {
  const {
    runStalenessWatchdogRef, refreshConnectionsRef, refreshRemotesRef,
    probeManagedRuntimeRef, drainPrewarmRef, reclaimHiddenViewsRef,
  } = inputs
  useEffect(() => {
    let compensationTimer: number | undefined
    let disposed = false
    let lastCompensationAt = Number.NEGATIVE_INFINITY
    const compensate = (): void => {
      // 统一前台相位门（页面可见 ∧ 壳窗口可见未遮挡，D2；不在这里另读第二份事实）：
      // 必须在记去重时间戳**之前**判——页面可见边沿可能先到而壳事实仍 hidden（此时
      // probe/drain 都会被相位门拒绝），若先记 lastCompensationAt，<250ms 内真正的壳
      // 恢复边沿会被当成重复吞掉，该轮 drain/harvest 延后（P2-2）。
      if (!shouldRunBackgroundPhase(document.visibilityState)) return
      const now = Date.now()
      if (now - lastCompensationAt < COMPENSATION_DEDUPE_MS) return
      lastCompensationAt = now
      runStalenessWatchdogRef.current()
      void refreshConnectionsRef.current()
      void refreshRemotesRef.current()
      // 托管 dsh 状态**先刷新完再** drain：隐藏期探针被跳过，并行 drain 会读到旧 managedRuntime
      // 投影，把已停机的 gateway 源拿去收割/预热（白烧一次尝试）。
      // 探针 promise 在微任务里 resolve，React 要到下一个宏任务才提交 setManagedRuntime——延后一个
      // 宏任务让补偿看到新事实；定时器随卸载清理，探针 reject 也不能让补偿整条腿消失。
      probeManagedRuntimeRef.current().then(() => {
        if (disposed) return
        compensationTimer = window.setTimeout(() => {
          compensationTimer = undefined
          if (!shouldRunBackgroundPhase(document.visibilityState)) return
          drainPrewarmRef.current()
          reclaimHiddenViewsRef.current()
        }, 0)
      }).catch(() => undefined)
    }
    const onVisibilityChange = (): void => compensate()
    // 宿主壳可见性（orderOut / 最小化 / Cmd+H / 遮挡 / 另一 Space）不产生页面
    // visibilitychange；恢复可见边沿同样必须补偿一轮（design 14 §D1）。
    const unsubscribeShell = subscribeShellVisibility((detail) => {
      if (detail.visible && !detail.occluded) compensate()
    })
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      disposed = true
      unsubscribeShell()
      if (compensationTimer !== undefined) window.clearTimeout(compensationTimer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [])
}
