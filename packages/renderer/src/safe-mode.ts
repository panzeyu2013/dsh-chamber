/**
 * 安全模式（C4 启动与修复）页面侧读取：控制面静态服务在 index.html 头部注入
 * `window.__DSH_CHAMBER_SAFE_MODE__ = true`（仅安全模式启动；普通启动不注入，
 * 响应逐字节不变）。为 true 时 shell 跳过 extra rows（dsh profile 里的客户端
 * 插件行）装载——壳仍由 chamber composite 启动，用户可进设置卸载坏插件后普通
 * 重启恢复。
 *
 * 全局名与 env 名是注入方（control-plane/src/safe-mode.ts、static-serving.ts）
 * 与消费方（本模块、shell.ts）之间的字面量契约：跨包 lockstep 用例钉住。
 */

/** 页面侧安全模式全局名（与控制面 `SAFE_MODE_GLOBAL` 同一字面量）。 */
export const SAFE_MODE_GLOBAL = '__DSH_CHAMBER_SAFE_MODE__'

/**
 * 判定注入值是否表示安全模式。
 * @param value - 全局属性的值。
 * @returns true = 只认布尔 true（'1'/缺省/其它一律普通模式）。
 */
export function isSafeModeEnabled(value: unknown): boolean {
  return value === true
}

/**
 * 读取当前页面的安全模式开关。
 * @param scope - 默认 globalThis；测试注入等价对象。
 * @returns true = 本次启动按安全模式运行。
 */
export function readSafeModeFlag(scope: unknown = globalThis): boolean {
  if (typeof scope !== 'object' || scope === null) return false
  return isSafeModeEnabled((scope as Record<string, unknown>)[SAFE_MODE_GLOBAL])
}
