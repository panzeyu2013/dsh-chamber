/** 单调时基单一实现：所有持有时钟/计窗只做差值比较，绝不能受墙钟步进影响——
 *  NTP 校时/休眠唤醒把 `Date.now()` 拉回会让一次性定时器算出负 elapsed 而不再重臂，
 *  有界出口静默消失。`performance.now()` 在渲染器里恒在，缺失时退回墙钟
 *  （非浏览器测试/异常环境）。
 *  @param source - 可注入的 performance 形状（测试缝）；缺省读 globalThis.performance。
 *  @returns 任意但单调的起点起的毫秒数。 */
export function monotonicNow(source?: { now?(): number }): number {
  const perf = source ?? (globalThis as { performance?: { now?: () => number } }).performance
  if (perf !== undefined && typeof perf.now === 'function') return perf.now()
  return Date.now()
}
