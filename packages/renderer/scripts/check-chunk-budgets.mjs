#!/usr/bin/env node
/**
 * check-chunk-budgets.mjs — chunk 尺寸预算护栏。
 *
 * 在 `vite build` + `gen-boot-manifest.mjs` 之后运行（依赖 .vite/manifest.json
 * 与已注入 chamber 预载/CSS 链接的 dist/index.html）。度量三个与首屏关键路径
 * 直接相关的原始字节指标：
 *
 *  - mainGraphRaw：主入口（index.html → assets/main-*.js）静态图合计
 *    （递归含 chamber-covered / vendor / 渲染块等共享 chunk）——**硬门**；
 *    主图在主入口求值前整体 evaluate，膨胀直接推迟 App 挂载与整条 boot 链
 *    起点（含本地实例 spawn 触发），是唯一值得硬门的指标。
 *  - chamberEntryRaw：chamber 复合入口文件本体（boot 内 prefetch 求值）——
 *    warn（无硬门：体积随上游 dsh 版本合法漂移，硬门会误伤升级）。
 *  - headCssRaw：dist/index.html 中全部 render-blocking 样式表合计——warn。
 *
 * 校准基线（raw bytes，最新实测见 dist/web/perf-sizes.json，随上游 dsh 版本
 * 与合并内容合法漂移）。0.2.2-alpha.3 代实测（0.2.1-alpha.2 代快照为
 * mainGraph 1,434,814）：mainGraph 1,914,607（App 拆分后的新实测：warn 1,950,000
 * = 实测 +1.8%，fail 2,060,000 = 实测 +7.6%）；chamberEntry 8,443,546（warn 门 = 实测 + ~1%
 * = 8,528,000——该项**有意只有 warn、不设硬门**：体积随上游 dsh 版本合法漂移，
 * 硬门会误伤升级，超限只提示评估拆分/懒化，不阻断构建）；headCss 326,261
 * （warn 门 = 实测 + ~1% = 329,500，同为 warn-only）。阈值不是历史账本：结构改动
 * 落地后按新实测值回填阈值并更新本注释，防止它变成下一份过期注释。
 *
 * 上一版阈值（chamberEntry 7,829,000 / headCss 304,300）量自 0.2.1-alpha.3 代（0.2.2-rc.2 代实测 8,556,539 / 339,104，本版按实测 + ~1% 回填 warn 8,650,000 / 342,500；mainGraph 仍 1,914,607 不动）
 * （实测 7,751,254 / 301,241），此后跨 0.2.1-rc.3、0.2.2-alpha.2、0.2.2-alpha.3 三代
 * pin 未再回填：0.2.2-alpha.2 代构建已到 8,182,347 / 320,696（当时代只 warn 未回填），
 * 0.2.2-alpha.3 到 8,443,546 / 326,261。同一跨度内共享图只 +0.3%（1,908,997 →
 * 1,914,607），增长落在复合入口与首屏样式（covered 行逐代累加，末段是
 * `ui-context-menu` 与其语言表）——故只按实测回填这两个 warn 项，不动 mainGraph 硬门。
 *
 * 输出：每次运行打印三项实测 + 阈值；硬门超限或资产缺失/未解析 exit 1
 * （build 失败）；并把本次构建快照 perf-sizes.json 写入 dist/web（vite
 * outDir，下次 build 覆写——跨构建趋势请存档代表点，口径见
 * scripts/perf/README.md）。gzip 列 = node gzipSync
 * level-6 自洽口径，仅脚本内可比。
 */
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
// G3（design 21 §7；TODO D§2.2）：本次构建的成功末尾写 .build-manifest.json
// （输入摘要 + 工具链 + 输出指纹）。writer/verifier 的规则单源在
// packages/desktop/scripts/build-manifest.mjs —— dist/web 是 renderer 包的
// vite outDir，而一致性比对在 verify-artifact-freshness（非注册门）。
import { BUILD_MANIFEST_FILE, writeWebDistBuildManifest } from '../../desktop/scripts/build-manifest.mjs'

const WEB_DIST = fileURLToPath(new URL('../../desktop/dist/web/', import.meta.url))
const VITE_MANIFEST = fileURLToPath(new URL('../../desktop/dist/web/.vite/manifest.json', import.meta.url))
const INDEX_HTML = fileURLToPath(new URL('../../desktop/dist/web/index.html', import.meta.url))
const SIZES_OUT = fileURLToPath(new URL('../../desktop/dist/web/perf-sizes.json', import.meta.url))

/** 阈值（raw bytes）。校准基线见文件头注释。 */
const THRESHOLDS = {
  mainGraphRaw: { warn: 1_950_000, fail: 2_060_000 },
  chamberEntryRaw: { warn: 8_650_000 },
  headCssRaw: { warn: 342_500 },
}

function fail(message) {
  console.error(`check-chunk-budgets: ${message}`)
  process.exit(1)
}

if (!existsSync(VITE_MANIFEST)) fail(`vite manifest missing (${VITE_MANIFEST}) — run the vite build first`)
if (!existsSync(INDEX_HTML)) fail(`dist/index.html missing (${INDEX_HTML})`)

const manifest = JSON.parse(readFileSync(VITE_MANIFEST, 'utf8'))
const rows = Object.values(manifest)

/** 主入口行：HTML 输入（file 形如 assets/main-*.js 的 isEntry 行）。 */
const mainRow = rows.find((row) => row?.isEntry === true && typeof row?.file === 'string' && /^assets\/main-[^/]+\.js$/.test(row.file))
/** chamber 入口行：与 gen-boot-manifest.mjs 同款定位（isEntry + assets/chamber-*.js）。 */
const chamberRow = rows.find(
  (row) => row?.isEntry === true && typeof row?.file === 'string' && /^assets\/chamber-[^/]+\.js$/.test(row.file),
)
if (mainRow === undefined) fail('no main entry row in vite manifest (assets/main-*.js, isEntry)')
if (chamberRow === undefined) fail('no chamber entry row in vite manifest (assets/chamber-*.js, isEntry)')

/** manifest "imports" 是 chunk 名（形如 `_chamber-covered-xxx.js`，偶带 assets/
 * 前缀或深层相对路径）；按 "assets/" + 去前导下划线 归一化解析到 row.file。 */
const byFile = new Map(rows.filter((row) => typeof row?.file === 'string').map((row) => [row.file, row]))
const resolveRow = (name) => {
  if (name.includes('/') && !name.startsWith('assets/')) return undefined // 深层路径不参与首屏静态图
  const norm = name.replace(/^assets\//, '').replace(/^_/, '')
  return byFile.get(name)
    ?? byFile.get(`assets/${norm}`)
    ?? [...byFile.values()].find((row) => row.file === norm || row.file.endsWith(`/${norm}`))
}

function statBytes(relPath) {
  const path = relPath.startsWith('/') ? relPath.slice(1) : relPath
  const full = `${WEB_DIST}${path}`
  if (!existsSync(full)) return null
  return statSync(full).size
}

/** 从入口行沿静态 imports 递归累计文件原始字节与 gzip 字节。缺失/未解析
 * 资产会让硬门 undercount（缺一个大 chunk 反而放行），故一律计数并在末尾
 * fail——构建产物与 manifest 不一致本身就是 build 回归。 */
function graphBytes(entryRow) {
  const visited = new Set()
  const stack = [entryRow]
  let raw = 0
  let gzip = 0
  let missing = 0
  while (stack.length > 0) {
    const row = stack.pop()
    if (row === undefined || visited.has(row.file)) continue
    visited.add(row.file)
    const size = statBytes(row.file)
    if (size === null) {
      console.error(`check-chunk-budgets: missing asset ${row.file}`)
      missing += 1
      continue
    }
    raw += size
    const full = `${WEB_DIST}${row.file}`
    gzip += gzipSync(readFileSync(full)).length
    for (const name of row.imports ?? []) {
      const next = resolveRow(name)
      if (next === undefined) {
        console.error(`check-chunk-budgets: unresolved import ${name} from ${row.file}`)
        missing += 1
        continue
      }
      stack.push(next)
    }
  }
  return { raw, gzip, missing }
}

/** dist/index.html 中全部 render-blocking 样式表（含 gen-boot-manifest 注入的 chamber CSS）。 */
function headCssBytes() {
  const html = readFileSync(INDEX_HTML, 'utf8')
  const hrefs = [...html.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g)].map((m) => m[1])
  let raw = 0
  let gzip = 0
  let missing = 0
  for (const href of hrefs) {
    const path = href.replace(/^\.\//, '').replace(/^\//, '')
    const full = `${WEB_DIST}${path}`
    if (!existsSync(full)) {
      console.error(`check-chunk-budgets: missing head css ${href}`)
      missing += 1
      continue
    }
    raw += statSync(full).size
    gzip += gzipSync(readFileSync(full)).length
  }
  return { raw, gzip, count: hrefs.length, missing }
}

const mainGraph = graphBytes(mainRow)
const chamberBytes = (() => {
  const size = statBytes(chamberRow.file)
  if (size === null) fail(`chamber bundle missing (${chamberRow.file})`)
  const full = `${WEB_DIST}${chamberRow.file}`
  return { raw: size, gzip: gzipSync(readFileSync(full)).length }
})()
const headCss = headCssBytes()

const report = {
  at: new Date().toISOString(),
  mainGraphRaw: mainGraph.raw,
  mainGraphGzip: mainGraph.gzip,
  chamberEntryRaw: chamberBytes.raw,
  chamberEntryGzip: chamberBytes.gzip,
  headCssRaw: headCss.raw,
  headCssGzip: headCss.gzip,
  headCssCount: headCss.count,
}
writeFileSync(SIZES_OUT, `${JSON.stringify(report, null, 2)}\n`)

const lines = [
  `main graph    raw=${mainGraph.raw} gzip=${mainGraph.gzip} (warn>${THRESHOLDS.mainGraphRaw.warn} fail>${THRESHOLDS.mainGraphRaw.fail})`,
  `chamber entry raw=${chamberBytes.raw} gzip=${chamberBytes.gzip} (warn>${THRESHOLDS.chamberEntryRaw.warn})`,
  `head css      raw=${headCss.raw} gzip=${headCss.gzip} ×${headCss.count} links (warn>${THRESHOLDS.headCssRaw.warn})`,
]
let failed = mainGraph.missing > 0 || headCss.missing > 0
if (failed) {
  console.error(`check-chunk-budgets: ${mainGraph.missing + headCss.missing} missing/unresolved asset(s) — metrics are incomplete, refusing to pass`)
}
for (const line of lines) console.log(`check-chunk-budgets: ${line}`)

const crosses = (metric, value, key) => {
  const t = THRESHOLDS[key]
  if (value > t.warn) console.warn(`check-chunk-budgets: ${metric} ${value} exceeds warn threshold ${t.warn}`)
  if (t.fail !== undefined && value > t.fail) {
    console.error(`check-chunk-budgets: ${metric} ${value} exceeds FAIL threshold ${t.fail}`)
    failed = true
  }
}
crosses('mainGraphRaw', mainGraph.raw, 'mainGraphRaw')
crosses('chamberEntryRaw', chamberBytes.raw, 'chamberEntryRaw')
crosses('headCssRaw', headCss.raw, 'headCssRaw')
console.log(`check-chunk-budgets: wrote ${SIZES_OUT}`)
if (failed) process.exit(1)

// G3：只有成功构建才写清单（失败的半成品不配得到「新鲜」的摘要，旧清单保持
// 原样 ⇒ 后续比对永远判红，直到重建成功）。必须在本脚本最后一个写盘点之后：
// 输出集在这里从磁盘枚举，perf-sizes.json 已在上方落盘；manifest 自身除外。
const buildManifest = writeWebDistBuildManifest({ webDistDir: WEB_DIST })
console.log(
  `check-chunk-budgets: wrote ${BUILD_MANIFEST_FILE}（${buildManifest.inputsCount} 输入 / ${buildManifest.outputs.length} 输出）`,
)
