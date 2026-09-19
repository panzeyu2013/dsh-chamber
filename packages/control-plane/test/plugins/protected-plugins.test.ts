/**
 * protected-plugins.ts 单测（design 21 §6.11 / 决策 19 的 2026-12 修订）：
 * 受保护集合派生、op 分相的写面判定（含 **remove 永不判版本** 这条回归）、版本语法与
 * 代比较（预发布字符串全等）、读面行投影的并集语义（组合/种子行必须在行集里）、
 * 运行时线族解析（锁文件优先 / 树兜底 / 都没有则 fail-closed）。
 *
 * Run directly: node packages/control-plane/test/plugins/protected-plugins.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  decidePluginMutation,
  derivePluginRows,
  deriveProtectedSet,
  familyNamesFromLockfileClosure,
  familyNamesFromRuntimeTree,
  familyVersionsFromLockfileClosure,
  isExactVersion,
  isMaterializedValue,
  officialScope,
  parseExactVersion,
  PLUGIN_MATERIALIZED_VALUE_MASK,
  PROFILE_BUNDLES_SNAPSHOT,
  RUNTIME_FAMILY_CORE,
  protectedReason,
  readInstalledVersion,
  resolveRuntimeFamily,
  describeFamilyFindings,
  verifyProfileFamilyConsistency,
  sameGeneration,
  suggestExactSpec,
  type ProtectedFacts,
} from '../../src/protected-plugins.ts'
import { putProfilePackage } from '../support/utils.ts'

const SEEDS = ['@dsh-chamber/dsh-chamber-seed-client-graph', '@dsh-chamber/dsh-chamber-seed-git-worktree']
const FAMILY = ['@deepseek-ai/dsh', '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-session']

const facts = (over: Partial<ProtectedFacts> = {}): ProtectedFacts => ({
  seedNames: SEEDS,
  familyNames: FAMILY,
  ...over,
})

const okSet = (over: Partial<ProtectedFacts> = {}) => {
  const derived = deriveProtectedSet(facts(over))
  assert.equal(derived.ok, true)
  if (!derived.ok) throw new Error('unreachable')
  return derived.set
}

// ---------------------------------------------------------------------------
// 派生
// ---------------------------------------------------------------------------

test('deriveProtectedSet: B₀ ∪ S ∪ F，来源优先级 installation > chamber > family', () => {
  const set = okSet()
  for (const name of PROFILE_BUNDLES_SNAPSHOT) assert.equal(protectedReason(set, name), 'installation')
  assert.equal(protectedReason(set, SEEDS[0]), 'chamber')
  assert.equal(protectedReason(set, '@deepseek-ai/dsh-session'), 'family')
  assert.equal(protectedReason(set, 'third-party-thing'), null)
  // 同名多来源时取最先命中的（B₀ 优先）
  const overlapping = okSet({ seedNames: ['@deepseek-ai/dsh-base'] })
  assert.equal(protectedReason(overlapping, '@deepseek-ai/dsh-base'), 'installation')
})

test('deriveProtectedSet: F 为 null（ssh 形态）仍可派生 B₀ ∪ S', () => {
  const set = okSet({ familyNames: null })
  assert.equal(protectedReason(set, '@deepseek-ai/dsh-base'), 'installation')
  assert.equal(protectedReason(set, '@deepseek-ai/dsh-session'), null)
})

test('deriveProtectedSet: 空 F / 非字符串 / 空名一律派生失败（fail-closed）', () => {
  const empty = deriveProtectedSet(facts({ familyNames: [] }))
  assert.equal(empty.ok, false)
  const bad = deriveProtectedSet({ seedNames: ['@dsh-chamber/x'], familyNames: [42 as unknown as string] })
  assert.equal(bad.ok, false)
  const emptyName = deriveProtectedSet({ seedNames: [''], familyNames: null })
  assert.equal(emptyName.ok, false)
})

test('deriveProtectedSet: 派生出的 P 绝不可是空集（2026-09-13 round-2 review F3）', () => {
  // An all-empty fact set used to answer `ok:true` with ZERO names, and
  // `decidePluginMutation` then ALLOWED removing a composition member — while
  // this module promises protection never silently degrades to nothing. Hence a
  // fail-closed guard. No production path can reach it today (B₀ defaults to the
  // non-empty snapshot, S comes from the non-empty registry); a future caller
  // reading the installation bundles from a profile can.
  const derived = deriveProtectedSet({ installationBundles: [], seedNames: [], familyNames: null })
  assert.equal(derived.ok, false, 'an empty protected set must never be ok:true')
  // The non-empty neighbours keep working: default B₀ alone, S alone, F alone.
  assert.equal(deriveProtectedSet({ seedNames: [], familyNames: null }).ok, true)
  assert.equal(deriveProtectedSet({ installationBundles: [], seedNames: ['@dsh-chamber/x'], familyNames: null }).ok, true)
  assert.equal(deriveProtectedSet({ installationBundles: [], seedNames: [], familyNames: ['@deepseek-ai/dsh-base'] }).ok, true)
})

test('officialScope: 只认 @deepseek-ai/ 前缀', () => {
  assert.equal(officialScope('@deepseek-ai/dsh-base'), true)
  assert.equal(officialScope('@dsh-chamber/x'), false)
  assert.equal(officialScope('third-party'), false)
  assert.equal(officialScope('@deepseek-ai'), false)
})

// ---------------------------------------------------------------------------
// 版本语法与代比较
// ---------------------------------------------------------------------------

test('isExactVersion: 精确版本通过；range / dist-tag / 残缺版本拒绝', () => {
  for (const good of ['0.1.5', '0.1.5-rc.2', '1.2.3-alpha.1', '1.2.3+build.5', '1.2.3-rc.1+build']) {
    assert.equal(isExactVersion(good), true, good)
  }
  for (const bad of ['^0.1.5', '~0.1.5', 'latest', 'next', '0.1', '0.1.5.4', '>=1.2.3', '1.2.3 || 2.0.0', '', null, undefined]) {
    assert.equal(isExactVersion(bad as string), false, String(bad))
  }
})

test('parseExactVersion: 拆出 tuple 与预发布串', () => {
  assert.deepEqual(parseExactVersion('0.1.5-rc.2'),
    { major: '0', minor: '1', patch: '5', prerelease: 'rc.2' })
  assert.deepEqual(parseExactVersion('2.0.0'), { major: '2', minor: '0', patch: '0', prerelease: null })
})

test('sameGeneration: 预发布必须字符串全等（tuple 相等不算通过）', () => {
  assert.equal(sameGeneration('0.1.5-rc.2', '0.1.5-rc.2'), true)
  assert.equal(sameGeneration('0.1.5-rc.1', '0.1.5-rc.2'), false)
  assert.equal(sameGeneration('0.1.5-alpha.2', '0.1.5-rc.2'), false)
  assert.equal(sameGeneration('0.1.5-rc.2', '0.1.5'), false)
  assert.equal(sameGeneration('0.1.5', '0.1.5+build.1'), true, 'build 元数据不参与同代判定')
  assert.equal(sameGeneration('1.2.3', '1.2.3'), true)
  assert.equal(sameGeneration('1.2.3', '1.2.4'), false)
  assert.equal(sameGeneration('not-a-version', '1.2.3'), false)
})

test('suggestExactSpec: 只在实例版本精确可读时给建议', () => {
  assert.equal(suggestExactSpec('@deepseek-ai/pkg', '0.1.5-rc.2'), '@deepseek-ai/pkg@0.1.5-rc.2')
  assert.equal(suggestExactSpec('@deepseek-ai/pkg', null), null)
  assert.equal(suggestExactSpec('@deepseek-ai/pkg', 'latest'), null)
})

// ---------------------------------------------------------------------------
// decidePluginMutation
// ---------------------------------------------------------------------------

const decide = (over: Partial<Parameters<typeof decidePluginMutation>[0]> = {}) => decidePluginMutation({
  op: 'install',
  name: 'third-party-pkg',
  derivation: { ok: true, set: okSet() },
  runtimeVersion: '0.1.5-rc.2',
  ...over,
})

test('R1：受保护名 install/remove 同拒（composition / seed / family）', () => {
  for (const name of ['@deepseek-ai/dsh-base', SEEDS[1], '@deepseek-ai/dsh-session']) {
    const install = decide({ name })
    assert.equal(install.kind, 'refuse')
    assert.equal(install.kind === 'refuse' ? install.code : null, 'protected')
    const remove = decide({ op: 'remove', name, version: null })
    assert.equal(remove.kind, 'refuse')
    assert.equal(remove.kind === 'refuse' ? remove.code : null, 'protected')
  }
})

test('R2 回归：remove 永不判版本（官方 scope 的非受保护名可以卸）', () => {
  const remove = decide({ op: 'remove', name: '@deepseek-ai/dsh-experimental-agent-team-profile', version: null })
  assert.equal(remove.kind, 'allow', JSON.stringify(remove))
})

test('R2：官方 scope 无版本 / range / dist-tag 拒，且回填建议 spec', () => {
  const noVersion = decide({ name: '@deepseek-ai/dsh-experimental-agent-team-profile' })
  assert.equal(noVersion.kind === 'refuse' ? noVersion.code : null, 'needs-version')
  assert.equal(noVersion.kind === 'refuse' ? noVersion.suggest : null,
    '@deepseek-ai/dsh-experimental-agent-team-profile@0.1.5-rc.2')

  for (const version of ['^0.1.5-rc.2', '~0.1.5-rc.2', 'latest', 'next']) {
    const decision = decide({ name: '@deepseek-ai/dsh-experimental-agent-team-profile', version })
    assert.equal(decision.kind === 'refuse' ? decision.code : null, 'needs-exact-version', version)
  }
})

test('R2：跨代拒（rc.1 vs rc.2 / alpha vs rc / 稳定跨代），同代放行', () => {
  const name = '@deepseek-ai/dsh-experimental-agent-team-profile'
  for (const version of ['0.1.5-rc.1', '0.1.5-alpha.2', '0.1.4']) {
    const decision = decide({ name, version })
    assert.equal(decision.kind === 'refuse' ? decision.code : null, 'generation-mismatch', version)
  }
  assert.equal(decide({ name, version: '0.1.5-rc.2' }).kind, 'allow')
  // 第三方不受代规则约束
  assert.equal(decide({ name: 'third-party-pkg', version: '9.9.9' }).kind, 'allow')
})

test('R2：实例版本不可读 ⇒ 官方 install 也拒（fail-closed）', () => {
  const decision = decide({ name: '@deepseek-ai/dsh-experimental-agent-team-profile', version: '0.1.5-rc.2', runtimeVersion: null })
  assert.equal(decision.kind === 'refuse' ? decision.code : null, 'runtime-version-unknown')
})

test('R0：profile 未初始化 ⇒ defer（不是拒绝——首装正是 profile 的创建者）', () => {
  const decision = decide({ name: '@deepseek-ai/dsh-experimental-agent-team-profile', version: '0.1.5-rc.2', profileState: 'absent' })
  assert.equal(decision.kind, 'defer')
  assert.equal(decision.kind === 'defer' ? decision.code : null, 'profile_absent')
})

test('fail-closed：派生失败 ⇒ 写面拒绝（读面不受影响）', () => {
  const decision = decide({ name: 'third-party-pkg', derivation: null })
  assert.equal(decision.kind === 'refuse' ? decision.code : null, 'protected-set-unavailable')

  const failed = decide({ name: 'third-party-pkg', derivation: { ok: false, reason: 'runtime family unavailable' } })
  assert.equal(failed.kind, 'refuse')
  assert.match(failed.kind === 'refuse' ? failed.error : '', /runtime family unavailable/)
})

test('降级形态（familySource "unavailable"）：官方 install 拒且码区分降级；第三方与卸面照常', () => {
  // F 本该有但读不到（运行时树缺失/锁文件不可解析）：保护效果等同 ssh 保守形态，唯一差别
  // 是拒绝码——`protected-set-unavailable` 说明"事实缺失导致的降级"，不是"这个层被组合保护"。
  const bootSet = okSet({ familyNames: null })
  const derivation = { ok: true as const, set: bootSet }
  const official = decide({
    name: '@deepseek-ai/dsh-experimental-x', version: '0.1.5-rc.2', derivation, familySource: 'unavailable',
  })
  assert.equal(official.kind === 'refuse' ? official.code : null, 'protected-set-unavailable')
  // 第三方不受影响（只收紧官方 scope，不冻结整条写面）
  assert.equal(decide({ name: 'third-party-pkg', version: '1.0.0', derivation, familySource: 'unavailable' }).kind, 'allow')
  // 卸面照常按 B₀∪S 判：一个族外官方名仍可卸
  assert.equal(decide({
    op: 'remove', name: '@deepseek-ai/dsh-experimental-x', derivation, familySource: 'unavailable',
  }).kind, 'allow')
  // 受保护名照样拒（且是 `protected`，不是降级码）
  const seed = decide({
    name: '@dsh-chamber/dsh-chamber-seed-client-graph', version: '1.0.0', derivation, familySource: 'unavailable',
  })
  assert.equal(seed.kind === 'refuse' ? seed.code : null, 'protected')
})

test('ssh 保守形态：官方 scope install 一律拒；卸面按 B₀∪S；第三方装面照常', () => {
  const sshSet = okSet({ familyNames: null })
  const derivation = { ok: true as const, set: sshSet }
  const installOfficial = decide({ name: '@deepseek-ai/dsh-experimental-x', version: '0.1.5-rc.2', derivation, familySource: 'none' })
  assert.equal(installOfficial.kind === 'refuse' ? installOfficial.code : null, 'protected')

  const installThirdParty = decide({ name: 'third-party-pkg', derivation, familySource: 'none' })
  assert.equal(installThirdParty.kind, 'allow')

  const removeProtected = decide({ op: 'remove', name: '@deepseek-ai/dsh-base', derivation, familySource: 'none' })
  assert.equal(removeProtected.kind === 'refuse' ? removeProtected.code : null, 'protected')

  const removeOfficial = decide({ op: 'remove', name: '@deepseek-ai/dsh-experimental-x', derivation, familySource: 'none' })
  assert.equal(removeOfficial.kind, 'allow')
})

// ---------------------------------------------------------------------------
// 读面行投影
// ---------------------------------------------------------------------------

test('derivePluginRows: 行集 = 依赖表；B₀/S 只分类，不再凭空造行（2026-09 修订）', () => {
  const set = okSet()
  // 依赖表为空 ⇒ 行集为空：安装自带组合（B₀）与 chamber 播种物（S）都不出现
  // （chamber 组件有自己的表；官方组合是运行时基线）。
  const empty = derivePluginRows({
    dependencies: {},
    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
    protectedSet: set,
    seedNames: SEEDS,
  })
  assert.deepEqual(empty, [])
  // 同一个名字**确实**出现在依赖表里时，role/owner/protected 照旧由分类器给出。
  const declared = derivePluginRows({
    dependencies: {
      '@deepseek-ai/dsh-base': '0.1.5-rc.2',
      [SEEDS[0]]: '0.3.1',
    },
    bundles: ['@deepseek-ai/dsh-base'],
    protectedSet: set,
    seedNames: SEEDS,
  })
  const byName = new Map(declared.map(row => [row.name, row]))
  assert.deepEqual([...byName.keys()].sort(), ['@deepseek-ai/dsh-base', SEEDS[0]].sort())
  assert.equal(byName.get('@deepseek-ai/dsh-base')?.role, 'composition')
  assert.equal(byName.get('@deepseek-ai/dsh-base')?.owner, 'installation')
  assert.equal(byName.get('@deepseek-ai/dsh-base')?.protected, true)
  assert.equal(byName.get(SEEDS[0])?.role, 'seed')
  assert.equal(byName.get(SEEDS[0])?.owner, 'chamber')
  assert.equal(byName.get(SEEDS[0])?.protected, true)
  assert.equal(byName.get(SEEDS[0])?.spec, '0.3.1')
})

test('derivePluginRows: 用户后加的层 = live bundles 里不在 B₀ 的名 ⇒ role=layer 且不被保护', () => {
  const layer = '@deepseek-ai/dsh-experimental-agent-team-profile'
  const set = okSet()
  const rows = derivePluginRows({
    dependencies: { [layer]: '0.1.5-rc.2' },
    bundles: [...PROFILE_BUNDLES_SNAPSHOT, layer],
    protectedSet: set,
    seedNames: SEEDS,
    installedVersion: name => (name === layer ? '0.1.5-rc.2' : null),
  })
  const row = rows.find(candidate => candidate.name === layer)
  assert.equal(row?.role, 'layer')
  assert.equal(row?.protected, false)
  assert.equal(row?.spec, '0.1.5-rc.2')
  assert.equal(row?.version, '0.1.5-rc.2')
})

test('derivePluginRows: 第三方 / materialize 值分类 + 派生失败时 protected 一律 false', () => {
  const rows = derivePluginRows({
    dependencies: {
      'third-party-pkg': '^1.0.0',
      'folder-imported': 'file:.dsh-chamber/plugins/x.tgz',
      'linked': 'link:../x',
    },
    bundles: [],
    protectedSet: null,
  })
  const byName = new Map(rows.map(row => [row.name, row]))
  assert.equal(byName.get('third-party-pkg')?.role, 'third-party')
  assert.equal(byName.get('folder-imported')?.role, 'materialized')
  assert.equal(byName.get('linked')?.role, 'materialized')
  for (const row of rows) assert.equal(row.protected, false)
})

test('isMaterializedValue: file:/link:/路径类为 materialize，registry 范围为否', () => {
  for (const value of ['file:x.tgz', 'link:../x', './x', '../x', '/abs/x', '~/x', 'C:\\x', '\\\\host\\share']) {
    assert.equal(isMaterializedValue(value), true, value)
  }
  for (const value of ['^1.0.0', '1.0.0', 'workspace:*', '']) {
    assert.equal(isMaterializedValue(value), false, value)
  }
})

// ---------------------------------------------------------------------------
// 事实源（fs 探针）
// ---------------------------------------------------------------------------

test('familyNamesFromLockfileClosure: 只吃 packages 段的 2 空格键，兼容 v9/v6', () => {
  const lock = [
    'lockfileVersion: \'9.0\'',
    'importers:',
    '  .:',
    '    dependencies:',
    "      '@deepseek-ai/dsh':",
    '        specifier: 1.2.3',
    'packages:',
    "  '@deepseek-ai/dsh@1.2.3':",
    "  '@deepseek-ai/dsh-base@1.2.3':",
    '  /@deepseek-ai/legacy/1.0.0:',
    '  zod@4.0.0:',
  ].join('\n')
  assert.deepEqual(familyNamesFromLockfileClosure(lock), [
    '@deepseek-ai/dsh', '@deepseek-ai/dsh-base', '@deepseek-ai/legacy',
  ])
})

test('resolveRuntimeFamily: 可信闭包优先；无锁文件退回树枚举；都不可信则失败', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-family-'))
  // 可信闭包 = 核心锚齐全 + 无禁名（与 C11 同一判据）。
  const core = ["  '@deepseek-ai/dsh@0.1.5-rc.2':", "  '@deepseek-ai/dsh-base@0.1.5-rc.2':", "  '@deepseek-ai/dsh-web-app@0.1.5-rc.2':"]
  try {
    // 1) 只有树（核心锚齐全）
    for (const name of ['dsh', 'dsh-base', 'dsh-web-app']) {
      mkdirSync(join(root, 'node_modules', '@deepseek-ai', name), { recursive: true })
    }
    const treeOnly = resolveRuntimeFamily(root)
    assert.equal(treeOnly.ok, true)
    assert.equal(treeOnly.ok ? treeOnly.source : null, 'runtime-tree')
    assert.deepEqual(treeOnly.ok ? treeOnly.names : [],
      ['@deepseek-ai/dsh', '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
    assert.deepEqual(familyNamesFromRuntimeTree(root),
      ['@deepseek-ai/dsh', '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])

    // 2) 锁文件存在即权威——**哪怕只解析出少量名字**（没有"名字太少就换来源"的启发式）
    writeFileSync(join(root, 'pnpm-lock.yaml'), ['lockfileVersion: \'9.0\'', 'packages:', ...core].join('\n'))
    const withLock = resolveRuntimeFamily(root)
    assert.equal(withLock.ok, true)
    assert.equal(withLock.ok ? withLock.source : null, 'lockfile-closure')
    assert.equal(withLock.ok ? withLock.names.length : 0, 3)
    // ...and a SMALL lockfile still outranks the (populated) tree: the closure is
    // the authoritative, platform-independent source.
    assert.deepEqual(withLock.ok ? withLock.names : [], [...RUNTIME_FAMILY_CORE].sort())

    // 2b) 不可信的闭包**不是** F：源码线形态（含 opt-in 段）与裁剪过的锁文件都被拒。
    //     用一个没有树的干净目录，隔离"锁文件被拒 → 退回树枚举"的兜底（那是有意行为）。
    const lockOnly = mkdtempSync(join(tmpdir(), 'dsh-family-lockonly-'))
    try {
      writeFileSync(join(lockOnly, 'pnpm-lock.yaml'), ['lockfileVersion: \'9.0\'', 'packages:',
        ...core, "  '@deepseek-ai/dsh-experimental-agent-team-profile@0.1.5-rc.2':"].join('\n'))
      const sourceLine = resolveRuntimeFamily(lockOnly)
      assert.equal(sourceLine.ok, false, 'a closure carrying the opt-in segment must be rejected')
      assert.match(sourceLine.ok ? '' : sourceLine.reason, /opt-in layer belongs to the source line/)
      writeFileSync(join(lockOnly, 'pnpm-lock.yaml'), ['lockfileVersion: \'9.0\'', 'packages:',
        "  '@deepseek-ai/dsh@0.1.5-rc.2':"].join('\n'))
      const partial = resolveRuntimeFamily(lockOnly)
      assert.equal(partial.ok, false, 'a closure missing the core anchors must be rejected')
      assert.match(partial.ok ? '' : partial.reason, /missing the core anchor/)
    } finally {
      rmSync(lockOnly, { recursive: true, force: true })
    }


    // 3) 都没有 ⇒ fail-closed
    const empty = mkdtempSync(join(tmpdir(), 'dsh-family-empty-'))
    try {
      const failed = resolveRuntimeFamily(empty)
      assert.equal(failed.ok, false)
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('decide 判序：B₀ ∪ S 判名先于降级阶梯（组合成员在降级态仍答 protected）', () => {
  const boot = PROFILE_BUNDLES_SNAPSHOT[0]!
  const seeds = ['@dsh-chamber/dsh-chamber-seed-client-graph']
  const bootOnly = deriveProtectedSet({ seedNames: seeds, familyNames: null })
  assert.equal(bootOnly.ok, true)
  const set = bootOnly.ok ? bootOnly.set : null
  assert.ok(set !== null)
  const base = { profileState: 'ready' as const, derivation: { ok: true as const, set: set! }, familySource: 'unavailable' as const }
  // 组合成员（∈ B₀）在降级态：答 protected，而不是 protected-set-unavailable。
  const member = decidePluginMutation({ op: 'install', name: boot, version: '0.1.5-rc.2', runtimeVersion: null, ...base })
  assert.equal(member.kind === 'refuse' ? member.code : null, 'protected')
  // 官方非 P 名字才落到阶梯。
  const other = decidePluginMutation({ op: 'install', name: '@deepseek-ai/dsh-cli-extra', version: '0.1.5-rc.2', runtimeVersion: null, ...base })
  assert.equal(other.kind === 'refuse' ? other.code : null, 'protected-set-unavailable')
  // 第三方不受影响。
  const third = decidePluginMutation({ op: 'install', name: 'plain-pkg', version: '1.0.0', runtimeVersion: null, ...base })
  assert.equal(third.kind, 'allow')
  // ssh（familySource 'none'）对官方非 P 名字给 protected（保守装面码）。
  const ssh = decidePluginMutation({
    op: 'install', name: '@deepseek-ai/dsh-cli-extra', version: '0.1.5-rc.2', runtimeVersion: null,
    profileState: 'ready', derivation: { ok: true, set: set! }, familySource: 'none',
  })
  assert.equal(ssh.kind === 'refuse' ? ssh.code : null, 'protected')
})

test('isMaterializedValue: 路径形态才算 materialize，semver 范围/标签绝不算', () => {
  // 路径形态（含 `~` 的 home 形态 —— 但**不是** `~1.2.0` 这种波浪号范围）
  for (const value of ['file:../p', 'FILE:/abs/p', 'link:./p', './p', '../p', '.', '/abs/p', '~/p', '~\\p', '~',
    'C:\\p', '\\\\server\\share', 'c:/p']) {
    assert.equal(isMaterializedValue(value), true, value)
  }
  // registry 值：范围、标签、别名、git/url —— 一个都不能被当成 materialize
  for (const value of ['~1.2.0', '~1.2', '^1.2.3', '>=1.0.0 <2', '1.x', '*', 'latest', 'next', 'beta',
    'workspace:*', 'npm:alias@1.0.0', 'git+https://x/y.git', 'https://x/y.tgz', '1.2.3']) {
    assert.equal(isMaterializedValue(value), false, value)
  }
})

test('derivePluginRows: materialize 值在行投影里也被掩码（远端本地路径不得进渲染端）', () => {
  const rows = derivePluginRows({
    dependencies: { 'plain-pkg': '^1.0.0', 'local-pkg': 'file:/Users/someone/secret/path.tgz', 'rel-pkg': '../sibling' },
    bundles: [],
    protectedSet: null,
    seedNames: [],
    maskSpec: undefined,
  })
  const byName = new Map(rows.map(row => [row.name, row]))
  // DEFAULT = identity: the row must carry exactly what the caller's own
  // `dependencies` projection carries (the local profile's raw manifest is
  // returned raw — masking only the rows would desync the two).
  assert.equal(byName.get('plain-pkg')?.spec, '^1.0.0')
  assert.equal(byName.get('local-pkg')?.spec, 'file:/Users/someone/secret/path.tgz')
  // The role is classified from the value, so a masked spec must still classify
  // as materialize (the mask keeps the `file:` prefix for exactly this reason).
  assert.equal(byName.get('local-pkg')?.role, 'materialized')
  assert.equal(byName.get('rel-pkg')?.role, 'materialized')
  // A masking backend (gateway / ssh) passes its own hook and gets the mask.
  const masked = derivePluginRows({
    dependencies: { 'local-pkg': 'file:/x/y.tgz' },
    bundles: [],
    protectedSet: null,
    maskSpec: spec => (isMaterializedValue(spec) ? PLUGIN_MATERIALIZED_VALUE_MASK : spec),
  })
  assert.equal(masked.find(row => row.name === 'local-pkg')?.spec, PLUGIN_MATERIALIZED_VALUE_MASK)
  assert.equal(masked.find(row => row.name === 'local-pkg')?.role, 'materialized',
    'the masked value still classifies as materialize')
})

test('derivePluginRows: owner 是全枚举（installation / chamber / user），role 与 protected 不变', () => {
  const dependencies = {
    'third-party-pkg': '^1.0.0',
    'layer-pkg': '^2.0.0',
    [SEEDS[0]]: '0.3.1',
    '@deepseek-ai/dsh-base': '0.1.5-rc.2',
  }
  const rows = derivePluginRows({
    // 组合/播种名同样要在依赖表里才成行（2026-09 行集修订）——分类器对它们照常生效。
    dependencies,
    bundles: ['layer-pkg'],
    protectedSet: okSet(),
    seedNames: SEEDS,
  })
  const owner = (name: string): string | undefined => rows.find(row => row.name === name)?.owner
  assert.equal(owner('third-party-pkg'), 'user')
  assert.equal(owner('layer-pkg'), 'user')
  assert.equal(owner(SEEDS[0]), 'chamber')
  assert.equal(owner('@deepseek-ai/dsh-base'), 'installation')
  assert.equal(rows.find(row => row.name === 'third-party-pkg')?.role, 'third-party')
  assert.equal(rows.find(row => row.name === 'layer-pkg')?.role, 'layer')
  assert.equal(rows.every(row => row.owner !== undefined), true, 'no row may lack an owner')
  // 锁步（S5）：行键集恒等于依赖键集。渲染端的 `actionableDependencies` 依赖
  // "rows 覆盖 dependencies" 这一隐含前提（缺行即静默跳过 ⇒ 少动作）；producer
  // 若哪天收窄成子集，这条会先红。
  assert.deepEqual(rows.map(row => row.name).sort(), Object.keys(dependencies).sort())
})

test('decidePluginMutation: 空/非法名字是输入错误（invalid-name），不是事实缺失', () => {
  const empty = decide({ name: '', derivation: { ok: true, set: okSet({}) } })
  assert.equal(empty.kind === 'refuse' ? empty.code : null, 'invalid-name')
  const missing = decide({ name: undefined as unknown as string, derivation: { ok: true, set: okSet({}) } })
  assert.equal(missing.kind === 'refuse' ? missing.code : null, 'invalid-name')
})

test('verifyProfileFamilyConsistency: 传递副本必须 ∈ F 且同代；直接依赖（层本身）豁免', () => {
  const profileDir = mkdtempSync(join(tmpdir(), 'dsh-verify-'))
  try {
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      dependencies: { '@deepseek-ai/dsh-experimental-agent-team-profile': '0.1.5-rc.2' },
    }))
    // The explicitly requested layer is official-scope but NOT in F — exempt.
    putProfilePackage(profileDir, '@deepseek-ai/dsh-experimental-agent-team-profile', { version: '0.1.5-rc.2' })
    // A hoisted transitive family copy at the right generation: fine.
    putProfilePackage(profileDir, '@deepseek-ai/dsh-brand', { version: '0.1.5-rc.2' })
    const clean = verifyProfileFamilyConsistency({
      profileDir,
      familyNames: ['@deepseek-ai/dsh-brand', ...PROFILE_BUNDLES_SNAPSHOT],
      runtimeVersion: '0.1.5-rc.2',
    })
    assert.deepEqual(clean, { ok: true, checked: 1 })

    // A cross-generation copy is a finding...
    putProfilePackage(profileDir, '@deepseek-ai/dsh-session', { version: '0.1.4' })
    const drifted = verifyProfileFamilyConsistency({
      profileDir,
      familyNames: ['@deepseek-ai/dsh-brand', '@deepseek-ai/dsh-session', ...PROFILE_BUNDLES_SNAPSHOT],
      runtimeVersion: '0.1.5-rc.2',
    })
    assert.equal(drifted.ok, false)
    if (!drifted.ok) {
      assert.deepEqual(drifted.findings, [{ name: '@deepseek-ai/dsh-session', version: '0.1.4', kind: 'generation-mismatch' }])
      assert.match(describeFamilyFindings(drifted.findings, '0.1.5-rc.2'), /does not match the instance runtime generation/)
    }

    // ...and a family-name copy the pinned release does not provide is one too.
    putProfilePackage(profileDir, '@deepseek-ai/dsh-not-in-release', { version: '1.0.0' })
    const outside = verifyProfileFamilyConsistency({ profileDir, familyNames: ['@deepseek-ai/dsh-brand'], runtimeVersion: '0.1.5-rc.2' })
    assert.equal(outside.ok, false)
    if (!outside.ok) {
      // dsh-session is not in this call's family list either, so both stray
      // copies classify as outside-family (the generation arm needs membership).
      assert.deepEqual(outside.findings.map(finding => finding.kind).sort(), ['outside-family', 'outside-family'])
      assert.deepEqual(outside.findings.map(finding => finding.name).sort(),
        ['@deepseek-ai/dsh-not-in-release', '@deepseek-ai/dsh-session'])
    }
  } finally {
    rmSync(profileDir, { recursive: true, force: true })
  }
})

test('familyVersionsFromLockfileClosure: v9/v6 键形、peer 后缀与多版本（名字集合仍由 familyNamesFromLockfileClosure 单独权威）', () => {
  const text = [
    "lockfileVersion: '9.0'",
    'packages:',
    "  '@deepseek-ai/dsh@0.1.5-rc.2':",
    "  '@deepseek-ai/cosmokit@1.8.3':",
    "  '@deepseek-ai/schemastery@3.18.2':",
    "  '@deepseek-ai/schemastery@3.17.0(peer@1.0.0)':",
    'snapshots:',
    "  '@deepseek-ai/cosmokit@1.8.3':",
    '  /@deepseek-ai/legacy/2.0.0:',
  ].join('\n')
  const versions = familyVersionsFromLockfileClosure(text)
  assert.deepEqual(versions.get('@deepseek-ai/dsh'), ['0.1.5-rc.2'])
  assert.deepEqual(versions.get('@deepseek-ai/cosmokit'), ['1.8.3'])
  // Peer suffixes are truncated at `(` (the real runtime lockfile carries 234
  // such keys, with nested parens), and both pinned versions of one name are
  // retained (sorted) — the profile copy must match one of them, not an
  // arbitrary single value.
  assert.deepEqual(versions.get('@deepseek-ai/schemastery'), ['3.17.0', '3.18.2'])
  assert.deepEqual(versions.get('@deepseek-ai/legacy'), ['2.0.0'])
  // The names authority is untouched: same input, same name set, twice.
  assert.deepEqual(familyNamesFromLockfileClosure(text), familyNamesFromLockfileClosure(text))
})

test('verifyProfileFamilyConsistency: 真实安装树形状 —— opt-in 层的传递实现包由闭包豁免，改域 vendored 包按运行时提供的版本放行', () => {
  const profileDir = mkdtempSync(join(tmpdir(), 'dsh-verify-team-'))
  try {
    // 实测形状（~/Library/Application Support/@dsh-chamber/desktop/state/dsh-home/profiles/web）：
    // 两个 bundle 是直接依赖，其余 6 个条目由 pnpm 提升上来。
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      dependencies: {
        '@deepseek-ai/dsh-experimental-agent-team-profile': '0.1.5-rc.2',
        '@deepseek-ai/dsh-experimental-agent-team-web-profile': '0.1.5-rc.2',
      },
    }))
    putProfilePackage(profileDir, '@deepseek-ai/dsh-experimental-agent-team-profile', {
      version: '0.1.5-rc.2',
      dependencies: {
        '@deepseek-ai/dsh-experimental-agent-team': '0.1.5-rc.2',
        '@deepseek-ai/dsh-experimental-tool-agent-team': '0.1.5-rc.2',
      },
    })
    putProfilePackage(profileDir, '@deepseek-ai/dsh-experimental-agent-team-web-profile', {
      version: '0.1.5-rc.2',
      dependencies: { '@deepseek-ai/dsh-experimental-client-ui-agent-team': '0.1.5-rc.2' },
    })
    putProfilePackage(profileDir, '@deepseek-ai/dsh-experimental-agent-team', {
      version: '0.1.5-rc.2',
      dependencies: { '@deepseek-ai/dsh-brand': '0.1.5-rc.2', '@deepseek-ai/schemastery': '^3.18.2' },
    })
    putProfilePackage(profileDir, '@deepseek-ai/dsh-experimental-tool-agent-team', { version: '0.1.5-rc.2' })
    putProfilePackage(profileDir, '@deepseek-ai/dsh-experimental-client-ui-agent-team', { version: '0.1.5-rc.2' })
    putProfilePackage(profileDir, '@deepseek-ai/dsh-brand', { version: '0.1.5-rc.2' })
    putProfilePackage(profileDir, '@deepseek-ai/schemastery', { version: '3.18.2', dependencies: { '@deepseek-ai/cosmokit': '^1.8.3' } })
    putProfilePackage(profileDir, '@deepseek-ai/cosmokit', { version: '1.8.3' })

    const verdict = verifyProfileFamilyConsistency({
      profileDir,
      familyNames: [
        '@deepseek-ai/dsh-brand', '@deepseek-ai/schemastery', '@deepseek-ai/cosmokit',
        ...PROFILE_BUNDLES_SNAPSHOT,
      ],
      runtimeVersion: '0.1.5-rc.2',
      // Rescoped vendored packages keep upstream versions ⇒ the generation
      // string is the wrong scale; the runtime-provided version is the right one.
      familyVersions: new Map([
        ['@deepseek-ai/dsh-brand', ['0.1.5-rc.2']],
        ['@deepseek-ai/schemastery', ['3.18.2']],
        ['@deepseek-ai/cosmokit', ['1.8.3']],
      ]),
    })
    // 8 entries − 2 direct dependencies = 6 checked; nothing is a finding.
    assert.deepEqual(verdict, { ok: true, checked: 6 })
  } finally {
    rmSync(profileDir, { recursive: true, force: true })
  }
})

test('verifyProfileFamilyConsistency: 闭包豁免不得掩盖版本歪斜（先版本、后闭包）', () => {
  const profileDir = mkdtempSync(join(tmpdir(), 'dsh-verify-skew-'))
  try {
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      dependencies: { 'third-party-layer': '1.0.0' },
    }))
    putProfilePackage(profileDir, 'third-party-layer', { version: '1.0.0', dependencies: { '@deepseek-ai/schemastery': '^3.17.0' } })
    // Reachable from the user's own layer (so the closure would exempt it) AND
    // runtime-provided at another version ⇒ version skew still reports.
    putProfilePackage(profileDir, '@deepseek-ai/schemastery', { version: '3.17.0' })
    const skewed = verifyProfileFamilyConsistency({
      profileDir,
      familyNames: ['@deepseek-ai/schemastery'],
      runtimeVersion: '0.1.5-rc.2',
      familyVersions: new Map([['@deepseek-ai/schemastery', ['3.18.2']]]),
    })
    assert.equal(skewed.ok, false)
    if (!skewed.ok) {
      assert.deepEqual(skewed.findings, [
        { name: '@deepseek-ai/schemastery', version: '3.17.0', kind: 'generation-mismatch' },
      ])
      assert.match(
        describeFamilyFindings(skewed.findings, '0.1.5-rc.2', new Map([['@deepseek-ai/schemastery', ['3.18.2']]])),
        /is not the version this instance runtime provides \(expected 3\.18\.2\)/,
      )
    }
  } finally {
    rmSync(profileDir, { recursive: true, force: true })
  }
})

test('verifyProfileFamilyConsistency: 无版本事实时回退世代比较（闭包豁免仍独立生效）', () => {
  const profileDir = mkdtempSync(join(tmpdir(), 'dsh-verify-fallback-'))
  try {
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      dependencies: { '@deepseek-ai/dsh-experimental-agent-team-profile': '0.1.5-rc.2' },
    }))
    putProfilePackage(profileDir, '@deepseek-ai/dsh-experimental-agent-team-profile', {
      version: '0.1.5-rc.2',
      dependencies: { '@deepseek-ai/dsh-experimental-agent-team': '0.1.5-rc.2' },
    })
    putProfilePackage(profileDir, '@deepseek-ai/dsh-experimental-agent-team', { version: '0.1.5-rc.2' })
    // A family member WITHOUT a version fact falls back to the generation arm
    // (the pre-2026-12 behaviour), so the vendored package is still flagged —
    // the fix is the fact, not a blanket exemption.
    putProfilePackage(profileDir, '@deepseek-ai/cosmokit', { version: '1.8.3' })
    const verdict = verifyProfileFamilyConsistency({
      profileDir,
      familyNames: ['@deepseek-ai/cosmokit', ...PROFILE_BUNDLES_SNAPSHOT],
      runtimeVersion: '0.1.5-rc.2',
    })
    assert.equal(verdict.ok, false)
    if (!verdict.ok) {
      assert.deepEqual(verdict.findings, [
        { name: '@deepseek-ai/cosmokit', version: '1.8.3', kind: 'generation-mismatch' },
      ])
      assert.match(describeFamilyFindings(verdict.findings, '0.1.5-rc.2'), /does not match the instance runtime generation/)
    }
    // The closure-owned experimental package stays exempt in the same run.
    assert.equal(verdict.ok === false && verdict.findings.some(finding => finding.name.includes('experimental')), false)
  } finally {
    rmSync(profileDir, { recursive: true, force: true })
  }
})

test('verifyProfileFamilyConsistency: 部分族名字一次臂都没跑成时如实报 skipped（绝不聚合成无声通过）', () => {
  const profileDir = mkdtempSync(join(tmpdir(), 'dsh-verify-partial-'))
  try {
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      dependencies: { 'third-party-layer': '1.0.0' },
    }))
    putProfilePackage(profileDir, 'third-party-layer', { version: '1.0.0' })
    putProfilePackage(profileDir, '@deepseek-ai/schemastery', { version: '3.18.2' })
    // Obviously skewed, but neither a version fact nor a runtime generation
    // exists for it ⇒ this name's arm NEVER runs.
    putProfilePackage(profileDir, '@deepseek-ai/cosmokit', { version: '9.9.9' })
    const facts = {
      profileDir,
      familyNames: ['@deepseek-ai/schemastery', '@deepseek-ai/cosmokit'],
      runtimeVersion: null,
    }
    const partial = verifyProfileFamilyConsistency({
      ...facts,
      familyVersions: new Map([['@deepseek-ai/schemastery', ['3.18.2']]]),
    })
    assert.deepEqual(partial, {
      ok: true,
      checked: 2,
      skipped: 'no runtime-provided version fact exists and the instance runtime version is unknown for @deepseek-ai/cosmokit; the generation arm of the verification could not run for them',
    }, 'a name that entered no arm must never be folded into a silent pass')

    // No name ran any arm at all ⇒ the historic aggregate wording is preserved.
    const none = verifyProfileFamilyConsistency(facts)
    assert.deepEqual(none, {
      ok: true,
      checked: 2,
      skipped: 'the instance runtime version is unknown; the generation arm of the verification could not run',
    })
  } finally {
    rmSync(profileDir, { recursive: true, force: true })
  }
})

test('verifyProfileFamilyConsistency: 树里没有任何 F 名字 ⇒ 不是跳过（空族 + 合法世代）', () => {
  const profileDir = mkdtempSync(join(tmpdir(), 'dsh-verify-nofamily-'))
  try {
    // The gateway's empty-family fact is legitimate: the runtime provides no
    // official-scope packages, and the only top-level entry is the user's own
    // direct layer. There is nothing to compare ⇒ a clean pass, NOT a skip
    // (the 0 === 0 trap the earlier per-name refactor introduced).
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      dependencies: { '@deepseek-ai/dsh-experimental-agent-team': '0.1.5-rc.2' },
    }))
    const dir = join(profileDir, 'node_modules', '@deepseek-ai', 'dsh-experimental-agent-team')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-experimental-agent-team', version: '0.1.5-rc.2' }))
    assert.deepEqual(
      verifyProfileFamilyConsistency({ profileDir, familyNames: [], runtimeVersion: '0.1.5-rc.2' }),
      { ok: true, checked: 0 },
    )
  } finally {
    rmSync(profileDir, { recursive: true, force: true })
  }
})

test('resolveRuntimeFamily: 两条来源都产出 name→version（锁文件取 pinned 版本，树取各包清单）', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'dsh-family-versions-'))
  try {
    writeFileSync(join(workspace, 'pnpm-lock.yaml'), [
      "lockfileVersion: '9.0'",
      'packages:',
      "  '@deepseek-ai/dsh@0.1.5-rc.2':",
      "  '@deepseek-ai/dsh-base@0.1.5-rc.2':",
      "  '@deepseek-ai/dsh-web-app@0.1.5-rc.2':",
      "  '@deepseek-ai/cosmokit@1.8.3':",
    ].join('\n'))
    const fromLock = resolveRuntimeFamily(workspace)
    assert.equal(fromLock.ok, true)
    assert.deepEqual(fromLock.ok ? fromLock.versions.get('@deepseek-ai/cosmokit') : null, ['1.8.3'])

    // No lockfile ⇒ tree enumeration supplies names AND versions.
    rmSync(join(workspace, 'pnpm-lock.yaml'))
    for (const [name, version] of [
      ['dsh', '0.1.5-rc.2'], ['dsh-base', '0.1.5-rc.2'], ['dsh-web-app', '0.1.5-rc.2'], ['cosmokit', '1.8.3'],
    ]) {
      const dir = join(workspace, 'node_modules', '@deepseek-ai', name as string)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `@deepseek-ai/${name}`, version }))
    }
    const fromTree = resolveRuntimeFamily(workspace)
    assert.equal(fromTree.ok, true)
    assert.equal(fromTree.ok ? fromTree.source : null, 'runtime-tree')
    assert.deepEqual(fromTree.ok ? fromTree.versions.get('@deepseek-ai/cosmokit') : null, ['1.8.3'])
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('verifyProfileFamilyConsistency: 第三方层夹带官方 scope 名字不再被闭包豁免（2026-12 review 收紧）', () => {
  const profileDir = mkdtempSync(join(tmpdir(), 'dsh-verify-carry-'))
  try {
    // A plain third-party layer whose closure carries an official-scope name the
    // runtime line does not provide. Only the closure of an OFFICIAL direct
    // layer may explain such a name; otherwise any published package could
    // smuggle one in silently (the runtime resolves inserted rows by name).
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      dependencies: { 'evil-layer': '1.0.0' },
    }))
    putProfilePackage(profileDir, 'evil-layer', { version: '1.0.0', dependencies: { '@deepseek-ai/dsh-session-helper': '0.1.5-rc.2' } })
    putProfilePackage(profileDir, '@deepseek-ai/dsh-session-helper', { version: '0.1.5-rc.2' })
    const carried = verifyProfileFamilyConsistency({
      profileDir,
      familyNames: [...PROFILE_BUNDLES_SNAPSHOT],
      runtimeVersion: '0.1.5-rc.2',
      familyVersions: new Map(),
    })
    assert.equal(carried.ok, false, 'a third-party layer must not be able to smuggle an official-scope name')
    if (!carried.ok) {
      assert.deepEqual(carried.findings, [
        { name: '@deepseek-ai/dsh-session-helper', version: '0.1.5-rc.2', kind: 'outside-family' },
      ])
    }

    // Control: the very same name reached through OFFICIAL layers only stays
    // exempt — the walk may cross official hops, never a third-party one.
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      dependencies: { '@deepseek-ai/dsh-experimental-agent-team-profile': '0.1.5-rc.2' },
    }))
    putProfilePackage(profileDir, '@deepseek-ai/dsh-experimental-agent-team-profile', {
      version: '0.1.5-rc.2',
      dependencies: { '@deepseek-ai/dsh-experimental-agent-team': '0.1.5-rc.2' },
    })
    putProfilePackage(profileDir, '@deepseek-ai/dsh-experimental-agent-team', {
      version: '0.1.5-rc.2',
      dependencies: { '@deepseek-ai/dsh-session-helper': '0.1.5-rc.2' },
    })
    assert.deepEqual(verifyProfileFamilyConsistency({
      profileDir,
      familyNames: [...PROFILE_BUNDLES_SNAPSHOT],
      runtimeVersion: '0.1.5-rc.2',
      familyVersions: new Map(),
    }), { ok: true, checked: 2 })

    // ...but a THIRD-PARTY intermediary inside an official layer's closure must
    // not be able to explain an official name (real closures carry zod/react).
    putProfilePackage(profileDir, '@deepseek-ai/dsh-experimental-agent-team', {
      version: '0.1.5-rc.2',
      dependencies: { zod: '4.6.4' },
    })
    putProfilePackage(profileDir, 'zod', { version: '4.6.4', dependencies: { '@deepseek-ai/dsh-session-helper': '0.1.5-rc.2' } })
    const deep = verifyProfileFamilyConsistency({
      profileDir,
      familyNames: [...PROFILE_BUNDLES_SNAPSHOT],
      runtimeVersion: '0.1.5-rc.2',
      familyVersions: new Map(),
    })
    assert.equal(deep.ok, false, 'a third-party hop must not explain an official-scope name')
    if (!deep.ok) {
      assert.deepEqual(deep.findings, [
        { name: '@deepseek-ai/dsh-session-helper', version: '0.1.5-rc.2', kind: 'outside-family' },
      ])
    }
  } finally {
    rmSync(profileDir, { recursive: true, force: true })
  }
})

test('resolveRuntimeFamily: 名字可解析而版本一个都解析不出 ⇒ 拒绝该来源（两个解析器自相矛盾时宁可不放行）', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'dsh-family-disagree-'))
  try {
    const lockfile = (versionCell: string) => [
      "lockfileVersion: '9.0'",
      'packages:',
      `  '@deepseek-ai/dsh@${versionCell}':`,
      `  '@deepseek-ai/dsh-base@${versionCell}':`,
      `  '@deepseek-ai/dsh-web-app@${versionCell}':`,
      `  '@deepseek-ai/cosmokit@${versionCell}':`,
    ].join('\n')
    // A range-form key (no pinned version) keeps the NAME parser happy but leaves
    // the version fact empty. Letting it through would silently push every
    // family member back to the generation arm — the exact false-positive path
    // this module was fixed for — so the source must be refused instead.
    writeFileSync(join(workspace, 'pnpm-lock.yaml'), lockfile('^0.1.5'))
    const refused = resolveRuntimeFamily(workspace)
    assert.equal(refused.ok, false, 'a self-contradicting fact source must not become F')
    assert.match(refused.ok ? '' : refused.reason, /no parseable versions/)
    // Positive control: the same file with pinned versions stays usable.
    writeFileSync(join(workspace, 'pnpm-lock.yaml'), lockfile('0.1.5-rc.2'))
    const ok = resolveRuntimeFamily(workspace)
    assert.equal(ok.ok, true)
    assert.deepEqual(ok.ok ? ok.names.length : 0, 4)
    assert.deepEqual(ok.ok ? ok.versions.get('@deepseek-ai/cosmokit') : null, ['0.1.5-rc.2'])
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('resolveRuntimeFamily: 锚锁文件优先于活动树（dev 形态的活动树可能是源码线，闭包含 opt-in 段）', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'dsh-family-ws-'))
  const pinnedDir = mkdtempSync(join(tmpdir(), 'dsh-family-pin-'))
  try {
    // The ACTIVE tree carries a source-line-like lockfile (opt-in segment) — the
    // pin must win, and without a pin that lockfile must be REJECTED, not adopted.
    writeFileSync(join(workspace, 'pnpm-lock.yaml'), [
      "lockfileVersion: '9.0'",
      'packages:',
      "  '@deepseek-ai/dsh@0.1.5-rc.2':",
      "  '@deepseek-ai/dsh-base@0.1.5-rc.2':",
      "  '@deepseek-ai/dsh-web-app@0.1.5-rc.2':",
      "  '@deepseek-ai/dsh-experimental-agent-team-profile@0.1.5-rc.2':",
    ].join('\n'))
    // The PINNED runtime-line lockfile does not.
    const pinned = join(pinnedDir, 'pnpm-lock.yaml')
    writeFileSync(pinned, [
      "lockfileVersion: '9.0'",
      'packages:',
      "  '@deepseek-ai/dsh@0.1.5-rc.2':",
      "  '@deepseek-ai/dsh-base@0.1.5-rc.2':",
      "  '@deepseek-ai/dsh-web-app@0.1.5-rc.2':",
    ].join('\n'))

    const withPin = resolveRuntimeFamily(workspace, { pinnedLockfilePath: pinned })
    assert.equal(withPin.ok, true)
    assert.equal(withPin.ok ? withPin.source : null, 'pinned-lockfile')
    assert.equal(withPin.ok ? withPin.lockfilePath : null, pinned)
    assert.deepEqual(withPin.ok ? withPin.names : [],
      ['@deepseek-ai/dsh', '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
      'the committed runtime-line closure wins — the opt-in name must NOT enter F')
    // The opt-in layer stays installable under the pinned facts (the whole point
    // of the redesign), while it would have been hard-protected by the tree.
    assert.equal(decide({ name: '@deepseek-ai/dsh-experimental-agent-team-profile', version: '0.1.5-rc.2',
      derivation: { ok: true, set: okSet({ familyNames: withPin.ok ? withPin.names : [] }) } }).kind, 'allow')

    // No pin (or a missing pin file) ⇒ the active tree's lockfile is considered — but a
    // source-line closure is REJECTED (reasons named), so F is never silently poisoned.
    const noPin = resolveRuntimeFamily(workspace)
    assert.equal(noPin.ok, false, 'without the pin the source-line closure must not become F')
    assert.match(noPin.ok ? '' : noPin.reason, /opt-in layer belongs to the source line/)
    const missingPin = resolveRuntimeFamily(workspace, { pinnedLockfilePath: join(pinnedDir, 'nope.yaml') })
    assert.equal(missingPin.ok, false)
  } finally {
    rmSync(workspace, { recursive: true, force: true })
    rmSync(pinnedDir, { recursive: true, force: true })
  }
})

test('verifyProfileFamilyConsistency: 复验无法执行时是 skipped（响亮），绝不是静默通过', () => {
  const profileDir = mkdtempSync(join(tmpdir(), 'dsh-verify-skip-'))
  try {
    // node_modules/@deepseek-ai exists but the profile manifest is corrupt ⇒
    // the direct-dependency set cannot be derived ⇒ skipped with a reason.
    mkdirSync(join(profileDir, 'node_modules', '@deepseek-ai', 'dsh-brand'), { recursive: true })
    writeFileSync(join(profileDir, 'node_modules', '@deepseek-ai', 'dsh-brand', 'package.json'), '{"name":"@deepseek-ai/dsh-brand","version":"0.1.5-rc.2"}')
    writeFileSync(join(profileDir, 'package.json'), '{ not json')
    const skipped = verifyProfileFamilyConsistency({ profileDir, familyNames: FAMILY, runtimeVersion: '0.1.5-rc.2' })
    assert.equal(skipped.ok, true)
    assert.match(skipped.ok ? (skipped.skipped ?? '') : '', /could not be read/)
    // No tree at all ⇒ a normal empty verification, NOT a skip.
    const cleanDir = mkdtempSync(join(tmpdir(), 'dsh-verify-clean-'))
    try {
      assert.deepEqual(verifyProfileFamilyConsistency({ profileDir: cleanDir, familyNames: FAMILY, runtimeVersion: '0.1.5-rc.2' }),
        { ok: true, checked: 0 })
    } finally {
      rmSync(cleanDir, { recursive: true, force: true })
    }
  } finally {
    rmSync(profileDir, { recursive: true, force: true })
  }
})

test('readInstalledVersion: 读得到返回版本；越名/缺清单/坏 JSON 一律 null', () => {
  const profileDir = mkdtempSync(join(tmpdir(), 'dsh-profile-'))
  try {
    const pkgDir = join(profileDir, 'node_modules', '@deepseek-ai', 'dsh-session')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-session', version: '0.1.5-rc.2' }))
    assert.equal(readInstalledVersion(profileDir, '@deepseek-ai/dsh-session'), '0.1.5-rc.2')
    assert.equal(readInstalledVersion(profileDir, '@deepseek-ai/missing'), null)
    assert.equal(readInstalledVersion(profileDir, '../../etc/passwd'), null)
    const broken = join(profileDir, 'node_modules', 'broken')
    mkdirSync(broken, { recursive: true })
    writeFileSync(join(broken, 'package.json'), '{ not json')
    assert.equal(readInstalledVersion(profileDir, 'broken'), null)
  } finally {
    rmSync(profileDir, { recursive: true, force: true })
  }
})
