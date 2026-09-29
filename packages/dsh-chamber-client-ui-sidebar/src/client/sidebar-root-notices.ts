/**
 * 来源级归档提示条（design 06 §3.4，D5）：归档成功 / 停止并归档 / 点击归档行不可
 * 打开三种瞬时通知。落点 = **触发它的来源 section 内**（上游单浏览器 overlay 的
 * N-ctx 实例化），per-shell 瞬态、与 rowErrors 同纪律：新的通知替换同来源旧条，
 * per-kind TTL 后自动消失（归档两类 6s、普通警示 3s，上游 RowActionToast/Toast 同步调）；
 * 跨 shell 不共享（上游 toast 同样是瞬时面）。规则在框架无关的 sidebar-notices-model.ts。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  retainConnectedNoticeSources, sourceNoticeTtl,
  type SourceNotice, type SourceNoticeKind,
} from './sidebar-notices-model.ts'

export type { SourceNotice, SourceNoticeKind } from './sidebar-notices-model.ts'

export interface SidebarNotices {
  notices: Readonly<Record<string, SourceNotice>>
  showNotice: (sourceId: string, kind: SourceNoticeKind, sessionId: string) => void
  dismissNotice: (sourceId: string) => void
}

/**
 * One notice per source; showing again replaces the entry and restarts its timer.
 * `servers` drives the disconnect prune: a notice whose source is not connected is
 * dropped (with its timer), so a reconnect inside the TTL cannot resurrect it.
 */
export function useSidebarNotices(
  servers: readonly { id: string; connected: boolean }[],
): SidebarNotices {
  const [notices, setNotices] = useState<Record<string, SourceNotice>>({})
  // 实时连接集：归档续作可能在"已渲染断连"之后才成功回报，若此时仍创建提示，prune effect
  // （依赖 [servers]）不会再跑一次，重连后提示会复活。showNotice 直接按当前连接集拒绝。
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
  const dismissNotice = useCallback((sourceId: string): void => {
    clearTimer(sourceId)
    setNotices((prev) => {
      if (!(sourceId in prev)) return prev
      const next = { ...prev }
      delete next[sourceId]
      return next
    })
  }, [])
  const showNotice = useCallback((sourceId: string, kind: SourceNoticeKind, sessionId: string): void => {
    // 断连来源不落提示：渲染门（server.connected）会把它藏起来，重连后 TTL 内复活。
    if (!connectedRef.current.has(sourceId)) return
    clearTimer(sourceId)
    setNotices(prev => ({ ...prev, [sourceId]: { kind, sessionId } }))
    timers.current.set(sourceId, setTimeout(() => {
      timers.current.delete(sourceId)
      setNotices((prev) => {
        if (!(sourceId in prev)) return prev
        const next = { ...prev }
        delete next[sourceId]
        return next
      })
    }, sourceNoticeTtl(kind)))
  }, [])
  useEffect(() => {
    const connected = new Set(servers.filter(server => server.connected).map(server => server.id))
    setNotices((prev) => {
      const next = retainConnectedNoticeSources(prev, connected)
      if (next === prev) return prev
      for (const sourceId of Object.keys(prev)) {
        if (!(sourceId in next)) clearTimer(sourceId)
      }
      return next as Record<string, SourceNotice>
    })
  }, [servers])
  useEffect(() => () => {
    for (const timer of timers.current.values()) clearTimeout(timer)
    timers.current.clear()
  }, [])
  return { notices, showNotice, dismissNotice }
}
