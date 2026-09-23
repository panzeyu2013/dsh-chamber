#!/usr/bin/env node
/**
 * build-control-plane.mjs —— 将 @dsh-chamber/control-plane 打包为**自包含**的
 * ESM 单文件（desktop/dist/control-plane/index.js），供打包进 Electron 应用与
 * Swift sidecar 装配目录。
 *
 * 为什么必须 bundle 而不是逐文件 tsc emit（R6 第 2 阶段的 must-fix）：
 *   - 打包树把 workspace 依赖（@dsh-chamber/dsh-chamber-wire）以 TS 源码形态放进
 *     node_modules，而 Node 22.18+ 的类型擦除对 node_modules 下的文件不生效
 *     （ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING）——tsc 产物残留的裸说明符
 *     `@dsh-chamber/dsh-chamber-wire/plugin-manifest` 在 packaged app 首次加载
 *     control-plane 时即失败（阶段 1 已实证；仓库内直接 node import 为
 *     ERR_MODULE_NOT_FOUND）；
 *   - sidecar 装配目录（design 25 §3.2）根本没有 node_modules 树，裸说明符
 *     同样不可解析。
 *
 * 与 gateway dist 构建（packages/gateway/scripts/build.mjs）同规：platform=node、
 * format=esm、target=node22、workspace 依赖与运行时依赖（ws）全部内联，产物只
 * import `node:` 内建。捆绑 CJS 的 ws 时会静态 require('events') 等内建，所以与
 * gateway 相同，用 createRequire banner 提供 __require 的解析器。
 *
 * 步骤：
 *   1. `tsc -p tsconfig.control-plane.build.json --noEmit` —— 编译闭包/类型校验
 *      （include 覆盖 index.ts 传递引用的全部源文件；无 emit，emit 由第 2 步接管）；
 *   2. esbuild 打包 src/index.ts → dist/control-plane/index.js（清空重建）；
 *   3. 产物断言：文件存在，且**没有非 node: 说明符**——打包态的最终判据是
 *      「这个文件自己可被 node import」，而不是「tsc 通过」。
 *
 * 运行期由 control-plane-module.ts 以相对入口 `./dist/control-plane/index.js`
 * 加载（packaged Electron 与 sidecar 两条路径共用，见该 facade 的说明）。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadEsbuild } from '../../../scripts/lib/esbuild.mjs'

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(desktopDir, '..', '..')
// Invoke the TypeScript JS entry through the current Node binary instead of
// relying on package-manager-generated `.bin` shims. This is cross-platform
// and also works in frozen/offline installs that materialize package links but
// intentionally omit executable shims.
const tscEntry = path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc')
const project = path.join(desktopDir, 'tsconfig.control-plane.build.json')
const entrySource = path.join(repoRoot, 'packages', 'control-plane', 'src', 'index.ts')
const outDir = path.join(desktopDir, 'dist', 'control-plane')
const entry = path.join(outDir, 'index.js')

/**
 * Every import/export specifier of a flat ESM module: static `from` clauses
 * (single- OR multi-line), side-effect imports and dynamic `import(...)`
 * calls. Statement anchoring (`start of file | newline | ';'`) plus the
 * `[^;]*?` body keep bundled template-literal text from being read as an
 * import; the esbuild re-bundle check below is the authoritative ruler and
 * this scan only names specifiers in diagnostics.
 * @param {string} source - emitted module text.
 * @returns {string[]} specifiers in first-seen order (deduplicated).
 */
export function runtimeImportSpecifiers(source) {
  const found = new Set()
  for (const match of source.matchAll(/(?:^|[\n;])\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/gu)) found.add(match[1])
  for (const match of source.matchAll(/(?:^|[\n;])\s*import\s*\(?\s*["']([^"']+)["']/gu)) found.add(match[1])
  return [...found]
}

/**
 * The package-time invariant: a self-contained entry may only reach
 * `node:` builtins. Anything else (a bare workspace specifier, a relative
 * hop out of the artifact) is a broken pack even when the repo tree happens
 * to resolve it.
 * @param {readonly string[]} specifiers - {@link runtimeImportSpecifiers} output.
 * @returns {string[]} specifiers that are not node builtins.
 */
export function nonBuiltinSpecifiers(specifiers) {
  return specifiers.filter(specifier => !specifier.startsWith('node:'))
}

/**
 * AUTHORITATIVE self-containment check: re-bundle the emitted entry with the
 * same bundler and require that it resolves to itself ALONE. Any surviving
 * import — a bare workspace specifier, a relative hop — becomes a second
 * metafile input (or fails resolution loudly), so multi-line imports and
 * strings can never fool the check the way a text scan can. `node:` builtins
 * stay external on `platform: 'node'` and are not inputs.
 * @param {object} esbuild - the loaded esbuild module.
 * @param {string} entryPath - absolute path of the emitted single-file entry.
 * @param {string} workingDir - absWorkingDir for the re-bundle.
 * @returns {Promise<string[]>} metafile input keys (paths relative to workingDir).
 */
export async function residualBundleInputs(esbuild, entryPath, workingDir) {
  const result = await esbuild.build({
    entryPoints: [entryPath],
    absWorkingDir: workingDir,
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    logLevel: 'silent',
    metafile: true,
  })
  return Object.keys(result.metafile.inputs)
}

async function main() {
  if (!existsSync(tscEntry)) {
    console.error('[build-control-plane] 未找到 TypeScript。请先在仓库根目录执行 pnpm install。')
    process.exit(1)
  }
  if (!existsSync(entrySource)) {
    console.error(`[build-control-plane] 未找到 control-plane 入口：${entrySource}`)
    process.exit(1)
  }

  // 1. 编译闭包/类型校验（noEmit：emit 由 esbuild 接管）。
  const checked = spawnSync(process.execPath, [tscEntry, '-p', project, '--noEmit'], {
    stdio: 'inherit',
    shell: false,
  })
  if (checked.error || checked.status !== 0) {
    console.error(`[build-control-plane] 编译闭包校验失败（exit ${checked.status ?? 'null'}）`)
    process.exit(checked.status ?? 1)
  }

  // 2. esbuild 打包（清空重建：改名/删模块后旧产物绝不留在 dist）。
  rmSync(outDir, { recursive: true, force: true })
  let esbuild
  try {
    esbuild = await loadEsbuild()
  } catch (error) {
    console.error(`[build-control-plane] 无法加载 esbuild（经 packages/renderer 的 vite 树解析）：${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
  await esbuild.build({
    entryPoints: [entrySource],
    absWorkingDir: desktopDir,
    outfile: entry,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'info',
    // 纯 ESM 输出没有 ambient `require`：捆绑进来的 CJS（ws）对 node 内建的
    // 静态 require 会走 esbuild 的 __require 兜底，banner 提供解析器（与
    // packages/gateway/scripts/build.mjs 同一条理由与同一段实现）。
    banner: {
      js: 'import { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);',
    },
  })

  // 3. 产物断言：存在 + 自包含（打包态的最终判据：「这个文件自己可被 node
  // import」，而不是「tsc 通过」）。重打包检查用真解析器判定——产物若有任何
  // 存活的 import（裸包名或相对跳转），metafile 输入就不止它自己；文本扫描只
  // 用于诊断命名。
  if (!existsSync(entry)) {
    console.error(`[build-control-plane] 打包异常：${entry} 不存在`)
    process.exit(1)
  }
  let inputs
  try {
    inputs = await residualBundleInputs(esbuild, entry, desktopDir)
  } catch (error) {
    // An unresolvable surviving specifier fails the re-bundle itself — the
    // loudest possible form of the same verdict.
    console.error(`[build-control-plane] 产物自包含检查失败（重建无法解析残留说明符）：${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
    process.exit(1)
  }
  const expectedInput = path.relative(desktopDir, entry).split(path.sep).join('/')
  if (inputs.length !== 1 || inputs[0] !== expectedInput) {
    const named = nonBuiltinSpecifiers(runtimeImportSpecifiers(readFileSync(entry, 'utf8')))
    console.error(
      `[build-control-plane] 产物不是自包含单文件：重建输入 = ${JSON.stringify(inputs)}（期望 [${JSON.stringify(expectedInput)}]）`
      + (named.length > 0 ? `；非内建说明符：${named.join(', ')}` : ''),
    )
    process.exit(1)
  }
  console.log('[build-control-plane] control-plane 已 esbuild 打包为自包含 ESM -> dist/control-plane/index.js')
}

const isEntry = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isEntry) await main()
