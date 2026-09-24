/**
 * 内建 dsh 锚点版本读取的单一来源。
 *
 * apply-phase 以「切换来源」的真实 semver 作为快照名，锚点工作区必须贡献它的
 * @deepseek-ai/dsh 版本。三个候选按优先级：工作区根 package.json 的
 * dependencies[@deepseek-ai/dsh] → 已安装包清单的 version → apps/cli/package.json 的
 * version。读不到/非法继续下一候选，全部失败返回 null——调用方 loud 失败，绝不伪造快照名。
 * 消费方：gateway/src/runtime-manager.ts。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isSafeVersion } from './version-safety.ts'

/** 锚点声明的 dsh 包名（与 registry 通道消费的 DSH_PACKAGE_NAME 同值）。 */
const DSH_PACKAGE_NAME = '@deepseek-ai/dsh'

/** 读锚点工作区的 dsh 版本；accept 默认 {@link isSafeVersion}（精确 semver，路径安全预校验）。
 *  返回命中的原始字符串（与既有各 flavor 一致，不做 trim）。 */
export function readAnchorVersion(
  anchorPath: string,
  accept: (raw: string) => boolean = isSafeVersion,
): string | null {
  const candidates = [
    join(anchorPath, 'package.json'),
    join(anchorPath, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    join(anchorPath, 'apps', 'cli', 'package.json'),
  ]
  for (const candidate of candidates) {
    try {
      const manifest = JSON.parse(readFileSync(candidate, 'utf8')) as {
        version?: unknown
        dependencies?: Record<string, unknown>
      }
      const version = candidate === candidates[0]
        ? manifest.dependencies?.[DSH_PACKAGE_NAME]
        : manifest.version
      if (typeof version === 'string' && accept(version)) return version
    } catch {
      // 读不到或非法继续下一候选；全部失败保持 null（调用方 loud 失败）。
    }
  }
  return null
}
