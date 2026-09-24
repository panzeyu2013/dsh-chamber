/**
 * dsh CLI 入口解析的单一来源。
 *
 * 一个 dsh 工作区只有两种入口形状：已安装 npm 产物
 * (node_modules/@deepseek-ai/dsh/lib/bin.js，直接 node 执行) 与 dev 源码
 * (apps/cli/src/bin.ts，经 tsx loader)；两者都不存在即非工作区。gateway 的
 * isDshWorkspace / plugins-tasks 启动都派生自本函数。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** 一次 dsh CLI 入口解析：入口路径 + 启动形状 + 工作区布局标记。 */
export interface DshCliEntryResolution {
  entry: string
  /** dev 源码形状需要 --import tsx/esm 前缀。 */
  viaTsx: boolean
  layout: 'installed' | 'source'
}

/** 已安装产物优先、dev 源码次之；都不存在 → null（非 dsh 工作区）。 */
export function resolveDshCliEntry(workspace: string): DshCliEntryResolution | null {
  const installed = join(workspace, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (existsSync(installed)) return { entry: installed, viaTsx: false, layout: 'installed' }
  const source = join(workspace, 'apps', 'cli', 'src', 'bin.ts')
  if (existsSync(source)) return { entry: source, viaTsx: true, layout: 'source' }
  return null
}

/** 目录是否是一个可启动的 dsh 工作区（由 {@link resolveDshCliEntry} 派生）。 */
export function isDshWorkspace(dir: string): boolean {
  return resolveDshCliEntry(dir) !== null
}
