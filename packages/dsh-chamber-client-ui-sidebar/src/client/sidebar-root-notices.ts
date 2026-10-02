/**
 * 来源级普通警示（design 06 §3.4）：点击归档行不可打开时，在**触发它的来源
 * section 内**给一行瞬态警示（上游单浏览器 overlay 的 N-ctx 实例化），per-shell
 * 瞬态、与 rowErrors 同纪律：新的警示替换同来源旧条，3s（上游 Toast 默认 hold）
 * 后自动消失；跨 shell 不共享。归档成功 / 停止并归档的就地提示条已按用户裁决
 * 移除，本 hook 只服务这条普通警示。规则在框架无关的 sidebar-notices-model.ts。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  retainConnectedNoticeSources, SOURCE_NOTICE_TTL_MS,
  type SourceNotices,
} from './sidebar-notices-model.ts'

export type { SourceNotices } from './sidebar-notices-model.ts'

export interface SidebarNotices {
  notices: SourceNotices
  showNotice: (sourceId: string) => void
}

/**
 * One warning per source; showing again replaces the entry and restarts its timer.
 * `servers` drives the disconnect prune: a warning whose source is not connected is
 * dropped (with its timer), so a reconnect inside the TTL cannot resurrect it.
 */
export function useSidebarNotices(
  servers: readonly { id: string; connected: boolean }[],
): SidebarNotices {
  const [notices, setNotices] = useState<SourceNotices>({})
  // 实时连接集：点击可能在"已渲染断连"之后才回报，若此时仍创建警示，prune effect
  // （依赖 [servers]）不会再跑一次，重连后警示会复活。showNotice 直接按当前连接集拒绝。
  const connectedRef = useRef<Set<string>>(new Set())
  connectedRef.current = new Set(servers.filter(server => server.connected).map(server => server.id))
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const clearTimer = (sourceId: string): void => {
    const timer = timers.current.get(sourceId)
    if (timer !== undefined) {
      clearTimeout(timer)
      timers.current.delete(sourceId)
    }
  }
  const showNotice = useCallback((sourceId: string): void => {
    // 断连来源不落警示：渲染门（server.connected）会把它藏起来，重连后 TTL 内复活。
    if (!connectedRef.current.has(sourceId)) return
    clearTimer(sourceId)
    setNotices(prev => ({ ...prev, [sourceId]: true }))
    timers.current.set(sourceId, setTimeout(() => {
      timers.current.delete(sourceId)
      setNotices((prev) => {
        if (!(sourceId in prev)) return prev
        const next = { ...prev }
        delete next[sourceId]
        return next
      })
    }, SOURCE_NOTICE_TTL_MS))
  }, [])
  useEffect(() => {
    const connected = new Set(servers.filter(server => server.connected).map(server => server.id))
    setNotices((prev) => {
      const next = retainConnectedNoticeSources(prev, connected)
      if (next === prev) return prev
      for (const sourceId of Object.keys(prev)) {
        if (!(sourceId in next)) clearTimer(sourceId)
      }
      return next
    })
  }, [servers])
  useEffect(() => () => {
    for (const timer of timers.current.values()) clearTimeout(timer)
    timers.current.clear()
  }, [])
  return { notices, showNotice }
}
