/**
 * First-contact connection bootstrap.
 *
 * Local: once the first connection row arrives (null = not fetched yet), a missing/stopped/error
 * local row triggers ONE idempotent POST /api/connections; a serviceable row (ready|degraded,
 * design 02 §3.5) marks it booted. A failed POST never sets the flag, so the next 30s poll retries.
 *
 * Remote: connect only instances seen for the FIRST time in this render session - never re-connect
 * an id already known, or the poll would resurrect an instance the user manually disconnected.
 * Removed ids leave the set (a re-added id connects again). Extracted from App.tsx (B1-3j).
 */
import { useEffect } from 'react'
import { api } from '../api.ts'
import { LOCAL_INSTANCE_ID } from '../local-instance.ts'
import { isServiceableLocalStatus } from '../transport-source.ts'
import type { ConnectionSummary } from '../api.ts'

export interface ConnectionBootstrapInputs {
  connections: ConnectionSummary[] | null
  remoteInstances: readonly { id: string }[]
  localBootedRef: { current: boolean }
  knownRemoteIdsRef: { current: Set<string> }
}

export function useConnectionBootstrap(inputs: ConnectionBootstrapInputs): void {
  const { connections, remoteInstances, localBootedRef, knownRemoteIdsRef } = inputs
  useEffect(() => {
    if (connections === null) return
    if (localBootedRef.current) return
    const local = connections.find(c => c.connectionId === LOCAL_INSTANCE_ID && c.kind === 'local')
    // A serving local connection must never reach createLocal (design 02 §3.5).
    if (local !== undefined && isServiceableLocalStatus(local.status)) {
      localBootedRef.current = true
      return
    }
    void api.connections.createLocal().then(() => {
      localBootedRef.current = true
    }).catch(err => {
      console.error('[renderer] auto-start local failed (will retry on the next connections poll):', err)
    })
  }, [connections])

  /**
   * 注册表远程实例自动连接：只对**本渲染会话首次见到的**实例 id connect，绝不重复 connect 已见过的 id
   * ——否则轮询会把用户手动断开的实例重新拉起。启动装载 / 设置页新增都在下一个轮询周期内生效；error/
   * degraded 的自动恢复在 transport-manager 慢速重探与用户点击即时重连（都尊重手动断开）。id 随注册表
   * 删除移出，重新添加即再次自动连接。
   */
  useEffect(() => {
    const ssh = window.dshChamber?.desktopSsh
    if (ssh === undefined) return
    const known = knownRemoteIdsRef.current
    for (const instance of remoteInstances) {
      if (known.has(instance.id)) continue
      known.add(instance.id)
      // connect 对未知 id 会经 IPC 拒绝（注册表在 get 与 connect 之间被删）：显式吞掉并记录，绝不产生未处理的 rejection。
      void ssh.connect(instance.id).catch(err => {
        console.error(`[renderer] auto-connect ${instance.id} failed:`, err)
      })
    }
    for (const id of [...known]) {
      if (!remoteInstances.some(instance => instance.id === id)) known.delete(id)
    }
  }, [remoteInstances])
}
