/**
 * verify-artifact-freshness.test.mjs — 陈旧门**规范化函数**的负例测试。
 *
 * 只保留 gateway staged rebuild 仍使用的 canonRungs 与门的 --self-test：
 * mobile 适配包退役后，逐文件 canonComment 的调用方已删除，测试随实现一起退役。
 *
 * 跑法：node --test scripts/gates/verify-artifact-freshness.test.mjs。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { canonRungs, summarizeResults } from './verify-artifact-freshness.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

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

