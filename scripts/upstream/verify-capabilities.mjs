#!/usr/bin/env node
/**
 * 能力面对齐门（I-6）：`scripts/upstream/capabilities.json` × vendor 源树。
 *
 * 每条能力 = 一个机械探针（vendor 树内 roots × symbol/patterns）+ 期望（present/absent）
 * + chamber 侧消费者（requires / localWorkaround.by，路径存在性一并校验）。判定：
 *
 *   aligned             观测 == 期望（期望 absent 时正是「本地替代仍必要」的登记态）
 *   chamber-behind      期望 present 而缺席、chamber 尚未消费 ⇒ 门红：pin 落后于能力的登记面
 *   chamber-ahead-broken 期望 present 而缺席、chamber 已消费 ⇒ 门红：调用面运行时必炸
 *   upstream-landed     期望 absent 而出现 ⇒ 门红：本地替代的退役触发已到（打印 retireWhen）
 *   probe-unresolvable  vendor 未物化或探针根缺失 ⇒ 门红：缺席无法证明
 *   consumer-missing    chamber 消费者路径不存在 ⇒ 门红：登记面腐烂
 *
 * 只读、离线；`--self-test` 自带负控，`--json` 供 CI 消费，`--vendor-root` / `--capabilities` 供夹具。
 *
 * 已知边界：symbol/patterns 是**纯文本**匹配（注释或字符串里的提及也算命中），故 present 条目的 roots
 * 应收窄到声明所在的包（例如会话方法在 `session/*` 单数命名空间、会话级工作区方法在 `workspace/*`；
 * 形如 `xxx.sessions.delete(id)` 的 Map 调用会被 `sessions\.delete` 命中，故缺席探针只取路由形状）；
 * 测试目录与 `*.test.*`/`*.spec.*` 已从扫描面排除，但注释与字符串仍算命中——登记时宁可写窄，
 * 也别把注释里的旧拼写留在范围内；升级成 `path#symbol` 锚点解析（复用 check-anchors 的声明解析）
 * 需先物化 vendor 逐条验证，是跟进项。
 *
 * 离线预检夹具：同版本发行安装（`node_modules/@deepseek-ai/*`，按各自 `repository.directory` 映射回
 * `packages/<…>`、把 `lib/` 内容放到 `src/` 下）可作 `--vendor-root` 的近似树，用来核对探针定义与
 * 官方实现是否一致；它不能替代升级时对 vendor 源树的正式判定。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = resolve(HERE, '..', '..')
export const CAPABILITIES_PATH = join(HERE, 'capabilities.json')
export const DEFAULT_VENDOR_ROOT = join(REPO_ROOT, 'vendor', 'harness-checkout')

const TOP_KEYS = ['schema', 'note', 'capabilities']
const ENTRY_KEYS = ['id', 'note', 'probe', 'requires', 'localWorkaround']
const PROBE_KEYS = ['roots', 'symbol', 'patterns', 'expect']
const WORKAROUND_KEYS = ['by', 'retireWhen']
const SOURCE_SUFFIXES = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs']
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage', 'lib', 'build', 'test', 'tests', '__tests__', '__mocks__'])
/** 测试文件不是能力声明面：扫进来只会把注释/夹具里的字符串读成上游落地。 */
const SKIP_FILE = /\.(?:test|spec)\.[A-Za-z]+$/u
const IDENTIFIER_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/u
const RELATIVE_VENDOR_PATH = /^(?![\/])[A-Za-z0-9._@-]+(?:\/[A-Za-z0-9._@-]+)*$/u

/** 相对 vendor 根的路径：形状之外还要拒绝 `.`/`..` 段——探针根不得越出 vendor 根。 */
function isRelativeVendorPath(value) {
  return typeof value === 'string' && RELATIVE_VENDOR_PATH.test(value)
    && !value.split('/').some((segment) => segment === '.' || segment === '..')
}

export const VERDICT = Object.freeze({
  aligned: 'aligned',
  behind: 'chamber-behind',
  broken: 'chamber-ahead-broken',
  landed: 'upstream-landed',
  unresolvable: 'probe-unresolvable',
  consumer: 'consumer-missing',
})
/** 会让本门退出的判定（绿 = 全部 aligned）。 */
export const FAILING = new Set([VERDICT.behind, VERDICT.broken, VERDICT.landed, VERDICT.unresolvable, VERDICT.consumer])

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Entry 声明的 chamber 侧消费者路径里不存在的那些（`requires` + `localWorkaround.by`）。
 * 存在性在这里单点判定：形状错误（非 packages/ 前缀）由 validateCapabilities 分别报，
 * 判定阶梯把它作为**独立于 vendor 的** `consumer-missing` 行（--json 也能看到，而不只是退出码）。
 */
export function missingConsumerPaths(entry, repoRoot = REPO_ROOT) {
  const missing = []
  const declared = [
    ...(Array.isArray(entry.requires) ? entry.requires.map((path) => ['.requires', path]) : []),
    ...(isPlainObject(entry.localWorkaround) && Array.isArray(entry.localWorkaround.by)
      ? entry.localWorkaround.by.map((path) => ['.localWorkaround.by', path]) : []),
  ]
  for (const [label, path] of declared) {
    if (typeof path === 'string' && path.startsWith('packages/') && !existsSync(join(repoRoot, path))) {
      missing.push(label + ' 路径不存在: ' + path)
    }
  }
  return missing
}

/** 读取能力登记（默认 `capabilities.json`）。 */
export function loadCapabilities(path = CAPABILITIES_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** 形状校验 + chamber 侧消费者路径存在性；返回问题清单（空 = 绿）。 */
export function validateCapabilities(capabilities, repoRoot = REPO_ROOT) {
  const problems = []
  if (!isPlainObject(capabilities)) return ['capabilities.json 必须是对象']
  for (const key of Object.keys(capabilities)) if (!TOP_KEYS.includes(key)) problems.push('未知顶层字段: ' + key)
  if (capabilities.schema !== 1) problems.push('schema 必须是 1')
  if (typeof capabilities.note !== 'string' || capabilities.note === '') problems.push('note 必须是非空字符串')
  if (!Array.isArray(capabilities.capabilities) || capabilities.capabilities.length === 0) {
    problems.push('capabilities 必须是非空数组')
    return problems
  }
  const seen = new Set()
  for (const [index, entry] of capabilities.capabilities.entries()) {
    const at = 'capabilities[' + index + ']'
    if (!isPlainObject(entry)) { problems.push(at + ' 不是对象'); continue }
    for (const key of Object.keys(entry)) if (!ENTRY_KEYS.includes(key)) problems.push(at + ' 未知字段: ' + key)
    if (typeof entry.id !== 'string' || entry.id === '') problems.push(at + '.id 必须是非空字符串')
    else if (seen.has(entry.id)) problems.push(at + '.id 重复: ' + entry.id)
    else seen.add(entry.id)
    if (typeof entry.note !== 'string' || entry.note === '') problems.push(at + '.note 必须是非空字符串')
    const probe = entry.probe
    if (!isPlainObject(probe)) problems.push(at + '.probe 必须是对象')
    else {
      for (const key of Object.keys(probe)) if (!PROBE_KEYS.includes(key)) problems.push(at + '.probe 未知字段: ' + key)
      if (!Array.isArray(probe.roots) || probe.roots.length === 0) problems.push(at + '.probe.roots 必须是非空数组')
      else for (const root of probe.roots) {
        if (!isRelativeVendorPath(root)) problems.push(at + '.probe.roots 必须是 vendor 树内相对路径（不得含 . 或 .. 段）: ' + JSON.stringify(root))
      }
      const hasSymbol = typeof probe.symbol === 'string' && probe.symbol !== ''
      const hasPatterns = Array.isArray(probe.patterns) && probe.patterns.length > 0
      if (hasSymbol === hasPatterns) problems.push(at + '.probe 必须恰好给 symbol 或 patterns 之一')
      if (hasSymbol && !IDENTIFIER_PATTERN.test(probe.symbol)) problems.push(at + '.probe.symbol 非法标识符: ' + JSON.stringify(probe.symbol))
      if (hasPatterns) for (const pattern of probe.patterns) {
        if (typeof pattern !== 'string' || pattern === '') { problems.push(at + '.probe.patterns 必须是非空字符串数组'); continue }
        try { new RegExp(pattern, 'u') } catch { problems.push(at + '.probe.patterns 非法正则: ' + JSON.stringify(pattern)) }
      }
      if (probe.expect !== 'present' && probe.expect !== 'absent') problems.push(at + '.probe.expect 必须是 present/absent: ' + JSON.stringify(probe.expect))
    }
    if (!Array.isArray(entry.requires)) problems.push(at + '.requires 必须是数组')
    else for (const consumer of entry.requires) {
      if (typeof consumer !== 'string' || !consumer.startsWith('packages/')) problems.push(at + '.requires 必须是 packages/ 下的仓内路径: ' + JSON.stringify(consumer))
    }
    // expect=absent + requires 是自相矛盾的登记（消费一个已登记为缺席的能力）：形状直接红，
    // 判定阶梯也给 chamber-ahead-broken，避免登记面被误改后门不响。
    if (entry.probe?.expect === 'absent' && Array.isArray(entry.requires) && entry.requires.length > 0) {
      problems.push(at + ': expect=absent 的条目不得声明 requires（有消费面就应按 present 登记）')
    }
    // 头注约定：expect=absent 的条目必须带 localWorkaround.retireWhen —— 缺席类登记在门红时
    // 唯一的行动指令就是这条退役触发，缺它等于登记了一个没有出口的等待。
    if (entry.probe?.expect === 'absent'
      && (typeof entry.localWorkaround?.retireWhen !== 'string' || entry.localWorkaround.retireWhen === '')) {
      problems.push(at + ': expect=absent 的条目必须带 localWorkaround.retireWhen（上游落地时的退役触发）')
    }
    if (entry.localWorkaround !== undefined) {
      const workaround = entry.localWorkaround
      if (!isPlainObject(workaround)) problems.push(at + '.localWorkaround 必须是对象')
      else {
        for (const key of Object.keys(workaround)) if (!WORKAROUND_KEYS.includes(key)) problems.push(at + '.localWorkaround 未知字段: ' + key)
        if (!Array.isArray(workaround.by) || workaround.by.length === 0) problems.push(at + '.localWorkaround.by 必须是非空数组')
        else for (const consumer of workaround.by) {
          if (typeof consumer !== 'string' || !consumer.startsWith('packages/')) problems.push(at + '.localWorkaround.by 必须是 packages/ 下的仓内路径: ' + JSON.stringify(consumer))
        }
        if (typeof workaround.retireWhen !== 'string' || workaround.retireWhen === '') problems.push(at + '.localWorkaround.retireWhen 必须是非空字符串（本地替代的退役触发）')
      }
    }
    for (const problem of missingConsumerPaths(entry, repoRoot)) problems.push(at + ' ' + problem)
  }
  return problems
}

function sourceFilesUnder(root) {
  const files = []
  const visit = (dir) => {
    let names
    try { names = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const item of names) {
      if (item.isDirectory()) {
        if (!SKIP_DIRS.has(item.name)) visit(join(dir, item.name))
      } else if (SOURCE_SUFFIXES.some((suffix) => item.name.endsWith(suffix)) && !SKIP_FILE.test(item.name)) files.push(join(dir, item.name))
    }
  }
  visit(root)
  return files
}

function probeMatcher(probe) {
  if (probe.symbol !== undefined) {
    const escaped = probe.symbol.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    return (text) => new RegExp('\\b' + escaped + '\\b', 'u').test(text)
  }
  const patterns = probe.patterns.map((pattern) => new RegExp(pattern, 'u'))
  return (text) => patterns.some((pattern) => pattern.test(text))
}

/** 观测一条探针：roots 全缺 = 不可判定（absent 无法证明）。 */
export function observeProbe(probe, vendorRoot) {
  const missingRoots = []
  const hits = []
  const matches = probeMatcher(probe)
  const boundary = resolve(vendorRoot)
  for (const root of probe.roots) {
    const absolute = resolve(vendorRoot, root)
    // 越界根 = 不可判定（fail closed）：形状校验已拒绝 `..`，这里再兜一层实现层的逃逸。
    if (absolute !== boundary && !absolute.startsWith(boundary + sep)) { missingRoots.push(root); continue }
    if (!existsSync(absolute)) { missingRoots.push(root); continue }
    for (const file of sourceFilesUnder(absolute)) {
      let text
      try { text = readFileSync(file, 'utf8') } catch { continue }
      if (matches(text)) {
        const id = relative(vendorRoot, file).split('\\').join('/')
        if (!hits.includes(id)) hits.push(id)
        if (hits.length >= 3) break
      }
    }
    if (hits.length >= 3) break
  }
  return { resolvable: missingRoots.length === 0, missingRoots, hits, present: hits.length > 0 }
}

/** 判定全部条目；`ok === false` 时 CLI 退出 1。 */
export function evaluateCapabilities(capabilities, options = {}) {
  const vendorRoot = options.vendorRoot ?? DEFAULT_VENDOR_ROOT
  const repoRoot = options.repoRoot ?? REPO_ROOT
  const rows = []
  for (const entry of capabilities.capabilities ?? []) {
    const requires = entry.requires ?? []
    const missingConsumers = missingConsumerPaths(entry, repoRoot)
    const subject = entry.probe.symbol ?? (entry.probe.patterns ?? []).join('|')
    let verdict = VERDICT.aligned
    let detail
    if (missingConsumers.length > 0) {
      // Vendor-independent registry rot: report it as its own row (not just a shape problem).
      verdict = VERDICT.consumer
      rows.push({ id: entry.id, expect: entry.probe.expect, verdict, detail: 'chamber 消费者: ' + missingConsumers.join('; '), hits: [] })
      continue
    }
    if (entry.probe.expect === 'absent' && requires.length > 0) {
      verdict = VERDICT.broken
      detail = 'expect=absent 却声明了 chamber 消费者: ' + requires.join(', ')
      rows.push({ id: entry.id, expect: entry.probe.expect, verdict, detail, hits: [] })
      continue
    }
    const observation = observeProbe(entry.probe, vendorRoot)
    if (!observation.resolvable) {
      verdict = VERDICT.unresolvable
      detail = '探针根缺失（vendor 未物化或路径漂移）: ' + observation.missingRoots.join(', ')
    } else if (observation.present && entry.probe.expect === 'present') {
      detail = '命中 ' + observation.hits.length + ' 处: ' + observation.hits.join(', ')
    } else if (!observation.present && entry.probe.expect === 'present') {
      verdict = requires.length > 0 ? VERDICT.broken : VERDICT.behind
      detail = 'vendor 无 ' + subject + (requires.length > 0
        ? '，但 chamber 已消费 ' + requires.length + ' 处: ' + requires.join(', ')
        : '（chamber 尚未消费，可安全领先）')
    } else if (observation.present && entry.probe.expect === 'absent') {
      verdict = VERDICT.landed
      detail = '上游已出现 ' + subject + '（命中: ' + observation.hits.join(', ') + '）'
        + (entry.localWorkaround ? '；退役触发: ' + entry.localWorkaround.retireWhen : '；请重排期范围决策')
    } else {
      detail = '按期望缺席: ' + subject
        + (entry.localWorkaround ? '；退役触发: ' + entry.localWorkaround.retireWhen : '')
    }
    rows.push({ id: entry.id, expect: entry.probe.expect, verdict, detail, hits: observation.hits })
  }
  return { rows, ok: rows.every((row) => !FAILING.has(row.verdict)) }
}

/** 门内负控：判定夹具 + 真实登记形状。`--self-test` 与测试共用这一份（负控不复制）。 */
export function runSelfTest() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-capabilities-'))
  try {
    const present = join(root, 'packages/api/workspace.ts')
    mkdirSync(dirname(present), { recursive: true })
    writeFileSync(present, 'export async function unarchiveSession() {}\n')
    mkdirSync(join(root, 'packages/api/empty'), { recursive: true })
    // 探针语义负控（I-6 验收锚）：普通 Map 调用不得被读成 delete wire；路由形状必须被读出来。
    const mapCall = join(root, 'packages/api/map-call/prune.ts')
    mkdirSync(dirname(mapCall), { recursive: true })
    writeFileSync(mapCall, 'export function prune(sessions, id) {\n  this.sessions.delete(id)\n  sessions.deleteMany?.(id)\n}\n')
    const routeDecl = join(root, 'packages/api/route-decl/controller.ts')
    mkdirSync(dirname(routeDecl), { recursive: true })
    writeFileSync(routeDecl, "export const descriptor = { id: '@deepseek-ai/dsh-api-session-controller#session/delete' }\n")
    const browseFilter = join(root, 'packages/client/ui-workspace/filter.ts')
    mkdirSync(dirname(browseFilter), { recursive: true })
    writeFileSync(browseFilter, 'export const actions = { setArchivedFilter: () => {} }\n')
    const cases = [
      { name: 'present+found → aligned', probe: { roots: ['packages/api'], symbol: 'unarchiveSession', expect: 'present' }, requires: [], want: VERDICT.aligned },
      { name: 'present+missing+no consumer → behind', probe: { roots: ['packages/api'], symbol: 'neverThere', expect: 'present' }, requires: [], want: VERDICT.behind },
      { name: 'present+missing+consumer → broken', probe: { roots: ['packages/api'], symbol: 'neverThere', expect: 'present' }, requires: ['packages/dsh-chamber-client-core/src/instance-api.ts'], want: VERDICT.broken },
      { name: 'absent+missing → aligned', probe: { roots: ['packages/api'], patterns: ['never-landed-wire'], expect: 'absent' }, requires: [], want: VERDICT.aligned },
      { name: 'absent+found → landed', probe: { roots: ['packages/api'], symbol: 'unarchiveSession', expect: 'absent' }, requires: [], want: VERDICT.landed },
      { name: 'missing root → unresolvable', probe: { roots: ['packages/api/gone'], symbol: 'x', expect: 'present' }, requires: [], want: VERDICT.unresolvable },
      { name: 'absent+requires → broken', probe: { roots: ['packages/api'], patterns: ['never-landed-wire'], expect: 'absent' }, requires: ['packages/dsh-chamber-client-core/src/instance-api.ts'], want: VERDICT.broken },
      { name: 'missing consumer path → consumer-missing', probe: { roots: ['packages/api'], symbol: 'unarchiveSession', expect: 'present' }, requires: ['packages/nope/gone.ts'], want: VERDICT.consumer },
      // 探针形状负控（真实登记里的 delete 探针必须用这组路由形状）：Map 调用 = 缺席，路由声明 = 落地。
      { name: 'Map .delete call stays absent → aligned', probe: { roots: ['packages/api/map-call'], patterns: ['session/delete(?![A-Za-z])', 'sessions/delete(?![A-Za-z])', '\\bdeleteSession\\b'], expect: 'absent' }, requires: [], want: VERDICT.aligned },
      { name: 'route-shaped session/delete → landed', probe: { roots: ['packages/api/route-decl'], patterns: ['session/delete(?![A-Za-z])', 'sessions/delete(?![A-Za-z])', '\\bdeleteSession\\b'], expect: 'absent' }, requires: [], want: VERDICT.landed },
      { name: 'setArchivedFilter matches the browse pattern', probe: { roots: ['packages/client/ui-workspace'], patterns: ['[Aa]rchivedFilter'], expect: 'present' }, requires: [], want: VERDICT.aligned },
      { name: 'bulk patterns stay absent on a Map call', probe: { roots: ['packages/api/map-call'], patterns: ['session/deleteAll', 'session/deleteMany', 'sessions/deleteAll', 'sessions/deleteMany', 'deleteAllSessions'], expect: 'absent' }, requires: [], want: VERDICT.aligned },
    ]
    let failed = 0
    for (const item of cases) {
      const outcome = evaluateCapabilities({ capabilities: [{ id: item.name, note: 'fixture', probe: item.probe, requires: item.requires }] }, { vendorRoot: root })
      const got = outcome.rows[0]?.verdict
      if (got !== item.want) { failed += 1; console.error('[self-test] ✗ ' + item.name + '（got ' + got + '）') }
    }
    const shapeProblems = validateCapabilities(loadCapabilities())
    if (shapeProblems.length > 0) {
      failed += 1
      console.error('[self-test] ✗ 真实 capabilities.json 校验失败:\n  ' + shapeProblems.join('\n  '))
    }
    // 校验器/扫描面负控：越界根、缺席类缺退役触发、测试文件被当证据，三者都必须被挡住。
    const escapeDir = join(root, 'vendor')
    mkdirSync(escapeDir, { recursive: true })
    writeFileSync(join(root, 'outside-secret.ts'), 'export const secretMarker = 1\n')
    if (observeProbe({ roots: ['../outside-secret.ts'], patterns: ['secretMarker'], expect: 'present' }, escapeDir).present) {
      failed += 1
      console.error('[self-test] ✗ 越界探针根必须不可判定（不得读出 vendor 根之外的内容）')
    }
    const shapeFixture = (probe) => ({ schema: 1, note: 'fixture', capabilities: [{ id: 'x', note: 'fixture', probe, requires: [] }] })
    if (!validateCapabilities(shapeFixture({ roots: ['packages/..'], symbol: 'x', expect: 'present' })).some((p) => p.includes('roots'))) {
      failed += 1
      console.error('[self-test] ✗ packages/.. 根必须被判形状错误')
    }
    if (!validateCapabilities(shapeFixture({ roots: ['packages/api'], symbol: 'x', expect: 'absent' })).some((p) => p.includes('retireWhen'))) {
      failed += 1
      console.error('[self-test] ✗ expect=absent 缺 localWorkaround.retireWhen 必须被判形状错误')
    }
    const noiseTest = join(root, 'packages/api/noise/wire.test.ts')
    mkdirSync(dirname(noiseTest), { recursive: true })
    writeFileSync(noiseTest, '// session/delete\n')
    if (observeProbe({ roots: ['packages/api/noise'], patterns: ['session/delete'], expect: 'absent' }, root).present) {
      failed += 1
      console.error('[self-test] ✗ 测试文件不得作为能力证据')
    }
    // 真实登记的两条缺席探针覆盖面负控（子代理审计 finding）：真 delete wire 落在非 api 包
    // （会话服务在 packages/session/**）也必须报落地，根不能只收 packages/api。
    const deleteEntry = loadCapabilities().capabilities.find((entry) => entry.id === 'sessions.delete(sessionId)')
    const nonApiRoot = join(root, 'non-api')
    const nonApiWire = join(nonApiRoot, 'packages/session/session-x/src/wire.ts')
    mkdirSync(dirname(nonApiWire), { recursive: true })
    writeFileSync(nonApiWire, "export const id = '@deepseek-ai/dsh-api-session-controller#session/delete'\n")
    const landedRow = evaluateCapabilities({ capabilities: [deleteEntry] }, { vendorRoot: nonApiRoot }).rows[0]
    if (landedRow?.verdict !== VERDICT.landed) {
      failed += 1
      console.error('[self-test] ✗ 非 api 包里的真 delete wire 必须报 upstream-landed（got ' + landedRow?.verdict + '）')
    }
    if (failed > 0) { console.error('[self-test] 失败 ' + failed + ' 项'); return 1 }
    console.log('[self-test] ok：' + cases.length + ' 个判定夹具 + capabilities.json 形状/消费者路径')
    return 0
  } finally { rmSync(root, { recursive: true, force: true }) }
}

function parseArgs(argv) {
  const options = { json: false, selfTest: false, vendorRoot: DEFAULT_VENDOR_ROOT, capabilities: CAPABILITIES_PATH, problems: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json') options.json = true
    else if (arg === '--self-test') options.selfTest = true
    else if (arg === '--vendor-root') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) { options.problems.push('--vendor-root 需要一个目录参数'); continue }
      options.vendorRoot = resolve(value)
      index += 1
    } else if (arg === '--capabilities') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) { options.problems.push('--capabilities 需要一个文件参数'); continue }
      options.capabilities = resolve(value)
      index += 1
    } else options.problems.push('未知参数: ' + arg)
  }
  return options
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.problems.length > 0) { for (const problem of options.problems) console.error('[capabilities] ' + problem); return 1 }
  if (options.selfTest) return runSelfTest()
  const capabilities = loadCapabilities(options.capabilities)
  const shapeProblems = validateCapabilities(capabilities)
  const evaluation = evaluateCapabilities(capabilities, { vendorRoot: options.vendorRoot })
  const vendorMissing = !existsSync(options.vendorRoot)
  if (options.json) {
    console.log(JSON.stringify({ vendorRoot: options.vendorRoot, vendorMissing, problems: shapeProblems, ...evaluation }, null, 2))
  } else {
    if (vendorMissing) console.error('[capabilities] vendor 树不存在: ' + options.vendorRoot)
    for (const problem of shapeProblems) console.error('[capabilities] 形状/消费者: ' + problem)
    for (const row of evaluation.rows) {
      const mark = FAILING.has(row.verdict) ? '✗' : '✓'
      console.log('[' + mark + '] ' + row.verdict.padEnd(20) + ' ' + row.id + ' — ' + row.detail)
    }
    const failed = evaluation.rows.filter((row) => FAILING.has(row.verdict)).length
    console.log('[capabilities] ' + (evaluation.rows.length - failed) + '/' + evaluation.rows.length + ' aligned'
      + (shapeProblems.length > 0 ? '；形状问题 ' + shapeProblems.length : ''))
  }
  return shapeProblems.length === 0 && evaluation.ok ? 0 : 1
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) process.exitCode = main()
