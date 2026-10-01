/**
 * verify-mobile-anchors.test.mjs — 移动锚点门的**负例**测试（纯函数层 `mobile-anchors.mjs`；
 * docs/checklists/upstream-touchpoints.md §4 登记行的「自测负例」一栏）。
 *
 * 这里逐条构造**改坏**的输入，断言门必须红（锚点零命中没有 advisory 档；仅「动态发射链缺失」
 * 与「语料缺 conversation 半」两类结构性提示走 advisory）：slot / data-* / role / hash /
 * local-name 各类锚点改名（含 `.foo_row` 裸后缀与 props 变量化的 SHAPE_RULE 形状）、最小断言集方向 B、
 * 无锚点根时本地判据仍须执行、chamber 跨包发射方消失、自打标假红防线、去注释投影、真语料
 * 双向差集、参数契约（未知参数/位置参数/缺值 = 用法错误 exit 2；`--help` 优先；
 * `DSH_MOBILE_ANCHOR_ROOT` 兜底）。
 *
 * 跑法：`node --test scripts/upstream/verify-mobile-anchors.test.mjs`（root `test:upgrade-tools`
 * 逐文件列名，本文件在其中——见 §4 登记行。）
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  REQUIRED_ANCHORS, anchorFindings, applySimulatedRename, conversationHeaderShapeFindings,
  extractAnchorsFromSource, extractDeclaredAnchors, forbiddenPatternFindings,
  localNameEvidence, requiredDeclarationFindings, stripCommentsKeepingLines,
} from './mobile-anchors.mjs'
import {
  DEFAULT_ANCHOR_ROOTS, defaultAnchorRoots, parseVerifyMobileAnchorsArgs,
} from './verify-mobile-anchors-args.mjs'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

/** 合成上游产物：覆盖全部上游锚点形态；语料**不得**混入插件源码——那会让每条锚点用自己的声明文本自证。 */
const UPSTREAM_TEXT = [
  'const x = renderSlot("main", {}, { entryKey: "conversation" })',
  'renderSlot("sidebar", {}); renderSlot("rightbar", {}); renderSlot("root", {})',
  'renderSlot("conversation.session.header", {}); renderSlot("conversation.session.header.actions", {})',
  'renderSlot("conversation.session.header.utilities", {}); renderSlot("conversation.session.header.corner", {})',
  'renderSlot("conversation.session.header.lineage", {}); renderSlot("shell.overlay", {})',
  'renderSlot("conversation.composer.bar", {}); renderSlot("conversation.input.model", {}); renderSlot("conversation.header", {})',
  'renderSlot("settings.section", {}); renderSlot("settings.header", {}); renderSlot("settings.action", {}); renderSlot("settings.close", {})',
  'jsx("div", { "data-slot": "root", "data-conversation-scroll": "", "data-composer-seat": "", "data-composer-input": true })',
  'jsx("div", { "data-chat-flow": "", "data-chat-anchor-key": routedNode.key, "data-phase": phase })',
  'jsx("div", { "data-sidebar-collapsed": v, "data-rightbar-collapsed": v, "data-sidebar-right-panel": m })',
  'jsx("div", { "data-sidebar-right-mode": m, "data-rightbar-fullscreen": f, "data-conversation-header-corner": "" })',
  'jsx("div", { "data-dockkit-strip": "", "data-dockkit-divider": "" })',
  'jsx("button", { "data-dockkit-tab-close": "", "data-trigger-menu": "", "data-input-scroll": true })',
  'jsx("div", { "data-width-handle": "", "data-side": side, "data-ds-dark-theme": "" })',
  'jsx("button", { "data-tip": t("view") })',
  'jsx("div", { "role": "tablist" }); jsx("button", { "role": "tab" })',
  'jsx("div", { "role": "dialog" }); jsx("div", { "role": "tooltip", "data-portal": true, "data-side": side })',
  'const toBottomCls = "EvIC1a_toBottomSlot"',
  // external 锚：插件用结构性 nav > span 吃面包屑条，类名由上游发（含哈希）。
  'const crumbCls = "wSkVaW_crumbSeg"',
  '.wSkVaW_crumbSeg{align-items:center}',
  'jsx("div", { "role": "menu" }); jsx("div", { "role": "menuitem" }); jsx("div", { "role": "listbox" }); jsx("div", { "role": "option" })',
  'const stamped = { "data-slot": slotKey }',
  'const cls = "_root_38jqx_3"',
  'const cls2 = "_card_38jqx_9"',
  // CSS-module 类名字典的两种生产形态（local-name 判据的发射形）
  '._row_1alm6_55 { flex-wrap: nowrap }',
  'const modelCls = "zGbnIq_modelRow"',
].join('\n')

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
  'const p = \'[class$="_row"]\'; const q = \'[class*="_modelRow "]\'',
  "const r = '[data-slot=\"conversation.header\"]'",
  'const s = \'[role="tooltip"][data-portal][data-side]\'',
  'const t = \'[class$="_toBottomSlot"]\'',
  "export const CARD = '_root_38jqx_'",
  "export const CARD_BODY = '_card_38jqx_'",
].join('\n')

const CHAMBER_TEXT = 'jsx("span", { "data-git-action": "" })'

/** 合成 dsh-client-ui-conversation 产物：SHAPE_RULES 的正例形状（header 的 children 内含会话头槽）。 */
const CONVERSATION_TEXT = [
  'return (0, react_jsx_runtime.jsxs)("header", {',
  '  className: x,',
  '  children: [(0, react_jsx_runtime.jsx)("div", { children: renderSlot("conversation.header.leading", {}) }),',
  '    renderSlot("conversation.session.header", { hideChrome: blank })]',
  '});',
  'children: [renderSlot("conversation.header", {}), renderSlot("conversation.content", {})]',
].join('\n')

const sources = [{ path: 'plugins/mobile.ts', text: PLUGIN_TEXT }]
const upstream = [
  { path: 'upstream/client.js', text: UPSTREAM_TEXT },
  { path: 'upstream/dsh-client-ui-conversation/lib/client.js', text: CONVERSATION_TEXT },
]
const chamber = [{ path: 'chamber/git.tsx', text: CHAMBER_TEXT }]
function run({ text = UPSTREAM_TEXT, pluginText = PLUGIN_TEXT, chamberFiles = chamber } = {}) {
  const renamed = applySimulatedRename(text, [])
  const extracted = extractDeclaredAnchors([{ path: 'plugins/mobile.ts', text: pluginText }])
  return anchorFindings({
    anchors: extracted.anchors,
    upstream: [
      { path: 'upstream/client.js', text: renamed },
      { path: 'upstream/dsh-client-ui-conversation/lib/client.js', text: CONVERSATION_TEXT },
    ],
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

test('负例 3：上游把 build-time 哈希 token 改名 ⇒ 硬失败（pin bump 必须重锚）', () => {
  const renamed = UPSTREAM_TEXT.replaceAll('_root_38jqx_', '_root_zzzzz_')
  const findings = run({ text: renamed })
  assert.ok(findings.violations.some(v => v.includes('_root_38jqx_')), findings.violations.join('\n'))
  assert.ok(findings.advisories.every(a => !a.includes('_root_38jqx_')),
    'hash 零命中不得再降为 advisory: ' + findings.advisories.join('\n'))
})

test('负例 3b（方向 B）：插件把哈希 token 从源码里删掉 ⇒ 最小断言集硬失败', () => {
  const pluginText = PLUGIN_TEXT.replace("export const CARD = '_root_38jqx_'", '')
  const findings = run({ pluginText })
  assert.ok(findings.violations.some(v => v.includes('_root_38jqx_') && v.includes('插件')),
    findings.violations.join('\n'))
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

test('真语料：本包源码抽出的每一条上游锚点，都能被「只含合成发射形态」的语料证明', () => {
  // 语料只由合成发射件（UPSTREAM_TEXT）与仓内跨包发射方组成，插件源码只用于**抽锚点**、绝不参与证据
  // （否则每条锚点都在自己的声明文本里自证，上游删掉发射点也照样绿）。
  // The file list is DISCOVERED, not hardcoded: a hardcoded list stops covering the package once a source file is added.
  const sourcesDir = join(ROOT, 'packages', 'dsh-chamber-client-ui-mobile', 'src')
  const discovered = readdirSync(sourcesDir, { recursive: true, encoding: 'utf8' })
    .filter(name => name.endsWith('.ts') || name.endsWith('.tsx'))
    .sort()
  assert.ok(discovered.length >= 10, `expected the package sources to be discovered, got ${discovered.length}`)
  const realSources = discovered.map(name => ({
    path: `packages/dsh-chamber-client-ui-mobile/src/${name.split(sep).join('/')}`,
    text: readFileSync(join(sourcesDir, name), 'utf8'),
  }))
  const extracted = extractDeclaredAnchors(realSources)
  const syntheticUpstream = [{ path: 'upstream/all.js', text: UPSTREAM_TEXT }]
  const findings = anchorFindings({ anchors: extracted.anchors, upstream: syntheticUpstream, chamber, required: REQUIRED_ANCHORS })
  const upstreamRows = findings.rows.filter(row => row.category === 'upstream')
  assert.ok(upstreamRows.length > 30, `抽到的上游锚点太少：${upstreamRows.length}`)
  // 任何一条上游锚点不命中合成语料，即说明抽取器抽出了语料未覆盖的形态——补语料或修抽取器，不允许放宽判定。
  assert.deepEqual(upstreamRows.filter(row => row.verdict !== 'ok').map(row => row.token), [])
  // 方向 B 也必须在同一份合成语料上成立（不得用 required: [] 把这一半关掉）。
  assert.deepEqual(findings.violations, [])
})

test('防伪：只有写入形算发射；注释/数组/文案/选择器/attr() 都不算', () => {
  const anchors = [
    { kind: 'attribute', token: 'data-chat-flow', path: 'x.ts', line: 1 },
    { kind: 'attribute', token: 'data-chat-anchor-key', path: 'x.ts', line: 1 },
    { kind: 'attribute', token: 'data-phase', path: 'x.ts', line: 1 },
    { kind: 'attribute', token: 'data-sidebar-right-panel', path: 'x.ts', line: 1 },
  ]
  const verdicts = text => anchorFindings({
    anchors, upstream: [{ path: 'upstream/all.js', text }], chamber: [], required: [],
  }).rows.map(row => row.verdict)
  // 消费形（CSS 规则 / 选择器 / attr()）与裸提及都不证明上游还在**写**这个属性：若把
  // `[data-x]` 选择器也算证据，「上游删掉写入点、只留死 CSS」的漂移照样绿（data-ds-dark-theme 即此形）。
  const decoys = [
    '// upstream still emits "data-chat-flow" somewhere',
    '// historically: jsx("div", { "data-chat-flow": "" })',
    '/* [data-chat-anchor-key] was removed upstream */',
    'const legacy = ["data-chat-flow", "data-chat-anchor-key"]',
    'throw new Error("[data-phase] is gone")',
    'throw new Error("expected data-phase=active")',
    'document.querySelector("[data-chat-flow]")',
    'body[data-chat-flow]{display:flex}',
    'css(":after{content:attr(data-sidebar-right-panel)}")',
  ].join('\n')
  assert.deepEqual(verdicts(decoys), ['missing', 'missing', 'missing', 'missing'],
    'mentions and consumers are not emissions')
  // 失败文案要说清「只有消费方证据」，别让人以为上游完全没提过它。
  const messages = anchorFindings({
    anchors: [anchors[0]], upstream: [{ path: 'upstream/all.js', text: 'body[data-chat-flow]{display:flex}' }],
    chamber: [], required: [],
  }).violations
  assert.equal(messages.filter(message => message.includes('消费方')).length, 1, messages.join(' | '))
  // 写入形才是证据：对象键（编译后的 JSX）、setAttribute/toggleAttribute。
  const real = anchorFindings({
    anchors,
    upstream: [{
      path: 'upstream/all.js',
      text: [
        'jsx("div", { "data-chat-flow": "", "data-chat-anchor-key": key })',
        'node.setAttribute("data-phase", phase)',
        "document.body.toggleAttribute('data-sidebar-right-panel', true)",
      ].join('\n'),
    }],
    chamber: [],
    required: [],
  })
  assert.deepEqual(real.rows.map(row => row.verdict), ['ok', 'ok', 'ok', 'ok'])
  // 打包产物里 `data-x=` 只可能是文案/字符串（JS 标识符不能带 `-`），故只对 .ts/.tsx 源码语料开启。
  const jsxSource = anchorFindings({
    anchors: [{ kind: 'attribute', token: 'data-phase', path: 'x.ts', line: 1 }],
    upstream: [{ path: 'packages/example/src/X.tsx', text: '<div data-phase={phase} />' }],
    chamber: [], required: [],
  })
  assert.deepEqual(jsxSource.rows.map(row => row.verdict), ['ok'])
  const bundledString = anchorFindings({
    anchors: [{ kind: 'attribute', token: 'data-phase', path: 'x.ts', line: 1 }],
    upstream: [{ path: 'upstream/all.js', text: 'console.warn("expected data-phase=active")' }],
    chamber: [], required: [],
  })
  assert.deepEqual(bundledString.rows.map(row => row.verdict), ['missing'],
    'a bundled JS string is not a JSX attribute')
  // 跨包锚点（data-git-action）查的是仓内发射方：同样的 TSX 属性写法在那里是证据。
  const crossPackage = anchorFindings({
    anchors: [{ kind: 'attribute', token: 'data-git-action', path: 'x.tsx', line: 1 }],
    upstream: [],
    chamber: [{ path: 'packages/dsh-chamber-client-ui-git/src/client/X.tsx', text: '<button data-git-action="stage" />' }],
    required: [],
  })
  assert.deepEqual(crossPackage.rows.map(row => row.verdict), ['ok'])
})

test('防伪：role 的「文案」不算发射，只有对象键/选择器形才算', () => {
  // 与属性锚点同一类假绿：`console.warn('role: "dialog" is gone')` 这类**文案**若被当成发射，已被
  // 改名的 role 会继续绿；真实发射形（编译后 JSX 属性表）值后必是 `,`/`}` 收尾，故冒号形加收尾要求。
  const decoy = anchorFindings({
    anchors: [{ kind: 'role', token: 'dialog', path: 'x.ts', line: 1 }],
    upstream: [{ path: 'upstream/all.js', text: `console.warn('role: "dialog" is gone')` }],
    chamber: [],
    required: [],
  })
  assert.deepEqual(decoy.rows.map(row => row.verdict), ['missing'], 'a message is not an emission')
  for (const text of [
    'jsx("div", { role: "dialog", "aria-modal": true })',
    'jsx("div", { "role" : "dialog" })',
    'node.setAttribute("role", "dialog")',
  ]) {
    const real = anchorFindings({
      anchors: [{ kind: 'role', token: 'dialog', path: 'x.ts', line: 1 }],
      upstream: [{ path: 'upstream/all.js', text }],
      chamber: [],
      required: [],
    })
    assert.deepEqual(real.rows.map(row => row.verdict), ['ok'], text)
  }
  // 消费形（CSS 选择器）单独存在时不算发射——与属性锚点同一条规则。
  const selectorOnly = anchorFindings({
    anchors: [{ kind: 'role', token: 'dialog', path: 'x.ts', line: 1 }],
    upstream: [{ path: 'upstream/all.js', text: 'css("[role=\"dialog\"]{position:fixed}")' }],
    chamber: [],
    required: [],
  })
  assert.deepEqual(selectorOnly.rows.map(row => row.verdict), ['missing'])
})

test('防伪：slot 也只有写入形算发射（注册 API / 选择器不算）', () => {
  // slot 锚点只认写入形：把 slots.inject 或选择器当发射，会让「上游删掉 renderSlot」在 16 个 slot 锚点（含最小断言集一半）上照样绿。
  const anchors = [{ kind: 'slot', token: 'main', path: 'x.ts', line: 1 }]
  const verdict = text => anchorFindings({ anchors, upstream: [{ path: 'upstream/all.js', text }], chamber: [], required: [] })
  for (const text of [
    'slots.inject("main", () => {})',
    'registry.subscribe("main")',
    'css("[data-slot=\\"main\\"]{display:flex}")',
    'document.querySelector("[data-slot=\\"main\\"]")',
  ]) {
    const findings = verdict(text)
    assert.deepEqual(findings.rows.map(row => row.verdict), ['missing'], text)
    assert.match(findings.violations.join(' '), /消费方/, text)
  }
  for (const text of [
    'renderSlot("main", {}, { entryKey: "conversation" })',
    'jsx("div", { "data-slot": "main" })',
    'node.setAttribute("data-slot", "main")',
  ]) {
    assert.deepEqual(verdict(text).rows.map(row => row.verdict), ['ok'], text)
  }
  // 结构性前提（data-slot 属性名本身）同样只认写入形：只有选择器时必须红。
  const structuralOnlySelectors = anchorFindings({
    anchors: [],
    upstream: [{ path: 'upstream/all.js', text: 'body[data-slot]{display:contents}' }],
    chamber: [], required: [],
  })
  assert.equal(structuralOnlySelectors.violations.filter(v => v.includes('结构性锚点')).length, 1)
})

test('data-tip 是上游锚点（不是本插件自打标）：上游零命中时必须硬失败', () => {
  const findings = anchorFindings({
    anchors: [{ kind: 'attribute', token: 'data-tip', path: 'x.ts', line: 1 }],
    upstream: [{ path: 'upstream/all.js', text: 'jsx("div", { "data-tip": t("view") })' }],
    chamber: [],
    required: [],
  })
  assert.deepEqual(findings.rows.map(row => row.category), ['upstream'])
  const gone = anchorFindings({
    anchors: [{ kind: 'attribute', token: 'data-tip', path: 'x.ts', line: 1 }],
    upstream: [{ path: 'upstream/all.js', text: 'jsx("div", {})' }],
    chamber: [],
    required: [],
  })
  assert.equal(gone.violations.filter(violation => violation.includes('data-tip')).length, 1,
    'an upstream rename of data-tip is now a hard failure')
})

test('严格模式的「其实什么都没查」路径：源码缺失 ⇒ exit 1（默认仍 fail-soft）', () => {
  // `--require-anchor-root` 承诺区分「正常跳过」与「其实什么都没查」，但源码抽不到那条跳过路径仍 exit 0；退出码只能端到端测。
  const root = mkdtempSync(join(tmpdir(), 'anchors-strict-'))
  try {
    mkdirSync(join(root, 'scripts', 'upstream'), { recursive: true })
    for (const name of ['verify-mobile-anchors.mjs', 'verify-mobile-anchors-args.mjs', 'mobile-anchors.mjs']) {
      copyFileSync(join(ROOT, 'scripts', 'upstream', name), join(root, 'scripts', 'upstream', name))
    }
    const run = args => spawnSync(process.execPath, ['scripts/upstream/verify-mobile-anchors.mjs', ...args], { cwd: root, encoding: 'utf8' })
    const strict = run(['--require-anchor-root'])
    assert.equal(strict.status, 1, `strict must not exit 0 with no sources: ${strict.stdout}`)
    assert.match(strict.stderr, /没有可抽的插件源码/)
    const fallback = run([])
    assert.equal(fallback.status, 0, 'the default stays fail-soft (CI has no upstream tree)')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('严格模式的 pin 身份：读不到 lockfile ⇒ 明说「无法判定」并 exit 1', () => {
  const root = mkdtempSync(join(tmpdir(), 'anchors-pin-'))
  try {
    mkdirSync(join(root, 'scripts', 'upstream'), { recursive: true })
    for (const name of ['verify-mobile-anchors.mjs', 'verify-mobile-anchors-args.mjs', 'mobile-anchors.mjs']) {
      copyFileSync(join(ROOT, 'scripts', 'upstream', name), join(root, 'scripts', 'upstream', name))
    }
    // Sources present (so the run gets past that gate) but no in-repo lockfile.
    cpSync(join(ROOT, 'packages', 'dsh-chamber-client-ui-mobile', 'src'), join(root, 'packages', 'dsh-chamber-client-ui-mobile', 'src'), { recursive: true })
    // A fake anchor tree whose corpus SATISFIES every declared anchor (the same synthetic emissions
    // the corpus test uses), so otherwise the run exits 0 — making the pin the only thing that can fail it.
    const anchor = join(root, 'anchor')
    mkdirSync(join(anchor, 'node_modules', '@deepseek-ai', 'fake', 'lib'), { recursive: true })
    writeFileSync(join(anchor, 'node_modules', '@deepseek-ai', 'fake', 'lib', 'client.js'), UPSTREAM_TEXT)
    // The corpus must look COMPLETE, or the newer strict corpus check fires first and this test passes for the wrong reason.
    const frontend = join(anchor, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'assets')
    mkdirSync(frontend, { recursive: true })
    writeFileSync(join(frontend, 'index-ABCDEFGH.js'), UPSTREAM_TEXT)
    writeFileSync(join(frontend, 'index-ABCDEFGH.css'), 'body[data-slot]{display:contents}')
    const run = args => spawnSync(process.execPath, ['scripts/upstream/verify-mobile-anchors.mjs', ...args], { cwd: root, encoding: 'utf8' })
    const fallback = run(['--anchor-root', anchor])
    assert.equal(fallback.status, 0, `the anchors themselves must pass on this corpus: ${fallback.stdout}${fallback.stderr}`)
    assert.match(fallback.stdout, /pin 身份无法判定/, 'the default says so out loud, then keeps going')
    const strict = run(['--require-anchor-root', '--anchor-root', anchor])
    assert.equal(strict.status, 1, `strict must fail when the pin cannot be read: ${strict.stdout}`)
    assert.match(strict.stderr + strict.stdout, /pin 身份无法判定/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

function pinnedFrontendVersion() {
  const lockfile = readFileSync(join(ROOT, 'packages', 'desktop', 'vendor', 'dsh', 'pnpm-lock.yaml'), 'utf8')
  const match = lockfile.match(/@deepseek-ai\/dsh-web-frontend@([^'(:\s]+)/)
  assert.ok(match !== null, 'the committed lockfile must pin @deepseek-ai/dsh-web-frontend')
  return match[1]
}

/**
 * A temp root whose corpus SATISFIES every declared anchor, so only the property under test can fail
 * the run. `shell: false` leaves out the shell bundle/CSS; `frontendVersion` stamps the tree's identity.
 */
function makeStrictRoot(t, { frontendVersion, shell = false, symlink = false }) {
  const root = mkdtempSync(join(tmpdir(), 'anchors-strict-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'scripts', 'upstream'), { recursive: true })
  for (const name of ['verify-mobile-anchors.mjs', 'verify-mobile-anchors-args.mjs', 'mobile-anchors.mjs']) {
    copyFileSync(join(ROOT, 'scripts', 'upstream', name), join(root, 'scripts', 'upstream', name))
  }
  cpSync(join(ROOT, 'packages', 'dsh-chamber-client-ui-mobile', 'src'), join(root, 'packages', 'dsh-chamber-client-ui-mobile', 'src'), { recursive: true })
  mkdirSync(join(root, 'packages', 'desktop', 'vendor', 'dsh'), { recursive: true })
  copyFileSync(join(ROOT, 'packages', 'desktop', 'vendor', 'dsh', 'pnpm-lock.yaml'), join(root, 'packages', 'desktop', 'vendor', 'dsh', 'pnpm-lock.yaml'))
  const anchor = join(root, 'anchor')
  // symlink: packages live in an out-of-tree store and are reached through symlinks,
  // the pnpm isolated shape (node_modules/@deepseek-ai/<pkg> -> .pnpm/...).
  const store = symlink ? join(root, 'store') : null
  const scoped = join(anchor, 'node_modules', '@deepseek-ai')
  const frontend = symlink ? join(store, 'dsh-web-frontend') : join(scoped, 'dsh-web-frontend')
  mkdirSync(join(frontend, 'dist', 'assets'), { recursive: true })
  writeFileSync(join(frontend, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-web-frontend', version: frontendVersion }))
  if (shell) {
    writeFileSync(join(frontend, 'dist', 'assets', 'index-ABCDEFGH.js'), UPSTREAM_TEXT)
    writeFileSync(join(frontend, 'dist', 'assets', 'index-ABCDEFGH.css'), 'body[data-slot]{display:contents}')
  }
  const fake = symlink ? join(store, 'fake') : join(scoped, 'fake')
  mkdirSync(join(fake, 'lib'), { recursive: true })
  writeFileSync(join(fake, 'lib', 'client.js'), UPSTREAM_TEXT)
  if (symlink) {
    mkdirSync(scoped, { recursive: true })
    symlinkSync(frontend, join(scoped, 'dsh-web-frontend'), 'dir')
    symlinkSync(fake, join(scoped, 'fake'), 'dir')
    // A cycle through a symlinked directory must terminate (ancestor realpath check).
    symlinkSync(store, join(fake, 'loop'), 'dir')
  }
  return { root, anchor }
}

test('严格模式的语料完整性：只有 client 半、没有 shell 产物 ⇒ exit 1', () => {
  const t = { after: () => {} }
  const { root, anchor } = makeStrictRoot(t, { frontendVersion: pinnedFrontendVersion(), shell: false })
  const run = args => spawnSync(process.execPath, ['scripts/upstream/verify-mobile-anchors.mjs', ...args], { cwd: root, encoding: 'utf8' })
  try {
    const fallback = run(['--anchor-root', anchor])
    assert.equal(fallback.status, 0, `default stays fail-soft: ${fallback.stdout}${fallback.stderr}`)
    const strict = run(['--require-anchor-root', '--anchor-root', anchor])
    assert.equal(strict.status, 1, `strict must fail on a client-halves-only corpus: ${strict.stdout}`)
    assert.match(strict.stdout + strict.stderr, /语料不完整/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('严格模式的 pin 一致性：树版本与仓内 pin 不符 ⇒ exit 1', () => {
  const t = { after: () => {} }
  const { root, anchor } = makeStrictRoot(t, { frontendVersion: '0.0.0-not-the-pin', shell: true })
  const run = args => spawnSync(process.execPath, ['scripts/upstream/verify-mobile-anchors.mjs', ...args], { cwd: root, encoding: 'utf8' })
  try {
    const strict = run(['--require-anchor-root', '--anchor-root', anchor])
    assert.equal(strict.status, 1, `strict must fail on a version mismatch: ${strict.stdout}`)
    assert.match(strict.stdout + strict.stderr, /与 pin 不符/)
    // ...and the matching version passes, so the failure above is the version and not something else in this root.
    const ok = makeStrictRoot({ after: () => {} }, { frontendVersion: pinnedFrontendVersion(), shell: true })
    try {
      const green = run(['--require-anchor-root', '--anchor-root', ok.anchor])
      assert.equal(green.status, 0, `a matching tree must pass: ${green.stdout}${green.stderr}`)
    } finally {
      rmSync(ok.root, { recursive: true, force: true })
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('最小断言集本身：无重复、kind 合法，且与 §4 登记行逐项对得上', () => {
  // 26 项声明侧最小集 + external 锚（只查上游发射侧）。§4 登记行记录的是声明侧
  // 最小集（「26 项必须既在源码侧声明、又在产物侧发射」），external 项没有声明侧
  // 契约，故不要求该行点名——但必须真的存在，否则「上游在用、插件尚未点名」的
  // 锚点就没有任何门在管。
  const pluginItems = REQUIRED_ANCHORS.filter(item => item.declared === 'plugin')
  const externalItems = REQUIRED_ANCHORS.filter(item => item.declared === 'external')
  assert.equal(pluginItems.length, 26)
  assert.ok(externalItems.length >= 1, 'external 锚至少要有一条（_crumbSeg）')
  assert.equal(REQUIRED_ANCHORS.length, pluginItems.length + externalItems.length)
  const keys = REQUIRED_ANCHORS.map(item => `${item.kind}:${item.token}`)
  assert.equal(new Set(keys).size, keys.length)
  for (const item of REQUIRED_ANCHORS) {
    assert.ok(['attribute', 'role', 'slot', 'hash', 'local-name'].includes(item.kind), item.kind)
    assert.ok(['plugin', 'external'].includes(item.declared), item.declared)
    assert.ok(typeof item.note === 'string' && item.note.length > 0)
  }
  // Doc lockstep: a count alone just restates a constant — the registry row is the
  // human half of this gate, so every required token must still be named there.
  const registry = readFileSync(join(ROOT, 'docs/checklists/upstream-touchpoints.md'), 'utf8')
  // Pick the LONGEST line that names the gate: a positional `find` would silently
  // retarget to any earlier passing mention (§7 names it too) and then assert
  // against the wrong text.
  const candidates = registry.split('\n').filter(line => line.includes('verify-mobile-anchors.mjs'))
  const row = [...candidates].sort((a, b) => b.length - a.length)[0] ?? ''
  assert.ok(row.length > 200, 'the §4 registry row for the mobile anchor gate must exist')
  assert.ok(candidates.length >= 2, 'both the §4 row and the §7 procedure name the gate')
  for (const item of pluginItems) {
    // Slot anchors may be named compactly in the row ("conversation.session.header 及其 actions/utilities/corner/lineage 四座"), so the tail segment counts.
    const named = row.includes(item.token) || (item.kind === 'slot' && row.includes(item.token.split('.').pop() ?? ''))
    assert.ok(named, `the §4 row must name the required anchor ${item.kind}:${item.token}`)
  }
})

test('FORBIDDEN_PATTERNS：禁用形态在去注释投影里命中即硬失败，注释里的提及不算', () => {
  const header = forbiddenPatternFindings([{ path: 'plugins/x.ts', text: "ctx.slots.inject('[data-slot=\"conversation.session.header\"] > header')" }])
  assert.equal(header.violations.length, 1)
  assert.match(header.violations[0], /plugins\/x\.ts:1/)
  const nav = forbiddenPatternFindings([{ path: "plugins/x.ts", text: "const css = 'nav > span > button:disabled { color: red }'" }])
  assert.equal(nav.violations.length, 1)
  const commented = forbiddenPatternFindings([{ path: 'plugins/x.ts', text: '/* [data-slot="conversation.session.header"] > header */\nconst a = 1' }])
  assert.deepEqual(commented.violations, [])
})

test('FORBIDDEN_PATTERNS 走门：插件源码里的禁用形态让门 exit 1', () => {
  const { root, anchor } = makeStrictRoot({ after: () => {} }, { frontendVersion: pinnedFrontendVersion(), shell: true })
  appendFileSync(join(root, 'packages', 'dsh-chamber-client-ui-mobile', 'src', 'client', 'session-stall.ts'), '\nexport const BAD_ANCHOR = \'[data-slot="conversation.session.header"] > header\'\n')
  const run = args => spawnSync(process.execPath, ['scripts/upstream/verify-mobile-anchors.mjs', ...args], { cwd: root, encoding: 'utf8' })
  try {
    const strict = run(['--require-anchor-root', '--anchor-root', anchor])
    assert.equal(strict.status, 1, strict.stdout + strict.stderr)
    assert.match(strict.stdout + strict.stderr, /禁用锚点形态/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/**
 * 一个**没有锚点树**的临时仓根：门的三份脚本 + 真实移动包源码，但没有
 * `node_modules/@deepseek-ai`。用于钉「无根时本地判据仍必须跑」。
 * `mutateSources` 在真实源码副本上注入改坏形态（实验不碰工作树）。
 */
function makeRootlessRoot(t, { mutateSources } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'anchors-rootless-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'scripts', 'upstream'), { recursive: true })
  for (const name of ['verify-mobile-anchors.mjs', 'verify-mobile-anchors-args.mjs', 'mobile-anchors.mjs']) {
    copyFileSync(join(ROOT, 'scripts', 'upstream', name), join(root, 'scripts', 'upstream', name))
  }
  const src = join(root, 'packages', 'dsh-chamber-client-ui-mobile', 'src')
  cpSync(join(ROOT, 'packages', 'dsh-chamber-client-ui-mobile', 'src'), src, { recursive: true })
  if (mutateSources !== undefined) mutateSources(src)
  return root
}

test('无锚点根：本地判据（禁用形态 / 声明侧完整性）不得被一起跳过', t => {
  const run = (root, args) => spawnSync(process.execPath, ['scripts/upstream/verify-mobile-anchors.mjs', ...args], { cwd: root, encoding: 'utf8' })
  const missingRoot = root => join(root, 'no-such-anchor-tree')

  // 1) 干净源 + 不存在的锚点根：exit 0，但要明确说清哪些**上游侧**没执行。
  const clean = makeRootlessRoot(t)
  const green = run(clean, ['--anchor-root', missingRoot(clean)])
  assert.equal(green.status, 0, green.stdout + green.stderr)
  assert.match(green.stdout, /上游发射侧/)
  for (const phrase of ['方向 A', 'SHAPE_RULES', 'pin 身份', '禁用锚点形态扫描']) {
    assert.match(green.stdout, new RegExp(phrase), 'the no-root report must name what did (not) run: ' + green.stdout)
  }

  // 2) 注入禁用形态：没有锚点树也必须 exit 1（旧行为：根缺失直接 exit 0）。
  const dirty = makeRootlessRoot(t, { mutateSources: src => appendFileSync(
    join(src, 'client', 'session-stall.ts'),
    "\nexport const BAD_ANCHOR = '[data-slot=\"conversation.session.header\"] > header'\n",
  ) })
  const red = run(dirty, ['--anchor-root', missingRoot(dirty)])
  assert.equal(red.status, 1, red.stdout + red.stderr)
  assert.match(red.stderr, /禁用锚点形态/)

  // 3) 插件把最小断言集的锚点改名（声明侧缺口）：没有锚点树也必须 exit 1。
  const renamed = makeRootlessRoot(t, { mutateSources: src => {
    const file = join(src, 'client', 'session-stall.ts')
    writeFileSync(file, readFileSync(file, 'utf8').replace("'[data-chat-flow]'", "'[data-chat-flow-x]'"))
  } })
  const declared = run(renamed, ['--anchor-root', missingRoot(renamed)])
  assert.equal(declared.status, 1, declared.stdout + declared.stderr)
  assert.match(declared.stderr, /data-chat-flow/)
  assert.match(declared.stderr, /最小断言集/)

  // 4) 严格模式的约定不变：根缺失仍然 exit 1（且本地判据的结论一样先打印）。
  const strict = run(clean, ['--require-anchor-root', '--anchor-root', missingRoot(clean)])
  assert.equal(strict.status, 1, strict.stdout + strict.stderr)
  assert.match(strict.stderr, /找不到可用锚点根/)

  // 5) 根存在但没有任何 client 产物（不完整的树）也是同一条「只跳过上游发射侧」。
  const incomplete = makeRootlessRoot(t, { mutateSources: src => appendFileSync(
    join(src, 'client', 'session-stall.ts'),
    "\nexport const BAD_ANCHOR = '[data-slot=\"conversation.session.header\"] > header'\n",
  ) })
  mkdirSync(join(incomplete, 'anchor', 'node_modules', '@deepseek-ai', 'empty', 'lib'), { recursive: true })
  const partial = run(incomplete, ['--anchor-root', join(incomplete, 'anchor')])
  assert.equal(partial.status, 1, partial.stdout + partial.stderr)
  assert.match(partial.stderr, /禁用锚点形态/)
  const partialClean = makeRootlessRoot(t)
  mkdirSync(join(partialClean, 'anchor', 'node_modules', '@deepseek-ai', 'empty', 'lib'), { recursive: true })
  const partialGreen = run(partialClean, ['--anchor-root', join(partialClean, 'anchor')])
  assert.equal(partialGreen.status, 0, partialGreen.stdout + partialGreen.stderr)
  assert.match(partialGreen.stdout, /上游发射侧判据本次未执行/)
})

test('SHAPE_RULES：header 形状改名 / 槽移出 / 持久槽删除都必须红', () => {
  const base = [{ path: 'up/dsh-client-ui-conversation/lib/client.js', text: CONVERSATION_TEXT }]
  assert.deepEqual(conversationHeaderShapeFindings(base).violations, [])
  const renamed = conversationHeaderShapeFindings([{ path: 'up/dsh-client-ui-conversation/lib/client.js', text: CONVERSATION_TEXT.split('jsxs)("header"').join('jsxs)("div"') }])
  assert.ok(renamed.violations.some(v => v.includes('SHAPE_RULE 1')), renamed.violations.join(' '))
  const moved = conversationHeaderShapeFindings([{ path: 'up/dsh-client-ui-conversation/lib/client.js', text: 'function C(){ return (0, react_jsx_runtime.jsxs)("header", { children: [(0, react_jsx_runtime.jsx)("div", {})] }); }\nrenderSlot("conversation.session.header", {})' }])
  assert.ok(moved.violations.some(v => v.includes('SHAPE_RULE 1')), moved.violations.join(' '))
  const noBase = conversationHeaderShapeFindings([{ path: 'up/dsh-client-ui-conversation/lib/client.js', text: CONVERSATION_TEXT.replace('renderSlot("conversation.header",', 'renderSlot("conversation.header.leading",') }])
  assert.ok(noBase.violations.some(v => v.includes('SHAPE_RULE 2')), noBase.violations.join(' '))
})

test('SHAPE_RULES：props 变量化必须红——不得从后文某个 { 里「找到」children+renderSlot', () => {
  const path = 'up/dsh-client-ui-conversation/lib/client.js'
  // props 变量化：后文仍有 children + renderSlot，但 header 调用自己没有对象字面量。
  const variable = conversationHeaderShapeFindings([{ path, text: [
    'const props = { children: [renderSlot("conversation.session.header", {})] }',
    'return (0, react_jsx_runtime.jsxs)("header", props)',
    'renderSlot("conversation.header", {})',
  ].join('\n') }])
  assert.ok(variable.violations.some(v => v.includes('props 不是紧随其后的对象字面量')), variable.violations.join(' '))
  assert.ok(variable.violations.some(v => v.includes('SHAPE_RULE 1')), variable.violations.join(' '))
  // 正例：调用与 { 之间只允许空白/逗号/换行（真实产物就是换行缩进）。
  const spaced = conversationHeaderShapeFindings([{ path, text:
    'jsxs)("header" ,\n  { children: [renderSlot("conversation.session.header", {})] });\nrenderSlot("conversation.header", {})' }])
  assert.deepEqual(spaced.violations, [])
  // 包裹调用（merge({...})）同样不是「紧随其后的对象字面量」：fail-closed。
  const wrapped = conversationHeaderShapeFindings([{ path, text:
    'jsxs)("header", merge({ children: [renderSlot("conversation.session.header", {})] }));\nrenderSlot("conversation.header", {})' }])
  assert.ok(wrapped.violations.some(v => v.includes('props 不是紧随其后的对象字面量')), wrapped.violations.join(' '))
})

test('声明侧完整性可脱离上游语料独立运行：requiredDeclarationFindings', () => {
  const extracted = extractDeclaredAnchors([{ path: 'plugins/mobile.ts', text: PLUGIN_TEXT }])
  const green = requiredDeclarationFindings(extracted.anchors)
  assert.deepEqual(green.violations, [])
  assert.equal(green.checked, 26, 'external 项不进声明侧检查')
  const broken = requiredDeclarationFindings(extracted.anchors.filter(anchor => anchor.token !== 'data-chat-flow'))
  assert.equal(broken.violations.length, 1)
  assert.match(broken.violations[0], /data-chat-flow/)
})

test('local-name：类名字典零发射 ⇒ 硬失败；裸本地名不算发射，两种生产形态都算', () => {
  const bare = anchorFindings({
    anchors: [{ kind: 'local-name', token: '_row', path: 'x.ts', line: 1 }],
    upstream: [{ path: 'upstream/all.js', text: 'const cls = "row"' }],
    chamber: [], required: [],
  })
  assert.deepEqual(bare.rows.map(row => row.verdict), ['missing'])
  assert.match(bare.violations.join(' '), /_row/)
  const localFirst = anchorFindings({
    anchors: [{ kind: 'local-name', token: '_row', path: 'x.ts', line: 1 }],
    upstream: [{ path: 'upstream/all.css', text: '._row_1alm6_55 { flex-wrap: nowrap }' }],
    chamber: [], required: [],
  })
  assert.deepEqual(localFirst.rows.map(row => row.verdict), ['ok'])
  const hashFirst = anchorFindings({
    anchors: [{ kind: 'local-name', token: '_modelRow', path: 'x.ts', line: 1 }],
    upstream: [{ path: 'upstream/all.js', text: '{"modelRow":"zGbnIq_modelRow"}' }],
    chamber: [], required: [],
  })
  assert.deepEqual(hashFirst.rows.map(row => row.verdict), ['ok'])
})

test('local-name：只接受哈希锚定的类名形态，.foo_row 这类裸后缀不算发射', () => {
  // 旧判据的 [A-Za-z0-9-]* 前缀让「任何以本地名结尾的人类可读类名」都成了证据：
  // 上游换掉哈希类、留下一个 .foo_row 风格的静态类名时门照样绿。
  const bareSuffix = anchorFindings({
    anchors: [{ kind: 'local-name', token: '_row', path: 'x.ts', line: 1 }],
    upstream: [{ path: 'upstream/all.css', text: '.foo_row { color: red }' }],
    chamber: [], required: [],
  })
  assert.deepEqual(bareSuffix.rows.map(row => row.verdict), ['missing'])
  assert.match(bareSuffix.violations.join(' '), /_row/)
  // 裸本地名（无哈希段）同样不算。
  for (const text of ['const cls = "row"', 'const cls = "_row"', '.modelRow { }']) {
    assert.equal(localNameEvidence([{ path: 'upstream/all.js', text }], text.includes('modelRow') ? '_modelRow' : '_row').emissions.length, 0, text)
  }
  // 哈希段是判据的一部分：≥5 个字符还不够，段内必须有数字或大小写混合——否则
  // .table_row / .breakpoint_modelRow 这类「可读单词前缀 + 本地名」的静态类名也会
  // 被当成哈希发射（假绿）。两字符的 .ab_row 同样不算。
  assert.equal(localNameEvidence([{ path: 'upstream/all.css', text: '.ab_row{x:1}' }], '_row').emissions.length, 0)
  assert.equal(localNameEvidence([{ path: 'upstream/all.css', text: '.ab3de_row{x:1}' }], '_row').emissions.length, 1)
  assert.equal(localNameEvidence([{ path: 'upstream/all.css', text: '.abcDe_row{x:1}' }], '_row').emissions.length, 1)
  assert.equal(localNameEvidence([{ path: 'upstream/all.css', text: '.table_row{x:1}' }], '_row').emissions.length, 0)
  assert.equal(localNameEvidence([{ path: 'upstream/all.css', text: '.breakpoint_modelRow{x:1}' }], '_modelRow').emissions.length, 0)
  assert.equal(localNameEvidence([{ path: 'upstream/all.css', text: '._row_breakpoint{x:1}' }], '_row').emissions.length, 0)
  assert.equal(localNameEvidence([{ path: 'upstream/all.css', text: '._row_1alm6_55{x:1}' }], '_row').emissions.length, 1)
  // 两种生产形态（真实 rc.2 产物里的形状）都仍然算发射。
  assert.equal(localNameEvidence([{ path: 'upstream/all.css', text: '._row_1alm6_55{x:1}' }], '_row').emissions.length, 1)
  assert.equal(localNameEvidence([{ path: 'upstream/all.js', text: '{"modelRow":"zGbnIq_modelRow"}' }], '_modelRow').emissions.length, 1)
  assert.equal(localNameEvidence([{ path: 'upstream/all.js', text: 'const c = "EvIC1a_toBottomSlot"' }], '_toBottomSlot').emissions.length, 1)
})

test('external 锚 _crumbSeg：只查上游发射侧；上游改名即红，插件不点名不算缺口', () => {
  const extracted = extractDeclaredAnchors([{ path: 'plugins/mobile.ts', text: PLUGIN_TEXT }])
  // 正例：合成语料里有 wSkVaW_crumbSeg ⇒ external 项通过（且没有声明侧要求）。
  const green = anchorFindings({
    anchors: extracted.anchors,
    upstream: [{ path: 'upstream/client.js', text: UPSTREAM_TEXT }],
    chamber, required: REQUIRED_ANCHORS,
  })
  assert.deepEqual(green.violations, [])
  // 负例：上游把 crumbSeg 的哈希类名换掉（改名/换容器）⇒ 硬失败。
  const renamed = anchorFindings({
    anchors: extracted.anchors,
    upstream: [{ path: 'upstream/client.js', text: UPSTREAM_TEXT.replaceAll('wSkVaW_crumbSeg', 'zzzzzz_crumbBar') }],
    chamber, required: REQUIRED_ANCHORS,
  })
  assert.ok(renamed.violations.some(v => v.includes('_crumbSeg')), renamed.violations.join('\n'))
  assert.ok(!renamed.violations.some(v => v.includes('_crumbSeg') && v.includes('插件声明')),
    'external 项不得产生声明侧缺口：' + renamed.violations.join('\n'))
})

test('抽取：三种 [class…] 形态都抽成 local-name（token 保留前导 _）', () => {
  const anchors = extractAnchorsFromSource({ path: 'x.ts', text: '[class$="_row"]{} [class*="_row "]{} [class*="_modelRow_"]{} [class="plain"]{}' })
  assert.deepEqual(anchors.map(a => a.kind + ':' + a.token), ['local-name:_row', 'local-name:_row', 'local-name:_modelRow'])
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
  assert.match(parseVerifyMobileAnchorsArgs(['--require-anchor-root', '--require-anchor-root']).errors[0], /重复的 --require-anchor-root/)
})

test('参数契约：--require-anchor-root 是严格的「必须真的查过」开关', () => {
  // 默认（CI/裸 clone）允许 fail-soft；严格模式由升级流程显式打开，把「正常跳过」与「其实什么都没查」区分开（默认路径静默 exit 0）。
  assert.equal(parseVerifyMobileAnchorsArgs([]).requireAnchorRoot, false)
  const strict = parseVerifyMobileAnchorsArgs(['--require-anchor-root'])
  assert.deepEqual(strict.errors, [])
  assert.equal(strict.requireAnchorRoot, true)
  assert.equal(parseVerifyMobileAnchorsArgs(['--require-anchor-root', '--list']).requireAnchorRoot, true)
  assert.equal(parseVerifyMobileAnchorsArgs(['--help', '--require-anchor-root']).help, true)
})

test('参数契约：合法形态与 --help 优先、env 兜底', () => {
  const parsed = parseVerifyMobileAnchorsArgs(['--anchor-root', '/tmp/x', '--simulate-rename', 'main=center', '--list'])
  assert.deepEqual(parsed.errors, [])
  assert.equal(parsed.anchorRoot, '/tmp/x')
  assert.deepEqual(parsed.renames, [{ from: 'main', to: 'center' }])
  assert.equal(parsed.list, true)
  const help = parseVerifyMobileAnchorsArgs(['--help', '--unknown-flag'])
  assert.equal(help.help, true)
  assert.deepEqual(help.errors, [])
  // 环境变量兜底；显式 --anchor-root 覆盖它
  assert.equal(parseVerifyMobileAnchorsArgs([], { DSH_MOBILE_ANCHOR_ROOT: '/env/root' }).anchorRoot, '/env/root')
  assert.equal(parseVerifyMobileAnchorsArgs(['--anchor-root', '/cli/root'], { DSH_MOBILE_ANCHOR_ROOT: '/env/root' }).anchorRoot, '/cli/root')
  assert.equal(parseVerifyMobileAnchorsArgs([], {}).anchorRoot, null)
  assert.ok(DEFAULT_ANCHOR_ROOTS.length >= 2)
})

test('stripCommentsKeepingLines：长度守恒（闭合 */ 也占位），行号与字符串不变', () => {
  const commented = [
    'a/* b */c',
    'a/* b\nc */d',
    'a// b\nc',
    'a/* not closed\nb',
    'a/*/**/b',
    'const x = 1 /* one */ + 2 // two\n/* three */',
  ]
  for (const text of commented) {
    const projected = stripCommentsKeepingLines(text)
    assert.equal(projected.length, text.length, JSON.stringify(text))
    assert.equal(projected.split('\n').length, text.split('\n').length, JSON.stringify(text))
    assert.ok(!projected.includes('/*') && !projected.includes('*/'), JSON.stringify(text))
  }
  const inString = 'a"/* not a comment */"b'
  const quoted = stripCommentsKeepingLines(inString)
  assert.equal(quoted.length, inString.length)
  assert.ok(quoted.includes('/* not a comment */'), 'quoted strings are preserved')
})

test('CSS 注释投影：全部 kind 都在投影上抽取，注释里的声明不算（hash 同理）', () => {
  const commentOnly = {
    path: 'plugins/styles.ts',
    text: [
      'export const CSS = "/* [data-chat-flow] used to live here */"',
      'export const CLS = "/* [class$=\\"_row\\"] { color: red } */"',
      'export const HASH = "/* _root_38jqx_ */"',
    ].join('\n'),
  }
  assert.deepEqual(extractAnchorsFromSource(commentOnly).map(anchor => anchor.kind + ':' + anchor.token), [])
  const withReal = { path: 'plugins/styles.ts', text: commentOnly.text + '\n[data-chat-flow] { display: flex }' }
  assert.deepEqual(extractAnchorsFromSource(withReal).map(anchor => anchor.kind + ':' + anchor.token), ['attribute:data-chat-flow'])
  const findings = requiredDeclarationFindings(extractDeclaredAnchors([commentOnly]).anchors)
  assert.ok(findings.violations.some(violation => violation.includes('data-chat-flow')), findings.violations.join('\n'))
})

test('CSS 注释投影：data-tip 的声明行是真实选择器，不是注释里的提及', () => {
  const file = join(ROOT, 'packages', 'dsh-chamber-client-ui-mobile', 'src', 'client', 'styles.ts')
  const text = readFileSync(file, 'utf8')
  const tip = extractAnchorsFromSource({ path: 'styles.ts', text }).filter(anchor => anchor.token === 'data-tip')
  assert.ok(tip.length >= 1, 'data-tip must still be declared after CSS-comment stripping')
  const line = text.split('\n')[tip[0].line - 1]
  assert.match(line, /\[data-tip\]/, 'declaration line: ' + line)
  assert.doesNotMatch(line, /^\s*(\*|\/\*)/, 'a comment line cannot be the declaration: ' + line)
})

test('FORBIDDEN_PATTERNS：转义引号 / 另一种引号 / 字符串拼接都不得绕过', () => {
  const variants = [
    "const BAD = '[data-slot=\\\"conversation.session.header\\\"] > header'",
    'const BAD = "[data-slot=\'conversation.session.header\'] > header"',
    "const BAD = '[data-slot=\"conversation.session.header\"]' + ' > header'",
    "const BAD = '[data-slot=\"conversation.session.' + 'header\"] > header'",
    "const BAD = 'nav > span' + ' > button:disabled'",
  ]
  for (const text of variants) {
    const findings = forbiddenPatternFindings([{ path: 'plugins/x.ts', text }])
    assert.equal(findings.violations.length, 1, text + ' -> ' + findings.violations.join(' '))
    assert.match(findings.violations[0], /plugins\/x\.ts:1/)
  }
  const multiline = [
    'const a = 1',
    'const BAD = \'[data-slot="conversation.session\'',
    '  + \'.header"] > header\'',
  ].join('\n')
  const findings = forbiddenPatternFindings([{ path: 'plugins/x.ts', text: multiline }])
  assert.equal(findings.violations.length, 1, findings.violations.join(' '))
  assert.match(findings.violations[0], /plugins\/x\.ts:2/)
})

test('SHAPE_RULES：children 值区间之外或字符串里的槽文本都必须红', () => {
  const path = 'up/dsh-client-ui-conversation/lib/client.js'
  const base = '\nrenderSlot("conversation.header", {})'
  const decoys = [
    'jsxs)("header", { children: [], onRender: () => renderSlot("conversation.session.header", {}) });' + base,
    'jsxs)("header", { children: [], config: { deep: { slot: renderSlot("conversation.session.header", {}) } } });' + base,
    'jsxs)("header", { children: ["renderSlot(\'conversation.session.header\', {})"] });' + base,
  ]
  for (const text of decoys) {
    const findings = conversationHeaderShapeFindings([{ path, text }])
    assert.ok(findings.violations.some(violation => violation.includes('SHAPE_RULE 1')), text + ' -> ' + findings.violations.join(' '))
  }
  const positive = 'jsxs)("header", { className: x, children: [jsx("div", {}), sessionId === void 0 ? jsx("div", {}) : renderSlot("conversation.session.header", { hideChrome: blank })] });' + base
  assert.deepEqual(conversationHeaderShapeFindings([{ path, text: positive }]).violations, [])
})

test('防伪：对象键形只在合法键边界成立（文案里的键形不算发射）', () => {
  const anchors = [{ kind: 'attribute', token: 'data-chat-flow', path: 'x.ts', line: 1 }]
  const verdict = text => anchorFindings({
    anchors, upstream: [{ path: 'upstream/all.js', text }], chamber: [], required: [],
  }).rows.map(row => row.verdict)
  // 引号前是单词字符：这是文案里的提及，不是 props 的键（旧判据会把它当发射）。
  assert.deepEqual(verdict('console.warn(\'legacy "data-chat-flow": true\')'), ['missing'])
  // 合法键边界：对象开头 / 前一个键之后。
  assert.deepEqual(verdict('jsx("div", { "data-chat-flow": "" })'), ['ok'])
  assert.deepEqual(verdict('jsx("div", { className: x, "data-chat-flow": "" })'), ['ok'])
  // 已知残余（见 objectKeyEmits 的注释）：整段键形塞进字符串仍是局部合法边界，
  // 本模块不是词法分析器；这条断言把残余钉在明面上，避免被误当成已解决。
  assert.deepEqual(verdict('console.warn(\'{"data-chat-flow": 1} is gone\')'), ['ok'])
})

test('defaultAnchorRoots：env 值里的 $& / $1 按字面量插入', () => {
  assert.equal(defaultAnchorRoots({ DSH_MOBILE_GATEWAY_ANCHOR_ROOT: '/x/$&/y' })[0], '/x/$&/y')
  assert.equal(defaultAnchorRoots({ DSH_MOBILE_GATEWAY_ANCHOR_ROOT: '/x/$1' })[0], '/x/$1')
  assert.deepEqual(defaultAnchorRoots({}), DEFAULT_ANCHOR_ROOTS.filter(root => root !== '$' + '{DSH_MOBILE_GATEWAY_ANCHOR_ROOT}'))
})

test('walkFiles 跟随符号链接目录：pnpm isolated 锚根不被误判「树不完整」', () => {
  const { root, anchor } = makeStrictRoot({ after: () => {} }, { frontendVersion: pinnedFrontendVersion(), shell: true, symlink: true })
  const run = args => spawnSync(process.execPath, ['scripts/upstream/verify-mobile-anchors.mjs', ...args], { cwd: root, encoding: 'utf8' })
  try {
    const strict = run(['--require-anchor-root', '--anchor-root', anchor])
    assert.equal(strict.status, 0, 'symlinked packages are a complete tree: ' + strict.stdout + strict.stderr)
    assert.match(strict.stdout, /上游语料：[1-9][0-9]* 个 client 半/)
    assert.doesNotMatch(strict.stdout + strict.stderr, /没有 client 产物/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

