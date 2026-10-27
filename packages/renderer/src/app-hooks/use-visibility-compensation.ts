/**
 * Foreground-resume compensation: hidden -> visible immediately advances one aggregate
 * watchdog round, refreshes the connection rows and the registry, and - only after the
 * managed-runtime probe settles and one macrotask passes (React commits the probe's state
 * on the next macrotask) - drains the prewarm queue and reclaims hidden views. Skipped
 * probes during hidden time would otherwise let the drain act on a stale projection.
 * Split out of App.tsx (B1-3g); all dependencies arrive as refs.
 */
import { useEffect } from 'react'

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
    const onVisibilityChange = (): void => {
      if (document.visibilityState !== 'visible') return
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
          if (document.visibilityState !== 'visible') return
          drainPrewarmRef.current()
          reclaimHiddenViewsRef.current()
        }, 0)
      }).catch(() => undefined)
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      disposed = true
      if (compensationTimer !== undefined) window.clearTimeout(compensationTimer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [])
}
