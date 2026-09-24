/**
 * 启动性能 User Timing 标记注册表（renderer 侧直接 import 的埋点；boot 内核内联的
 * `dsh:boot:*` 不在此登记）。名字必须稳定——性能工具与人工 trace 以本表为准，改名会破坏
 * 跨版本的阶段对照。
 *
 * 所有 mark 以 `dsh:` 为前缀；带实例维度的标记用 perfMark(name, instanceId) 生成
 * `<name>:<instanceId>` 后缀（按前缀过滤即可聚合）；每个命名标记全页面只由一个打点者发出
 * （shell settle/failed 由 shell.ts 统一打点，App 只消费状态）。
 * 埋点只做观测、零业务语义：performance.mark 缺失/抛错一律静默（生产与测试同路径）。
 */
export const PERF_MARKS = {
  /** chamber App 首次挂载 effect（页面壳/veil 就绪，boot 链路即将开始）。 */
  appMount: 'dsh:app:mount',
  /** /health（或 SSE 健康流）首次报告本地实例 ready。 */
  appLocalReady: 'dsh:app:local-ready',
  /** 一次来源切换意图被接受（selectView 提交选择）。带目标来源后缀；与 appViewReveal 之差 =
   *  switchFrameMs（App 侧揭示时刻，不是"首帧已绘制"的证明）。 */
  appViewRequest: 'dsh:app:view-request',
  /** 揭示门把 painted 收敛到目标的那一提交。带目标来源后缀；与 appViewRequest 之差 = switchFrameMs。 */
  appViewReveal: 'dsh:app:view-reveal',
  /** bootInstanceShell 入口（含排队等待）。 */
  shellBootStart: 'dsh:shell:boot-start',
  /** AppWebEntry 构造前：module system / host-graph / extra bundles 全部就绪。 */
  shellEntryReady: 'dsh:shell:entry-ready',
  /** 某实例 shell 成功 settle（booted=true）。带实例后缀。 */
  shellSettled: 'dsh:shell:settled',
  /** 一次 boot 以失败落定（error 态；取消/换代不算）。带实例后缀。 */
  shellBootFailed: 'dsh:shell:boot-failed',
} as const

export type PerfMarkName = (typeof PERF_MARKS)[keyof typeof PERF_MARKS]

/** 零成本守卫埋点。detail 用于实例维度后缀（见文件头语义约定）。 */
export function perfMark(name: PerfMarkName, detail?: string): void {
  try {
    if (typeof performance !== 'undefined' && typeof performance.mark === 'function') {
      performance.mark(detail === undefined ? name : `${name}:${detail}`)
    }
  } catch {
  }
}
