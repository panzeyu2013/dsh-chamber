/**
 * registry.mjs — 上游触点 registry 的加载、schema 校验与 canonical 序列化（纯逻辑）。
 *
 * 单一来源：`registry.json` 只承载**机械事实**（路径、分类、判据 id、偏差 id、
 * 一句话原因）；长散文留在 `docs/checklists/upstream-touchpoints.md`。生成视图与
 * 触点门都从这里读，禁止第二份手抄副本。
 *
 * canonical 规则（`verify-registry.mjs` 逐字节强制，`registry-views.mjs --write` 产出）：
 * - 2 空格缩进 / LF / 末尾换行；顶层与 entry 键按固定顺序；classify 内映射按键排序；
 *   `entries` **保持数组顺序**（C2 报告顺序由它决定，不许重排）；
 * - `vendorSourceConsumers` 按 (consumer, vendorFile) 排序（C16 登记是集合语义）；
 * - 字符串数组（criteria/deviations/relatedGates/symbols/…）排序。
 *
 * 有意不做的事：这里不读文件系统、不解析 deviations.md、不渲染文档 —— 那些属于
 * `verify-registry.mjs` / `registry-views.mjs`，本模块只保证"数据形状与序列化"。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CRITERIA_IDS } from './touchpoint-criteria.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

/** registry.json 路径（与消费者同域：scripts/upstream/）。 */
export const REGISTRY_PATH = join(HERE, 'registry.json')

/** `entries[].type` 取值。 */
export const ENTRY_TYPES = Object.freeze(['fork', 'seed', 'seam', 'mirror', 'artifact', 'seat'])

/** `entries[].status` 取值。 */
export const ENTRY_STATUSES = Object.freeze(['aligned', 'open', 'accepted', 'not-applicable'])

/** 需要 `classify` 块（文件级分类）的类型。 */
export const CLASSIFIED_TYPES = Object.freeze(['fork', 'seed'])

const TOP_KEYS = ['schema', 'pins', 'authorityEnum', 'chamberNamedForks', 'excludedUpstreamDirs', 'criteriaCodeOnly', 'vendorSourceConsumers', 'generatedBlocks', 'entries', 'notes']
const ENTRY_KEYS = ['id', 'type', 'name', 'ours', 'upstream', 'upstreamFormer', 'versionAnchor', 'classify', 'authority', 'criteria', 'deviations', 'relatedGates', 'symbols', 'evidence', 'status', 'rationale']
const CLASSIFY_KEYS = ['patched', 'own', 'ownPrefix', 'ownNotes', 'dropped', 'droppedNotes']
/** `vendorSourceConsumers[]` 的字段集（C16：登记一条 vendor 源直穿的最小机械事实）。 */
const VENDOR_CONSUMER_KEYS = ['consumer', 'vendorFile', 'symbols', 'reason', 'retiresWhen']
/** `vendorSourceConsumers[].symbols[]` 的允许形态（一个 ECMAScript 标识符）。 */
const VENDOR_SYMBOL_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/u
const ID_PATTERN = /^(fork|seed|seam|mirror|artifact|seat)\.[a-z0-9][a-z0-9-]*$/
const DEVIATION_ID_PATTERN = /^[STPGD]-?[0-9]+$/
/** `entries[].relatedGates` 引用真实门：根 package.json script 名或仓内脚本/测试路径（存在性门在 verify-registry.mjs）。 */
export const GATE_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._/@-]*$/
const BLOCK_ID_PATTERN = /^[a-z0-9][a-z0-9.-]*$/
export const SYMBOL_PATTERN = /^[^#]+#(=literal:.+|[A-Za-z_$][A-Za-z0-9_$.-]*)$/

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const sortedStrings = (list) => [...list].sort()

/** 读取并解析 registry.json（保留原始文本供 canonical 比对）。 */
export function readRegistrySource(path = REGISTRY_PATH) {
  const raw = readFileSync(path, 'utf8')
  return { path, raw, registry: JSON.parse(raw) }
}

/** 读取 registry.json。 */
export function loadRegistry(path = REGISTRY_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function sortMap(map) {
  return Object.fromEntries(Object.keys(map).sort().map((key) => [key, map[key]]))
}

function canonicalizeClassify(classify) {
  const out = {}
  for (const key of CLASSIFY_KEYS) {
    if (classify[key] === undefined) continue
    if (key === 'patched' || key === 'own' || key === 'ownNotes' || key === 'droppedNotes') out[key] = sortMap(classify[key])
    else out[key] = sortedStrings(classify[key])
  }
  return out
}

/** canonical 形态：按 (consumer, vendorFile) 排序，符号数组排序（集合语义，作者顺序不算事实）。 */
function canonicalizeVendorConsumers(consumers) {
  return consumers
    .map((entry) => ({
      consumer: entry.consumer,
      vendorFile: entry.vendorFile,
      symbols: sortedStrings(entry.symbols ?? []),
      reason: entry.reason,
      retiresWhen: entry.retiresWhen,
    }))
    .sort((a, b) => (a.consumer === b.consumer
      ? (a.vendorFile < b.vendorFile ? -1 : a.vendorFile > b.vendorFile ? 1 : 0)
      : (a.consumer < b.consumer ? -1 : 1)))
}

function canonicalizeEntry(entry) {
  const out = {}
  for (const key of ENTRY_KEYS) {
    if (entry[key] === undefined) continue
    if (key === 'classify') out.classify = canonicalizeClassify(entry.classify)
    else if (Array.isArray(entry[key])) out[key] = sortedStrings(entry[key])
    else out[key] = entry[key]
  }
  return out
}

/** 按 canonical 规则重建对象（键顺序、映射排序、字符串数组排序）。 */
export function canonicalizeRegistry(registry) {
  const out = {}
  for (const key of TOP_KEYS) {
    if (registry[key] === undefined) continue
    if (key === 'entries') out.entries = registry.entries.map(canonicalizeEntry)
    else if (key === 'pins') {
      out.pins = {
        sourceLine: registry.pins.sourceLine,
        runtimeLine: registry.pins.runtimeLine,
        forkAnchors: sortedStrings(registry.pins.forkAnchors ?? []),
      }
    } else if (key === 'vendorSourceConsumers') out[key] = canonicalizeVendorConsumers(registry[key])
    else if (Array.isArray(registry[key])) out[key] = sortedStrings(registry[key])
    else out[key] = registry[key]
  }
  return out
}

/** canonical 文本（写入盘上的形态；`verify-registry` 逐字节比对）。 */
export function renderRegistryText(registry) {
  return `${JSON.stringify(canonicalizeRegistry(registry), null, 2)}\n`
}

/** fork/seed 条目（verifier 的 FORKS 面）。 */
export function classifiedEntries(registry) {
  return registry.entries.filter((entry) => CLASSIFIED_TYPES.includes(entry.type))
}

/**
 * 触点门消费的形状：name/rel/upstream/versionAnchor/
 * patched/own/ownPrefix/dropped；ownNotes/droppedNotes 是纯文档字段，不进 verifier。
 */
export function verifierForks(registry) {
  return classifiedEntries(registry).map((entry) => {
    const fork = {
      name: entry.name,
      rel: entry.ours,
      upstream: entry.upstream,
      patched: entry.classify.patched,
      own: entry.classify.own,
      ownPrefix: entry.classify.ownPrefix ?? [],
      dropped: entry.classify.dropped ?? [],
    }
    return entry.versionAnchor === undefined || entry.versionAnchor === 'upstream'
      ? fork
      : { ...fork, versionAnchor: entry.versionAnchor }
  })
}

/** registry 里出现的全部判据 id（分类条目 + 代码自持清单）。 */
export function criteriaPartition(registry) {
  const used = new Set()
  for (const entry of registry.entries) for (const id of entry.criteria ?? []) used.add(id)
  const codeOnly = new Set(registry.criteriaCodeOnly ?? [])
  return { used: [...used].sort(), codeOnly: [...codeOnly].sort() }
}

/**
 * 纯 schema 校验（不碰文件系统）。返回 findings（空数组 = 通过）。
 * 引用级校验（路径存在性、deviations id、生成块一致）在 verify-registry.mjs。
 */
export function validateRegistry(registry) {
  const findings = []
  const push = (message) => findings.push(message)
  if (!isPlainObject(registry)) return ['registry 不是对象']

  for (const key of Object.keys(registry)) if (!TOP_KEYS.includes(key)) push(`未知顶层字段: ${key}`)
  if (registry.schema !== 1) push(`schema 必须是 1（实际 ${JSON.stringify(registry.schema)}）`)
  if (!isPlainObject(registry.pins)) push('pins 缺失或不是对象')
  else {
    for (const key of Object.keys(registry.pins)) if (!['sourceLine', 'runtimeLine', 'forkAnchors'].includes(key)) push(`pins 未知字段: ${key}`)
    for (const key of ['sourceLine', 'runtimeLine']) if (typeof registry.pins[key] !== 'string' || registry.pins[key] === '') push(`pins.${key} 必须是非空字符串`)
    if (!Array.isArray(registry.pins.forkAnchors) || registry.pins.forkAnchors.some((item) => typeof item !== 'string')) push('pins.forkAnchors 必须是字符串数组')
  }
  for (const key of ['authorityEnum', 'chamberNamedForks', 'excludedUpstreamDirs', 'criteriaCodeOnly', 'generatedBlocks']) {
    if (!Array.isArray(registry[key])) { push(`${key} 必须是数组`); continue }
    if (registry[key].some((item) => typeof item !== 'string' || item === '')) push(`${key} 必须是字符串数组`)
  }
  if (Array.isArray(registry.authorityEnum) && !(registry.authorityEnum.includes('upstream') && registry.authorityEnum.includes('chamber'))) {
    push('authorityEnum 必须包含 upstream 与 chamber')
  }
  if (Array.isArray(registry.generatedBlocks)) {
    if (new Set(registry.generatedBlocks).size !== registry.generatedBlocks.length) push('generatedBlocks 有重复 id')
    for (const id of registry.generatedBlocks) if (!BLOCK_ID_PATTERN.test(id)) push(`generatedBlocks id 非法: ${id}`)
  }

  // vendorSourceConsumers（C16）：一条 = 一次「package 生产源相对 import 出包到 vendor/」的直穿登记。
  // 符号集合/存在性由 C16 对真实 import 双向判定；这里只锁形状与最小事实（consumer 在 packages/ 下、
  // vendorFile 在 vendor/ 下、至少一个合法符号、无重复登记），防止块被清空/写坏后静默放行。
  if (registry.vendorSourceConsumers !== undefined) {
    if (!Array.isArray(registry.vendorSourceConsumers)) push('vendorSourceConsumers 必须是数组')
    else {
      const seenConsumers = new Set()
      for (const [index, item] of registry.vendorSourceConsumers.entries()) {
        const at = `vendorSourceConsumers[${index}]`
        if (!isPlainObject(item)) { push(`${at} 不是对象`); continue }
        for (const key of Object.keys(item)) if (!VENDOR_CONSUMER_KEYS.includes(key)) push(`${at} 未知字段: ${key}`)
        for (const key of ['consumer', 'vendorFile', 'reason', 'retiresWhen']) {
          if (typeof item[key] !== 'string' || item[key] === '') push(`${at}.${key} 必须是非空字符串`)
        }
        if (typeof item.consumer === 'string' && item.consumer !== '' && !item.consumer.startsWith('packages/')) {
          push(`${at}.consumer 必须是 packages/ 下的仓内路径: ${JSON.stringify(item.consumer)}`)
        }
        if (typeof item.vendorFile === 'string' && item.vendorFile !== '' && !item.vendorFile.startsWith('vendor/')) {
          push(`${at}.vendorFile 必须是 vendor/ 下的仓内路径: ${JSON.stringify(item.vendorFile)}`)
        }
        if (!Array.isArray(item.symbols) || item.symbols.length === 0) {
          push(`${at}.symbols 必须是非空字符串数组（清空符号 = 直穿的消费面不可证明）`)
        } else {
          for (const symbol of item.symbols) {
            if (typeof symbol !== 'string' || !VENDOR_SYMBOL_PATTERN.test(symbol)) push(`${at}.symbols 非法符号: ${JSON.stringify(symbol)}`)
          }
          if (new Set(item.symbols).size !== item.symbols.length) push(`${at}.symbols 有重复`)
        }
        if (typeof item.consumer === 'string' && typeof item.vendorFile === 'string') {
          const pair = item.consumer + ' -> ' + item.vendorFile
          if (seenConsumers.has(pair)) push(`${at}: (consumer, vendorFile) 重复登记`)
          else seenConsumers.add(pair)
        }
      }
    }
  }

  if (!Array.isArray(registry.entries) || registry.entries.length === 0) {
    push('entries 必须是非空数组')
    return findings
  }
  const seen = new Set()
  const seenNames = new Set()
  for (const [index, entry] of registry.entries.entries()) {
    const at = `entries[${index}]`
    if (!isPlainObject(entry)) { push(`${at} 不是对象`); continue }
    for (const key of Object.keys(entry)) if (!ENTRY_KEYS.includes(key)) push(`${at} 未知字段: ${key}`)
    if (typeof entry.id !== 'string' || !ID_PATTERN.test(entry.id)) push(`${at}.id 非法（要求 <域>.<名>）: ${JSON.stringify(entry.id)}`)
    else if (seen.has(entry.id)) push(`${at}.id 重复: ${entry.id}`)
    else seen.add(entry.id)
    if (!ENTRY_TYPES.includes(entry.type)) push(`${at}.type 非法: ${JSON.stringify(entry.type)}`)
    if (entry.type === 'fork' || entry.type === 'seed') {
      if (typeof entry.name !== 'string' || entry.name === '') push(`${at}.name 缺失（fork/seed 需要人类可读短名）`)
      else if (seenNames.has(entry.name)) push(`${at}.name 重复: ${entry.name}（生成块 id 以 name 为键，重复会静默顶掉一张表）`)
      else seenNames.add(entry.name)
      if (!isPlainObject(entry.classify)) push(`${at}.classify 缺失（fork/seed 需要文件级分类）`)
      if (Array.isArray(entry.criteria) && entry.criteria.length === 0) {
        push(`${at}.criteria 为空：分类条目至少引用一条判据（否则 C1–C15 可被整体挪进 criteriaCodeOnly 而无人发现）`)
      }
      // 现行分类条目必须二选一：shadow（上游进入 excludedUpstreamDirs）或 chamber-named
      // （本仓路径进入 chamberNamedForks）。否则删掉 exclusion/naming 关联后覆盖面静默消失。
      // 退役形态（upstream: null + upstreamFormer + status accepted/not-applicable）豁免此不变量：
      // 那时上游目录可能已不存在，强行二选一会让"退役"本身不可能。
      if (entry.upstream !== null) {
        const isExcluded = Array.isArray(registry.excludedUpstreamDirs) && registry.excludedUpstreamDirs.includes(entry.upstream)
        const isNamed = Array.isArray(registry.chamberNamedForks) && registry.chamberNamedForks.includes(entry.ours)
        if (isExcluded === isNamed) {
          push(`${at}: 分类条目必须恰好属于一类——shadow（upstream ∈ excludedUpstreamDirs）或 chamber-named（ours ∈ chamberNamedForks）`)
        }
      }
      if (Array.isArray(entry.symbols) && entry.symbols.length === 0) {
        push(`${at}.symbols 为空：fork/seed 至少一条符号锚（D15 机械化方向，探针不得被清空后仍然绿）`)
      }
    }
    if (entry.type === 'seed' && entry.versionAnchor !== 'chamber') push(`${at}: type=seed 必须 versionAnchor=chamber`)
    if (isPlainObject(entry.classify)) {
      for (const key of Object.keys(entry.classify)) if (!CLASSIFY_KEYS.includes(key)) push(`${at}.classify 未知字段: ${key}`)
      for (const key of ['patched', 'own']) {
        if (!isPlainObject(entry.classify[key])) push(`${at}.classify.${key} 必须是对象（fork/seed 必填；缺省会让生成器与 verifier 抛 TypeError 而不是给出可行动结论）`)
      }
      for (const key of ['ownNotes', 'droppedNotes']) {
        if (entry.classify[key] !== undefined && !isPlainObject(entry.classify[key])) push(`${at}.classify.${key} 必须是对象`)
      }
      for (const key of ['ownPrefix', 'dropped']) {
        if (entry.classify[key] !== undefined && (!Array.isArray(entry.classify[key]) || entry.classify[key].some((item) => typeof item !== 'string'))) push(`${at}.classify.${key} 必须是字符串数组`)
      }
    }
    if (typeof entry.ours !== 'string' || entry.ours === '') push(`${at}.ours 必须是非空字符串`)
    if (entry.upstream === null) {
      if (typeof entry.upstreamFormer !== 'string' || entry.upstreamFormer === '') push(`${at}: upstream 为 null 时必须给 upstreamFormer`)
      if (!['not-applicable', 'accepted'].includes(entry.status)) push(`${at}: upstream 为 null 只允许 status ∈ {not-applicable, accepted}`)
    } else if (typeof entry.upstream !== 'string' || entry.upstream === '') {
      push(`${at}.upstream 必须是字符串或 null`)
    }
    if (entry.versionAnchor !== undefined && !['upstream', 'chamber'].includes(entry.versionAnchor)) push(`${at}.versionAnchor 非法: ${entry.versionAnchor}`)
    if (entry.authority !== undefined && !(registry.authorityEnum ?? []).includes(entry.authority)) push(`${at}.authority 不在 authorityEnum: ${entry.authority}`)
    if (!Array.isArray(entry.criteria)) push(`${at}.criteria 必须是数组`)
    else for (const id of entry.criteria) if (!CRITERIA_IDS.includes(id)) push(`${at}.criteria 未知判据 id: ${id}`)
    if (!Array.isArray(entry.deviations)) push(`${at}.deviations 必须是数组`)
    else for (const id of entry.deviations) if (typeof id !== 'string' || !DEVIATION_ID_PATTERN.test(id)) push(`${at}.deviations id 非法: ${JSON.stringify(id)}`)
    if (!Array.isArray(entry.relatedGates)) push(`${at}.relatedGates 必须是数组`)
    else for (const ref of entry.relatedGates) if (typeof ref !== 'string' || !GATE_REF_PATTERN.test(ref)) push(`${at}.relatedGates 门引用非法（要求根 package.json script 名或仓内脚本路径）: ${JSON.stringify(ref)}`)
    if (!Array.isArray(entry.symbols)) push(`${at}.symbols 必须是数组`)
    else for (const symbol of entry.symbols) if (typeof symbol !== 'string' || !SYMBOL_PATTERN.test(symbol)) push(`${at}.symbols 格式非法（要求 path#symbol 或 path#=literal:…）: ${JSON.stringify(symbol)}`)
    if (!ENTRY_STATUSES.includes(entry.status)) push(`${at}.status 非法: ${JSON.stringify(entry.status)}`)
    if (entry.status === 'accepted' && (typeof entry.rationale !== 'string' || entry.rationale === '')) push(`${at}: status=accepted 必须给 rationale（理由随条目走）`)
    if (typeof entry.evidence !== 'string' || entry.evidence === '') push(`${at}.evidence 必须是非空字符串`)
  }

  const { used, codeOnly } = criteriaPartition(registry)
  for (const id of used) if (!CRITERIA_IDS.includes(id)) push(`criteria 用了未知 id: ${id}`)
  const both = used.filter((id) => codeOnly.includes(id))
  for (const id of both) push(`判据 ${id} 同时出现在 entries.criteria 与 criteriaCodeOnly`)
  const covered = new Set([...used, ...codeOnly])
  const missing = CRITERIA_IDS.filter((id) => !covered.has(id))
  if (missing.length > 0) push(`判据未被任何条目或 criteriaCodeOnly 覆盖: ${missing.join(', ')}`)
  const stray = codeOnly.filter((id) => !CRITERIA_IDS.includes(id))
  for (const id of stray) push(`criteriaCodeOnly 含未知判据: ${id}`)

  const chamberEntries = registry.entries.filter((entry) => entry.versionAnchor === 'chamber').map((entry) => entry.ours)
  const named = registry.chamberNamedForks ?? []
  for (const path of named) if (!chamberEntries.includes(path)) push(`chamberNamedForks 列出的 ${path} 不是 versionAnchor=chamber 的条目`)
  for (const path of chamberEntries) if (!named.includes(path)) push(`versionAnchor=chamber 的条目 ${path} 未登记进 chamberNamedForks`)
  for (const entry of registry.entries) {
    if (named.includes(entry.ours) && entry.type !== 'seed') push(`chamberNamedForks 的 ${entry.ours} 必须是 type=seed（升级预检按 type 过滤 fork 面）`)
  }

  return findings
}
