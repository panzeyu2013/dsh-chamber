/**
 * plugin-protection-gate.test.mjs — C11–C14 纯判据单测（负例：改坏派生来源 / profile 契约 / 播种
 * 注册表 / manifest 镜像 / plugin-row 单源都必须变红；另对真实仓库文件做正向断言，锚点写错在这里先红而不是在 CI 里红）。
 * 跑法：`node --test scripts/upstream/plugin-protection-gate.test.mjs`（已挂进 `pnpm run test:upgrade-tools`）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  FAMILY_CORE,
  FAMILY_OPT_IN_ALLOWED,
  familyFindings,
  interfaceFields,
  manifestMirrorFindings,
  pluginRowSingleSourceFindings,
  PLUGIN_ROW_CONSUMERS,
  PLUGIN_ROW_SINGLE_SOURCE,
  profileContractFindings,
  runtimeFamilyNames,
  seedRegistryFindings,
} from './plugin-protection-gate.mjs'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (rel) => readFileSync(join(REPO_ROOT, rel), 'utf8')

/** 合成一个「健康」的闭包名集合（≥ MIN_FAMILY_SIZE 才不会触发健全性下限；白名单条目
 *  必须也在场，否则会触发 C11 的白名单保鲜臂）。 */
function healthyNames(extra = []) {
  const filler = Array.from({ length: 240 }, (_, i) => `@deepseek-ai/dsh-filler-${i}`)
  return [...FAMILY_CORE, ...FAMILY_OPT_IN_ALLOWED, ...filler, ...extra].sort()
}

// C11 —— 运行时线族集合

// v9/v6 两种锁文件键形的解析是 packages/control-plane/test/plugins/protected-plugins.test.ts:336-353
// 的权威断言（runtimeFamilyNames 只是 familyNamesFromLockfileClosure 的纯委托）；这里只保留
// 该契约测试未覆盖的版本去重形态（同一包两个版本 → 一个族名）。
test('runtimeFamilyNames: 版本去重（同一包两个版本只出一个名字）', () => {
  const lock = [
    'packages:',
    "  '@deepseek-ai/dsh-base@1.2.3':",
    '    resolution: {integrity: sha512-y}',
    "  '@deepseek-ai/dsh-base@1.2.4':",
    '    resolution: {integrity: sha512-z}',
  ].join('\n')
  assert.deepEqual(runtimeFamilyNames(lock), ['@deepseek-ai/dsh-base'])
})

test('C11 负例：锁文件文本出现 @dsh-chamber/ 引用即红（F 来源被污染）', () => {
  // 解析器按 scope 只取 @deepseek-ai/*，所以「chamber 包混入闭包」只能由锁文件原文判定
  // （round-2 review F5：原来的 names 遍历是死分支，已改成对原文的真实扫描）。
  const names = healthyNames()
  const clean = familyFindings({
    names,
    treeNames: null,
    lockfileText: "packages:\n  '@deepseek-ai/dsh-base@1.2.3':\n    resolution: {integrity: sha512-y}\n",
  })
  assert.deepEqual(clean.violations, [])
  const polluted = familyFindings({
    names,
    treeNames: null,
    lockfileText: "packages:\n  '@dsh-chamber/dsh-chamber-wire@1.0.0':\n    resolution: {integrity: sha512-z}\n",
  })
  assert.ok(polluted.violations.some((v) => v.includes('@dsh-chamber/') && v.includes('污染')),
    polluted.violations.join('; '))
  // 不传原文（纯 names 夹具）即跳过扫描，不制造假红。
  assert.deepEqual(familyFindings({ names, treeNames: null }).violations, [])
})

test('C11 正例：闭包健康（含登记 opt-in）+ 树只差平台分包 → 无违规（且报出平台差）', () => {
  const names = healthyNames([
    '@deepseek-ai/node-addon-system-linux-x64',
    '@deepseek-ai/libreoffice-kit-win32-x64',
  ])
  const treeNames = names.filter((name) => name !== '@deepseek-ai/node-addon-system-linux-x64'
    && name !== '@deepseek-ai/libreoffice-kit-win32-x64')
  const { violations, notes } = familyFindings({ names, treeNames })
  assert.deepEqual(violations, [])
  assert.ok(notes.some((note) => note.includes('等价性校验')), notes.join('; '))
})

test('C11 负例：闭包缺核心 / 未登记 opt-in / dev 包 都必须红', () => {
  const missingCore = familyFindings({ names: healthyNames().filter((n) => n !== '@deepseek-ai/dsh-web-app'), treeNames: null })
  assert.ok(missingCore.violations.some((v) => v.includes('dsh-web-app')))
  const optIn = familyFindings({ names: healthyNames(['@deepseek-ai/dsh-experimental-inspector']), treeNames: null })
  assert.ok(optIn.violations.some((v) => v.includes('opt-in')), optIn.violations.join('; '))
  const devPkg = familyFindings({ names: healthyNames(['@deepseek-ai/dsh-benchmarks', '@deepseek-ai/dsh-agent-loop-testkit']), treeNames: null })
  assert.equal(devPkg.violations.length, 2, devPkg.violations.join('; '))
})

test('C11 登记 opt-in 是 F 的合法成员；白名单条目不在闭包里也红（上游移除/改名）', () => {
  const registered = familyFindings({ names: healthyNames(['@deepseek-ai/dsh-experimental-auto-review']), treeNames: null })
  assert.deepEqual(registered.violations, [], registered.violations.join('; '))
  const removed = healthyNames().filter((n) => n !== '@deepseek-ai/dsh-experimental-auto-review')
  const stale = familyFindings({ names: removed, treeNames: null })
  assert.ok(stale.violations.some((v) => v.includes('@deepseek-ai/dsh-experimental-auto-review') && v.includes('不再包含')),
    stale.violations.join('; '))
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

// C12 —— profile 契约锚

const PROFILE_OK = `
export const PROFILE_TEMPLATES: Record<string, ProfileTemplate> = {
  web: {
    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
  },
}
nodeLinker: hoisted
autoInstallPeers: false
export const DEFAULT_PROFILE_BUNDLES: readonly string[] = ['@deepseek-ai/dsh-base']
      dsh: { profile: { bundles: [...bundles] } },
  const bundle = bundleManifest.dsh?.bundle
  throw new Error('dsh.bundle.patch must be a file path or a list of file paths')
`
const MANAGER_OK = `
 * then reconcile the \`dsh.profile.bundles\` layer list
  return manifest.dsh?.bundle?.patch !== undefined
  const plugins = after.dsh?.profile?.bundles ?? []
        \`\${NAME}: warning: \${packageName} declares no dsh.bundle — installed as a plain dependency\`
`
const PLUGIN_OK = `
      template?.bundles ?? DEFAULT_PROFILE_BUNDLES,
`

test('C12 正例：空白扰动（换行/缩进不同）不影响命中', () => {
  const { violations } = profileContractFindings({ profileSource: PROFILE_OK, managerSource: MANAGER_OK, pluginSource: PLUGIN_OK })
  assert.deepEqual(violations, [])
})

test('C12 负例：模板默认组合改了 / 链接器改了 / 层声明机制改了 都必须红', () => {
  const driftedTemplate = PROFILE_OK.replace(
    "bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']",
    "bundles: ['@deepseek-ai/dsh-base']",
  )
  assert.ok(profileContractFindings({ profileSource: driftedTemplate, managerSource: MANAGER_OK, pluginSource: PLUGIN_OK })
    .violations.some((v) => v.includes('模板默认组合')))
  const driftedLinker = PROFILE_OK.replace('autoInstallPeers: false', 'autoInstallPeers: true')
  assert.ok(profileContractFindings({ profileSource: driftedLinker, managerSource: MANAGER_OK, pluginSource: PLUGIN_OK })
    .violations.some((v) => v.includes('不自动装 peer')))
  const driftedDecl = MANAGER_OK.replace('dsh?.bundle?.patch', 'dsh?.layer?.patch')
  assert.ok(profileContractFindings({ profileSource: PROFILE_OK, managerSource: driftedDecl, pluginSource: PLUGIN_OK })
    .violations.some((v) => v.includes('dsh.bundle.patch')))
})

test('C12 未物化子模块：只 note，不违规（缺失子模块由 C1/C3/C5 响亮失败）', () => {
  const { violations, notes } = profileContractFindings({ profileSource: null, managerSource: null, pluginSource: null })
  assert.deepEqual(violations, [])
  assert.ok(notes.some((note) => note.includes('未物化')))
})

test('C12 部分缺失：树已部分物化，缺的那个文件必须算违规（2026-09-13 round-2 review F1）', () => {
  // The dangerous shape: one anchor file renamed/moved while the others still read fine —
  // its anchors would vanish silently (no violation, not even a note) while the rest looks locked.
  const pluginGone = profileContractFindings({ profileSource: PROFILE_OK, managerSource: MANAGER_OK, pluginSource: null })
  assert.ok(pluginGone.violations.some((v) => v.includes('plugin')), pluginGone.violations.join('; '))
  const managerGone = profileContractFindings({ profileSource: PROFILE_OK, managerSource: null, pluginSource: PLUGIN_OK })
  assert.ok(managerGone.violations.some((v) => v.includes('manager')), managerGone.violations.join('; '))
  assert.ok(!pluginGone.notes.some((note) => note.includes('未物化')),
    'a partially materialized tree is not the "not materialized" case')
})

// C13 —— 播种注册表结构

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

// C14 —— manifest 宿主镜像（producer ↔ preload ↔ renderer）

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

// 对真实仓库的正向断言（解析器/锚点必须与仓内现状一致）

test('真实仓库：C11 运行时线闭包含核心、dev 包缺席、experimental 白名单与闭包双向一致', () => {
  const lockfileText = read('packages/desktop/vendor/dsh/pnpm-lock.yaml')
  const names = runtimeFamilyNames(lockfileText)
  const { violations } = familyFindings({ names, treeNames: null, lockfileText })
  assert.deepEqual(violations, [], violations.join('; '))
  assert.ok(names.length >= 200, `闭包仅 ${names.length} 项`)
  // 白名单只登记实测在闭包里的名字：闭包里的每个 experimental 都必须已登记，登记的
  // 每个名字也都必须仍在闭包里（上游移除/改名 ⇒ 删登记）。
  const experimental = names.filter((name) => name.startsWith('@deepseek-ai/dsh-experimental-'))
  const allowed = new Set(FAMILY_OPT_IN_ALLOWED)
  assert.deepEqual(experimental.filter((name) => !allowed.has(name)), [], '未登记的 experimental 名字')
  assert.deepEqual(FAMILY_OPT_IN_ALLOWED.filter((name) => !names.includes(name)), [], '已登记但不在闭包里的名字')
})

test('真实仓库：C13 播种注册表三面一致', () => {
  const { violations } = seedRegistryFindings({ seedSource: read('packages/control-plane/src/host-graph-seed.ts') })
  assert.deepEqual(violations, [], violations.join('; '))
})

// C14 —— plugin-row 单源（wire ./plugin-row 唯一声明；五消费方只引用不重声明）

/** 合成的健康单源文本：字段集与 role 并集都与 PLUGIN_ROW_SINGLE_SOURCE 预期一致。 */
const ROW_SINGLE_OK = [
  "export type PluginRowRole =",
  "  | 'composition'",
  "  | 'seed'",
  "  | 'layer'",
  "  | 'third-party'",
  "  | 'materialized'",
  "  | 'unknown'",
  '',
  'export interface PluginRow {',
  '  name: string',
  '  spec: string | null',
  '  version: string | null',
  '  role: PluginRowRole',
  '  protected: boolean',
  '}',
  '',
].join('\n')

/** 合成消费方：从指定引用面类型引用指定本地名（与 PLUGIN_ROW_CONSUMERS 的期待同形）。 */
const ROW_CONSUMERS_OK = {
  'control-plane': "import type { PluginRow, PluginRowRole } from '@dsh-chamber/dsh-chamber-wire/plugin-row'\nexport type { PluginRow, PluginRowRole }\n",
  'client-core-face': "export type { PluginRow, PluginRowRole } from '@dsh-chamber/dsh-chamber-wire/plugin-row'\n",
  preload: "import type { PluginRow as PluginRowProjection } from '@dsh-chamber/dsh-chamber-client-core/plugin-row'\nexport type { PluginRowProjection }\n",
  renderer: "import type { PluginRow as PluginRowProjection } from '@dsh-chamber/dsh-chamber-client-core/plugin-row'\nexport type { PluginRowProjection }\n",
  'settings-connections': "import type { PluginRow as PluginRowShape, PluginRowRole as PluginRowRoleShape } from '@dsh-chamber/dsh-chamber-client-core/plugin-row'\nexport type { PluginRowShape, PluginRowRoleShape }\n",
}

test('C14 plugin-row 正例：单源字段集 = 预期、消费方只引用不重声明 → 零违规', () => {
  const { violations, notes } = pluginRowSingleSourceFindings({ singleSource: ROW_SINGLE_OK, consumers: ROW_CONSUMERS_OK })
  assert.deepEqual(violations, [], violations.join('; '))
  assert.ok(notes.some((note) => note.includes('单源')), notes.join('; '))
})

test('C14 plugin-row 负控①本地重声明：任一消费方重新声明行形状/字段即红', () => {
  const redeclared = {
    ...ROW_CONSUMERS_OK,
    renderer: ROW_CONSUMERS_OK.renderer
      + "export interface PluginRowProjection {\n  name: string\n  spec: string | null\n  role: 'seed'\n}\n",
  }
  const { violations } = pluginRowSingleSourceFindings({ singleSource: ROW_SINGLE_OK, consumers: redeclared })
  assert.ok(violations.some((v) => v.includes('本地重声明')), violations.join('; '))
  // 本地 type 别名同样是字段集副本（export type X = { … } 不是引用面引用）。
  const aliased = {
    ...ROW_CONSUMERS_OK,
    'settings-connections': ROW_CONSUMERS_OK['settings-connections'] + 'export type PluginRowShape = { name: string }\n',
  }
  assert.ok(pluginRowSingleSourceFindings({ singleSource: ROW_SINGLE_OK, consumers: aliased })
    .violations.some((v) => v.includes('本地重声明')), 'a local type alias must be red too')
})

test('C14 plugin-row 负控②引用面漂移：specifier 改道 / 期待本地名缺失即红', () => {
  const wrongFace = {
    ...ROW_CONSUMERS_OK,
    preload: ROW_CONSUMERS_OK.preload.replace('@dsh-chamber/dsh-chamber-client-core/plugin-row', './plugin-row'),
  }
  const drifted = pluginRowSingleSourceFindings({ singleSource: ROW_SINGLE_OK, consumers: wrongFace })
  assert.ok(drifted.violations.some((v) => v.includes('引用面漂移')), drifted.violations.join('; '))
  // 面还在但本地别名消失（settings-connections 直接绑原名）：同样红。
  const missingName = {
    ...ROW_CONSUMERS_OK,
    'settings-connections': "import type { PluginRow } from '@dsh-chamber/dsh-chamber-client-core/plugin-row'\nexport type { PluginRow }\n",
  }
  assert.ok(pluginRowSingleSourceFindings({ singleSource: ROW_SINGLE_OK, consumers: missingName })
    .violations.some((v) => v.includes('未绑定本地名 PluginRowShape')), 'the renamed binding must be required')
})

test('C14 plugin-row 负控③单源字段缺失 / role 并集漂移：单源文件即红', () => {
  const lostField = pluginRowSingleSourceFindings({
    singleSource: ROW_SINGLE_OK.split('  protected: boolean\n').join(''),
    consumers: ROW_CONSUMERS_OK,
  })
  assert.ok(lostField.violations.some((v) => v.includes('protected')), lostField.violations.join('; '))
  const narrowed = pluginRowSingleSourceFindings({
    singleSource: ROW_SINGLE_OK.replace(" | 'unknown'", ''),
    consumers: ROW_CONSUMERS_OK,
  })
  assert.ok(narrowed.violations.some((v) => v.includes('PluginRowRole 并集')), narrowed.violations.join('; '))
  // 字段类型改成不透明命名类型：字段集签名漂移同样红。
  const opaque = pluginRowSingleSourceFindings({
    singleSource: ROW_SINGLE_OK.replace('role: PluginRowRole', 'role: OpaqueRole'),
    consumers: ROW_CONSUMERS_OK,
  })
  assert.ok(opaque.violations.some((v) => v.includes('字段集')), opaque.violations.join('; '))
  // 单源文件被搬走/改名：读不到即红，绝不静默跳过。
  const vanished = pluginRowSingleSourceFindings({ singleSource: '', consumers: ROW_CONSUMERS_OK })
  assert.ok(vanished.violations.some((v) => v.includes('找不到 interface PluginRow')), vanished.violations.join('; '))
})

test('真实仓库：C14 manifest 三方字段集 + plugin-row 单源（消费方只引用不重声明）', () => {
  const host = manifestMirrorFindings({
    producerSource: read('packages/desktop/plugin-sync.ts'),
    preloadSource: read('packages/desktop/preload.cts'),
    rendererSource: read('packages/renderer/src/global.d.ts'),
  })
  const consumers = {}
  for (const consumer of PLUGIN_ROW_CONSUMERS) consumers[consumer.side] = read(consumer.source)
  const row = pluginRowSingleSourceFindings({ singleSource: read(PLUGIN_ROW_SINGLE_SOURCE.path), consumers })
  assert.deepEqual(host.violations, [], host.violations.join('; '))
  assert.deepEqual(row.violations, [], row.violations.join('; '))
  assert.ok(host.notes.some((note) => note.includes('宿主字段集')), host.notes.join('; '))
  assert.ok(row.notes.some((note) => note.includes('单源')), row.notes.join('; '))
})

test('真实仓库：C12 在上游子模块物化时零违规（未物化则跳过）', () => {
  const profilePath = join(REPO_ROOT, 'vendor', 'harness-checkout', 'packages', 'boot', 'app-boot', 'src', 'profile.ts')
  const managerPath = join(REPO_ROOT, 'vendor', 'harness-checkout', 'packages', 'boot', 'plugin-manager', 'src', 'operations.ts')
  const pluginPath = join(REPO_ROOT, 'vendor', 'harness-checkout', 'apps', 'cli', 'src', 'plugin.ts')
  const { violations, notes } = profileContractFindings({
    profileSource: existsSync(profilePath) ? readFileSync(profilePath, 'utf8') : null,
    managerSource: existsSync(managerPath) ? readFileSync(managerPath, 'utf8') : null,
    pluginSource: existsSync(pluginPath) ? readFileSync(pluginPath, 'utf8') : null,
  })
  assert.deepEqual(violations, [], violations.join('; '))
  if (!existsSync(profilePath)) assert.ok(notes.some((note) => note.includes('未物化')))
})
