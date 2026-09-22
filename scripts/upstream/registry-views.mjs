/**
 * registry-views.mjs — registry → 文档块的**纯渲染**与写盘 CLI。
 *
 * 视图只由 `registry.json` 决定（零工作树访问），因此保鲜门可以逐字节比对，
 * 而不受文件系统状态影响。生成块的标记形态：
 *
 *   <!-- GENERATED:registry:touchpoints.fork-mirror.<name>:begin -->
 *   …（生成内容，禁止手改）…
 *   <!-- GENERATED:registry:touchpoints.fork-mirror.<name>:end -->
 *
 * 块 id 必须已在 `registry.generatedBlocks` 声明：
 * 门只校验"已声明的块存在且逐字节一致"，未声明的块一律报错 —— 删掉标记不能把门关掉。
 *
 * 用法：
 *   node scripts/upstream/registry-views.mjs --check   # 只报差异（默认）
 *   node scripts/upstream/registry-views.mjs --write   # 写 registry canonical + 文档块
 */
import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CLASSIFIED_TYPES, REGISTRY_PATH, loadRegistry, renderRegistryText, validateRegistry } from './registry.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')

/** 生成块的宿主文档。 */
export const CHECKLIST_PATH = join(ROOT, 'docs', 'checklists', 'upstream-touchpoints.md')

/** 块 id → 位置（文档里的段落由人写，块只替换表格本体）。 */
export const FORK_BLOCK_PREFIX = 'touchpoints.fork-mirror.'
export const INDEX_BLOCK = 'touchpoints.index'

const BEGIN = (id) => `<!-- GENERATED:registry:${id}:begin -->`
const END = (id) => `<!-- GENERATED:registry:${id}:end -->`

/** 表格单元格：转义竖线，避免把行撑破。 */
const cell = (value) => String(value).replace(/\|/gu, '\\|').replace(/\n/gu, ' ')

/** patched 原因串以 `[patch-*]` / `[own-divergent]` 开头，标记列直接从它取。 */
function markerOf(reason, fallback) {
  const match = /^\[([a-z-]+)\]/u.exec(reason.trim())
  return match === null ? fallback : `[${match[1]}]`
}

/** `ownNotes`/`droppedNotes` 的键可带通配（如 `README*`），先精确后前缀。 */
function noteFor(notes, key) {
  if (notes[key] !== undefined) return notes[key]
  const wildcard = Object.keys(notes).find((pattern) => pattern.endsWith('*') && key.startsWith(pattern.slice(0, -1)))
  return wildcard === undefined ? '' : notes[wildcard]
}

/** 一个 fork/seed 条目的文件分类表（§2.x 的表格本体）。 */
export function renderForkTable(entry) {
  const classify = entry.classify
  const lines = ['| 文件 | 标记 | 原因/补丁说明 |', '|---|---|---|']
  for (const file of Object.keys(classify.patched).sort()) {
    const reason = classify.patched[file]
    const text = reason.replace(/^\[[a-z-]+\]\s*/u, '')
    lines.push(`| \`${cell(file)}\` | ${markerOf(reason, '[patched]')} | ${cell(text)} |`)
  }
  for (const file of Object.keys(classify.own).sort()) {
    lines.push(`| \`${cell(file)}\` | [own] | ${cell(classify.own[file])} |`)
  }
  for (const file of classify.ownPrefix ?? []) {
    lines.push(`| \`${cell(file)}\` | [own] | ${cell(noteFor(classify.ownNotes ?? {}, file) || 'chamber 自有（前缀/文件）')} |`)
  }
  for (const file of classify.dropped ?? []) {
    lines.push(`| \`${cell(file)}\` | [dropped] | ${cell(noteFor(classify.droppedNotes ?? {}, file) || '上游文件有意不镜像')} |`)
  }
  return lines.join('\n')
}

/** §9 总表：registry 里每个条目的机械索引。 */
export function renderIndexTable(registry) {
  const lines = ['| id | 类型 | 上游 | 我方 | 判据 | 偏差 / 门 | 状态 |', '|---|---|---|---|---|---|---|']
  for (const entry of registry.entries) {
    const upstream = entry.upstream === null ? `（原 ${entry.upstreamFormer}）` : `\`${entry.upstream}\``
    const refs = [...(entry.deviations ?? []), ...(entry.relatedGates ?? [])]
    lines.push([
      `\`${entry.id}\``,
      entry.type,
      upstream,
      `\`${entry.ours}\``,
      (entry.criteria ?? []).join(', ') || '—',
      refs.join(', ') || '—',
      entry.status,
    ].join(' | ').replace(/^/u, '| ').replace(/$/u, ' |'))
  }
  return lines.join('\n')
}

/** 已声明块 id → 渲染文本。 */
export function renderBlocks(registry) {
  const blocks = new Map()
  for (const entry of registry.entries) {
    if (CLASSIFIED_TYPES.includes(entry.type) && entry.classify !== undefined) {
      blocks.set(`${FORK_BLOCK_PREFIX}${entry.name}`, renderForkTable(entry))
    }
  }
  blocks.set(INDEX_BLOCK, renderIndexTable(registry))
  return blocks
}

/** 文档里出现的全部 GENERATED 块 id（begin/end 都算）。 */
export function markerIds(text) {
  const ids = new Set()
  for (const match of text.matchAll(/<!--\s*GENERATED:registry:([a-z0-9.-]+):(?:begin|end)\s*-->/gu)) ids.add(match[1])
  return ids
}

/** 取文档里的块内容；返回 `{ content, error }`。 */
export function extractBlock(text, id) {
  const begin = BEGIN(id)
  const end = END(id)
  const beginCount = text.split(begin).length - 1
  const endCount = text.split(end).length - 1
  if (beginCount !== 1 || endCount !== 1) {
    return { content: null, error: `块 ${id} 的标记不是恰好一对（begin ${beginCount} / end ${endCount}）` }
  }
  const start = text.indexOf(begin) + begin.length
  const stop = text.indexOf(end)
  if (stop < start) return { content: null, error: `块 ${id} 的 end 标记在 begin 之前` }
  return { content: text.slice(start, stop), error: null }
}

/** 用渲染结果替换文档里的块（未声明/缺标记 = 报错，不静默新建）。 */
export function applyBlocks(text, registry) {
  const blocks = renderBlocks(registry)
  const declared = new Set(registry.generatedBlocks)
  const undeclaredViews = [...blocks.keys()].filter((id) => !declared.has(id))
  if (undeclaredViews.length > 0) return { text: null, error: `generatedBlocks 未声明全部生成视图: ${undeclaredViews.join(', ')}` }
  for (const id of markerIds(text)) {
    if (!declared.has(id)) return { text: null, error: `文档存在未声明的 GENERATED 标记: ${id}（先声明或删除）` }
  }
  let next = text
  for (const id of registry.generatedBlocks) {
    if (!blocks.has(id)) return { text: null, error: `generatedBlocks 声明了未定义的块: ${id}` }
    const found = extractBlock(next, id)
    if (found.error !== null) return { text: null, error: found.error }
    next = next.replace(BEGIN(id) + found.content + END(id), BEGIN(id) + '\n' + blocks.get(id) + '\n' + END(id))
  }
  return { text: next, error: null }
}

/** 保鲜比对：逐字节（含标记对与未声明块）。 */
export function checkBlocks(text, registry) {
  const findings = []
  const blocks = renderBlocks(registry)
  const declared = new Set(registry.generatedBlocks ?? [])
  // 声明必须与渲染面一一对应：否则删掉一条声明就能静默关掉对应视图的保鲜。
  for (const id of blocks.keys()) if (!declared.has(id)) findings.push(`渲染面存在未声明的块: ${id}（generatedBlocks 必须覆盖全部生成视图）`)
  for (const id of markerIds(text)) if (!declared.has(id)) findings.push(`文档里存在未声明的 GENERATED 块标记: ${id}`)
  for (const id of registry.generatedBlocks) {
    if (!blocks.has(id)) { findings.push(`generatedBlocks 声明了未定义的块: ${id}`); continue }
    const found = extractBlock(text, id)
    if (found.error !== null) { findings.push(found.error); continue }
    const expected = '\n' + blocks.get(id) + '\n'
    if (found.content !== expected) findings.push(`块 ${id} 与 registry 不一致（跑 registry-views.mjs --write）`)
  }
  return findings
}

const USAGE = [
  '用法: node scripts/upstream/registry-views.mjs [--write|--check|--help]',
  '',
  '--check（默认）：registry canonical + 生成块逐字节比对，不写盘。',
  '--write：写 registry canonical 并重生成 checklist 的 GENERATED 块。',
  '未知参数 = exit 2（拼错的 --wirte 绝不能静默退化成只检查）。',
].join('\n')

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) { console.log(USAGE); return }
  const unknown = argv.filter((arg) => !['--write', '--check'].includes(arg))
  if (unknown.length > 0) {
    console.error('registry-views: 未知参数 ' + unknown.join(' '))
    console.error(USAGE)
    process.exitCode = 2
    return
  }
  const write = argv.includes('--write')
  let registry
  try {
    registry = loadRegistry()
  } catch (error) {
    console.error('registry-views: 无法读取 registry.json: ' + error.message)
    console.error('  下一步: node scripts/upstream/verify-registry.mjs')
    process.exitCode = 1
    return
  }
  const shapeFindings = validateRegistry(registry)
  if (shapeFindings.length > 0) {
    for (const finding of shapeFindings) console.error('✗ ' + finding)
    console.error('\nregistry-views: registry.json schema 校验失败——先跑 node scripts/upstream/verify-registry.mjs')
    process.exitCode = 1
    return
  }
  const source = readFileSync(REGISTRY_PATH, 'utf8')
  const canonical = renderRegistryText(registry)
  const checklist = readFileSync(CHECKLIST_PATH, 'utf8')
  if (write) {
    if (source !== canonical) writeFileSync(REGISTRY_PATH, canonical)
    const applied = applyBlocks(checklist, registry)
    if (applied.error !== null) {
      console.error(`registry-views: ${applied.error}`)
      process.exitCode = 1
      return
    }
    if (applied.text !== checklist) writeFileSync(CHECKLIST_PATH, applied.text)
    console.log('registry-views: registry.json canonical + ' + registry.generatedBlocks.length + ' 个生成块已写入')
    return
  }
  const findings = []
  if (source !== canonical) findings.push('registry.json 不是 canonical 形态（跑 registry-views.mjs --write）')
  findings.push(...checkBlocks(checklist, registry))
  if (findings.length > 0) {
    for (const finding of findings) console.error('✗ ' + finding)
    process.exitCode = 1
    return
  }
  console.log(`✓ registry-views: registry canonical，${registry.generatedBlocks.length} 个生成块一致`)
}

/** 入口判定：realpath 双侧比较（符号链接绝对路径调用时也不静默 no-op）。 */
const isEntry = (() => {
  const invoked = process.argv[1]
  if (invoked === undefined) return false
  try {
    return realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
})()
if (isEntry) main(process.argv.slice(2))
