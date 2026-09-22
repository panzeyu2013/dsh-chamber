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
 * 本门要回答的问题：移动插件的 CSS/JS 锚在
 * 上游 DOM 契约上（`data-*` 属性、slot key、`role`），打包 fork 的 README +
 * `test/behavior/composer-guard.test.ts` 只**自证**（只读本包），拦不住上游漂移。这里把
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
 *     `data-tip` **不**属于上面两类：上游
 *     `dsh-client-ui-agent-preset` 的 client 行自己在按钮上设置该属性（其打包 CSS
 *     用 `content:attr(data-tip)` 消费），所以它按普通上游锚点查；本插件侧发射方在
 *     `dsh-chamber-client-ui-settings-connections`，那条契约由该包与移动包的
 *     lockstep 测试钉住（`test/dom/official-hover-card.test.ts`）。
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
 * 而不是上游。`data-git-action` 是侧栏 git 动作钩子（styles.ts 头注），
 * 发射方在 git 插件里。
 */
/**
 * 仓内跨包发射方：这些属性由**别的** chamber 包发射，所以查本仓发射方而不是上游。
 * 注意：本插件当前不声明其中任何一条（git 插件自己发射 `data-git-action`，移动端
 * 只在注释里提到它），所以 `--list` 的「跨包」计数是 0——这条规则是为「移动端真的
 * 用上该钩子」预留的，不是死代码待删，也不假装今天在保护什么。
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
 * 门禁要求的最小断言集（与 §4 登记行同源）。
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
 * 属性锚点的证据分两级。**写入形**证明上游仍在发射：
 *   1. 对象键 / 编译后的 JSX 属性：`"data-x":`、`'data-x':`；
 *   2. DOM 写入：`setAttribute(` / `toggleAttribute(` / `removeAttribute(`；
 *   3. JSX 源码里的属性写法 `data-x=`（**只对 `.ts/.tsx` 这类源码语料开启**；
 *      打包产物里 `data-x=` 只可能出现在字符串/文案里，那是诱饵面：见下）。
 * 另有**消费形**（选择器 `[data-x…]`、CSS `attr(data-x)`）：它们只证明页面**用**这个
 * 属性，不证明上游还在**写**它——上游删掉写入点、留下一条死 CSS，旧判定照样绿
 * （`data-ds-dark-theme` 正是这样：唯一写入点是
 * `document.body.toggleAttribute('data-ds-dark-theme', dark)`，其余全是 CSS 规则）。
 * 因此：属性锚点的判定只认写入形；只有消费形 ⇒ 硬失败并点名（判据见
 * anchorFindings）。注释里的裸提及、数组字面量、错误文案都不算——语料先过
 * stripCommentsKeepingLines 投影，而"文案里带结构形"（如
 * `console.warn("[data-x] is gone")`）落在消费形那一级，同样不能决定判定。
 */
const SOURCE_SYNTAX_PATH = /\.(?:ts|tsx|mts|cts)$/

/**
 * `data-chat-anchor-key` → `chatAnchorKey`（`dataset` 的键形）。写入
 * `el.dataset.chatAnchorKey = …` 与 `setAttribute` 等效，是正常重构；只接受**赋值**
 * 形，读取形仍属消费形。
 */
function datasetKeyFor(token) {
  return token.replace(/^data-/, '').replace(/-(\w)/g, (_match, ch) => ch.toUpperCase())
}

/**
 * 同一文件里 `const ID = "data-x"` 这类**常量别名**：真实上游已经这么写
 * （`dsh-client-ui-layout/lib/client.js` 的 `DARK_ATTRIBUTE`），只认字面量的判定会
 * 把它算成「没有写入点」——假红。别名只在同一文件内生效，且仍必须出现在
 * set/toggle/removeAttribute 调用里。
 */
function aliasesFor(text, token) {
  const found = []
  for (const match of text.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*["']([^"']+)["']/g)) {
    if (match[2] === token) found.push(match[1])
  }
  return found
}

function attributeEmissionPatterns(token, { fileText = '', path = '' } = {}) {
  const escaped = escapeRe(token)
  const sourceSyntax = SOURCE_SYNTAX_PATH.test(path)
  const aliasPatterns = aliasesFor(fileText, token)
    .map(alias => new RegExp(String.raw`(?:set|toggle|remove)Attribute\(\s*${escapeRe(alias)}\b`))
  return [
    new RegExp(String.raw`["']${escaped}["']\s*:`),
    new RegExp(String.raw`(?:set|toggle|remove)Attribute\(\s*["']${escaped}["']`),
    ...aliasPatterns,
    new RegExp(String.raw`\.dataset\.${datasetKeyFor(escaped)}\s*=(?!=)`),
    ...(sourceSyntax ? [new RegExp(String.raw`(?<![\w-])${escaped}\s*=`, 'i')] : []),
  ]
}

function attributeSelectorPatterns(token) {
  const escaped = escapeRe(token)
  return [
    new RegExp(String.raw`\[${escaped}(?=[\]~^$*|=])`),
    new RegExp(String.raw`attr\(\s*${escaped}\s*\)`),
  ]
}

/**
 * role 锚点同样分两级：**写入形**是 `role:"dialog"` / `"role":"dialog"` /
 * `setAttribute("role"`（值后必须是 `,`/`}`/`]`/`;`/`)` 收尾，否则
 * `console.warn('role: "dialog" is gone')` 这种**文案**就成了发射证据）；**消费形**是
 * CSS 的 `[role="dialog"]`。当前 pin 上 8 个 role 锚点全都有写入形证据。
 */
function roleEmissionPatterns(role) {
  // NOT accepted: an HTML-template `role="dialog"` (the pinned renderer compiles
  // JSX, so it emits the colon form) — if a future pin ever ships that shape the
  // gate goes red and asks for a re-anchor rather than silently passing.
  const escaped = escapeRe(role)
  return [
    new RegExp(`["']?role["']?\\s*:\\s*["']${escaped}["'](?=\\s*[,}\\];)])`),
    new RegExp(`(?:set|toggle|remove)Attribute\\(\\s*["']role["']\\s*,\\s*["']${escaped}["']`),
  ]
}

function roleSelectorPatterns(role) {
  return [new RegExp(`\\[role=["']${escapeRe(role)}["']\\]`)]
}

/** 按「写入形优先」取证据：有写入形就只报写入形，否则回落消费形（判定方决定
 *  这是硬失败还是可接受）。 */
function evidenceByStrength(files, emissionPatternsFor, selectorPatterns) {
  const emissions = files
    .filter(file => emissionPatternsFor(file).some(pattern => pattern.test(file.text)))
    .map(file => file.path)
  if (emissions.length > 0) return { emissions, selectors: [] }
  const selectors = files
    .filter(file => selectorPatterns.some(pattern => pattern.test(file.text)))
    .map(file => file.path)
  return { emissions: [], selectors }
}

/** 属性锚点：写入形 / 消费形两份证据（导出以便负例测试直接钉判定边界）。 */
export function attributeEvidence(files, token) {
  return evidenceByStrength(
    files,
    file => attributeEmissionPatterns(token, { fileText: file.text, path: file.path }),
    attributeSelectorPatterns(token),
  )
}

/** role 锚点：写入形 / 消费形两份证据。 */
export function roleEvidence(files, role) {
  return evidenceByStrength(files, () => roleEmissionPatterns(role), roleSelectorPatterns(role))
}

/**
 * slot key 的**写入形**：渲染器把 key 变成 DOM 的两环
 *   1. `renderSlot("<key>"` —— key 发射点（ui-renderer 的槽渲染器）；
 *   2. `"data-slot": "<key>"` / `setAttribute("data-slot", "<key>")` —— 值投影的字面量形。
 * **消费形**：`slots.inject|subscribe|entries("<key>")`（客户端注册/查询 API）与
 * `[data-slot="<key>"]` 选择器——它们证明页面**用**这个槽，不证明渲染器还在**发射**它。
 * 没有分级时，「上游删掉 renderSlot、只留注册 API 或选择器」这条漂移在 slot
 * 锚点上会照样绿。
 */
export function slotEmissionPatterns(slot) {
  const escaped = escapeRe(slot)
  return [
    new RegExp(`renderSlot\\(\\s*["']${escaped}["']`),
    new RegExp(`["']data-slot["']\\s*:\\s*["']${escaped}["']`),
    new RegExp(`(?:set|toggle|remove)Attribute\\(\\s*["']data-slot["']\\s*,\\s*["']${escaped}["']`),
  ]
}

export function slotSelectorPatterns(slot) {
  const escaped = escapeRe(slot)
  return [
    new RegExp(`slots\\.(?:inject|subscribe|entries)\\(\\s*["']${escaped}["']`),
    new RegExp(`\\[data-slot=["']${escaped}["']\\]`),
  ]
}

/** 全形态并集（保留导出面：调用方要「有没有提到」时用它；判定走上面两级）。 */
export function slotEvidencePatterns(slot) {
  return [...slotEmissionPatterns(slot), ...slotSelectorPatterns(slot)]
}

/** slot 锚点：写入形 / 消费形两份证据。 */
export function slotEvidence(files, slot) {
  return evidenceByStrength(files, () => slotEmissionPatterns(slot), slotSelectorPatterns(slot))
}

/**
 * 一条锚点在语料里的命中文件（证据），按 kind 用不同形态匹配。
 *
 * @param {Array<{ path: string, text: string }>} files - 上游产物/仓内发射方。
 * @param {{ kind: string, token: string }} anchor
 * @returns {string[]} 命中的文件路径（去重，稳定顺序）。
 */
export function anchorEvidence(files, anchor) {
  // attribute / role / slot 走同一套「写入形优先」的两级判定；hash token 只有
  // 字面量一种形态（它本就是 advisory：pin 一动必变）。
  if (anchor.kind === 'attribute') {
    const { emissions, selectors } = attributeEvidence(files, anchor.token)
    return emissions.length > 0 ? emissions : selectors
  }
  if (anchor.kind === 'role') {
    const { emissions, selectors } = roleEvidence(files, anchor.token)
    return emissions.length > 0 ? emissions : selectors
  }
  if (anchor.kind === 'slot') {
    const { emissions, selectors } = slotEvidence(files, anchor.token)
    return emissions.length > 0 ? emissions : selectors
  }
  return files.filter(file => new RegExp(escapeRe(anchor.token)).test(file.text)).map(file => file.path)
}

/** 一个锚点的证据强度：attribute/role 分写入形与消费形，其余 kind 只有一种形态
 *  （命中即写入形，消费形为空）。 */
function strengthOf(files, anchor) {
  if (anchor.kind === 'attribute') return attributeEvidence(files, anchor.token)
  if (anchor.kind === 'role') return roleEvidence(files, anchor.token)
  if (anchor.kind === 'slot') return slotEvidence(files, anchor.token)
  return { emissions: anchorEvidence(files, anchor), selectors: [] }
}

/**
 * 「没有写入点」的失败文案。两种可能都要写出来，读的人才知道下一步做什么：
 * 上游真删了写入点（留下死 CSS），或写入形态没被本门识别。消费方命中要点名，
 * 那正是「看着还在、其实已经不再发射」的那一类。
 *
 * @param {{kind: string, token: string}} anchor
 * @param {string} where - 声明处 `path:line`。
 * @param {string} label - 中文类别名（如「attribute 锚点」）。
 * @param {string} corpusName - 语料名（上游产物 / 本仓发射方）。
 * @param {string[]} selectorHits - 消费形证据文件（可为空）。
 * @param {string} extra - 追加信息（如跨包发射方路径），可为空。
 */
function noEmissionMessage(anchor, where, label, corpusName, selectorHits, extra = '') {
  const detail = selectorHits.length > 0
    ? `只有**消费方**证据（选择器/CSS：${selectorHits[0]}），没有任何写入点`
      + '——上游可能已停止发射它（留下的是死 CSS），或它的写入形态未被本门识别（dataset./toggleAttribute/其它 API 变体）'
    : '在语料里零命中（连消费方证据都没有）'
  return `${label} ${anchor.token} 在${corpusName}${detail}。请按 design 17 §18.4.3 重锚，`
    + `或把该形态补进 scripts/upstream/mobile-anchors.mjs（声明于 ${where}）${extra === '' ? '' : `；${extra}`}`
}

/**
 * 双向差集判定。
 *
 * 语料在匹配前统一过一遍**去注释投影**（`stripCommentsKeepingLines`，字符串感知、
 * 保留行号）：注释里写着 `[data-x]` 或 `"data-x"` 不构成「上游仍在发射」的证据——
 * 上游删掉真实发射点后，残留注释不能让门禁继续绿（与 C15 的
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
  // 结构性前提同样只认写入形：选择器里的 `[data-slot=…]` 是消费方证据，上游把
  // 属性投影删掉、只留选择器时这里也必须红。
  const structural = attributeEvidence(upstream, STRUCTURAL_ATTRIBUTE).emissions
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
      const evidence = strengthOf(chamber, anchor)
      const proof = evidence.emissions.length > 0 ? evidence.emissions : evidence.selectors
      rows.push({ ...anchor, category, verdict: evidence.emissions.length > 0 ? 'ok' : 'missing', evidence: proof })
      if (evidence.emissions.length === 0) {
        violations.push(noEmissionMessage(anchor, where, 'chamber 跨包锚点', '本仓发射方',
          evidence.selectors, `发射方=${CHAMBER_CROSS_PACKAGE[anchor.token]}`))
      }
      continue
    }
    const evidence = strengthOf(upstream, anchor)
    const hard = HARD_KINDS.has(anchor.kind)
    const proof = evidence.emissions.length > 0 ? evidence.emissions : evidence.selectors
    rows.push({
      ...anchor,
      category,
      verdict: evidence.emissions.length > 0 ? 'ok' : (hard ? 'missing' : 'advisory'),
      evidence: proof,
    })
    if (evidence.emissions.length === 0) {
      const message = `${anchor.kind} 锚点 ${anchor.token} 在上游产物零命中（声明于 ${where}，形态 ${anchor.form}）`
      if (hard) {
        violations.push(noEmissionMessage(anchor, where, `${anchor.kind} 锚点`, '上游产物', evidence.selectors))
      } else {
        advisories.push(`${message}——build-time 哈希 token，pin 一动必变：属于「pin 前移必须重锚」的登记项，不判失败`)
      }
    }
  }

  // ---- 方向 B：门禁要求的最小集 → 插件声明 + 上游发射 ----
  for (const item of required) {
    const key = `${item.kind}:${item.token}`
    if (item.declared === 'plugin' && !declaredKeys.has(key)) {
      violations.push(`最小断言集要求插件声明 ${item.kind} 锚点 ${item.token}，但源码里抽不到——插件侧改名/删除，或该锚点所属功能被移除`
        + `（后者应把本项与 docs/checklists/upstream-touchpoints.md §4 的登记行一起删）：${item.note}`)
    }
    // 与方向 A 同一条强度规则：只有**写入形**才算「上游还在发射」，选择器/CSS 是
    // 消费方证据，不能单独支撑最小断言集。
    const strength = strengthOf(upstream, item)
    const upstreamEvidence = strength.emissions.length > 0 ? strength.emissions : strength.selectors
    const hard = HARD_KINDS.has(item.kind)
    if (strength.emissions.length === 0 && hard) {
      violations.push(strength.selectors.length > 0
        ? noEmissionMessage(item, '最小断言集', `${item.kind} 锚点`, '上游产物', strength.selectors, `声明侧=${item.declared}`)
        : `最小断言集要求上游发射 ${item.kind} 锚点 ${item.token}，但产物里零命中（${item.note}；声明侧=${item.declared}）`)
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
