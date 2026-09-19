/**
 * registry.test.mjs — registry 单一来源的锁步测试：C1–C15 判据表不漂移、registry.json 过 schema 且 canonical、
 * 判据分区不重不漏、verifierForks 形状/顺序/计数为"故意改才动"的 golden（删一个 fork 或改一份分类都必须在这里可见）、
 * 校验器抓退化（未知判据 / 分区缺口 / accepted 缺理由 / upstream=null 语义）、生成块 extract/apply/check 往返。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CRITERIA_IDS } from './touchpoint-criteria.mjs'
import {
  REGISTRY_PATH, criteriaPartition, loadRegistry, renderRegistryText, validateRegistry, verifierForks,
} from './registry.mjs'
import { INDEX_BLOCK, applyBlocks, checkBlocks, renderBlocks } from './registry-views.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const VERIFIER = readFileSync(join(HERE, 'verify-upstream-touchpoints.mjs'), 'utf8')
const registry = loadRegistry()
const clone = () => JSON.parse(JSON.stringify(registry))

test('C1–C15 判据表恰好 15 个 id，且每个都出现在 verifier 源码里', () => {
  assert.equal(CRITERIA_IDS.length, 15)
  for (const id of CRITERIA_IDS) {
    // 词边界，不是子串：`includes('C1')` 会被 'C10'/'C15' 满足，删掉实现只剩文本也能绿。
    assert.match(VERIFIER, new RegExp('\\b' + id + '\\b', 'u'), '判据 ' + id + ' 在 verify-upstream-touchpoints.mjs 里没有独立出现（判据表与实现漂移）')
  }
})

test('新增不变量：shadow/chamber-named 二选一、判据下限、退役形态豁免', () => {
  const dropExclusion = clone()
  dropExclusion.excludedUpstreamDirs = dropExclusion.excludedUpstreamDirs.filter((dir) => dir !== 'packages/api/gateway')
  assert.ok(
    validateRegistry(dropExclusion).some((message) => message.includes('恰好属于一类')),
    '删掉 upstream 的 exclusion 而不改 vendor 清单，必须在 schema 层红（覆盖面不得静默消失）',
  )

  const retyped = clone()
  retyped.entries[3].type = 'fork'
  retyped.chamberNamedForks = []
  assert.ok(validateRegistry(retyped).some((message) => message.includes('恰好属于一类')), 'seed 改型 + 清空 chamberNamedForks 必须红')

  const emptied = clone()
  emptied.criteriaCodeOnly = [...new Set([...emptied.criteriaCodeOnly, ...emptied.entries[0].criteria])]
  emptied.entries[0].criteria = []
  assert.ok(validateRegistry(emptied).some((message) => message.includes('criteria 为空')), '判据可整体挪进 criteriaCodeOnly 时必须红')

  const retired = clone()
  Object.assign(retired.entries[0], { upstream: null, upstreamFormer: 'packages/client/connection', status: 'accepted', rationale: '退役演练' })
  assert.deepEqual(validateRegistry(retired), [], '退役形态（upstream=null + upstreamFormer）必须豁免二选一不变量')
})

test('registry 值锁：分类桶形状 + 符号锚字符串（防"同计数下桶间搬家 / 锚点改指他处"）', () => {
  const shape = registry.entries.map((entry) => [
    entry.id,
    Object.keys(entry.classify.patched).sort(),
    Object.keys(entry.classify.own).sort(),
    [...(entry.classify.ownPrefix ?? [])],
    [...(entry.classify.dropped ?? [])],
  ])
  // 值锁：api-gateway 桶按合并后的 registry 重算（载波重试纯函数 / 页面事实 / 仓内测试清单）；形状变化必须同批改本哈希。
  assert.equal(
    createHash('sha256').update(JSON.stringify(shape)).digest('hex').slice(0, 16),
    '19ca33757127ba06',
    '分类桶形状变了（桶间搬家或增删文件）——必须同批改本断言的哈希；当前形状：' + JSON.stringify(shape),
  )
  assert.deepEqual(
    registry.entries.flatMap((entry) => entry.symbols),
    [
      'src/api-path.ts#resolveInstanceBasePath',
      'src/boot.ts#AppWebEntry',
      'src/client/stream-client.ts#RemoteStreamMuxClient',
      'src/core.ts#OpenInAppError',
    ],
    '符号锚是逐条 golden：改指向必须同批改本断言',
  )
})

test('registry.json 过 schema 且是 canonical 形态', () => {
  assert.deepEqual(validateRegistry(registry), [])
  assert.equal(renderRegistryText(registry), readFileSync(REGISTRY_PATH, 'utf8'))
})

test('判据分区：entries.criteria ∪ criteriaCodeOnly == C1–C15，不重不漏', () => {
  const { used, codeOnly } = criteriaPartition(registry)
  assert.deepEqual([...new Set([...used, ...codeOnly])].sort(), [...CRITERIA_IDS].sort())
  assert.equal(used.filter((id) => codeOnly.includes(id)).length, 0)
})

test('verifierForks 与迁移前内嵌 FORKS 同形：顺序、路径、分类计数、版本锚', () => {
  const forks = verifierForks(registry)
  assert.deepEqual(forks.map((fork) => fork.name), ['connection', 'client-web', 'api-gateway', 'seed-open-in'])
  assert.deepEqual(forks.map((fork) => fork.rel), [
    'packages/dsh-client-connection',
    'packages/dsh-client-web',
    'packages/dsh-api-gateway',
    'packages/dsh-chamber-seed-open-in',
  ])
  assert.deepEqual(
    forks.map((fork) => [Object.keys(fork.patched).length, Object.keys(fork.own).length, fork.ownPrefix.length, fork.dropped.length]),
    [[7, 4, 4, 2], [9, 2, 1, 2], [6, 5, 1, 9], [4, 3, 1, 6]],
  )
  assert.equal(forks[3].versionAnchor, 'chamber')
  for (const fork of forks.slice(0, 3)) assert.equal(fork.versionAnchor, undefined)
})

test('校验器抓退化：未知判据 / 分区缺口 / accepted 缺理由 / upstream=null 语义 / id 重复', () => {
  const unknown = clone(); unknown.entries[0].criteria = ['C99']
  assert.ok(validateRegistry(unknown).some((item) => item.includes('C99')))

  const gap = clone(); gap.criteriaCodeOnly = gap.criteriaCodeOnly.filter((id) => id !== 'C15')
  assert.ok(validateRegistry(gap).some((item) => item.includes('未被任何条目或 criteriaCodeOnly 覆盖')))

  const noRationale = clone(); noRationale.entries[0].status = 'accepted'
  assert.ok(validateRegistry(noRationale).some((item) => item.includes('rationale')))

  const retired = clone(); retired.entries[0].upstream = null
  assert.ok(validateRegistry(retired).some((item) => item.includes('upstreamFormer')))

  const duplicate = clone(); duplicate.entries[1].id = duplicate.entries[0].id
  assert.ok(validateRegistry(duplicate).some((item) => item.includes('重复')))

  // review 补充：这些退化曾经能"改了也不红"——每一条都必须被 schema 抓住。
  const noSymbols = clone(); noSymbols.entries[0].symbols = []
  assert.ok(validateRegistry(noSymbols).some((item) => item.includes('symbols 为空')))

  const duplicateName = clone(); duplicateName.entries[3].name = duplicateName.entries[1].name
  assert.ok(validateRegistry(duplicateName).some((item) => item.includes('name 重复')))

  const missingPatched = clone(); delete missingPatched.entries[0].classify.patched
  assert.ok(validateRegistry(missingPatched).some((item) => item.includes('classify.patched')))

  const seedAnchor = clone(); seedAnchor.entries[3].versionAnchor = 'upstream'
  assert.ok(validateRegistry(seedAnchor).some((item) => item.includes('type=seed 必须 versionAnchor=chamber')))
})

test('符号锚下限：每个 fork/seed 至少一条，且总数被 pin（清空探针 = 测试红）', () => {
  const total = registry.entries.reduce((sum, entry) => sum + (entry.symbols ?? []).length, 0)
  assert.equal(total, 4, '符号锚总数是 golden：增删锚点必须同批改本断言（D15 机械化方向不可被清空）')
  for (const entry of registry.entries) {
    if (entry.type === 'fork' || entry.type === 'seed') assert.ok(entry.symbols.length >= 1, entry.id + ' 缺符号锚')
  }
})

test('生成块：声明与渲染面一一对应、往返、缺标记/未声明标记/改内容都能抓到', () => {
  const index = renderBlocks(registry).get(INDEX_BLOCK).split('\n')
  assert.equal(index.length, registry.entries.length + 2)

  const fixture = {
    schema: 1,
    entries: [{
      id: 'fork.x', type: 'fork', name: 'x', ours: 'pkg/x', upstream: 'packages/x',
      classify: { patched: { 'a.ts': '[patch-mod] 说明' }, own: {}, ownPrefix: [], dropped: [] },
      criteria: ['C1'], deviations: [], relatedGates: [], symbols: ['a.ts#f'], evidence: 'e', status: 'aligned',
    }],
    generatedBlocks: ['touchpoints.fork-mirror.x', INDEX_BLOCK],
  }
  const marker = (id, body) => '<!-- GENERATED:registry:' + id + ':begin -->\n' + body + '\n<!-- GENERATED:registry:' + id + ':end -->'
  const doc = 'head\n' + marker('touchpoints.fork-mirror.x', 'stale') + '\n' + marker(INDEX_BLOCK, 'stale') + '\ntail\n'

  assert.ok(checkBlocks(doc, fixture).length > 0, '内容陈旧必须红')
  const applied = applyBlocks(doc, fixture)
  assert.equal(applied.error, null)
  assert.deepEqual(checkBlocks(applied.text, fixture), [])

  const missing = 'head\n' + marker(INDEX_BLOCK, 'stale') + '\n'
  assert.ok(checkBlocks(missing, fixture).some((item) => item.includes('恰好一对')))

  // review F1：删声明 / 未声明标记不得让保鲜静默关闭。
  const emptied = { ...fixture, generatedBlocks: [] }
  assert.ok(checkBlocks(doc, emptied).some((item) => item.includes('渲染面存在未声明的块')))
  const bogus = doc + marker('touchpoints.bogus', 'x') + '\n'
  assert.ok(checkBlocks(bogus, fixture).some((item) => item.includes('未声明的 GENERATED 块标记')))
  assert.notEqual(applyBlocks(bogus, fixture).error, null, '--write 不得在存在未声明标记时静默成功')
  assert.notEqual(applyBlocks(doc, emptied).error, null, '--write 不得在未声明全部视图时静默成功')
})
