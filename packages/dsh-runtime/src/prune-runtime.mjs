/**
 * 运行时附属物裁剪（bundle-dsh 与运行期安装器共用，抽为独立模块以便对任意目录直接验证）。
 *
 * 清理运行期不需要的内容（安装期/构建期产物）：
 * - node-pty 的构建源料（deps/third_party/src/scripts/typings/binding.gyp）
 *   与异平台预编译归档：node-pty@1.1 的运行时二进制**只随包自带**于
 *   prebuilds/<platform>/pty.node（无 build/Release），loader 按
 *   build/Release → build/Debug → prebuilds/<platform> 顺序加载——因此保留
 *   当前平台的 prebuilds 子目录，只删其余平台（darwin-x64/win32/linux…）
 * - mistralai / openai 的 TS 源码、示例、测试（运行时只用编译产物 esm|lib）
 * - 全树测试/示例/基准/CI 目录（test/tests/__tests__/fixtures/examples/
 *   benchmark/.github 等）与文档/许可/CI 配置文件（README/CHANGELOG/
 *   LICENSE、NOTICE、dotfiles、tsconfig*.json、*.test.* 与 *.spec.*）——
 *   运行期零使用。**例外：`docs/` 下的 Markdown 保留**——dsh 0.2.2-alpha.3
 *   起，插件管理器的 bundle 详情页在运行期读取 locale `meta.detail` 指名的
 *   文档，随安装分发的 bundle 都把它放在 `docs/DETAIL*.md`；删掉它会让详情页
 *   以 `invalid` 失败（「插件声明的详细介绍文件无效」，重试也无效）。保留整个
 *   `docs/` 的 Markdown 不依赖上游的文档命名习惯：新增一份 `docs/` 文档无需
 *   再加规则；其它位置的 Markdown 仍按原规则裁掉。
 *   除缩减体积外，这直接关系 Windows 安装体验：NSIS 安装器要**逐文件**解压
 *   这些内容（Windows Defender 实时扫描每个新建文件会把安装拖到"看起来
 *   卡死"，且文件被锁时安装器会进入"重解压→再拷贝"的重试循环，进度条来回
 *   反复）——文件数越少，安装越快、被锁触发循环的概率越低。保留面本身：
 *   钉版声明目标 34 个（约 4 KiB），按目录还会留下第三方包自带的 `docs/`
 *   文档（同钉版 `undici@8.11.2` 一家 46 个 / 约 405 KiB），整树约 80 个 /
 *   0.4 MiB，约为 hoisted 树文件数的 0.25%。**已知例外**：附属物目录名
 *   （{@link PRUNE_DIR_NAMES}）在 `docs/` 内仍整目录删除（`docs/test/**`
 *   等是测试素材而不是文档）——声明的详情文档若落在那里，`bundle-dsh` 的
 *   核对会让封装失败，不会静默发出去（design 18 §3.7）。
 * - 全树 *.d.ts / *.d.cts / *.d.mts / *.map（类型声明与源码映射，运行期零使用）
 *
 * 版本无关：包级特化规则（node-pty/mistralai/openai）同时覆盖 hoisted
 * （顶层实体目录）与 isolated（.pnpm/<name>@<ver>[_peer]/node_modules/<name>）
 * 两种 pnpm 布局，找不到（版本重构）时静默跳过；通用规则全树生效。
 * 正确性由 bundle-dsh 安装后的冒烟检查与 `collectDeclaredDetailFiles` 的
 * prune 前后核对兜底（design 18 §4.1）。
 */
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/** 运行期零使用的目录名（测试/示例/基准/CI 附属物）——整目录删除。注意
 * 只收"语义明确为附属物"的名字：yaml 的 `dist/doc/` 是 Document 模型的
 * 运行时代码（目录名 doc 但实际是代码），因此 `doc`/`docs` 不进此表，文档
 * 文件由 PRUNE_FILE_PATTERNS 的 *.md 规则单独清理（`docs/` 下的 Markdown
 * 是详情页运行时内容，见 {@link RUNTIME_DOCUMENT_DIR}）。整目录删除先于
 * 文件规则，所以 `docs/` 内的同名目录照样整体删除（design 18 §3.7 的已知
 * 例外）。 */
const PRUNE_DIR_NAMES = new Set([
  'test', 'tests', '__tests__', '__snapshots__', 'fixtures', 'test-fixtures',
  'examples', 'example', 'benchmark', 'bench', 'perf', 'coverage',
  '.github', '.nyc_output',
])

/**
 * 运行期文档目录：其中的 Markdown 是插件管理器 bundle 详情页的运行时内容
 * （locale `meta.detail` 指名），任何深度都保留；目录本身不整体删，目录内
 * 其它文件模式照旧。名字按大小写不敏感匹配——macOS/Windows 宿主上 `Docs/`
 * 与 `docs/` 是同一个目录，规则不该因打包容器的文件系统而分叉。
 */
const RUNTIME_DOCUMENT_DIR = 'docs'

/** @param name - 目录名。 */
const isRuntimeDocumentDir = (name) => name.toLowerCase() === RUNTIME_DOCUMENT_DIR

/**
 * 裁剪规则集版本：保留面或删除面一变就递增。`bundle-dsh` 把它写进封装
 * manifest 的 `dsh.pruneRevision`，幂等跳过据此判定——否则同版本同平台的旧
 * 树会被直接复用，规则变更永远进不了安装包。
 */
export const PRUNE_RULES_REVISION = 1

/** Markdown 文件：除 `docs/` 下以外运行期零使用。 */
const MARKDOWN_FILE = /\.md$/i

/** 运行期零使用的文件模式（文档/许可/CI 配置/测试文件/构建中间产物）。 */
const PRUNE_FILE_PATTERNS = [
  MARKDOWN_FILE,
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
  /** @param inDocumentDir - 当前目录位于某个 docs/ 之下（其 Markdown 是运行时内容）。 */
  const walk = (dir, inDocumentDir = false) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (PRUNE_DIR_NAMES.has(entry.name)) {
          removedFiles += countFiles(full)
          removedDirs += 1
          rmSync(full, { recursive: true, force: true })
          continue
        }
        walk(full, inDocumentDir || isRuntimeDocumentDir(entry.name))
      } else if (
        !(inDocumentDir && MARKDOWN_FILE.test(entry.name))
        && (
          PRUNE_FILE_PATTERNS.some((pattern) => pattern.test(entry.name))
          || /\.d\.(ts|cts|mts)$/.test(entry.name)
          || entry.name.endsWith('.map')
        )
      ) {
        rmSync(full, { force: true })
        removedFiles += 1
      }
    }
  }
  walk(root)
  return { removedFiles, removedDirs }
}

/**
 * 收集树内各包 locale/*.json 的 meta.detail 实际存在的目标文件，供封装期核对
 * prune 没有删掉运行期文档。只认上游 dsh-plugin-detail 接受的形态：相对路径、
 * 无反斜杠与 scheme、无空段/./..、以 .md|.markdown 结尾；畸形 locale、畸形
 * 声明与不存在的目标静默跳过——那是上游打包的事，prune 只对自己删掉的文件负责。
 * @param root - 安装树根（与 {@link pruneRuntimeArtifacts} 同一入参）。
 * @returns 存在的详情文档绝对路径，去重并按字典序排列。
 */
export function collectDeclaredDetailFiles(root) {
  const found = new Set()
  const collectFrom = (localeDir, packageDir) => {
    let names
    try {
      names = readdirSync(localeDir)
    } catch {
      return
    }
    for (const name of names) {
      if (!name.toLowerCase().endsWith('.json')) continue
      let meta
      try {
        meta = JSON.parse(readFileSync(join(localeDir, name), 'utf8'))?.meta
      } catch {
        continue
      }
      const detail = typeof meta === 'object' && meta !== null ? meta.detail : undefined
      if (typeof detail !== 'string' || detail.trim() === '') continue
      if (detail.includes('\\') || URL.canParse(detail)) continue
      if (detail.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) continue
      if (!/\.(?:md|markdown)$/iu.test(detail)) continue
      const file = join(packageDir, ...detail.split('/'))
      if (existsSync(file)) found.add(file)
    }
  }
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const full = join(dir, entry.name)
      if (entry.name === 'locale') collectFrom(full, dir)
      walk(full)
    }
  }
  walk(root)
  return [...found].sort()
}
