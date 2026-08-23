/**
 * 运行时附属物裁剪（bundle-dsh 专用，抽为独立模块以便对任意目录直接验证）。
 *
 * 清理运行期不需要的内容（安装期/构建期产物）：
 * - node-pty 的构建源料（deps/third_party/src/scripts/typings/binding.gyp）
 *   与异平台预编译归档：node-pty@1.1 的运行时二进制**只随包自带**于
 *   prebuilds/<platform>/pty.node（无 build/Release），loader 按
 *   build/Release → build/Debug → prebuilds/<platform> 顺序加载——因此保留
 *   当前平台的 prebuilds 子目录，只删其余平台（darwin-x64/win32/linux…）
 * - mistralai / openai 的 TS 源码、示例、测试（运行时只用编译产物 esm|lib）
 * - 全树测试/示例/基准/CI 目录（test/tests/__tests__/fixtures/examples/
 *   benchmark/.github 等）与文档/许可/CI 配置文件（*.md、LICENSE、
 *   CHANGELOG、NOTICE、dotfiles、tsconfig*.json、*.test.* 与 *.spec.*）——
 *   运行期零使用。除缩减体积外，这直接关系 Windows 安装体验：NSIS 安装器
 *   要**逐文件**解压这些内容（Windows Defender 实时扫描每个新建文件会把
 *   安装拖到"看起来卡死"，且文件被锁时安装器会进入"重解压→再拷贝"的重试
 *   循环，进度条来回反复）——文件数越少，安装越快、被锁触发循环的概率越低。
 * - 全树 *.d.ts / *.d.cts / *.d.mts / *.map（类型声明与源码映射，运行期零使用）
 *
 * 版本无关：包级特化规则（node-pty/mistralai/openai）同时覆盖 hoisted
 * （顶层实体目录）与 isolated（.pnpm/<name>@<ver>[_peer]/node_modules/<name>）
 * 两种 pnpm 布局，找不到（版本重构）时静默跳过；通用规则全树生效。
 * 正确性由 bundle-dsh 安装后的冒烟检查兜底。
 */
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/** 运行期零使用的目录名（测试/示例/基准/CI 附属物）——整目录删除。注意
 * 只收"语义明确为附属物"的名字：yaml 的 `dist/doc/` 是 Document 模型的
 * 运行时代码（目录名 doc 但实际是代码），因此 `doc`/`docs` 不进此表，文档
 * 文件由 PRUNE_FILE_PATTERNS 的 *.md 规则单独清理。 */
export const PRUNE_DIR_NAMES = new Set([
  'test', 'tests', '__tests__', '__snapshots__', 'fixtures', 'test-fixtures',
  'examples', 'example', 'benchmark', 'bench', 'perf', 'coverage',
  '.github', '.nyc_output',
])

/** 运行期零使用的文件模式（文档/许可/CI 配置/测试文件/构建中间产物）。 */
export const PRUNE_FILE_PATTERNS = [
  /\.md$/i,
  /^(licen[cs]e|notice|authors|patents|copying)(\.|$)/i,
  /\.(test|spec)\.(js|cjs|mjs|mts|cts|ts|tsx|jsx)$/i,
  /^tsconfig.*\.json$/,
  /^\.(gitignore|npmignore|editorconfig|prettierrc.*|eslintrc.*|eslintignore|prettierignore|babelrc.*|yarnrc|npmrc|gitattributes|dockerignore|travis\.yml|appveyor\.yml|nycrc.*|gitmodules)$/,
  /\.tsbuildinfo$/,
]

/**
 * 对已安装的 pnpm 运行时树执行裁剪（原地删除）。
 * @param root - 安装根（内含 node_modules/.pnpm，如 bundle-dsh 的 work 目录或
 *   已封装的 vendor/dsh）。
 * @returns {{removedFiles: number, removedDirs: number}} — 删除的文件数
 *   （含整目录内的）与整目录数。
 */
export function pruneRuntimeArtifacts(root) {
  const pnpmDir = join(root, 'node_modules', '.pnpm')

  /**
   * 某包在树里的全部实体目录：hoisted 布局（node-linker=hoisted，顶层为真实
   * 目录）与 isolated 布局（顶层为符号链接、实体在 .pnpm/<name>@<ver>[_peer]/
   * node_modules/<name>）都覆盖；用 Set 去重（两种布局互斥，去重仅为防御）。
   * @param rel - 包相对 node_modules 的路径（如 'node-pty'、'@mistralai/mistralai'）。
   */
  function packageDirs(rel) {
    const dirs = new Set()
    const top = join(root, 'node_modules', rel)
    if (existsSync(top)) dirs.add(top)
    let pnpmEntries = []
    try {
      pnpmEntries = readdirSync(pnpmDir)
    } catch { /* hoisted 布局可能没有 .pnpm 目录 */ }
    for (const entry of pnpmEntries) {
      const pkg = join(pnpmDir, entry, 'node_modules', rel)
      if (existsSync(pkg)) dirs.add(pkg)
    }
    return [...dirs]
  }

  for (const pkg of packageDirs('node-pty')) {
    for (const sub of ['deps', 'third_party', 'src', 'scripts', 'typings', 'binding.gyp']) {
      rmSync(join(pkg, sub), { recursive: true, force: true })
    }
    const prebuilds = join(pkg, 'prebuilds')
    if (existsSync(prebuilds)) {
      const current = `${process.platform}-${process.arch}`
      for (const entry of readdirSync(prebuilds)) {
        if (entry !== current) rmSync(join(prebuilds, entry), { recursive: true, force: true })
      }
    }
  }
  for (const rel of ['@mistralai/mistralai', 'openai']) {
    for (const pkg of packageDirs(rel)) {
      for (const sub of ['src', 'examples', 'tests']) rmSync(join(pkg, sub), { recursive: true, force: true })
    }
  }

  let removedFiles = 0
  let removedDirs = 0
  const countFiles = (dir) => {
    let n = 0
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) n += countFiles(full)
      else n += 1
    }
    return n
  }
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (PRUNE_DIR_NAMES.has(entry.name)) {
          removedFiles += countFiles(full)
          removedDirs += 1
          rmSync(full, { recursive: true, force: true })
          continue
        }
        walk(full)
      } else if (
        PRUNE_FILE_PATTERNS.some((pattern) => pattern.test(entry.name))
        || /\.d\.(ts|cts|mts)$/.test(entry.name)
        || entry.name.endsWith('.map')
      ) {
        rmSync(full, { force: true })
        removedFiles += 1
      }
    }
  }
  walk(root)
  return { removedFiles, removedDirs }
}
