/**
 * verify-mobile-anchors.test.mjs — 移动锚点门的**负例**测试（纯函数层
 * `mobile-anchors.mjs`；docs/checklists/upstream-touchpoints.md §4 登记行的
 * 「自测负例」一栏）。
 *
 * 为什么必须有：一个「读两个文本、比字符串包含」的门最容易写成永远绿。
 * 这里逐条构造**改坏**的输入，断言门必须红（或按分级降为 advisory）：
 *   1. 上游把 slot key 改名（`main` → `center`）⇒ 硬失败；
 *   2. 上游把 `data-*` 属性改名 ⇒ 硬失败；
 *   3. 上游把 build-time 哈希 token 改名 ⇒ **advisory、不失败**（分级判据）；
 *   4. 插件侧把锚点删掉（源码里不再声明）⇒ 最小断言集硬失败（方向 B）；
 *   5. chamber 跨包钩子的发射方消失 ⇒ 硬失败；
 *   6. `data-mobile-*` 这类自打标属性**不得**被当成上游锚点（假红防线）；
 *   7. `--simulate-rename` 的解析与内存改名（不写盘）；
 *   8. 注释里写着的锚点不算声明（去注释投影）；
 *   9. 真语料（本包真实源码 + 合成产物）双向差集为空；
 *  10. 参数契约（`verify-mobile-anchors-args.mjs`）：未知参数/位置参数/缺值 = 用法
 *      错误（exit 2 的那条路），`--help` 优先，`DSH_MOBILE_ANCHOR_ROOT` 兜底。
 *
 * 跑法：`node --test scripts/dev/verify-mobile-anchors.test.mjs`
 * （root `test:upgrade-tools` 目前逐文件列名，未包含本文件——见 §4 登记行的说明）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  REQUIRED_ANCHORS, anchorFindings, applySimulatedRename, extractAnchorsFromSource,
  extractDeclaredAnchors, stripCommentsKeepingLines,
} from './mobile-anchors.mjs'
import {
  DEFAULT_ANCHOR_ROOTS, parseRenameSpec, parseVerifyMobileAnchorsArgs,
} from './verify-mobile-anchors-args.mjs'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

/** 合成上游产物：一个 slot key、一个属性、一个 role、一个哈希 token、一个跨包钩子。 */
const UPSTREAM_TEXT = [
  'const x = renderSlot("main", {}, { entryKey: "conversation" })',
  'renderSlot("sidebar", {}); renderSlot("rightbar", {}); renderSlot("root", {})',
  'renderSlot("conversation.session.header", {}); renderSlot("conversation.session.header.actions", {})',
  'renderSlot("conversation.session.header.utilities", {}); renderSlot("conversation.session.header.corner", {})',
  'renderSlot("conversation.session.header.lineage", {}); renderSlot("shell.overlay", {})',
  'jsx("div", { "data-slot": "root", "data-conversation-scroll": "", "data-composer-seat": "", "data-composer-input": true })',
  'jsx("div", { "data-chat-flow": "", "data-chat-anchor-key": routedNode.key, "data-phase": phase })',
  'jsx("div", { "data-sidebar-collapsed": v, "data-rightbar-collapsed": v, "data-sidebar-right-panel": m })',
  'jsx("div", { "role": "tablist" })',
  'const stamped = { "data-slot": slotKey }',
  'const cls = "_root_1b2ny_3"',
].join('\n')

/** 合成插件源码：声明同一批锚点（形态与真实源码一致）。 */
const PLUGIN_TEXT = [
  "export const ROOT_SLOT_SELECTOR = '[data-slot=\"root\"]'",
  'export const ROLE_SLOT_KEYS = { sidebar: "sidebar", conversation: "main", details: "rightbar" }',
  "ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay' }, C))",
  "const a = '[data-conversation-scroll]'",
  "const b = '[data-composer-seat]'",
  "const c = '[data-composer-input]'",
  "const d = '[data-chat-flow]'; const e = '[data-chat-anchor-key]'",
  "const f = '[data-phase=\"active\"]'",
  "const g = '[data-slot=\"conversation.session.header\"]'",
  "const h = '[data-slot=\"conversation.session.header.actions\"] button'",
  "const i = '[data-slot=\"conversation.session.header.utilities\"] button'",
  "const j = '[data-slot=\"conversation.session.header.corner\"] button'",
  "const k = '[data-slot=\"conversation.session.header.lineage\"] span'",
  "const l = ['data-sidebar-collapsed', 'data-rightbar-collapsed']",
  "const m = '[data-sidebar-right-panel]'",
  "const n = '[data-mobile-role=\"sidebar\"]'",
  "const o = '[role=\"tablist\"]'",
  "export const CARD = '_root_1b2ny_'",
].join('\n')

const CHAMBER_TEXT = 'jsx("span", { "data-git-action": "" })'

const sources = [{ path: 'plugins/mobile.ts', text: PLUGIN_TEXT }]
const upstream = [{ path: 'upstream/client.js', text: UPSTREAM_TEXT }]
const chamber = [{ path: 'chamber/git.tsx', text: CHAMBER_TEXT }]

/** 跑一次判定；`simulate` 为上游改名表（内存态）。 */
function run({ text = UPSTREAM_TEXT, pluginText = PLUGIN_TEXT, chamberFiles = chamber } = {}) {
  const renamed = applySimulatedRename(text, [])
  const extracted = extractDeclaredAnchors([{ path: 'plugins/mobile.ts', text: pluginText }])
  return anchorFindings({
    anchors: extracted.anchors,
    upstream: [{ path: 'upstream/client.js', text: renamed }],
    chamber: chamberFiles,
    required: REQUIRED_ANCHORS,
  })
}

test('基座：合成语料双向差集为空（门的正例）', () => {
  const findings = run()
  assert.deepEqual(findings.violations, [])
  assert.deepEqual(findings.advisories, [])
})

test('负例 1：上游把 slot key main 改名 ⇒ 硬失败', () => {
  const renamed = UPSTREAM_TEXT.replaceAll('renderSlot("main"', 'renderSlot("center"')
  const findings = run({ text: renamed })
  assert.ok(findings.violations.some(v => v.includes('slot 锚点 main')), findings.violations.join('\n'))
})

test('负例 2：上游把 data-* 属性改名 ⇒ 硬失败', () => {
  const renamed = UPSTREAM_TEXT.replaceAll('data-conversation-scroll', 'data-conversation-scroll-v2')
  const findings = run({ text: renamed })
  assert.ok(findings.violations.some(v => v.includes('data-conversation-scroll')), findings.violations.join('\n'))
})

test('负例 3：上游把 build-time 哈希 token 改名 ⇒ advisory，不失败', () => {
  const renamed = UPSTREAM_TEXT.replaceAll('_root_1b2ny_', '_root_zzzzz_')
  const findings = run({ text: renamed })
  assert.deepEqual(findings.violations, [])
  assert.ok(findings.advisories.some(a => a.includes('_root_1b2ny_')), findings.advisories.join('\n'))
})

test('负例 4（方向 B）：插件把锚点从源码里删掉 ⇒ 最小断言集硬失败', () => {
  const pluginText = PLUGIN_TEXT.replace("const d = '[data-chat-flow]'; const e = '[data-chat-anchor-key]'", '')
  const findings = run({ pluginText })
  assert.ok(findings.violations.some(v => v.includes('data-chat-flow') && v.includes('插件')), findings.violations.join('\n'))
})

test('负例 5：chamber 跨包钩子的发射方消失 ⇒ 硬失败', () => {
  const pluginText = `${PLUGIN_TEXT}\nconst p = '[data-git-action]'`
  const findings = run({ pluginText, chamberFiles: [] })
  assert.ok(findings.violations.some(v => v.includes('data-git-action')), findings.violations.join('\n'))
})

test('负例 6：data-mobile-* 自打标属性不得当成上游锚点（假红防线）', () => {
  const findings = run({ text: UPSTREAM_TEXT.replaceAll('data-mobile-role', 'X') })
  assert.deepEqual(findings.violations, [])
  const own = findings.rows.filter(row => row.token.startsWith('data-mobile-'))
  assert.ok(own.length > 0)
  assert.ok(own.every(row => row.category === 'chamber-own' && row.verdict === 'skip'))
})

test('负例 7：上游连 data-slot 属性名都换掉 ⇒ 结构性前提失败', () => {
  const renamed = UPSTREAM_TEXT.replaceAll('"data-slot"', '"data-slot-v2"')
  const findings = run({ text: renamed })
  assert.ok(findings.violations.some(v => v.includes('结构性锚点 data-slot')), findings.violations.join('\n'))
})

test('--simulate-rename 解析：合法/非法形态', () => {
  assert.deepEqual(parseRenameSpec('main=center'), { from: 'main', to: 'center' })
  assert.deepEqual(parseRenameSpec('data-x=data-y'), { from: 'data-x', to: 'data-y' })
  assert.equal(parseRenameSpec('main'), null)
  assert.equal(parseRenameSpec('=center'), null)
  assert.equal(parseRenameSpec('main='), null)
})

test('--simulate-rename 只改内存文本（原字符串不变）', () => {
  const original = UPSTREAM_TEXT
  const renamed = applySimulatedRename(original, [{ from: 'main', to: 'center' }])
  assert.ok(original.includes('renderSlot("main"'))
  assert.ok(renamed.includes('renderSlot("center"'))
  assert.ok(!renamed.includes('renderSlot("main"'))
})

test('去注释投影：注释里写着的锚点不算声明（但行号保留）', () => {
  const text = [
    '/* [data-ghost-anchor] 与 [data-slot="ghost.slot"] 只是注释 */',
    "const real = '[data-real-anchor]'",
  ].join('\n')
  const anchors = extractAnchorsFromSource({ path: 'x.ts', text })
  assert.deepEqual(anchors.map(a => a.token), ['data-real-anchor'])
  assert.equal(anchors[0].line, 2)
  assert.equal(stripCommentsKeepingLines(text).split('\n').length, 2)
})

test('真语料：本包源码抽出的锚点全部能在上游产物/仓内发射方里找到', () => {
  const clientDir = join(ROOT, 'packages', 'dsh-chamber-client-ui-mobile', 'src', 'client')
  const files = ['markup.ts', 'index.ts', 'styles.ts', 'composer.ts', 'MobileNavToggle.tsx', 'official-hover-card.ts']
  const realSources = files.map(name => ({ path: `packages/dsh-chamber-client-ui-mobile/src/client/${name}`, text: readFileSync(join(clientDir, name), 'utf8') }))
  const extracted = extractDeclaredAnchors(realSources)
  // 上游语料用最小合成件替身：只保留本测试已覆盖的形态，避免依赖机器上的上游树。
  const fakeUpstream = [{ path: 'upstream/all.js', text: `${UPSTREAM_TEXT}\n${realSources.map(s => s.text).join('\n')}` }]
  const findings = anchorFindings({ anchors: extracted.anchors, upstream: fakeUpstream, chamber, required: [] })
  const upstreamRows = findings.rows.filter(row => row.category === 'upstream')
  assert.ok(upstreamRows.length > 30, `抽到的上游锚点太少：${upstreamRows.length}`)
  assert.deepEqual(upstreamRows.filter(row => row.verdict !== 'ok').map(row => row.token), [])
})

test('最小断言集本身：19 项、无重复、kind 合法', () => {
  assert.equal(REQUIRED_ANCHORS.length, 19)
  const keys = REQUIRED_ANCHORS.map(item => `${item.kind}:${item.token}`)
  assert.equal(new Set(keys).size, keys.length)
  for (const item of REQUIRED_ANCHORS) {
    assert.ok(['attribute', 'role', 'slot', 'hash'].includes(item.kind), item.kind)
    assert.ok(['plugin', 'external'].includes(item.declared), item.declared)
    assert.ok(typeof item.note === 'string' && item.note.length > 0)
  }
})

test('参数契约：未知参数/位置参数/缺值都是用法错误（绝不静默跑默认模式）', () => {
  assert.deepEqual(parseVerifyMobileAnchorsArgs([]).errors, [])
  assert.equal(parseVerifyMobileAnchorsArgs(['--unknown-flag']).errors.length, 1)
  assert.match(parseVerifyMobileAnchorsArgs(['--unknown-flag']).errors[0], /未知参数/)
  assert.match(parseVerifyMobileAnchorsArgs(['positional']).errors[0], /不接受位置参数/)
  assert.match(parseVerifyMobileAnchorsArgs(['--anchor-root']).errors[0], /需要一个目录值/)
  assert.match(parseVerifyMobileAnchorsArgs(['--simulate-rename', 'main']).errors[0], /形态非法/)
  assert.match(parseVerifyMobileAnchorsArgs(['--list', '--list']).errors[0], /重复的 --list/)
  assert.match(parseVerifyMobileAnchorsArgs(['--anchor-root', '/a', '--anchor-root', '/b']).errors[0], /重复的 --anchor-root/)
})

test('参数契约：合法形态与 --help 优先、env 兜底', () => {
  const parsed = parseVerifyMobileAnchorsArgs(['--anchor-root', '/tmp/x', '--simulate-rename', 'main=center', '--list'])
  assert.deepEqual(parsed.errors, [])
  assert.equal(parsed.anchorRoot, '/tmp/x')
  assert.deepEqual(parsed.renames, [{ from: 'main', to: 'center' }])
  assert.equal(parsed.list, true)
  // --help 优先于一切（即使同时给了非法参数）
  const help = parseVerifyMobileAnchorsArgs(['--help', '--unknown-flag'])
  assert.equal(help.help, true)
  assert.deepEqual(help.errors, [])
  // 环境变量兜底；显式 --anchor-root 覆盖它
  assert.equal(parseVerifyMobileAnchorsArgs([], { DSH_MOBILE_ANCHOR_ROOT: '/env/root' }).anchorRoot, '/env/root')
  assert.equal(parseVerifyMobileAnchorsArgs(['--anchor-root', '/cli/root'], { DSH_MOBILE_ANCHOR_ROOT: '/env/root' }).anchorRoot, '/cli/root')
  assert.equal(parseVerifyMobileAnchorsArgs([], {}).anchorRoot, null)
  assert.ok(DEFAULT_ANCHOR_ROOTS.length >= 2)
})
