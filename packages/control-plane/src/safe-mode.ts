/**
 * 安全模式（C4 启动与修复）：`DSH_CHAMBER_SAFE_MODE=1` 时，本次启动跳过
 * chamber 宿主包 seeding，并把同一事实发给页面——静态服务在 index.html 头部注入
 * `window.__DSH_CHAMBER_SAFE_MODE__ = true`，渲染端据此跳过 extra rows 装载。
 *
 * 只影响本次进程：env 不落盘、不改写 dsh profile，下次普通启动自动恢复。它与
 * Electron 侧 packages/desktop/startup-error.ts 的同名 env 契约逐字相同（跨包
 * lockstep 用例钉住）；渲染端的全局名与 packages/renderer/src/safe-mode.ts 相同
 * （注入方/消费方两处字面量由 control-plane 用例锁步）。
 */

/** 安全模式 env 名（与 desktop 侧 SAFE_MODE_ENV 同一字面量）。 */
export const SAFE_MODE_ENV = 'DSH_CHAMBER_SAFE_MODE'

/** 页面侧安全模式全局名（与 renderer/src/safe-mode.ts 同一字面量）。 */
export const SAFE_MODE_GLOBAL = '__DSH_CHAMBER_SAFE_MODE__'

/**
 * 安全模式是否生效（只认 '1'）。
 * @param env - 进程环境或等价映射。
 * @returns true = 本次启动按安全模式运行。
 */
export function isSafeModeEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return env[SAFE_MODE_ENV] === '1'
}
