#!/usr/bin/env node
/**
 * check-anchors.mjs — 符号锚探针 + 遗留行号锚的预算棘轮。
 *
 * 背景：docs/** 里写死的 `文件:行` 锚点会随代码插入/删除大面积过期，且位移不均匀。
 * 本工具把退役动作拆成可增量执行的三件事：
 *   ① registry 里的符号锚（`path#symbol` / `path#=literal:<唯一子串>`）默认必须可解析；
 *      锚点 path 先按 entry.ours 解析（与 classify 的键同一坐标系），再退回仓库根；
 *   ①′ docs 正文里手写的稳定锚（`path#symbol` / `path#=literal:<唯一子串>`）同样必须可
 *      解析——docs 里拼错的锚同样要红；
 *      生成块内的锚由 registry 侧覆盖，跳过不重复判定（见 collectDocAnchors）；
 *   ② 遗留 `文件:行` 锚点总数只许降不许升（`anchors-budget.json` 棘轮）——
 *      新锚点必须写符号锚，遗留锚迁移后调低预算；
 *   ③ `--report` 给出符号锚漂移与遗留锚分布（含测试面三分类），供人工判读。
 *
 * 模式：
 *   node scripts/upstream/check-anchors.mjs                  # 门（默认）
 *   node scripts/upstream/check-anchors.mjs --report         # 只报告，不红
 *   node scripts/upstream/check-anchors.mjs --fix --file <md> [--apply]
 *   node scripts/upstream/check-anchors.mjs --update-budget [--force]
 *
 * `--fix` 纪律：默认 dry-run；只作用于显式 `--file`；绝不改生成块（GENERATED 标记
 * 之间的内容）；只把"同一行里有且仅有一个可解析符号"的锚点写回行号，其余留给人工。
 * 写完必须重跑受影响的测试（部分 Swift/TS 测试注释引用这些行号）。
 */
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadRegistry, validateRegistry } from './registry.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const BUDGET_PATH = join(HERE, 'anchors-budget.json')

/** 遗留锚扫描面：docs 树下的 .md（D15 的口径）。 */
export const LEGACY_SCAN_ROOT = join(ROOT, 'docs')
export const LEGACY_ANCHOR_PATTERN = /[A-Za-z0-9_/.@-]+\.(?:ts|tsx|mts|cts|mjs|js|swift|css|json|ya?ml|md):\d+/gu
/** 测试面（三分类对象；只报告，不进预算）：macos/Tests + scripts + packages 下 test/ 与 *.test.*。 */
export function collectTestSurfaceFiles(root = ROOT) {
  const files = [
    ...collectFiles(join(root, 'macos', 'Tests'), '.swift'),
    ...collectFiles(join(root, 'scripts'), '.ts'),
    ...collectFiles(join(root, 'scripts'), '.mjs'),
  ]
  const packagesRoot = join(root, 'packages')
  if (existsSync(packagesRoot)) {
    for (const name of readdirSync(packagesRoot)) {
      if (IGNORED_DIRECTORIES.has(name)) continue
      const pkg = join(packagesRoot, name)
      if (!statSync(pkg).isDirectory()) continue
      for (const suffix of ['.ts', '.mjs', '.swift']) files.push(...collectFiles(join(pkg, 'test'), suffix))
      files.push(...collectFiles(join(pkg, 'scripts'), '.mjs'))
      for (const entry of readdirSync(pkg)) if (/\.test\.(ts|mjs|tsx)$/u.test(entry)) files.push(join(pkg, entry))
    }
  }
  return [...new Set(files)].sort()
}
const IGNORED_DIRECTORIES = new Set(['node_modules', 'vendor', 'dist', 'lib', 'release', '.git', '.build', '.dev-user-data', '.tmp'])

const USAGE = [
  '用法: node scripts/upstream/check-anchors.mjs [--report|--fix --file <path> [--apply]|--update-budget [--force]]',
  '',
  '默认（门）：registry 符号锚可解析 + 遗留行号锚总数 <= anchors-budget.json。',
  'exit 0 = 通过；exit 1 = 门失败；exit 2 = 用法错误。',
].join('\n')

/** 递归收集某后缀文件（跳过 IGNORED_DIRECTORIES）。 */
export function collectFiles(root, suffix) {
  const found = []
  const walk = (dir) => {
    if (!existsSync(dir)) return
    for (const name of readdirSync(dir)) {
      if (IGNORED_DIRECTORIES.has(name)) continue
      const full = join(dir, name)
      // 悬空软链（如 Chrome `SingletonCookie`）会让 statSync 抛 ENOENT、
      // 软链环抛 ELOOP，两者都会把整道门打挂；这类条目既不是锚点目标也
      // 不该递归，跳过即可。其余软链保持原样跟随（不改变既有解析面）。
      if (lstatSync(full).isSymbolicLink() && !existsSync(full)) continue
      let info
      try {
        info = statSync(full)
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ELOOP') continue
        throw error
      }
      if (info.isDirectory()) walk(full)
      else if (name.endsWith(suffix)) found.push(full)
    }
  }
  walk(root)
  return found.sort()
}

/** 遗留锚计数（出现次数，与 grep -o 口径一致）。 */
export function countLegacyAnchors(text) {
  return [...text.matchAll(LEGACY_ANCHOR_PATTERN)].length
}

/** 解析锚点：`path#symbol` 或 `path#=literal:<substr>`。 */
export function parseAnchor(anchor) {
  const hash = anchor.indexOf('#')
  if (hash <= 0 || hash === anchor.length - 1) return null
  const file = anchor.slice(0, hash)
  const rest = anchor.slice(hash + 1)
  if (rest.startsWith('=literal:')) return { file, literal: rest.slice('=literal:'.length) }
  return { file, symbol: rest }
}

/** 具名声明抽取（按语言；只做"存在性"判断，不做类型解析）。 */
export function collectDeclarations(text, extension) {
  const names = new Set()
  const add = (name) => names.add(name)
  if (['.ts', '.tsx', '.mts', '.cts', '.mjs', '.js', '.cjs'].includes(extension)) {
    for (const match of text.matchAll(/export\s+(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][A-Za-z0-9_$]*)/gu)) add(match[1])
    for (const match of text.matchAll(/export\s+(?:abstract\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)/gu)) add(match[1])
    for (const match of text.matchAll(/export\s+(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gu)) add(match[1])
    for (const match of text.matchAll(/export\s+(?:interface|type|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gu)) add(match[1])
    for (const match of text.matchAll(/export\s*\{([^}]*)\}/gu)) {
      for (const raw of match[1].split(',')) {
        const name = raw.trim().split(/\s+as\s+/u).pop()
        if (/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(name)) add(name)
      }
    }
  } else if (extension === '.swift') {
    for (const match of text.matchAll(/\bfunc\s+([A-Za-z_][A-Za-z0-9_]*)/gu)) add(match[1])
    for (const match of text.matchAll(/\b(?:class|enum|struct|protocol|extension)\s+([A-Za-z_][A-Za-z0-9_]*)/gu)) add(match[1])
  } else if (extension === '.md') {
    for (const match of text.matchAll(/^#{1,6}\s+.*$/gmu)) {
      const heading = match[0]
      for (const token of heading.matchAll(/[A-Za-z_$][A-Za-z0-9_$.-]*/gu)) add(token[0])
    }
  } else if (['.yaml', '.yml', '.json'].includes(extension)) {
    for (const match of text.matchAll(/^\s*"?([A-Za-z_$][A-Za-z0-9_$.-]*)"?\s*:/gmu)) add(match[1])
  }
  return names
}

/**
 * 具名声明的**声明行**（1-based；0 = 无单行声明，例如多行 `export { … }` 块）。
 * 逐行跑 collectDeclarations，而不是 `line.includes(symbol)`——后者会把
 * 「注释里先提到该符号」的行当成锚点行（--fix 会写回注释行）。
 */
export function declarationLine(text, extension, symbol) {
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    if (collectDeclarations(lines[index], extension).has(symbol)) return index + 1
  }
  return 0
}

/**
 * 在一个文件文本里解析锚点。返回 `{ status, detail }`：
 * `ok` | `ambiguous-symbol`（只报告）| `missing-symbol` | `missing-literal` |
 * `ambiguous-literal` | `no-match`（文件不存在时由调用方处理）。
 */
export function resolveAnchorInText(text, extension, parsed) {
  if (parsed.literal !== undefined) {
    const count = text.split(parsed.literal).length - 1
    if (count === 1) return { status: 'ok', detail: 'literal 恰好命中一次' }
    if (count === 0) return { status: 'missing-literal', detail: 'literal 零命中' }
    return { status: 'ambiguous-literal', detail: 'literal 命中 ' + count + ' 次（要求恰好一次）' }
  }
  const declarations = collectDeclarations(text, extension)
  if (!declarations.has(parsed.symbol)) return { status: 'missing-symbol', detail: '找不到具名声明' }
  const line = declarationLine(text, extension, parsed.symbol)
  return { status: 'ok', detail: line > 0 ? 'line ' + line : 'export-list（多行导出块，无单行声明；--fix 不自动改写）' }
}

/** 遗留锚的测试面三分类（注释 / 字符串 / 断言或其它）。 */
export function classifyAnchors(text) {
  const counts = { comment: 0, string: 0, other: 0 }
  for (const line of text.split('\n')) {
    const matches = [...line.matchAll(LEGACY_ANCHOR_PATTERN)]
    if (matches.length === 0) continue
    const trimmed = line.trim()
    const isComment = trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('#')
    for (const match of matches) {
      if (isComment) { counts.comment += 1; continue }
      const before = line.slice(0, match.index)
      const quotes = (before.match(/["'`]/gu) ?? []).length
      if (quotes % 2 === 1) counts.string += 1
      else counts.other += 1
    }
  }
  return counts
}

/** 生成块区间（`--fix` 拒绝改写）。 */
export function generatedRanges(text) {
  const ranges = []
  const open = /<!--\s*GENERATED:registry:[a-z0-9.-]+:begin\s*-->/gu
  const close = /<!--\s*GENERATED:registry:[a-z0-9.-]+:end\s*-->/gu
  let match
  while ((match = open.exec(text)) !== null) {
    close.lastIndex = match.index
    const end = close.exec(text)
    if (end !== null) ranges.push([match.index, end.index + end[0].length])
  }
  return ranges
}

function readBudget() {
  return JSON.parse(readFileSync(BUDGET_PATH, 'utf8'))
}

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE)
    return
  }
  const known = ['--report', '--fix', '--apply', '--update-budget', '--force', '--file', '--help', '-h']
  const files = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--file') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) {
        console.error('check-anchors: --file 需要一个路径')
        console.error(USAGE)
        process.exitCode = 2
        return
      }
      files.push(value)
      index += 1
      continue
    }
    if (!known.includes(arg)) {
      console.error('check-anchors: 未知参数 ' + arg)
      console.error(USAGE)
      process.exitCode = 2
      return
    }
  }

  let registry
  let budget
  try {
    registry = loadRegistry()
    budget = readBudget()
  } catch (error) {
    console.error('✗ check-anchors: 无法读取 registry.json / anchors-budget.json: ' + error.message)
    console.error('  下一步: node scripts/upstream/verify-registry.mjs')
    process.exitCode = 1
    return
  }
  // 结构损坏（entries 非数组 / fork-seed 缺 classify.patched|own 等）时给出可行动结论，
  // 而不是在后面某处抛 TypeError 栈回溯。
  const shapeFindings = validateRegistry(registry)
  if (shapeFindings.length > 0) {
    for (const finding of shapeFindings) console.error('✗ ' + finding)
    console.error('\n✗ check-anchors: registry.json schema 校验失败——先跑 node scripts/upstream/verify-registry.mjs')
    process.exitCode = 1
    return
  }
  // 预算文件的口径字段不是装饰：与脚本常量不一致 = 有人试图改口径而不是改预算。
  if (budget.scanRoot !== 'docs' || budget.pattern !== LEGACY_ANCHOR_PATTERN.source) {
    console.error('✗ anchors-budget.json 的 scanRoot/pattern 与脚本口径不一致（不得私自改口径）')
    console.error('  期望: scanRoot=docs, pattern=' + LEGACY_ANCHOR_PATTERN.source)
    process.exitCode = 1
    return
  }

  if (argv.includes('--update-budget')) {
    const total = countLegacyAnchorsTotal()
    if (total > budget.legacyAnchors && !argv.includes('--force')) {
      console.error('✗ 当前 ' + total + ' 高于预算 ' + budget.legacyAnchors + '（棘轮只降不升；确要上调用 --force 并说明理由）')
      process.exitCode = 1
      return
    }
    writeFileSync(BUDGET_PATH, JSON.stringify({ ...budget, legacyAnchors: total }, null, 2) + '\n')
    console.log('✓ anchors-budget.json: ' + budget.legacyAnchors + ' → ' + total)
    return
  }

  const anchorFindings = [...checkRegistrySymbols(registry), ...checkDocAnchors()]
  const total = countLegacyAnchorsTotal()
  const budgetFinding = total > budget.legacyAnchors

  if (argv.includes('--fix')) {
    runFix(files, argv.includes('--apply'))
    return
  }
  if (argv.includes('--report')) {
    report(registry, anchorFindings, total, budget)
    return
  }

  let failed = false
  for (const finding of anchorFindings) { console.error('✗ ' + finding); failed = true }
  if (budgetFinding) {
    console.error('✗ 遗留行号锚 ' + total + ' 处 > 预算 ' + budget.legacyAnchors + ' 处（棘轮只降不升）。新锚点请写符号锚 path#symbol；')
    console.error('  迁移后调低: node scripts/upstream/check-anchors.mjs --update-budget')
    failed = true
  }
  if (failed) {
    console.error('\n✗ check-anchors: 门失败')
    process.exitCode = 1
    return
  }
  console.log('✓ check-anchors: 符号锚全部可解析（registry ' + registrySymbolCount(registry) + ' + docs ' + collectDocAnchors().length + ' 个）；遗留行号锚 ' + total + ' / 预算 ' + budget.legacyAnchors + '（棘轮只降不升）')
}

function registrySymbolCount(registry) {
  return registry.entries.reduce((sum, entry) => sum + (entry.symbols ?? []).length, 0)
}

/** registry 符号锚校验；歧义只记录不红。 */
export function checkRegistrySymbols(registry, root = ROOT) {
  const findings = []
  for (const entry of registry.entries) {
    for (const anchor of entry.symbols ?? []) {
      const parsed = parseAnchor(anchor)
      if (parsed === null) { findings.push('[' + entry.id + '] 锚点格式非法: ' + anchor); continue }
      // 锚点路径先按 entry.ours 解析（与 classify 的键同一坐标系），再退回仓库根。
      const relativeToEntry = typeof entry.ours === 'string' ? join(root, entry.ours, parsed.file) : null
      const full = relativeToEntry !== null && existsSync(relativeToEntry) ? relativeToEntry : join(root, parsed.file)
      // 锚点不得越出仓库根（join 会把 /etc/passwd 收进 root，但 .. 会逃逸）。
      const rootResolved = resolve(root)
      if (resolve(full) !== rootResolved && !resolve(full).startsWith(rootResolved + sep)) {
        findings.push('[' + entry.id + '] 锚点路径越出仓库根: ' + parsed.file)
        continue
      }
      if (!existsSync(full)) { findings.push('[' + entry.id + '] 锚点文件不存在（相对 entry.ours 与仓库根都不存在）: ' + parsed.file); continue }
      const result = resolveAnchorInText(readFileSync(full, 'utf8'), full.slice(full.lastIndexOf('.')), parsed)
      if (result.status !== 'ok' && result.status !== 'ambiguous-symbol') findings.push('[' + entry.id + '] ' + anchor + ': ' + result.detail)
    }
  }
  return findings
}

/**
 * docs 正文里的稳定锚（D15 要求的新锚点形态）：`path#symbol` / `path#=literal:<唯一子串>`。
 * 仓内惯例是把锚点包在反引号里，故 literal 允许含空格（匹配到反引号或行尾为止）；`.md`
 * 路径不参与符号锚匹配——`docs/x.md#heading` 是链接而不是代码符号锚。生成块区间内的锚由
 * registry 校验覆盖（坐标系不同），此处跳过。
 */
export function collectDocAnchors(root = ROOT) {
  // 符号段允许 `.`：`src/a.ts#Type.method` 必须整段采集——只吃到 `#Type` 时，
  // 恰好存在导出 `Type` 会让 `method` 零校验。点号形态的处置见
  // checkDocAnchors（显式报不支持，不做静默截断）。
  // 路径字符集含 "+"：Swift 约定把同一类型的功能拆进 `Type+Feature.swift`，
  // 少一个字符就会把锚点路径截成裸 basename（registry 侧的 SYMBOL_PATTERN 用
  // [^#]+，本就接受 "+"）。
  const pattern = /[A-Za-z0-9_/.@+-]+\.(?:ts|tsx|mts|cts|mjs|js|swift|css|json|ya?ml)(?:#=literal:[^`\n]+|#[A-Za-z_$][A-Za-z0-9_$.]*)/gu
  const found = []
  for (const file of collectFiles(join(root, 'docs'), '.md')) {
    const text = readFileSync(file, 'utf8')
    const ranges = generatedRanges(text)
    for (const match of text.matchAll(pattern)) {
      const index = match.index ?? 0
      if (ranges.some(([start, stop]) => index >= start && index < stop)) continue
      // 只接受行内「分隔符之后」的锚：URL（`https://…/src/a.ts#L42`）里每个可能的起始
      // 位置都被 `:`/`/`/`.` 之类字符顶着，字符类会把 scheme 剥掉后采集成
      // `//github.com/…` 并报「锚点文件不存在」的假红。
      if (index > 0 && /[\w/:.@-]/.test(text[index - 1])) continue
      const anchor = match[0].trim()
      found.push({ file, anchor, parsed: parseAnchor(anchor) })
    }
  }
  return found
}

/**
 * 解析 docs 锚点路径：先按仓库根相对；**裸文件名**（既有登记形态，如
 * `WebPermissionPolicyTests.swift#…`）按全仓唯一 basename 解析。越出仓库根返回 null。
 */
function resolveDocAnchorFile(root, file) {
  const rootResolved = resolve(root)
  const direct = resolve(join(root, file))
  if (direct !== rootResolved && !direct.startsWith(rootResolved + sep)) return null
  if (existsSync(direct) && statSync(direct).isFile()) return direct
  if (file.includes('/')) return null
  const suffix = file.slice(file.lastIndexOf('.'))
  const hits = []
  for (const base of ['macos', 'packages', 'scripts', 'docs']) {
    const dir = join(root, base)
    if (!existsSync(dir)) continue
    for (const candidate of collectFiles(dir, suffix)) if (basename(candidate) === file) hits.push(candidate)
  }
  return hits.length === 1 ? hits[0] : null
}

/** docs 手写锚校验（生成块之外）：文件存在且 literal 恰好一次 / 符号声明存在。 */
export function checkDocAnchors(root = ROOT) {
  const findings = []
  for (const { file, anchor, parsed } of collectDocAnchors(root)) {
    const where = '[' + relative(root, file) + ']'
    if (parsed === null) { findings.push(where + ' 锚点格式非法: ' + anchor); continue }
    if (parsed.symbol !== undefined && parsed.symbol.includes('.')) {
      findings.push(where + ' ' + anchor + ': 点号符号锚不受支持（声明抽取只认具名顶层声明，改用 `#=literal:<唯一子串>`）')
      continue
    }
    const full = resolveDocAnchorFile(root, parsed.file)
    if (full === null) {
      findings.push(where + ' ' + anchor + ': 锚点文件不存在（含裸文件名的唯一 basename 解析）')
      continue
    }
    const result = resolveAnchorInText(readFileSync(full, 'utf8'), full.slice(full.lastIndexOf('.')), parsed)
    if (result.status !== 'ok') findings.push(where + ' ' + anchor + ': ' + result.detail)
  }
  return findings
}

function countLegacyAnchorsTotal() {
  let total = 0
  for (const file of collectFiles(LEGACY_SCAN_ROOT, '.md')) total += countLegacyAnchors(readFileSync(file, 'utf8'))
  return total
}

function report(registry, anchorFindings, total, budget) {
  console.log('== 符号锚（registry ' + registrySymbolCount(registry) + ' 个 + docs 手写 ' + collectDocAnchors().length + ' 个）==')
  console.log(anchorFindings.length === 0 ? '  ✓ 全部可解析' : anchorFindings.map((finding) => '  ✗ ' + finding).join('\n'))
  console.log('\n== 遗留行号锚（docs/**/*.md）==')
  const perFile = collectFiles(LEGACY_SCAN_ROOT, '.md')
    .map((file) => ({ file: relative(ROOT, file), count: countLegacyAnchors(readFileSync(file, 'utf8')) }))
    .filter((row) => row.count > 0)
    .sort((left, right) => right.count - left.count)
  for (const row of perFile.slice(0, 15)) console.log('  ' + String(row.count).padStart(4) + '  ' + row.file)
  console.log('  ---- 合计 ' + total + ' / 预算 ' + budget.legacyAnchors + (total > budget.legacyAnchors ? '  ✗ 超预算' : '  ✓'))
  console.log('\n== 测试面锚点三分类（P3 盘点对象，不进预算）==')
  const testCounts = { comment: 0, string: 0, other: 0 }
  for (const file of collectTestSurfaceFiles()) {
    const counts = classifyAnchors(readFileSync(file, 'utf8'))
    testCounts.comment += counts.comment
    testCounts.string += counts.string
    testCounts.other += counts.other
  }
  console.log('  注释 ' + testCounts.comment + ' / 字符串 ' + testCounts.string + ' / 断言或其它 ' + testCounts.other)
}

/** `--fix`：只把"同行恰好一个可解析符号"的 `文件:行` 写回真行号；其余留给人工。 */
export function runFix(files, apply, root = ROOT) {
  if (files.length === 0) {
    console.error('check-anchors --fix: 必须用 --file <path> 指定要改的文件（默认 dry-run）')
    process.exitCode = 2
    return
  }
  let proposals = 0
  let manual = 0
  const rootResolved = resolve(root)
  for (const rel of files) {
    const full = resolve(root, rel)
    // --fix 只能改仓库根以内的文件：join/resolve 会接受 ../，没有包含校验就能改写 checkout 外文件。
    if (full !== rootResolved && !full.startsWith(rootResolved + sep)) {
      console.error('✗ --file 越出仓库根，拒绝改写: ' + rel)
      process.exitCode = 1
      continue
    }
    if (!existsSync(full)) { console.error('✗ 文件不存在: ' + rel); process.exitCode = 1; continue }
    if (!statSync(full).isFile()) { console.error('✗ --file 不是普通文件（目录或设备）: ' + rel); process.exitCode = 1; continue }
    const text = readFileSync(full, 'utf8')
    const ranges = generatedRanges(text)
    const lines = text.split('\n')
    const next = lines.map((line, index) => {
      const lineStart = lines.slice(0, index).reduce((sum, current) => sum + current.length + 1, 0)
      if (ranges.some(([start, stop]) => lineStart >= start && lineStart < stop)) return line
      return line.replace(/([A-Za-z0-9_/.@-]+\.(?:ts|tsx|mts|cts|mjs|js|swift|css|json|ya?ml|md)):(\d+)(?!\d)/gu, (token, file, lineNo) => {
        const symbols = [...line.matchAll(/`([A-Za-z_$][A-Za-z0-9_$.:()\[\]-]*)`/gu)].map((match) => match[1])
        const target = join(root, file)
        if (!existsSync(target) || symbols.length === 0) { manual += 1; return token }
        const targetText = readFileSync(target, 'utf8')
        const extension = target.slice(target.lastIndexOf('.'))
        const declarations = collectDeclarations(targetText, extension)
        const candidates = symbols.filter((symbol) => declarations.has(symbol))
        if (candidates.length !== 1) { manual += 1; return token }
        const targetLine = declarationLine(targetText, extension, candidates[0])
        if (targetLine <= 0 || String(targetLine) === lineNo) { manual += 1; return token }
        proposals += 1
        console.log('  ' + rel + ':' + (index + 1) + '  ' + file + ':' + lineNo + ' → :' + targetLine + '  （' + candidates[0] + '）')
        return token.replace(file + ':' + lineNo, file + ':' + targetLine)
      })
    })
    if (apply && next.join('\n') !== text) writeFileSync(full, next.join('\n'))
  }
  console.log((apply ? '已应用 ' : '拟改动 ') + proposals + ' 处；需人工判读 ' + manual + ' 处' + (apply ? '；请重跑受影响测试' : '（dry-run，加 --apply 写入）'))
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
