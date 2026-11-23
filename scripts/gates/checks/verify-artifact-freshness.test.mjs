/**
 * verify-artifact-freshness.test.mjs — 陈旧门**规范化函数**的负例测试。
 *
 * 只保留 gateway staged rebuild 仍使用的 canonRungs、门的 --self-test 与 G3
 * Electron 冻结归档档位的纯判据（hostPackageFreshnessArm）：mobile 适配包退役后，
 * 逐文件 canonComment 的调用方已删除，测试随实现一起退役。
 *
 * 跑法：node --test scripts/gates/checks/verify-artifact-freshness.test.mjs。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { canonRungs, hostPackageFreshnessArm, summarizeResults } from './verify-artifact-freshness.mjs'
import {
  ARTIFACT_FRESHNESS_REGISTRY,
  freshnessGuardIds,
  validateArtifactFreshnessRegistry,
} from './artifact-freshness-registry.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

test('--self-test 走门：门的负控必须真的能失败（挂进 test:scripts）', () => {
  const result = spawnSync(process.execPath, [join(HERE, './verify-artifact-freshness.mjs'), '--self-test'], { encoding: 'utf8' })
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
  const help = spawnSync(process.execPath, [join(HERE, './verify-artifact-freshness.mjs'), '--help'], { encoding: 'utf8' })
  assert.equal(help.status, 0, help.stdout + help.stderr)
  assert.match(help.stdout, /用法: node scripts\/gates\/checks\/verify-artifact-freshness\.mjs/)
  assert.match(help.stdout, /--require-compare/, '严格档必须写进用法（否则没人知道它存在）')
  assert.match(help.stdout, /--include-electron/, 'Electron 复活严格档必须写进用法（否则没人知道冻结归档怎么复核）')
  const typo = spawnSync(process.execPath, [join(HERE, './verify-artifact-freshness.mjs'), '--mobil-rebuild'], { encoding: 'utf8' })
  assert.equal(typo.status, 2, typo.stdout + typo.stderr)
  assert.match(typo.stderr, /未知参数 --mobil-rebuild/)
  assert.match(typo.stderr, /用法: node/)
  assert.equal(typo.stdout.trim(), '', '未知参数不得静默退化成普通检查（一个产物状态字符都不许打）')
})

test('G3 Electron-frozen host packages: default loud SKIP, --include-electron keeps the line-by-line compare', () => {
  // The four dist/host-*-package trees are the Electron packaging leg's copies
  // (design 25 §3.2: the Swift sidecar reads packages/dsh-chamber-seed-* instead).
  // Default must read as a frozen-archive SKIP that names the revival flag — not a
  // silent pass and not a gate-blocking red; the strict arm must keep comparing.
  const frozen = hostPackageFreshnessArm()
  assert.equal(frozen.compare, false, 'the default arm must not compare the frozen artifacts')
  assert.match(frozen.detail, /冻结归档/, 'the skip must be loud (named as a frozen archive)')
  assert.match(frozen.detail, /--include-electron/, 'the skip must name the revival/strict flag')
  assert.match(frozen.detail, /缺目录\/旧摘要/, 'the strict-arm semantics must stay stated')
  const strict = hostPackageFreshnessArm({ includeElectron: true })
  assert.equal(strict.compare, true, '--include-electron must restore the line-by-line compare')
  // G2 two-way lockstep: the frozen arm still emits the same id and stays a
  // freshness guard (not an exemption — exempting it would hollow the table).
  const hostEntry = ARTIFACT_FRESHNESS_REGISTRY.find(entry => entry.id === 'desktop/dist/host-*-package')
  assert.ok(hostEntry, 'the host-package artifact must stay registered')
  assert.equal(hostEntry.guard.kind, 'freshness', 'the frozen default is not an exemption; G2 lockstep keeps the id observed')
  assert.match(hostEntry.guard.detail, /--include-electron/, 'the registry must name the strict/revival arm')
  const source = readFileSync(new URL('./verify-artifact-freshness.mjs', import.meta.url), 'utf8')
  const bodyStart = source.indexOf('function checkHostPackageBuildManifests(')
  assert.ok(bodyStart > 0, 'the host-package arm must stay a named function')
  const armBody = source.slice(bodyStart, source.indexOf('\nfunction ', bodyStart + 1))
  assert.match(armBody, /if \(!arm\.compare\) \{\s*note\('desktop\/dist\/host-\*-package', 'skip', arm\.detail\)/,
    'the frozen arm must emit the registered id itself (removing it must not stay green on another arm)')
  assert.match(armBody, /note\('desktop\/dist\/host-\*-package', 'stale'/, 'the strict arm keeps the stale verdict')
  assert.match(source, /checkHostPackageBuildManifests\(\{ includeElectron \}\)/, 'main must pass the strict flag into the host-package arm')
})

test('G2/G8: the shipped artifact registry is valid — every artifact has a guard or a signed exemption', () => {
  assert.deepEqual(validateArtifactFreshnessRegistry(), [])
  assert.ok(ARTIFACT_FRESHNESS_REGISTRY.length > 0)
  for (const entry of ARTIFACT_FRESHNESS_REGISTRY) {
    if (entry.guard.kind === 'exemption') assert.ok(entry.guard.reason.trim().length > 0, entry.id + ' exemption must carry a reason')
    else assert.ok(entry.guard.detail.trim().length > 0, entry.id + ' guard must name where it lives')
  }
})

test('G8: an exemption without a reason is rejected (the table cannot be hollowed out silently)', () => {
  const problems = validateArtifactFreshnessRegistry([
    { id: 'x', artifact: 'a', generator: 'g', guard: { kind: 'exemption' } },
  ])
  assert.ok(problems.some(problem => /G8/.test(problem)), problems.join('; '))
})

test('G2: unknown guard kinds, duplicate ids and missing fields are rejected', () => {
  const unknown = validateArtifactFreshnessRegistry([
    { id: 'x', artifact: 'a', generator: 'g', guard: { kind: 'wishful', detail: 'd' } },
  ])
  assert.ok(unknown.some(problem => /unknown guard kind/.test(problem)))
  const duplicate = validateArtifactFreshnessRegistry([
    { id: 'x', artifact: 'a', generator: 'g', guard: { kind: 'freshness', detail: 'd' } },
    { id: 'x', artifact: 'b', generator: 'g', guard: { kind: 'freshness', detail: 'd' } },
  ])
  assert.ok(duplicate.some(problem => /duplicate id/.test(problem)))
  const missing = validateArtifactFreshnessRegistry([
    { id: 'y', artifact: '', generator: 'g', guard: { kind: 'freshness', detail: 'd' } },
  ])
  assert.ok(missing.some(problem => /missing artifact/.test(problem)))
})

test('G2 two-way lockstep: the freshness ids are exactly the ids the verifier emits', () => {
  // G3 加入后，dist/web 与 host-*-package 从 exemption 升为 freshness 类：
  // 清单比对由 verify-artifact-freshness 观测（缺一组即失步即红）。
  assert.deepEqual(freshnessGuardIds(), [
    'desktop/preload.cjs',
    'renderer/src/generated/typert',
    'gateway/dist/index.js',
    'desktop/dist/web',
    'desktop/dist/host-*-package',
  ])
  const source = readFileSync(new URL('./verify-artifact-freshness.mjs', import.meta.url), 'utf8')
  for (const id of freshnessGuardIds()) {
    assert.ok(source.includes("note('" + id + "'"), 'the verifier must emit the registered id ' + id)
  }
  assert.match(source, /artifactFreshnessSummary\(\)/, 'the gate must print the registry summary')
  assert.match(source, /freshnessGuardIds\(\)/, 'the gate must enforce the two-way lockstep itself')
})

