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
   * network error, so the page's own error paths run.
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
  /** Dispatch a keydown to the script's document-level listeners. */
  pressKey(key: string, options?: { shiftKey?: boolean }): void
  /** Id of the focused element, or null. */
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
  disabled = false
  /** Attributes the SCRIPT sets (aria-busy); the markup's own are not mirrored. */
  readonly attributes = new Map<string, string>()
  readonly children: FakeElement[] = []
  focusCount = 0
  private readonly listeners = new Map<string, FakeListener[]>()
  private readonly owner: FakeDocument

  constructor(owner: FakeDocument, tag: string, id = '') {
    this.owner = owner
    this.tag = tag
    this.id = id
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
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener({ type, target: this, preventDefault() {}, ...event })
    }
  }
}

/** The document stub: markup-checked id lookup, element creation, listeners. */
export class FakeDocument {
  activeElement: FakeElement | null = null
  private readonly elements = new Map<string, FakeElement>()
  private readonly documentListeners = new Map<string, FakeListener[]>()
  private readonly html: string

  constructor(html: string) {
    this.html = html
  }

  /** The opening tag carrying this id, or null when the served markup has none. */
  private tagFor(id: string): string | null {
    const match = this.html.match(new RegExp('<[^>]*\\bid="' + id + '"[^>]*>'))
    return match === null ? null : match[0]
  }

  byId(id: string): FakeElement {
    const existing = this.elements.get(id)
    if (existing !== undefined) return existing
    const tag = this.tagFor(id)
    // The served markup is the id contract: a script/markup drift must fail
    // here rather than be papered over by a stand-in node.
    if (tag === null) throw new Error('the served markup has no element with id "' + id + '"')
    const element = new FakeElement(this, 'div', id)
    // Initial state comes from that markup (the hidden backdrop, the disabled
    // runtime controls, the class vocabulary the dialog reuses), so the
    // harness starts where the page starts.
    const className = tag.match(/\bclass="([^"]*)"/)
    element.className = className === null ? '' : className[1]
    element.hidden = /(^|\s)hidden(\s|>|=|\/)/.test(tag)
    element.disabled = /(^|\s)disabled(\s|>|=|\/)/.test(tag)
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

  /** Dispatch a keydown to the script's document-level listeners. */
  pressKey(key: string, options: { shiftKey?: boolean } = {}): void {
    for (const listener of [...(this.documentListeners.get('keydown') ?? [])]) {
      listener({ type: 'keydown', key, shiftKey: options.shiftKey === true, preventDefault() {} })
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
