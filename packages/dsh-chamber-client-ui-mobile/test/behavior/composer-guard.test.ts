/**
 * Composer visibility guard — BEHAVIORAL tests for the DOM-bound installer
 * (the 2026-12 review's F1/F3/F4/F5/F6/F8): the previous suite pinned only the
 * pure decisions and a source regex, so mutations of the poll, the seat query,
 * the verify loop and the teardown all stayed green.
 *
 * Every case runs against test/support/guard-harness.ts: a plain-node DOM
 * double, a window with NO visualViewport (an engine that delivers no viewport
 * event), a fake clock driving the guard's 250ms interval, and an engine model
 * that decides how fully the layout honors the sticky inset.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  KBD_MAX_VERIFY_STEPS, KBD_POLL_BUDGET_MS, KBD_POLL_MS,
  MOBILE_KBD_ATTR, MOBILE_KBD_STATE_ATTR, MOBILE_KBD_SPACER_ATTR, MOBILE_KBD_VAR,
  PHONE_TIER_QUERY,
} from '../../src/client/composer.ts'
import { MOBILE_CSS, VIEWPORT_TOKENS } from '../../src/client/styles.ts'
import {
  createGuardHarness, type FakeElement, type GuardHarness, type GuardHarnessOptions,
} from '../support/guard-harness.ts'

function withGuard(options: GuardHarnessOptions, run: (h: GuardHarness, dispose: () => void) => void): void {
  const h = createGuardHarness(options)
  const dispose = h.install()
  try {
    run(h, dispose)
  } finally {
    dispose()
    h.restore()
  }
}

const spacerOf = (h: GuardHarness): FakeElement => {
  const spacer = h.root.querySelector(`[${MOBILE_KBD_SPACER_ATTR}]`)
  assert.ok(spacer !== null, 'the guard must have inserted its in-flow spacer')
  return spacer
}

test('MOBILE_KBD_VAR equals the custom property the sticky-bottom arm consumes (rename lock)', () => {
  // F7: renaming the JS constant used to pass the whole suite — the arm in
  // styles.ts kept consuming the literal. Parse the property name OUT of the
  // shipped CSS so the two sides can only move together.
  const arm = MOBILE_CSS.match(/\[data-mobile-frame\]\[data-mobile-kbd\][^\{]*\{([^\}]*)\}/)
  assert.ok(arm !== null, 'the single sticky-bottom arm must exist in MOBILE_CSS')
  const consumed = (arm[1] as string).match(/var\(\s*(--[a-zA-Z0-9-]+)/)
  assert.ok(consumed !== null, 'the arm must consume a custom property')
  assert.equal(MOBILE_KBD_VAR, consumed[1])
})

test('poll alone converges: geometry moves with no viewport event (F5)', () => {
  withGuard({ covered: 0 }, h => {
    assert.equal(h.frame.getAttribute(MOBILE_KBD_STATE_ATTR), 'idle')
    // The keyboard opens and only the LAYOUT changes: no visualViewport,
    // resize, focus, pointer or phase event is dispatched.
    h.openKeyboardWithoutEvents(336)
    assert.equal(h.frame.getAttribute(MOBILE_KBD_STATE_ATTR), 'idle', 'no event → the guard cannot have seen it yet')
    h.clock.advance(KBD_POLL_MS)
    assert.equal(h.frame.getAttribute(MOBILE_KBD_ATTR), '352', 'the bounded poll is the convergence path')
    assert.equal(h.frame.style.getPropertyValue(MOBILE_KBD_VAR), '352px')
    assert.equal(h.frame.getAttribute(MOBILE_KBD_STATE_ATTR), 'armed')
  })
})

test('the poll budget is per focus arm: pointer/focus churn never extends it (F2/F5)', () => {
  withGuard({ covered: 336 }, h => {
    assert.equal(h.frame.getAttribute(MOBILE_KBD_STATE_ATTR), 'armed')
    // 4Hz synthetic taps + focusin churn for the whole 4s budget (the measured
    // mutation: each event reset pollUntil before the running-interval return,
    // so the 250ms sync loop lived forever while the composer held focus).
    for (let elapsed = 0; elapsed <= KBD_POLL_BUDGET_MS; elapsed += KBD_POLL_MS) {
      h.pointerDown()
      h.focusIn()
      h.clock.advance(KBD_POLL_MS)
    }
    assert.equal(h.clock.pending, 0, 'the interval must stop at KBD_POLL_BUDGET_MS despite the churn')
    const reads = h.counts.scrollerRects
    h.clock.advance(2_000)
    assert.equal(h.counts.scrollerRects, reads, 'nothing may sync after the budget stopped the poll')
  })
})

test('the poll stops when focus leaves the editable (F5)', () => {
  withGuard({ covered: 336 }, h => {
    assert.equal(h.frame.getAttribute(MOBILE_KBD_STATE_ATTR), 'armed')
    h.blur()
    // The grace window (1.2s) keeps the interval through the close animation;
    // after it, the poll must end instead of syncing forever.
    h.clock.advance(KBD_POLL_BUDGET_MS)
    assert.equal(h.clock.pending, 0, 'focus loss must clear the interval')
    const reads = h.counts.scrollerRects
    h.clock.advance(2_000)
    assert.equal(h.counts.scrollerRects, reads)
  })
})

test('a focused editable OUTSIDE the composer seat leaves the guard idle (F6)', () => {
  withGuard({ covered: 336, focused: false }, h => {
    // The keyboard belongs to a settings-sheet question-card field: the seat
    // must not move just because SOME editable is focused.
    h.focusOutsideEditable()
    h.pointerDown()
    assert.equal(h.frame.getAttribute(MOBILE_KBD_STATE_ATTR), 'idle')
    assert.equal(h.frame.hasAttribute(MOBILE_KBD_ATTR), false)
    assert.equal(h.root.querySelectorAll(`[${MOBILE_KBD_SPACER_ATTR}]`).length, 0)
    h.clock.advance(KBD_POLL_MS)
    assert.equal(h.frame.hasAttribute(MOBILE_KBD_ATTR), false, 'the poll must not arm a non-composer field')
  })
})

test('a carrier that grows with the lift is latched, never ramped (F2)', () => {
  // The measurement's premise is that the scrollport's border box is
  // flex-sized, so our own writes cannot move it. This model breaks it: each
  // write grows the measured edge by the increment it applied (the synthetic
  // feedback that ramped 352 → 5984px over the poll window). The guard must
  // read the edge across the write, latch, and REPORT the residue.
  withGuard({ covered: 336, scrollerGrowsWithLift: 1 }, h => {
    const first = h.frame.getAttribute(MOBILE_KBD_ATTR)
    assert.equal(first, '352')
    for (let tick = 0; tick < 20; tick += 1) h.clock.advance(KBD_POLL_MS)
    assert.equal(h.frame.getAttribute(MOBILE_KBD_ATTR), first,
      'a self-pushed carrier must not raise the lift past its first bounded value')
    assert.equal(h.frame.getAttribute(MOBILE_KBD_STATE_ATTR), 'still-covered',
      'the residue is reported instead of chased')
  })
})

test('a hidden active-phase root earlier in DOM order never wins the seat query (F3)', () => {
  withGuard({ covered: 336, hiddenSeatFirst: true }, h => {
    // First-match seat selection served the hidden seat (scrollport 0x0) and
    // stayed idle while the real seat was covered.
    assert.equal(h.frame.getAttribute(MOBILE_KBD_STATE_ATTR), 'armed')
    assert.equal(h.frame.getAttribute(MOBILE_KBD_ATTR), '352')
    const spacer = spacerOf(h)
    assert.equal(spacer.style.height, '352px')
    assert.equal(h.seat.previousElementSibling?.hasAttribute(MOBILE_KBD_SPACER_ATTR), true,
      'the spacer must sit immediately before the REAL seat')
  })
})

test('dispose removes the state attribute from the frame and <html> (F4)', () => {
  withGuard({ covered: 336 }, (h, dispose) => {
    assert.equal(h.frame.getAttribute(MOBILE_KBD_STATE_ATTR), 'armed')
    assert.equal(h.document.documentElement.getAttribute(MOBILE_KBD_STATE_ATTR), 'armed')
    dispose()
    assert.equal(h.frame.hasAttribute(MOBILE_KBD_STATE_ATTR), false)
    assert.equal(h.document.documentElement.hasAttribute(MOBILE_KBD_STATE_ATTR), false)
    assert.equal(h.frame.hasAttribute(MOBILE_KBD_ATTR), false)
    assert.equal(h.root.querySelectorAll(`[${MOBILE_KBD_SPACER_ATTR}]`).length, 0)
  })
})

test('an engine that honors the sticky inset arms with one coherent 352px lift', () => {
  withGuard({ covered: 336 }, h => {
    assert.equal(h.frame.getAttribute(MOBILE_KBD_STATE_ATTR), 'armed')
    assert.equal(h.frame.getAttribute(MOBILE_KBD_ATTR), '352')
    assert.equal(h.frame.style.getPropertyValue(MOBILE_KBD_VAR), '352px')
    assert.equal(spacerOf(h).style.height, '352px')
  })
})

test('a requirement that GROWS during the write is corrected within the same sync, on the FINAL lift (F1)', () => {
  // Narrowed 2026-09: with an unchanged requirement the loop cannot fire
  // (`extra > 0` needs `residual > lift - 8`, while a partially honoured
  // engine leaves `residual <= nextKbdOffset(covered) - lift <= -8`) — a
  // partially honouring engine converges on the next event/poll tick instead.
  // The loop therefore only corrects demand that grew while the write landed.
  // The keyboard keeps rising while the first write lands (visible bottom drops
  // 400px): the first residual (384px) is worse than the applied lift, so the
  // bounded loop adds exactly the missing delta (48px → total 400) instead of
  // re-applying the whole residual. Every surface must carry that FINAL lift —
  // the attribute used to stay on the pre-verify target.
  withGuard({ covered: 336, keyboardGrowthOnFirstWrite: 400 }, h => {
    assert.equal(h.frame.getAttribute(MOBILE_KBD_ATTR), '400')
    assert.equal(h.frame.style.getPropertyValue(MOBILE_KBD_VAR), '400px')
    assert.equal(spacerOf(h).style.height, '400px')
    assert.equal(h.frame.getAttribute(MOBILE_KBD_STATE_ATTR), 'still-covered',
      'a 400px growth cannot be cleared by one bounded correction — it is reported')
    assert.ok(h.counts.seatRects <= KBD_MAX_VERIFY_STEPS + 2)
  })
})

test('a non-converging engine ends still-covered with the FINAL lift everywhere, never 3x (F1/F8)', () => {
  withGuard({ covered: 336, responsiveness: 0 }, h => {
    // The seat never moves: the guard re-verifies at most
    // KBD_MAX_VERIFY_STEPS times, then REPORTS instead of chasing.
    assert.equal(h.frame.getAttribute(MOBILE_KBD_STATE_ATTR), 'still-covered')
    // attr === var === spacer === the measured need (336 + 8 headroom → 352).
    // The measured defect was attr=352 / var=1056 / spacer=1056 because each
    // verify extra re-added the already-applied lift.
    assert.equal(h.frame.getAttribute(MOBILE_KBD_ATTR), '352')
    assert.equal(h.frame.style.getPropertyValue(MOBILE_KBD_VAR), '352px')
    const spacer = spacerOf(h)
    assert.equal(spacer.style.height, '352px')
    // Bounded measurement budget per sync: the loop corrections plus the final
    // read (never an unbounded ramp).
    assert.ok(h.counts.seatRects <= KBD_MAX_VERIFY_STEPS + 2,
      `the seat was measured ${h.counts.seatRects} times in one sync`)
    // The poll's next sync must not accumulate the offset either.
    h.clock.advance(KBD_POLL_MS)
    assert.equal(h.frame.getAttribute(MOBILE_KBD_ATTR), '352')
    assert.equal(spacer.style.height, '352px')
    assert.equal(h.frame.getAttribute(MOBILE_KBD_STATE_ATTR), 'still-covered')
  })
})
/**
 * RESTORED BREAKPOINT / STYLESHEET INVARIANTS (2026-09-21 deletion review).
 * The deleted test/visual/breakpoints.test.ts pinned 27 stylesheet invariants;
 * this section restores the user-visible and accessibility ones compactly into
 * the surviving MOBILE_CSS suite: coarse guards + media-query scoping (desktop
 * untouched), drawer layering/chrome, the fullscreen right panel with safe-area
 * insets, the 44px touch floors, the settings-sheet shape, the aria-modal and
 * 16px focus-zoom floors, the viewport tokens and the header shrink order. All
 * rule assertions run on comment-stripped, whitespace-normalized tiers, so
 * neither prose nor formatting can satisfy a lock. The section ends with the
 * generic source guard for rules written after the template literal.
 */

/** One media block (comments stripped, whitespace normalized); `end` bounds the slice. */
function sliceTier(start: string, end?: string): string {
  const from = MOBILE_CSS.indexOf(start)
  assert.ok(from !== -1, 'media block not found: ' + start)
  const to = end === undefined ? -1 : MOBILE_CSS.indexOf(end, from)
  return MOBILE_CSS.slice(from, to === -1 ? undefined : to).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ')
}
const normalizePhoneTier = (): string => sliceTier('@media (max-width: 768px)')
/** The 1023px tier only: slicing to the sheet end would swallow the phone tier. */
const normalizeTouchTier = (): string => sliceTier('@media (max-width: 1023px)', '@media (max-width: 768px)')
/** How many rules start with exactly `selector {` (at equal specificity the last wins). */
const countBlocks = (css: string, selector: string): number => css.split(selector + ' {').length - 1
/** The CSS block `selector { … }` (normalized form), or null. */
function cssBlock(css: string, selector: string): string | null {
  const at = css.indexOf(selector + ' {')
  if (at === -1) return null
  const open = css.indexOf('{', at)
  const close = open === -1 ? -1 : css.indexOf('}', open)
  return close === -1 ? null : css.slice(at, close + 1)
}
/** CSS-only comment stripper (the sheet holds no JS literals to protect). */
const stripCssComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '')

test('breakpoints: the tiers are media-scoped and carry the coarse-pointer guards', () => {
  assert.ok(MOBILE_CSS.includes('@media (max-width: 1023px) and (pointer: coarse)'), 'touch tier guard')
  assert.ok(MOBILE_CSS.includes('@media (max-width: 768px) and (pointer: coarse)'), 'phone tier guard')
  assert.ok(MOBILE_CSS.includes('@media (max-width: 480px) and (pointer: coarse)'), '480px tier')
  assert.ok(MOBILE_CSS.includes('@media (max-width: 360px) and (pointer: coarse)'), '360px tier')
  assert.ok(MOBILE_CSS.includes('@media ' + PHONE_TIER_QUERY), 'the JS phone tier must be the stylesheet tier')
  // Strip every balanced media block: the unscoped remainder must stay the ONE
  // deliberate desktop default (toggle + backdrop hidden) — anything else leaks
  // onto desktop (the "PC leak" invariant).
  let rest = MOBILE_CSS
  let cursor = 0
  for (;;) {
    const start = rest.indexOf('@media', cursor)
    if (start === -1) break
    const open = rest.indexOf('{', start)
    let depth = 0
    let end = -1
    for (let i = open; i < rest.length; i += 1) {
      if (rest[i] === '{') depth += 1
      else if (rest[i] === '}') { depth -= 1; if (depth === 0) { end = i + 1; break } }
    }
    assert.ok(end !== -1, 'unbalanced media block')
    rest = rest.slice(0, start) + rest.slice(end)
    cursor = start
  }
  const stripped = stripCssComments(rest).replace(/\s+/g, '')
  assert.equal(stripped, '.dsh-mobile-nav-toggle,.dsh-mobile-backdrop{display:none;}', 'unexpected unscoped rules: ' + stripped.slice(0, 200))
})

test('breakpoints: the drawer keeps its desktop default, layering, chrome and motion', () => {
  const outside = MOBILE_CSS.slice(0, MOBILE_CSS.indexOf('@media (max-width: 1023px)'))
  assert.ok(outside.includes('.dsh-mobile-nav-toggle,') && outside.includes('.dsh-mobile-backdrop') && outside.includes('display: none;'),
    'the desktop default hides both overlay entries')
  assert.ok(MOBILE_CSS.includes('display: inline-flex'), 'the touch tier shows the toggle')
  assert.ok(MOBILE_CSS.includes('width: min(86vw, 280px)'), 'drawer keeps the official sidebar width')
  assert.ok(MOBILE_CSS.includes('box-shadow: var(--dsw-elevation-prominent)'), 'raised surfaces use the elevation token')
  assert.ok(!MOBILE_CSS.includes('box-shadow: var(--dsw-shadow-lv'), 'the legacy shadow scale must stay unused')
  assert.ok(MOBILE_CSS.includes('var(--ds-transition-duration-slow') && MOBILE_CSS.includes('var(--ds-ease-in-out'))
  assert.ok(MOBILE_CSS.includes('@media (prefers-reduced-motion: reduce)'), 'the reduced-motion branch stays')
  assert.ok(MOBILE_CSS.includes('var(--dsw-alias-bg-mask-1'), 'the backdrop mask token stays')
  // Selector→z-index PAIRING: backdrop 74 < drawer 75 < toggle 76, above the
  // official fullscreen panel (40).
  const tier = normalizeTouchTier()
  const drawer = cssBlock(tier, '[data-mobile-role="sidebar"]')
  const backdrop = cssBlock(tier, '[data-mobile-frame]:not([data-sidebar-collapsed]) .dsh-mobile-backdrop')
  const toggle = cssBlock(tier, '.dsh-mobile-nav-toggle')
  assert.ok(drawer !== null && drawer.includes('z-index: 75'), 'drawer at 75')
  assert.ok(backdrop !== null && backdrop.includes('z-index: 74'), 'backdrop at 74')
  assert.ok(toggle !== null && toggle.includes('z-index: 76'), 'toggle at 76')
})

test('breakpoints: the right panel is re-presented fullscreen with safe-area insets', () => {
  const tier = normalizeTouchTier()
  const shown = cssBlock(tier, '[data-mobile-role="details"] [data-sidebar-right-panel]')
  assert.ok(shown !== null, 'the panel (not the display:contents wrapper) must be re-presented fullscreen')
  assert.ok(shown.includes('position: fixed;') && shown.includes('inset: 0;'), 'the panel fills the frame')
  assert.ok(shown.includes('width: 100% !important;'), 'the inline normal width must yield')
  assert.ok(shown.includes('z-index: 40;'), "upstream's own fullscreen layer")
  for (const side of ['top', 'right', 'bottom', 'left']) {
    assert.ok(shown.includes('padding-' + side + ': env(safe-area-inset-' + side + ', 0px);'), side + ' safe-area inset')
  }
  assert.ok(shown.includes('box-sizing: border-box;'), 'the insets must not widen the panel past the viewport')
  assert.equal(countBlocks(tier, '[data-mobile-role="details"] [data-sidebar-right-panel]'), 1,
    'the pinned selector must be unique (the cascade would let a duplicate win)')
  assert.equal(cssBlock(tier, '[data-mobile-frame]:not([data-rightbar-collapsed]) [data-mobile-role="details"] [data-sidebar-right-panel]'), null,
    'the presentation must not be frame-gated (the close animation needs the box)')
  assert.equal(cssBlock(tier, '[data-mobile-role="details"] > *'), null, 'the wrapper must never be the target')
  // The drawer yields to the panel on BOTH arms (track flag and phone band).
  const trackArm = '[data-mobile-frame]:not([data-rightbar-collapsed]) [data-mobile-role="sidebar"]'
  assert.ok(tier.includes(trackArm + ','), 'the track-arm of the drawer yield is missing')
  const fullArm = cssBlock(tier, '[data-mobile-frame][data-rightbar-fullscreen] [data-mobile-role="sidebar"]')
  assert.ok(fullArm !== null && fullArm.includes('visibility: hidden;'), 'the phone-band arm must hide the drawer too')
})

test('breakpoints: the 44px touch floors cover the review-fix seats', () => {
  const tier = normalizeTouchTier()
  const stripButton = '[data-sidebar-right-panel] [data-dockkit-strip] button:not([data-dockkit-tab-close])'
  const heightFloor = cssBlock(tier, [
    '[data-slot="conversation.composer.bar"] button,', '[data-slot="sidebar"] button,',
    '[data-slot="conversation.session.header.actions"] button,', '[data-slot="conversation.session.header.utilities"] button,',
    '[data-slot="conversation.session.header.corner"] button,', '[data-slot="settings.section"] button,',
    stripButton + ',', '[data-sidebar-right-panel] [data-dockkit-strip] [role="tab"],',
    '[role="menuitem"], [role="option"]',
  ].join(' '))
  assert.ok(heightFloor !== null && heightFloor.includes('min-height: 44px;'), 'the action seats carry the height floor')
  const widthFloor = cssBlock(tier, [
    '[data-slot="sidebar"] button,', '[data-slot="conversation.session.header.actions"] button,',
    '[data-slot="conversation.session.header.utilities"] button,', '[data-slot="conversation.session.header.corner"] button,',
    stripButton + ',', '[role="menuitem"], [role="option"]',
  ].join(' '))
  assert.ok(widthFloor !== null && widthFloor.includes('min-width: 44px;'), 'icon-only buttons carry the width floor')
  // The floor means the BOX on padded strip buttons; the chips must NOT get
  // that rule (dockkit measures chip min-width + padding).
  const stripBox = cssBlock(tier, stripButton)
  assert.ok(stripBox !== null && stripBox.includes('box-sizing: border-box;'))
  assert.equal(countBlocks(tier, stripButton), 1, 'the box-sizing rule must be unique')
  assert.ok(!/\[data-dockkit-strip\] \[role="tab"\]\s*\{/.test(stripCssComments(tier)), 'the chips must not get a box-sizing rule of their own')
  const tabs = cssBlock(tier, '[data-slot="conversation.session.header"] [role="tab"]')
  assert.ok(tabs !== null && tabs.includes('min-height: 44px;') && tabs.includes('box-sizing: border-box;'), 'view tabs carry the 44px box floor')
  const tablist = cssBlock(tier, '[data-slot="conversation.session.header"] [role="tablist"]')
  assert.ok(tablist !== null && tablist.includes('flex-wrap: wrap;'), 'the tab strip wraps instead of clipping')
  assert.ok(!stripCssComments(MOBILE_CSS).includes('role="tablist"]::-webkit-scrollbar'), 'the tab strip must not become a scroll container')
  const narrowBand = tier.slice(tier.indexOf('@media (min-width: 768px)'))
  const modeControl = cssBlock(narrowBand, '[data-mobile-frame] [data-sidebar-right-mode]')
  assert.ok(modeControl !== null && modeControl.includes('display: none !important;'), 'the inert mode control is hidden in 768-1023')
})

test('breakpoints: the settings sheet stacks on the phone tier', () => {
  const phone = normalizePhoneTier()
  const sheet = '[role="dialog"][aria-modal="true"]:has([data-slot="settings.header"])'
  assert.ok(MOBILE_CSS.includes(sheet), 'the full-screen rule must anchor the official dialog shape')
  const panel = cssBlock(phone, sheet)
  assert.ok(panel !== null && panel.includes('position: fixed !important;') && panel.includes('flex-direction: column !important;'),
    'the sheet goes full-screen and stacks vertically')
  const navList = cssBlock(phone, sheet + ' > nav > div:last-child')
  assert.ok(navList !== null && navList.includes('overflow-x: auto;') && navList.includes('flex-direction: row;'), 'the chip row scrolls horizontally')
  const headerRow = cssBlock(phone, sheet + ' > div:last-child > div:has([data-slot="settings.action"]):has([data-slot="settings.close"])')
  assert.ok(headerRow !== null && headerRow.includes('position: sticky;') && headerRow.includes('flex: none;'),
    'the header row is pinned on the documented seams')
  assert.equal(cssBlock(phone, sheet + ' > div:last-child > div:first-child'), null, 'the sticky row must not be positional')
  const options = cssBlock(phone, sheet + ' > div:last-child > div:last-child')
  assert.ok(options !== null && options.includes('overflow-y: auto;'), 'the options area is the inner scroller')
})

test('breakpoints: no blanket aria-modal cap, and the 16px focus-zoom floors stay', () => {
  const code = stripCssComments(MOBILE_CSS)
  assert.ok(!/\[role="dialog"\]\[aria-modal="true"\]:not\(/.test(code), 'no blanket aria-modal cap (the ImageLightbox backdrop stays full-bleed)')
  const selectors = [...code.matchAll(/([^{}]+)\{/g)].map(match => (match[1] ?? '').trim()).filter(selector => selector.includes('aria-modal'))
  assert.ok(selectors.length > 0, 'the settings sheet anchors must stay')
  for (const selector of selectors) {
    assert.ok(selector.includes(':has([data-slot="settings.header"])'), 'only settings-sheet rules may anchor on aria-modal: ' + selector)
  }
  const fields = cssBlock(normalizePhoneTier(),
    '[role="dialog"] input:not([type="checkbox"]):not([type="radio"]):not([type="range"]), [role="dialog"] select, [role="dialog"] textarea')
  assert.ok(fields !== null && fields.includes('max(16px, var(--dsh-content-font-size, 16px)) !important;'), 'dialog fields stay at/above 16px')
})

test('breakpoints: safe-area, 16px floors and the viewport tokens stay accessible', () => {
  const composerSeat = cssBlock(normalizePhoneTier(), '[data-composer-seat]')
  assert.ok(composerSeat !== null && composerSeat.includes('env(safe-area-inset-bottom'), 'the composer seat clears the home indicator')
  const toggle = cssBlock(normalizeTouchTier(), '.dsh-mobile-nav-toggle')
  assert.ok(toggle !== null && toggle.includes('env(safe-area-inset-top'), 'the drawer toggle clears the island')
  assert.ok(MOBILE_CSS.includes('max(16px, var(--dsh-content-font-size, 16px))'), 'the composer font keeps the official content-size preference above 16px')
  assert.match(stripCssComments(MOBILE_CSS),
    /\[data-mobile-role="sidebar"\] input:not\(\[type="checkbox"\]\):not\(\[type="radio"\]\):not\(\[type="range"\]\)[^{]*\{\s*font-size:\s*max\(16px, var\(--dsh-content-font-size, 16px\)\) !important;/,
    'the drawer fields carry the 16px floor')
  assert.deepEqual(VIEWPORT_TOKENS, ['viewport-fit=cover', 'interactive-widget=resizes-content'])
  assert.ok(!MOBILE_CSS.includes('user-scalable'), 'WCAG 1.4.4: no user-scalable lock')
})

test('breakpoints: retired mechanisms stay gone and sticky-hover stays suppressed', () => {
  assert.ok(!MOBILE_CSS.includes('data-mobile-dismiss'), 'the session-log stamping CSS must stay gone')
  assert.ok(MOBILE_CSS.includes('[data-dockkit-divider]'), 'only dockkit drag chrome may be hidden')
  assert.ok(!stripCssComments(MOBILE_CSS).includes('[data-dockkit-split-button]'), 'the usable split button must not be re-hidden')
  assert.ok(!MOBILE_CSS.includes('dsh-mobile-nav-toggle-bars'), 'the CSS hamburger must stay gone')
  const code = stripCssComments(MOBILE_CSS)
  const tooltipSelectors = [...code.matchAll(/([^{}]+)\{/g)]
    .map(match => (match[1] ?? '').trim()).map(selector => selector.replace(/:not\([^)]*\)/g, ''))
    .filter(selector => /\[role\s*[~^$*|]?=\s*["']?tooltip["']?\]/.test(selector))
  assert.deepEqual(tooltipSelectors, ['button[aria-label] + [role="tooltip"][data-side]'], 'only bubbles duplicating an accessible name may be hidden')
  assert.match(code, /button\[aria-label\] \+ \[role="tooltip"\]\[data-side\]\s*\{\s*display:\s*none\s*!important;/)
  const coarseAt = code.indexOf('@media (pointer: coarse) and (hover: none)')
  const ruleAt = code.indexOf('button[aria-label] + [role="tooltip"][data-side]')
  assert.ok(coarseAt !== -1 && ruleAt > coarseAt && ruleAt < code.indexOf('@media (max-width: 1023px)'),
    'the suppression must live in the coarse+hover tier, not the touch tier')
  // The keyboard arm rides the plugin frame stamp and the scrollport padding
  // arm stays removed (it double-lifts the seat).
  assert.ok(code.includes('[data-mobile-frame][data-mobile-kbd] [data-phase="active"] [data-composer-seat]'))
  assert.equal(code.includes('padding-bottom: var(--chamber-mobile-kbd-offset, 0px) !important;'), false,
    'the scrollport padding arm must stay removed')
})

test('breakpoints: the session header stays one line and degrades text only', () => {
  const phone = normalizePhoneTier()
  const nav = cssBlock(normalizeTouchTier(), '[data-mobile-frame] [data-slot="conversation.session.header"] nav')
  assert.ok(nav !== null && nav.includes('flex-wrap: nowrap') && nav.includes('white-space: nowrap'),
    'the crumb strip must not wrap (the class-less lineage count has no other protection)')
  assert.ok(nav.includes('overflow-x: auto') && nav.includes('scrollbar-width: none'), 'panning replaces the clip')
  const row = cssBlock(phone, '[data-mobile-frame] [data-slot="conversation.session.header"] > header > div:has(nav)')
  assert.ok(row !== null && row.includes('min-height: 48px'), 'the title row is a 48px touch row')
  const lineage = cssBlock(phone, '[data-mobile-frame] [data-slot="conversation.session.header.lineage"] button')
  assert.ok(lineage !== null && lineage.includes('flex: 0 0 auto') && lineage.includes('min-height: 44px'),
    'the lineage chip stays out of the shrink race at a 44px target')
  const currentCrumb = cssBlock(phone, '[data-mobile-frame] [data-slot="conversation.session.header"] nav > span > button:disabled')
  assert.ok(currentCrumb !== null && currentCrumb.includes('flex: 1 1 auto'), 'the current crumb absorbs the remaining width and ellipsises')
  const code = stripCssComments(MOBILE_CSS)
  assert.ok(!code.includes('[data-slot="conversation.session.header.actions"] > button'), 'no rule may target a direct-child button: the seat has none')
  const label = cssBlock(MOBILE_CSS, '[data-mobile-frame] [data-slot="conversation.session.header.actions"] > span')
  assert.ok(label !== null && label.includes('max-width: 8em') && label.includes('min-width: 0') && !label.includes('display: none'),
    'the 480px tier clips (never removes) the agent-preset span that really exists')
  assert.match(code,
    /@media \(max-width: 360px\) and \(pointer: coarse\) \{\s*[^}]*?\[data-mobile-frame\] \[data-slot="conversation\.session\.header\.actions"\] > span \{\s*max-width: 5em;/,
    'the narrowest tier takes one more step back')
})

test('css-source: no CSS rule may live after the MOBILE_CSS literal', () => {
  // Single source, no shadow copy: CSS written after the template literal is
  // not in MOBILE_CSS and has no other plain-node behavior entry point.
  const lines = readFileSync(new URL('../../src/client/styles.ts', import.meta.url), 'utf8').split('\n')
  const open = lines.findIndex(line => line.includes('export const MOBILE_CSS = `'))
  assert.ok(open !== -1, 'MOBILE_CSS export not found (renamed?)')
  let close = -1
  for (let index = open + 1; index < lines.length; index += 1) {
    if (lines[index]?.trim() === '`') { close = index; break }
  }
  assert.ok(close !== -1, 'MOBILE_CSS closing backtick not found (unterminated literal?)')
  assert.ok(!lines.slice(close + 1).join('\n').includes('{'), 'no CSS rule may live after the literal')
})
