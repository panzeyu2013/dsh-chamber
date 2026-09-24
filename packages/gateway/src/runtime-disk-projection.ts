/**
 * Gateway runtime disk projection: 30 s TTL cache + coalesced async tree walk.
 * The manager holds one instance; invalidate() is the disk half of
 * invalidateDiskCache().
 */
import {
  createCoalescedRefresher,
  runtimeDiskSummaryAsync,
  type RuntimeDiskSummary,
} from '@dsh-chamber/dsh-runtime'
import { sanitizeRouteError } from './sanitize-route-error.ts'

export interface RuntimeDiskProjection {
  projection(force?: boolean): Promise<{ usage: RuntimeDiskSummary | null; error: string | null }>
  invalidate(): void
}

export function createRuntimeDiskProjection(deps: { baseDir: string; dshHome: string }): RuntimeDiskProjection {
  const { baseDir, dshHome } = deps
  const DISK_CACHE_TTL_MS = 30_000
  let diskCache: {
    checkedAt: number
    usage: RuntimeDiskSummary | null
    error: string | null
  } | null = null
  // 磁盘统计走异步单遍遍历（按批让渡事件循环）+ 节流/单飞：TTL 缓存挡住认证的
  // 3s UI 轮询，冷缓存与 force 路径经 createCoalescedRefresher 合并并发请求，
  // 绝不串行叠加或冻结网关进程。非 force 冷缓存请求在链在途时静默 join
  // （陈旧度 ≤ 在途一遍，不适用 TTL 保证）；force 安装闸口不 join、新鲜度不变。
  const refreshDiskUsage = createCoalescedRefresher(() => runtimeDiskSummaryAsync(baseDir, dshHome))
  return {
    async projection(force = false) {
      const now = Date.now()
      if (!force && diskCache !== null && now - diskCache.checkedAt < DISK_CACHE_TTL_MS) {
        return { usage: diskCache.usage, error: diskCache.error }
      }
      try {
        // 非 force 静默 join；force 安装闸口不传选项，保持默认补跑语义。
        const usage = await refreshDiskUsage(force ? undefined : { rerunOnJoin: false })
        diskCache = { checkedAt: now, usage, error: null }
      } catch (error) {
        diskCache = {
          checkedAt: now,
          usage: null,
          error: sanitizeRouteError(error instanceof Error ? error.message : String(error)),
        }
      }
      return { usage: diskCache.usage, error: diskCache.error }
    },
    invalidate() {
      diskCache = null
    },
  }
}