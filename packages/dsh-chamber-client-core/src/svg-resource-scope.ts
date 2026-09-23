/**
 * 文档级 SVG 资源 id 归属（N-ctx 绘制不变量；设计侧 design 05 §4.2）。
 *
 * 缺陷：上游图标组件（@deepseek-ai/dsh-client-ui-primitives）把 Figma 导出 id 写死
 * 在组件里（IconSettingsOutline16=clip0_1450_63327、BrandWordmark 的 whale/badge
 * clip、IconAgentPresetOutline16 的 mask 等），而 url(#id) 是**文档级**解析；N-ctx
 * 在同一个文档里挂载多个实例壳，同一 id 因此被逐壳重复定义。
 *
 * macOS WKWebView 的行为：文档内出现第二份带同名 id 的壳子树后，**新建**图标首次
 * 绘制若解析到未布局子树（instance-hidden / instance-pending）里的 clipper/mask，
 * WebKit 会整块失绘并把结果缓存住（重建元素才自愈，属性回写/揭示都不行）；改名同一
 * 子树里的 id 即可避免这一失绘。因此本模块**让每个 <svg> 自足**：把它「自己定义 +
 * 自己引用」的资源 id 改名为文档唯一 token，引用一起改；若它引用的定义在**别的** svg
 * 里（混合 sprite），把那份定义**复制**进本 svg（消费侧自足化，连同它内部再引用的
 * 定义做传递闭包），外部引用因此永不悬空。
 *
 * 边界（刻意保守，宁可少改）：
 * - 只改名「本 <svg> 内定义（id=）且本 <svg> 内被引用（url(#…) 或 href="#…"）」的 id；
 * - 被 a11y 引用（aria-labelledby/aria-describedby/for）或被**样式表**引用（文档级
 *   <style>、同源 CSSOM、svg 内嵌 <style> 的 url(#…)）的 id 一律保留原名：改名会断
 *   开这些引用，而它们不在本模块的重写面内；
 * - 同一批不重复处理：`data-chamber-svg-scope` 标记 + WeakSet 身份兜住重复插入与 React
 *   重排；克隆件不在集合里 ⇒ 用新 token 重做；已 scoped 的 svg 里后补 id/引用会重扫该 svg；
 * - 根 `<svg>` 自身的 id 不改（上游图标不起根 id，外部代码/CSS 更可能按它寻址）；
 * - 嵌套 <svg> 自成作用域（安装器会下钻收集内层 svg）；
 * - 已 scoped 的 svg 里**后补**进新 id/引用（innerHTML 替换、插件追加）会触发该 svg
 *   重扫；直接改属性（不改 childList）不重扫。
 *
 * 安装点：main.tsx 在建 React root 之前调用一次 {@link installSvgResourceScope}；
 * 它观察 document.body 的新增子树（壳与 portal 都覆盖），批处理跑在微任务检查点 ——
 * 必须在首次绘制之前完成改名（见 SvgResourceScopeDeps.schedule）。
 */

/** 处理过的 <svg> 上的标记属性（值 = 该 svg 的 token）；身份判定以 WeakSet 为准。 */
export const SVG_SCOPE_ATTRIBUTE = 'data-chamber-svg-scope'

/**
 * 承载资源引用的属性面。刻意**不**包含 aria-* / for / class / data-*：那些不是
 * SVG 资源引用，改名会破坏 a11y 与 React 托管属性。
 */
const RESOURCE_REFERENCE_ATTRIBUTES = [
  'clip-path',
  'mask',
  'filter',
  'fill',
  'stroke',
  'marker-start',
  'marker-mid',
  'marker-end',
  'style',
] as const

/** 同文档引用另一元素的属性（<use href="#…"> 等）。 */
const HREF_ATTRIBUTES = ['href', 'xlink:href'] as const

/**
 * 只有这些元素把 href="#…" 当**资源**引用：<a href="#dom-id"> 是文档链接，不是资源面，
 * 既不改写也不复制（否则会把任意 DOM 拷进 svg）。
 */
const HREF_RESOURCE_ELEMENTS = [
  'use', 'textpath', 'mpath', 'feimage', 'image', 'pattern',
  'lineargradient', 'radialgradient', 'filter', 'clippath', 'mask', 'marker',
] as const

/**
 * 可以被复制进消费方 svg 的「永不直接渲染」定义元素；<use> 指向的可渲染元素（<g>/<path>）
 * 不在内——复制它会重复绘制，且它不是资源定义。
 */
const DEFINITION_ELEMENTS = [
  'clippath', 'mask', 'filter', 'marker', 'pattern',
  'lineargradient', 'radialgradient', 'meshgradient', 'symbol',
] as const

/** 一次 flush 里最多复制多少份外部定义（传递闭包的预算，防御病态图）。 */
const MAX_COPY_BUDGET = 8

/** resolveDefinition 沿改名链最多追几跳（重扫会把同一个作者 id 连续改名）。 */
const RESOLVE_HOP_LIMIT = 4

/** 引用了元素 id 的 a11y/表单属性：命中即保留原名（不在本模块重写面内）。 */
const ID_REFERENCE_ATTRIBUTES = ['aria-labelledby', 'aria-describedby', 'for'] as const

/** 样式表元素（svg 内嵌或文档级）：其中的 url(#…) 都是文档级引用面。 */
const STYLE_ELEMENT = 'style'

/**
 * 本模块用过的 token 前缀（默认 + 每次安装注入的）：重扫/克隆时剥掉旧前缀，id 形状不增长。
 * 只记前缀而不记具体 token，是因为同一文档可能装过多个 module 副本（各自前缀）。
 * **有意不随 disposer/reset 清空**：清掉会让已 scoped 的 id 在下次重扫时叠前缀；代价是显式
 * 注入的前缀会成为一条永久剥离规则（调用方只应使用 `chamber-*` 命名空间）。
 */
const activeTokenPrefixes = new Set<string>(['chamber-csvg'])

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// url(#id) / url( '#id' )；函数名大小写不敏感（CSS 函数名如此），引号成对且捕获两侧
// 空白原样保留；id 字符集排除空白与引号/括号（`url(#a b)` 这类无效 CSS 不再被当引用）。
const URL_REFERENCE_PATTERN = /(url)\((\s*)([\x27\x22]?)#([^\s\x27\x22)]+?)\3(\s*)\)/gi

const scopeTokens = { value: 0 }

/** 安装者序号写在观察根上：同一文档出现两份模块副本时 token 仍互不相同。 */
const SVG_SCOPE_SEQUENCE_ATTRIBUTE = 'data-chamber-svg-scope-seq'

/**
 * 本模块已经改名过的 <svg>。用 WeakSet 而不是「带标记即跳过」：
 * cloneNode(true) 会把标记属性和 token 一起复制，克隆件因此「看起来已处理」——
 * 若直接跳过，它就和原件同名，重复 id 又回来了。
 */
let scopedSvgs = new WeakSet<Element>()

/**
 * 模块自己 append 进文档的节点（外部定义的副本）：observer 会把它们当作新增子树报回来，
 * 若不认领就会触发「重扫 → 再次复制 → 再回灌」的自激循环（每轮新 token，预算只按次生效）。
 */
let selfProducedNodes = new WeakSet<Node>()

/** 已应用的改名（原 id → 现 id）：消费侧解析被改名过的外部定义时用。 */
const renamedResourceIds = new Map<string, string>()

/** 被样式表引用的 id（文档级 <style> / 同源 CSSOM / svg 内嵌 <style>）：保留原名。 */
const documentPreservedIds = new Set<string>()

/** 测试与热更新用：清掉模块级的记忆（token 计数器除外）。 */
export function resetSvgResourceScopeMemory(): void {
  renamedResourceIds.clear()
  documentPreservedIds.clear()
  scopedSvgs = new WeakSet<Element>()
  selfProducedNodes = new WeakSet<Node>()
}

function claimScopeSequence(root: ParentNode): number {
  const host = root as unknown as Element
  if (typeof host.getAttribute !== 'function' || typeof host.setAttribute !== 'function') return 1
  const current = Number(host.getAttribute(SVG_SCOPE_SEQUENCE_ATTRIBUTE))
  const next = Number.isInteger(current) && current > 0 ? current + 1 : 1
  host.setAttribute(SVG_SCOPE_SEQUENCE_ATTRIBUTE, String(next))
  return next
}

/** 下一个文档唯一 token（前缀可注入，便于测试与日志辨认）。 */
export function nextSvgScopeToken(prefix = 'csvg'): string {
  scopeTokens.value += 1
  return prefix + scopeTokens.value
}

/** 纯函数：剥掉本模块自己（任一次安装）的旧 token 前缀，重扫/克隆时保持 id 形状稳定。 */
export function stripOwnScopePrefix(id: string): string {
  for (const prefix of activeTokenPrefixes) {
    const scoped = new RegExp('^' + escapeForRegExp(prefix) + '\\d+-')
    if (scoped.test(id)) return id.replace(scoped, '')
  }
  return id
}

/** 纯函数：取出一个属性值里的全部 url(#…) 目标 id（保持出现顺序，允许重复）。 */
export function urlReferenceIds(value: string): readonly string[] {
  const ids: string[] = []
  URL_REFERENCE_PATTERN.lastIndex = 0
  let match = URL_REFERENCE_PATTERN.exec(value)
  while (match !== null) {
    ids.push((match[4] as string).trim())
    match = URL_REFERENCE_PATTERN.exec(value)
  }
  URL_REFERENCE_PATTERN.lastIndex = 0
  return ids
}

/** 纯函数：把一个属性值里的 url(#old) 换成 url(#new)（未登记的原样保留）。 */
export function rewriteUrlReferences(value: string, renames: ReadonlyMap<string, string>): string {
  URL_REFERENCE_PATTERN.lastIndex = 0
  const next = value.replace(URL_REFERENCE_PATTERN, (match, name: string, leading: string, quote: string, id: string, trailing: string) => {
    const renamed = renames.get(id.trim())
    return renamed === undefined ? match : name + '(' + leading + quote + '#' + renamed + quote + trailing + ')'
  })
  URL_REFERENCE_PATTERN.lastIndex = 0
  return next
}

/** 纯函数：重命名计划 = 本 svg 内「定义 ∩ 引用」减去保留集。 */
export function resourceRenamePlan(
  definedIds: Iterable<string>,
  referencedIds: Iterable<string>,
  token: string,
  preservedIds: Iterable<string> = [],
): ReadonlyMap<string, string> {
  const referenced = new Set(referencedIds)
  const preserved = new Set(preservedIds)
  const renames = new Map<string, string>()
  const targets = new Set<string>()
  for (const id of definedIds) {
    if (id === '' || !referenced.has(id) || preserved.has(id)) continue
    const base = token + '-' + stripOwnScopePrefix(id)
    let target = base
    for (let suffix = 1; targets.has(target) || target === id; suffix += 1) target = base + '-' + String(suffix)
    targets.add(target)
    renames.set(id, target)
  }
  return renames
}

function localNameOf(element: Element): string {
  return (element.localName ?? element.tagName ?? '').toLowerCase()
}

function isSvgElement(element: Element): boolean {
  return localNameOf(element) === 'svg'
}

function isStyleElement(element: Element): boolean {
  return localNameOf(element) === STYLE_ELEMENT
}

function isListed(names: readonly string[], element: Element): boolean {
  return names.includes(localNameOf(element))
}

/** 一个 svg 自身内容的四类事实（跳过嵌套 <svg> 的内容，它自成作用域）。 */
interface ScopeFacts {
  readonly defined: string[]
  readonly referenced: string[]
  readonly preserved: string[]
}

function collectScopeFacts(svg: Element): ScopeFacts {
  const defined: string[] = []
  const referenced: string[] = []
  const preserved: string[] = []
  const stack: Element[] = [svg]
  while (stack.length > 0) {
    const element = stack.pop() as Element
    // 根 <svg> 自身的 id 不改：上游图标不起根 id，而外部代码/CSS 更可能按它寻址。
    if (element !== svg) {
      const id = element.getAttribute('id')
      if (id !== null && id !== '') defined.push(id)
    }
    for (const name of RESOURCE_REFERENCE_ATTRIBUTES) {
      const value = element.getAttribute(name)
      if (value === null || value.toLowerCase().indexOf('url(') < 0) continue
      for (const reference of urlReferenceIds(value)) referenced.push(reference)
    }
    if ((HREF_RESOURCE_ELEMENTS as readonly string[]).includes(localNameOf(element))) {
      for (const name of HREF_ATTRIBUTES) {
        const value = element.getAttribute(name)
        if (value !== null && value.charAt(0) === '#') referenced.push(value.slice(1))
      }
    }
    for (const name of ID_REFERENCE_ATTRIBUTES) {
      const value = element.getAttribute(name)
      if (value === null) continue
      for (const id of value.split(/\s+/)) if (id !== '') preserved.push(id)
    }
    // svg 内嵌 <style> 的 url(#…) 同样按「保留」处理：样式表是文档级作用域，改名会
    // 改变它的语义，而要改写它就得替换 React 追踪的文本节点（宁可少改）。
    if (isStyleElement(element)) {
      const css = element.textContent
      if (css !== null && css.toLowerCase().indexOf('url(') >= 0) {
        for (const reference of urlReferenceIds(css)) preserved.push(reference)
      }
    }
    const children = element.children
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index] as Element
      if (isSvgElement(child)) continue
      stack.push(child)
    }
  }
  return { defined, referenced, preserved }
}

/** 把一个改名表写进 svg 自身内容（引用与定义成对；跳过嵌套 <svg>）。 */
function applyRenames(svg: Element, renames: ReadonlyMap<string, string>): void {
  if (renames.size === 0) return
  const stack: Element[] = [svg]
  while (stack.length > 0) {
    const element = stack.pop() as Element
    const id = element.getAttribute('id')
    if (id !== null && renames.has(id)) element.setAttribute('id', renames.get(id) as string)
    for (const name of RESOURCE_REFERENCE_ATTRIBUTES) {
      const value = element.getAttribute(name)
      if (value === null || value.toLowerCase().indexOf('url(') < 0) continue
      const next = rewriteUrlReferences(value, renames)
      if (next !== value) element.setAttribute(name, next)
    }
    if ((HREF_RESOURCE_ELEMENTS as readonly string[]).includes(localNameOf(element))) {
      for (const name of HREF_ATTRIBUTES) {
        const value = element.getAttribute(name)
        if (value === null || value.charAt(0) !== '#') continue
        const renamed = renames.get(value.slice(1))
        if (renamed !== undefined) element.setAttribute(name, '#' + renamed)
      }
    }
    const children = element.children
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index] as Element
      if (isSvgElement(child)) continue
      stack.push(child)
    }
  }
}

/**
 * 在文档里查一个 id（消费侧解析外部定义用；没有 document 面时返回 null）。
 * 作者 id 可能被改名多次（重扫/克隆），因此沿重命名链追到当前 id（跳数有上限）。
 */
function resolveDefinition(svg: Element, id: string): Element | null {
  let candidate = id
  for (let hop = 0; hop < RESOLVE_HOP_LIMIT; hop += 1) {
    const found = lookupDocumentId(svg, candidate)
    if (found !== null) return found
    const next = renamedResourceIds.get(candidate)
    if (next === undefined || next === candidate) return null
    candidate = next
  }
  return null
}

function lookupDocumentId(svg: Element, id: string): Element | null {
  const doc = svg.ownerDocument as Document | null | undefined
  if (doc === null || doc === undefined || typeof doc.getElementById !== 'function') return null
  return doc.getElementById(id)
}

/**
 * 消费侧自足化：本 svg 引用了**别的 svg** 里的定义时，把那份定义（连同它自己再引用的
 * 外部定义，传递闭包、深度受预算保护）复制进本 svg 并改用副本 id。副本内部 id 与引用
 * 成对改名 ⇒ 副本自身也是自足的。
 * 定义者那边保持原样，别处的引用同样不悬空。
 * @returns 原 id → 副本 id（供引用重写）。
 */
function copyExternalDefinitions(svg: Element, ids: readonly string[], token: string): Map<string, string> {
  const copies = new Map<string, string>()
  const queue: { id: string; depth: number }[] = ids.map(id => ({ id, depth: 1 }))
  let budget = MAX_COPY_BUDGET
  while (queue.length > 0 && budget > 0) {
    const item = queue.shift() as { id: string; depth: number }
    if (copies.has(item.id)) continue
    const definition = resolveDefinition(svg, item.id)
    if (definition === null || definition === svg) continue
    if (!isCopyableDefinition(definition)) continue
    if (typeof definition.cloneNode !== 'function') continue
    budget -= 1
    const clone = definition.cloneNode(true) as Element
    // 副本内部自足：内部**全部** id 都换成本 svg 的命名空间（不只是被引用的那些），
    // 这样复制不会往文档里再塞一份同名定义；引用仍成对改写（根 id 由外层映射接管）。
    const innerFacts = collectScopeFacts(clone)
    const innerToken = token + '-i' + String(copies.size + 1)
    const innerPlan = resourceRenamePlan(
      innerFacts.defined, innerFacts.defined, innerToken, [...innerFacts.preserved, ...documentPreservedIds],
    )
    if (innerPlan.size > 0) applyRenames(clone, innerPlan)
    // 只有「永不直接渲染」的定义元素可以落在不包 <defs> 的 svg 根上。
    const copyId = token + '-x' + String(copies.size + 1) + '-' + stripOwnScopePrefix(item.id)
    clone.setAttribute('id', copyId)
    ;(directDefsChild(svg) ?? svg).appendChild(clone)
    selfProducedNodes.add(clone)
    copies.set(item.id, copyId)
    renamedResourceIds.set(item.id, copyId)
    if (item.depth < 2) {
      for (const inner of collectExternalIdsIn(clone, svg)) queue.push({ id: inner, depth: item.depth + 1 })
    }
  }
  return copies
}

/** 副本/消费方里仍指向 svg 之外的定义（= 需要继续拷入的 id）。 */
function collectExternalIdsIn(node: Element, svg: Element): string[] {
  const defined = new Set(collectScopeFacts(svg).defined)
  const facts = collectScopeFacts(node)
  const out = new Set<string>()
  for (const id of facts.referenced) if (id !== '' && !defined.has(id) && !documentPreservedIds.has(id)) out.add(id)
  return [...out]
}

/** 定义元素 + 位于某个 svg 内（防止把 body 的 DOM 拷进 svg）。 */
function isCopyableDefinition(definition: Element): boolean {
  if (!isListed(DEFINITION_ELEMENTS, definition)) return false
  let current: Node | null = definition.parentNode
  while (current !== null) {
    if ((current as { nodeType?: number }).nodeType === 1 && isSvgElement(current as Element)) return true
    current = current.parentNode
  }
  return false
}

function directDefsChild(svg: Element): Element | null {
  const children = svg.children
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index] as Element
    if (child !== svg && (child.localName ?? '').toLowerCase() === 'defs') return child
  }
  return null
}

/**
 * 让一个 <svg> 自足：自己定义且自己引用的资源 id 改名；引用的外部定义复制进来。
 * 已处理过（标记 + WeakSet）的 svg 直接返回 0 —— 幂等。
 * @returns 实际改动数（改名 + 复制；测试与诊断用）。
 */
export function scopeSvgElement(svg: Element, token = nextSvgScopeToken()): number {
  if (svg.getAttribute(SVG_SCOPE_ATTRIBUTE) !== null) {
    if (scopedSvgs.has(svg)) return 0
    // 带标记但不是本模块处理过的节点 = 克隆件：标记与 token 被一起复制了。
    svg.removeAttribute(SVG_SCOPE_ATTRIBUTE)
  }
  return applyScopeToSvg(svg, token)
}

/** 已 scoped 的 svg 里后补了新内容时的重扫（同一套规则，强制再来一遍）。 */
function rescanSvgElement(svg: Element, token: string): number {
  if (!scopedSvgs.has(svg)) return scopeSvgElement(svg, token)
  svg.removeAttribute(SVG_SCOPE_ATTRIBUTE)
  return applyScopeToSvg(svg, token)
}

function applyScopeToSvg(svg: Element, token: string): number {
  const { defined, referenced, preserved } = collectScopeFacts(svg)
  const preservedAll = new Set<string>([...preserved, ...documentPreservedIds])
  const renames = resourceRenamePlan(defined, referenced, token, preservedAll)
  if (renames.size > 0) {
    applyRenames(svg, renames)
    for (const [from, to] of renames) {
      // 指向这个旧 id 的条目一并推进，避免重扫后只剩一跳的陈旧映射。
      for (const [key, value] of renamedResourceIds) if (value === from) renamedResourceIds.set(key, to)
      renamedResourceIds.set(from, to)
    }
  }
  const definedSet = new Set(defined)
  const externallyReferenced = [...new Set(referenced)]
    .filter(id => id !== '' && !definedSet.has(id) && !renames.has(id) && !preservedAll.has(id))
  const copies = copyExternalDefinitions(svg, externallyReferenced, token)
  if (copies.size > 0) applyRenames(svg, copies)
  svg.setAttribute(SVG_SCOPE_ATTRIBUTE, token)
  scopedSvgs.add(svg)
  return renames.size + copies.size
}

/** 新增子树里是否插入了样式表（<style> 或 <link>）。 */
function containsStyleSheet(node: Element): boolean {
  const name = (node.localName ?? node.tagName ?? '').toLowerCase()
  if (name === STYLE_ELEMENT || name === 'link') return true
  const children = node.children
  for (let index = 0; index < children.length; index += 1) {
    if (containsStyleSheet(children[index] as Element)) return true
  }
  return false
}

function collectSvgElements(node: Element, out: Element[]): void {
  if (isSvgElement(node)) {
    // 仍要下钻：嵌套 <svg> 自成作用域、需要自己的 token；只 push 不继续会让内层永不被处理。
    out.push(node)
  }
  const children = node.children
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index] as Element
    collectSvgElements(child, out)
  }
}

/** 新增子树里是否带 id / 资源引用（决定要不要重扫它所在的已 scoped svg）。 */
function introducesResourceContent(node: Element): boolean {
  const stack: Element[] = [node]
  while (stack.length > 0) {
    const element = stack.pop() as Element
    const id = element.getAttribute('id')
    if (id !== null && id !== '') return true
    for (const name of RESOURCE_REFERENCE_ATTRIBUTES) {
      const value = element.getAttribute(name)
      if (value !== null && value.toLowerCase().indexOf('url(') >= 0) return true
    }
    if (isListed(HREF_RESOURCE_ELEMENTS, element)) {
      for (const name of HREF_ATTRIBUTES) {
        const value = element.getAttribute(name)
        if (value !== null && value.charAt(0) === '#') return true
      }
    }
    const children = element.children
    for (let index = 0; index < children.length; index += 1) {
      stack.push(children[index] as Element)
    }
  }
  return false
}

/** 最近的、已由本模块 scoped 的祖先 <svg>（用于后补内容的宿主重扫）。 */
function nearestScopedAncestorSvg(node: Element): Element | null {
  let current: Node | null = node
  while (current !== null) {
    if ((current as { nodeType?: number }).nodeType === 1) {
      const element = current as Element
      if (isSvgElement(element)) return scopedSvgs.has(element) ? element : null
    }
    current = current.parentNode
  }
  return null
}

/** 观察面：只要求 disconnect（真实 MutationObserver 结构上满足）。 */
export interface SvgScopeObserver {
  disconnect(): void
}

/** 观察记录面：只读 addedNodes（真实 MutationRecord 结构上满足）。 */
export interface SvgScopeRecord {
  readonly addedNodes: ArrayLike<Node>
}

export interface SvgResourceScopeDeps {
  /** 观察根；默认 document.body（实例壳与 portal 到 body 的浮层都在其下）。 */
  readonly root?: ParentNode
  /** 观察器工厂；测试注入假实现。默认 MutationObserver(childList+subtree)。 */
  readonly observe?: (
    target: Node,
    callback: (records: readonly SvgScopeRecord[]) => void,
  ) => SvgScopeObserver
  /**
   * 批处理调度；默认微任务（queueMicrotask）。
   *
   * 必须是「首次绘制之前」的钩子：新图标的第一次绘制若解析到坏 clipper，失绘结果会
   * 被缓存，之后再改名也救不回来（属性回写与揭示都不自愈），所以改名
   * 机会只有插入后的同一个微任务检查点。因此**刻意不用 requestAnimationFrame**——
   * 它在被遮挡/后台的 WebView 里会被节流甚至不触发，
   * 那会让图标先绘制、再改名，等于没修。
   */
  readonly schedule?: (run: () => void) => void
  /** token 前缀（测试可读性用）。只应使用 `chamber-*` 命名空间：前缀会被登记为永久剥离规则。 */
  readonly tokenPrefix?: string
}

function defaultObserve(
  target: Node,
  callback: (records: readonly SvgScopeRecord[]) => void,
): SvgScopeObserver {
  const native = new MutationObserver(records => { callback(records) })
  native.observe(target, { childList: true, subtree: true })
  return native
}

function defaultSchedule(run: () => void): void {
  // 微任务：与触发插入的那个任务同一个检查点，先于首次绘制（见 SvgResourceScopeDeps.schedule）。
  queueMicrotask(run)
}

function isElementNode(node: Node): node is Element {
  return (node as { nodeType?: number }).nodeType === 1
}

/**
 * 把一棵子树里的 a11y/表单 id 引用记进**文档级**保留集：引用方与定义方常在不同的 svg 里，
 * 只在本地保留会让定义方改名后断链。
 */
function rememberReferenceIds(node: Element): void {
  const stack: Element[] = [node]
  while (stack.length > 0) {
    const element = stack.pop() as Element
    for (const name of ID_REFERENCE_ATTRIBUTES) {
      const value = element.getAttribute(name)
      if (value === null) continue
      for (const id of value.split(/\s+/)) if (id !== '') documentPreservedIds.add(id)
    }
    const children = element.children
    for (let index = 0; index < children.length; index += 1) stack.push(children[index] as Element)
  }
}

/** 记住样式表引用的 id（文档级 <style> + 同源 CSSOM 尽力而为）。 */
function rememberDocumentStyleIds(root: ParentNode): void {
  const doc = (root as Element).ownerDocument ?? (globalThis as { document?: Document }).document ?? null
  const host = (doc ?? root) as Document | ParentNode
  const query = (host as ParentNode).querySelectorAll
  if (typeof query === 'function') {
    for (const style of (host as ParentNode).querySelectorAll('style')) {
      const css = style.textContent
      if (css !== null && css !== undefined && css.toLowerCase().indexOf('url(') >= 0) {
        for (const id of urlReferenceIds(css)) documentPreservedIds.add(id)
      }
    }
  }
  const sheets = (doc as Document | null)?.styleSheets
  if (sheets === null || sheets === undefined) return
  for (let index = 0; index < sheets.length; index += 1) {
    try {
      walkCssRules(sheets[index]?.cssRules ?? null)
    } catch {
      // 跨源样式表拒绝读取：尽力而为，读不到就不保留。
    }
  }
}

function walkCssRules(rules: CSSRuleList | null): void {
  if (rules === null) return
  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index] as CSSRule & { cssRules?: CSSRuleList }
    const text = typeof rule.cssText === 'string' ? rule.cssText : ''
    if (text.toLowerCase().indexOf('url(') >= 0) {
      for (const id of urlReferenceIds(text)) documentPreservedIds.add(id)
    }
    if (rule.cssRules !== undefined) walkCssRules(rule.cssRules)
  }
}

/**
 * 安装文档级 SVG 资源 id 保护。幂等边界：调用方只装一次（main.tsx 模块作用域），
 * 返回的 disposer 供测试与热更新路径拆除。
 */
export function installSvgResourceScope(deps: SvgResourceScopeDeps = {}): () => void {
  const root = deps.root ?? document.body
  const tokenPrefix = deps.tokenPrefix ?? 'chamber-csvg' + String(claimScopeSequence(root))
  activeTokenPrefixes.add(tokenPrefix)
  const schedule = deps.schedule ?? defaultSchedule
  const observe = deps.observe ?? defaultObserve

  const pending = new Set<Element>()
  let scheduled = false
  let active = true
  const watchedLinks = new WeakSet<Element>()
  const linkHandlers: { element: Element; handler: () => void }[] = []

  /** 给本实例新插入的 <link> 挂一次性 load 监听：样式表加载完才能读 CSSOM。 */
  const watchStyleSheetLinks = (node: Element): void => {
    const stack: Element[] = [node]
    while (stack.length > 0) {
      const element = stack.pop() as Element
      const listener = (element as { addEventListener?: unknown }).addEventListener
      if (localNameOf(element) === 'link' && typeof listener === 'function' && !watchedLinks.has(element)) {
        watchedLinks.add(element)
        const handler = (): void => { if (active) rememberDocumentStyleIds(root) }
        linkHandlers.push({ element, handler })
        element.addEventListener('load', handler, { once: true })
      }
      const children = element.children
      for (let index = 0; index < children.length; index += 1) stack.push(children[index] as Element)
    }
  }

  const flush = (): void => {
    scheduled = false
    const nodes = [...pending]
    pending.clear()
    // 样式与 a11y 引用面**先**读：同一批里新插入的 <style>/aria 引用必须在改名之前进保留集，
    // 否则图标先按旧名改名、紧接着读到的新引用当场失效。
    for (const node of nodes) rememberReferenceIds(node)
    if (nodes.some(node => containsStyleSheet(node))) rememberDocumentStyleIds(root)
    for (const node of nodes) watchStyleSheetLinks(node)
    const svgs: Element[] = []
    for (const node of nodes) collectSvgElements(node, svgs)
    // 一遍过：工作量由「这次插入的子树」决定（整页 200+ 个 <svg> 仍是一次微任务内
    // 完成）。刻意不分片——分片只能让位给同一检查点里的其它微任务，不会把余量让到
    // 下一帧（首次绘制在检查点之后），却把「全部改名完成」拆成不确定状态。
    const touched = new Set<Element>()
    for (const svg of svgs) {
      const wasScoped = scopedSvgs.has(svg)
      const changed = scopeSvgElement(svg, nextSvgScopeToken(tokenPrefix))
      // 本批「真的处理过」的判据：新 scoped 或真的改了东西；已在集合里的旧 svg 走 0 返回，
      // 不能算处理过（否则同批重报的 host 会跳过必要的重扫）。
      if (!wasScoped || changed > 0) touched.add(svg)
    }
    // 后补进「已 scoped svg」的内容（innerHTML 替换、插件追加）：重扫那个宿主 svg，
    // 否则新引入的静态 id 会与别处重复，而它不会再被任何 pass 看到。
    for (const node of nodes) {
      if (!introducesResourceContent(node)) continue
      const host = nearestScopedAncestorSvg(node)
      if (host !== null && !touched.has(host)) rescanSvgElement(host, nextSvgScopeToken(tokenPrefix))
    }
  }

  const enqueue = (node: Element): void => {
    pending.add(node)
    if (scheduled) return
    scheduled = true
    schedule(flush)
  }

  const observer = observe(root as Node, records => {
    for (const record of records) {
      const added = record.addedNodes
      for (let index = 0; index < added.length; index += 1) {
        const node = added[index]
        // 自产副本不算新增内容：否则「复制 → 回灌 → 重扫 → 再复制」自激，预算只按次生效。
        if (isElementNode(node) && !selfProducedNodes.has(node)) enqueue(node)
      }
    }
  })

  // 装机前已存在的 svg（例如骨架屏或热更新后的既有壳）与样式表也要覆盖一次。
  rememberDocumentStyleIds(root)
  if (isElementNode(root as unknown as Node)) rememberReferenceIds(root as unknown as Element)
  const existing: Element[] = []
  if (isElementNode(root as unknown as Node)) collectSvgElements(root as unknown as Element, existing)
  for (const svg of existing) scopeSvgElement(svg, nextSvgScopeToken(tokenPrefix))

  return () => {
    active = false
    observer.disconnect()
    pending.clear()
    for (const { element, handler } of linkHandlers) {
      const remove = (element as { removeEventListener?: unknown }).removeEventListener
      if (typeof remove === 'function') element.removeEventListener('load', handler)
    }
    linkHandlers.length = 0
    resetSvgResourceScopeMemory()
  }
}
