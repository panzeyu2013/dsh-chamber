/**
 * 跨 owner 共享的「节流/单飞/终态一次」刷新原语。
 *
 * runtimeDiskSummaryAsync 单遍遍历在 10⁵–10⁶ 项 store 上仍需数百毫秒到数十秒，而
 * desktop 版本事务与 gateway 的 diskProjection 冷缓存路径会在短时间连续请求全树统计。
 * 本原语把并发请求收敛为：单飞（同一时刻至多一遍 compute 在途，运行期间的到达共享该遍
 * 结果）；终态一次（运行期间到达的请求置位补跑，当前遍结束后补跑一遍并把结果交给所有
 * 加入者——cap 内绝不因合并拿到陈旧终态）；有界补跑（同一 promise 链内总遍数 ≤
 * maxReruns，默认 3 = 首遍 + 至多 2 次补跑，触顶只防止病态轮询源把刷新拖成无限循环，
 * 触顶时存在 ≤1 遍的有界陈旧窗口）。
 *
 * 运行期间任一到达都触发完整补跑；串行 await 且无重叠的调用序列不减少遍数。TTL/轮询
 * 读方可用 `{ rerunOnJoin: false }` 静默 join。compute 抛错 → 链上所有请求一并收到该
 * 错误；链清空后下一次请求自然重试（无隐式退避）。
 */
export interface CoalescedRefresherOptions {
  /** 同一 promise 链内总遍数上限（默认 3 = 首遍 + 至多 2 次补跑）。钳制到 ≥1 的正整数：
   *  0/负数/NaN 一律按 1，与 runtimeDiskSummaryAsync 的 yieldEvery 同纪律。 */
  maxReruns?: number
}

/** 单次请求级选项。 */
export interface CoalescedRefreshRequestOptions {
  /** 链在途时是否置位终态补跑（默认 true）。false = 静默 join：只共享在途一遍的结果、
   *  不触发补跑，给 TTL/轮询读方用；结果陈旧度 ≤ 在途一遍，但长遍历期间 TTL 过期轮询可能
   *  拿到比 TTL 窗口更旧的结果（展示面接受）；需要新鲜结果的写前闸口保持 true。 */
  rerunOnJoin?: boolean
}

export function createCoalescedRefresher<T>(
  compute: () => Promise<T>,
  options: CoalescedRefresherOptions = {},
): (request?: CoalescedRefreshRequestOptions) => Promise<T> {
  const rawMaxReruns = options.maxReruns ?? 3
  // 钳制：NaN/0/负数 → 1（链至少跑首遍；NaN 经 `|| 1` 归 1）。
  const maxReruns = Math.max(1, Math.floor(rawMaxReruns) || 1)
  let chain: Promise<T> | null = null
  let arrivedDuringRun = false
  let reruns = 0

  const runLoop = async (): Promise<T> => {
    try {
      let last: T
      do {
        arrivedDuringRun = false
        last = await compute()
        reruns += 1
        // 运行期间有请求到达 → 补跑一遍（终态一次），让加入者拿到最新状态；
        // 补跑封顶防到达率驱动的无限循环。
      } while (arrivedDuringRun && reruns < maxReruns)
      return last
    } finally {
      chain = null
      reruns = 0
      arrivedDuringRun = false
    }
  }

  return (request?: CoalescedRefreshRequestOptions) => {
    if (chain === null) {
      chain = runLoop()
    } else if (request?.rerunOnJoin !== false) {
      arrivedDuringRun = true
    }
    return chain
  }
}
