/**
 * perf T3（2026-09，D8 组合方案）：跨 owner 共享的"节流/单飞/终态一次"
 * 刷新原语。
 *
 * 背景：runtimeDiskSummaryAsync 单遍遍历在 10⁵–10⁶ 项 store 上仍需数百毫秒
 * 到数十秒（只是不再冻结进程）。desktop 版本事务的多个 refresh 调用点与
 * gateway 的 diskProjection 冷缓存路径都会在短时间内连续请求全树统计——若
 * 每个请求各自跑一整遍，事务/冷缓存期会被 N×单遍时长拖慢。本原语把并发
 * 请求收敛为：
 *
 *  - 单飞（single-flight）：同一时刻至多一遍 compute 在途；运行期间的到达
 *    请求共享该遍结果（返回同一个 promise 链）；
 *  - 终态一次（terminal trailing run）：运行期间到达的请求置位"还需再跑
 *    一遍"，当前遍结束后补跑一遍并把补跑结果交给所有加入者——请求者拿到
 *    不早于其到达时在途的那遍之后的补跑结果（cap 内绝不因合并而拿到陈旧
 *    终态；cap 触顶见下）；
 *  - 节流（bounded reruns）：补跑期间的到达继续置位，但同一 promise 链内
 *    **总遍数** ≤ maxReruns（默认 3 = 首遍 + 至多 2 次补跑；运行中任一到达
 *    都强制一遍补跑——到达稀疏时补跑即终态覆盖，重叠持续时到 cap 截断）——
 *    突变序列在事务内串行、UI 轮询有 TTL 缓存（gateway）或事件驱动
 *    （desktop），实际不会触顶；触顶只是防止病态轮询源把一次刷新拖成无限
 *    循环。触顶时 cap 遍运行期间到达的加入者拿到的是该遍结果——其启动早于
 *    到达，存在 ≤1 遍的**有界陈旧窗口**（调用方场景下不可达：写者全串行，
 *    见 desktop/gateway 接线注释）。
 *
 * 成本特征：运行期间**任一**到达（无论状态是否变化）都触发一遍完整补跑；
 * 对"串行 await、请求间无重叠"的调用序列，本原语不减少遍数（每请求各自起
 * 新链）——其收益在不冻结（见 runtimeDiskSummaryAsync）之外的场景是合并
 * 并发突发；纯串行消费方不应期待节流收益。TTL/轮询类读方可用单次请求选项
 * `{ rerunOnJoin: false }` 静默 join（不置位补跑），避免"轮询在长遍历期间
 * 持续到达 → 链内补跑到 cap"的长尾（gateway diskProjection 用法，review A4）。
 *
 * 错误语义：compute 抛错 → 链上所有请求一并收到该错误；链清空后下一次请求
 * 自然重试（不做隐式退避——调用方各自有错误投影/缓存失效语义）。
 *
 * 用法（两个 owner 相同）：
 *   const diskRefresh = createCoalescedRefresher(() => runtimeDiskSummaryAsync(baseDir, dshHome))
 *   const diskUsage = await diskRefresh()
 */
export interface CoalescedRefresherOptions {
  /** 同一 promise 链内总遍数上限（默认 3 = 首遍 + 至多 2 次补跑）。 */
  maxReruns?: number
}

/** 单次请求级选项。 */
export interface CoalescedRefreshRequestOptions {
  /** 链在途时是否置位"终态补跑"（默认 true）。false = **静默 join**：只共享
   *  在途一遍的结果、不触发补跑——给 TTL/轮询类读方用（结果陈旧度 ≤ 在途
   *  一遍，等价其缓存语义）；需要新鲜结果的写前闸口保持 true。 */
  rerunOnJoin?: boolean
}

export function createCoalescedRefresher<T>(
  compute: () => Promise<T>,
  options: CoalescedRefresherOptions = {},
): (request?: CoalescedRefreshRequestOptions) => Promise<T> {
  const maxReruns = options.maxReruns ?? 3
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
        // 运行期间有请求到达 → 再补跑一遍（终态一次），让加入者拿到最新
        // 状态；补跑封顶防到达率驱动的无限循环。
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
