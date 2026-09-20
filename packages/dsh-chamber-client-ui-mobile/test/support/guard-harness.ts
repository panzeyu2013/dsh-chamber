/**
 * Minimal DOM/window double for the composer visibility guard's behavioral
 * tests (F5/F6/F8): a plain-node tree with real descendant/attribute selector
 * semantics, a fake window with NO visualViewport (so a test proves the poll —
 * not a viewport event — is the convergence path), a fake clock driving the
 * guard's 250ms interval, and an engine model that decides how fully the
 * (fake) layout honors the sticky inset.
 *
 * The package never runs a DOM environment (test/behavior/composer.test.ts is
 * pure-logic), so this is the smallest surface the guard actually touches.
 * createGuardHarness() patches the globals the guard reads and restore()
 * unpatches them; tests must run inside one synchronous block.
 */
import { installComposerVisibilityGuard, MOBILE_KBD_VAR } from '../../src/client/composer.ts'

export interface FakeRect {
  top: number
  left: number
  width: number
  height: number
  bottom: number
}

export class FakeStyle {
  cssText = ''
  height = ''
  private readonly properties = new Map<string, string>()
  /** Test hook: notified with every custom-property write (the engine model
   *  reacts to the guard's one actuator here). */
  onSet: ((name: string, value: string) => void) | null = null
  setProperty(name: string, value: string): void {
    this.properties.set(name, value)
    this.onSet?.(name, value)
  }
  getPropertyValue(name: string): string { return this.properties.get(name) ?? '' }
  removeProperty(name: string): void { this.properties.delete(name) }
}

class FakeNodeBase {}

/** The element double: attributes, a wired parent chain, the selector
 *  semantics the guard's queries need (`[attr]`, `[attr="v"]`, tag,
 *  descendant combinators, comma lists) and a mutable rect. */
export class FakeElement extends FakeNodeBase {
  readonly tagName: string
  readonly attributes = new Map<string, string>()
  readonly children: FakeElement[] = []
  readonly style = new FakeStyle()
  parentElement: FakeElement | null = null
  isContentEditable = false
  contentEditable = 'inherit'
  scrollTop = 0
  scrollHeight = 0
  clientHeight = 0
  rect: FakeRect = { top: 0, left: 0, width: 390, height: 600, bottom: 600 }
  /** Test hook: count the guard's measurements per element. */
  onRect: (() => void) | null = null
  private connected = true
  constructor(tagName: string) {
    super()
    this.tagName = tagName
  }
  get isConnected(): boolean { return this.connected }
  get nextElementSibling(): FakeElement | null {
    if (this.parentElement === null) return null
    const index = this.parentElement.children.indexOf(this)
    return this.parentElement.children[index + 1] ?? null
  }
  get previousElementSibling(): FakeElement | null {
    if (this.parentElement === null) return null
    const index = this.parentElement.children.indexOf(this)
    return index <= 0 ? null : this.parentElement.children[index - 1] ?? null
  }
  setAttribute(name: string, value = ''): void { this.attributes.set(name, value) }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null }
  hasAttribute(name: string): boolean { return this.attributes.has(name) }
  removeAttribute(name: string): void { this.attributes.delete(name) }
  matches(selector: string): boolean { return matchesSelector(this, selector) }
  closest(selector: string): FakeElement | null {
    for (let node: FakeElement | null = this; node !== null; node = node.parentElement) {
      if (matchesSelector(node, selector)) return node
    }
    return null
  }
  appendChild(child: FakeElement): FakeElement { return this.insertBefore(child, null) }
  append(...nodes: FakeElement[]): void { for (const node of nodes) this.appendChild(node) }
  insertBefore(child: FakeElement, reference: FakeElement | null): FakeElement {
    child.parentElement?.detach(child)
    const index = reference === null ? this.children.length : this.children.indexOf(reference)
    this.children.splice(index === -1 ? this.children.length : index, 0, child)
    child.parentElement = this
    child.connected = true
    return child
  }
  remove(): void {
    this.parentElement?.detach(this)
    this.parentElement = null
    this.connected = false
  }
  querySelector(selector: string): FakeElement | null { return this.querySelectorAll(selector)[0] ?? null }
  /** Descendants only, document order — the real DOM semantics. */
  querySelectorAll(selector: string): FakeElement[] {
    const out: FakeElement[] = []
    const walk = (node: FakeElement): void => {
      for (const child of node.children) {
        if (matchesSelector(child, selector)) out.push(child)
        walk(child)
      }
    }
    walk(this)
    return out
  }
  getBoundingClientRect(): FakeRect {
    this.onRect?.()
    return this.rect
  }
  private detach(child: FakeElement): void {
    const index = this.children.indexOf(child)
    if (index !== -1) this.children.splice(index, 1)
  }
}

interface AttrMatcher { readonly name: string; readonly value: string | null }
interface Compound { readonly tag: string | null; readonly attrs: readonly AttrMatcher[] }

function parseCompound(token: string): Compound {
  const pieces = token.match(/[a-z]+|\[[^\]]+\]/gi) ?? []
  let tag: string | null = null
  const attrs: AttrMatcher[] = []
  for (const piece of pieces) {
    if (piece.startsWith('[')) {
      const match = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(piece)
      if (match === null) throw new Error(`guard-harness: unsupported attribute anchor ${piece}`)
      attrs.push({ name: match[1] as string, value: match[2] ?? null })
    } else {
      tag = piece.toLowerCase()
    }
  }
  if (tag === null && attrs.length === 0) throw new Error(`guard-harness: unsupported selector token ${token}`)
  return { tag, attrs }
}

function matchesCompound(node: FakeElement, compound: Compound): boolean {
  if (compound.tag !== null && node.tagName.toLowerCase() !== compound.tag) return false
  return compound.attrs.every(attr => attr.value === null
    ? node.hasAttribute(attr.name)
    : node.getAttribute(attr.name) === attr.value)
}

function matchesChain(node: FakeElement, tokens: readonly string[]): boolean {
  if (!matchesCompound(node, parseCompound(tokens[tokens.length - 1] as string))) return false
  if (tokens.length === 1) return true
  for (let ancestor = node.parentElement; ancestor !== null; ancestor = ancestor.parentElement) {
    if (matchesChain(ancestor, tokens.slice(0, -1))) return true
  }
  return false
}

function matchesSelector(node: FakeElement, selector: string): boolean {
  return selector.split(',').some(part => matchesChain(node, part.trim().split(/\s+/)))
}

/** A deterministic clock: setInterval/clearInterval callbacks run only when a
 *  test advances time, and Date.now() follows. */
export class FakeClock {
  now = 1_000_000
  private readonly timers = new Map<number, { fn: () => void; interval: number; next: number }>()
  private nextId = 1
  setInterval(fn: () => void, interval: number): number {
    const id = this.nextId++
    this.timers.set(id, { fn, interval, next: this.now + interval })
    return id
  }
  clearInterval(id: number): void { this.timers.delete(id) }
  get pending(): number { return this.timers.size }
  advance(ms: number): void {
    const end = this.now + ms
    for (let guard = 0; guard < 100_000; guard += 1) {
      let dueId: number | null = null
      let dueNext = Number.POSITIVE_INFINITY
      for (const [id, timer] of this.timers) {
        if (timer.next <= end && timer.next < dueNext) { dueId = id; dueNext = timer.next }
      }
      if (dueId === null) break
      this.now = dueNext
      const timer = this.timers.get(dueId)
      if (timer === undefined) continue
      timer.fn()
      const live = this.timers.get(dueId)
      if (live !== undefined) live.next = this.now + live.interval
    }
    this.now = end
  }
  clearAll(): void { this.timers.clear() }
}

export interface FakeEvent { readonly target: unknown }

export class FakeDocument {
  readonly documentElement = new FakeElement('html')
  readonly body = new FakeElement('body')
  activeElement: FakeElement | null = null
  visibilityState = 'visible'
  private readonly listeners = new Map<string, Array<(event: FakeEvent) => void>>()
  createElement(tagName: string): FakeElement { return new FakeElement(tagName) }
  getSelection(): null { return null }
  addEventListener(type: string, handler: (event: FakeEvent) => void): void {
    const list = this.listeners.get(type) ?? []
    list.push(handler)
    this.listeners.set(type, list)
  }
  removeEventListener(type: string, handler: (event: FakeEvent) => void): void {
    const list = this.listeners.get(type)
    if (list === undefined) return
    const index = list.indexOf(handler)
    if (index !== -1) list.splice(index, 1)
  }
  dispatch(type: string, target: unknown): void {
    for (const handler of [...(this.listeners.get(type) ?? [])]) handler({ target })
  }
}

export class FakeWindow {
  innerHeight = 844
  /** The Android-WebView engine this harness models: no visual viewport at
   *  all, so no viewport event can ever arrive. */
  visualViewport: null = null
  private readonly listeners = new Map<string, Array<() => void>>()
  addEventListener(type: string, handler: () => void): void {
    const list = this.listeners.get(type) ?? []
    list.push(handler)
    this.listeners.set(type, list)
  }
  removeEventListener(type: string, handler: () => void): void {
    const list = this.listeners.get(type)
    if (list === undefined) return
    const index = list.indexOf(handler)
    if (index !== -1) list.splice(index, 1)
  }
}

export interface GuardHarnessOptions {
  /** How fully the fake engine honors the sticky inset: 1 = the seat lands
   *  exactly where the lift puts it, 0 = the seat never moves. */
  responsiveness?: number
  /** Measured overlap at install time (px). */
  covered?: number
  /** Focus the composer before install (default true). */
  focused?: boolean
  /** Insert a second, HIDDEN [data-phase="active"] root (its scrollport rect
   *  is 0x0) BEFORE the real one — the first-match seat trap (F3). */
  hiddenSeatFirst?: boolean
  /** The keyboard keeps RISING while the guard's first write lands: the
   *  visible bottom drops by this many px on the first custom-property write,
   *  so the applied lift genuinely lands short and the bounded verify loop
   *  must correct it within the same sync. */
  keyboardGrowthOnFirstWrite?: number
}

export interface GuardHarness {
  readonly root: FakeElement
  readonly frame: FakeElement
  readonly seat: FakeElement
  readonly input: FakeElement
  readonly scroller: FakeElement
  readonly outsideInput: FakeElement
  readonly document: FakeDocument
  readonly window: FakeWindow
  readonly clock: FakeClock
  readonly counts: { scrollerRects: number; seatRects: number }
  responsiveness: number
  install(): () => void
  /** Geometry moves with NO event dispatched (the silent-keyboard engine). */
  openKeyboardWithoutEvents(covered?: number): void
  pointerDown(): void
  focusIn(): void
  focusComposer(): void
  focusOutsideEditable(): void
  blur(): void
  restore(): void
}

function rect(bottom: number, width = 390, height = 600): FakeRect {
  return { top: bottom - height, left: 0, width, height, bottom }
}

const globals = globalThis as unknown as Record<string, unknown>

/** Build the tree + patch globals. Always pair with restore(). */
export function createGuardHarness(options: GuardHarnessOptions = {}): GuardHarness {
  const saved: Record<string, unknown> = {
    Node: globals.Node,
    Element: globals.Element,
    HTMLElement: globals.HTMLElement,
    document: globals.document,
    window: globals.window,
    MutationObserver: globals.MutationObserver,
    setInterval: globals.setInterval,
    clearInterval: globals.clearInterval,
  }
  const savedDateNow = Date.now
  const clock = new FakeClock()
  const documentDouble = new FakeDocument()
  const windowDouble = new FakeWindow()
  globals.Node = FakeNodeBase
  globals.Element = FakeElement
  globals.HTMLElement = FakeElement
  globals.document = documentDouble
  globals.window = windowDouble
  globals.MutationObserver = class {
    observe(): void {}
    disconnect(): void {}
    takeRecords(): [] { return [] }
  }
  globals.setInterval = (fn: () => void, ms: number): number => clock.setInterval(fn, ms)
  globals.clearInterval = (id: number): void => { clock.clearInterval(id) }
  Date.now = (): number => clock.now

  const root = documentDouble.createElement('div')
  root.setAttribute('data-slot', 'root')
  documentDouble.body.appendChild(root)
  const frame = documentDouble.createElement('div')
  frame.setAttribute('data-mobile-frame', '')
  root.appendChild(frame)

  const makeSeat = (): { phaseRoot: FakeElement; scroller: FakeElement; seat: FakeElement; input: FakeElement } => {
    const phaseRoot = documentDouble.createElement('div')
    phaseRoot.setAttribute('data-phase', 'active')
    const scroller = documentDouble.createElement('div')
    scroller.setAttribute('data-conversation-scroll', '')
    const seat = documentDouble.createElement('div')
    seat.setAttribute('data-composer-seat', '')
    const input = documentDouble.createElement('div')
    input.setAttribute('data-composer-input', '')
    input.contentEditable = 'true'
    input.isContentEditable = true
    seat.appendChild(input)
    scroller.appendChild(seat)
    phaseRoot.appendChild(scroller)
    return { phaseRoot, scroller, seat, input }
  }

  if (options.hiddenSeatFirst === true) {
    const hidden = makeSeat()
    hidden.scroller.rect = rect(0, 0, 0)
    hidden.seat.rect = rect(0, 0, 0)
    frame.appendChild(hidden.phaseRoot)
  }
  const visible = makeSeat()
  frame.appendChild(visible.phaseRoot)
  const { scroller, seat, input } = visible

  const covered = options.covered ?? 336
  const seatBase = windowDouble.innerHeight + covered
  scroller.rect = rect(seatBase)
  seat.rect = rect(seatBase, 390, 20)
  scroller.scrollHeight = 2_000
  scroller.clientHeight = 600
  scroller.scrollTop = 1_400

  const outsideInput = documentDouble.createElement('div')
  outsideInput.setAttribute('data-outside-editable', '')
  outsideInput.contentEditable = 'true'
  outsideInput.isContentEditable = true
  documentDouble.body.appendChild(outsideInput)

  const counts = { scrollerRects: 0, seatRects: 0 }
  scroller.onRect = (): void => { counts.scrollerRects += 1 }
  seat.onRect = (): void => { counts.seatRects += 1 }

  let appliedLift = 0
  let liftWrites = 0
  const harness: GuardHarness = {
    root, frame, seat, input, scroller, outsideInput,
    document: documentDouble,
    window: windowDouble,
    clock,
    counts,
    responsiveness: options.responsiveness ?? 1,
    install: (): (() => void) => installComposerVisibilityGuard(root as unknown as ParentNode),
    openKeyboardWithoutEvents: (value = 336): void => {
      const bottom = windowDouble.innerHeight + value
      scroller.rect = rect(bottom)
      // The scrollport box does not move under the guard's own writes; the
      // seat's base IS the scrollport bottom, minus whatever lift the engine
      // already honored.
      seat.rect = rect(bottom - appliedLift * harness.responsiveness, 390, 20)
    },
    pointerDown: (): void => { documentDouble.dispatch('pointerdown', input) },
    focusIn: (): void => {
      documentDouble.activeElement = input
      documentDouble.dispatch('focusin', input)
    },
    focusComposer: (): void => { documentDouble.activeElement = input },
    focusOutsideEditable: (): void => { documentDouble.activeElement = outsideInput },
    blur: (): void => {
      documentDouble.activeElement = null
      documentDouble.dispatch('focusout', input)
    },
    restore: (): void => {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete globals[key]
        else globals[key] = value
      }
      Date.now = savedDateNow
    },
  }
  frame.style.onSet = (name, value) => {
    if (name !== MOBILE_KBD_VAR) return
    const lift = Number.parseFloat(value)
    if (!Number.isFinite(lift)) return
    appliedLift = lift
    if (liftWrites === 0 && (options.keyboardGrowthOnFirstWrite ?? 0) > 0) {
      windowDouble.innerHeight -= options.keyboardGrowthOnFirstWrite as number
    }
    liftWrites += 1
    seat.rect = rect(scroller.rect.bottom - lift * harness.responsiveness, 390, 20)
  }
  if (options.focused !== false) documentDouble.activeElement = input
  return harness
}
