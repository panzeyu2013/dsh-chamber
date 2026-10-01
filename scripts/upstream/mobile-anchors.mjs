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
 *     {@link REQUIRED_ANCHORS}：`declared: 'plugin'` 的每一项都必须（1）在本插件
 *     源码里被声明、（2）在上游产物里有发射点；`declared: 'external'` 只查（2）。
 *     这样「插件把自己的锚点改名/删掉」同样会红，而不只是「上游改名」。
 *     声明侧（1）不依赖上游语料，由 {@link requiredDeclarationFindings} 单独给出，
 *     锚点根缺失时也必须先判定。
 *
 * 分级：`data-*` / `role` / `slot` 锚点零命中 ⇒ exit 1；build-time 哈希
 * class token（`_root_38jqx_` 这类，pin 一动必变、无属性形兜底）零命中同样
 * ⇒ exit 1——它只能由「pin 前移后重锚」修复，advisory 会让门在 pin bump 后继续
 * 绿而插件静默 no-op，所以本门把它升为硬失败（重锚证据与产物路径见
 * packages/dsh-chamber-client-ui-mobile/README.md「Anchor baseline」）。
 *
 * 防伪纪律（同 C15）：抽取读的是**去注释**投影（注释里写着的锚点不算声明），
 * 注释用一个**保留行号**的剥离器去掉，因此证据里的 `file:line` 指回原始文件。
 */

/**
 * 上游锚点零命中时的判定分级。集合对抽取器可能产出的**全部 kind** 是全覆盖的
 * （attribute / role / slot / hash / local-name）：零命中一律硬失败，**没有**
 * 「降为 advisory」的第二档——哈希 token 不是例外，pin bump 后 advisory 会让门
 * 继续绿而插件静默 no-op。将来新增 kind 必须同时加进本集合（fail-closed 默认）。
 */
export const HARD_KINDS = new Set(['attribute', 'role', 'slot', 'hash', 'local-name'])

/**
 * 插件源码里**禁止出现**的旧锚点形态（去注释投影逐字扫描，命中即硬失败）。
 *
 * 两条都是「看着像锚点、其实锚不住」的形态：
 *   - `[data-slot="conversation.session.header"] > header`：上游的 `<header>` 是
 *     outlet 的**祖先**（会话头槽挂在 header 的 children 里），直接子选择器在真实
 *     DOM 上匹配不到 ⇒ 插件侧静默 no-op、走查侧静默 INFO；正确形态是
 *     `outlet.closest("header")`（scripts/gui-acceptance/mobile-checks.mjs 与插件
 *     侧同规）；
 *   - `nav > span > button:disabled`：上游禁用态不再保证这个 nav>span>button 结构
 *     （当前 pin 的样式已改用属性/别的结构表达）。
 * 命中不是「提醒」：要么按 design 17 §18.4.3 重锚，要么删掉该规则并说明为什么
 * 不再需要。
 */
export const FORBIDDEN_PATTERNS = [
  { text: '[data-slot="conversation.session.header"] > header', note: 'header 是 outlet 的祖先，不是直接子节点' },
  { text: 'nav > span > button:disabled', note: '上游禁用态不再保证 nav>span>button 结构' },
]

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
 * `declared: 'external'` ⇒ 只断言上游发射侧（供「上游在用、插件尚未点名」的锚点）。
 * 当前共 27 项 = 26 项 `plugin`（`data-chat-flow` / `data-chat-anchor-key` 已由
 * `session-stall.ts` 点名，故同样按两向断言）+ 1 项 `external`（表末 `_crumbSeg`：
 * 插件用结构性 `nav > span` 吃面包屑条、不点名类名，但上游一改名本门必须红）。
 * §4 登记行的「26 项」指前一组（声明侧最小集）；`external` 项没有声明侧契约，
 * 因此不要求该行点名。
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
  { kind: 'attribute', token: 'data-portal', declared: 'plugin', note: 'ui-primitives Tooltip 冒泡（styles.ts [role="tooltip"][data-portal][data-side]）；上游 dsh-client-ui-primitives 发射' },
  // —— 会话头及其四个子座位 ——
  { kind: 'slot', token: 'conversation.session.header', declared: 'plugin', note: '会话头 slot（首行高度/无换行/44px 断言的根）' },
  { kind: 'slot', token: 'conversation.header', declared: 'plugin', note: 'styles.ts 持久会话头 outlet（ConversationHeader 的挂载点；上游 renderSlot("conversation.header")）' },
  { kind: 'slot', token: 'conversation.session.header.actions', declared: 'plugin', note: '会话头 actions 座位（44px）' },
  { kind: 'slot', token: 'conversation.session.header.utilities', declared: 'plugin', note: '会话头 utilities 座位（44px）' },
  { kind: 'slot', token: 'conversation.session.header.corner', declared: 'plugin', note: '会话头 corner 座位（44px）' },
  { kind: 'slot', token: 'conversation.session.header.lineage', declared: 'plugin', note: '会话头 lineage 计数（单字换行断言）' },
  // —— 布局状态属性 ——
  { kind: 'attribute', token: 'data-phase', declared: 'plugin', note: '会话根相位（active/inert/…；composer 门控）' },
  { kind: 'attribute', token: 'data-sidebar-collapsed', declared: 'plugin', note: '轨道标志：存在=折叠、移除=展开' },
  { kind: 'attribute', token: 'data-rightbar-collapsed', declared: 'plugin', note: '轨道标志（右栏 shown 判定的一条臂）' },
  { kind: 'attribute', token: 'data-sidebar-right-panel', declared: 'plugin', note: '右栏面板自身状态（push|fullscreen）' },
  // —— CSS-module 本地名（类名字典发射形；与 hash 同列硬失败） ——
  // 三条都是 styles.ts 里的 `[class…="_…"]` 声明：composer bar 行、settings 模型行、
  // 回到底部控件的键盘抬升。本地名不受 build 哈希漂移影响，是哈希 token 之外唯一
  // 能在 pin bump 后继续锚住的形态。
  { kind: 'local-name', token: '_row', declared: 'plugin', note: 'styles.ts composer bar 行规则（[class$="_row"]）；上游 shell CSS 发射 `._row_1alm6_55` 类名' },
  { kind: 'local-name', token: '_modelRow', declared: 'plugin', note: 'styles.ts settings 模型行两列规则；上游 dsh-client-ui-settings-models/lib/client.js 发射 `zGbnIq_modelRow`' },
  { kind: 'local-name', token: '_toBottomSlot', declared: 'plugin', note: 'styles.ts 回到底部控件的键盘抬升规则；上游 dsh-client-ui-chat/lib/client.js 发射 `EvIC1a_toBottomSlot`' },

  // —— 悬停卡 watchdog 的 build-time CSS-module token（无属性形兜底，pin bump 必重锚） ——
  { kind: 'hash', token: '_root_38jqx_', declared: 'plugin', note: 'official-hover-card.ts OFFICIAL_CARD_ROOT_CLASS_TOKEN；rc.2 产物 index-*.js 的 qp="_root_38jqx_3"' },
  { kind: 'hash', token: '_card_38jqx_', declared: 'plugin', note: 'official-hover-card.ts OFFICIAL_CARD_CLASS_TOKEN；rc.2 产物 index-*.js 的 Gp="_card_38jqx_9"' },

  // —— external 锚（只查上游发射侧：插件不点名该 class，但上游一改名/换容器即红） ——
  { kind: 'local-name', token: '_crumbSeg', declared: 'external', note: '会话头面包屑段：上游 ConversationSessionHeader 把每一节渲染成 span（类名字典 wSkVaW_crumbSeg）；插件用结构性 nav > span 吃它，故这里只钉上游发射面' },
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
      // Length conservation: both characters of a CLOSING `*/` must be emitted.
      // The old code emitted one space for the '/', then let the for-update step
      // over it — every terminated block comment cost one character. The
      // index→line map happened to survive (newlines are preserved), but the
      // documented "same length" contract was false. An UNTERMINATED comment
      // consumes the rest of the file and must not append a phantom close.
      if (i < source.length) {
        out += '  '
        i += 1 // the for-update consumes the '/'
      }
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

/**
 * FORBIDDEN 匹配用的同一投影（{@link forbiddenPatternFindings}）：折叠空白、
 * 归一转义引号、去掉只服务于字符串字面量的字符并保留选择器内容。
 * 针文本与 haystack **必须**走同一个函数，否则两种写法的等价性就断了。
 *
 * @param {string} text - 源码或针文本。
 * @returns {string} 选择器等价的压缩串。
 */
function forbiddenProjection(text) {
  return text
    .replace(/\s+/gu, '')          // 选择器换行 / 多余空格 / 制表符都不改变命中
    .replace(/\\(["'])/g, '$1')   // 转义引号（\" / \'）与裸引号等价
    .replace(/["'+]/g, '')          // 引号是字面量边界、+ 是拼接运算符：只用于拼写选择器
}

/**
 * 禁用锚点形态扫描（{@link FORBIDDEN_PATTERNS}）：插件源码的去注释投影里查找，
 * 比较前过 {@link forbiddenProjection}——空白折叠之外，同一个选择器的多种**拼写**
 * 也必须在同一遍里命中（否则一句「换引号/转义/拼接」就绕过整条规则）：
 *   - 转义：`'[data-slot=\"x\"] > header'`；
 *   - 另一种引号：`"[data-slot='x'] > header"`；
 *   - 字符串拼接：`'[data-slot="x"]' + ' > header'`。
 * 证据里的行号取命中起点的原始行；每个进入 haystack 的字符都有自己的行号条目，
 * 被丢掉的引号/加号不占位，所以映射始终指向原文。
 * 注释里的提及不算（注释剥离保留行号，证据指回原文件）。
 *
 * @param {Array<{path: string, text: string}>} sources - 插件 `src/**` 源文件。
 * @returns {{violations: string[], notes: string[]}}
 */
export function forbiddenPatternFindings(sources) {
  const violations = []
  const notes = []
  for (const source of sources) {
    const code = stripCommentsKeepingLines(source.text)
    // Whitespace-folded haystack plus a per-character line map, so a selector
    // split across lines (or padded with extra spaces) cannot slip through the
    // literal matcher while evidence still points at the original line.
    const lineOf = []
    let haystack = ''
    const lines = code.split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      const squeezed = lines[index].replace(/\s+/gu, '')
      for (let k = 0; k < squeezed.length; k += 1) {
        const ch = squeezed[k]
        const next = squeezed[k + 1]
        if (ch === '\\' && (next === '"' || next === "'")) {
          // 转义引号（\" / \'）先归一为它代表的那个引号，再随字面量边界一起
          // 丢弃：两个源字符不产出 haystack 字符，也就不需要行号条目。
          k += 1
          continue
        }
        if (ch === '"' || ch === "'" || ch === '+') continue
        haystack += ch
        lineOf.push(index + 1)
      }
    }
    for (const pattern of FORBIDDEN_PATTERNS) {
      const needle = forbiddenProjection(pattern.text)
      const at = haystack.indexOf(needle)
      if (at === -1) continue
      violations.push(`禁用锚点形态出现在 ${source.path}:${lineOf[at]}：${JSON.stringify(pattern.text)}（${pattern.note}）`
        + "——按 design 17 §18.4.3 重锚，或删除该规则并说明为什么不再需要")
    }
  }
  if (violations.length === 0) notes.push(`禁用锚点形态扫描：${sources.length} 个插件源文件零命中`)
  return { violations, notes }
}

/** 正则转义。 */
function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * CSS 注释投影（保留行号）：styles.ts 把整段 CSS 放在 TS 模板字面量里，
 * `stripCommentsKeepingLines` 会把整段当一个字符串（字符串感知），于是 **CSS 注释
 * 里**的锚点提及（例如注释里写的 `[data-tip]` 或
 * 「attribute anchors, not a `[class$="_handle"]` local-name rule」）会存活下来，
 * 被抽取器误当成声明。**全部 kind** 因此都在这个投影上抽取：`/* … *​/` 一律抹成
 * 空格（换行保留，行号可用；与 stripComments 同为等长投影）。
 *
 * 这个投影不是字符串感知的（CSS 注释语法里没有字符串），所以 TS 字符串里成对的
 * `/*…*​/` 也会被抹掉——抽取面宁可少不可多：注释里的锚点不是声明，而字符串里的
 * 选择器声明本就同时出现在真实选择器上。
 */
function stripCssCommentsKeepingLines(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\n]/g, ' '))
}

/**
 * 从一个文件的**双层去注释投影**里抽出全部锚点声明：先 TS 注释（字符串感知、保留
 * 行号），再过 CSS 注释投影（上面那个）。两层都逐字符等长，索引→行号映射仍然指回
 * 原始文件。
 *
 * @param {{ path: string, text: string }} source - 一个插件源码文件。
 * @returns {Array<{ kind: string, token: string, path: string, line: number, form: string }>}
 */
export function extractAnchorsFromSource(source) {
  const code = stripCssCommentsKeepingLines(stripCommentsKeepingLines(source.text))
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
  // 6. build-time 哈希 class token（`_root_38jqx_` / `_card_38jqx_`）：硬失败族（pin bump 必重锚）。
  //    与其它 kind 一样在 CSS 注释投影上抽——注释里的哈希提及不是声明（styles.ts）。
  for (const match of code.matchAll(/_[a-z][a-z0-9]*_[a-z0-9]{5,}_/g)) {
    push('hash', match[0], match.index, 'hash-token')
  }
  // 7. CSS-module 本地名（`[class$="_row"]` / `[class*="_row "]` / `[class*="_row_"]`
  //    三种生产形态）：哈希 token 一 bump 就变，本地名是唯一不受哈希漂移影响的
  //    残余锚。token 保留前导 `_`——类名里正是它与哈希衔接（`<hash>_row` / `_row_<hash>_<idx>`）。
  for (const match of code.matchAll(/\[class(?:\$|\*)=["\'](_[A-Za-z][A-Za-z0-9-]*)(?:[ _][^"\']*)?["\']\]/g)) {
    push('local-name', match[1], match.index, '[class…="_…"]')
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
 * 最小断言集的**声明侧**完整性（方向 B 的一半）：`declared: 'plugin'` 的每一项都必须
 * 在本插件源码里被抽到，否则红线（插件侧改名/删除，或该功能被移除）。
 *
 * 单独成函数的原因：这一半**不依赖上游锚点树**。调用方（verify-mobile-anchors.mjs）
 * 在没有锚点根时仍必须先跑它——否则「没物化上游树」会把本仓侧的改坏一起跳过，
 * 默认模式静默 exit 0 就成了假绿。`declared: 'external'` 只查上游发射侧，不在此列。
 *
 * @param {Array<{kind: string, token: string}>} anchors - 插件声明的锚点。
 * @param {Array<object>} [required] - 门禁要求的最小断言集。
 * @returns {{violations: string[], checked: number}} 违规文案与检查过的 plugin 项数。
 */
export function requiredDeclarationFindings(anchors, required = REQUIRED_ANCHORS) {
  const declaredKeys = new Set(anchors.map(anchor => `${anchor.kind}:${anchor.token}`))
  const violations = []
  let checked = 0
  for (const item of required) {
    if (item.declared !== 'plugin') continue
    checked += 1
    if (!declaredKeys.has(`${item.kind}:${item.token}`)) {
      violations.push(`最小断言集要求插件声明 ${item.kind} 锚点 ${item.token}，但源码里抽不到——插件侧改名/删除，或该锚点所属功能被移除`
        + `（后者应把本项与 docs/checklists/upstream-touchpoints.md §4 的登记行一起删）：${item.note}`)
    }
  }
  return { violations, checked }
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

/**
 * **对象键形**证据（`"data-x":` / `role: "dialog"` / `"data-slot": "x"`）的最小
 * 防伪：键的起点前（跳过空白）必须是 `{`、`,` 或 `(`。真实的 props 对象里，一个
 * 键只会出现在这三种边界之后（对象/调用参数的开头，或前一个属性之后）；把键形
 * 写进普通文案的那一类（`console.warn("legacy \"data-chat-flow\": true")`）
 * 引号前是单词字符，直接落选。
 *
 * **已知残余（有意不判）**：把整段对象形塞进字符串/模板字面量的文案在局部形态上
 * 与真键无法区分。注释由 stripCommentsKeepingLines 剥掉，但字符串不能剥（消费形
 * 与 renderSlot 的槽 key 本身就活在字符串里）。在本仓真实语料上做「命中是否在
 * 字符串内」的全量词法判断已被证伪：minified 产物里的正则字面量（`/[..."]/u`）
 * 会打乱朴素的引号计数，造成成片假红。故只做**局部边界**这一层，残余面交给
 * 写入形/消费形的分级与人工重锚承担。
 *
 * @param {RegExp} pattern - 对象键形判据（无 g 也可）。
 * @param {string} text - 文件文本。
 * @returns {boolean} 是否存在一个处于合法对象键边界的命中。
 */
function objectKeyEmits(pattern, text) {
  const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g')
  let match
  while ((match = global.exec(text)) !== null) {
    let at = match.index - 1
    while (at >= 0 && /\s/.test(text[at])) at -= 1
    if (at < 0 || '{,('.includes(text[at])) return true
    global.lastIndex = match.index + 1
  }
  return false
}

/** 按「写入形优先」取证据：有写入形就只报写入形，否则回落消费形（判定方决定
 *  这是硬失败还是可接受）。`emits` 是「这个文件有没有写入形」的完整判据。 */
function evidenceByStrength(files, emits, selectorPatterns) {
  const emissions = files.filter(file => emits(file)).map(file => file.path)
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
    file => {
      const patterns = attributeEmissionPatterns(token, { fileText: file.text, path: file.path })
      // patterns[0] 是对象键形；其余（set/toggle/removeAttribute、dataset、JSX 形）
      // 的形态本身就足够窄，不需要边界那一层。
      return objectKeyEmits(patterns[0], file.text) || patterns.slice(1).some(pattern => pattern.test(file.text))
    },
    attributeSelectorPatterns(token),
  )
}

/** role 锚点：写入形 / 消费形两份证据。 */
export function roleEvidence(files, role) {
  const patterns = roleEmissionPatterns(role)
  return evidenceByStrength(
    files,
    file => objectKeyEmits(patterns[0], file.text) || patterns[1].test(file.text),
    roleSelectorPatterns(role),
  )
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

/** slot 锚点：写入形 / 消费形两份证据。 */
export function slotEvidence(files, slot) {
  const [render, key, attribute] = slotEmissionPatterns(slot)
  return evidenceByStrength(
    files,
    file => render.test(file.text) || objectKeyEmits(key, file.text) || attribute.test(file.text),
    slotSelectorPatterns(slot),
  )
}

/**
 * local-name 锚点的**发射形**：上游产物的 CSS-module 类名字典，且必须是**哈希锚定**
 * 的完整类名（点号或引号开头），两种生产形态：
 *   - hash-first：`.zGbnIq_modelRow` / `"wSkVaW_crumbSeg"`（`<hash>_<local>`）；
 *   - local-first：`._row_1alm6_55`（`_<local>_<hash>_<idx>`）。
 * 哈希段除了 ≥5 个字符，还必须**含数字或大小写混合**（`[0-9]` / 相邻的
 * `[a-z][A-Z]` / `[A-Z][a-z]`）：只看长度时 `.table_row` / `.breakpoint_modelRow`
 * 这类「人类可读前缀 + 本地名」的静态类名同样是 ≥5 字符的 alnum 段，会被误当
 * hash-first 证据（假绿）。四个真实本地名的哈希段都满足这条：`1alm6`（数字）、
 * `zGbnIq` / `wSkVaW` / `EvIC1a`（大小写混合）。
 * 裸本地名（`"modelRow"`）只是模块内部标识，不证明哈希类被发射；`.foo_row` 这类
 * 「恰好以本地名结尾的人类可读类名」同样不算——旧判据的 `[A-Za-z0-9-]*` 前缀会
 * 把它误当 hash-first 证据（假绿），收窄后必须真的带哈希段。
 */
export function localNameEmissionPatterns(token) {
  const escaped = escapeRe(token)
  // 先卡长度与右边界，再要求段内有数字或相邻大小写变化，最后消费整段。
  const hash = String.raw`(?=[A-Za-z0-9]{5,}(?![A-Za-z0-9]))(?=[A-Za-z0-9]*(?:[0-9]|[a-z][A-Z]|[A-Z][a-z]))[A-Za-z0-9]{5,}`
  return [
    new RegExp(String.raw`(?:\.|["\'])${hash}${escaped}(?![A-Za-z0-9_-])`),
    new RegExp(String.raw`(?:\.|["\'])${escaped}_${hash}(?:_[0-9]+)?(?![A-Za-z0-9_-])`),
  ]
}

/** local-name 没有独立的消费形（插件侧声明本身就是选择器），返回空表。 */
export function localNameSelectorPatterns() { return [] }

/** local-name 锚点：类名字典命中 = 发射。 */
export function localNameEvidence(files, token) {
  const patterns = localNameEmissionPatterns(token)
  return evidenceByStrength(files, file => patterns.some(pattern => pattern.test(file.text)), localNameSelectorPatterns())
}

/**
 * SHAPE_RULES — 会话头形状的**有序 token + 括号平衡** tripwire（不是解析器）。
 *
 * 明确声明它不是解析器：只回答两个问题——
 *   1. 上游 ConversationHeader 是否仍以 `jsxs)("header", { … })` 的**对象字面量
 *      props** 渲染、且**在 `children:` 的值区间内**出现
 *      `renderSlot("conversation.session.header")`（会话头槽真的挂在 header 的
 *      children 里）；props 变量化（`jsxs)("header", props)`）时 `{` 不紧随调用，
 *      判据判红，而不是从后文某个 `{` 里"找到"槽；三种诱饵同样判红——children 值
 *      区间之外的 onRender 回调、config.deep、以及字符串字面量里的同文本；
 *   2. `renderSlot("conversation.header")`（持久会话头槽 = ConversationHeader 的挂载点）
 *      是否仍存在。
 * 值区间由三族括号的字符串感知配对（matchingDelimiter）给出，字符串里的假命中由
 * findSlotRender 剔掉；但模板字面量的 `${…}` 表达式不做解析，上游改写成动态
 * key/别处渲染时本 tripwire 会报红并要求人工重锚——这是有意的 fail-closed 方向，
 * 不是假阳。
 */
export const SHAPE_RULES = [
  'jsxs)("header" 的 children 内必须出现 renderSlot("conversation.session.header")',
  'dsh-client-ui-conversation 产物里必须存在 renderSlot("conversation.header")',
]

/**
 * 从 code[openIndex] 的**开括号**起做字符串感知的配对扫描；返回配对闭括号的下标，
 * 未闭合（或交叉嵌套）返回 -1。三种括号族都参与（`{}` / `[]` / `()`）：props 对象
 * 里的数组值（`children: [ … ]`）与嵌套对象/调用都靠它定位真实边界，否则从调用后
 * 第一个 `{` 起只数花括号会停在数组里第一个内层 `}` 上。
 */
function matchingDelimiter(code, openIndex) {
  const openers = '([{'
  const closers = ')]}'
  const stack = []
  let quote = null
  for (let i = openIndex; i < code.length; i += 1) {
    const ch = code[i]
    if (quote !== null) {
      if (ch === '\\') { i += 1; continue }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue }
    const openAt = openers.indexOf(ch)
    if (openAt !== -1) { stack.push(closers[openAt]); continue }
    if (closers.includes(ch)) {
      if (stack[stack.length - 1] !== ch) return -1 // 交叉嵌套：形状不再认识
      stack.pop()
      if (stack.length === 0) return i
    }
  }
  return -1
}

/**
 * index 是否落在字符串/模板字面量内部（字符串感知的向前扫描）。
 * 用于把「文案里的假命中」从**代码里的发射/渲染**里剔出去。
 */
function insideString(text, index) {
  let quote = null
  for (let i = 0; i < index; i += 1) {
    const ch = text[i]
    if (quote !== null) {
      if (ch === '\\') { i += 1; continue }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch
  }
  return quote !== null
}

/**
 * 在一个 props 对象字面量的内部区间里定位 `children:` 的**值区间**（返回相对该区间
 * 的 `[valueStart, valueEnd)`，定位不到返回 null）。只在顶层（相对深度 0）认这个键：
 * 嵌套对象/回调里的 `children` 不是本对象的 prop。值区间的边界由 matchingDelimiter
 * 给出（数组/对象/调用），标量值截到同层逗号。
 */
function childrenValueRange(region) {
  let colon = -1
  let depth = 0
  let quote = null
  for (let i = 0; i < region.length; i += 1) {
    const ch = region[i]
    if (quote !== null) {
      if (ch === '\\') { i += 1; continue }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue }
    if (ch === '(' || ch === '[' || ch === '{') { depth += 1; continue }
    if (ch === ')' || ch === ']' || ch === '}') { depth -= 1; continue }
    if (depth !== 0 || ch !== 'c') continue
    if (!region.startsWith('children', i)) continue
    if (i > 0 && /[\w$]/.test(region[i - 1])) continue
    const after = region[i + "children".length]
    if (after !== undefined && /[\w$]/.test(after)) continue
    const colonMatch = /^\s*:/.exec(region.slice(i + "children".length))
    if (colonMatch === null) continue
    colon = i + "children".length + colonMatch[0].length
    break
  }
  if (colon === -1) return null
  let start = colon
  while (start < region.length && /\s/.test(region[start])) start += 1
  if (start >= region.length) return null
  if ('([{'.includes(region[start])) {
    const end = matchingDelimiter(region, start)
    return end === -1 ? null : [start, end]
  }
  // 标量/引用值：扫到同层逗号或 props 对象结尾。
  let valueDepth = 0
  let valueQuote = null
  for (let i = start; i < region.length; i += 1) {
    const ch = region[i]
    if (valueQuote !== null) {
      if (ch === '\\') { i += 1; continue }
      if (ch === valueQuote) valueQuote = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') { valueQuote = ch; continue }
    if (ch === '(' || ch === '[' || ch === '{') { valueDepth += 1; continue }
    if (ch === ')' || ch === ']' || ch === '}') { valueDepth -= 1; continue }
    if (ch === ',' && valueDepth === 0) return [start, i]
  }
  return [start, region.length]
}

/**
 * 在 [from, to) 里找 `renderSlot("<slot>"`；字符串/模板字面量里的同文本是**文案**，
 * 不是渲染调用（`children: ["renderSlot(\"…\")"]` 这类诱饵不算）。
 * @returns {number} 命中下标，找不到返回 -1。
 */
function findSlotRender(text, slot, from = 0, to = text.length) {
  const pattern = new RegExp(String.raw`renderSlot\(\s*["']${escapeRe(slot)}["']`, 'g')
  pattern.lastIndex = from
  let match
  while ((match = pattern.exec(text)) !== null) {
    if (match.index >= to) return -1
    if (!insideString(text, match.index)) return match.index
    pattern.lastIndex = match.index + 1
  }
  return -1
}

/**
 * {@link SHAPE_RULES} 的扫描实现（纯函数，夹具可测）。
 * @param {Array<{path: string, text: string}>} files - dsh-client-ui-conversation 产物。
 * @returns {{violations: string[], notes: string[]}}
 */
export function conversationHeaderShapeFindings(files) {
  const violations = []
  const notes = []
  const projected = files.map(file => ({ path: file.path, text: stripCommentsKeepingLines(file.text) }))
  let headerCalls = 0
  let objectPropsCalls = 0
  let ordered = 0
  for (const file of projected) {
    const code = file.text
    const call = /jsxs\)\(\s*["\']header["\']/g
    let match
    while ((match = call.exec(code)) !== null) {
      headerCalls += 1
      // props 必须是**紧随调用**的对象字面量：调用与 `{` 之间只允许空白/逗号/换行。
      // 旧写法从调用之后的第一个 `{` 起做括号平衡——props 变量化
      //（`jsxs)("header", props)`）时那个 `{` 落在无关作用域里，只要后文出现过
      // children + renderSlot 就算命中：这正是「形状判据被 props 变量化绕过」的假绿。
      const props = /^\s*,\s*\{/.exec(code.slice(match.index + match[0].length))
      if (props === null) {
        violations.push(`SHAPE_RULE 1：第 ${headerCalls} 个 \`jsxs)("header"\` 调用的 props 不是紧随其后的对象字面量`
          + '（调用与 `{` 之间只允许空白/逗号/换行；props 变量化或包裹调用都判红）——'
          + '会话头槽的形状无法确认，按 design 17 §18.4.3 重锚')
        continue
      }
      objectPropsCalls += 1
      const open = match.index + match[0].length + props[0].length - 1
      const end = matchingDelimiter(code, open)
      if (end === -1) {
        violations.push(`SHAPE_RULE 1：第 ${headerCalls} 个 \`jsxs)("header"\` 的对象字面量括号不平衡——产物被截断或形状变了`)
        continue
      }
      const region = code.slice(open + 1, end)
      // 判据是**包含**：槽必须在 `children:` 的**值区间**里渲染。旧写法只比较两个
      // 下标的先后（children 在槽之前就算命中），于是 `children: []` + 后面的
      // onRender 回调 / config.deep / 文案字符串都能把形状判据骗绿；值区间由
      // matchingDelimiter 给出，字符串里的假命中由 findSlotRender 剔掉。
      const children = childrenValueRange(region)
      if (children === null) continue
      const slotAt = findSlotRender(region, 'conversation.session.header', children[0], children[1])
      if (slotAt !== -1) ordered += 1
    }
  }
  const baseSlot = /renderSlot\(\s*["\']conversation\.header["\']/
  const hasBaseSlot = projected.some(file => baseSlot.test(file.text))
  if (headerCalls === 0) {
    violations.push('SHAPE_RULE 1：在 dsh-client-ui-conversation 产物里找不到 `jsxs)("header"` 调用——ConversationHeader 的渲染形状变了（design 17 §18.4.3 需按新形状重锚）')
  } else if (ordered === 0) {
    violations.push(`SHAPE_RULE 1：找到 ${headerCalls} 个 \`jsxs)("header"\` 调用（其中 props 是对象字面量的 ${objectPropsCalls} 个），但没有一个在 children 内渲染 renderSlot("conversation.session.header")——会话头槽被移出/删除`)
  } else {
    notes.push(`SHAPE_RULE 1：${ordered}/${headerCalls} 个 jsxs)("header" 的 children 内含 conversation.session.header slot`)
  }
  if (!hasBaseSlot) {
    violations.push('SHAPE_RULE 2：dsh-client-ui-conversation 产物里找不到 renderSlot("conversation.header"——持久会话头槽（ConversationHeader 挂载点）消失')
  } else {
    notes.push('SHAPE_RULE 2：renderSlot("conversation.header") 存在')
  }
  return { violations, notes }
}

/**
 * 一条锚点在语料里的命中文件（证据），按 kind 用不同形态匹配。
 *
 * @param {Array<{ path: string, text: string }>} files - 上游产物/仓内发射方。
 * @param {{ kind: string, token: string }} anchor
 * @returns {string[]} 命中的文件路径（去重，稳定顺序）。
 */
export function anchorEvidence(files, anchor) {
  // attribute / role / slot / local-name 走同一套「写入形优先」的两级判定；hash
  // token 只有字面量一种形态（零命中同样是硬失败：pin 一动必变，必须重锚）。
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
  if (anchor.kind === 'local-name') {
    const { emissions, selectors } = localNameEvidence(files, anchor.token)
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
  if (anchor.kind === 'local-name') return localNameEvidence(files, anchor.token)
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
    : '零命中（连消费方证据都没有）'
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

  // ---- SHAPE_RULES：会话头形状 tripwire（上游 ConversationHeader 重锚触发） ----
  const conversationFiles = upstream.filter(file => /(?:^|\/)dsh-client-ui-conversation\//.test(file.path))
  if (conversationFiles.length === 0) {
    advisories.push('SHAPE_RULES 未执行：上游语料里没有 dsh-client-ui-conversation 产物——会话头形状 tripwire 需要该 client 半（严格模式请把完整树物化后再跑）')
  } else {
    const shape = conversationHeaderShapeFindings(conversationFiles)
    violations.push(...shape.violations)
    notes.push(...shape.notes)
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
    // HARD_KINDS 覆盖抽取器的全部 kind，所以零命中直接判红；旧版「hash 零命中只
    // advisory」的分支已删除——它不可达，且正是 pin bump 后静默 no-op 的来源。
    const proof = evidence.emissions.length > 0 ? evidence.emissions : evidence.selectors
    rows.push({
      ...anchor,
      category,
      verdict: evidence.emissions.length > 0 ? 'ok' : 'missing',
      evidence: proof,
    })
    if (evidence.emissions.length === 0) {
      violations.push(noEmissionMessage(anchor, where, `${anchor.kind} 锚点`, '上游产物', evidence.selectors))
    }
  }

  // ---- 方向 B：门禁要求的最小集 → 插件声明 + 上游发射 ----
  // 声明侧与发射侧拆开：声明侧（requiredDeclarationFindings）不依赖上游语料，
  // 调用方可在锚点根缺失时先跑它；这里合并两者，语义不变。
  violations.push(...requiredDeclarationFindings(anchors, required).violations)
  for (const item of required) {
    // 与方向 A 同一条强度规则：只有**写入形**才算「上游还在发射」，选择器/CSS 是
    // 消费方证据，不能单独支撑最小断言集。
    const strength = strengthOf(upstream, item)
    // 同上：HARD_KINDS 全覆盖，最小断言集里不存在「零命中降 advisory」的分支。
    if (strength.emissions.length === 0) {
      violations.push(strength.selectors.length > 0
        ? noEmissionMessage(item, '最小断言集', `${item.kind} 锚点`, '上游产物', strength.selectors, `声明侧=${item.declared}`)
        : `最小断言集要求上游发射 ${item.kind} 锚点 ${item.token}，但产物里零命中（${item.note}；声明侧=${item.declared}）`)
    }
  }

  const declaredUpstream = rows.filter(row => row.category === 'upstream')
  const hashRows = rows.filter(row => row.kind === 'hash')
  notes.push(`方向 A：插件声明 ${declaredUpstream.length} 个上游锚点（去重后），零命中 ${declaredUpstream.filter(row => row.verdict === 'missing').length} 个；`
    + `chamber 自有 ${rows.filter(row => row.category === 'chamber-own').length} 个（不查上游）、跨包 ${rows.filter(row => row.category === 'chamber-cross-package').length} 个、`
    + `哈希 token ${hashRows.length} 个（硬失败：零命中 ${hashRows.filter(row => row.verdict !== 'ok').length} 个）`)
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
