/**
 * protected-plugins.ts 单测（design 21 §6.11）：受保护集合派生、读面行投影、
 * 运行时线族解析（锁文件优先 / 树兜底 / 都没有则 fail-closed）与版本事实。
 * 用户插件写面已随 2026-09 C 分层退役，本套件只覆盖读面事实。
 *
 * Run directly: node packages/control-plane/test/plugins/protected-plugins.test.ts
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isMaterializedValue,
  PLUGIN_MATERIALIZED_VALUE_MASK,
} from '@dsh-chamber/dsh-chamber-wire/plugin-manifest'
import {
  derivePluginRows,
  deriveProtectedSet,
  familyNamesFromLockfileClosure,
  familyVersionsFromLockfileClosure,
  PROFILE_BUNDLES_SNAPSHOT,
  RUNTIME_FAMILY_CORE,
  protectedReason,
  readInstalledVersion,
  resolveRuntimeFamily,
  type ProtectedFacts,
} from '../../src/protected-plugins.ts'

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
  // The read face would answer "nothing is protected" — while this module
  // promises protection never silently degrades to nothing. Hence a fail-closed
  // guard. No production path can reach it today (B₀ defaults to the non-empty
  // snapshot, S comes from the non-empty registry); a caller reading the
  // installation bundles from a profile can.
  const derived = deriveProtectedSet({ installationBundles: [], seedNames: [], familyNames: null })
  assert.equal(derived.ok, false, 'an empty protected set must never be ok:true')
  // The non-empty neighbours keep working: default B₀ alone, S alone, F alone.
  assert.equal(deriveProtectedSet({ seedNames: [], familyNames: null }).ok, true)
  assert.equal(deriveProtectedSet({ installationBundles: [], seedNames: ['@dsh-chamber/x'], familyNames: null }).ok, true)
  assert.equal(deriveProtectedSet({ installationBundles: [], seedNames: [], familyNames: ['@deepseek-ai/dsh-base'] }).ok, true)
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
  // 同一个名字**确实**出现在依赖表里时，role/protected 照旧由分类器给出。
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
  assert.equal(byName.get('@deepseek-ai/dsh-base')?.protected, true)
  assert.equal(byName.get(SEEDS[0])?.role, 'seed')
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
  // 可信闭包 = 核心锚齐全 + 无禁名 + 官方 opt-in 全在登记白名单内（与 C11 同一判据）。
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

    // 2) 锁文件存在即权威——**哪怕只解析出少量名字**（没有"名字太少就换来源"的启发式）
    writeFileSync(join(root, 'pnpm-lock.yaml'), ['lockfileVersion: \'9.0\'', 'packages:', ...core].join('\n'))
    const withLock = resolveRuntimeFamily(root)
    assert.equal(withLock.ok, true)
    assert.equal(withLock.ok ? withLock.source : null, 'lockfile-closure')
    assert.equal(withLock.ok ? withLock.names.length : 0, 3)
    // ...and a SMALL lockfile still outranks the (populated) tree: the closure is
    // the authoritative, platform-independent source.
    assert.deepEqual(withLock.ok ? withLock.names : [], [...RUNTIME_FAMILY_CORE].sort())

    // 2b) 不可信的闭包**不是** F：dev/test 段、未登记的 opt-in 与裁剪过的锁文件都被拒；
    //     登记白名单里的 opt-in 名字是 F 的合法成员（运行时根包自己声明的运行时依赖）。
    //     用一个没有树的干净目录，隔离"锁文件被拒 → 退回树枚举"的兜底（那是有意行为）。
    const lockOnly = mkdtempSync(join(tmpdir(), 'dsh-family-lockonly-'))
    try {
      writeFileSync(join(lockOnly, 'pnpm-lock.yaml'), ['lockfileVersion: \'9.0\'', 'packages:',
        ...core, "  '@deepseek-ai/dsh-benchmarks@0.1.5-rc.2':"].join('\n'))
      const sourceLine = resolveRuntimeFamily(lockOnly)
      assert.equal(sourceLine.ok, false, 'a closure carrying a dev/test package must be rejected')
      assert.match(sourceLine.ok ? '' : sourceLine.reason, /dev\/test package belongs to the source line/)
      writeFileSync(join(lockOnly, 'pnpm-lock.yaml'), ['lockfileVersion: \'9.0\'', 'packages:',
        ...core, "  '@deepseek-ai/dsh-experimental-inspector@0.1.5-rc.2':"].join('\n'))
      const unregistered = resolveRuntimeFamily(lockOnly)
      assert.equal(unregistered.ok, false, 'an unregistered opt-in name must be rejected')
      assert.match(unregistered.ok ? '' : unregistered.reason, /unregistered official opt-in package/)
      writeFileSync(join(lockOnly, 'pnpm-lock.yaml'), ['lockfileVersion: \'9.0\'', 'packages:',
        ...core, "  '@deepseek-ai/dsh-experimental-agent-team-profile@0.1.5-rc.2':"].join('\n'))
      const registered = resolveRuntimeFamily(lockOnly)
      assert.equal(registered.ok, true, 'a registered opt-in name is a legitimate F member')
      assert.ok(registered.ok && registered.names.includes('@deepseek-ai/dsh-experimental-agent-team-profile'))
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

test('derivePluginRows: 分类器作用于依赖表内的组合/播种名，行键集恒等于依赖键集', () => {
  const dependencies = {
    'third-party-pkg': '^1.0.0',
    'layer-pkg': '^2.0.0',
    [SEEDS[0]]: '0.3.1',
    '@deepseek-ai/dsh-base': '0.1.5-rc.2',
  }
  const rows = derivePluginRows({
    // 组合/播种名同样要在依赖表里才成行——分类器对它们照常生效。
    dependencies,
    bundles: ['layer-pkg'],
    protectedSet: okSet(),
    seedNames: SEEDS,
  })
  assert.equal(rows.find(row => row.name === 'third-party-pkg')?.role, 'third-party')
  assert.equal(rows.find(row => row.name === 'layer-pkg')?.role, 'layer')
  assert.equal(rows.find(row => row.name === SEEDS[0])?.role, 'seed')
  assert.equal(rows.find(row => row.name === '@deepseek-ai/dsh-base')?.role, 'composition')
  // 锁步：行键集恒等于依赖键集。渲染端的 `actionableDependencies` 依赖
  // "rows 覆盖 dependencies" 这一隐含前提（缺行即静默跳过 ⇒ 少动作）；producer
  // 若哪天收窄成子集，这条会先红。
  assert.deepEqual(rows.map(row => row.name).sort(), Object.keys(dependencies).sort())
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
    // The ACTIVE tree carries a source-line-like lockfile (an UNREGISTERED opt-in name) —
    // the pin must win, and without a pin that lockfile must be REJECTED, not adopted.
    writeFileSync(join(workspace, 'pnpm-lock.yaml'), [
      "lockfileVersion: '9.0'",
      'packages:',
      "  '@deepseek-ai/dsh@0.1.5-rc.2':",
      "  '@deepseek-ai/dsh-base@0.1.5-rc.2':",
      "  '@deepseek-ai/dsh-web-app@0.1.5-rc.2':",
      "  '@deepseek-ai/dsh-experimental-inspector@0.1.5-rc.2':",
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
    // The pinned closure is F's sole authority: a name it does not carry is not
    // protected, and the rejected active-tree closure never becomes a protection source.
    assert.equal(protectedReason(okSet({ familyNames: withPin.ok ? withPin.names : [] }),
      '@deepseek-ai/dsh-experimental-agent-team-profile'), null,
    'the pinned closure is the sole authority: a name it does not carry is not protected')

    // No pin (or a missing pin file) ⇒ the active tree's lockfile is considered — but a
    // source-line closure is REJECTED (reasons named), so F is never silently poisoned.
    const noPin = resolveRuntimeFamily(workspace)
    assert.equal(noPin.ok, false, 'without the pin the source-line closure must not become F')
    assert.match(noPin.ok ? '' : noPin.reason, /unregistered official opt-in package/)
    const missingPin = resolveRuntimeFamily(workspace, { pinnedLockfilePath: join(pinnedDir, 'nope.yaml') })
    assert.equal(missingPin.ok, false)
  } finally {
    rmSync(workspace, { recursive: true, force: true })
    rmSync(pinnedDir, { recursive: true, force: true })
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
