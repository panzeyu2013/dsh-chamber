/**
 * gateway 来源的托管 dsh 状态探针。desktop 的 ready 只证明 gateway 进程活着，
 * 托管 dsh 是独立进程——不消费 connectionState 时，停机窗口里的来源"可点但背后
 * 不可用"（\`+\` 建会话必失败、状态显示缺失）。
 *
 * 探针只跑 gateway 来源、仅前台、15s 一轮；探不到（非 200/代理失败/未挂载隧道）
 * 一律 null = fail open（见 managed-runtime.ts 头注）。探针函数经 \`probeRef\`
 * 暴露：前台恢复补偿要在 drain 之前先刷新一轮，否则窗口隐藏期间（探针被跳过）
 * 首次 drain 可能把一个托管 dsh 已停机的源拿去收割/预热。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchManagedRuntimeState } from '@dsh-chamber/dsh-chamber-client-core'
import { withoutRemovedSourceKeys } from '../aggregate-refresh.ts'
import { shouldRunBackgroundPhase } from '../retention.ts'
import { sourceIdForInstance } from '../transport-source.ts'
import type { SshInstanceSpec } from '../global.d.ts'
import { MANAGED_RUNTIME_POLL_MS, MANAGED_RUNTIME_PROBE_TIMEOUT_MS } from './budgets.ts'

export interface ManagedRuntimeProbe {
  /** 每 gateway 来源的托管状态（id 缺席 = 未探到；null = 明确不可用）。 */
  managedRuntime: Record<string, string | null>
  /** 当前探针（前台恢复补偿：drain 前先等它落地一轮）。 */
  probeRef: { current: () => Promise<void> }
  /** 来源退役：键空间随注册表收敛（重加同名 id 由刷新重建）。 */
  retireManagedRuntime(removed: ReadonlySet<string>): void
}

export function useManagedRuntime(remoteInstances: SshInstanceSpec[]): ManagedRuntimeProbe {
  const [managedRuntime, setManagedRuntime] = useState<Record<string, string | null>>({})
  const probeManagedRuntimeRef = useRef<() => Promise<void>>(async () => undefined)
  useEffect(() => {
    const gatewayIds = remoteInstances
      .filter(instance => instance.kind === 'gateway')
      .map(sourceIdForInstance)
    const live = new Set(gatewayIds)
    setManagedRuntime(prev => {
      const next: Record<string, string | null> = {}
      let changed = false
      for (const [id, state] of Object.entries(prev)) {
        if (!live.has(id)) {
          changed = true
          continue
        }
        next[id] = state
      }
      return changed ? next : prev
    })
    if (gatewayIds.length === 0) return
    let cancelled = false
    let inFlight: Promise<void> | null = null
    const controller = new AbortController()
    // 单飞 + 单次探针超时：代理悬挂时既不堆叠请求，
    // 也不会永久堵死轮询（15s 周期 × 10s 上限 ⇒ 每轮至多一个在途请求）。
    const probeSignal = (): AbortSignal => {
      const timeout = typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(MANAGED_RUNTIME_PROBE_TIMEOUT_MS)
        : undefined
      if (timeout === undefined || typeof AbortSignal.any !== 'function') return controller.signal
      return AbortSignal.any([controller.signal, timeout])
    }
    const probe = (): Promise<void> => {
      // 单飞返回**同一个在途 promise**（不是 no-op）：可见性恢复补偿要先等
      // 探针落地再 drain，否则 drain 会读到 15s tick 留下的旧投影，把一个已
      // 停机的 gateway 源拿去收割（白烧一次尝试）。
      if (inFlight !== null) return inFlight
      if (!shouldRunBackgroundPhase(document.visibilityState)) return Promise.resolve()
      const run = (async (): Promise<void> => {
      try {
        const signal = probeSignal()
        const entries = await Promise.all(gatewayIds.map(async id =>
          [id, await fetchManagedRuntimeState(id, { signal })] as const))
        if (cancelled) return
        setManagedRuntime(prev => {
          let changed = false
          const next = { ...prev }
          for (const [id, state] of entries) {
            if (next[id] !== state) {
              next[id] = state
              changed = true
            }
          }
          return changed ? next : prev
        })
      } finally {
        inFlight = null
      }
      })()
      inFlight = run
      return run
    }
    void probe()
    probeManagedRuntimeRef.current = probe
    const timer = setInterval(() => { void probe() }, MANAGED_RUNTIME_POLL_MS)
    return () => {
      cancelled = true
      controller.abort()
      probeManagedRuntimeRef.current = async () => undefined
      clearInterval(timer)
    }
  }, [remoteInstances])
  const retireManagedRuntime = useCallback((removed: ReadonlySet<string>): void => {
    setManagedRuntime(prev => withoutRemovedSourceKeys(prev, removed))
  }, [])
  return { managedRuntime, probeRef: probeManagedRuntimeRef, retireManagedRuntime }
}
