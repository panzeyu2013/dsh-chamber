/**
 * Document-level SVG resource-id scoping (design 05 §4.2「文档级 SVG 资源 id 归属」).
 *
 * The defect this spec pins: upstream icon components hard-code their Figma
 * resource ids (`clip0_1450_63327`, `dsh-wordmark-*-clip`, the agent-preset mask),
 * and `url(#id)` resolves DOCUMENT-wide. N-ctx mounts N instance shells into ONE
 * document, so every shell defines those ids again. Measured on the real shell
 * (macOS WKWebView, 0.3.2-beta.4, one variable per run): once a second shell
 * subtree carrying the same ids exists, a NEWLY created icon whose clipper/mask
 * resolves into a not-laid-out subtree (.instance-hidden / .instance-pending)
 * is dropped at paint time and stays blank until the element is rebuilt
 * (re-setting the attribute or revealing the shell does NOT heal it); renaming
 * the ids in the duplicated subtree made the very same scenario paint again.
 * So the rule is: every <svg> must resolve its own resource ids inside itself.
 *
 * `svg-resource-scope.ts` is framework-free and takes its document surface by
 * injection, so the rule is driven here through a tiny element double (the repo
 * runs node:test without a DOM). The entry wiring (the source-text lock file was
 * retired in the second trim round) is guarded at the artifact level by
 * packages/desktop/scripts/build-swift-app.test.mjs (assembled chunk marker,
 * fail-closed) and packages/dsh-chamber-client-ui-mobile/scripts/artifact-scope-marker.test.mjs.
 *
 * LIMITS, stated honestly: this spec proves the rename plan, the boundary rules
 * and the installer pipeline; it does not rasterize, so the engine behaviour
 * above is evidenced by the on-device probe recorded in the design section and
 * the STATUS acceptance item, not executed here.
 */
import { beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'

import {
  SVG_SCOPE_ATTRIBUTE,
  installSvgResourceScope,
  resetSvgResourceScopeMemory,
  resourceRenamePlan,
  rewriteUrlReferences,
  scopeSvgElement,
  urlReferenceIds,
} from '../../src/svg-resource-scope.ts'

// Module-level memory (rename map / preserved ids / scoped identity) is per realm, not per test.
beforeEach(() => { resetSvgResourceScopeMemory() })

/** Minimal element double: exactly the surface the scoper uses. */
class FakeElement {
  readonly nodeType = 1
  readonly children: FakeElement[] = []
  parentNode: FakeElement | null = null
  readonly localName: string
  readonly tagName: string
  private readonly attrs = new Map<string, string>()

  constructor(localName: string, attrs: Record<string, string> = {}) {
    this.localName = localName
    this.tagName = localName
    for (const [name, value] of Object.entries(attrs)) this.attrs.set(name, value)
  }

  /** Number of textContent writes (F6: an unchanged <style> string must not be written back). */
  textWrites = 0
  private text = ''
  private textWasSet = false

  get textContent(): string | null {
    return this.textWasSet ? this.text : null
  }

  set textContent(value: string | null) {
    this.textWrites += 1
    this.text = value ?? ''
    this.textWasSet = true
  }

  getAttribute(name: string): string | null {
    return this.attrs.has(name) ? (this.attrs.get(name) as string) : null
  }

  attributeWrites = 0

  setAttribute(name: string, value: string): void {
    this.attributeWrites += 1
    this.attrs.set(name, value)
  }

  hasAttribute(name: string): boolean {
    return this.attrs.has(name)
  }

  removeAttribute(name: string): void {
    this.attrs.delete(name)
  }

  append(...nodes: FakeElement[]): this {
    for (const node of nodes) {
      node.parentNode = this
      this.children.push(node)
    }
    return this
  }

  listeners = new Map<string, (() => void)[]>()

  addEventListener(type: string, handler: () => void): void {
    const list = this.listeners.get(type) ?? []
    list.push(handler)
    this.listeners.set(type, list)
  }

  removeEventListener(type: string, handler: () => void): void {
    const list = this.listeners.get(type) ?? []
    this.listeners.set(type, list.filter(entry => entry !== handler))
  }

  fire(type: string): void {
    for (const handler of this.listeners.get(type) ?? []) handler()
  }

  listenerCount(type: string): number {
    return (this.listeners.get(type) ?? []).length
  }

  appendChild(node: FakeElement): FakeElement {
    this.append(node)
    return node
  }

  cloneNode(deep = false): FakeElement {
    const copy = new FakeElement(this.localName)
    for (const name of this.attributeNames()) copy.setAttribute(name, this.getAttribute(name) as string)
    if (this.textContent !== null) copy.textContent = this.textContent
    if (deep) for (const child of this.children) copy.append(child.cloneNode(true))
    return copy
  }

  /** Every element in this subtree, this node included (assertion helper). */
  all(): FakeElement[] {
    const out: FakeElement[] = []
    const stack: FakeElement[] = [this]
    while (stack.length > 0) {
      const node = stack.pop() as FakeElement
      out.push(node)
      for (const child of node.children) stack.push(child)
    }
    return out
  }

  attributeNames(): string[] {
    return [...this.attrs.keys()]
  }

  ids(): string[] {
    return this.all().map(node => node.getAttribute('id')).filter((id): id is string => id !== null)
  }
}

/** Deep copy in the shape cloneNode(true) produces (attributes, incl. the scope marker). */
function cloneOf(node: FakeElement): FakeElement {
  const copy = new FakeElement(node.localName)
  for (const name of node.attributeNames()) copy.setAttribute(name, node.getAttribute(name) as string)
  copy.textContent = node.textContent
  for (const child of node.children) copy.append(cloneOf(child))
  return copy
}

const element = (node: FakeElement): Element => node as unknown as Element

/** The same icon authored with whitespace inside url( … ) — a form the guards must not skip. */
function spaceyFormIcon(): FakeElement {
  const svg = new FakeElement('svg', { width: '16', height: '16' })
  const group = new FakeElement('g', { 'clip-path': 'url( #spacey )' })
  group.append(new FakeElement('path', { d: 'M1 1h6' }))
  const defs = new FakeElement('defs')
  const clip = new FakeElement('clipPath', { id: 'spacey' })
  clip.append(new FakeElement('rect', { width: '16', height: '16' }))
  defs.append(clip)
  svg.append(group, defs)
  return svg
}

/** One upstream icon instance: a clipped path plus its own <defs>. */
function gearIcon(id = 'clip0_1450_63327', size = '16'): FakeElement {
  const svg = new FakeElement('svg', { width: size, height: size, viewBox: '0 0 ' + size + ' ' + size })
  const group = new FakeElement('g', { 'clip-path': 'url(#' + id + ')' })
  group.append(new FakeElement('path', { d: 'M4 8h8', fill: 'currentColor' }))
  const defs = new FakeElement('defs')
  const clip = new FakeElement('clipPath', { id })
  clip.append(new FakeElement('rect', { width: size, height: size }))
  defs.append(clip)
  svg.append(group, defs)
  return svg
}

/** The wordmark shape: a direct <path>, a clipped whale group and a clipped badge group. */
function wordmark(): FakeElement {
  const svg = new FakeElement('svg', { width: '182', height: '24', viewBox: '0 0 182 24' })
  const whale = new FakeElement('g', { 'clip-path': 'url(#dsh-wordmark-whale-clip)' })
  whale.append(new FakeElement('path', { d: 'M1 1c2 3 4 5 6 6', fill: 'currentColor' }))
  const badge = new FakeElement('rect', { x: '129.348', y: '5.5', width: '52', height: '14' })
  const badgeText = new FakeElement('g', { 'clip-path': 'url(#dsh-wordmark-badge-clip)' })
  badgeText.append(new FakeElement('path', { d: 'M135 9h6v2h-6z' }))
  const defs = new FakeElement('defs')
  const whaleClip = new FakeElement('clipPath', { id: 'dsh-wordmark-whale-clip' })
  whaleClip.append(new FakeElement('rect', { width: '23.1602', height: '17.0435' }))
  const badgeClip = new FakeElement('clipPath', { id: 'dsh-wordmark-badge-clip' })
  badgeClip.append(new FakeElement('rect', { width: '46', height: '14' }))
  defs.append(whaleClip, badgeClip)
  svg.append(whale, badge, badgeText, defs)
  return svg
}

/** The reference attribute of an element, or null when it has none. */
function referenceOf(node: FakeElement): string | null {
  return node.getAttribute('clip-path') ?? node.getAttribute('mask') ?? node.getAttribute('fill')
}

/** Ids of the definitions inside exactly this svg (nested svg excluded). */
function definedIds(svg: FakeElement): string[] {
  return svg
    .all()
    .filter(node => node !== svg && node.localName !== 'svg')
    .map(node => node.getAttribute('id'))
    .filter((id): id is string => id !== null)
}

test('urlReferenceIds extracts every url(#…) target and ignores non-url values', () => {
  assert.deepEqual(urlReferenceIds('url(#a)'), ['a'])
  assert.deepEqual(urlReferenceIds("url( '#b' )"), ['b'])
  assert.deepEqual(urlReferenceIds('url("#c")'), ['c'])
  assert.deepEqual(urlReferenceIds('url(#a) url(#b)'), ['a', 'b'])
  assert.deepEqual(urlReferenceIds('url(http://x/y.svg#z)'), [])
  assert.deepEqual(urlReferenceIds('none'), [])
  assert.deepEqual(urlReferenceIds(''), [])
  // Reused statefully: a second call must not continue from the previous match.
  assert.deepEqual(urlReferenceIds('url(#a)'), ['a'])
  assert.deepEqual(urlReferenceIds('url(#b)'), ['b'])
})

test('rewriteUrlReferences renames only registered targets and preserves the original form', () => {
  const renames = new Map([['a', 'csvg7-a']])
  assert.equal(rewriteUrlReferences('url(#a)', renames), 'url(#csvg7-a)')
  assert.equal(rewriteUrlReferences("url( '#a' )", renames), "url( '#csvg7-a' )")
  assert.equal(rewriteUrlReferences('url(#b)', renames), 'url(#b)')
  assert.equal(rewriteUrlReferences('url(#a) url(#b)', renames), 'url(#csvg7-a) url(#b)')
})

test('resourceRenamePlan keeps defined ∩ referenced ids and never a preserved one', () => {
  const plan = resourceRenamePlan(['a', 'b', '', 'c'], ['b', 'c', 'outside'], 'T')
  assert.deepEqual([...plan.keys()].sort(), ['b', 'c'])
  assert.equal(plan.get('b'), 'T-b')
  // An id referenced from an svg-local <style> is preserved (see the scoped-css tests).
  const guarded = resourceRenamePlan(['a', 'b'], ['a', 'b'], 'T', ['a'])
  assert.deepEqual([...guarded.keys()], ['b'])
})

test('scopeSvgElement makes one icon self-contained: ids and references renamed together', () => {
  const svg = gearIcon()
  const renamed = scopeSvgElement(element(svg), 'T1')
  assert.equal(renamed, 1)
  assert.deepEqual(definedIds(svg), ['T1-clip0_1450_63327'])
  assert.equal(referenceOf(svg.children[0]), 'url(#T1-clip0_1450_63327)')
  assert.equal(svg.getAttribute(SVG_SCOPE_ATTRIBUTE), 'T1')
})

test('scopeSvgElement is idempotent (second pass is a no-op, no double prefix)', () => {
  const svg = gearIcon()
  assert.equal(scopeSvgElement(element(svg), 'T1'), 1)
  const after = definedIds(svg)
  assert.equal(scopeSvgElement(element(svg), 'T2'), 0)
  assert.deepEqual(definedIds(svg), after)
  assert.equal(referenceOf(svg.children[0]), 'url(#T1-clip0_1450_63327)')
})

test('a CLONE of an already-scoped svg is re-scoped, not skipped by the copied marker', () => {
  const original = gearIcon()
  assert.equal(scopeSvgElement(element(original), 'C1'), 1)
  const clone = cloneOf(original)
  assert.equal(clone.getAttribute(SVG_SCOPE_ATTRIBUTE), 'C1')
  assert.equal(scopeSvgElement(element(clone), 'C2'), 1)
  assert.notEqual(definedIds(clone)[0], definedIds(original)[0])
  assert.equal(referenceOf(clone.children[0]), 'url(#' + definedIds(clone)[0] + ')')
  assert.equal(referenceOf(original.children[0]), 'url(#' + definedIds(original)[0] + ')')
})

test('two identical icons in one document no longer share a resource id (the immunisation property)', () => {
  const first = gearIcon()
  const second = gearIcon()
  scopeSvgElement(element(first), 'T1')
  scopeSvgElement(element(second), 'T2')
  const firstId = definedIds(first)[0]
  const secondId = definedIds(second)[0]
  assert.notEqual(firstId, secondId)
  // Each icon references the definition that lives inside itself.
  assert.equal(referenceOf(first.children[0]), 'url(#' + firstId + ')')
  assert.equal(referenceOf(second.children[0]), 'url(#' + secondId + ')')
})

test('the wordmark keeps its direct and clipped content consistent', () => {
  const svg = wordmark()
  assert.equal(scopeSvgElement(element(svg), 'W1'), 2)
  assert.deepEqual(definedIds(svg).sort(), ['W1-dsh-wordmark-badge-clip', 'W1-dsh-wordmark-whale-clip'])
  assert.equal(svg.children[0].getAttribute('clip-path'), 'url(#W1-dsh-wordmark-whale-clip)')
  assert.equal(svg.children[2].getAttribute('clip-path'), 'url(#W1-dsh-wordmark-badge-clip)')
  // The unclipped siblings are untouched.
  assert.equal(svg.children[1].getAttribute('x'), '129.348')
  assert.equal(svg.children[1].getAttribute('clip-path'), null)
})

test('an id referenced from an svg-local <style> is PRESERVED (never renamed, never rewritten)', () => {
  const svg = new FakeElement('svg')
  const style = new FakeElement('style')
  style.textContent = '.glyph{clip-path:url(#local-clip);fill:currentColor}'
  const writesAfterSetup = style.textWrites
  const clip = new FakeElement('clipPath', { id: 'local-clip' })
  clip.append(new FakeElement('rect', { width: '8', height: '8' }))
  const defs = new FakeElement('defs')
  defs.append(clip)
  const glyph = new FakeElement('path', { class: 'glyph', 'clip-path': 'url(#local-clip)' })
  svg.append(style, glyph, defs)
  // 宁可少改：那张样式表是文档级作用域，改名会改变它，而写回要替换 React 追踪的文本节点。
  assert.equal(scopeSvgElement(element(svg), 'C1'), 0)
  assert.equal(clip.getAttribute('id'), 'local-clip')
  assert.equal(glyph.getAttribute('clip-path'), 'url(#local-clip)')
  assert.equal(style.textContent, '.glyph{clip-path:url(#local-clip);fill:currentColor}')
  assert.equal(style.textWrites, writesAfterSetup)
})

test('the <svg> root keeps its own id (external code may address the root)', () => {
  const svg = gearIcon()
  svg.setAttribute('id', 'root-gear')
  assert.equal(scopeSvgElement(element(svg), 'R1'), 1)
  assert.equal(svg.getAttribute('id'), 'root-gear')
  assert.deepEqual(definedIds(svg), ['R1-clip0_1450_63327'])
})

test('a whole insertion batch is scoped in ONE pass (no chunk budget leaves icons unscoped)', () => {
  const root = new FakeElement('body')
  const scheduled: (() => void)[] = []
  let registered: ((records: readonly { addedNodes: ArrayLike<unknown> }[]) => void) | null = null
  installSvgResourceScope({
    root: element(root) as unknown as ParentNode,
    tokenPrefix: 'B',
    observe: (_target, callback) => {
      registered = callback as never
      return { disconnect: () => {} }
    },
    schedule: run => { scheduled.push(run) },
  })
  const inserted = new FakeElement('div')
  const icons: FakeElement[] = []
  for (let index = 0; index < 300; index += 1) {
    const icon = gearIcon('clip-' + index)
    icons.push(icon)
    inserted.append(icon)
  }
  ;(registered as unknown as (records: readonly { addedNodes: ArrayLike<unknown> }[]) => void)([{ addedNodes: [inserted] }])
  assert.equal(scheduled.length, 1)
  scheduled.shift()?.()
  for (const icon of icons) {
    assert.equal(String(definedIds(icon)[0]).startsWith('B'), true)
    assert.equal(icon.getAttribute(SVG_SCOPE_ATTRIBUTE) !== null, true)
  }
  assert.equal(scheduled.length, 0)
})

test('two installers in one document use different token namespaces', () => {
  const root = new FakeElement('body')
  const first = gearIcon()
  root.append(first)
  const observers: ((records: readonly { addedNodes: ArrayLike<unknown> }[]) => void)[] = []
  const runNow = (run: () => void) => { run() }
  installSvgResourceScope({
    root: element(root) as unknown as ParentNode,
    observe: (_t, cb) => { observers.push(cb as never); return { disconnect: () => {} } },
    schedule: runNow,
  })
  assert.equal(String(definedIds(first)[0]).startsWith('chamber-csvg1'), true)
  // A second module copy (duplicate bundle) would install again over the same document.
  installSvgResourceScope({
    root: element(root) as unknown as ParentNode,
    observe: (_t, cb) => { observers.push(cb as never); return { disconnect: () => {} } },
    schedule: runNow,
  })
  const second = gearIcon()
  root.append(second)
  observers[1]?.([{ addedNodes: [second] }])
  assert.equal(String(definedIds(second)[0]).startsWith('chamber-csvg2'), true)
  assert.notEqual(definedIds(first)[0], definedIds(second)[0])
})

test('an svg-internal style keeps its id unrenamed inside that svg (never written back)', () => {
  const svg = new FakeElement('svg')
  const style = new FakeElement('style')
  style.textContent = '.glyph{clip-path:url(#local-clip)}'
  const writesAfterSetup = style.textWrites
  const clip = new FakeElement('clipPath', { id: 'local-clip' })
  const defs = new FakeElement('defs')
  defs.append(clip)
  const glyph = new FakeElement('path', { 'clip-path': 'url(#local-clip)' })
  svg.append(style, glyph, defs)
  assert.equal(scopeSvgElement(element(svg), 'C1'), 0)
  assert.equal(clip.getAttribute('id'), 'local-clip')
  assert.equal(glyph.getAttribute('clip-path'), 'url(#local-clip)')
  assert.equal(style.textContent, '.glyph{clip-path:url(#local-clip)}')
  assert.equal(style.textWrites, writesAfterSetup)
})

test('whitespace and quote forms of url() are rewritten, not only the bare url(#id) form', () => {
  const svg = spaceyFormIcon()
  assert.equal(scopeSvgElement(element(svg), 'S9'), 1)
  assert.equal(svg.children[0].getAttribute('clip-path'), 'url( #S9-spacey )')
  assert.deepEqual(definedIds(svg), ['S9-spacey'])
})

test('a11y ids are never renamed and a11y references are never rewritten', () => {
  const svg = gearIcon()
  svg.setAttribute('aria-labelledby', 'gear-label')
  const title = new FakeElement('title', { id: 'gear-label' })
  title.append(new FakeElement('textNode'))
  svg.append(title)
  assert.equal(scopeSvgElement(element(svg), 'T1'), 1)
  assert.equal(svg.getAttribute('aria-labelledby'), 'gear-label')
  assert.equal(title.getAttribute('id'), 'gear-label')
  assert.deepEqual(definedIds(svg).sort(), ['T1-clip0_1450_63327', 'gear-label'])
})

test('without a document face an external definition is left untouched (no copy attempted)', () => {
  const sprite = new FakeElement('svg')
  const defs = new FakeElement('defs')
  defs.append(new FakeElement('linearGradient', { id: 'shared' }))
  sprite.append(defs)
  const consumer = new FakeElement('svg')
  consumer.append(new FakeElement('rect', { fill: 'url(#shared)' }))
  assert.equal(scopeSvgElement(element(sprite), 'S1'), 0)
  assert.equal(scopeSvgElement(element(consumer), 'S2'), 0)
  assert.equal(defs.children[0].getAttribute('id'), 'shared')
  assert.equal(consumer.children[0].getAttribute('fill'), 'url(#shared)')
})

test('a nested svg is its own scope: the outer pass does not rename inner ids', () => {
  const outer = new FakeElement('svg')
  const inner = gearIcon('inner-clip')
  outer.append(inner)
  assert.equal(scopeSvgElement(element(outer), 'O1'), 0)
  assert.deepEqual(definedIds(inner), ['inner-clip'])
  assert.equal(scopeSvgElement(element(inner), 'I1'), 1)
  assert.deepEqual(definedIds(inner), ['I1-inner-clip'])
})

test('installSvgResourceScope scopes pre-existing svgs, scopes inserted subtrees once, and disposes', () => {
  const root = new FakeElement('body')
  const existing = gearIcon()
  root.append(existing)
  const scheduled: (() => void)[] = []
  let registered: ((records: readonly { addedNodes: ArrayLike<unknown> }[]) => void) | null = null
  let disconnects = 0
  const install = installSvgResourceScope({
    root: element(root) as unknown as ParentNode,
    tokenPrefix: 'P',
    observe: (_target, callback) => {
      registered = callback as never
      return { disconnect: () => { disconnects += 1 } }
    },
    schedule: run => { scheduled.push(run) },
  })
  const emit = (node: FakeElement): void => {
    ;(registered as unknown as (records: readonly { addedNodes: ArrayLike<unknown> }[]) => void)(
      [{ addedNodes: [node] }],
    )
  }
  // Pre-existing content is covered at install time.
  assert.equal(definedIds(existing)[0].startsWith('P'), true)
  assert.equal(disconnects, 0)

  const inserted = new FakeElement('div')
  const icon = gearIcon()
  inserted.append(icon)
  emit(inserted)
  assert.equal(scheduled.length, 1)
  scheduled.shift()?.()
  assert.equal(definedIds(icon)[0].startsWith('P'), true)
  const scoped = definedIds(icon)[0]

  // Same subtree again: marker makes the flush a no-op (no double prefix).
  emit(inserted)
  scheduled.shift()?.()
  assert.deepEqual(definedIds(icon), [scoped])

  install()
  assert.equal(disconnects, 1)
})


test('an id that is also an a11y target is PRESERVED (renaming it would break the association)', () => {
  const svg = gearIcon()
  svg.setAttribute('aria-labelledby', 'clip0_1450_63327')
  assert.equal(scopeSvgElement(element(svg), 'Y1'), 0)
  assert.deepEqual(definedIds(svg), ['clip0_1450_63327'])
  assert.equal(svg.children[0].getAttribute('clip-path'), 'url(#clip0_1450_63327)')
  assert.equal(svg.getAttribute('aria-labelledby'), 'clip0_1450_63327')
})

test('url(#a b) (invalid CSS) is no longer treated as a reference', () => {
  assert.deepEqual(urlReferenceIds('url(#a b)'), [])
  assert.deepEqual(urlReferenceIds('url(#a )'), ['a'])
  assert.deepEqual(urlReferenceIds('url( #a )'), ['a'])
})

test('a clone re-scope strips the module token prefix (no id growth)', () => {
  const original = gearIcon()
  assert.equal(scopeSvgElement(element(original), 'chamber-csvg7'), 1)
  assert.deepEqual(definedIds(original), ['chamber-csvg7-clip0_1450_63327'])
  const clone = cloneOf(original)
  assert.equal(scopeSvgElement(element(clone), 'chamber-csvg8'), 1)
  assert.deepEqual(definedIds(clone), ['chamber-csvg8-clip0_1450_63327'])
})

test('an externally referenced definition is COPIED into the consuming svg (self-containment)', () => {
  const owner = new FakeElement('svg')
  const ownerDefs = new FakeElement('defs')
  const gradient = new FakeElement('linearGradient', { id: 'shared-grad' })
  gradient.append(new FakeElement('stop', { offset: '0' }))
  ownerDefs.append(gradient)
  owner.append(ownerDefs)
  const consumer = new FakeElement('svg')
  const painted = new FakeElement('rect', { fill: 'url(#shared-grad)' })
  consumer.append(painted)
  const documentDouble = { getElementById: (id: string) => (id === 'shared-grad' ? gradient : null) }
  ;(consumer as unknown as { ownerDocument: unknown }).ownerDocument = documentDouble
  const changed = scopeSvgElement(element(consumer), 'E1')
  assert.equal(changed, 1)
  const copy = consumer.children.find(child => child.getAttribute('id') !== null)
  assert.notEqual(copy, undefined)
  const copyId = String(copy?.getAttribute('id'))
  assert.notEqual(copyId, 'shared-grad')
  assert.equal(painted.getAttribute('fill'), 'url(#' + copyId + ')')
  // The owner keeps its own definition untouched (other consumers are unaffected).
  assert.equal(gradient.getAttribute('id'), 'shared-grad')
  assert.equal(ownerDefs.children.length, 1)
})

test('a definition appended LATER inside an already-scoped svg triggers a rescan of that svg', () => {
  const root = new FakeElement('body')
  const scheduled: (() => void)[] = []
  let registered: ((records: readonly { addedNodes: ArrayLike<unknown> }[]) => void) | null = null
  installSvgResourceScope({
    root: element(root) as unknown as ParentNode,
    tokenPrefix: 'L',
    observe: (_target, callback) => {
      registered = callback as never
      return { disconnect: () => {} }
    },
    schedule: run => { scheduled.push(run) },
  })
  const host = gearIcon('first-clip')
  root.append(host)
  const emit = (node: FakeElement): void => {
    ;(registered as unknown as (records: readonly { addedNodes: ArrayLike<unknown> }[]) => void)([{ addedNodes: [node] }])
  }
  emit(host)
  scheduled.shift()?.()
  const firstScoped = String(definedIds(host)[0])
  assert.equal(firstScoped.startsWith('L'), true)

  // innerHTML-style replacement inside the SAME svg introduces a brand-new static id.
  const added = new FakeElement('g', { 'clip-path': 'url(#late-clip)' })
  const defs = new FakeElement('defs')
  defs.append(new FakeElement('clipPath', { id: 'late-clip' }))
  added.append(defs)
  host.append(added)
  emit(added)
  scheduled.shift()?.()
  const ids = definedIds(host)
  assert.equal(ids.includes('late-clip'), false, 'the late static id must be renamed')
  assert.equal(added.getAttribute('clip-path'), 'url(#' + String(defs.children[0].getAttribute('id')) + ')')
  assert.equal(host.getAttribute(SVG_SCOPE_ATTRIBUTE) !== null, true)
})

test('an id referenced by a document-level <style> is preserved (global style face)', () => {
  resetSvgResourceScopeMemory()
  const root = new FakeElement('body')
  const style = new FakeElement('style')
  style.textContent = '.icon{clip-path:url(#doc-clip)}'
  const svg = gearIcon('doc-clip')
  root.append(style, svg)
  ;(root as unknown as { ownerDocument: unknown }).ownerDocument = {
    querySelectorAll: (selector: string) => (selector === 'style' ? [style] : []),
    getElementById: () => null,
    styleSheets: [],
  }
  installSvgResourceScope({
    root: element(root) as unknown as ParentNode,
    tokenPrefix: 'D',
    observe: () => ({ disconnect: () => {} }),
    schedule: run => { run() },
  })
  assert.deepEqual(definedIds(svg), ['doc-clip'])
  assert.equal(svg.children[0].getAttribute('clip-path'), 'url(#doc-clip)')
  resetSvgResourceScopeMemory()
})

test('the installer scopes a NESTED <svg> too (each svg owns its own scope)', () => {
  const root = new FakeElement('body')
  const scheduled: (() => void)[] = []
  let registered: ((records: readonly { addedNodes: ArrayLike<unknown> }[]) => void) | null = null
  installSvgResourceScope({
    root: element(root) as unknown as ParentNode,
    tokenPrefix: 'N',
    observe: (_target, callback) => {
      registered = callback as never
      return { disconnect: () => {} }
    },
    schedule: run => { scheduled.push(run) },
  })
  // Mirrors the upstream code-icon shape: a wrapper <svg> whose content sits in a nested <svg>.
  const wrapper = new FakeElement('svg', { width: '20', height: '20' })
  const nested = gearIcon('nested-clip')
  wrapper.append(nested)
  const inserted = new FakeElement('div')
  inserted.append(wrapper)
  ;(registered as unknown as (records: readonly { addedNodes: ArrayLike<unknown> }[]) => void)([{ addedNodes: [inserted] }])
  scheduled.shift()?.()
  assert.equal(wrapper.getAttribute(SVG_SCOPE_ATTRIBUTE) !== null, true)
  assert.equal(nested.getAttribute(SVG_SCOPE_ATTRIBUTE) !== null, true)
  assert.equal(definedIds(nested).length, 1)
  assert.equal(String(definedIds(nested)[0]).startsWith('N'), true)
  assert.notEqual(definedIds(nested)[0], 'nested-clip')
  assert.equal(nested.children[0].getAttribute('clip-path'), 'url(#' + definedIds(nested)[0] + ')')
})

test('svg-local href / xlink:href self references are renamed with their definition', () => {
  const svg = new FakeElement('svg')
  const symbol = new FakeElement('symbol', { id: 'sprite-1' })
  symbol.append(new FakeElement('path', { d: 'M0 0h4' }))
  const use = new FakeElement('use', { href: '#sprite-1' })
  const useLegacy = new FakeElement('use', { 'xlink:href': '#sprite-1' })
  svg.append(symbol, use, useLegacy)
  assert.equal(scopeSvgElement(element(svg), 'H1'), 1)
  assert.equal(symbol.getAttribute('id'), 'H1-sprite-1')
  assert.equal(use.getAttribute('href'), '#H1-sprite-1')
  assert.equal(useLegacy.getAttribute('xlink:href'), '#H1-sprite-1')
})

test('an inline style attribute is a reference面, and an attribute needing no rename is not rewritten', () => {
  const svg = new FakeElement('svg')
  const painted = new FakeElement('path', { style: 'clip-path:url(#icon-clip);fill:currentColor' })
  const untouched = new FakeElement('path', { style: 'clip-path:url(#elsewhere)' })
  const clip = new FakeElement('clipPath', { id: 'icon-clip' })
  clip.append(new FakeElement('rect', { width: '4', height: '4' }))
  const defs = new FakeElement('defs')
  defs.append(clip)
  svg.append(painted, untouched, defs)
  const writesBefore = untouched.attributeWrites
  assert.equal(scopeSvgElement(element(svg), 'A1'), 1)
  assert.equal(painted.getAttribute('style'), 'clip-path:url(#A1-icon-clip);fill:currentColor')
  assert.equal(untouched.getAttribute('style'), 'clip-path:url(#elsewhere)')
  assert.equal(untouched.attributeWrites, writesBefore)
})

test('URL() is recognised case-insensitively and keeps the original casing', () => {
  const svg = gearIcon()
  svg.children[0].setAttribute('clip-path', 'URL(#clip0_1450_63327)')
  assert.deepEqual(urlReferenceIds('URL(#a)'), ['a'])
  assert.equal(scopeSvgElement(element(svg), 'U1'), 1)
  assert.equal(svg.children[0].getAttribute('clip-path'), 'URL(#U1-clip0_1450_63327)')
})

test('production defaults observe document.body and flush in a microtask (no rAF, no sync paint window)', async () => {
  const body = new FakeElement('body')
  const observed: { target: unknown; options: unknown }[] = []
  let emit: ((records: readonly { addedNodes: ArrayLike<unknown> }[]) => void) | null = null
  class FakeMutationObserver {
    constructor(callback: (records: readonly { addedNodes: ArrayLike<unknown> }[]) => void) {
      emit = callback as never
    }
    observe(target: unknown, options: unknown): void {
      observed.push({ target, options })
    }
    disconnect(): void {}
  }
  const globals = globalThis as unknown as Record<string, unknown>
  const savedDocument = globals.document
  const savedObserver = globals.MutationObserver
  try {
    globals.document = { body }
    globals.MutationObserver = FakeMutationObserver
    const dispose = installSvgResourceScope()
    assert.equal(observed.length, 1)
    assert.equal(observed[0]?.target, body)
    assert.deepEqual(observed[0]?.options, { childList: true, subtree: true })
    const icon = gearIcon()
    body.append(icon)
    ;(emit as unknown as (records: readonly { addedNodes: ArrayLike<unknown> }[]) => void)([{ addedNodes: [icon] }])
    assert.equal(icon.getAttribute(SVG_SCOPE_ATTRIBUTE), null, 'must not rename synchronously')
    await new Promise<void>(resolve => { queueMicrotask(() => { resolve() }) })
    assert.equal(String(definedIds(icon)[0]).startsWith('chamber-csvg'), true, 'must rename in the microtask checkpoint')
    dispose()
  } finally {
    globals.document = savedDocument
    globals.MutationObserver = savedObserver
  }
})

test('non-element added nodes are ignored without throwing', () => {
  const root = new FakeElement('body')
  const scheduled: (() => void)[] = []
  let registered: ((records: readonly { addedNodes: ArrayLike<unknown> }[]) => void) | null = null
  installSvgResourceScope({
    root: element(root) as unknown as ParentNode,
    tokenPrefix: 'X',
    observe: (_target, callback) => {
      registered = callback as never
      return { disconnect: () => {} }
    },
    schedule: run => { scheduled.push(run) },
  })
  assert.doesNotThrow(() => {
    ;(registered as unknown as (records: readonly { addedNodes: ArrayLike<unknown> }[]) => void)(
      [{ addedNodes: [{ nodeType: 3 } as unknown as Node, { nodeType: 8 } as unknown as Node] }],
    )
  })
  assert.equal(scheduled.length, 0)
})


test('a copied definition is TRANSITIVELY self-contained (its own reference is copied too)', () => {
  const owner = new FakeElement('svg')
  const base2 = new FakeElement('linearGradient', { id: 'base-2' })
  const base1 = new FakeElement('linearGradient', { id: 'base-1', 'xlink:href': '#base-2' })
  base1.append(new FakeElement('stop', { offset: '0' }))
  const ownerDefs = new FakeElement('defs')
  ownerDefs.append(base1, base2)
  owner.append(ownerDefs)
  const consumer = new FakeElement('svg')
  const painted = new FakeElement('rect', { fill: 'url(#base-1)' })
  consumer.append(painted)
  const byId = new Map([[String(base1.getAttribute('id')), base1], [String(base2.getAttribute('id')), base2]])
  ;(consumer as unknown as { ownerDocument: unknown }).ownerDocument = {
    getElementById: (id: string) => byId.get(id) ?? null,
    querySelectorAll: () => [],
    styleSheets: [],
  }
  assert.equal(scopeSvgElement(element(consumer), 'T1'), 2)
  const copies = consumer.children.filter(child => child.getAttribute('id') !== null)
  assert.equal(copies.length, 2)
  const withHref = copies.find(copy => copy.getAttribute('xlink:href') !== null) as FakeElement
  const plain = copies.find(copy => copy.getAttribute('xlink:href') === null) as FakeElement
  // The copy internal reference points at the OTHER copy, never at the owner id.
  assert.equal(String(withHref.getAttribute('xlink:href')), '#' + String(plain.getAttribute('id')))
  assert.equal(painted.getAttribute('fill'), 'url(#' + String(withHref.getAttribute('id')) + ')')
  // Owner later renames its own (self referenced) id: the consumer copy must be unaffected.
  assert.equal(scopeSvgElement(element(owner), 'O1'), 1)
  assert.equal(base2.getAttribute('id'), 'O1-base-2')
  assert.equal(String(withHref.getAttribute('xlink:href')), '#' + String(plain.getAttribute('id')))
  assert.equal(painted.getAttribute('fill'), 'url(#' + String(withHref.getAttribute('id')) + ')')
})

test('a rescan keeps the id shape (no stacked prefixes) and keeps refs paired', () => {
  const root = new FakeElement('body')
  const scheduled: (() => void)[] = []
  let registered: ((records: readonly { addedNodes: ArrayLike<unknown> }[]) => void) | null = null
  installSvgResourceScope({
    root: element(root) as unknown as ParentNode,
    tokenPrefix: 'R',
    observe: (_target, callback) => {
      registered = callback as never
      return { disconnect: () => {} }
    },
    schedule: run => { scheduled.push(run) },
  })
  const emit = (node: FakeElement): void => {
    ;(registered as unknown as (records: readonly { addedNodes: ArrayLike<unknown> }[]) => void)([{ addedNodes: [node] }])
  }
  const host = gearIcon('stable-clip')
  root.append(host)
  emit(host)
  scheduled.shift()?.()
  const clipIds = (): string[] => definedIds(host).filter(id => id.includes('stable-clip'))
  const first = String(clipIds()[0])
  assert.ok(/^R\d+-stable-clip$/.test(first), first)
  const noise = new FakeElement('g', { id: 'unused-noise' })
  host.append(noise)
  emit(noise)
  scheduled.shift()?.()
  const second = String(clipIds()[0])
  assert.ok(/^R\d+-stable-clip$/.test(second), second)
  assert.equal(second.includes('stable-clip-stable-clip'), false)
  assert.equal(host.children[0].getAttribute('clip-path'), 'url(#' + second + ')')
})

test('CSSOM rules (including nested media rules) are part of the preserved style face', () => {
  const root = new FakeElement('body')
  ;(root as unknown as { ownerDocument: unknown }).ownerDocument = {
    querySelectorAll: () => [],
    getElementById: () => null,
    styleSheets: [{ cssRules: [{ cssText: '@media (max-width:1px){}', cssRules: [{ cssText: '.a{clip-path:url(#cssom-clip)}' }] }] }],
  }
  const svg = gearIcon('cssom-clip')
  root.append(svg)
  installSvgResourceScope({
    root: element(root) as unknown as ParentNode,
    tokenPrefix: 'M',
    observe: () => ({ disconnect: () => {} }),
    schedule: run => { run() },
  })
  assert.deepEqual(definedIds(svg), ['cssom-clip'])
})

test('a style inserted in the SAME batch as the icon is read BEFORE the rename', () => {
  const root = new FakeElement('body')
  const style = new FakeElement('style')
  style.textContent = '.x{clip-path:url(#batch-clip)}'
  ;(root as unknown as { ownerDocument: unknown }).ownerDocument = {
    querySelectorAll: (selector: string) => (selector === 'style' ? [style] : []),
    getElementById: () => null,
    styleSheets: [],
  }
  let registered: ((records: readonly { addedNodes: ArrayLike<unknown> }[]) => void) | null = null
  installSvgResourceScope({
    root: element(root) as unknown as ParentNode,
    tokenPrefix: 'B',
    observe: (_target, callback) => {
      registered = callback as never
      return { disconnect: () => {} }
    },
    schedule: run => { run() },
  })
  const svg = gearIcon('batch-clip')
  root.append(style, svg)
  ;(registered as unknown as (records: readonly { addedNodes: ArrayLike<unknown> }[]) => void)([{ addedNodes: [style, svg] }])
  assert.deepEqual(definedIds(svg), ['batch-clip'])
})

test('a <link> stylesheet is re-read when it loads, protecting later icons', () => {
  const root = new FakeElement('body')
  const styles: FakeElement[] = []
  ;(root as unknown as { ownerDocument: unknown }).ownerDocument = {
    querySelectorAll: (selector: string) => (selector === 'style' ? styles : []),
    getElementById: () => null,
    styleSheets: [],
  }
  let registered: ((records: readonly { addedNodes: ArrayLike<unknown> }[]) => void) | null = null
  installSvgResourceScope({
    root: element(root) as unknown as ParentNode,
    tokenPrefix: 'K',
    observe: (_target, callback) => {
      registered = callback as never
      return { disconnect: () => {} }
    },
    schedule: run => { run() },
  })
  const emit = (node: FakeElement): void => {
    ;(registered as unknown as (records: readonly { addedNodes: ArrayLike<unknown> }[]) => void)([{ addedNodes: [node] }])
  }
  const link = new FakeElement('link', { rel: 'stylesheet', href: '/late.css' })
  root.append(link)
  emit(link)
  const beforeLoad = gearIcon('late-clip')
  root.append(beforeLoad)
  emit(beforeLoad)
  assert.equal(String(definedIds(beforeLoad)[0]).startsWith('K'), true, 'pre-load icon cannot know the sheet yet')
  // The sheet content becomes readable only after load.
  const style = new FakeElement('style')
  style.textContent = '.x{clip-path:url(#late-clip)}'
  styles.push(style)
  link.fire('load')
  const afterLoad = gearIcon('late-clip')
  root.append(afterLoad)
  emit(afterLoad)
  assert.deepEqual(definedIds(afterLoad), ['late-clip'])
})

test('a non-resource href (#dom-id) is neither copied nor rewritten', () => {
  const panel = new FakeElement('div', { id: 'settings-panel' })
  const svg = new FakeElement('svg')
  const anchor = new FakeElement('a', { href: '#settings-panel' })
  svg.append(anchor)
  ;(svg as unknown as { ownerDocument: unknown }).ownerDocument = {
    getElementById: (id: string) => (id === 'settings-panel' ? panel : null),
    querySelectorAll: () => [],
    styleSheets: [],
  }
  assert.equal(scopeSvgElement(element(svg), 'N1'), 0)
  assert.equal(anchor.getAttribute('href'), '#settings-panel')
  assert.equal(svg.children.length, 1)
})

test('a <use> pointing at a renderable element is not copied (no duplicate paint)', () => {
  const group = new FakeElement('g', { id: 'icon-home' })
  group.append(new FakeElement('path', { d: 'M0 0h2' }))
  const svg = new FakeElement('svg')
  const use = new FakeElement('use', { href: '#icon-home' })
  svg.append(use)
  ;(svg as unknown as { ownerDocument: unknown }).ownerDocument = {
    getElementById: (id: string) => (id === 'icon-home' ? group : null),
    querySelectorAll: () => [],
    styleSheets: [],
  }
  assert.equal(scopeSvgElement(element(svg), 'U9'), 0)
  assert.equal(use.getAttribute('href'), '#icon-home')
  assert.equal(svg.children.length, 1)
})

test('a <use> pointing at a symbol definition IS copied (self-contained)', () => {
  const symbol = new FakeElement('symbol', { id: 'sym-1' })
  symbol.append(new FakeElement('path', { d: 'M0 0h2' }))
  const ownerDefs = new FakeElement('defs')
  ownerDefs.append(symbol)
  const owner = new FakeElement('svg')
  owner.append(ownerDefs)
  const consumer = new FakeElement('svg')
  const use = new FakeElement('use', { href: '#sym-1' })
  consumer.append(use)
  ;(consumer as unknown as { ownerDocument: unknown }).ownerDocument = {
    getElementById: (id: string) => (id === 'sym-1' ? symbol : null),
    querySelectorAll: () => [],
    styleSheets: [],
  }
  assert.equal(scopeSvgElement(element(consumer), 'U10'), 1)
  const copy = consumer.children.find(child => child.getAttribute('id') !== null) as FakeElement
  assert.equal(copy.localName, 'symbol')
  assert.equal(use.getAttribute('href'), '#' + String(copy.getAttribute('id')))
})

test('repeated references to one external definition produce exactly one copy', () => {
  const gradient = new FakeElement('linearGradient', { id: 'shared-grad' })
  const ownerDefs = new FakeElement('defs')
  ownerDefs.append(gradient)
  const owner = new FakeElement('svg')
  owner.append(ownerDefs)
  const consumer = new FakeElement('svg')
  consumer.append(
    new FakeElement('rect', { fill: 'url(#shared-grad)' }),
    new FakeElement('rect', { stroke: 'url(#shared-grad)' }),
  )
  ;(consumer as unknown as { ownerDocument: unknown }).ownerDocument = {
    getElementById: (id: string) => (id === 'shared-grad' ? gradient : null),
    querySelectorAll: () => [],
    styleSheets: [],
  }
  assert.equal(scopeSvgElement(element(consumer), 'W1'), 1)
  const copies = consumer.children.filter(child => child.getAttribute('id') !== null)
  assert.equal(copies.length, 1)
  for (const child of consumer.children) {
    for (const name of ['fill', 'stroke']) {
      const value = child.getAttribute(name)
      if (value !== null) assert.equal(value, 'url(#' + String(copies[0]?.getAttribute('id')) + ')')
    }
  }
})

test('aria-describedby / for references also preserve their target ids', () => {
  const svg = gearIcon()
  svg.setAttribute('aria-describedby', 'clip0_1450_63327')
  assert.equal(scopeSvgElement(element(svg), 'Y2'), 0)
  assert.deepEqual(definedIds(svg), ['clip0_1450_63327'])
  const form = gearIcon()
  form.setAttribute('for', 'clip0_1450_63327')
  assert.equal(scopeSvgElement(element(form), 'Y3'), 0)
  assert.deepEqual(definedIds(form), ['clip0_1450_63327'])
})

test('dispose() drops the module memory, including scoped identity', () => {
  const root = new FakeElement('body')
  const icon = gearIcon()
  root.append(icon)
  const dispose = installSvgResourceScope({
    root: element(root) as unknown as ParentNode,
    tokenPrefix: 'Z',
    observe: () => ({ disconnect: () => {} }),
    schedule: run => { run() },
  })
  assert.equal(String(definedIds(icon)[0]).startsWith('Z'), true)
  dispose()
  // Identity is gone: the still-marked element is treated as an untracked clone and re-scoped.
  assert.equal(scopeSvgElement(element(icon), 'Z9'), 1)
  assert.equal(String(definedIds(icon)[0]).startsWith('Z9-'), true)
})

test('an svg-internal style id is promoted to the document face (accepted trade-off)', () => {
  const root = new FakeElement('body')
  const first = gearIcon()
  const style = new FakeElement('style')
  style.textContent = '.x{clip-path:url(#clip0_1450_63327)}'
  first.append(style)
  const second = gearIcon()
  root.append(first, second)
  ;(root as unknown as { ownerDocument: unknown }).ownerDocument = {
    querySelectorAll: (selector: string) => (selector === 'style' ? [style] : []),
    getElementById: () => null,
    styleSheets: [],
  }
  installSvgResourceScope({
    root: element(root) as unknown as ParentNode,
    tokenPrefix: 'P',
    observe: () => ({ disconnect: () => {} }),
    schedule: run => { run() },
  })
  // Documented, deliberate: no reference is broken, at the cost that such an icon keeps its id.
  assert.deepEqual(definedIds(first), ['clip0_1450_63327'])
  assert.deepEqual(definedIds(second), ['clip0_1450_63327'])
})


test('a copied definition carries no duplicate nested ids (copy is fully namespaced)', () => {
  const owner = new FakeElement('svg')
  const pattern = new FakeElement('pattern', { id: 'pat-1' })
  const inner = new FakeElement('linearGradient', { id: 'pat-inner' })
  pattern.append(inner)
  const ownerDefs = new FakeElement('defs')
  ownerDefs.append(pattern)
  owner.append(ownerDefs)
  const consumer = new FakeElement('svg')
  const painted = new FakeElement('rect', { fill: 'url(#pat-1)' })
  consumer.append(painted)
  ;(consumer as unknown as { ownerDocument: unknown }).ownerDocument = {
    getElementById: (id: string) => (id === 'pat-1' ? pattern : null),
    querySelectorAll: () => [],
    styleSheets: [],
  }
  assert.equal(scopeSvgElement(element(consumer), 'Q1'), 1)
  const copy = consumer.children.find(child => child.getAttribute('id') !== null) as FakeElement
  assert.notEqual(copy.getAttribute('id'), 'pat-1')
  const nested = copy.children[0] as FakeElement
  assert.notEqual(nested.getAttribute('id'), 'pat-inner', 'nested ids must be namespaced too')
  assert.equal(definedIds(owner).includes(String(nested.getAttribute('id'))), false)
  assert.equal(painted.getAttribute('fill'), 'url(#' + String(copy.getAttribute('id')) + ')')
})

test('the link load listener does no work after dispose', () => {
  const root = new FakeElement('body')
  const styles: FakeElement[] = []
  ;(root as unknown as { ownerDocument: unknown }).ownerDocument = {
    querySelectorAll: (selector: string) => (selector === 'style' ? styles : []),
    getElementById: () => null,
    styleSheets: [],
  }
  let registered: ((records: readonly { addedNodes: ArrayLike<unknown> }[]) => void) | null = null
  const dispose = installSvgResourceScope({
    root: element(root) as unknown as ParentNode,
    tokenPrefix: 'J',
    observe: (_target, callback) => {
      registered = callback as never
      return { disconnect: () => {} }
    },
    schedule: run => { run() },
  })
  const link = new FakeElement('link', { rel: 'stylesheet' })
  root.append(link)
  ;(registered as unknown as (records: readonly { addedNodes: ArrayLike<unknown> }[]) => void)([{ addedNodes: [link] }])
  dispose()
  // A stylesheet that only becomes readable AFTER disposal must not join the preserved set.
  const style = new FakeElement('style')
  style.textContent = '.x{clip-path:url(#after-dispose)}'
  styles.push(style)
  link.fire('load')
  const icon = gearIcon('after-dispose')
  root.append(icon)
  ;(registered as unknown as (records: readonly { addedNodes: ArrayLike<unknown> }[]) => void)([{ addedNodes: [icon] }])
  // The id is still renamed by the (fake) observer that keeps delivering after dispose:
  // what matters is that the post-dispose stylesheet did NOT join the preserved set.
  assert.notEqual(definedIds(icon)[0], 'after-dispose')
  assert.equal(String(definedIds(icon)[0]).startsWith('J'), true)
})

test('a consumer can still resolve the AUTHOR id after the owner was rescanned (multi-hop map)', () => {
  const root = new FakeElement('body')
  const scheduled: (() => void)[] = []
  let registered: ((records: readonly { addedNodes: ArrayLike<unknown> }[]) => void) | null = null
  installSvgResourceScope({
    root: element(root) as unknown as ParentNode,
    tokenPrefix: 'H',
    observe: (_target, callback) => {
      registered = callback as never
      return { disconnect: () => {} }
    },
    schedule: run => { scheduled.push(run) },
  })
  const emit = (node: FakeElement): void => {
    ;(registered as unknown as (records: readonly { addedNodes: ArrayLike<unknown> }[]) => void)([{ addedNodes: [node] }])
  }
  const owner = new FakeElement('svg')
  const defs = new FakeElement('defs')
  const clip = new FakeElement('clipPath', { id: 'author-clip' })
  defs.append(clip)
  owner.append(defs, new FakeElement('rect', { 'clip-path': 'url(#author-clip)' }))
  root.append(owner)
  emit(owner)
  scheduled.shift()?.()
  assert.notEqual(clip.getAttribute('id'), 'author-clip')
  // A later innerHTML-style addition forces a rescan: the id is renamed AGAIN.
  const late = new FakeElement('g', { id: 'late-noise' })
  owner.append(late)
  emit(late)
  scheduled.shift()?.()
  const scopedId = String(clip.getAttribute('id'))
  assert.notEqual(scopedId, 'author-clip')
  // A brand-new consumer still references the ORIGINAL author id.
  const consumer = new FakeElement('svg')
  const painted = new FakeElement('rect', { fill: 'url(#author-clip)' })
  consumer.append(painted)
  ;(consumer as unknown as { ownerDocument: unknown }).ownerDocument = {
    getElementById: (id: string) => (id === scopedId ? clip : null),
    querySelectorAll: () => [],
    styleSheets: [],
  }
  assert.equal(scopeSvgElement(element(consumer), 'H9'), 1, 'multi-hop resolution must find the current definition')
  const copy = consumer.children.find(child => child.getAttribute('id') !== null) as FakeElement
  assert.equal(painted.getAttribute('fill'), 'url(#' + String(copy.getAttribute('id')) + ')')
})

test('a module-produced copy reported back by the observer is recognised (no self-feeding loop)', () => {
  const root = new FakeElement('body')
  const scheduled: (() => void)[] = []
  let registered: ((records: readonly { addedNodes: ArrayLike<unknown> }[]) => void) | null = null
  installSvgResourceScope({
    root: element(root) as unknown as ParentNode,
    tokenPrefix: 'F',
    observe: (_target, callback) => {
      registered = callback as never
      return { disconnect: () => {} }
    },
    schedule: run => { scheduled.push(run) },
  })
  const emit = (node: FakeElement): void => {
    ;(registered as unknown as (records: readonly { addedNodes: ArrayLike<unknown> }[]) => void)([{ addedNodes: [node] }])
  }
  const gradient = new FakeElement('linearGradient', { id: 'ext-grad' })
  const ownerDefs = new FakeElement('defs')
  ownerDefs.append(gradient)
  const owner = new FakeElement('svg')
  owner.append(ownerDefs)
  const consumer = new FakeElement('svg')
  consumer.append(new FakeElement('rect', { fill: 'url(#ext-grad)' }))
  ;(consumer as unknown as { ownerDocument: unknown }).ownerDocument = {
    getElementById: (id: string) => (id === 'ext-grad' ? gradient : null),
    querySelectorAll: () => [],
    styleSheets: [],
  }
  root.append(consumer)
  emit(consumer)
  scheduled.shift()?.()
  const copy = consumer.children.find(child => child.getAttribute('id') !== null) as FakeElement
  const marker = String(consumer.getAttribute(SVG_SCOPE_ATTRIBUTE))
  const copyId = String(copy.getAttribute('id'))
  // The observer reports the copy we appended ourselves (real MutationObserver semantics).
  emit(copy)
  scheduled.shift()?.()
  assert.equal(consumer.getAttribute(SVG_SCOPE_ATTRIBUTE), marker, 'the host must not be re-scoped')
  assert.equal(copy.getAttribute('id'), copyId, 'the copy must keep its id')
  assert.equal(consumer.children.filter(child => child.getAttribute('id') !== null).length, 1, 'no second copy')
})

test('a host reported again in the SAME batch as late content is still rescanned', () => {
  const root = new FakeElement('body')
  const scheduled: (() => void)[] = []
  let registered: ((records: readonly { addedNodes: ArrayLike<unknown> }[]) => void) | null = null
  installSvgResourceScope({
    root: element(root) as unknown as ParentNode,
    tokenPrefix: 'M',
    observe: (_target, callback) => {
      registered = callback as never
      return { disconnect: () => {} }
    },
    schedule: run => { scheduled.push(run) },
  })
  const host = gearIcon('h-clip')
  root.append(host)
  ;(registered as unknown as (records: readonly { addedNodes: ArrayLike<unknown> }[]) => void)([{ addedNodes: [host] }])
  scheduled.shift()?.()
  const late = new FakeElement('g', { 'clip-path': 'url(#late-ref)' })
  const lateDefs = new FakeElement('defs')
  lateDefs.append(new FakeElement('clipPath', { id: 'late-ref' }))
  late.append(lateDefs)
  host.append(late)
  ;(registered as unknown as (records: readonly { addedNodes: ArrayLike<unknown> }[]) => void)([
    { addedNodes: [host] },
    { addedNodes: [late] },
  ])
  scheduled.shift()?.()
  assert.equal(definedIds(host).includes('late-ref'), false, 'late id must be renamed even when the host is re-reported')
  assert.equal(late.getAttribute('clip-path'), 'url(#' + String(lateDefs.children[0].getAttribute('id')) + ')')
})

test('prefix stripping can never collapse two ids into one (targets are de-duplicated)', () => {
  const svg = new FakeElement('svg')
  const noisy = new FakeElement('clipPath', { id: 'chamber-csvg7-a' })
  const plain = new FakeElement('clipPath', { id: 'a' })
  const defs = new FakeElement('defs')
  defs.append(noisy, plain)
  svg.append(defs, new FakeElement('rect', { 'clip-path': 'url(#chamber-csvg7-a)' }), new FakeElement('rect', { 'clip-path': 'url(#a)' }))
  assert.equal(scopeSvgElement(element(svg), 'T9'), 2)
  const ids = definedIds(svg)
  assert.equal(new Set(ids).size, ids.length, 'renamed ids must stay unique: ' + ids.join(','))
})

test('an <a href="#panel"> inside a scoped svg does not trigger a rescan', () => {
  const root = new FakeElement('body')
  const scheduled: (() => void)[] = []
  let registered: ((records: readonly { addedNodes: ArrayLike<unknown> }[]) => void) | null = null
  installSvgResourceScope({
    root: element(root) as unknown as ParentNode,
    tokenPrefix: 'N',
    observe: (_target, callback) => {
      registered = callback as never
      return { disconnect: () => {} }
    },
    schedule: run => { scheduled.push(run) },
  })
  const host = gearIcon('panel-clip')
  root.append(host)
  ;(registered as unknown as (records: readonly { addedNodes: ArrayLike<unknown> }[]) => void)([{ addedNodes: [host] }])
  scheduled.shift()?.()
  const marker = String(host.getAttribute(SVG_SCOPE_ATTRIBUTE))
  const anchor = new FakeElement('a', { href: '#settings-panel' })
  host.append(anchor)
  ;(registered as unknown as (records: readonly { addedNodes: ArrayLike<unknown> }[]) => void)([{ addedNodes: [anchor] }])
  scheduled.shift()?.()
  assert.equal(host.getAttribute(SVG_SCOPE_ATTRIBUTE), marker, 'a document link is not resource content')
  assert.equal(anchor.getAttribute('href'), '#settings-panel')
})

test('dispose() removes the link load listeners and a reinstall watches its own links', () => {
  const root = new FakeElement('body')
  const makeDeps = () => ({
    root: element(root) as unknown as ParentNode,
    tokenPrefix: 'L',
    observe: () => ({ disconnect: () => {} }),
    schedule: (run: () => void) => { run() },
  })
  const first = installSvgResourceScope(makeDeps())
  const linkA = new FakeElement('link', { rel: 'stylesheet' })
  root.append(linkA)
  first()
  assert.equal(linkA.listenerCount('load'), 0, 'listener must be removed on dispose')
  const second = installSvgResourceScope(makeDeps())
  const linkB = new FakeElement('link', { rel: 'stylesheet' })
  root.append(linkB)
  second()
  assert.equal(linkB.listenerCount('load'), 0)
  assert.equal(linkA.listenerCount('load'), 0)
})
