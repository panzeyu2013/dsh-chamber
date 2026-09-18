#!/usr/bin/env node
/**
 * verify-registry.mjs — 上游触点 registry 的保鲜与覆盖面门。
 *
 * 检查面（任一不成立 = exit 1，绝不静默）：
 *   ① schema（registry.mjs 的纯校验，含 `criteria` ∪ `criteriaCodeOnly` == C1–C15）；
 *   ② canonical：盘上文本 == canonical 序列化（键顺序/映射排序/数组顺序）；
 *   ③ 引用存在性：`ours` 存在、`upstream` 在 vendor/harness-checkout 内存在
 *      （退役面用 `upstream: null` + `upstreamFormer` + status ∈ {not-applicable, accepted}）；
 *   ④ deviations id：`deviations`(S/T/P 表行) 与 `relatedGates`(G/D 项目符号) 必须命中
 *      docs/progress/deviations.md 里真实存在的行 id；
 *   ⑤ 覆盖面网（防"静默缩小"）：
 *      A. checklist §2.x 标题（人手写）↔ registry 的每个 fork/seed 条目一一对应；
 *      B. `chamberNamedForks` ↔ `versionAnchor: chamber` 条目（在 schema 校验里）；
 *      C. `excludedUpstreamDirs` ↔ `scripts/dev/ensure-harness-vendor.mjs` 的 EXCLUDED 集合
 *         （那份清单是独立维护的，删 registry 条目而不改它 = 红）；
 *   ⑥ 生成块：`generatedBlocks` 声明的每块存在且与渲染结果逐字节一致。
 *
 * 失败信息必须给出下一步命令（写 canonical / 重生成 / 修数据），不停在"红了"。
 *
 * 用法：
 *   node scripts/upstream/verify-registry.mjs
 *   node scripts/upstream/verify-registry.mjs --help
 */
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CRITERIA } from './touchpoint-criteria.mjs'
import {
  REGISTRY_PATH, classifiedEntries, readRegistrySource, renderRegistryText, validateRegistry,
} from './registry.mjs'
import { CHECKLIST_PATH, checkBlocks } from './registry-views.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const SUBMODULE = join(ROOT, 'vendor', 'harness-checkout')
const DEVIATIONS = join(ROOT, 'docs', 'progress', 'deviations.md')
const VENDOR_BOOTSTRAP = join(ROOT, 'scripts', 'dev', 'ensure-harness-vendor.mjs')

const USAGE = [
  '用法: node scripts/upstream/verify-registry.mjs',
  '',
  '校验 registry.json：schema / canonical / 引用存在性 / deviations id / 覆盖面网 / 生成块。',
  '失败时打印下一步命令；exit 1 = 门硬失败，exit 2 = 用法错误。',
].join('\n')

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE)
    return
  }
  const unknown = argv.filter((arg) => !['--help', '-h'].includes(arg))
  if (unknown.length > 0) {
    console.error(`verify-registry: 未知参数 ${unknown.join(' ')}`)
    console.error(USAGE)
    process.exitCode = 2
    return
  }

  const failures = []
  const fail = (message) => failures.push(message)

  let source
  try {
    source = readRegistrySource()
  } catch (error) {
    console.error(`✗ verify-registry: 无法读取 ${REGISTRY_PATH}: ${error.message}`)
    process.exitCode = 1
    return
  }
  const registry = source.registry

  for (const finding of validateRegistry(registry)) fail(finding)

  // 结构损坏（entries 非数组/含非对象，或 fork/seed 缺 classify.patched|own）时，
  // canonical 化与渲染会抛 TypeError；这里先给出可行动的结论，而不是栈回溯。
  const entries = registry.entries
  const structurallySound = Array.isArray(entries) && entries.length > 0
    && entries.every((entry) => entry !== null && typeof entry === 'object' && !Array.isArray(entry)
      && ((entry.type === 'fork' || entry.type === 'seed')
        ? (entry.classify !== null && typeof entry.classify === 'object'
          && typeof entry.classify.patched === 'object' && typeof entry.classify.own === 'object')
        : true))
  if (!structurallySound) {
    for (const message of failures) console.error(`✗ ${message}`)
    console.error('\n✗ verify-registry: entries 结构损坏，canonical/引用/网/生成块检查已跳过——先修 registry.json')
    console.error('  下一步: node scripts/upstream/registry-views.mjs --write（结构修好后重跑本门）')
    process.exitCode = 1
    return
  }

  const canonical = renderRegistryText(registry)
  if (source.raw !== canonical) fail(`registry.json 不是 canonical 形态（键顺序/映射排序/数组顺序）；跑: node scripts/upstream/registry-views.mjs --write`)

  // ③ 引用存在性
  for (const entry of registry.entries) {
    const ours = join(ROOT, entry.ours)
    if (!existsSync(ours)) fail(`[${entry.id}] ours 路径不存在: ${entry.ours}`)
    if (typeof entry.upstream === 'string') {
      if (!existsSync(SUBMODULE)) {
        fail('vendor/harness-checkout 未物化；跑: git submodule update --init vendor/harness-checkout && node scripts/dev/ensure-harness-vendor.mjs')
        break
      }
      if (!existsSync(join(SUBMODULE, entry.upstream))) fail(`[${entry.id}] upstream 路径在 pin 住的 vendor 树里不存在: ${entry.upstream}`)
    }
  }

  // ④ deviations / relatedGates id
  const deviationIds = parseDeviationIds(readFileSync(DEVIATIONS, 'utf8'))
  for (const entry of registry.entries) {
    for (const id of entry.deviations ?? []) {
      if (!deviationIds.has(id)) fail(`[${entry.id}] deviations 引用了不存在的行 id: ${id}`)
    }
    for (const id of entry.relatedGates ?? []) {
      if (!deviationIds.has(id)) fail(`[${entry.id}] relatedGates 引用了不存在的行 id: ${id}`)
    }
  }

  // ⑤A checklist §2.x 标题 ↔ fork/seed 条目
  const checklist = readFileSync(CHECKLIST_PATH, 'utf8')
  const headings = parseForkHeadings(checklist)
  const classified = classifiedEntries(registry)
  for (const entry of classified) {
    const key = `${entry.ours}|${entry.upstream}`
    const matches = headings.filter((heading) => `${heading.ours}|${heading.upstream}` === key)
    if (matches.length !== 1) fail(`[${entry.id}] checklist §2.x 标题必须恰好一条（实际 ${matches.length} 条）: ${key}`)
  }
  for (const heading of headings) {
    if (!classified.some((entry) => entry.ours === heading.ours && entry.upstream === heading.upstream)) {
      fail(`checklist §2.x 标题 ${heading.ours}（上游 ${heading.upstream}）在 registry 里没有对应条目`)
    }
  }

  // ⑤C ensure-harness-vendor EXCLUDED（独立清单）↔ excludedUpstreamDirs
  const vendorExcluded = parseVendorExcluded(readFileSync(VENDOR_BOOTSTRAP, 'utf8'))
  const mappedExcluded = []
  for (const dir of registry.excludedUpstreamDirs ?? []) {
    const entry = classified.find((candidate) => candidate.upstream === dir)
    if (entry === undefined) fail(`excludedUpstreamDirs 的 ${dir} 没有对应 fork 条目（C6 哨兵失去锚）`)
    else mappedExcluded.push(entry.ours.split('/').pop())
  }
  const vendorSet = [...vendorExcluded].sort()
  const registrySet = [...mappedExcluded].sort()
  if (vendorSet.join(',') !== registrySet.join(',')) {
    fail(`excludedUpstreamDirs 与 ensure-harness-vendor EXCLUDED 不一致: vendor=${vendorSet.join(',')} registry=${registrySet.join(',')}（两侧同改）`)
  }
  // ⑤D pins 不是装饰：source/runtime 锚与 forkAnchors glob 必须真的命中文件
  for (const [key, ref] of [['sourceLine', registry.pins?.sourceLine], ['runtimeLine', registry.pins?.runtimeLine]]) {
    if (typeof ref === 'string' && !existsSync(join(ROOT, ref))) fail(`pins.${key} 指向的文件不存在: ${ref}`)
  }
  for (const pattern of registry.pins?.forkAnchors ?? []) {
    if (!globMatches(pattern, ROOT)) fail(`pins.forkAnchors 的 glob 没有命中任何文件: ${pattern}`)
  }

  // ⑥ 生成块
  for (const finding of checkBlocks(checklist, registry)) fail(finding)

  if (failures.length > 0) {
    for (const message of failures) console.error(`✗ ${message}`)
    console.error(`\n✗ verify-registry: ${failures.length} 项失败`)
    process.exitCode = 1
    return
  }
  console.log(`✓ verify-registry: schema/canonical/引用/网/生成块 全绿（${registry.entries.length} 条目，判据 ${Object.keys(CRITERIA).length} 个）`)
}

/** deviations.md 的两种行形态：S/T/P 表行 + G/D 项目符号。 */
export function parseDeviationIds(text) {
  const ids = new Set()
  for (const match of text.matchAll(/^\|\s*([STPGD]-?\d+)\s*\|/gmu)) ids.add(match[1])
  for (const match of text.matchAll(/^-\s*\*\*([GD]\d+)\b/gmu)) ids.add(match[1])
  return ids
}

/** checklist §2.x 标题：`### 2.1 \`packages/a\`（上游 \`packages/b\`）`。 */
export function parseForkHeadings(text) {
  const headings = []
  for (const match of text.matchAll(/^###\s+2\.\d+\s+`([^`]+)`（上游`?\s*`([^`]+)`/gmu)) {
    headings.push({ ours: match[1], upstream: match[2] })
  }
  return headings
}

/** ensure-harness-vendor.mjs 的 `const EXCLUDED = new Set([...])`。 */
export function parseVendorExcluded(text) {
  const match = /const EXCLUDED = new Set\(\[([^\]]*)\]\)/u.exec(text)
  if (match === null) return []
  return [...match[1].matchAll(/'([^']+)'/gu)].map((item) => item[1])
}

/** 单层 glob（只支持 "目录 / 星号 / 余下路径" 形态）；pins.forkAnchors 的声明式校验用。 */
export function globMatches(pattern, root) {
  if (!pattern.includes('*')) return existsSync(join(root, pattern))
  const index = pattern.indexOf('*')
  const base = pattern.slice(0, index).replace(/\/$/u, '')
  const rest = pattern.slice(index + 1).replace(/^\//u, '')
  if (base === '' || rest === '' || rest.includes('*')) return false
  const baseDir = join(root, base)
  if (!existsSync(baseDir)) return false
  return readdirSync(baseDir).some((name) => existsSync(join(baseDir, name, rest)))
}

/** 入口判定用 realpath 双侧比较：符号链接绝对路径调用时也不静默 no-op。 */
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
