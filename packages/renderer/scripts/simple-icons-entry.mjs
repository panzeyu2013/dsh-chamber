/**
 * simple-icons 的 ESM 入口解析（E1：首屏体积）。
 *
 * 包同时发布两份全量图标表：CJS `index.js`（`require` 导出条件）与 ESM
 * `index.mjs`（`import`/`module` 条件，`sideEffects: false`）。Vite 的
 * `npmFallback` 用 `createRequire(...).resolve()` 解析 bare specifier，命中的
 * 必然是 CJS 入口；Rollup 无法对 CJS 图标表做 tree-shaking，于是 vendor
 * ui-primitives 的 `SiteGlyph.tsx` 只 import 34 个图标，chamber entry 却把全部
 * ~3.4k 个图标（5.2 MB 原始 / 2.1 MB gzip）打进首屏。这里返回 ESM 入口，
 * Rollup 只保留实际 import 的图标。
 *
 * 解析顺序：先按 vendor 消费方（dsh-client-ui-primitives）的安装树解析——这是
 * 本仓实际可达的路径；scripts/ 目录不在 renderer 的依赖树里，直接以本模块
 * require 解析通常会 MODULE_NOT_FOUND。vendor 路径失败再回退调用方传入的
 * require（vite 配置模块自身的解析树）；两条路径都失败时 loud fail（静默回落
 * CJS 会把整包重新带回首屏，而那只会在体积门里变成 warn）。
 */
import { createRequire } from 'node:module'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** renderer 配置模块自己的 require 解析树。 */
const requireFromRenderer = createRequire(import.meta.url)

/** vendor 里唯一 import simple-icons 的消费方包（只读 pin；目录是 symlink 树）。 */
const siteGlyphPackageUrl = new URL(
  '../../../vendor/harness-packages/@deepseek-ai/dsh-client-ui-primitives/',
  import.meta.url,
)

/**
 * 解析 simple-icons 的 ESM 入口文件。
 * @param requireFromConsumer - 调用方 `createRequire` 结果（vite 配置树），只作
 *   回退路径：先走 vendor 消费方安装树（本仓实际可达），失败再回退调用方树。
 * @returns 绝对路径：package.json `exports["."].import`（当前 pin 为 index.mjs）。
 */
export function resolveSimpleIconsEsmEntry(requireFromConsumer = requireFromRenderer) {
  const resolvedCjs = resolveSimpleIconsCjs(requireFromConsumer)
  const packageDir = dirname(resolvedCjs)
  const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
  const rootExport = manifest.exports?.['.']
  const esmRelative = rootExport?.import ?? rootExport?.module
  if (typeof esmRelative !== 'string') {
    throw new Error(
      `simple-icons ${String(manifest.version)}: exports["."] 没有 import/module 入口（只有：`
      + `${Object.keys(rootExport ?? {}).join(', ')}）—— E1 的 ESM 路由需要重新评估`,
    )
  }
  const entry = join(packageDir, esmRelative)
  if (!existsSync(entry)) {
    throw new Error(`simple-icons: exports["."].import 指向 ${entry}，但文件不存在 —— E1 的 ESM 路由需要重新评估`)
  }
  return entry
}

/**
 * 找到 simple-icons 的 CJS 入口（只用来定位包目录，绝不返回给 Vite）。
 * @param requireFromConsumer - 调用方 `createRequire` 结果（备用路径）。
 * @returns CJS 入口（index.js）绝对路径。
 */
function resolveSimpleIconsCjs(requireFromConsumer) {
  try {
    const vendorPackageDir = realpathSync(fileURLToPath(siteGlyphPackageUrl))
    return createRequire(join(vendorPackageDir, 'package.json')).resolve('simple-icons')
  } catch (vendorError) {
    try {
      return requireFromConsumer.resolve('simple-icons')
    } catch (callerError) {
      throw new Error(
        'simple-icons 不可解析（vendor 消费方与调用方两条路径都失败）：'
        + `vendor=${String(vendorError)}; caller=${String(callerError)}`,
        { cause: vendorError },
      )
    }
  }
}
