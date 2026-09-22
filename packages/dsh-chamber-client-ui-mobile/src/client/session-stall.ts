import { LADDER_TABLES } from '@dsh-chamber/dsh-stream-state'
import type { MobileKey } from './locales.ts'

//  this module does not OWN its six ladder thresholds - they are read from the
// shared table (@dsh-chamber/dsh-stream-state, LADDER_TABLES.mobile) at each use site
// below, which is their only owner.
// NOTE ON THE TIER DEVIATION on LADDER_TABLES.mobile.thresholdMs: this
// tier has no openState channel (it observes a DOM-only shape a healthy slow load can
// also produce), so its notice threshold is deliberately LONGER than the desktop
// ladder's 20s. That deviation is intentional and locked by the cross-tier
// parity test; it lives with the value in src/tables.ts, not here.

/** The conversation root's phase attribute. The emitter is upstream
 *  `ConversationRoot`'s `phase` attribute (ui-conversation): the value space is
 *  exactly `settling` (a session is open but the shell is blank and loading, or
 *  a continuable subagent is waiting for its parent catalog), `hero` (no
 *  session presented) and `active` (everything else). The `conversationPhase()`
 *  contract's `blank` / `engaging` names are internal and NEVER reach this
 *  attribute. The composer node's own `data-phase` carries a
 *  different value set (`input.phase` / `inert`) and is never an ancestor of
 *  the chat flow, so the nearest-ancestor read below can only land on the
 *  root. */
export const CONVERSATION_PHASE_QUERY = '[data-phase]'

/** The phases that present a REAL conversation — the ones where an empty
 *  message column is a fault rather than the correct empty face. `hero` (no
 *  session) is the only exclusion. `settling` is included on the strength of
 *  the value space alone (it is a real-session phase, not the empty face);
 *  WHICH of its arms can actually reach this predicate is decided by the
 *  header-visibility gate below, not here — in the blank-shell arm upstream
 *  hides the header, so the shape cannot hold there (
 *  an earlier comment claimed this inclusion covered "a session opening its
 *  history", which that gating makes unreachable). */
export const STALL_PHASES: readonly string[] = ['settling', 'active']

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

//  the notice's presentation surface (style tag, class names, geometry, CSS) and the
// double-install guard now live in session-stall-notice.ts. Imported for this module's own
// use, re-exported so the public surface the tests and the plugin entry consume is
// unchanged.
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

/** The notice decision, plus the clock and ledger it leaves behind. */
export interface StallDecision {
  /** The first sighting of the current continuous stall, 0 when not timing. */
  readonly since: number
  /** Whether the notice belongs on screen now. */
  readonly show: boolean
  /** Execute the per-session rebuild NOW (evidence + ledger allow it). */
  readonly resync: boolean
  /** The ledger carried forward (pruned to the rolling window). */
  readonly resyncStamps: readonly number[]
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
  /** Concrete open liveness for the presented session: TRUE = an open is
   *  pending, FALSE = the state is parked with nothing pending, UNDEFINED = this
   *  build cannot say. Only the explicit FALSE unlocks the automatic rebuild. */
  readonly openInFlight?: boolean | undefined
  /** Concrete `openState === 'loading'`: TRUE unlocks the automatic rebuild, and
   *  FALSE / UNDEFINED both fail closed (the stall shape alone is not evidence). */
  readonly loading?: boolean | undefined
  /** Timestamps of the automatic rebuilds already executed for this session. */
  readonly resyncStamps?: readonly number[]
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
 * either half breaks — the stall must be CONTINUOUS and observed. A dismissal
 * suppresses the notice without stopping the clock, so the caller can keep the
 * user's choice for as long as that same continuous stall lasts. Pure —
 * unit-tested.
 * @param input - the shape, the page state, the previous clock, now, dismissal.
 * @returns the clock to carry forward and whether to show the notice.
 */
export function decideStallNotice(input: StallNoticeInput): StallDecision {
  const resyncStamps = pruneStallResync(input.resyncStamps ?? [], input.now)
  if (!input.shape || !input.pageVisible) return { since: 0, show: false, resync: false, resyncStamps }
  const since = input.since === 0 ? input.now : input.since
  const stalled = input.now - since >= LADDER_TABLES.mobile.thresholdMs
  return {
    since,
    show: !input.dismissed && stalled,
    // BOTH evidences are required: the concrete state must be
    // `loading` (not a healthy open session whose first turn is merely slow), and
    // nothing may be in flight. Either one unknown ⇒ no automatic write.
    resync: stalled
      && input.loading === true
      && input.openInFlight === false
      && stallResyncAvailable(resyncStamps, input.now),
    resyncStamps,
  }
}

/**
 * Timestamps still inside the rolling budget window. FUTURE stamps are dropped
 * too: a wall clock that stepped backwards (NTP correction, VM restore) would
 * otherwise keep them "inside the window" for up to that whole step and the
 * budget would count them forever. Dropping them resets the
 * ledger to "nothing spent" instead, which is the desktop ladder's ruling for a
 * negative elapsed time.
 */
function pruneStallResync(stamps: readonly number[], now: number): readonly number[] {
  return stamps.filter(stamp => Number.isFinite(stamp) && stamp <= now && now - stamp < LADDER_TABLES.mobile.resyncWindowMs)
}

/**
 * Whether the automatic rebuild may run: at most {@link LADDER_TABLES.mobile.resyncMax} per
 * {@link LADDER_TABLES.mobile.resyncWindowMs}, spaced by {@link LADDER_TABLES.mobile.resyncCooldownMs}.
 * Pure — unit-tested.
 * @param stamps - the session's previous automatic rebuild times.
 * @param now - current wall clock.
 * @returns whether one more automatic rebuild is allowed.
 */
export function stallResyncAvailable(stamps: readonly number[], now: number): boolean {
  const recent = pruneStallResync(stamps, now)
  if (recent.length >= LADDER_TABLES.mobile.resyncMax) return false
  const last = recent.at(-1)
  return last === undefined || now - last >= LADDER_TABLES.mobile.resyncCooldownMs
}

/**
 * The ledger after one executed automatic rebuild. Pure — unit-tested.
 * @param stamps - the session's previous automatic rebuild times.
 * @param now - the execution time.
 * @returns the pruned ledger plus this attempt.
 */
export function markStallResync(stamps: readonly number[], now: number): readonly number[] {
  return [...pruneStallResync(stamps, now), now]
}

/**
 * The notice copy for a stall that has held this long: the failure wording past
 * {@link LADDER_TABLES.mobile.failedMs}, so an endless spinner is never described as an
 * ongoing load. Pure — unit-tested.
 * @param elapsedMs - the continuous stall duration.
 * @returns the locale key for the notice message.
 */
export function stallMessageKey(elapsedMs: number): MobileKey {
  return elapsedMs >= LADDER_TABLES.mobile.failedMs
    ? 'dsh-chamber.mobile.stall.messageFailed'
    : 'dsh-chamber.mobile.stall.message'
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

/** The guarded window property's shape: the live installation, with its
 *  reference count (two contexts on one page share ONE watcher; the last
 *  disposer tears it down). */
interface GuardedWindow {
  [STALL_GUARD]?: { count: number; release: () => void }
}

/** Wrap a shared release so ONE caller's disposer can only ever run once (a
 *  double dispose must not decrement another holder's reference). */
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
   * TRUE = the concrete session reports `openState === 'loading'`. FALSE for any
   * other state, UNDEFINED when the member cannot be read. REQUIRED by the
   * automatic arm: a healthy `open` session with a slow first turn shares the
   * stall SHAPE (empty transcript, no `data-chat-anchor-key` rows), so
   * `openPromise === null` alone would rebuild a session that needs no repair.
   */
  loading(): boolean | undefined
  /** Rebuild the presented session's event stream (the pinned concrete `resync()`). */
  resync(): void
}

/** Loose structural slice of the instance's session face (never trusted). */
interface SessionsStallLoose {
  readonly list?: { getSnapshot?(): { readonly current?: string | undefined } }
  resolve?(id: string): { readonly session?: unknown } | undefined
}

/** The CURRENT concrete Session object, or undefined (guarded, fail-closed). */
function currentStallSession(sessions: SessionsStallLoose | undefined): Record<string, unknown> | undefined {
  try {
    const current = sessions?.list?.getSnapshot?.().current
    if (current === undefined || typeof sessions?.resolve !== 'function') return undefined
    const session = sessions.resolve(current)?.session
    if (session === null || session === undefined || typeof session !== 'object') return undefined
    return session as Record<string, unknown>
  } catch {
    return undefined
  }
}

/**
 * Build the automatic arm's face from the plugin context, or undefined when the
 * concrete capability is absent (the touch tier may run without a session
 * controller, and a drifted build must degrade to the notice-only behaviour
 * rather than to a guess). The READ of an absent cordis service throws through
 * the ctx proxy, so the non-throwing `reflect.get(name, false)` form is used —
 * the same guarded shape the desktop tier's probe uses.
 * @param ctx - the plugin context (anything exposing `reflect.get`).
 * @returns the face, or undefined when it cannot be trusted.
 */
export function sessionStallFace(
  ctx: { readonly reflect?: { get?(name: string, strict?: boolean): unknown } } | undefined,
): StallSessionFace | undefined {
  const reflect = ctx?.reflect
  if (reflect?.get === undefined) return undefined
  // Bound once: the property is optional on the ctx face, so every call site would
  // otherwise need its own narrowing (typecheck:mobile is a gate).
  const get = reflect.get.bind(reflect)
  /**
   * Re-resolve the service on EVERY call: the
   * mobile plugin deliberately does not inject `sessions`, so its apply order is
   * not guaranteed to be after the session controller registers — resolving once at
   * install time would silently disable the arm for that whole install lifetime.
   */
  const resolve = (): SessionsStallLoose | undefined => {
    try {
      const found = get('sessions', false)
      if (found === null || typeof found !== 'object') return undefined
      const candidate = found as SessionsStallLoose
      if (typeof candidate.list?.getSnapshot !== 'function' || typeof candidate.resolve !== 'function') return undefined
      return candidate
    } catch {
      return undefined
    }
  }
  return {
    openInFlight: (): boolean | undefined => {
      const session = currentStallSession(resolve())
      if (session === undefined) return undefined
      try {
        // The member MUST exist for FALSE to be reported: a build that renamed or
        // removed `openPromise` degrades to "unknown", never to "nothing pending".
        if (!Object.hasOwn(session, 'openPromise')) return undefined
        const pending = session.openPromise
        // Only an exactly-null own member is positive evidence (desktop parity);
        // anything else non-thenable (e.g. undefined) is UNKNOWN and fails closed.
        if (pending === null) return false
        if (typeof pending === 'object' || typeof pending === 'function') return true
        return undefined
      } catch {
        return undefined
      }
    },
    loading: (): boolean | undefined => {
      const session = currentStallSession(resolve())
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
      const session = currentStallSession(resolve())
      if (session === undefined) return
      try {
        const method = session.resync
        if (typeof method !== 'function') return
        void (method as () => unknown).call(session)
      } catch {
        // Fail closed: a hostile face must never throw into the poll loop.
      }
    },
  }
}

/**
 * Install the session-load stall notice. The installer reads the official DOM,
 * polls at STALL_POLL_MS, recomputes immediately on visibilitychange, and mounts
 * a single notice whose primary action calls `location.reload()` and whose
 * secondary action dismisses the notice for the current stall. The ONLY write it
 * ever performs by itself is the pinned `Session.resync()`, and only on the
 * evidence the pure decision pins (see {@link decideStallNotice}).
 * Sharing: the installation is reference-counted on the window, so a second
 * install (a second context on the same page) joins the live watcher instead of
 * silently receiving a dead disposer — disposing the first would otherwise stop
 * watching for the second. The watcher's copy is the first installer's locale
 * binding (the same dictionary on one page) and the first installer's session
 * face: a second install on the same page therefore joins the live arm instead of
 * silently replacing its evidence source, and every install is still disposed by
 * its own disposer.
 * @param t - the bound locale lookup for the notice copy.
 * @param session - the guarded concrete face for the automatic arm; absent means
 *   notice-only.
 * @returns the disposer (idempotent; the watcher stops when the last one runs).
 */
export function installSessionStallNotice(t: (key: MobileKey) => string, session?: StallSessionFace): () => void {
  // DOM-free harness (the package's plain-node test files) and any non-browser
  // scope: nothing to watch, nothing installed.
  if (typeof document === 'undefined' || typeof window === 'undefined') return () => {}
  const guard = window as unknown as GuardedWindow
  const live = guard[STALL_GUARD]
  if (live !== undefined) {
    live.count += 1
    return singleShot(live.release)
  }

  let since = 0
  let dismissed = false
  /** Automatic-rebuild ledger for the CURRENT session (reset on a session switch). */
  let resyncStamps: readonly number[] = []
  // The session identity: the displayed header, and ONLY it (the phase node is
  // keyed by entry and survives a session switch — see the module header; when no
  // header is displayed the shape is false anyway, so nothing is being timed).
  let sessionAnchor: StallNodeFace | null = null
  let notice: HTMLElement | null = null
  let noticeMessage: HTMLElement | null = null
  let noticeAction: HTMLButtonElement | null = null
  let noticeDismiss: HTMLButtonElement | null = null

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

  /** The ONE recovery action: reload the page. Never called by the watcher. */
  const reload = (): void => {
    try {
      window.location.reload()
    } catch {
      // Fail closed: the notice must never throw into the page.
    }
  }

  /** The user's answer to a false positive: hide the notice and keep waiting.
   *  It suppresses the notice for this continuous stall only — a broken shape
   *  (progress, a session switch, a reload) clears the suppression. */
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

  // Live regions re-announce on every text write, so identical copy is left
  // alone (the poll runs every LADDER_TABLES.mobile.pollMs).
  const setText = (element: HTMLElement, value: string): void => {
    if (element.textContent !== value) element.textContent = value
  }

  const mount = (header: StallNodeFace | null, messageKey: MobileKey): void => {
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
      // The dismiss control is what makes a false positive harmless: reloading
      // aborts the in-flight load, and a slow-but-healthy open looks exactly
      // like this shape (the threshold is not device-calibrated).
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
      // A different session (its header node) is a different stall: the clock,
      // the dismissal and any shown notice belong to the session they were
      // started for. No fallback is needed: no displayed header means the shape
      // is false, which already resets everything below.
      const anchor = probe.header
      if (anchor !== sessionAnchor) {
        sessionAnchor = anchor
        since = 0
        dismissed = false
        resyncStamps = []
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
        resyncStamps,
      })
      since = decision.since
      if (decision.resync) {
        // The ONLY automatic write in this module: the pinned per-session rebuild,
        // executed strictly on the plan's evidence (no open in flight) and
        // accounted whether or not the guarded face performed anything.
        try {
          session?.resync()
        } catch {
          // Fail closed: the watcher must never throw into the poll loop.
        }
        resyncStamps = markStallResync(decision.resyncStamps, now)
      } else {
        resyncStamps = decision.resyncStamps
      }
      // A broken shape ends the stall episode — and so does a hidden page, which
      // zeroes the clock for the same reason (background time is not stall time).
      // Either way the episode a dismissal belonged to is over, so it must not
      // silence the NEXT one (a backgrounded app resumed onto a still-stalled
      // session gets its notice back).
      if (!shape || !pageVisible) dismissed = false
      // Once announced, the notice STANDS until the shape itself recovers: the
      // clock is discarded in the background, so recomputing the decision alone
      // would take the notice away for another full threshold on resume.
      // (`dismissed` needs no re-check here: the only setter also unmounts, so a
      // mounted notice implies it is false.)
      if (decision.show || (shape && notice !== null)) {
        mount(probe.header, stallMessageKey(decision.since === 0 ? 0 : now - decision.since))
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
  // Install-time seed: a page that boots into the stalled shape starts its
  // clock here instead of at the first poll (light: a handful of attribute
  // queries, no writes).
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
