/**
 * Host health stream + low-frequency polling. The control plane streams every machine
 * transition (starting -> ready flips immediately, no periodic health poll); the page
 * channel reconnects and the health subscription snapshots on subscribe, and a failed
 * stream falls back to one-shot /health. The connection rows and the registry poll on the
 * same slow cadence (background phases skipped; the visibility effect compensates), and
 * beforeunload disposes every shell. Split out of App.tsx (B1-3i).
 */
import { useEffect } from 'react'
import { api, type HealthResponse } from '../api.ts'
import { CONNECTIONS_POLL_MS } from '../host/budgets.ts'
import { shouldRunBackgroundPhase } from '../retention.ts'

export interface HostHealthStreamInputs {
  refreshHealth: () => Promise<unknown>
  refreshConnections: () => Promise<unknown>
  refreshRemotes: () => Promise<unknown>
  pollAggregatesRef: { current: () => void }
  setHealth: (value: HealthResponse) => void
  setHealthError: (value: string | null) => void
  setHealthErrorAt: (value: number | null) => void
  rosterGate: { isListenerReady(): boolean }
  disposeAllShells: () => void
}

export function useHostHealthStream(inputs: HostHealthStreamInputs): void {
  const {
    refreshHealth, refreshConnections, refreshRemotes, pollAggregatesRef,
    setHealth, setHealthError, setHealthErrorAt, rosterGate, disposeAllShells,
  } = inputs
  useEffect(() => {
    let cancelled = false

    void refreshHealth()
    void refreshConnections()
    pollAggregatesRef.current()

    // Local status push channel: the control plane streams every machine transition (starting →
    // ready flips immediately, no periodic health poll). The page channel reconnects and the health
    // subscription snapshots on subscribe; a failed stream falls back to one-shot /health.
    const healthEvents = api.host.healthEvents()
    healthEvents.onmessage = (event) => {
      if (cancelled) return
      try {
        const payload = JSON.parse(event.data) as HealthResponse
        if (payload?.ok === true && payload?.dsh !== undefined) {
          setHealth(payload)
          setHealthError(null)
          setHealthErrorAt(null)
        }
      } catch {
        // 畸形帧忽略——流的下一帧快照会覆盖
      }
    }
    healthEvents.onerror = () => {
      if (cancelled) return
      void refreshHealth()
    }

    // 连接行低频刷新（label/dshPort 极少变化）；隐藏期跳过，恢复可见时由上方 visibility effect 立即补偿一轮。
    const connectionsTimer = setInterval(() => {
      if (cancelled) return
      if (!shouldRunBackgroundPhase(document.visibilityState)) return
      void refreshConnections()
    }, CONNECTIONS_POLL_MS)

    // 注册表低频轮询（与连接行同节奏）：兜底主进程 save/delete 的 instances_changed 推送之外的注册表
    // 变化；隧道状态本身走 onStatusChanged 推送，不依赖此轮询。隐藏期跳过与恢复补偿同连接行轮询。
    const remotesTimer = setInterval(() => {
      if (cancelled) return
      if (!rosterGate.isListenerReady()) return
      if (!shouldRunBackgroundPhase(document.visibilityState)) return
      void refreshRemotes()
    }, CONNECTIONS_POLL_MS)

    window.addEventListener('beforeunload', disposeAllShells)

    return () => {
      cancelled = true
      clearInterval(connectionsTimer)
      clearInterval(remotesTimer)
      healthEvents.close()
      window.removeEventListener('beforeunload', disposeAllShells)
    }
  }, [refreshHealth, refreshConnections, refreshRemotes])
}
