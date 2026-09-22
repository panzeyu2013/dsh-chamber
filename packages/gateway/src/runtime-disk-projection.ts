/**
 * Gateway runtime disk projection: the 30 s TTL cache
 * plus the coalesced async tree walk.
 * The manager holds one instance; invalidate() is the disk half of
 * its invalidateDiskCache().
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
  // 磁盘统计走异步单遍遍历（runtimeDiskSummaryAsync，
  // 按批让渡事件循环）+ 节流/单飞。TTL 缓存挡住认证的 3s UI 轮询；冷缓存
  // 与 force 路径经 createCoalescedRefresher 合并并发请求——大 store 下冷
  // 缓存/安装闸口的多次全树统计不串行叠加、也绝不冻结网关进程。
  // 非 force 冷缓存请求在链在途时**静默 join**（共享
  // 在途一遍、不置位补跑）——长遍历期间 3s 轮询的持续到达不会驱动补跑到
  // cap（消除 ~90s 长尾）；force（安装闸口）保持默认补跑语义，闸口新鲜度
  // 不变。陈旧度口径：join 结果的陈旧度 ≤ 在途一遍，
  // 但**不等价于** TTL 缓存语义——长遍历（单遍 42s+ 量级）期间 TTL 已过期
  // 的轮询会拿到比 30s TTL 允许窗更旧的在途结果（可超出 TTL 窗）；展示面
  // 接受此陈旧，写前闸口（force）不走 join、新鲜度不受影响。
  const refreshDiskUsage = createCoalescedRefresher(() => runtimeDiskSummaryAsync(baseDir, dshHome))
  return {
    async projection(force = false) {
      const now = Date.now()
      if (!force && diskCache !== null && now - diskCache.checkedAt < DISK_CACHE_TTL_MS) {
        return { usage: diskCache.usage, error: diskCache.error }
      }
      try {
        // 非 force 静默 join（陈旧度口径见上方注释）；
        // force 安装闸口不传选项、保持默认补跑语义。
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
