#!/usr/bin/env node
/**
 * check-chunk-budgets.mjs — chunk 尺寸预算护栏（C6，2026-09 性能审计落点）。
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
 * 校准基线（2026-09 alpha.2 重锚后 dist，raw bytes，见 dist/web/perf-sizes.json）：
 * mainGraph ≈1,208,191；chamberEntry ≈1,982,358（距 warn 门 2,000,000 仅
 * ~0.9%：含 file-upload 转为 covered、vendor 补丁集与必需行探针的净增量——
 * 再加一个首屏家族就会触 warn，需先评估拆分）；headCss ≈245,227。阈值不是历史账本：结构改动落地后按新实测值回填阈值并更新本注释，
 * 防止它变成下一份过期注释。
 *
 * 输出：每次运行打印三项实测 + 阈值；硬门超限或资产缺失/未解析 exit 1
 * （build 失败）；并把本次构建快照 perf-sizes.json 写入 dist/web（vite
 * outDir，下次 build 覆写——跨构建趋势请存档代表点，见
 * docs/progress/performance-baseline.md §11）。gzip 列 = node gzipSync
 * level-6 自洽口径，仅脚本内可比。
 */
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

const WEB_DIST = fileURLToPath(new URL('../../desktop/dist/web/', import.meta.url))
const VITE_MANIFEST = fileURLToPath(new URL('../../desktop/dist/web/.vite/manifest.json', import.meta.url))
const INDEX_HTML = fileURLToPath(new URL('../../desktop/dist/web/index.html', import.meta.url))
const SIZES_OUT = fileURLToPath(new URL('../../desktop/dist/web/perf-sizes.json', import.meta.url))

/** 阈值（raw bytes）。校准基线见文件头注释（2026-09 C3/C4 后回填）。 */
const THRESHOLDS = {
  mainGraphRaw: { warn: 1_350_000, fail: 1_550_000 },
  chamberEntryRaw: { warn: 2_000_000 },
  headCssRaw: { warn: 300_000 },
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
