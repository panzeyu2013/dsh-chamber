/**
 * check-anchors.test.mjs — 符号锚探针的纯逻辑锁步：锚点解析 / 各语言具名声明抽取 / literal 恰好一次纪律 /
 * 遗留锚计数与三分类 / 生成块区间（--fix 拒绝改写）/ registry 符号锚在临时目录上的 ok-missing 判定。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  LEGACY_ANCHOR_PATTERN, checkDocAnchors, checkRegistrySymbols, classifyAnchors, collectDeclarations,
  collectDocAnchors, collectFiles, countLegacyAnchors, declarationLine, generatedRanges, parseAnchor,
  resolveAnchorInText, runFix,
} from './check-anchors.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
/**
 * 预算上限的独立钉：升级/迁移只能调低；上调必须同时改这里并说明理由——故意的两文件编辑（否则手改 anchors-budget.json
 * 就能把棘轮废掉）。当前钉为整合后的实测值，此后只降不升；批量语义化重锚仍按 D15 在全部在途分支落地后执行，届时逐批调低。
 *
 * 2026-12（remote-status 整合）上调到 1275，与 anchors-budget.json 的 note 同一次：整合前 main（525dc66d）树
 * 实测 665、remote-status 树实测 1279、整合后本树实测 1275，增量全部来自该分支新增的 7 份计划/蓝图文档
 * （它们的「现状盘点」按设计带 file:line 证据锚），main 侧零新增；本次按实测值对齐（无余量）。
 */
const BUDGET_CEILING = 1275

test('collectFiles：悬空软链与软链环不炸门（Chrome SingletonCookie 形态）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-anchors-walk-'))
  try {
    // .tmp 下的 Chrome 配置：悬空软链（GUI 验收留下的真实形态）。
    mkdirSync(join(dir, '.tmp', 'dev-user-data'), { recursive: true })
    symlinkSync('1374599200779130394', join(dir, '.tmp', 'dev-user-data', 'SingletonCookie'))
    // 非 .tmp 目录里的悬空软链：同样不得让门崩，且不得被当成锚点目标。
    mkdirSync(join(dir, 'docs'), { recursive: true })
    writeFileSync(join(dir, 'docs', 'ok.md'), '# ok')
    symlinkSync('missing-target', join(dir, 'docs', 'broken.md'))
    assert.deepEqual(collectFiles(join(dir, 'docs'), '.md'), [join(dir, 'docs', 'ok.md')],
      '悬空软链必须跳过，正常文件照常收集')
    assert.deepEqual(collectFiles(dir, '.md'), [join(dir, 'docs', 'ok.md')], '.tmp 目录整体忽略')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('parseAnchor：path#symbol 与 path#=literal:…', () => {
  assert.deepEqual(parseAnchor('src/a.ts#apply'), { file: 'src/a.ts', symbol: 'apply' })
  assert.deepEqual(parseAnchor('src/a.ts#=literal:const X ='), { file: 'src/a.ts', literal: 'const X =' })
  assert.equal(parseAnchor('src/a.ts'), null)
  assert.equal(parseAnchor('src/a.ts#'), null)
})

test('collectDeclarations：TS / Swift / Markdown / YAML', () => {
  const ts = 'export function apply() {}\nexport const X = 1\nexport class Y {}\nexport interface Z {}\nexport { a as b }\nfunction hidden() {}'
  const tsNames = collectDeclarations(ts, '.ts')
  for (const name of ['apply', 'X', 'Y', 'Z', 'b']) assert.ok(tsNames.has(name), name)
  assert.equal(tsNames.has('hidden'), false)

  const swift = 'func download(_: URL) {}\npublic final class AppUpdater {}\nstruct Box {}\nprivate extension MainWindowController {}'
  const swiftNames = collectDeclarations(swift, '.swift')
  for (const name of ['download', 'AppUpdater', 'Box', 'MainWindowController']) assert.ok(swiftNames.has(name), name)

  assert.ok(collectDeclarations('## RefreshRatePolicy.apply(to:)\n', '.md').has('RefreshRatePolicy.apply'))
  assert.ok(collectDeclarations('name: value\n', '.yaml').has('name'))
})

test('resolveAnchorInText：符号命中 / literal 恰好一次 / 歧义与缺失', () => {
  const text = 'export function apply() {}\n'
  assert.equal(resolveAnchorInText(text, '.ts', { symbol: 'apply' }).status, 'ok')
  assert.equal(resolveAnchorInText(text, '.ts', { symbol: 'missing' }).status, 'missing-symbol')
  assert.equal(resolveAnchorInText('a\nX\nb\n', '.ts', { literal: 'X' }).status, 'ok')
  assert.equal(resolveAnchorInText('X\nX\n', '.ts', { literal: 'X' }).status, 'ambiguous-literal')
  assert.equal(resolveAnchorInText('a\n', '.ts', { literal: 'X' }).status, 'missing-literal')
})

test('declarationLine：注释里先提到符号时，锚点行仍指向真正的声明行', () => {
  const text = '// use apply carefully\nexport const X = 1\n\nexport function apply() {}\n'
  assert.equal(declarationLine(text, '.ts', 'apply'), 4)
  assert.equal(resolveAnchorInText(text, '.ts', { symbol: 'apply' }).detail, 'line 4')
  assert.equal(declarationLine('const x = 1\n', '.ts', 'apply'), 0)
})

test('预算棘轮：上限只降不升，口径字段与脚本一致', () => {
  const budget = JSON.parse(readFileSync(join(HERE, 'anchors-budget.json'), 'utf8'))
  assert.ok(budget.legacyAnchors <= BUDGET_CEILING,
    'legacyAnchors 被上调了（' + budget.legacyAnchors + ' > ' + BUDGET_CEILING + '）：棘轮只能向下；确要上调需同时改本测试的 BUDGET_CEILING 并说明理由')
  assert.equal(budget.scanRoot, 'docs')
  assert.equal(budget.pattern, LEGACY_ANCHOR_PATTERN.source)
})

test('遗留锚计数与三分类', () => {
  const text = [
    '// see main.ts:947 for details',
    'const doc = "AppDelegate.swift:1131-1144"',
    'plain reference SwiftEdgeHostLegs.swift:410',
  ].join('\n')
  assert.equal(countLegacyAnchors(text), 3)
  const counts = classifyAnchors(text)
  assert.deepEqual(counts, { comment: 1, string: 1, other: 1 })
})

test('generatedRanges：--fix 不得改写生成块', () => {
  const text = 'a\n<!-- GENERATED:registry:touchpoints.index:begin -->\nmain.ts:1\n<!-- GENERATED:registry:touchpoints.index:end -->\nb\n'
  const ranges = generatedRanges(text)
  assert.equal(ranges.length, 1)
  const inside = text.slice(ranges[0][0], ranges[0][1])
  assert.ok(inside.includes('main.ts:1'))
})

test('checkRegistrySymbols：临时目录上 ok / missing / 歧义不红', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-anchors-'))
  try {
    mkdirSync(join(root, 'pkg'), { recursive: true })
    writeFileSync(join(root, 'pkg', 'a.ts'), 'export function apply() {}\nexport function other() {}\n')
    const registry = {
      entries: [
        { id: 'seat.ok', ours: 'pkg', symbols: ['a.ts#apply'] },
        { id: 'seat.missing', ours: 'pkg', symbols: ['a.ts#nope'] },
        { id: 'seat.literal', ours: 'pkg', symbols: ['a.ts#=literal:export function other'] },
        { id: 'seat.rootRelative', symbols: ['pkg/a.ts#apply'] },
      ],
    }
    const findings = checkRegistrySymbols(registry, root)
    assert.equal(findings.length, 1)
    assert.ok(findings[0].includes('seat.missing'))

    // 锚点不得越出仓库根（评审实测的 ../ 逃逸面）
    const escaping = { entries: [{ id: 'seat.escape', ours: 'pkg', symbols: ['../../outside.ts#f'] }] }
    assert.ok(checkRegistrySymbols(escaping, root).some((item) => item.includes('越出仓库根')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('collectDocAnchors：URL fragment 不算锚；点号符号整段采集且显式报不支持', () => {
  const root = mkdtempSync(join(tmpdir(), 'anchors-url-'))
  try {
    mkdirSync(join(root, 'docs'), { recursive: true })
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'a.ts'), 'export function apply() {}\nexport const Type = {}\n')
    writeFileSync(join(root, 'docs', 'u.md'), [
      '见 `src/a.ts#apply` 与 https://github.com/foo/bar/blob/main/src/a.ts#L42 的说明。',
      '另见 `src/a.ts#Type.method`。',
      '',
    ].join('\n'))
    const anchors = collectDocAnchors(root).map((entry) => entry.anchor)
    assert.deepEqual(anchors, ['src/a.ts#apply', 'src/a.ts#Type.method'],
      'URL fragment 不得被当成仓内锚（此前会采集成 //github.com/… 并报假红）')
    const findings = checkDocAnchors(root)
    assert.equal(findings.length, 1, findings.join(' | '))
    assert.match(findings[0], /点号符号锚不受支持/, '点号符号必须显式报不支持，不得静默截断成 `Type`')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('checkDocAnchors：裸文件名唯一命中采用、同名歧义报缺失', () => {
  const root = mkdtempSync(join(tmpdir(), 'anchors-bare-'))
  try {
    mkdirSync(join(root, 'docs'), { recursive: true })
    mkdirSync(join(root, 'packages'), { recursive: true })
    writeFileSync(join(root, 'packages', 'WebPolicy.swift'), 'func testApply() {}\n')
    writeFileSync(join(root, 'docs', 'ok.md'), '见 `WebPolicy.swift#testApply`。\n')
    assert.deepEqual(checkDocAnchors(root), [], '唯一 basename 必须被解析到并校验通过')
    mkdirSync(join(root, 'macos'), { recursive: true })
    writeFileSync(join(root, 'macos', 'WebPolicy.swift'), 'func testApply() {}\n')
    const findings = checkDocAnchors(root)
    assert.equal(findings.length, 1, findings.join(' | '))
    assert.match(findings[0], /锚点文件不存在/, '同名两份 basename 属歧义，必须报缺失而不是猜一个')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
test('--fix 拒绝越出 root 的 --file，且 root 外文件保持字节不变', () => {
  const outer = mkdtempSync(join(tmpdir(), 'dsh-fix-escape-'))
  try {
    mkdirSync(join(outer, 'root'), { recursive: true })
    writeFileSync(join(outer, 'outside.md'), 'see `apply` foo.ts:1\n')
    writeFileSync(join(outer, 'root', 'foo.ts'), 'export function apply() {}\n')
    const previousExitCode = process.exitCode
    runFix(['../outside.md'], true, join(outer, 'root'))
    process.exitCode = previousExitCode ?? 0 // runFix 的拒绝会置 1；这是库内调用，恢复退出码
    assert.ok(readFileSync(join(outer, 'outside.md'), 'utf8').includes('foo.ts:1'), 'root 外的文件不得被改写')
  } finally {
    rmSync(outer, { recursive: true, force: true })
  }
})

test('checkDocAnchors：docs 手写锚的 ok / missing / ambiguous 与生成块跳过', () => {
  const root = mkdtempSync(join(tmpdir(), 'anchors-doc-'))
  try {
    mkdirSync(join(root, 'docs'), { recursive: true })
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'a.ts'), 'export function apply() {}\nconst marker = \'unique\'\nconst twice = 1\nconst twice2 = 1\ntwice\ntwice2\n')
    writeFileSync(join(root, 'docs', 'ok.md'), [
      '见 `src/a.ts#apply` 与 `src/a.ts#=literal:const marker`。',
      '<!-- GENERATED:registry:x:begin -->',
      '`src/a.ts#=literal:not here`',
      '`src/a.ts#noSuchSymbol`',
      '<!-- GENERATED:registry:x:end -->',
      '',
    ].join('\n'))
    writeFileSync(join(root, 'docs', 'bad.md'), '见 `src/a.ts#=literal:const nope` 与 `src/a.ts#noSuchSymbol`。\n')
    const findings = checkDocAnchors(root)
    assert.equal(findings.length, 2, findings.join(' | '))
    assert.ok(findings.every((finding) => finding.startsWith('[docs/bad.md]')), findings.join(' | '))
    assert.equal(collectDocAnchors(root).length, 4, '生成块内的两个锚必须被跳过')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
