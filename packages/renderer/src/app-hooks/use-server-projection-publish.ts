/**
 * 服务器投影的发布闸与缓存（性能 A1/A2）：
 *  - useServerProjectionCaches 持有 derive 的按来源投影缓存与签名片段缓存（都在本 hook 内建，App 只透传）；
 *  - usePublishServerProjection 等值不发布（壳订阅侧仍会再比一次签名，那道闸不删），签名变化时把它记在
 *    发布数组上，于是每个挂载壳的签名比较退化为 O(1)（原先每壳 2 次整 fleet 序列化）。
 */
import { useEffect, useRef } from 'react'
import {
  cachedServersProjectionSignature,
  chamberBridge,
  createChamberProjectionSignatureCache,
  rememberServersProjectionSignature,
  type ChamberProjectionSignatureCache,
  type ChamberServerAggregate,
} from '@dsh-chamber/dsh-chamber-client-core'
import { createServerProjectionCache, type ServerProjectionCache } from '../host/servers.ts'

export interface ServerProjectionCaches {
  readonly servers: ServerProjectionCache
  readonly signature: ChamberProjectionSignatureCache
}

export function useServerProjectionCaches(): ServerProjectionCaches {
  const ref = useRef<ServerProjectionCaches | null>(null)
  if (ref.current === null) {
    ref.current = {
      servers: createServerProjectionCache(),
      signature: createChamberProjectionSignatureCache(),
    }
  }
  return ref.current
}

export function usePublishServerProjection(
  servers: ChamberServerAggregate[],
  caches: ServerProjectionCaches,
): void {
  const lastSignatureRef = useRef('')
  useEffect(() => {
    const signature = cachedServersProjectionSignature(servers, caches.signature)
    if (signature === lastSignatureRef.current) return
    lastSignatureRef.current = signature
    rememberServersProjectionSignature(servers, signature)
    chamberBridge.publish(servers)
  }, [servers, caches])
}
