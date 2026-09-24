/**
 * Shared-singleton guard for the page-wide singletons (chamberBridge, view-prefs, search
 * controller), which rely on the vite shared chunk deduplicating their module into ONE instance;
 * bundling drift would silently duplicate them and degrade every cross-ctx feature to per-shell
 * divergence. The guard registers each module in a Symbol.for-keyed GLOBAL registry (shared across
 * module instances in the same realm) and reports a second instantiation via console.error.
 * Diagnostic only — drift must be fixed in the build config.
 */
const REGISTRY = Symbol.for('dsh-chamber.singleton.instances')

/** Register one shared module; reports a duplicate instantiation (diagnostic only — it cannot fix drift). */
export function assertSingletonModule(name: string): void {
  // HMR re-evaluates modules without a reload while the registry survives, so a
  // hot-replaced module would log a false duplicate; detection targets builds.
  if (typeof import.meta !== 'undefined' && (import.meta as { hot?: unknown }).hot !== undefined) return
  const global = globalThis as unknown as Record<symbol, Record<string, boolean>>
  const registry = global[REGISTRY] ?? (global[REGISTRY] = {})
  if (registry[name] === true) {
    console.error(
      `[dsh-chamber] 共享单例模块 "${name}" 被实例化多次——跨 ctx 共享已失效 `
      + '(vite shared chunk 去重被破坏；chamberBridge/视图偏好/搜索的跨来源一致性将回归 per-shell 分裂)。请检查打包配置。',
    )
  } else {
    registry[name] = true
  }
}
