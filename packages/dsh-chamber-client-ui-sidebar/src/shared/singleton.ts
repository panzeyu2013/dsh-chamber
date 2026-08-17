/**
 * Shared-singleton guard (2026-08, cross-cutting hardening).
 *
 * chamberBridge, the view-prefs store and the search controller all rely on
 * the vite shared chunk deduplicating their module into ONE page-wide
 * instance. If bundling ever drifts (alias/resolution divergence, chunking
 * changes, a per-boot bundle split), the modules silently duplicate and every
 * cross-ctx feature degrades back to the per-shell divergence this round
 * fixed — with no diagnostic. This guard registers each singleton module in a
 * Symbol.for-keyed GLOBAL registry (Symbol.for is shared across module
 * instances in the same realm, so even a duplicated module copy hits the same
 * registry) and fails loudly on a second instantiation.
 */
const REGISTRY = Symbol.for('dsh-chamber.singleton.instances')

/** Register one shared module; warns loudly if it was already instantiated. */
export function assertSingletonModule(name: string): void {
  // vite dev HMR re-evaluates modules WITHOUT a page reload — the
  // Symbol.for registry survives HMR, so a hot-replaced module would log a
  // false duplicate every time. The shared chunk is deduped by the bundler;
  // drift detection matters in production builds (where HMR is absent).
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
