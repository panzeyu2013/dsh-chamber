/**
 * verify-artifact-freshness.test.mjs — 陈旧门**规范化函数**的负例测试。
 *
 * 为什么需要：checkMobileClientBundle 的逐字节比对前会把 esbuild 的模块注释
 * 规范化（临时副本构建的上跳层级与就地构建不同）。旧 canonComment 会改写**任何**
 * 以 "// " 开头、含 packages/ 或前导 ../ 的行——模板字面量里的内容行也被一起
 * 规范化，两侧的真实字节差异被抹平，陈旧产物就能蒙混过关。这里把 canonComment
 * 钉在「只改写真正的 esbuild 模块注释（带源码扩展名）」上，并证明内容行不被改写
 * ⇒ 差异仍被检出。
 *
 * 同时把门的 --self-test 拉进 test:scripts：那个自测原来没有自动化调用者，
 * 删掉/改坏比对器不会有任何测试变红（run-script-tests.mjs 的 gates 组登记本文件）。
 *
 * 跑法：node --test scripts/gates/verify-artifact-freshness.test.mjs。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  MODULE_COMMENT_LINE, canonComment, canonRungs, generatedTreeVerdict, summarizeResults,
} from './verify-artifact-freshness.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
/** 与 checkMobileClientBundle 里同一套组合（测试用同一步骤，避免判据两处漂移）。 */
const canonical = (source, options) => source.split('\n').map(line => canonComment(line, options)).join('\n')

test('canonComment：tail 能解析到真实文件的模块注释才规范化（按 packages/ 尾段 + 去上跳层级）', t => {
  assert.ok(MODULE_COMMENT_LINE.test('// ../../packages/dsh-chamber-client-ui-mobile/src/client/index.ts'))
  assert.equal(canonComment('// ../../packages/dsh-chamber-client-ui-mobile/src/client/index.ts'),
    '// dsh-chamber-client-ui-mobile/src/client/index.ts')
  assert.equal(canonComment('// ../dsh-chamber-client-core/src/svg-resource-scope.ts'),
    '// dsh-chamber-client-core/src/svg-resource-scope.ts')
  assert.equal(canonComment('// src/client/styles.ts'), '// src/client/styles.ts')
  // 路径含空格（本仓在 "Application Support" 下）也必须识别为模块注释，否则 staged
  // 与 in-place 的注释前缀永远不同 ⇒ freshness 假 STALE；存在性判据用一个 fixture
  // 仓根，避免测试依赖真实仓库里恰好存在某个包。
  const root = mkdtempSync(join(tmpdir(), 'dsh-fresh-comment-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'packages', 'a', 'src'), { recursive: true })
  writeFileSync(join(root, 'packages', 'a', 'src', 'x.ts'), '')
  const roots = { roots: [root] }
  assert.ok(MODULE_COMMENT_LINE.test('// /tmp/Application Support/packages/a/src/x.ts'))
  assert.equal(
    canonComment('// ../../../Users/me/Application Support/packages/a/src/x.ts', roots),
    '// a/src/x.ts',
  )
  // 原始路径直接解析得到真实文件的（staged 绝对路径）同样规范化。
  assert.equal(canonComment('// /tmp/Application Support/packages/a/src/x.ts', roots), '// a/src/x.ts')
  // 上跳层级不同、同一条模块注释 ⇒ 规范化后必须相同（否则 staged/in-place 永远假红）。
  assert.equal(
    canonical('// ../../../packages/a/src/x.ts\nconst a = 1', roots),
    canonical('// ../../packages/a/src/x.ts\nconst a = 1', roots),
  )
  // 不存在的 tail 不是模块注释：没有任何真实文件可解析 ⇒ 原样保留。
  assert.equal(canonComment('// ../../packages/a/src/ghost.ts', roots), '// ../../packages/a/src/ghost.ts')
})

test('canonComment：模板字面量/注释里的内容行不得被改写（旧的宽松规则会抹平差异）', () => {
  // 旧规则的等价实现：任何 "// " 行，只要含 packages/ 或前导 ../ 就被重写。
  const oldCanonComment = line => {
    if (!/^\/\/ /.test(line) || line.startsWith('//#') || line.startsWith('//!') || /^\/\/\//.test(line)) return line
    let path = line.slice(3)
    const anchor = path.lastIndexOf('packages/')
    if (anchor >= 0) path = path.slice(anchor + 'packages/'.length)
    return '// ' + path.replace(/^(?:\.\.\/)+/, '')
  }
  const oldCanonical = source => source.split('\n').map(oldCanonComment).join('\n')
  // 两侧内容行只差上跳层级（内容本身不同），旧规则把它们抹成同一行；新规则必须原样保留。
  const rebuilt = 'const css = ' + String.fromCharCode(96) + '\n// ../packages/keep-this\n' + String.fromCharCode(96)
  const onDisk = 'const css = ' + String.fromCharCode(96) + '\n// ../../packages/keep-this\n' + String.fromCharCode(96)
  assert.equal(oldCanonical(rebuilt), oldCanonical(onDisk), '前提：旧规则确实会抹平这条内容行差异（这正是要修的假绿）')
  assert.notEqual(canonical(rebuilt), canonical(onDisk), '内容行不被改写 ⇒ 陈旧仍被检出')
  // 扩展名不是判据：带真实扩展名的内容行（`// ../packages/keep.ts`）同样不得被
  // 改写。只按「形状」（^// + 扩展名 + packages/ 或前导 ../）判定的规则会把它和
  // `// ../../packages/keep.ts` 抹成同一行；tail 解析不到真实文件时必须原样保留，
  // 否则模板字面量里的差异仍被抹平（这是形状门遗留的假绿）。
  const tick = String.fromCharCode(96)
  const extRebuilt = 'const tpl = ' + tick + '\n// ../packages/keep.ts\n' + tick
  const extOnDisk = 'const tpl = ' + tick + '\n// ../../packages/keep.ts\n' + tick
  const shapeOnly = line => (MODULE_COMMENT_LINE.test(line) ? '// ' + line.slice(3).replace(/^(?:\.\.\/)+/, '') : line)
  const shapeOnlyCanonical = source => source.split('\n').map(shapeOnly).join('\n')
  assert.equal(shapeOnlyCanonical(extRebuilt), shapeOnlyCanonical(extOnDisk),
    '前提：只按形状判定的规则会抹平带扩展名的内容行（形状门的残余假绿）')
  assert.notEqual(canonical(extRebuilt), canonical(extOnDisk), 'tail 不存在 ⇒ 内容行原样保留，差异仍可见')
  // 其它非模块注释行原样保留。
  for (const line of [
    '// keep this',
    '// ../packages/keep',
    '// ../packages/keep.ts',
    '// ../../packages/a/src/ghost.ts',
    '//# sourceMappingURL=client.js.map',
    '//! license banner',
    '/// doc comment',
    '// foo.ts // not a whole-line module comment',
    '// ../packages/a/src/x.ts.map',
  ]) {
    assert.equal(canonComment(line), line, line)
  }
})

test('canonComment：模块路径内容不同（不是层级不同）时仍保持不同 ⇒ 真陈旧会被检出', () => {
  assert.notEqual(
    canonical('// ../../packages/a/src/x.ts'),
    canonical('// ../../packages/a/src/y.ts'),
  )
})


test('--self-test 走门：门的负控必须真的能失败（挂进 test:scripts）', () => {
  const result = spawnSync(process.execPath, [join(HERE, 'verify-artifact-freshness.mjs'), '--self-test'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /artifact-freshness self-test: ok/)
})

test('canonRungs：只收敛模块注释行的上跳层级，代码里的 ../ 串必须原样保留', () => {
  assert.equal(canonRungs('// ../../node_modules/.pnpm/ws@8.21.3/node_modules/ws/lib/constants.js'),
    '// @up@/node_modules/.pnpm/ws@8.21.3/node_modules/ws/lib/constants.js')
  assert.equal(canonRungs("const rel = '../../node_modules/x'"), "const rel = '../../node_modules/x'")
  assert.equal(canonRungs('//# sourceMappingURL=index.js.map'), '//# sourceMappingURL=index.js.map')
  // 旧实现是全文 replace(/(?:\.\.\/)+/gu)：代码字符串里的层级差异会被一起抹平。
  assert.notEqual(
    canonRungs("const a = '../../x'"),
    canonRungs("const a = '../../../x'"),
    '代码行里的 ../ 差异不得被抹平（旧全文替换的假绿）',
  )
})

test('summarizeResults：默认档 SKIP 不判红，--require-compare 下全 SKIP 必须红', () => {
  const allSkip = [{ status: 'skip' }, { status: 'skip' }]
  assert.deepEqual(summarizeResults(allSkip), { compared: 0, skipped: 2, stale: 0, strictFailure: false })
  assert.equal(summarizeResults(allSkip, { requireCompare: true }).strictFailure, true)
  const mixed = [{ status: 'ok' }, { status: 'skip' }, { status: 'stale' }]
  assert.deepEqual(summarizeResults(mixed, { requireCompare: true }),
    { compared: 2, skipped: 1, stale: 1, strictFailure: false })
})

test('main：--help 打印用法（exit 0），未知参数 exit 2 且不跑任何检查', () => {
  const help = spawnSync(process.execPath, [join(HERE, 'verify-artifact-freshness.mjs'), '--help'], { encoding: 'utf8' })
  assert.equal(help.status, 0, help.stdout + help.stderr)
  assert.match(help.stdout, /用法: node scripts\/gates\/verify-artifact-freshness\.mjs/)
  assert.match(help.stdout, /--require-compare/, '严格档必须写进用法（否则没人知道它存在）')
  const typo = spawnSync(process.execPath, [join(HERE, 'verify-artifact-freshness.mjs'), '--mobil-rebuild'], { encoding: 'utf8' })
  assert.equal(typo.status, 2, typo.stdout + typo.stderr)
  assert.match(typo.stderr, /未知参数 --mobil-rebuild/)
  assert.match(typo.stderr, /用法: node/)
  assert.equal(typo.stdout.trim(), '', '未知参数不得静默退化成普通检查（一个产物状态字符都不许打）')
})

