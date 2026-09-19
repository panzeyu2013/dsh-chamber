/**
 * Shared DOM double for the mobile package's plain-node tests (no DOM
 * environment). A node carries attributes, a wired parent chain, the real
 * querySelector/closest semantics (descendants only for queries, self included
 * for closest) and EXACTLY the production anchor grammar the test fakes speak —
 * `[attr]`, `[attr="value"]`, a bare tag and `parent > child`; anything else
 * throws, so a new anchor fails loudly instead of passing silently.
 */
export interface SimpleSelector {
  readonly tag: string | null
  readonly attr: string | null
  readonly value: string | null
}

/** Parse one compound selector (`tag`, `[attr]`, `[attr="v"]`, `tag[attr="v"]`);
 *  anything outside the anchor grammar throws. */
export function parseSimple(selector: string): SimpleSelector {
  const match = /^([a-z][a-z0-9-]*)?(\[([a-z][a-z0-9-]*)(?:="([^"]*)")?\])?$/.exec(selector)
  if (match === null || (match[1] === undefined && match[2] === undefined)) {
    throw new Error(`unsupported selector "${selector}": the double speaks attribute anchors only`)
  }
  return { tag: match[1] ?? null, attr: match[3] ?? null, value: match[4] ?? null }
}

export function matchesSimple(node: FakeNode, selector: SimpleSelector): boolean {
  if (selector.tag !== null && node.tag !== selector.tag) return false
  if (selector.attr === null) return selector.tag !== null
  if (selector.value === null) return node.hasAttribute(selector.attr)
  return node.getAttribute(selector.attr) === selector.value
}

/** A fake element: tag + attributes + children, with the parent chain wired. */
export class FakeNode {
  readonly children: FakeNode[] = []
  readonly attributes = new Map<string, string>()
  readonly listeners = new Map<string, Array<() => void>>()
  readonly tag: string
  parent: FakeNode | null = null
  connected = true
  display = 'block'
  visibility = 'visible'
  rect: { bottom: number } | null = null
  className = ''
  textContent = ''
  type = ''
  readonly style: { top: string; removeProperty(name: string): void } = {
    top: '',
    removeProperty: (name: string): void => { if (name === 'top') this.style.top = '' },
  }
  constructor(tag: string) { this.tag = tag }
  get isConnected(): boolean { return this.connected }
  get parentElement(): FakeNode | null { return this.parent }
  get firstElementChild(): FakeNode | null { return this.children[0] ?? null }
  setAttribute(name: string, value = ''): void { this.attributes.set(name, value) }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null }
  hasAttribute(name: string): boolean { return this.attributes.has(name) }
  matches(selector: string): boolean { return matchesSimple(this, parseSimple(selector)) }
  addEventListener(type: string, handler: () => void): void {
    const list = this.listeners.get(type) ?? []
    list.push(handler)
    this.listeners.set(type, list)
  }
  dispatch(type: string): void {
    for (const handler of this.listeners.get(type) ?? []) handler()
  }
  click(): void { this.dispatch('click') }
  append(...nodes: FakeNode[]): void { for (const node of nodes) attach(this, node) }
  appendChild(node: FakeNode): FakeNode { return attach(this, node) }
  remove(): void {
    const parent = this.parent
    if (parent === null) return
    const index = parent.children.indexOf(this)
    if (index !== -1) parent.children.splice(index, 1)
    this.parent = null
  }
  querySelector(selector: string): FakeNode | null { return this.findAll(selector)[0] ?? null }
  querySelectorAll(selector: string): FakeNode[] { return this.findAll(selector) }
  closest(selector: string): FakeNode | null {
    const simple = parseSimple(selector)
    for (let node: FakeNode | null = this; node !== null; node = node.parent) {
      if (matchesSimple(node, simple)) return node
    }
    return null
  }
  getBoundingClientRect(): { bottom: number } { return this.rect ?? { bottom: 0 } }
  /** Descendants only, document order — the real DOM semantics. */
  findAll(selector: string): FakeNode[] {
    const parts = selector.split(' > ')
    const child = parseSimple(parts[parts.length - 1] as string)
    const parent = parts.length > 1 ? parseSimple(parts[parts.length - 2] as string) : null
    const out: FakeNode[] = []
    const walk = (node: FakeNode): void => {
      for (const candidate of node.children) {
        if (matchesSimple(candidate, child)
          && (parent === null || (candidate.parent !== null && matchesSimple(candidate.parent, parent)))) {
          out.push(candidate)
        }
        walk(candidate)
      }
    }
    walk(this)
    return out
  }
}

/** Attach child to parent, wiring the parent chain the selectors walk. */
export function attach(parent: FakeNode, child: FakeNode): FakeNode {
  parent.children.push(child)
  child.parent = parent
  return child
}
