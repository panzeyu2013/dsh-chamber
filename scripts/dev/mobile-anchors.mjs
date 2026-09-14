/**
 * mobile-anchors.mjs — 移动插件锚点的**纯判据层**（docs/checklists/
 * upstream-touchpoints.md §4 的机器侧；design 17 §18.4.3/§18.6 的锚点保鲜）。
 *
 * 为什么单独成模块：`verify-mobile-anchors.mjs` 是顶层过程式程序、不可被测试
 * import（同 `verify-upstream-touchpoints-args.mjs` / `plugin-protection-gate.mjs`
 * 的拆法先例）。这里只放**纯函数**（无 fs、无 process、无 network）：调用方读
 * 源码/读上游产物，把文本与文件表传进来，拿回 `{violations, advisories, notes}`，
 * 再由调用方决定 fail/warn。于是每条判据都能用合成夹具做**负例**测试。
 *
 * 本门要回答的问题（STATUS.md 移动档开放项 ⑤ 的另一半）：移动插件的 CSS/JS 锚在
 * 上游 DOM 契约上（`data-*` 属性、slot key、`role`），打包 fork 的 README +
 * `test/breakpoints.test.ts` 只**自证**（只读本包），拦不住上游漂移。这里把
 * 「插件声明的锚点」与「上游产物里真实发射的锚点」做双向差集：
 *
 *   方向 A（声明 → 上游）：插件源码里出现的每个 `data-*` / `[role=…]` /
 *     `data-slot` key 都必须能在上游 client 产物 / shell CSS 里找到发射点。
 *     零命中 = **硬失败**（该规则已经静默 no-op，正是要拦的漂移）。
 *     例外两类，各自有明确的替代指向：
 *       - `data-mobile-*` / `data-plugin` 是本插件**自己打标**的
 *         （markup.ts stampFrame / index.ts `<style>`），上游本来就没有——
 *         登记为 chamber-own，不查上游；
 *       - `data-git-action` 是 **chamber 跨包钩子**（由
 *         `packages/dsh-chamber-client-ui-git` 发射），查本仓发射方而不是上游。
 *     `data-tip` **不**属于上面两类（2026-12 review 更正）：上游
 *     `dsh-client-ui-agent-preset` 的 client 行自己在按钮上设置该属性（其打包 CSS
 *     用 `content:attr(data-tip)` 消费），所以它按普通上游锚点查；本插件侧发射方在
 *     `dsh-chamber-client-ui-settings-connections`，那条契约由该包与移动包的
 *     lockstep 测试钉住（`test/official-hover-card.test.ts`）。
 *   direction B（上游 → 声明）：对上游全量做反向差集是不可能的（上游发射数百个
 *     锚点，插件只用其一）。所以方向 B 收窄到**门禁要求的最小断言集**
 *     {@link REQUIRED_ANCHORS}：其中每一项都必须（1）在本插件源码里被声明、
 *     （2）在上游产物里有发射点。这样「插件把自己的锚点改名/删掉」同样会红，
 *     而不只是「上游改名」。
 *
 * 分级（task 要求）：`data-*` / `role` / `slot` 锚点零命中 ⇒ exit 1；build-time
 * 哈希 class token（`_root_1b2ny_` 这类，pin 一动必变、无属性形兜底）零命中 ⇒
 * advisory（打印警告，不失败）——它本来就是「pin 前移必须重锚」的登记项，不是
 * 本仓能修的漂移。
 *
 * 防伪纪律（同 C15）：抽取读的是**去注释**投影（注释里写着的锚点不算声明），
 * 注释用一个**保留行号**的剥离器去掉，因此证据里的 `file:line` 指回原始文件。
 */

/** 上游锚点零命中时的判定分级。 */
export const HARD_KINDS = new Set(['attribute', 'role', 'slot'])

/** 本插件自己打标的属性（上游不存在，不查上游）。 */
const OWN_ATTRIBUTE_PATTERNS = [
  /^data-mobile-/, // markup.ts MOBILE_FRAME_ATTR/MOBILE_ROLE_ATTR + composer.ts MOBILE_KBD_ATTR
  /^data-plugin$/, // index.ts 注入的 <style data-plugin="…">
]

/**
 * chamber 跨包钩子：由本仓另一个插件发射，锚点契约是**仓内**的，所以查发射方
 * 而不是上游。`data-git-action` 是 2026-09-11 upstream-alignment 定下的
 * 侧栏 git 动作钩子（styles.ts 头注），发射方在 git 插件里。
 */
export const CHAMBER_CROSS_PACKAGE = {
  'data-git-action': 'packages/dsh-chamber-client-ui-git',
}

/**
 * `data-slot` 属性名本身：所有 slot 判据的前提。它是渲染器通用发射的
 * （`"data-slot": slotKey`），单独作为结构性锚点登记。
 */
const STRUCTURAL_ATTRIBUTE = 'data-slot'

/**
 * 门禁要求的最小断言集（task 逐条点名的那一份；与 §4 登记行同源）。
 *
 * `declared: 'plugin'` ⇒ 必须先在本插件源码里被抽到，否则红线（插件侧改名/删除）；
 * `declared: 'external'` ⇒ 只断言上游发射侧（供「上游在用、插件尚未点名」的锚点
 * 预留；当前 19 项全部为 `plugin`——`data-chat-flow` / `data-chat-anchor-key`
 * 已由 `session-stall.ts` 点名，故同样按两向断言）。
 *
 * 这一份是**有意独立于插件源码**的最小目录：抽取器抽不到某个锚点时（插件把它
 * 改名/删掉），方向 A 看不见这条规则已经失效，只有这里会红。维护纪律：往插件里
 * 新加一条上游锚点依赖时，在 §4 登记行与本表各加一行；锚点退役时两处一起删。
 */
export const REQUIRED_ANCHORS = [
  // —— 三栏骨架 ——
  { kind: 'slot', token: 'root', declared: 'plugin', note: 'markup.ts ROOT_SLOT_SELECTOR（每实例根）' },
  { kind: 'slot', token: 'sidebar', declared: 'plugin', note: 'ROLE_SLOT_KEYS.sidebar（左列 key）' },
  { kind: 'slot', token: 'main', declared: 'plugin', note: 'ROLE_SLOT_KEYS.conversation（中列 key）' },
  { kind: 'slot', token: 'rightbar', declared: 'plugin', note: 'ROLE_SLOT_KEYS.details（右列 key）' },
  { kind: 'slot', token: 'shell.overlay', declared: 'plugin', note: 'index.ts 浮动抽屉开关的 additive 座' },
  // —— 会话滚动 / composer ——
  { kind: 'attribute', token: 'data-conversation-scroll', declared: 'plugin', note: '会话滚动容器（抽屉锁滚动）' },
  { kind: 'attribute', token: 'data-composer-seat', declared: 'plugin', note: 'composer 座（键盘补偿的几何锚）' },
  { kind: 'attribute', token: 'data-composer-input', declared: 'plugin', note: 'Lexical 编辑区（非 textarea）' },
  // —— 会话流锚点 ——
  { kind: 'attribute', token: 'data-chat-flow', declared: 'plugin', note: '上游会话流容器（ChatView 消息列；会话停滞判定）' },
  { kind: 'attribute', token: 'data-chat-anchor-key', declared: 'plugin', note: '上游会话流虚拟化锚 key（已渲染消息行）' },
  // —— 会话头及其四个子座位 ——
  { kind: 'slot', token: 'conversation.session.header', declared: 'plugin', note: '会话头 slot（首行高度/无换行/44px 断言的根）' },
  { kind: 'slot', token: 'conversation.session.header.actions', declared: 'plugin', note: '会话头 actions 座位（44px）' },
  { kind: 'slot', token: 'conversation.session.header.utilities', declared: 'plugin', note: '会话头 utilities 座位（44px）' },
  { kind: 'slot', token: 'conversation.session.header.corner', declared: 'plugin', note: '会话头 corner 座位（44px）' },
  { kind: 'slot', token: 'conversation.session.header.lineage', declared: 'plugin', note: '会话头 lineage 计数（单字换行断言）' },
  // —— 布局状态属性 ——
  { kind: 'attribute', token: 'data-phase', declared: 'plugin', note: '会话根相位（active/inert/…；composer 门控）' },
  { kind: 'attribute', token: 'data-sidebar-collapsed', declared: 'plugin', note: '轨道标志：存在=折叠、移除=展开' },
  { kind: 'attribute', token: 'data-rightbar-collapsed', declared: 'plugin', note: '轨道标志（右栏 shown 判定的一条臂）' },
  { kind: 'attribute', token: 'data-sidebar-right-panel', declared: 'plugin', note: '右栏面板自身状态（push|fullscreen）' },
]

/**
 * 去掉注释、**保留行号**（块注释里的换行补成同数量的空行，索引与原文一一对应，
 * 因此证据里的行号可用）。语义同 `plugin-protection-gate.mjs` 的 `stripComments`
 * （字符串感知：引号内的 `//`/`/*` 不是注释），差别只有行号对齐这一点。
 *
 * @param {string} source - TS/TSX 源码文本。
 * @returns {string} 同长度的去注释文本。
 */
export function stripCommentsKeepingLines(source) {
  let out = ''
  let quote = null
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]
    const next = source[i + 1]
    if (quote !== null) {
      out += ch
      if (ch === '\\') { out += next ?? ''; i += 1; continue }
      if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; out += ch; continue }
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') { out += ' '; i += 1 }
      out += source[i] ?? ''
      continue
    }
    if (ch === '/' && next === '*') {
      out += '  '
      i += 2
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        out += source[i] === '\n' ? '\n' : ' '
        i += 1
      }
      i += 1
      out += ' '
      continue
    }
    out += ch
  }
  return out
}

/** 1-based 行号（由去注释投影的索引反查，投影保留行号）。 */
function lineAt(text, index) {
  let line = 1
  for (let i = 0; i < index && i < text.length; i += 1) if (text[i] === '\n') line += 1
  return line
}

/** 正则转义。 */
function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 从一个文件的去注释投影里抽出全部锚点声明。
 *
 * @param {{ path: string, text: string }} source - 一个插件源码文件。
 * @returns {Array<{ kind: string, token: string, path: string, line: number, form: string }>}
 */
export function extractAnchorsFromSource(source) {
  const code = stripCommentsKeepingLines(source.text)
  const found = []
  const push = (kind, token, index, form) => {
    found.push({ kind, token, path: source.path, line: lineAt(code, index), form })
  }

  // 1. 属性名：`data-*`（含 `[data-x]` 选择器、`'data-x'` 字面量、attributeFilter 数组）
  for (const match of code.matchAll(/\bdata-[a-z][a-z0-9-]*\b/g)) {
    const token = match[0]
    if (token === STRUCTURAL_ATTRIBUTE) continue // 由 slot 判据与结构性检查覆盖
    push('attribute', token, match.index, 'data-*')
  }
  // 2. 角色选择器：`[role="…"]`（只认选择器形，不认 JSON/对象字面量里的 role 字段）
  for (const match of code.matchAll(/\[role=["']([a-z][a-z0-9-]*)["']\]/g)) {
    push('role', match[1], match.index, '[role=…]')
  }
  // 3. slot key：选择器形 `[data-slot="…"]`
  for (const match of code.matchAll(/\[data-slot=["']([^"'\]]+)["']\]/g)) {
    push('slot', match[1], match.index, '[data-slot=…]')
  }
  // 4. slot key：槽 API 形 `slots.inject('…')` / `slots.register({ name: '…' })`
  for (const match of code.matchAll(/\bslots\.(?:inject|register)\(\s*['"]([a-z][a-z0-9.-]*)['"]/g)) {
    push('slot', match[1], match.index, 'slots.*(…)')
  }
  for (const match of code.matchAll(/\bslots\.(?:inject|register)\(\s*\{[^}]*?\bname:\s*['"]([a-z][a-z0-9.-]*)['"]/gs)) {
    push('slot', match[1], match.index, 'slots.*({name})')
  }
  // 5. 列 key 映射表（ROLE_SLOT_KEYS 的值就是上游 slot key；这是「角色词 ↔ slot 词」
  //    的唯一映射点，上游改名时改的就是它）
  const roleMap = /\bROLE_SLOT_KEYS\b[^=]*=\s*\{([^}]*)\}/s.exec(code)
  if (roleMap !== null) {
    for (const value of roleMap[1].matchAll(/['"]([a-z][a-z0-9.-]*)['"]/g)) {
      push('slot', value[1], roleMap.index + value.index, 'ROLE_SLOT_KEYS')
    }
  }
  // 6. build-time 哈希 class token（`_root_1b2ny_` / `_card_1b2ny_`）：advisory 族
  for (const match of code.matchAll(/_[a-z][a-z0-9]*_[a-z0-9]{5,}_/g)) {
    push('hash', match[0], match.index, 'hash-token')
  }
  return found
}

/**
 * 抽取全部插件源码的锚点声明，按 (kind, token) 去重，保留**第一处**声明位置。
 *
 * @param {Array<{ path: string, text: string }>} sources - `src/**` 下的 TS/TSX。
 * @returns {{ anchors: Array<object>, byKey: Map<string, object> }}
 */
export function extractDeclaredAnchors(sources) {
  const byKey = new Map()
  for (const source of sources) {
    for (const anchor of extractAnchorsFromSource(source)) {
      const key = `${anchor.kind}:${anchor.token}`
      if (!byKey.has(key)) byKey.set(key, anchor)
    }
  }
  return { anchors: [...byKey.values()], byKey }
}

/**
 * 锚点分类：上游 / chamber 自有 / chamber 跨包 / 结构性。
 *
 * @param {{ kind: string, token: string }} anchor
 * @returns {'upstream'|'chamber-own'|'chamber-cross-package'|'structural'}
 */
export function anchorCategory(anchor) {
  if (anchor.kind === 'attribute') {
    if (anchor.token === STRUCTURAL_ATTRIBUTE) return 'structural'
    if (Object.hasOwn(CHAMBER_CROSS_PACKAGE, anchor.token)) return 'chamber-cross-package'
    if (OWN_ATTRIBUTE_PATTERNS.some(pattern => pattern.test(anchor.token))) return 'chamber-own'
  }
  return 'upstream'
}

/**
 * 属性锚点在上游产物里的发射形态。只认**结构形**，不认「裸提及」：
 *   1. CSS 属性选择器：`[data-x]`、`[data-x=…]`、`[data-x~=…]` 等；
 *   2. 对象键 / JSX 编译产物：`"data-x":`、`'data-x':`；
 *   3. 属性写入：`setAttribute("data-x"`，以及 JSX/HTML 模板里的 `data-x=`；
 *   4. CSS 消费：`attr(data-x)`（`content: attr(data-tip)` 这类）。
 *
 * 为什么收紧（2026-12 review）：旧边界只要求「前后是引号/括号」，于是
 * `// upstream emits "data-x"` 这样的注释、或 `["data-x"]` 这样的数组，都能充当
 * 「上游仍在发射」的证据——上游真把发射点删掉、只留一句提及，门禁照样绿。C15 对
 * 形状检查用的是「去注释 + 去字符串」投影，这里用「只认结构形」达到同样的防伪
 * 效果，且不需要写 JS 词法分析器。用 `String.raw` 写，避免 `\\]` 在字符类里提前
 * 闭合——这个坑在首版里让三个 dockkit 锚点假红过一次。
 */
function attributePattern(token) {
  const escaped = escapeRe(token)
  return new RegExp([
    String.raw`\[${escaped}(?=[\]~^$*|=])`,
    String.raw`["']${escaped}["']\s*:`,
    String.raw`setAttribute\(\s*["']${escaped}["']`,
    String.raw`(?<![\w-])${escaped}\s*=`,
    String.raw`attr\(\s*${escaped}\s*\)`,
  ].join('|'))
}

/** role 锚点在上游产物里的发射形态：`role:"dialog"`、`"role":"dialog"`、`[role="dialog"]`。 */
function rolePattern(role) {
  return new RegExp(`(?:["']?role["']?\\s*:\\s*["']${escapeRe(role)}["']|\\[role=["']${escapeRe(role)}["']\\])`)
}

/**
 * slot key 在上游产物里的发射形态。`renderSlot("<key>"` 是 **key 发射点**
 * （renderer 的槽渲染器把 key 直接写成 `data-slot` 属性值），其余几种是同一
 * key 的 API/选择器形。任何一条命中即视为「上游仍发射该 slot」。
 */
export function slotEvidencePatterns(slot) {
  const escaped = escapeRe(slot)
  return [
    new RegExp(`renderSlot\\(\\s*["']${escaped}["']`),
    new RegExp(`slots\\.(?:inject|subscribe|entries)\\(\\s*["']${escaped}["']`),
    new RegExp(`["']data-slot["']\\s*:\\s*["']${escaped}["']`),
    new RegExp(`\\[data-slot=["']${escaped}["']\\]`),
  ]
}

/**
 * 一条锚点在语料里的命中文件（证据），按 kind 用不同形态匹配。
 *
 * @param {Array<{ path: string, text: string }>} files - 上游产物/仓内发射方。
 * @param {{ kind: string, token: string }} anchor
 * @returns {string[]} 命中的文件路径（去重，稳定顺序）。
 */
export function anchorEvidence(files, anchor) {
  const patterns = anchor.kind === 'role'
    ? [rolePattern(anchor.token)]
    : anchor.kind === 'slot'
      ? slotEvidencePatterns(anchor.token)
      : anchor.kind === 'attribute'
        ? [attributePattern(anchor.token)]
        : [new RegExp(escapeRe(anchor.token))]
  return files.filter(file => patterns.some(pattern => pattern.test(file.text))).map(file => file.path)
}

/**
 * 双向差集判定。
 *
 * 语料在匹配前统一过一遍**去注释投影**（`stripCommentsKeepingLines`，字符串感知、
 * 保留行号）：注释里写着 `[data-x]` 或 `"data-x"` 不构成「上游仍在发射」的证据——
 * 上游删掉真实发射点后，残留注释不能让门禁继续绿（2026-12 review；与 C15 的
 * 「去注释 + 去字符串」同一防伪纪律，这里字符串必须保留，因为发射形态本身就是
 * 字符串/选择器）。
 *
 * @param {object} input
 * @param {Array<{kind: string, token: string, path: string, line: number}>} input.anchors - 插件声明的锚点。
 * @param {Array<{path: string, text: string}>} input.upstream - 上游 client 产物 + shell CSS。
 * @param {Array<{path: string, text: string}>} input.chamber - 仓内跨包发射方（如 git 插件 src）。
 * @param {Array<object>} [input.required] - 门禁要求的最小断言集。
 * @returns {{violations: string[], advisories: string[], notes: string[], rows: Array<object>}}
 */
export function anchorFindings({ anchors, upstream, chamber, required = REQUIRED_ANCHORS }) {
  const project = files => files.map(file => ({ path: file.path, text: stripCommentsKeepingLines(file.text) }))
  upstream = project(upstream)
  chamber = project(chamber)
  const violations = []
  const advisories = []
  const notes = []
  const rows = []
  const declaredKeys = new Set(anchors.map(anchor => `${anchor.kind}:${anchor.token}`))

  // ---- 结构性前提：data-slot 属性名本身 ----
  const structural = anchorEvidence(upstream, { kind: 'attribute', token: STRUCTURAL_ATTRIBUTE })
  if (structural.length === 0) {
    violations.push(`结构性锚点 ${STRUCTURAL_ATTRIBUTE} 在上游产物零命中——所有 slot 判据都失去前提（渲染器不再发射 data-slot）`)
  } else {
    notes.push(`结构性锚点 ${STRUCTURAL_ATTRIBUTE}：${structural.length} 个产物命中（例：${structural[0]}）`)
  }
  // 动态发射链（`"data-slot": slotKey`）：slot key 变成 DOM 属性的机制。局部变量名
  // 可能变，故只作 advisory——但零命中意味着 slot key 与 data-slot 值的锁步断了。
  const linkage = upstream.filter(file => /["']data-slot["']\s*:\s*[A-Za-z_$][A-Za-z0-9_$]*/.test(file.text))
  if (linkage.length === 0) {
    advisories.push('未在上游产物里找到 `"data-slot": <标识符>` 的动态发射链——slot key → data-slot 值的锁步无法确认（渲染器实现可能换形）')
  } else {
    notes.push(`slot key → data-slot 发射链：${linkage[0].path}`)
  }

  // ---- 方向 A：插件声明的锚点 → 上游发射点 ----
  for (const anchor of anchors) {
    const category = anchorCategory(anchor)
    const where = `${anchor.path}:${anchor.line}`
    if (category === 'chamber-own' || category === 'structural') {
      rows.push({ ...anchor, category, verdict: 'skip', evidence: [] })
      continue
    }
    if (category === 'chamber-cross-package') {
      const evidence = anchorEvidence(chamber, anchor)
      rows.push({ ...anchor, category, verdict: evidence.length > 0 ? 'ok' : 'missing', evidence })
      if (evidence.length === 0) {
        violations.push(`chamber 跨包锚点 ${anchor.token} 在本仓发射方零命中（${where} 声明的契约已断；发射方=${CHAMBER_CROSS_PACKAGE[anchor.token]}）`)
      }
      continue
    }
    const evidence = anchorEvidence(upstream, anchor)
    const hard = HARD_KINDS.has(anchor.kind)
    rows.push({ ...anchor, category, verdict: evidence.length > 0 ? 'ok' : (hard ? 'missing' : 'advisory'), evidence })
    if (evidence.length === 0) {
      const message = `${anchor.kind} 锚点 ${anchor.token} 在上游产物零命中（声明于 ${where}，形态 ${anchor.form}）`
      if (hard) violations.push(`${message}——本插件的规则已静默 no-op，请按 design 17 §18.4.3 重锚`)
      else advisories.push(`${message}——build-time 哈希 token，pin 一动必变：属于「pin 前移必须重锚」的登记项，不判失败`)
    }
  }

  // ---- 方向 B：门禁要求的最小集 → 插件声明 + 上游发射 ----
  for (const item of required) {
    const key = `${item.kind}:${item.token}`
    if (item.declared === 'plugin' && !declaredKeys.has(key)) {
      violations.push(`最小断言集要求插件声明 ${item.kind} 锚点 ${item.token}，但源码里抽不到——插件侧改名/删除，或该锚点所属功能被移除`
        + `（后者应把本项与 docs/checklists/upstream-touchpoints.md §4 的登记行一起删）：${item.note}`)
    }
    const upstreamEvidence = anchorEvidence(upstream, item)
    const hard = HARD_KINDS.has(item.kind)
    if (upstreamEvidence.length === 0 && hard) {
      violations.push(`最小断言集要求上游发射 ${item.kind} 锚点 ${item.token}，但产物里零命中（${item.note}；声明侧=${item.declared}）`)
    }
    if (upstreamEvidence.length === 0 && !hard) {
      advisories.push(`最小断言集里的 build-time 哈希 token ${item.token} 在上游产物零命中（${item.note}）`)
    }
  }

  const declaredUpstream = rows.filter(row => row.category === 'upstream')
  const hashRows = rows.filter(row => row.kind === 'hash')
  notes.push(`方向 A：插件声明 ${declaredUpstream.length} 个上游锚点（去重后），零命中 ${declaredUpstream.filter(row => row.verdict === 'missing').length} 个；`
    + `chamber 自有 ${rows.filter(row => row.category === 'chamber-own').length} 个（不查上游）、跨包 ${rows.filter(row => row.category === 'chamber-cross-package').length} 个、`
    + `哈希 token ${hashRows.length} 个（advisory：零命中 ${hashRows.filter(row => row.verdict !== 'ok').length} 个）`)
  notes.push(`方向 B：最小断言集 ${required.length} 项（external ${required.filter(item => item.declared === 'external').length} 项免声明侧检查）`)
  return { violations, advisories, notes, rows }
}

/**
 * 把改名应用到一份产物文本（**只在内存里**：自测负例不得改仓库产物）。
 * 替换是字面量全局替换——正是「上游把锚点改名」的效果。
 *
 * @param {string} text - 产物文本。
 * @param {Array<{from: string, to: string}>} renames - 改名表。
 * @returns {string} 改名后的文本。
 */
export function applySimulatedRename(text, renames) {
  let out = text
  for (const rename of renames) out = out.split(rename.from).join(rename.to)
  return out
}
