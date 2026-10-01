import { sessionOpenPromiseInFlight } from '@dsh-chamber/dsh-chamber-client-core'
import {
  LADDER_TABLES,
  mobileStallLadder,
  planLadder,
  type LadderRecord,
} from '@dsh-chamber/dsh-stream-state'
import type { MobileKey } from './locales.ts'
import { presentedConcreteSession, type SessionsConcreteLoose } from './session-presentation.ts'

//  This module does not OWN its six ladder thresholds: they are read from the
// shared table (@dsh-chamber/dsh-stream-state, LADDER_TABLES.mobile), their
// only owner. That tier deliberately uses a LONGER notice threshold than the
// desktop ladder (it has no openState channel), locked by the cross-tier parity
// test; the value lives in src/tables.ts.

/** The conversation root's phase attribute, emitted by upstream
 *  ConversationRoot (ui-conversation). Value space exactly: settling (a
 *  session is open but the shell is blank/loading, or a continuable subagent
 *  waits for its parent catalog), hero (no session presented) and active. The
 *  composer node's own data-phase carries a different value set and is never
 *  an ancestor of the chat flow, so the nearest-ancestor read can only land on
 *  the root. */
export const CONVERSATION_PHASE_QUERY = '[data-phase]'

/** The phases that present a REAL conversation — the ones where an empty
 *  message column is a fault rather than the correct empty face. hero (no
 *  session) is the only exclusion BY VALUE. The blank arms are excluded by
 *  SHAPE instead: upstream DefaultConversationViews returns null while the
 *  session is blank (ConversationRoot still mounts, its header slot included,
 *  so the header CAN be on screen), hence no [data-chat-flow] is rendered at
 *  all and probeStall fails closed at the flow gate — the header-visibility
 *  gate is NOT what excludes them. settling keeps its seat here for the arm
 *  whose root IS rendered with a flow (a continuable subagent awaiting its
 *  parent catalog); the blank-shape fixture in the test file pins that
 *  separation. */
export const STALL_PHASES: readonly string[] = ['settling', 'active']

/** Is this root phase one where an empty flow means "stalled"? */
export function isStallPhase(value: string | null | undefined): boolean {
  return value !== null && value !== undefined && STALL_PHASES.includes(value)
}

/** The ChatView message column — the one unconditional chat-surface anchor. */
export const CHAT_FLOW_QUERY = '[data-chat-flow]'

/** A rendered message row (the official `routedNode.key` projection). */
export const CHAT_ROW_QUERY = '[data-chat-anchor-key]'

/**
 * The session-header OUTLET — the only stable anchor. Upstream
 * ConversationSessionHeader returns a Fragment, so the element that OWNS the
 * outlet is the surrounding `<header>` (the outlet is its child, not its
 * parent), and the outlet itself is display:contents. The old
 * `[data-slot=...] > header` child combinator therefore never matched on the
 * real DOM and left the stall shape permanently false.
 */
export const SESSION_HEADER_QUERY = '[data-slot="conversation.session.header"]'

/**
 * Resolve the displayed session `<header>` from its outlet: query the audited
 * outlet anchor, then walk to the outlet's nearest `<header>` ancestor
 * (`closest` includes the node itself). null when the outlet or the header is
 * absent — the stall shape then stays false, never a guess.
 *
 * The DOM-free test harness drives this with a plain-node double, so the null
 * checks are exact and `closest('header')` is typed to return
 * `HTMLElement | null`: no `instanceof` on globals the harness does not have.
 */
export function sessionHeaderElement(root: ParentNode): HTMLElement | null {
  const outlet = root.querySelector(SESSION_HEADER_QUERY)
  if (outlet === null) return null
  return outlet.closest('header')
}

//  The notice's presentation surface and double-install guard live in
// session-stall-notice.ts; imported here and re-exported (public surface).
import {
  STALL_GUARD,
  STALL_NOTICE_ACTION_CLASS, STALL_NOTICE_CLASS, STALL_NOTICE_CSS,
  STALL_NOTICE_DISMISS_CLASS, STALL_NOTICE_GAP_PX, STALL_NOTICE_MESSAGE_CLASS,
  STALL_NOTICE_MIN_VISIBLE_PX, STALL_STYLE_TAG,
} from './session-stall-notice.ts'
export {
  STALL_GUARD,
  STALL_NOTICE_ACTION_CLASS, STALL_NOTICE_CLASS, STALL_NOTICE_CSS,
  STALL_NOTICE_DISMISS_CLASS, STALL_NOTICE_GAP_PX, STALL_NOTICE_MESSAGE_CLASS,
  STALL_NOTICE_MIN_VISIBLE_PX, STALL_STYLE_TAG,
} from './session-stall-notice.ts'

/** The minimal node face the probe reads (real Element satisfies it; tests
 *  drive it with a plain-node double). */
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
  readonly activeConversation: boolean
  readonly headerVisible: boolean
  readonly flowPresent: boolean
  readonly hasRows: boolean
}

/** The stall SHAPE, without the time and page-state conditions. */
export interface StallShapeFacts {
  readonly activeConversation: boolean
  readonly headerVisible: boolean
  readonly flowPresent: boolean
  readonly hasRows: boolean
}

/** The shared engine's mobile ladder, built once from the table values. */
const MOBILE_STALL_LADDER = mobileStallLadder({
  thresholdMs: LADDER_TABLES.mobile.thresholdMs,
  cooldownMs: LADDER_TABLES.mobile.resyncCooldownMs,
  windowMs: LADDER_TABLES.mobile.resyncWindowMs,
  max: LADDER_TABLES.mobile.resyncMax,
})

/** The shared engine's per-session ledger shape (one `stall` observation). */
export type StallLadderRecords = Readonly<Record<string, LadderRecord>>

/** The single source id this watcher feeds the shared ladder. */
const STALL_SOURCE_ID = 'stall'

/** The notice decision, plus the clock and ledger it leaves behind. */
export interface StallDecision {
  /** The first sighting of the current continuous stall, 0 when not timing. */
  readonly since: number
  readonly show: boolean
  /** Execute the per-session rebuild NOW (evidence + ledger allow it). */
  readonly resync: boolean
  /** The shared ladder has NO lever left for this session: automatic recovery
   *  is spent, only the manual reload remains (drives the copy). */
  readonly exhausted: boolean
  readonly records: StallLadderRecords
}

export interface StallNoticeInput {
  readonly shape: boolean
  readonly pageVisible: boolean
  readonly since: number
  readonly now: number
  /** The user dismissed the notice for the CURRENT continuous stall. It stays
   *  suppressed while the shape holds; the suppression ends with the shape, so
   *  a later stall (a new session, a re-open) still gets its notice. */
  readonly dismissed: boolean
  /** Concrete open liveness: TRUE = open pending, FALSE = parked with
   *  nothing pending, UNDEFINED = unknowable. Only explicit FALSE unlocks the
   *  automatic rebuild. */
  readonly openInFlight?: boolean | undefined
  /** Concrete openState === loading: TRUE unlocks the automatic rebuild;
   *  FALSE / UNDEFINED fail closed (the shape alone is not evidence). */
  readonly loading?: boolean | undefined
  /** The shared engine's ladder ledger for this session (empty = nothing spent). */
  readonly records?: StallLadderRecords
}

/**
 * Is this the stalled shape — an active conversation whose chat column never
 * rendered a row and whose header is on screen? Pure — unit-tested. The time
 * and page-state halves live in decideStallNotice.
 */
export function isStallShape(facts: StallShapeFacts): boolean {
  return facts.activeConversation && facts.headerVisible && facts.flowPresent && !facts.hasRows
}

/**
 * The stall clock and notice decision. The clock is seeded at the first
 * sighting (since === 0 means not timing), runs only while the shape holds AND
 * the page is visible, and zeroes when either half breaks — a stall must be
 * CONTINUOUS and observed. A dismissal suppresses the notice without stopping
 * the clock. Pure — unit-tested.
 */
export function decideStallNotice(input: StallNoticeInput): StallDecision {
  // A stall nobody is observing ends its EPISODE (the clock resets — a stall
  // must be continuous and observed), but the shared ladder's rolling window
  // survives: a flickering shape must not hand out a fresh resync quota on
  // every break. The caller carries the returned ledger forward.
  if (!input.shape || !input.pageVisible) {
    return { since: 0, show: false, resync: false, exhausted: false, records: input.records ?? {} }
  }
  const since = input.since === 0 ? input.now : input.since
  // The evidence gate: both halves required, exactly as the observation below
  // reports them. plan.exhausted ALSO fires when this gate cannot be satisfied
  // (no lever is reachable at all), which is not a spent budget — the copy may
  // only claim exhaustion when the budget is the binding constraint.
  const stuckEvidence = input.loading === true && input.openInFlight === false
  const plan = planLadder(
    MOBILE_STALL_LADDER,
    input.records ?? {},
    {
      stall: {
        sticky: true,
        symptomSinceMs: since,
        stuckEvidence,
        progressStamp: 0,
        escalationBlocked: false,
      },
    },
    input.now,
  )
  // The ladder's tier IS the threshold — never compare a second copy of it.
  const thresholdMs = MOBILE_STALL_LADDER.tiers[0]?.afterMs ?? LADDER_TABLES.mobile.thresholdMs
  const stalled = input.now - since >= thresholdMs
  return {
    since,
    show: !input.dismissed && stalled,
    resync: plan.actions.some((action) => action.tier === 'resync'),
    // Exhausted = the plan has no lever left AND the evidence gate is
    // satisfiable: with `stuckEvidence` true the only remaining blocker is a
    // spent quota, so this is exactly "the automatic arm ran out of budget".
    exhausted: plan.exhausted.includes(STALL_SOURCE_ID) && stuckEvidence,
    records: plan.records,
  }
}

/** The facts the notice copy is selected from. */
export interface StallMessageFacts {
  /** How long the current continuous stall has held (ms). */
  readonly elapsedMs: number
  /** The shared ladder spent its last lever for this session
   *  (StallDecision.exhausted): automatic recovery can no longer fire. */
  readonly exhausted: boolean
}

/**
 * The copy KEY TABLE: the FIRST matching row wins and the last row matches
 * unconditionally, so the key space is total by construction. An exhausted
 * ladder outranks the elapsed wording: past the failure bound the user would
 * otherwise be told "content not loaded" with no hint that the automatic
 * recovery budget is spent. Pure — unit-tested.
 */
const STALL_MESSAGE_TABLE: readonly {
  readonly key: MobileKey
  readonly when: (facts: StallMessageFacts) => boolean
}[] = [
  { key: 'dsh-chamber.mobile.stall.messageExhausted', when: facts => facts.exhausted },
  { key: 'dsh-chamber.mobile.stall.messageFailed', when: facts => facts.elapsedMs >= LADDER_TABLES.mobile.failedMs },
  { key: 'dsh-chamber.mobile.stall.message', when: () => true },
]

/** Select the notice copy key from the table above. Pure — unit-tested. */
export function stallMessageKey(facts: StallMessageFacts): MobileKey {
  for (const row of STALL_MESSAGE_TABLE) {
    if (row.when(facts)) return row.key
  }
  return 'dsh-chamber.mobile.stall.message'
}

/**
 * Is this node actually rendered — connected, not hidden by the hidden
 * attribute, and not inside a display: none / visibility: hidden ancestor?
 * The walk is bounded by the ancestor chain and reads styles through the
 * injected reader, so it is testable without a DOM. Pure — unit-tested.
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
 * only unconditional anchor, so a page without it is a no-op. Fails closed.
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
  // The probe's root is the minimal query-root face; the resolver only needs
  // querySelector + closest, which both the real ParentNode and the double have.
  const header = sessionHeaderElement(root as unknown as ParentNode)
  const headerVisible = header !== null && options.isVisible(header)
  return {
    activeRoot,
    header: headerVisible ? header : null,
    activeConversation: activeRoot !== null,
    headerVisible,
    flowPresent: true,
    hasRows: flow.querySelector(CHAT_ROW_QUERY) !== null,
  }
}

/**
 * Where the notice goes: just under its session header, clamped on screen. A
 * missing or degenerate rect (hidden/detached/unlaid-out header, bottom 0 or
 * NaN) yields null = keep the stylesheet's fallback anchor. Pure — unit-tested.
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

/** The guarded window property: the live installation plus its reference
 *  count (two contexts share ONE watcher; the last disposer tears it down). */
interface GuardedWindow {
  [STALL_GUARD]?: { count: number; release: () => void }
}

/** Wrap a shared release so ONE caller's disposer can only run once. */
function singleShot(release: () => void): () => void {
  let done = false
  return () => {
    if (done) return
    done = true
    release()
  }
}

/** The concrete session face the automatic arm reads (fully guarded). */
export interface StallSessionFace {
  /** TRUE = an open is pending, FALSE = parked with nothing pending, UNDEFINED = unknowable. */
  openInFlight(): boolean | undefined
  /**
   * TRUE = the concrete session reports openState === loading. REQUIRED by the
   * automatic arm: a healthy open session with a slow first turn shares the
   * stall SHAPE, so openPromise === null alone would rebuild a session that
   * needs no repair.
   */
  loading(): boolean | undefined
  /** Rebuild the presented session's event stream (the pinned concrete `resync()`). */
  resync(): void
}

//  Presentation and concrete-Session access are single-sourced in
//  session-presentation.ts (presentedSessionId + presentedConcreteSession) so the
//  stall arm reads the official face through exactly one accessor pair.

/** One warning per module lifetime: a permanently broken resync must not
 *  flood the console at the poll cadence, but it must never fail silently. */
let warnedOnce = false

/**
 * Build the automatic arm's face from the plugin context, or undefined when
 * the concrete capability is absent (degrade to notice-only, never to a
 * guess). The READ of an absent cordis service throws through the ctx proxy,
 * so the non-throwing reflect.get(name, false) form is used.
 */
export function sessionStallFace(
  ctx: { readonly reflect?: { get?(name: string, strict?: boolean): unknown } } | undefined,
): StallSessionFace | undefined {
  const reflect = ctx?.reflect
  if (reflect?.get === undefined) return undefined
  // Bound once: the property is optional, so call sites would each need narrowing.
  const get = reflect.get.bind(reflect)
  /** Re-read the service on EVERY call: the mobile plugin does not inject
   *  sessions, so apply order is not guaranteed — resolving once at install
   *  time would silently disable the arm. rc.2 `binding` is the ONE accessor
   *  (presentedConcreteSession reads it). */
  const readSessions = (): SessionsConcreteLoose | undefined => {
    try {
      const found = get('sessions', false)
      if (found === null || typeof found !== 'object') return undefined
      const candidate = found as SessionsConcreteLoose
      if (typeof candidate.list?.getSnapshot !== 'function') return undefined
      if (typeof candidate.binding !== 'function') return undefined
      return candidate
    } catch {
      return undefined
    }
  }
  return {
    openInFlight: (): boolean | undefined => {
      const session = presentedConcreteSession(readSessions())
      if (session === undefined) return undefined
      // Tri-state evidence is single-sourced in client-core (the open-in probe
      // reads the same function); fail-closed semantics live there.
      return sessionOpenPromiseInFlight(session)
    },
    loading: (): boolean | undefined => {
      const session = presentedConcreteSession(readSessions())
      if (session === undefined) return undefined
      try {
        if (!Object.hasOwn(session, 'openState')) return undefined
        const state = session.openState
        return state === 'loading'
      } catch {
        return undefined
      }
    },
    resync: (): void => {
      const session = presentedConcreteSession(readSessions())
      if (session === undefined) return
      try {
        const method = session.resync
        if (typeof method !== 'function') return
        // The pinned resync returns a Promise: a rejection must never surface
        // as an unhandled rejection (Promise.resolve also absorbs a hostile
        // thenable), and it must not vanish either — warn once.
        void Promise.resolve((method as () => unknown).call(session)).catch((error: unknown) => {
          if (warnedOnce) return
          warnedOnce = true
          console.warn('[dsh-chamber.mobile] session resync failed', error)
        })
      } catch {
        // Fail closed: a hostile face must never throw into the poll loop.
      }
    },
  }
}

/**
 * Install the session-load stall notice: reads the official DOM, polls at
 * STALL_POLL_MS, recomputes on visibilitychange, and mounts one notice whose
 * primary action reloads the page and whose secondary dismisses it. The ONLY
 * write it performs by itself is the pinned Session.resync(), on the pure
 * decision's evidence.
 *
 * Sharing: reference-counted on the window — a second install joins the live
 * watcher (first installer's locale binding and session face) rather than
 * silently replacing its evidence source.
 */
export function installSessionStallNotice(t: (key: MobileKey) => string, session?: StallSessionFace): () => void {
  // Non-browser scope (DOM-free test harness): nothing to watch.
  if (typeof document === 'undefined' || typeof window === 'undefined') return () => {}
  const guard = window as unknown as GuardedWindow
  const live = guard[STALL_GUARD]
  if (live !== undefined) {
    live.count += 1
    return singleShot(live.release)
  }

  let since = 0
  let dismissed = false
  /** Shared-engine ladder ledger for the CURRENT session (reset on a session switch). */
  let records: StallLadderRecords = {}
  // The session identity: the displayed header, and ONLY it (the phase node
  // survives a session switch; no header means the shape is false anyway).
  let sessionAnchor: StallNodeFace | null = null
  let notice: HTMLElement | null = null
  let noticeMessage: HTMLElement | null = null
  let noticeAction: HTMLButtonElement | null = null
  let noticeDismiss: HTMLButtonElement | null = null

  // styles.ts is owned elsewhere, so the notice's few rules ride their own
  // tag; an existing tag is reused, never adopted (not ours to remove).
  let ownedStyle: HTMLStyleElement | null = null
  if (document.querySelector(`style[data-plugin="${STALL_STYLE_TAG}"]`) === null) {
    ownedStyle = document.createElement('style')
    ownedStyle.setAttribute('data-plugin', STALL_STYLE_TAG)
    ownedStyle.textContent = STALL_NOTICE_CSS
    document.head.appendChild(ownedStyle)
  }

  /** The ONE recovery action: reload the page. Never called by the watcher. */
  const reload = (): void => {
    try {
      window.location.reload()
    } catch {
      // Fail closed: the notice must never throw into the page.
    }
  }

  /** The user's answer to a false positive: hide the notice and keep waiting.
   *  Suppresses this continuous stall only; a broken shape clears it. */
  const dismiss = (): void => {
    dismissed = true
    unmount()
  }

  const unmount = (): void => {
    if (notice === null) return
    notice.remove()
    notice = null
    noticeMessage = null
    noticeAction = null
    noticeDismiss = null
  }

  // Live regions re-announce on every text write: leave identical copy alone
  // (the poll runs every LADDER_TABLES.mobile.pollMs).
  const setText = (element: HTMLElement, value: string): void => {
    if (element.textContent !== value) element.textContent = value
  }

  const mount = (header: StallNodeFace | null, messageKey: MobileKey): void => {
    if (notice === null) {
      const body: HTMLElement | null = document.body
      if (body === null) return
      const root = document.createElement('div')
      root.className = STALL_NOTICE_CLASS
      // role=status: a polite live region announces without moving focus, so
      // the notice never steals focus from the composer.
      root.setAttribute('role', 'status')
      root.setAttribute('aria-live', 'polite')
      const message = document.createElement('span')
      message.className = STALL_NOTICE_MESSAGE_CLASS
      const action = document.createElement('button')
      action.type = 'button'
      action.className = STALL_NOTICE_ACTION_CLASS
      action.addEventListener('click', reload)
      // The dismiss control makes a false positive harmless: reloading aborts
      // the load, and a slow-but-healthy open looks exactly like this shape.
      const dismissButton = document.createElement('button')
      dismissButton.type = 'button'
      dismissButton.className = STALL_NOTICE_DISMISS_CLASS
      dismissButton.addEventListener('click', dismiss)
      root.append(message, dismissButton, action)
      body.appendChild(root)
      notice = root
      noticeMessage = message
      noticeAction = action
      noticeDismiss = dismissButton
    }
    if (noticeMessage !== null) setText(noticeMessage, t(messageKey))
    if (noticeAction !== null) setText(noticeAction, t('dsh-chamber.mobile.stall.action'))
    if (noticeDismiss !== null) setText(noticeDismiss, t('dsh-chamber.mobile.stall.dismiss'))
    const top = noticeTopFor(header?.getBoundingClientRect?.() ?? null, window.innerHeight)
    if (top === null) notice.style.removeProperty('top')
    else notice.style.top = `${top}px`
  }

  const evaluate = (): void => {
    try {
      const probe = probeStall(document, {
        isVisible: node => isVisibleElement(node as unknown as Element),
      })
      // A different header node is a different stall: clock, dismissal and
      // notice belong to the session they were started for.
      const anchor = probe.header
      if (anchor !== sessionAnchor) {
        sessionAnchor = anchor
        since = 0
        dismissed = false
        records = {}
        unmount()
      }
      const shape = isStallShape(probe)
      const pageVisible = document.visibilityState === 'visible'
      const now = Date.now()
      const decision = decideStallNotice({
        shape,
        pageVisible,
        since,
        now,
        dismissed,
        openInFlight: readOpenInFlight(),
        loading: readLoading(),
        records,
      })
      since = decision.since
      // The engine records a dispatch when it AUTHORIZES one, so carry the
      // ledger before the effect — accounted even if the face did nothing.
      records = decision.records
      if (decision.resync) {
        // The ONLY automatic write here: the pinned per-session rebuild, on
        // the plan's evidence only (no open in flight).
        try {
          session?.resync()
        } catch {
          // Fail closed: the watcher must never throw into the poll loop.
        }
      }
      // A broken shape (or a hidden page: background time is not stall time)
      // ends the episode a dismissal belonged to, so it never silences the
      // NEXT stall.
      if (!shape || !pageVisible) dismissed = false
      // Once announced the notice STANDS until the shape recovers: background
      // time discards the clock, so recomputing alone would hide it on resume.
      // A mounted notice implies dismissed is false (its only setter unmounts).
      if (decision.show || (shape && notice !== null)) {
        mount(probe.header, stallMessageKey({
          elapsedMs: decision.since === 0 ? 0 : now - decision.since,
          exhausted: decision.exhausted,
        }))
      } else unmount()
    } catch {
      // Fail closed: a notice watcher must never break the page it watches.
    }
  }

  /** Guarded read of the concrete open-liveness bit (a hostile face is "unknown"). */
  const readOpenInFlight = (): boolean | undefined => {
    try {
      return session?.openInFlight()
    } catch {
      return undefined
    }
  }

  /** Guarded read of the concrete open state (absent face ⇒ unknown, never "not loading"). */
  const readLoading = (): boolean | undefined => {
    try {
      return session?.loading()
    } catch {
      return undefined
    }
  }

  const onVisibilityChange = (): void => { evaluate() }
  document.addEventListener('visibilitychange', onVisibilityChange)
  const interval = window.setInterval(evaluate, LADDER_TABLES.mobile.pollMs)
  // Install-time seed: a page booting into the stalled shape starts its clock
  // here instead of at the first poll (attribute queries only, no writes).
  evaluate()

  let disposed = false
  const teardown = (): void => {
    if (disposed) return
    disposed = true
    window.clearInterval(interval)
    document.removeEventListener('visibilitychange', onVisibilityChange)
    unmount()
    ownedStyle?.remove()
  }
  /** Give up ONE reference; the last one stops the watcher. */
  const release = (): void => {
    const live = guard[STALL_GUARD]
    if (live === undefined) return
    live.count -= 1
    if (live.count > 0) return
    delete guard[STALL_GUARD]
    teardown()
  }
  guard[STALL_GUARD] = { count: 1, release }
  return singleShot(release)
}
