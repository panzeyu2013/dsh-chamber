/**
 * Session-load stall notice (design 17 §18, touch tier).
 *
 * THE DEFECT. Opening a session over the gateway can park the official chat
 * surface on its loading hint forever. The hint is the official
 * `dsh-client-ui-chat` view's loading-history face, rendered only while its
 * open state is `loading`, and NOTHING on either side of the wire is timed
 * out — neither the client render path nor the host's history load carries a
 * deadline — so one lost frame leaves a permanent loading face. The official
 * frontend offers no retry, no cancel and no reload affordance: a page reload
 * is what actually recovers, and the official UI never offers one.
 *
 * WHY AN OBSERVER, NOT A FIX. This package is the only chamber-owned code in
 * the instance's own frontend tier and the vendored official packages are
 * read-only (the constraint official-hover-card.ts documents), so the honest
 * lever is a notice: this module NEVER reloads on its own, NEVER re-opens a
 * session and NEVER touches the official load path. It watches for the
 * stalled SHAPE and offers the user exactly one action — reload the page.
 * Every failure is fail-closed: an unexpected DOM shape, a missing anchor or
 * a thrown probe simply shows nothing.
 *
 * THE SHAPE (attribute anchors only — the package's anchor discipline, see
 * docs/progress/STATUS.md: hash-class names and copy are NOT anchors). The
 * loading hint's own node carries only hashed CSS-module classes, so it can
 * never be matched; the stalled shape is described entirely by attributes the
 * official chat view emits:
 *   - `[data-chat-flow]` — the ChatView message column. Absent means no chat
 *     surface is on screen at all: no-op before any other anchor is read.
 *   - the flow's nearest `[data-phase]` ancestor is the conversation root
 *     (markup.ts's re-audited DOM map: `[data-slot="main"] >
 *     div.root[data-phase]`, which carries BOTH the session header outlet and
 *     the message column), and its phase must be one of STALL_PHASES. The
 *     emitter is upstream `conversationPhase()`, whose value space is exactly
 *     `active` / `engaging` / `blank`: `blank` is the no-conversation face
 *     where an empty column is CORRECT, so excluding it is what keeps a
 *     brand-new empty session from being reported as stalled; `engaging`
 *     (prompt attempted, first turn not produced yet) is INCLUDED because a
 *     stall that hits right after the first prompt leaves the column empty in
 *     exactly the same way. Ancestor coupling (rather than a bare
 *     document-wide phase existence test) also keeps the phase and the flow
 *     provably the same surface: no cross-root misfire, and the phase node
 *     doubles as the session identity below.
 *   - no message row anywhere inside the flow: rows carry
 *     `data-chat-anchor-key` (the official `routedNode.key` projection), so
 *     "nothing has ever rendered" is an existence test, never a count.
 *   - the session header outlet `[data-slot="conversation.session.header"]`
 *     still renders a `<header>` child that is actually displayed: with no
 *     session presented the official header is hidden, so its visibility is a
 *     second, independent "a real session is on screen" gate (the blank face
 *     can never pass it).
 *
 * THE DURABILITY AND PAGE-STATE CONDITIONS are the pure clock below: the
 * shape must hold CONTINUOUSLY for STALL_THRESHOLD_MS, and only while the
 * page is visible. Time spent hidden never counts and is discarded (the clock
 * restarts on resume) — the same "clock is 0 whenever the predicate breaks"
 * rule composer.ts's lockClock uses, and the only freeze-proof choice: a
 * backgrounded mobile page may have its timers suspended outright, so any
 * accumulated-time bookkeeping would resume against a stale timestamp and
 * over-count. Once the notice IS shown it stands until the shape itself
 * recovers, so a background/resume round trip cannot take it away for another
 * full threshold. Switching to a different conversation root (a different
 * session) resets both the clock and the notice.
 *
 * THE SURFACE. A body-level, fixed, top-anchored notice: non-modal, never
 * focused, never covering the composer (it sits under the session header it
 * belongs to, measured at show time with the CSS default as the fallback), and
 * `pointer-events: none` on everything but its one button — so it cannot trap
 * a tap even where it overlaps. z-index 19 keeps it above the conversation
 * content and BELOW the official `shell.overlay` layer (z-index 20 at body
 * level, which owns the drawer, the floating toggle and the fullscreen right
 * panel) — see the stacking note in styles.ts. Its few rules ride a dedicated
 * `<style data-plugin="dsh-chamber-mobile-stall">` tag injected and removed by
 * the installer: styles.ts is not extendable from here, and a JS-only inline
 * style could not express the tier default, which must stay declarative —
 * `display: none` outside the touch tier is the same "PC leak" default the nav
 * toggle and backdrop carry, and the element is only ever mounted while the
 * tier matches anyway. Copy comes from locales.ts (new keys only).
 *
 * Anchor-version note: every selector here is an attribute emitted by the
 * pinned official build (`data-phase` phase values, `data-chat-flow`,
 * `data-chat-anchor-key`, the `conversation.session.header` slot) and must be
 * re-audited when the vendored dsh pin moves, like every other anchor in this
 * package. A drifted anchor makes the notice a silent no-op — fail closed,
 * never a misfire.
 *
 * NOT COVERED: the instance-origin frontend opened DIRECTLY (e.g. :17510) has
 * no chamber client plugin at all, and a stall on a fine-pointer desktop
 * viewport is out of tier for this package by design (the PC-leak invariant).
 */
import { TOUCH_TIER_QUERY } from './composer.ts'
import type { MobileKey } from './locales.ts'

/**
 * How long the stalled shape must hold, continuously and on a visible page,
 * before the notice appears. Long enough that a slow-but-alive history load is
 * never called stalled; short enough that a phone left on a dead loading face
 * gets an exit without the user guessing.
 */
export const STALL_THRESHOLD_MS = 45_000

/**
 * Poll cadence. Deliberately slow: the condition is a long-lived page state,
 * not an event stream, and the official DOM streams thousands of mutations
 * while a session loads normally — a MutationObserver would be the wrong
 * channel here, so this module polls (plus an immediate recompute on
 * visibilitychange).
 */
export const STALL_POLL_MS = 3_000

/** The conversation root's phase attribute. The emitter is upstream
 *  `conversationPhase()` (ui-conversation): the value space is exactly
 *  `active` (a real conversation: active targets, or a non-blank session past
 *  its first turn, or a running turn), `engaging` (the user attempted a prompt
 *  and the first turn has not produced anything yet) and `blank` (no
 *  conversation). The composer node's own `data-phase` carries a different
 *  value set (`input.phase` / `inert`) and is never an ancestor of the chat
 *  flow, so the nearest-ancestor read below can only land on the root. */
export const CONVERSATION_PHASE_QUERY = '[data-phase]'

/** The phases that present a REAL conversation — the ones where an empty
 *  message column is a fault rather than the correct empty face. `engaging` is
 *  included deliberately: a stall that hits a brand-new session whose first
 *  prompt was already attempted leaves the column empty in exactly the same
 *  way, and the image/blank faces are excluded by `blank` staying out. */
export const STALL_PHASES: readonly string[] = ['active', 'engaging']

/** Is this root phase one where an empty flow means "stalled"? */
export function isStallPhase(value: string | null | undefined): boolean {
  return value !== null && value !== undefined && STALL_PHASES.includes(value)
}

/** The ChatView message column — the one unconditional chat-surface anchor. */
export const CHAT_FLOW_QUERY = '[data-chat-flow]'

/** A rendered message row (the official `routedNode.key` projection). */
export const CHAT_ROW_QUERY = '[data-chat-anchor-key]'

/** The session header: the header outlet plus its direct `<header>` child. */
export const SESSION_HEADER_QUERY = '[data-slot="conversation.session.header"] > header'

/** The notice's own marker (same naming family as the nav toggle/backdrop). */
export const STALL_STYLE_TAG = 'dsh-chamber-mobile-stall'
export const STALL_NOTICE_CLASS = 'dsh-mobile-stall'
export const STALL_NOTICE_MESSAGE_CLASS = 'dsh-mobile-stall-message'
export const STALL_NOTICE_ACTION_CLASS = 'dsh-mobile-stall-action'

/** Gap between the session header and the notice (px). */
export const STALL_NOTICE_GAP_PX = 8

/** When the header anchor is clamped, this much of the notice stays on screen
 *  (px) — the notice is never positioned off the bottom edge. */
export const STALL_NOTICE_MIN_VISIBLE_PX = 96

/** Double-install guard (the official-hover-card.ts pattern). */
const STALL_GUARD: unique symbol = Symbol.for('dsh-chamber.dsh-client-ui-mobile.session-stall')

/**
 * The notice's CSS. Tiny and self-contained because styles.ts is not
 * extendable from this module (file ownership) — see the module header for
 * why a style tag beats JS inline styles here. The default (`display: none`)
 * is OUTSIDE the tier media query on purpose: it is the declarative half of
 * the PC-leak guard, byte-identical to the tier the JS installer rides.
 */
export const STALL_NOTICE_CSS = `
/* Mobile-only surface: invisible outside the touch tier, the same default the
   nav toggle and backdrop carry (the official shell.overlay layer renders
   entries unconditionally; here the element is only ever mounted while the
   tier matches, so this is the second, declarative half of that guard). */
.dsh-mobile-stall {
  display: none;
}

@media ${TOUCH_TIER_QUERY} {
  .dsh-mobile-stall {
    position: fixed;
    /* Fallback anchor: clear of the floating nav toggle band. The installer
       overwrites this with the session header's measured bottom whenever that
       rect is usable. */
    top: calc(env(safe-area-inset-top, 0px) + 56px);
    left: 50%;
    transform: translateX(-50%);
    /* Above the conversation content, BELOW the official shell.overlay layer
       (z-index 20 at body level: drawer, floating toggle, right panel). */
    z-index: 19;
    box-sizing: border-box;
    display: flex;
    align-items: center;
    gap: 10px;
    max-width: min(92vw, 26rem);
    padding: 8px 8px 8px 12px;
    border-radius: 12px;
    background: var(--dsw-alias-bg-layer-2, #ffffff);
    color: var(--dsw-alias-label-primary, #1f1f1f);
    box-shadow: 0 4px 16px rgb(0 0 0 / 18%);
    font-size: 13px;
    line-height: 18px;
    /* The notice never blocks the page: only its action takes taps. */
    pointer-events: none;
  }
  .dsh-mobile-stall-message {
    flex: 1;
    min-width: 0;
  }
  .dsh-mobile-stall-action {
    flex: none;
    pointer-events: auto;
    padding: 6px 10px;
    border: none;
    border-radius: 8px;
    background: var(--dsw-alias-interactive-bg-hover);
    color: var(--dsw-alias-label-primary);
    font: inherit;
    white-space: nowrap;
    cursor: pointer;
    touch-action: manipulation;
    -webkit-appearance: none;
    appearance: none;
  }
  .dsh-mobile-stall-action:active {
    background: var(--dsw-alias-interactive-bg-active);
  }
  .dsh-mobile-stall-action:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px var(--dsw-alias-state-business-primary);
  }
}
`

/** The minimal node face the probe reads (real `Element` satisfies it; the
 *  tests drive it with a plain-node double, like markup.ts/official-hover-card.ts). */
export interface StallNodeFace {
  getAttribute(name: string): string | null
  querySelector(selector: string): StallNodeFace | null
  querySelectorAll(selector: string): ArrayLike<StallNodeFace>
  closest(selector: string): StallNodeFace | null
  getBoundingClientRect?(): { readonly bottom: number }
}

/** The minimal query-root face (real `Document` satisfies it). */
export interface StallQueryRootFace {
  querySelector(selector: string): StallNodeFace | null
}

/** The minimal node face the render check walks (real `Element` satisfies it). */
export interface RenderedNodeFace {
  readonly isConnected?: boolean
  readonly parentElement: RenderedNodeFace | null
  getAttribute(name: string): string | null
}

/** What the probe read out of one page state. */
export interface StallProbe {
  /** The `[data-phase]` node the flow belongs to, when it is active. */
  readonly activeRoot: StallNodeFace | null
  /** The displayed session header, when there is one (the position anchor). */
  readonly header: StallNodeFace | null
  /** A presented, active conversation is on screen. */
  readonly activeConversation: boolean
  /** The session header exists and is displayed. */
  readonly headerVisible: boolean
  /** The ChatView message column exists. */
  readonly flowPresent: boolean
  /** At least one message row is rendered inside that column. */
  readonly hasRows: boolean
}

/** The stall SHAPE, without the time and page-state conditions. */
export interface StallShapeFacts {
  readonly activeConversation: boolean
  readonly headerVisible: boolean
  readonly flowPresent: boolean
  readonly hasRows: boolean
}

/** The notice decision, plus the clock it leaves behind. */
export interface StallDecision {
  /** The first sighting of the current continuous stall, 0 when not timing. */
  readonly since: number
  /** Whether the notice belongs on screen now. */
  readonly show: boolean
}

export interface StallNoticeInput {
  readonly shape: boolean
  readonly pageVisible: boolean
  readonly since: number
  readonly now: number
}

/**
 * Is this the stalled shape — an active conversation whose chat column has
 * never rendered a row and whose session header is on screen? Pure —
 * unit-tested. The time and page-state halves of the criterion live in
 * decideStallNotice.
 * @param facts - the four structural facts of one probe.
 * @returns whether the page looks like a session stuck before its first row.
 */
export function isStallShape(facts: StallShapeFacts): boolean {
  return facts.activeConversation && facts.headerVisible && facts.flowPresent && !facts.hasRows
}

/**
 * The stall clock and the notice decision together. The clock is seeded at the
 * first sighting of the shape (`since === 0` means "not timing yet"), runs
 * only while the shape holds AND the page is visible, and is zeroed the moment
 * either half breaks — the stall must be CONTINUOUS and observed. Pure —
 * unit-tested.
 * @param input - the shape, the page state, the previous clock and now.
 * @returns the clock to carry forward and whether to show the notice.
 */
export function decideStallNotice(input: StallNoticeInput): StallDecision {
  if (!input.shape || !input.pageVisible) return { since: 0, show: false }
  const since = input.since === 0 ? input.now : input.since
  return { since, show: input.now - since >= STALL_THRESHOLD_MS }
}

/**
 * Is this node actually rendered — connected, not hidden by the HTML `hidden`
 * attribute, and not inside a `display: none` / `visibility: hidden`
 * ancestor? The walk is bounded by the ancestor chain and reads styles through
 * the injected reader, so the decision is testable without a DOM. Pure —
 * unit-tested.
 * @param node - the node to test (the session header).
 * @param styleOf - computed-style reader for one node.
 * @returns whether the node is displayed.
 */
export function isRendered(
  node: RenderedNodeFace,
  styleOf: (node: RenderedNodeFace) => { readonly display: string; readonly visibility: string },
): boolean {
  if (node.isConnected === false) return false
  for (let current: RenderedNodeFace | null = node; current !== null; current = current.parentElement) {
    if (current.getAttribute('hidden') !== null) return false
    const style = styleOf(current)
    if (style.display === 'none' || style.visibility === 'hidden') return false
  }
  return true
}

/** The production render check: the real computed style of every ancestor. */
export function isVisibleElement(element: Element): boolean {
  return isRendered(element as unknown as RenderedNodeFace, node => {
    const style = getComputedStyle(node as unknown as Element)
    return { display: style.display, visibility: style.visibility }
  })
}

/**
 * Read the stalled-shape facts out of a page. Order matters: the flow is the
 * only unconditional anchor, so a page without it is a no-op before anything
 * else is queried. Fails closed on every unexpected shape.
 * @param root - the query root (the real `document`).
 * @param options - the render check for the session header.
 * @returns the probe: the facts plus the nodes the installer needs.
 */
export function probeStall(
  root: StallQueryRootFace,
  options: { readonly isVisible: (node: StallNodeFace) => boolean },
): StallProbe {
  const flow = root.querySelector(CHAT_FLOW_QUERY)
  if (flow === null) {
    return {
      activeRoot: null, header: null,
      activeConversation: false, headerVisible: false, flowPresent: false, hasRows: false,
    }
  }
  const phaseNode = flow.closest(CONVERSATION_PHASE_QUERY)
  const activeRoot = isStallPhase(phaseNode?.getAttribute('data-phase')) ? phaseNode : null
  const candidate = root.querySelector(SESSION_HEADER_QUERY)
  const headerVisible = candidate !== null && options.isVisible(candidate)
  return {
    activeRoot,
    header: headerVisible ? candidate : null,
    activeConversation: activeRoot !== null,
    headerVisible,
    flowPresent: true,
    hasRows: flow.querySelector(CHAT_ROW_QUERY) !== null,
  }
}

/**
 * Where the notice goes: just under the session header it belongs to, clamped
 * to stay on screen. A missing or degenerate rect (hidden, detached,
 * unlaid-out header — `bottom` 0 or NaN) yields null, which means "keep the
 * stylesheet's fallback anchor". Pure — unit-tested.
 * @param rect - the header's viewport rect, or null when there is none.
 * @param viewportHeight - `window.innerHeight` at measure time.
 * @returns the notice's `top` in px, or null for the CSS fallback.
 */
export function noticeTopFor(
  rect: { readonly bottom: number } | null,
  viewportHeight: number,
): number | null {
  if (rect === null || !Number.isFinite(rect.bottom) || rect.bottom <= 0) return null
  const top = rect.bottom + STALL_NOTICE_GAP_PX
  if (!Number.isFinite(viewportHeight)) return top
  return Math.max(0, Math.min(top, viewportHeight - STALL_NOTICE_MIN_VISIBLE_PX))
}

/** The guarded window property's shape. */
interface GuardedWindow {
  [STALL_GUARD]?: () => void
}

/**
 * Install the session-load stall notice. The installer is an observer only:
 * it reads the official DOM, polls at STALL_POLL_MS, recomputes immediately on
 * visibilitychange, and mounts a single notice whose only action calls
 * `location.reload()`. It never reloads, re-opens or writes to the official
 * tree on its own. Idempotent: a second install while one is live returns a
 * no-op disposer (the first one keeps watching). The returned disposer clears
 * the timer and the listener, removes the notice and the style tag it created,
 * and is itself idempotent.
 * @param t - the bound locale lookup for the notice copy.
 * @returns the disposer.
 */
export function installSessionStallNotice(t: (key: MobileKey) => string): () => void {
  // DOM-free harness (the package's plain-node test files) and any non-browser
  // scope: nothing to watch, nothing installed.
  if (typeof document === 'undefined' || typeof window === 'undefined') return () => {}
  const guard = window as unknown as GuardedWindow
  if (guard[STALL_GUARD] !== undefined) return () => {}

  let since = 0
  let activeRoot: StallNodeFace | null = null
  let notice: HTMLElement | null = null
  let noticeMessage: HTMLElement | null = null
  let noticeAction: HTMLButtonElement | null = null

  // The stylesheet's notch: this module cannot extend styles.ts (owned by
  // another surface of the package), so its few rules ride their own tag. An
  // existing tag is reused, never adopted — it is not ours to remove.
  let ownedStyle: HTMLStyleElement | null = null
  if (document.querySelector(`style[data-plugin="${STALL_STYLE_TAG}"]`) === null) {
    ownedStyle = document.createElement('style')
    ownedStyle.setAttribute('data-plugin', STALL_STYLE_TAG)
    ownedStyle.textContent = STALL_NOTICE_CSS
    document.head.appendChild(ownedStyle)
  }

  /** The ONE action: reload the page. Never called by the watcher itself. */
  const reload = (): void => {
    try {
      window.location.reload()
    } catch {
      // Fail closed: the notice must never throw into the page.
    }
  }

  const unmount = (): void => {
    if (notice === null) return
    notice.remove()
    notice = null
    noticeMessage = null
    noticeAction = null
  }

  // Live regions re-announce on every text write, so identical copy is left
  // alone (the poll runs every STALL_POLL_MS).
  const setText = (element: HTMLElement, value: string): void => {
    if (element.textContent !== value) element.textContent = value
  }

  const mount = (header: StallNodeFace | null): void => {
    if (notice === null) {
      const body: HTMLElement | null = document.body
      if (body === null) return
      const root = document.createElement('div')
      root.className = STALL_NOTICE_CLASS
      // role=status: a polite live region, so the message is announced without
      // moving focus — the notice never steals focus from the composer.
      root.setAttribute('role', 'status')
      root.setAttribute('aria-live', 'polite')
      const message = document.createElement('span')
      message.className = STALL_NOTICE_MESSAGE_CLASS
      const action = document.createElement('button')
      action.type = 'button'
      action.className = STALL_NOTICE_ACTION_CLASS
      action.addEventListener('click', reload)
      root.append(message, action)
      body.appendChild(root)
      notice = root
      noticeMessage = message
      noticeAction = action
    }
    if (noticeMessage !== null) setText(noticeMessage, t('dsh-chamber.mobile.stall.message'))
    if (noticeAction !== null) setText(noticeAction, t('dsh-chamber.mobile.stall.action'))
    const top = noticeTopFor(header?.getBoundingClientRect?.() ?? null, window.innerHeight)
    if (top === null) notice.style.removeProperty('top')
    else notice.style.top = `${top}px`
  }

  const evaluate = (): void => {
    try {
      const probe = probeStall(document, {
        isVisible: node => isVisibleElement(node as unknown as Element),
      })
      // A different conversation root is a different session: the clock and any
      // shown notice belong to the session they were started for.
      if (probe.activeRoot !== activeRoot) {
        activeRoot = probe.activeRoot
        since = 0
        unmount()
      }
      const shape = isStallShape(probe)
      const decision = decideStallNotice({
        shape,
        pageVisible: document.visibilityState === 'visible',
        since,
        now: Date.now(),
      })
      since = decision.since
      // Once announced, the notice STANDS until the shape itself recovers: the
      // clock is discarded in the background, so recomputing the decision alone
      // would take the notice away for another full threshold on resume.
      if (decision.show || (shape && notice !== null)) mount(probe.header)
      else unmount()
    } catch {
      // Fail closed: a notice watcher must never break the page it watches.
    }
  }

  const onVisibilityChange = (): void => { evaluate() }
  document.addEventListener('visibilitychange', onVisibilityChange)
  const interval = window.setInterval(evaluate, STALL_POLL_MS)
  // Install-time seed: a page that boots into the stalled shape starts its
  // clock here instead of at the first poll (light: a handful of attribute
  // queries, no writes).
  evaluate()

  let disposed = false
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    window.clearInterval(interval)
    document.removeEventListener('visibilitychange', onVisibilityChange)
    unmount()
    ownedStyle?.remove()
    if (guard[STALL_GUARD] === dispose) delete guard[STALL_GUARD]
  }
  guard[STALL_GUARD] = dispose
  return dispose
}
