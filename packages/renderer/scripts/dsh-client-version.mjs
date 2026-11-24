/**
 * G02：账号客户端元数据所需的 `DSH_CLIENT_VERSION` 单源。
 *
 * WHY. 官方账号 UI（`@deepseek-ai/dsh-client-ui-settings-account` 的
 * `client-metadata.ts`）在每次账号 RPC 前都会读 `process.env.DSH_CLIENT_VERSION`；
 * 缺值直接抛错（`this client build carries no DSH_CLIENT_VERSION`）。上游 desktop
 * 在构建期把仓库版本内联成 define（`apps/desktop/tsdown.config.ts:26-34`），我们的
 * 替换构建没有那条注入面；而 Vite 6.4.x 对非 lib 客户端构建会把 `process.env`
 * 折成 `{}`，于是运行期恒缺值。
 *
 * WHAT. 本模块只做一件事：从**已提交的随包 dsh 运行时锁文件**
 * （`packages/desktop/vendor/dsh/pnpm-lock.yaml`）的根 importer 读取
 * `@deepseek-ai/dsh` 的版本。锁文件是 pin 的运行时锚（随仓库提交），而
 * `bundle:dsh` 生成的运行树清单不入库（clean checkout 不存在），所以版本源必须
 * 是锁文件——这同时避免版本字面量漂移。
 *
 * 与 `packages/desktop/scripts/bundle-dsh.mjs` 的 `lockfileDshVersion` 的关系：
 *  - 该脚本用「整个 lockfile 文本上的首个 `@deepseek-ai/dsh@<semver>` 正则命中」取
 *    版本（`packages:` 区的安装条目也可能先于 importer 命中），取不到时回退到写死的
 *    运行时锚字面量（C10 anchor）；
 *  - 本模块刻意更严格：只读**根 importer** 的 `@deepseek-ai/dsh` 声明，缺项/结构不符/
 *    非法版本一律 fail loud，绝不回退任何字面量。
 *  已提交 lockfile 上两者当前解析出同一版本（`dsh-client-version.test.mjs` 的漂移护栏
 *  逐文本比对，并用「packages 区先出现其它版本」的 fixture 钉住两侧语义差异）；若锁
 *  文件布局让两者分叉，护栏先红，需据此裁决而不是静默改一侧。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 仓库根（scripts/ 距根三层）。 */
const DEFAULT_ROOT = fileURLToPath(new URL('../../../', import.meta.url))

/** 已提交的随包 dsh 运行时锁文件在仓库内的相对路径（版本单源）。 */
export const DSH_RUNTIME_LOCKFILE_RELATIVE = 'packages/desktop/vendor/dsh/pnpm-lock.yaml'

/** 精确 semver（与 bundle-dsh 的 EXACT_SEMVER 同一形状，那个常量用于 env 校验；不接受 range/latest/URL）。 */
const EXACT_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u

/** 一行的前导空格数（YAML 缩进即层级）。 */
function indentOf(line) {
  return line.length - line.trimStart().length
}

/** 去引号并裁空白；`undefined` 原样返回。 */
function unquote(value) {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) return trimmed.slice(1, -1)
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) return trimmed.slice(1, -1)
  return trimmed
}

/**
 * 从 pnpm-lock.yaml 文本里取根 importer 的 `@deepseek-ai/dsh` 精确版本。
 *
 * 结构（pnpm v9）：`importers:` → `  .:` → `    dependencies:` →
 * `      '@deepseek-ai/dsh':` → `        specifier: X` / `version: X(peer)`。
 * 只认 importer 面：`packages:` 段的 `@deepseek-ai/dsh@X` 是安装解析结果，
 * 不能替代「应用依赖声明」的事实。
 * @param text - 锁文件全文。
 * @param path - 诊断用路径。
 * @returns 精确 semver 版本串。
 * @throws 缺 importers / 缺根 importer / 缺依赖条目 / 空或非法版本时抛错。
 */
function readLockfileImporterVersion(text, path) {
  const lines = text.split(/\r?\n/u)
  const importersAt = lines.findIndex(line => /^importers:\s*$/u.test(line))
  if (importersAt < 0) {
    throw new Error(`dsh client version: ${path} 缺 importers 段（不是可识别的 pnpm-lock.yaml）`)
  }
  const importers = []
  for (let index = importersAt + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '' || indentOf(line) > 0) importers.push(line)
    else break
  }
  const rootAt = importers.findIndex(line => /^ {2}\.:$/u.test(line))
  if (rootAt < 0) {
    throw new Error(`dsh client version: ${path} 的 importers 段缺根 importer（'.'）`)
  }
  const rootIndent = indentOf(importers[rootAt])
  const rootBlock = []
  for (let index = rootAt + 1; index < importers.length; index += 1) {
    const line = importers[index]
    if (line.trim() !== '' && indentOf(line) <= rootIndent) break
    rootBlock.push(line)
  }
  const dependencyAt = rootBlock.findIndex(line => /^\s+(?:'@deepseek-ai\/dsh'|"@deepseek-ai\/dsh"|@deepseek-ai\/dsh):\s*$/u.test(line))
  if (dependencyAt < 0) {
    throw new Error(`dsh client version: ${path} 的根 importer 没有 '@deepseek-ai/dsh' 依赖条目`)
  }
  const dependencyIndent = indentOf(rootBlock[dependencyAt])
  const entry = []
  for (let index = dependencyAt + 1; index < rootBlock.length; index += 1) {
    const line = rootBlock[index]
    if (line.trim() !== '' && indentOf(line) <= dependencyIndent) break
    entry.push(line)
  }
  const field = (name) => {
    const matches = entry
      .map(line => new RegExp(`^\\s+${name}:\\s*(.*)$`, 'u').exec(line))
      .filter(match => match !== null)
    return matches.length === 0 ? undefined : unquote(matches[matches.length - 1][1])
  }
  const specifier = field('specifier')
  const installed = field('version')
  // workspace/link/registry-range 之类的 specifier 不是精确版本：退回安装解析值
  // （peer 后缀 `(...)` 不是版本的一部分）。
  const candidate = specifier !== undefined && EXACT_SEMVER.test(specifier)
    ? specifier
    : (installed === undefined ? undefined : installed.replace(/\(.*\)$/u, ''))
  if (candidate === undefined || candidate === '') {
    throw new Error(`dsh client version: ${path} 的 '@deepseek-ai/dsh' 条目缺 specifier/version`)
  }
  if (!EXACT_SEMVER.test(candidate)) {
    throw new Error(`dsh client version: ${path} 的 '@deepseek-ai/dsh' 版本不是精确 semver（实际 ${JSON.stringify(candidate)}）`)
  }
  return candidate
}

/**
 * 读取随包 dsh 运行时的客户端版本（`@deepseek-ai/dsh` 精确版本）。
 * @param root - 仓库根目录（测试注入临时夹具用）。
 * @returns 精确 semver 版本串（形如 `X.Y.Z-<stage>.N`）。
 * @throws 锁文件缺失/不可读/结构不符/版本缺项或非法时抛错（绝不返回空值）。
 */
export function resolveDshClientVersion(root = DEFAULT_ROOT) {
  const lockfilePath = join(root, DSH_RUNTIME_LOCKFILE_RELATIVE)
  let text
  try {
    text = readFileSync(lockfilePath, 'utf8')
  } catch (error) {
    throw new Error(
      `dsh client version: 读不到已提交的随包 dsh 运行时锁文件 ${lockfilePath}（${String(error)}）`,
      { cause: error },
    )
  }
  return readLockfileImporterVersion(text, lockfilePath)
}
