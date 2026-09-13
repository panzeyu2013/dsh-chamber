/**
 * plugin-protection-gate.test.mjs — C11–C14 纯判据的单测（含**负例**：改坏派生
 * 来源 / profile 契约 / 播种注册表 / manifest 镜像都必须变红），外加对**真实仓库
 * 文件**的正向断言（我的解析器与锚点必须与仓内现状一致——锚点写错会在这里先红，
 * 而不是在 CI 里红）。
 *
 * 跑法：`node --test scripts/dev/plugin-protection-gate.test.mjs`
 * （已挂进 `pnpm run test:upgrade-tools`）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  FAMILY_CORE,
  familyFindings,
  interfaceFields,
  manifestMirrorFindings,
  profileContractFindings,
  runtimeFamilyNames,
  seedRegistryFindings,
} from './plugin-protection-gate.mjs'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (rel) => readFileSync(join(REPO_ROOT, rel), 'utf8')

/** 合成一个「健康」的闭包名集合（≥ MIN_FAMILY_SIZE 才不会触发健全性下限）。 */
function healthyNames(extra = []) {
  const filler = Array.from({ length: 240 }, (_, i) => `@deepseek-ai/dsh-filler-${i}`)
  return [...FAMILY_CORE, ...filler, ...extra].sort()
}

// ---------------------------------------------------------------------------
// C11 —— 运行时线族集合
// ---------------------------------------------------------------------------

test('runtimeFamilyNames: 只吃 packages 段（2 空格）键，去重升序，兼容 v9/v6 两种锁文件', () => {
  const lock = [
    'lockfileVersion: \'9.0\'',
    'importers:',
    '  .:',
    '    dependencies:',
    "      '@deepseek-ai/dsh':",
    '        specifier: 1.2.3',
    'packages:',
    "  '@deepseek-ai/dsh@1.2.3':",
    '    resolution: {integrity: sha512-x}',
    "  '@deepseek-ai/dsh-base@1.2.3':",
    '    resolution: {integrity: sha512-y}',
    "  '@deepseek-ai/dsh-base@1.2.4':",
    '    resolution: {integrity: sha512-z}',
    '  /@deepseek-ai/legacy-pkg/1.0.0:',
    '    resolution: {integrity: sha512-w}',
    '  zod@4.0.0:',
    '    resolution: {integrity: sha512-v}',
  ].join('\n')
  assert.deepEqual(runtimeFamilyNames(lock), [
    '@deepseek-ai/dsh',
    '@deepseek-ai/dsh-base',
    '@deepseek-ai/legacy-pkg',
  ])
})

test('C11 正例：闭包健康 + 树只差平台分包 → 无违规（且报出平台差）', () => {
  const names = healthyNames(['@deepseek-ai/node-addon-system-linux-x64'])
  const treeNames = names.filter((name) => name !== '@deepseek-ai/node-addon-system-linux-x64')
  const { violations, notes } = familyFindings({ names, treeNames })
  assert.deepEqual(violations, [])
  assert.ok(notes.some((note) => note.includes('等价性校验')), notes.join('; '))
})

test('C11 负例：闭包缺核心 / 混入 opt-in 层 / 混入 dev 包 都必须红', () => {
  const missingCore = familyFindings({ names: healthyNames().filter((n) => n !== '@deepseek-ai/dsh-web-app'), treeNames: null })
  assert.ok(missingCore.violations.some((v) => v.includes('dsh-web-app')))

  const optIn = familyFindings({ names: healthyNames(['@deepseek-ai/dsh-experimental-agent-team-profile']), treeNames: null })
  assert.ok(optIn.violations.some((v) => v.includes('opt-in')), optIn.violations.join('; '))

  const devPkg = familyFindings({ names: healthyNames(['@deepseek-ai/dsh-benchmarks', '@deepseek-ai/dsh-agent-loop-testkit']), treeNames: null })
  assert.equal(devPkg.violations.length, 2, devPkg.violations.join('; '))
})

test('C11 负例：树缺非平台包 / 树多出闭包外包 → 红；树未物化 → 只 note', () => {
  const names = healthyNames()
  const short = familyFindings({ names, treeNames: names.filter((n) => n !== '@deepseek-ai/dsh-filler-7') })
  assert.ok(short.violations.some((v) => v.includes('@deepseek-ai/dsh-filler-7')), short.violations.join('; '))

  const extra = familyFindings({ names, treeNames: [...names, '@deepseek-ai/dsh-not-in-closure'] })
  assert.ok(extra.violations.some((v) => v.includes('dsh-not-in-closure')))

  const absent = familyFindings({ names, treeNames: null })
  assert.deepEqual(absent.violations, [])
  assert.ok(absent.notes.some((note) => note.includes('未物化')))
})

test('C11 负例：闭包解析崩坏（少于下限）→ 红，且不再逐条报', () => {
  const { violations } = familyFindings({ names: ['@deepseek-ai/dsh'], treeNames: null })
  assert.equal(violations.length, 1)
  assert.match(violations[0], /< 200/)
})

test('C11 note：源码线 vendor 树含 opt-in 包时只提醒（它不是 F 的来源）', () => {
  const { violations, notes } = familyFindings({
    names: healthyNames(),
    treeNames: null,
    sourceTreeNames: ['@deepseek-ai/dsh-experimental-inspector', '@deepseek-ai/dsh-base'],
  })
  assert.deepEqual(violations, [])
  assert.ok(notes.some((note) => note.includes('绝不是 F 的来源')), notes.join('; '))
})

// ---------------------------------------------------------------------------
// C12 —— profile 契约锚
// ---------------------------------------------------------------------------

const PROFILE_OK = `
export const PROFILE_TEMPLATES: Record<string, ProfileTemplate> = {
  web: {
    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
    patchReload: 'live',
  },
}
nodeLinker: hoisted
autoInstallPeers: false
export const DEFAULT_PROFILE_BUNDLES: readonly string[] = ['@deepseek-ai/dsh-base']
      dsh: { profile: { bundles: [...bundles], patchReload } },
`
const PLUGIN_OK = `
 * then reconcile the \`dsh.profile.bundles\` layer list
  return manifest.dsh?.bundle?.patch !== undefined
  const plugins = after.dsh?.profile?.bundles ?? []
        \`\${NAME}: warning: \${packageName} declares no dsh.bundle — installed as a plain dependency\`
      template?.bundles ?? DEFAULT_PROFILE_BUNDLES,
`

test('C12 正例：空白扰动（换行/缩进不同）不影响命中', () => {
  const { violations } = profileContractFindings({ profileSource: PROFILE_OK, pluginSource: PLUGIN_OK })
  assert.deepEqual(violations, [])
})

test('C12 负例：模板默认组合改了 / 链接器改了 / 层声明机制改了 都必须红', () => {
  const driftedTemplate = PROFILE_OK.replace(
    "bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']",
    "bundles: ['@deepseek-ai/dsh-base']",
  )
  assert.ok(profileContractFindings({ profileSource: driftedTemplate, pluginSource: PLUGIN_OK })
    .violations.some((v) => v.includes('模板默认组合')))

  const driftedLinker = PROFILE_OK.replace('autoInstallPeers: false', 'autoInstallPeers: true')
  assert.ok(profileContractFindings({ profileSource: driftedLinker, pluginSource: PLUGIN_OK })
    .violations.some((v) => v.includes('不自动装 peer')))

  const driftedDecl = PLUGIN_OK.replace('dsh?.bundle?.patch', 'dsh?.layer?.patch')
  assert.ok(profileContractFindings({ profileSource: PROFILE_OK, pluginSource: driftedDecl })
    .violations.some((v) => v.includes('dsh.bundle.patch')))
})

test('C12 未物化子模块：只 note，不违规（缺失子模块由 C1/C3/C5 响亮失败）', () => {
  const { violations, notes } = profileContractFindings({ profileSource: null, pluginSource: null })
  assert.deepEqual(violations, [])
  assert.ok(notes.some((note) => note.includes('未物化')))
})

// ---------------------------------------------------------------------------
// C13 —— 播种注册表结构
// ---------------------------------------------------------------------------

const SEED_OK = `
export const HOST_GRAPH_PACKAGE_NAME = '@dsh-chamber/dsh-chamber-seed-client-graph'
export const HOST_GIT_WORKTREE_PACKAGE_NAME = '@dsh-chamber/dsh-chamber-seed-git-worktree'
export const HOST_GRAPH_INSERT: HostPackageInsert = {
  id: HOST_GRAPH_INSERT_ID,
  name: HOST_GRAPH_PACKAGE_NAME,
}
export const HOST_GIT_WORKTREE_INSERT: HostPackageInsert = {
  id: HOST_GIT_WORKTREE_INSERT_ID,
  name: HOST_GIT_WORKTREE_PACKAGE_NAME,
}
export const CHAMBER_HOST_PACKAGES: readonly ChamberHostPackageDescriptor[] = [
  { insert: HOST_GRAPH_INSERT, probe: { method: 'clientGraph/graph', args: {} } },
  { insert: HOST_GIT_WORKTREE_INSERT, probe: { method: 'gitWorktree/previewCreate', args: { input: {} } } },
]
`

test('C13 正例：包名常量 ↔ 插入行 ↔ 注册表三面一致', () => {
  const { violations, notes } = seedRegistryFindings({ seedSource: SEED_OK })
  assert.deepEqual(violations, [])
  assert.ok(notes.some((note) => note.includes('一一对应')))
})

test('C13 负例：孤儿常量 / 注册表引用未知行 / 常量被改名 都必须红', () => {
  const orphan = seedRegistryFindings({ seedSource: SEED_OK.replace(
    "export const HOST_GIT_WORKTREE_PACKAGE_NAME = '@dsh-chamber/dsh-chamber-seed-git-worktree'",
    "export const HOST_NEW_PACKAGE_NAME = '@dsh-chamber/dsh-chamber-seed-new'\nexport const HOST_GIT_WORKTREE_PACKAGE_NAME = '@dsh-chamber/dsh-chamber-seed-git-worktree'",
  ) })
  assert.ok(orphan.violations.some((v) => v.includes('HOST_NEW_PACKAGE_NAME')), orphan.violations.join('; '))

  const unknownRow = seedRegistryFindings({ seedSource: SEED_OK.replace(
    'insert: HOST_GIT_WORKTREE_INSERT',
    'insert: HOST_GHOST_INSERT',
  ) })
  assert.ok(unknownRow.violations.some((v) => v.includes('HOST_GHOST_INSERT')))

  const renamed = seedRegistryFindings({ seedSource: '# nothing here' })
  assert.ok(renamed.violations.length > 0)
})

test('C13 负例：包名越域（不在 @dsh-chamber/*）→ 红', () => {
  const { violations } = seedRegistryFindings({ seedSource: SEED_OK.replace(
    "'@dsh-chamber/dsh-chamber-seed-client-graph'",
    "'@someone-else/client-graph'",
  ) })
  assert.ok(violations.some((v) => v.includes('不在 @dsh-chamber/* 域内')))
})

// ---------------------------------------------------------------------------
// C14 —— manifest 三方镜像
// ---------------------------------------------------------------------------

test('interfaceFields: 跳过注释与嵌套对象成员，保住可选字段', () => {
  const source = `
/** doc */
export interface Demo {
  /** doc */
  name: string
  spec?: string
  nested: {
    inner: number
  }
  chamber: { ok: true; packages: string[] }
}
`
  assert.deepEqual(interfaceFields(source, 'Demo'), ['name', 'spec', 'nested', 'chamber'])
  assert.equal(interfaceFields(source, 'Missing'), null)
})

test('C14 负例：producer 独有字段 / preload↔renderer 顺序漂移 / 缺接口 都必须红', () => {
  const producerWithExtra = [
    'export interface RemotePluginManifest {',
    '  dependencies: Record<string, string>',
    '  bundles: string[]',
    '  profileExists: boolean',
    '  extra: number',
    '}',
    'export interface LocalPluginManifest {',
    '  dependencies: Record<string, string>',
    '}',
  ].join('\n')
  const preloadOk = [
    'export interface SshRemotePluginManifest {',
    '  dependencies: Record<string, string>',
    '  bundles: string[]',
    '  profileExists: boolean',
    '}',
    'export interface SshLocalPluginManifest {',
    '  dependencies: Record<string, string>',
    '}',
  ].join('\n')
  const rendererOk = [
    'export interface RemotePluginManifest {',
    '  dependencies: Record<string, string>',
    '  bundles: string[]',
    '  profileExists: boolean',
    '}',
    'export interface LocalPluginManifest {',
    '  dependencies: Record<string, string>',
    '}',
  ].join('\n')
  const drifted = manifestMirrorFindings({ producerSource: producerWithExtra, preloadSource: preloadOk, rendererSource: rendererOk })
  assert.ok(drifted.violations.some((v) => v.includes('extra')), drifted.violations.join('; '))

  const rendererReordered = rendererOk.replace(
    '  dependencies: Record<string, string>\n  bundles: string[]\n  profileExists: boolean',
    '  bundles: string[]\n  dependencies: Record<string, string>\n  profileExists: boolean',
  )
  const reordered = manifestMirrorFindings({ producerSource: preloadOk.replace(/Ssh/g, ''), preloadSource: preloadOk, rendererSource: rendererReordered })
  assert.ok(reordered.violations.some((v) => v.includes('顺序漂移')), reordered.violations.join('; '))

  const missing = manifestMirrorFindings({
    producerSource: preloadOk.replace(/Ssh/g, ''),
    preloadSource: preloadOk,
    rendererSource: 'export interface Nope { a: string }',
  })
  assert.ok(missing.violations.some((v) => v.includes('找不到接口声明')))
})

// ---------------------------------------------------------------------------
// 对真实仓库的正向断言（解析器/锚点必须与仓内现状一致）
// ---------------------------------------------------------------------------

test('真实仓库：C11 运行时线闭包含核心且无 opt-in/dev 包', () => {
  const names = runtimeFamilyNames(read('packages/desktop/vendor/dsh/pnpm-lock.yaml'))
  const { violations } = familyFindings({ names, treeNames: null })
  assert.deepEqual(violations, [], violations.join('; '))
  assert.ok(names.length >= 200, `闭包仅 ${names.length} 项`)
})

test('真实仓库：C13 播种注册表三面一致', () => {
  const { violations } = seedRegistryFindings({ seedSource: read('packages/control-plane/src/host-graph-seed.ts') })
  assert.deepEqual(violations, [], violations.join('; '))
})

test('C14 行类型负例：删 owner? / 收窄 role 字面量并集 / 行字段漂移 都必须红', () => {
  // 合成三方行类型：producer（命名角色类型）与 wire 两处（字面量并集）——
  // 这正是"宿主字段名一致但行内漂移"的形态。
  const producer = [
    'export interface PluginRow {',
    '  name: string',
    '  spec: string | null',
    '  role: PluginRowRole',
    '  owner?: \'installation\' | \'chamber\' | \'user\'',
    '}',
  ].join('\n')
  const preload = [
    'export interface PluginRowProjection {',
    '  name: string',
    '  spec: string | null',
    '  role: \'composition\' | \'seed\' | \'layer\' | \'third-party\' | \'materialized\' | \'unknown\'',
    '  owner?: \'installation\' | \'chamber\' | \'user\'',
    '}',
  ].join('\n')
  const renderer = preload.replace('PluginRowProjection', 'PluginRowProjection')
  // 只取行类型相关的违规（合成夹具没有宿主 manifest 接口，那几条与本次断言无关）。
  const rowViolations = (input) => manifestMirrorFindings(input).violations.filter(v => v.includes('PluginRow'))
  const base = { producerSource: producer, preloadSource: preload, rendererSource: renderer, rowProducerSource: producer }
  assert.deepEqual(rowViolations(base), [], rowViolations(base).join('; '))

  // (a) wire 侧丢掉 `owner?`（宿主字段名不变 ⇒ 旧判据 0 违规）
  const lostOwner = rowViolations({ ...base, preloadSource: preload.replace("  owner?: 'installation' | 'chamber' | 'user'\n", '') })
  assert.ok(lostOwner.some((v) => v.includes('owner')), lostOwner.join('; '))

  // (b) role 字面量并集被收窄
  const narrowed = rowViolations({ ...base, preloadSource: preload.replace(" | 'unknown'", '') })
  assert.ok(narrowed.some((v) => v.includes('role')), narrowed.join('; '))

  // (c) renderer 侧漏字段
  const droppedField = rowViolations({ ...base, rendererSource: renderer.replace('  spec: string | null\n', '') })
  assert.ok(droppedField.some((v) => v.includes('行字段漂移')), droppedField.join('; '))
})

test('真实仓库：C14 manifest 三方字段集 + rows 行类型一致', () => {
  const producerSource = read('packages/desktop/plugin-sync.ts')
  const preloadSource = read('packages/desktop/preload.cts')
  const rendererSource = read('packages/renderer/src/global.d.ts')
  const rowProducerSource = read('packages/control-plane/src/protected-plugins.ts')
  const { violations, notes } = manifestMirrorFindings({ producerSource, preloadSource, rendererSource, rowProducerSource })
  assert.deepEqual(violations, [], violations.join('; '))
  assert.ok(notes.some(note => note.includes('行类型镜像')), notes.join('; '))
})

test('真实仓库：C12 在上游子模块物化时零违规（未物化则跳过）', () => {
  const profilePath = join(REPO_ROOT, 'vendor', 'harness-checkout', 'packages', 'boot', 'app-boot', 'src', 'profile.ts')
  const pluginPath = join(REPO_ROOT, 'vendor', 'harness-checkout', 'apps', 'cli', 'src', 'plugin.ts')
  const { violations, notes } = profileContractFindings({
    profileSource: existsSync(profilePath) ? readFileSync(profilePath, 'utf8') : null,
    pluginSource: existsSync(pluginPath) ? readFileSync(pluginPath, 'utf8') : null,
  })
  assert.deepEqual(violations, [], violations.join('; '))
  if (!existsSync(profilePath)) assert.ok(notes.some((note) => note.includes('未物化')))
})
