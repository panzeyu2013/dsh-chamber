/**
 * DOM + fetch harness for the gateway dashboard's own classic script
 * (2026-09-11 upstream-alignment T2).
 *
 * The served `/chamber/app.js` is deliberately dependency-free, and this
 * package has neither a DOM nor a DOM library as a test dependency. So the
 * script is EXECUTED against the smallest document/fetch stand-in it actually
 * touches — element stubs keyed by id, listeners dispatched through
 * `click()` / `pressKey()`, and a fetch spy that records every request —
 * instead of asserting the script's text and calling that behaviour.
 *
 * The stand-in cannot invent a node the real page lacks: `byId` refuses an id
 * that is absent from the served markup, and element `hidden`/`disabled`
 * initial state is read from that markup too, so the harness starts where the
 * browser starts. Only behaviour-relevant APIs are implemented (this is a
 * driver for the page's own code, not a DOM implementation), and the page's
 * timers are inert: its abort guard, token-reveal timer and 3s status poll
 * cannot affect what these tests observe, and a live 15s timer would hold the
 * test process open behind a request the harness deliberately leaves pending.
 *
 * 2026-09-11 review-fix F1: `pressKey('Tab')` now performs the browser's own
 * Tab move (the next tabbable element of the served markup, in document
 * order) unless the script called `preventDefault()` — without it a "the trap
 * held" assertion proved nothing, because focus never moved either way. The
 * tab order is derived from the markup's element nesting, so a hidden or
 * `inert` ANCESTOR removes its whole subtree from the order, and a control the
 * script disabled mid-test leaves the order exactly like the browser drops it.
 * Two emulated browser rules make the pending window reproducible: setting
 * `disabled` on the focused control moves focus to `<body>`, and the script's
 * `inert` attribute (read through the same element stubs) takes a background
 * landmark and its subtree out of reach.
 */

/** One request the page issued (the fetch spy's record). */
export interface DashboardRequest {
  path: string
  method: string
  /** The parsed JSON body, or undefined when the request carried none. */
  body: Record<string, unknown> | undefined
}

export interface DashboardHarnessOptions {
  /** The served `/chamber/` markup: every id the script asks for must exist here. */
  html: string
  /** The served `/chamber/app.js` source. */
  script: string
  /**
   * Answer one request with its JSON payload. Throwing fails the fetch like a
   * network error, so the page's own error paths run — which also means a
   * spurious request is NOT visible as a failure here: assert the recorded
   * path set per scenario (`requests`).
   */
  respond: (request: DashboardRequest) => unknown
  /**
   * Paths whose requests stay recorded but unanswered until `release()` — the
   * window in which a confirmed action is observably still pending.
   */
  hold?: readonly string[]
}

export interface DashboardHarness {
  /** The element carrying this id (it must exist in the served markup). */
  byId(id: string): FakeElement
  /** Click a control, the way a browser does: a disabled control fires nothing. */
  click(id: string): void
  /**
   * Dispatch a keydown to the script's document-level listeners, then perform
   * the browser's own Tab move unless the script prevented the default.
   */
  pressKey(key: string, options?: { shiftKey?: boolean }): void
  /** Id of the focused element, or null (nothing focused: `<body>`). */
  activeElementId(): string | null
  /** Whether the confirmation dialog is open (its backdrop is not hidden). */
  dialogOpen(): boolean
  /** Every request the page issued, in order. */
  readonly requests: DashboardRequest[]
  /** The requests to one path, in order. */
  requestsTo(path: string): DashboardRequest[]
  /** Release the held requests and settle everything they trigger. */
  release(): Promise<void>
  /** Let every pending microtask (the page's boot chains included) settle. */
  settle(): Promise<void>
}

interface FakeEvent {
  type: string
  key?: string
  shiftKey?: boolean
  target?: FakeElement
  defaultPrevented?: boolean
  preventDefault(): void
}

type FakeListener = (event: FakeEvent) => void

/** One element stub: exactly the DOM surface the dashboard script touches. */
export class FakeElement {
  readonly tag: string
  readonly id: string
  textContent = ''
  className = ''
  value = ''
  hidden = false
  /** Attributes the SCRIPT sets (inert, aria-busy); the markup's own are read
   *  from the served markup instead of being mirrored here. */
  readonly attributes = new Map<string, string>()
  readonly children: FakeElement[] = []
  focusCount = 0
  private disabledState = false
  private readonly listeners = new Map<string, FakeListener[]>()
  private readonly owner: FakeDocument

  constructor(owner: FakeDocument, tag: string, id = '') {
    this.owner = owner
    this.tag = tag
    this.id = id
  }

  /**
   * A disabled control is not focusable, and disabling the control that owns
   * the focus throws focus back to `<body>` — the browser rule that puts an
   * accepted action's pending window (both dialog controls disabled) at the
   * top of the document's tab order.
   */
  get disabled(): boolean { return this.disabledState }

  set disabled(value: boolean) {
    this.disabledState = value
    if (value && this.owner.activeElement === this) this.owner.activeElement = null
  }

  /** A real select exposes its options; the page's version list reads them. */
  get options(): FakeElement[] { return this.children }

  setAttribute(name: string, value: string): void { this.attributes.set(name, value) }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null }
  removeAttribute(name: string): void { this.attributes.delete(name) }

  appendChild(node: FakeElement): FakeElement {
    // A DocumentFragment's children move into the parent (real DOM).
    if (node.tag === '#fragment') {
      for (const child of node.children.splice(0, node.children.length)) this.children.push(child)
      return node
    }
    this.children.push(node)
    return node
  }

  replaceChildren(...nodes: FakeElement[]): void {
    this.children.length = 0
    for (const node of nodes) this.appendChild(node)
  }

  addEventListener(type: string, listener: FakeListener): void {
    const registered = this.listeners.get(type)
    if (registered === undefined) this.listeners.set(type, [listener])
    else registered.push(listener)
  }

  removeEventListener(type: string, listener: FakeListener): void {
    const registered = this.listeners.get(type)
    if (registered === undefined) return
    const index = registered.indexOf(listener)
    if (index !== -1) registered.splice(index, 1)
  }

  focus(): void {
    this.focusCount += 1
    this.owner.activeElement = this
  }

  click(): void {
    if (this.disabled) return
    this.emit('click')
  }

  /** Dispatch one event to this element's listeners (a disabled control is not consulted — click() owns that rule). */
  emit(type: string, event: Partial<FakeEvent> = {}): void {
    const dispatched: FakeEvent = {
      type,
      target: this,
      defaultPrevented: false,
      preventDefault() { dispatched.defaultPrevented = true },
      ...event,
    }
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(dispatched)
    }
  }
}

/** One element the served markup declares, with the nesting the tab order
 *  needs (an element's own tag/attributes are read from its opening tag). */
interface MarkupNode {
  tag: string
  /** The opening tag's attribute text (never the tag name). */
  attrs: string
  /** The element's id, or '' when it has none. */
  id: string
  /** Index of the parent node, or -1 for a top-level element. */
  parent: number
}

/** Elements that never carry children, so the scanner must not expect a close tag. */
const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
])

/** The tab-order-relevant tags; a bare anchor without href is not focusable. */
const FOCUSABLE_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea'])

/** Is the bare attribute `name` present in an opening tag's attribute text?
 *  Anchored on the attribute boundary, so `type="hidden"` never reads as
 *  `hidden` and `data-not-disabled` never reads as `disabled`. */
function hasAttribute(attrs: string, name: string): boolean {
  return new RegExp('(^|\\s)' + name + '(\\s|=|$)').test(attrs)
}

/**
 * Scan the served markup into a flat node list with parent links. The page
 * carries no inline script or style TEXT that looks like markup (the script is
 * a src-only tag, the CSS holds no angle brackets), so a tag-level scan is
 * enough; an unclosed child is tolerated by popping to the matching open tag.
 */
function parseMarkup(html: string): { nodes: MarkupNode[]; indexById: Map<string, number> } {
  const nodes: MarkupNode[] = []
  const indexById = new Map<string, number>()
  const stack: number[] = []
  const pattern = /<(\/?)([a-zA-Z][^\s/>]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(html)) !== null) {
    const tag = match[2].toLowerCase()
    const attrs = match[3] ?? ''
    if (match[1] === '/') {
      for (let depth = stack.length - 1; depth >= 0; depth -= 1) {
        if (nodes[stack[depth]].tag === tag) { stack.length = depth; break }
      }
      continue
    }
    const id = /\bid="([^"]*)"/.exec(attrs)?.[1] ?? ''
    nodes.push({ tag, attrs, id, parent: stack.length === 0 ? -1 : stack[stack.length - 1] })
    if (id !== '' && !indexById.has(id)) indexById.set(id, nodes.length - 1)
    if (!VOID_ELEMENTS.has(tag) && !attrs.trimEnd().endsWith('/')) stack.push(nodes.length - 1)
  }
  return { nodes, indexById }
}

/** The document stub: markup-checked id lookup, element creation, listeners. */
export class FakeDocument {
  activeElement: FakeElement | null = null
  private readonly elements = new Map<string, FakeElement>()
  /** Stubs for the markup's id-less elements (only the tab walk needs them). */
  private readonly anonymous = new Map<number, FakeElement>()
  private readonly documentListeners = new Map<string, FakeListener[]>()
  private readonly nodes: MarkupNode[]
  private readonly indexById: Map<string, number>

  constructor(html: string) {
    const parsed = parseMarkup(html)
    this.nodes = parsed.nodes
    this.indexById = parsed.indexById
  }

  /** The markup's own state for one node (class vocabulary, hidden, disabled). */
  private stubFor(nodeIndex: number): FakeElement {
    const node = this.nodes[nodeIndex]
    const element = new FakeElement(this, node.tag, node.id)
    const className = /\bclass="([^"]*)"/.exec(node.attrs)
    element.className = className === null ? '' : className[1]
    element.hidden = hasAttribute(node.attrs, 'hidden')
    element.disabled = hasAttribute(node.attrs, 'disabled')
    return element
  }

  byId(id: string): FakeElement {
    const existing = this.elements.get(id)
    if (existing !== undefined) return existing
    const nodeIndex = this.indexById.get(id)
    // The served markup is the id contract: a script/markup drift must fail
    // here rather than be papered over by a stand-in node.
    if (nodeIndex === undefined) throw new Error('the served markup has no element with id "' + id + '"')
    // Initial state comes from that markup (the hidden backdrop, the disabled
    // runtime controls, the class vocabulary the dialog reuses), so the
    // harness starts where the page starts.
    const element = this.stubFor(nodeIndex)
    this.elements.set(id, element)
    return element
  }

  /** The script's own entry point into this stub. */
  getElementById(id: string): FakeElement { return this.byId(id) }

  createElement(tag: string): FakeElement { return new FakeElement(this, tag) }

  createDocumentFragment(): FakeElement { return new FakeElement(this, '#fragment') }

  addEventListener(type: string, listener: FakeListener): void {
    const registered = this.documentListeners.get(type)
    if (registered === undefined) this.documentListeners.set(type, [listener])
    else registered.push(listener)
  }

  removeEventListener(type: string, listener: FakeListener): void {
    const registered = this.documentListeners.get(type)
    if (registered === undefined) return
    const index = registered.indexOf(listener)
    if (index !== -1) registered.splice(index, 1)
  }

  /**
   * Dispatch a keydown to the script's document-level listeners, then perform
   * the browser's default Tab move. A script that handles Tab must call
   * `preventDefault()` — that is the only thing standing between the dialog
   * and the page behind it, so the harness must honour exactly that.
   */
  pressKey(key: string, options: { shiftKey?: boolean } = {}): void {
    const event: FakeEvent = {
      type: 'keydown',
      key,
      shiftKey: options.shiftKey === true,
      target: this.activeElement ?? undefined,
      defaultPrevented: false,
      preventDefault() { event.defaultPrevented = true },
    }
    for (const listener of [...(this.documentListeners.get('keydown') ?? [])]) listener(event)
    if (key === 'Tab' && event.defaultPrevented !== true) this.moveFocusByTab(event.shiftKey === true)
  }

  /** The browser's Tab move: the next tabbable element of the served markup in
   *  document order, wrapping at both ends (from `<body>`, forward starts at
   *  the first one and backward at the last). */
  private moveFocusByTab(shiftKey: boolean): void {
    const stops = this.tabbableStops()
    if (stops.length === 0) return
    const from = this.nodeIndexOfActive()
    if (!shiftKey) {
      const next = stops.find(stop => stop > from)
      this.stubAt(next ?? stops[0]).focus()
      return
    }
    const previous = [...stops].reverse().find(stop => stop < from)
    this.stubAt(previous ?? stops[stops.length - 1]).focus()
  }

  /** The markup node index of the focused element, or -1 for anything the
   *  markup does not declare (a script-created node, or `<body>` itself). */
  private nodeIndexOfActive(): number {
    const active = this.activeElement
    if (active === null || active.id === '') return -1
    return this.indexById.get(active.id) ?? -1
  }

  /** The fake for a node, found by id when it has one (the script and the walk
   *  must see the SAME stub) and cached by index otherwise. */
  private stubAt(nodeIndex: number): FakeElement {
    const node = this.nodes[nodeIndex]
    if (node.id !== '') return this.byId(node.id)
    const existing = this.anonymous.get(nodeIndex)
    if (existing !== undefined) return existing
    const stub = this.stubFor(nodeIndex)
    this.anonymous.set(nodeIndex, stub)
    return stub
  }

  /** The tabbable node indices, in document order. Recomputed per walk: the
   *  order depends on runtime state too (a control the script disabled, a
   *  landmark it made inert), so a cached list would keep walking an element
   *  the browser has already dropped. */
  private tabbableStops(): number[] {
    return this.nodes.map((_, index) => index).filter(index => this.isTabbable(index))
  }

  /** Does the browser consider this node tabbable? The element's own tag and
   *  state decide its candidacy; a hidden or inert ancestor removes the whole
   *  subtree. */
  private isTabbable(nodeIndex: number): boolean {
    const node = this.nodes[nodeIndex]
    const declaredTabIndex = /\btabindex="(-?\d+)"/.exec(node.attrs)
    const focusableTag = node.tag === 'a'
      ? hasAttribute(node.attrs, 'href')
      : FOCUSABLE_TAGS.has(node.tag)
    const tabIndex = declaredTabIndex === null ? null : Number(declaredTabIndex[1])
    if (tabIndex === null ? !focusableTag : tabIndex < 0) return false
    if (this.stateOf(nodeIndex).disabled || /\btype="hidden"/.test(node.attrs)) return false
    return !this.isRemoved(nodeIndex)
  }

  /** Is the node or one of its ancestors hidden or inert? */
  private isRemoved(nodeIndex: number): boolean {
    for (let index: number = nodeIndex; index !== -1; index = this.nodes[index].parent) {
      const state = this.stateOf(index)
      if (state.hidden || state.inert) return true
    }
    return false
  }

  /**
   * The state a browser would see for one node. The served markup supplies the
   * STARTING state, and the element stub — created the moment the script looks
   * the element up — SUPERSEDES it: the script un-hides the backdrop, enables
   * runtime controls and marks the background inert, and a walk that kept
   * reading the markup would keep the dialog out of the order while it is open
   * and the page behind in it after `inert` was applied.
   */
  private stateOf(nodeIndex: number): { hidden: boolean; disabled: boolean; inert: boolean } {
    const node = this.nodes[nodeIndex]
    const stub = node.id === '' ? undefined : this.elements.get(node.id)
    if (stub === undefined) {
      return {
        hidden: hasAttribute(node.attrs, 'hidden'),
        disabled: hasAttribute(node.attrs, 'disabled'),
        inert: hasAttribute(node.attrs, 'inert'),
      }
    }
    return {
      hidden: stub.hidden,
      disabled: stub.disabled,
      inert: stub.getAttribute('inert') !== null,
    }
  }
}

/** Load the served dashboard script against the DOM/fetch stand-in. */
export function createDashboardHarness(options: DashboardHarnessOptions): DashboardHarness {
  const document = new FakeDocument(options.html)
  const requests: DashboardRequest[] = []
  const held: Array<() => void> = []
  const hold = new Set(options.hold ?? [])

  /** One served response: an HTTP 200 carrying the responder's JSON payload. */
  function answer(request: DashboardRequest): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }> {
    return Promise.resolve()
      .then(() => options.respond(request))
      .then(payload => ({ ok: true, status: 200, json: async () => payload }))
  }

  const fetchSpy = (path: string, init: { method?: string; body?: string } = {}) => {
    const request: DashboardRequest = {
      path,
      method: init.method ?? 'GET',
      body: init.body === undefined ? undefined : JSON.parse(init.body) as Record<string, unknown>,
    }
    requests.push(request)
    if (!hold.has(path)) return answer(request)
    // Held: recorded, answered only by release() — the window in which a
    // confirmed action is still pending.
    return new Promise(resolve => {
      held.push(() => { void answer(request).then(resolve) })
    })
  }

  const settle = (): Promise<void> => new Promise(resolve => { setImmediate(resolve) })

  const evaluate = new Function(
    'document', 'fetch', 'setTimeout', 'clearTimeout', 'setInterval', options.script,
  )
  evaluate(document, fetchSpy, () => 0, () => {}, () => 0)

  return {
    byId: id => document.byId(id),
    click: id => { document.byId(id).click() },
    pressKey: (key, pressOptions) => { document.pressKey(key, pressOptions) },
    activeElementId: () => document.activeElement === null ? null : document.activeElement.id,
    dialogOpen: () => document.byId('confirm-backdrop').hidden === false,
    requests,
    requestsTo: path => requests.filter(request => request.path === path),
    release: async () => {
      for (const start of held.splice(0, held.length)) start()
      await settle()
    },
    settle,
  }
}
