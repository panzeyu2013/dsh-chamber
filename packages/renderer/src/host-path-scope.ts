/**
 * 桌面宿主路径面的范围门控（composer 的 @ 引用入口）。
 *
 * 原生壳（Electron preload / Swift bridge-shim）暴露上游的
 * \`__DSH_HOST_PATHS__.pathFor(file)\`：拖入/选择文件与文件夹由此变成
 * \`@路径\` 引用而不是上传（上游 apps/desktop/src/preload-app.ts）。但本页是
 * N-ctx 单文档，同一份全局面同时服务本地与远端实例视图——把本地主机的绝对
 * 路径写进**远端**会话草稿是错的（官方桌面只有本机一个宿主，没有这个问题）。
 *
 * 因此每个视图把**屏上**事实发布成文档根上的 \`data-chamber-painted-source\`
 * （\`InstanceView\` 的 \`active\` = App 的 paintedView）；两个 shell 的载体在
 * \`pathFor\` 时同步读它，只有值等于本地实例 id 才返回路径，其余一律 \`''\`
 * （回退上传 / 浏览器文案）。用 painted 而不是选择语义的 active：揭示过渡期
 * 屏上仍是旧视图，drop 落在那个 composer 上。
 *
 * 用文档属性而不是 window 全局：Electron contextIsolation 下 preload 与页面
 * 不共享 JS 全局、但共享 DOM（Swift shim 与页面同 world）。一条标记两端可读，
 * 并沿用 data-platform / data-window-vibrancy 的既有载体形态。
 */

/** 文档根上的门控属性；三处字面量（renderer 发布 + preload.cts / bridge-shim.js 读取）
 *  与 'local' 值契约的锁步由 packages/desktop/upstream-seats.test.ts 钉住。 */
export const HOST_PATH_SCOPE_ATTRIBUTE = 'data-chamber-painted-source'

/** 发布屏上来源（屏上视图是唯一写者，在同一提交里随 active/instanceId 变化调用）。 */
export function publishHostPathScope(sourceId: string): void {
  if (typeof document === 'undefined') return
  document.documentElement.setAttribute(HOST_PATH_SCOPE_ATTRIBUTE, sourceId)
}

/**
 * 屏上来源离开时只清自己写的值（compare-and-clear）：同一次提交里新屏上视图可能已经写了
 * 新值，无条件 removeAttribute 会把它擦掉（React 的 layout destroy/mount 顺序不保证，
 * 只在值仍等于自己时才清）。
 */
export function clearHostPathScope(sourceId: string): void {
  if (typeof document === 'undefined') return
  if (document.documentElement.getAttribute(HOST_PATH_SCOPE_ATTRIBUTE) === sourceId) {
    document.documentElement.removeAttribute(HOST_PATH_SCOPE_ATTRIBUTE)
  }
}
