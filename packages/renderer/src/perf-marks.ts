/**
 * 启动性能 User Timing 标记注册表（C2，2026-09 性能审计落点）。
 *
 * 本表是启动链埋点的**单一规范来源**：boot 内核
 * （packages/dsh-client-web/src/boot.ts，独立包无法反向依赖本文件）内联同名
 * 守卫函数并在其文件头注释中引用本表；renderer 侧（shell.ts / App.tsx）直接
 * import 本模块。名字必须保持稳定——scripts/perf 工具与人工 Performance trace
 * 以本表为准，改名会破坏跨版本的阶段对照。
 *
 * 语义约定：所有 mark 以 `dsh:` 为前缀；带实例维度的标记用
 * perfMark(name, instanceId) 生成 `<name>:<instanceId>` 后缀形式
 * （PerformanceObserver 按前缀过滤即可聚合）。每个命名标记全页面只由一个
 * 打点者发出（shell settle/failed 由 shell.ts 在 settle 返回点统一打点，
 * App 的 handleShellState 只消费状态、不再重复打点）。
 *
 * 埋点只做观测、零业务语义：performance.mark 缺失/抛错一律静默，生产与测试
 * 环境同路径（见 perfMark 的守卫）。
 */
export const PERF_MARKS = {
  /** chamber App 首次挂载 effect（页面壳/veil 就绪，boot 链路即将开始）。 */
  appMount: 'dsh:app:mount',
  /** /health（或 SSE 健康流）首次报告本地实例 ready。 */
  appLocalReady: 'dsh:app:local-ready',
  /** bootInstanceShell 入口（含排队等待）。 */
  shellBootStart: 'dsh:shell:boot-start',
  /** AppWebEntry 构造前：module system / host-graph / extra bundles 全部就绪。 */
  shellEntryReady: 'dsh:shell:entry-ready',
  /** 某实例 shell 成功 settle（booted=true）。带实例后缀。 */
  shellSettled: 'dsh:shell:settled',
  /** 一次 boot 以失败落定（error 态；取消/换代不算）。带实例后缀。 */
  shellBootFailed: 'dsh:shell:boot-failed',
  /** web boot 内核 run() 开始（manifest 就绪后）。 */
  webRunStart: 'dsh:boot:run-start',
  /** immediately 层预取完成（chamber 入口 bundle 已求值/注册）。 */
  webPrefetch: 'dsh:boot:prefetch',
  /** 全部 loader 行（含 kernel-adopted 与 extra rows）创建完成。 */
  webRowsCreated: 'dsh:boot:rows-created',
  /** loader.await() 返回（entry 激活完成）。 */
  webLoaderAwaited: 'dsh:boot:loader-awaited',
  /** uiRenderer.mount 注入完成（真实 UI 挂载点交给渲染器行）。 */
  webMounted: 'dsh:boot:mounted',
  /** boot 内核 run() 干净路径落定（uiRenderer 挂载完成，settle 或失败呈现
   * 前的最后 await 已过；失败路径见 webFailed）。 */
  webSettled: 'dsh:boot:settled',
  /** boot 链异常被内核 catch（run() 按设计 resolve——失败经 entry.bootError
   * 呈现给 shell，从不向调用方抛出；本标记指示 catch 分支被触发）。 */
  webFailed: 'dsh:boot:failed',
} as const

export type PerfMarkName = (typeof PERF_MARKS)[keyof typeof PERF_MARKS]

/** 零成本守卫埋点。detail 用于实例维度后缀（见文件头语义约定）。 */
export function perfMark(name: PerfMarkName, detail?: string): void {
  try {
    if (typeof performance !== 'undefined' && typeof performance.mark === 'function') {
      performance.mark(detail === undefined ? name : `${name}:${detail}`)
    }
  } catch {
    // User Timing 失败不影响任何业务路径。
  }
}
