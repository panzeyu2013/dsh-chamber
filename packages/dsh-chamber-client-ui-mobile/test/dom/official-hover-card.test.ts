/**
 * Stranded official hover-card watchdog + coarse-pointer tip suppression
 * (design 17 §18.4.5 / §18.4.2).
 *
 * Two coarse-pointer hover surfaces are pinned here:
 *
 *  1. the OFFICIAL `ui-primitives` HoverCard, whose close grace is armed from
 *     the last COMMITTED open (a leave inside the commit window strands the
 *     card, and a tap delivers no leave at all). The chamber cannot edit the
 *     vendored atom, so `official-hover-card.ts` drives its own
 *     `onPointerLeave` through one bubbling `pointerout` on the matched
 *     wrapper. Every decision of that watchdog is a pure function, tested
 *     here against the atom's real anchoring relation and against decoys (a
 *     foreign module hash, a foreign hash class on a 244px fixed element, an
 *     ambiguous pair), and the two DOM-touching steps are tested through the
 *     package's duck-typed fake pattern and a source lock.
 *
 *  2. the hand-rolled `data-tip` bubbles (chamber pages) the stylesheet's
 *     coarse-pointer tier must suppress as well. The lock asserts the rule
 *     lives INSIDE the coarse/no-hover media block — a rule that drifted to
 *     the top level would leak onto desktop.
 */
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  CARD_ANCHOR_GAP_PX,
  CARD_QUERY,
  CARD_ROOT_QUERY,
  COARSE_NO_HOVER_QUERY,
  OFFICIAL_CARD_CLASS_TOKEN,
  OFFICIAL_CARD_ROOT_CLASS_TOKEN,
  dispatchBoundaryLeave,
  hasModuleClassToken,
  installStrandedHoverCardWatchdog,
  isGestureOutside,
  isOutsideRect,
  isUsableAnchorRect,
  matchesCardAnchor,
  scanStrandedCards,
  type ElementFace,
  type QueryRootFace,
  type RectLike,
} from '../../src/client/official-hover-card.ts'
import { MOBILE_CSS } from '../../src/client/styles.ts'
import { PointerEventDouble, installPointerEventDouble } from '../support/pointer-event-double.ts'

// This Node process has no DOM globals and the watchdog constructs the real
// PointerEvent, so the bench installs its double for the whole file.
const restorePointerEvent = installPointerEventDouble()
after(() => { restorePointerEvent() })

const SOURCE = readFileSync(new URL('../../src/client/official-hover-card.ts', import.meta.url), 'utf8')
/** Comment-stripped: a rule assertion must be satisfied (or broken) by CODE,
 *  never by the prose that explains it. */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const INDEX_CODE = readFileSync(new URL('../../src/client/index.ts', import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

// The pinned build's real class strings (rc.2 served bundle
// `@deepseek-ai/dsh-web-frontend/dist/assets/index-Q6zc2uHV.js`:
// `Pp="_root_38jqx_3"`, `Rp="_card_38jqx_9"`, `zp="_copyable_38jqx_21"`).
const REAL_WRAPPER_CLASS = '_root_38jqx_3'
const REAL_CARD_CLASS = '_card_38jqx_9 _copyable_38jqx_21'
/** A Tooltip bubble's own module (foreign hash) — never a card. */
const TOOLTIP_CLASS = '_bubble_9zq1k_5'

/** The atom's own relation: card.left = wrapper.right + 8. */
const WRAPPER_RECT: RectLike = { left: 100, top: 50, right: 240, bottom: 78 }
const CARD_RECT: RectLike = { left: 248, top: 50, right: 492, bottom: 350 }
const VIEWPORT_HEIGHT = 800

function rect(left: number, top: number, right: number, bottom: number): RectLike {
  return { left, top, right, bottom }
}

// ---------------------------------------------------------------- pure faces

test('the class token matches the pinned build only, as a whole token', () => {
  assert.equal(hasModuleClassToken(REAL_CARD_CLASS, OFFICIAL_CARD_CLASS_TOKEN), true)
  assert.equal(hasModuleClassToken(REAL_WRAPPER_CLASS, OFFICIAL_CARD_ROOT_CLASS_TOKEN), true)
  // A different CSS-module hash (another component, another dsh build).
  assert.equal(hasModuleClassToken(TOOLTIP_CLASS, OFFICIAL_CARD_CLASS_TOKEN), false)
  assert.equal(hasModuleClassToken('_card_aa11b_13', OFFICIAL_CARD_CLASS_TOKEN), false)
  // The token must be a whole class: not a longer word, not a substring of one.
  assert.equal(hasModuleClassToken('_card_38jqx_x', OFFICIAL_CARD_CLASS_TOKEN), false)
  assert.equal(hasModuleClassToken('foo_card_38jqx_13', OFFICIAL_CARD_CLASS_TOKEN), false)
  assert.equal(hasModuleClassToken('', OFFICIAL_CARD_CLASS_TOKEN), false)
  assert.equal(hasModuleClassToken(null, OFFICIAL_CARD_CLASS_TOKEN), false)
  assert.equal(hasModuleClassToken(undefined, OFFICIAL_CARD_CLASS_TOKEN), false)
})

test('the anchor relation is the atom\'s own geometry, including the bottom clamp', () => {
  // Plain case: left = wrapper.right + 8, top = wrapper.top.
  assert.equal(matchesCardAnchor(WRAPPER_RECT, CARD_RECT, VIEWPORT_HEIGHT), true)
  // Sub-pixel rounding is tolerated, a shifted card is not.
  assert.equal(matchesCardAnchor(WRAPPER_RECT, rect(248.5, 50.5, 492, 350), VIEWPORT_HEIGHT), true)
  assert.equal(matchesCardAnchor(WRAPPER_RECT, rect(256, 50, 500, 350), VIEWPORT_HEIGHT), false)
  assert.equal(matchesCardAnchor(WRAPPER_RECT, rect(248, 60, 492, 360), VIEWPORT_HEIGHT), false)
  // Bottom clamp: top = innerHeight - cardHeight - 8, i.e. bottom = height - 8,
  // and the card necessarily starts above the wrapper.
  const lowWrapper = rect(100, 600, 240, 628)
  const clamped = rect(248, 492, 492, VIEWPORT_HEIGHT - CARD_ANCHOR_GAP_PX)
  assert.equal(matchesCardAnchor(lowWrapper, clamped, VIEWPORT_HEIGHT), true)
  assert.equal(
    matchesCardAnchor(lowWrapper, rect(248, 700, 492, VIEWPORT_HEIGHT - CARD_ANCHOR_GAP_PX), VIEWPORT_HEIGHT),
    false,
    'a clamped card that starts below the wrapper is not the atom\'s relation',
  )
  // A hidden / un-laid-out row (all-zero rect) is never an anchor, even
  // though a card at left 8, top 0 would "match" it.
  assert.equal(isUsableAnchorRect(rect(0, 0, 0, 0)), false)
  assert.equal(matchesCardAnchor(rect(0, 0, 0, 0), rect(8, 0, 252, 60), VIEWPORT_HEIGHT), false)
  // Non-finite rects (detached nodes) fail closed.
  assert.equal(matchesCardAnchor(WRAPPER_RECT, rect(Number.NaN, 50, 492, 350), VIEWPORT_HEIGHT), false)
  assert.equal(matchesCardAnchor(rect(100, 50, Number.NaN, 78), CARD_RECT, VIEWPORT_HEIGHT), false)
})

test('a pointer is "outside" only when provably outside, with a fail-closed margin', () => {
  assert.equal(isOutsideRect(150, 60, WRAPPER_RECT), false)
  assert.equal(isOutsideRect(100, 50, WRAPPER_RECT), false, 'the edge is not outside')
  assert.equal(isOutsideRect(120, 49, WRAPPER_RECT), false, 'inside the 2px safety margin')
  assert.equal(isOutsideRect(120, 47, WRAPPER_RECT), true, 'past the margin is provably outside')
  assert.equal(isOutsideRect(500, 400, WRAPPER_RECT), true)
  assert.equal(isOutsideRect(Number.NaN, 60, WRAPPER_RECT), false)
  assert.equal(isOutsideRect(150, Number.POSITIVE_INFINITY, WRAPPER_RECT), false)
})

test('a gesture dismisses only when target AND coordinates are away from both boxes', () => {
  const away = { targetInWrapper: false, targetInCard: false, pointInWrapper: false, pointInCard: false }
  assert.equal(isGestureOutside(away), true)
  for (const key of ['targetInWrapper', 'targetInCard', 'pointInWrapper', 'pointInCard'] as const) {
    assert.equal(isGestureOutside({ ...away, [key]: true }), false, `${key} must block the dismissal`)
  }
})

// ------------------------------------------------------------- the DOM scan

interface FakeElement extends ElementFace {
  readonly tag: string
  readonly rect: RectLike
}

function fakeElement(tag: string, classAttr: string | null, elementRect: RectLike): FakeElement {
  return {
    tag,
    rect: elementRect,
    getAttribute: (name: string) => (name === 'class' ? classAttr : null),
    getBoundingClientRect: () => elementRect,
  }
}

/** A query root that only answers the two production selectors — an
 *  unexpected selector fails the test rather than passing silently. */
function fakeRoot(cards: FakeElement[], wrappers: FakeElement[]): {
  queries: string[]
  face: QueryRootFace<FakeElement>
} {
  const queries: string[] = []
  return {
    queries,
    face: {
      querySelectorAll(selector: string) {
        queries.push(selector)
        if (selector === CARD_QUERY) return cards
        if (selector === CARD_ROOT_QUERY) return wrappers
        throw new Error(`unexpected selector: ${selector}`)
      },
    },
  }
}

test('a card is paired with exactly the one wrapper that anchors it', () => {
  const card = fakeElement('div', REAL_CARD_CLASS, CARD_RECT)
  const wrapper = fakeElement('span', REAL_WRAPPER_CLASS, WRAPPER_RECT)
  const other = fakeElement('span', REAL_WRAPPER_CLASS, rect(100, 400, 240, 428))
  const root = fakeRoot([card], [other, wrapper])
  const pairs = scanStrandedCards(root.face, VIEWPORT_HEIGHT)
  assert.equal(pairs.length, 1)
  assert.equal(pairs[0]?.card, card)
  assert.equal(pairs[0]?.wrapper, wrapper)
  assert.deepEqual(root.queries, [CARD_QUERY, CARD_ROOT_QUERY])
})

test('no card means no action at all — the wrapper query never runs', () => {
  const root = fakeRoot([], [fakeElement('span', REAL_WRAPPER_CLASS, WRAPPER_RECT)])
  assert.deepEqual(scanStrandedCards(root.face, VIEWPORT_HEIGHT), [])
  assert.deepEqual(root.queries, [CARD_QUERY])
})

test('a 244px fixed element that is not the card is never a candidate', () => {
  // The Tooltip bubble: same geometry, foreign module class.
  const bubble = fakeElement('div', TOOLTIP_CLASS, CARD_RECT)
  const root = fakeRoot([bubble], [fakeElement('span', REAL_WRAPPER_CLASS, WRAPPER_RECT)])
  assert.deepEqual(scanStrandedCards(root.face, VIEWPORT_HEIGHT), [])
})

test('stale geometry, a foreign wrapper and an ambiguous pair all fail closed', () => {
  const card = fakeElement('div', REAL_CARD_CLASS, CARD_RECT)
  // The wrapper moved (or the card is stale): no relation, no pair.
  assert.deepEqual(
    scanStrandedCards(fakeRoot([card], [fakeElement('span', REAL_WRAPPER_CLASS, rect(100, 400, 240, 428))]).face, VIEWPORT_HEIGHT),
    [],
  )
  // A root-class element with a foreign hash is not a wrapper.
  assert.deepEqual(
    scanStrandedCards(fakeRoot([card], [fakeElement('span', '_root_aa11b_3', WRAPPER_RECT)]).face, VIEWPORT_HEIGHT),
    [],
  )
  // A hidden row is not an anchor.
  assert.deepEqual(
    scanStrandedCards(fakeRoot([card], [fakeElement('span', REAL_WRAPPER_CLASS, rect(0, 0, 0, 0))]).face, VIEWPORT_HEIGHT),
    [],
  )
  // Two candidates with the same rect: an ambiguous relation is skipped.
  assert.deepEqual(
    scanStrandedCards(
      fakeRoot([card], [
        fakeElement('span', REAL_WRAPPER_CLASS, WRAPPER_RECT),
        fakeElement('span', REAL_WRAPPER_CLASS, WRAPPER_RECT),
      ]).face,
      VIEWPORT_HEIGHT,
    ),
    [],
  )
})

test('every matched card of a document is found, in card order', () => {
  const firstCard = fakeElement('div', REAL_CARD_CLASS, CARD_RECT)
  const secondCard = fakeElement('div', OFFICIAL_CARD_CLASS_TOKEN + '7', rect(248, 300, 492, 500))
  const pairs = scanStrandedCards(
    fakeRoot([firstCard, secondCard], [
      fakeElement('span', REAL_WRAPPER_CLASS, WRAPPER_RECT),
      fakeElement('span', REAL_WRAPPER_CLASS, rect(100, 300, 240, 328)),
    ]).face,
    VIEWPORT_HEIGHT,
  )
  assert.deepEqual(pairs.map(pair => pair.card), [firstCard, secondCard])
})

// ------------------------------------------------------------- the dispatch

test('the dismissal dispatches exactly one bubbling pointerout with no related target', () => {
  const seen: Event[] = []
  const dispatched = dispatchBoundaryLeave({ dispatchEvent: (event) => { seen.push(event); return true } })
  assert.equal(dispatched, true)
  assert.equal(seen.length, 1)
  const event = seen[0]
  assert.ok(event !== undefined)
  assert.ok(event instanceof PointerEventDouble, 'the direct PointerEvent constructor must use the installed double')
  assert.equal(event.type, 'pointerout', 'the atom listens for React\'s delegated pointerout')
  assert.equal(event.bubbles, true, 'React listens at the root container: the event must bubble')
  assert.equal(event.cancelable, false)
  // React resolves the related target via `relatedTarget || fromElement`;
  // both must be empty for it to read "the pointer left the window".
  assert.equal((event as { relatedTarget?: unknown }).relatedTarget ?? null, null)
  assert.equal((event as { fromElement?: unknown }).fromElement ?? null, null)
})

test('in a browser the dispatch uses PointerEvent with relatedTarget null', () => {
  const globals = globalThis as { PointerEvent?: unknown }
  const previous = globals.PointerEvent
  class FakePointerEvent extends Event {
    readonly relatedTarget: unknown
    constructor(type: string, init?: PointerEventInit) {
      super(type, init)
      this.relatedTarget = init?.relatedTarget ?? null
    }
  }
  globals.PointerEvent = FakePointerEvent
  try {
    const seen: Event[] = []
    dispatchBoundaryLeave({ dispatchEvent: (event) => { seen.push(event); return true } })
    assert.ok(seen[0] instanceof FakePointerEvent)
    assert.equal((seen[0] as unknown as { relatedTarget: unknown }).relatedTarget, null)
  } finally {
    globals.PointerEvent = previous
  }
})

test('without a PointerEvent global the dispatch fails closed instead of falling back', () => {
  const globals = globalThis as { PointerEvent?: unknown }
  const previous = globals.PointerEvent
  delete globals.PointerEvent
  try {
    const seen: Event[] = []
    assert.equal(
      dispatchBoundaryLeave({ dispatchEvent: (event) => { seen.push(event); return true } }),
      false,
      'a missing PointerEvent must fail closed, never stand in a MouseEvent/Event lookalike',
    )
    assert.deepEqual(seen, [], 'no fallback constructor may dispatch anything')
  } finally {
    globals.PointerEvent = previous
  }
})

test('a throwing host fails closed: the watchdog never propagates', () => {
  assert.equal(dispatchBoundaryLeave({ dispatchEvent: () => { throw new Error('boom') } }), false)
})

// ------------------------------------------------------------- the installer

test('without a DOM the installer is a harmless no-op (plain node harness)', () => {
  const dispose = installStrandedHoverCardWatchdog(() => true)
  assert.equal(typeof dispose, 'function')
  dispose()
  dispose()
})

test('the watchdog owns exactly one event kind and no timer', () => {
  const constructed = [...CODE.matchAll(/new\s+[A-Za-z_$][\w$]*\(\s*'([a-z]+)'/g)].map(match => match[1])
  assert.deepEqual(constructed, ['pointerout'], 'only the boundary event may ever be constructed')
  assert.match(CODE, /new PointerEvent\('pointerout', init\)/, 'the boundary event must come from PointerEvent directly')
  assert.doesNotMatch(CODE, /MouseEvent|typeof PointerEvent/, 'the fallback constructor chain must stay retired')
  assert.equal(/setTimeout|setInterval/.test(CODE), false, 'the watchdog arms no timer of its own')
  // One dispatch call site, inside dispatchBoundaryLeave: no click, no
  // pointerdown, no key event can ever leave this module.
  assert.equal([...CODE.matchAll(/\.dispatchEvent\(/g)].length, 1, 'exactly one dispatch call site')
})

test('the watchdog listens to the three dismissal triggers at document/window level', () => {
  assert.match(CODE, /document\.addEventListener\('pointerdown', onPointerDown, true\)/)
  assert.match(CODE, /document\.addEventListener\('visibilitychange', onVisibilityChange\)/)
  assert.match(CODE, /window\.addEventListener\('blur', onBlur\)/)
  assert.match(CODE, /document\.removeEventListener\('pointerdown', onPointerDown, true\)/)
  assert.match(CODE, /document\.removeEventListener\('visibilitychange', onVisibilityChange\)/)
  assert.match(CODE, /window\.removeEventListener\('blur', onBlur\)/)
  // Every dismissal path re-checks the live tier and is wrapped fail-closed.
  assert.ok(
    [...CODE.matchAll(/if \(!active\(\)\) return/g)].length >= 2,
    'both dismissal paths must re-check the live tier gate',
  )
  assert.ok(
    [...CODE.matchAll(/\} catch \{/g)].length >= 3,
    'dismissal, gesture and dispatch must all fail closed',
  )
})

test('the installer is guarded by exactly one Symbol.for window property', () => {
  assert.match(CODE, /Symbol\.for\('dsh-chamber\.dsh-client-ui-mobile\.stranded-hover-card'\)/)
  assert.match(CODE, /delete guard\[WATCHDOG_GUARD\]/)
  assert.match(CODE, /if \(guard\[WATCHDOG_GUARD\] !== undefined\) return \(\) => \{\}/)
})

test('index.ts installs the watchdog under its own coarse/no-hover tier gate', () => {
  assert.match(INDEX_CODE, /import \{[\s\S]*installStrandedHoverCardWatchdog,[\s\S]*\} from '\.\/official-hover-card\.ts'/)
  assert.match(INDEX_CODE, /window\.matchMedia\(COARSE_NO_HOVER_QUERY\)/)
  assert.match(INDEX_CODE, /installStrandedHoverCardWatchdog\(\(\) => coarseNoHover\.matches\)/)
  assert.match(
    INDEX_CODE,
    /ctx\.effect\(\(\) => \{[\s\S]*?installStrandedHoverCardWatchdog\(/,
    'the watchdog is a ctx.effect: its listeners die with the plugin context',
  )
  assert.match(INDEX_CODE, /coarseNoHover\.addEventListener\('change', sync\)/)
  assert.match(INDEX_CODE, /disposeWatchdog\?\.\(\)/)
})

// --------------------------------------------------- the coarse-pointer CSS

/** The inner text of the first `@media <query>` block (brace-matched). */
function mediaBlock(css: string, query: string): string {
  const start = css.indexOf(`@media ${query}`)
  assert.notEqual(start, -1, `missing @media ${query}`)
  const open = css.indexOf('{', start)
  let depth = 0
  for (let index = open; index < css.length; index += 1) {
    if (css[index] === '{') depth += 1
    else if (css[index] === '}') {
      depth -= 1
      if (depth === 0) return css.slice(open + 1, index)
    }
  }
  assert.fail('unbalanced @media block')
}

test('the JS tier gate is byte-identical to the stylesheet coarse-pointer tier', () => {
  assert.ok(
    MOBILE_CSS.includes(`@media ${COARSE_NO_HOVER_QUERY}`),
    'the watchdog tier and the sticky-surface CSS tier must be the same condition',
  )
})

test('the committed client artifact ships both mitigations (source/artifact lockstep)', () => {
  // `exports["./client"]` points at lib/client.js and the gateway seeds that
  // file byte for byte, so a source-only change ships nothing. This lock pins
  // the SHIPPED bytes: run the package build after touching src/client/**.
  const artifact = readFileSync(new URL('../../lib/client.js', import.meta.url), 'utf8')
  assert.ok(
    artifact.includes('dsh-chamber.dsh-client-ui-mobile.stranded-hover-card'),
    'lib/client.js must ship the watchdog installer (rebuild: pnpm --filter @dsh-chamber/dsh-client-ui-mobile run build)',
  )
  assert.ok(artifact.includes('[data-tip]'), 'lib/client.js must ship the data-tip suppression rule')
  assert.match(
    artifact,
    /\[data-tip\]::after[^}]*display: none !important/,
    'the shipped bytes must carry the suppression declaration, not just the selector',
  )
})

test('the data-tip bubble suppression lives inside the coarse/no-hover block', () => {
  const block = mediaBlock(MOBILE_CSS, COARSE_NO_HOVER_QUERY)
  assert.match(
    block,
    /\[data-tip\]::after\s*\{\s*display:\s*none\s*!important;/,
    'the hand-rolled data-tip bubble must be suppressed on the coarse tier',
  )
  // The official Tooltip rule this one mirrors stays in the same block.
  assert.ok(block.includes('button[aria-label] + [role="tooltip"][data-side]'))
  // One occurrence, inside the block: a second copy or a top-level rule would
  // leak the suppression onto desktop (the "PC leak" invariant).
  const first = MOBILE_CSS.indexOf('[data-tip]')
  assert.equal(MOBILE_CSS.slice(first + 1).includes('[data-tip]'), false, 'exactly one data-tip rule')
  assert.ok(
    first > MOBILE_CSS.indexOf(`@media ${COARSE_NO_HOVER_QUERY}`) &&
      first < MOBILE_CSS.indexOf(`@media ${COARSE_NO_HOVER_QUERY}`) + block.length,
    'the rule must sit inside the coarse/no-hover media block',
  )
})

test('the data-tip attribute this rule depends on is still EMITTED by the chamber page that owns it', () => {
  // Cross-package lockstep: `[data-tip]::after` is a silent
  // no-op if the emitting package renames the attribute, and the anchor gate
  // cannot see a JSX attribute in a sibling package's source. The mobile plugin
  // owns no data-tip site itself — the connections settings sheet does — so the
  // contract is pinned here. (The official side of the same attribute is checked
  // against the pinned upstream corpus by scripts/upstream/verify-mobile-anchors.mjs.)
  const repoRoot = new URL('../../../..', import.meta.url)
  const emitter = readFileSync(new URL('packages/dsh-chamber-client-ui-settings-connections/src/client/ConnectionsSection.tsx', repoRoot), 'utf8')
  assert.match(emitter, /data-tip=\{/, 'the connections page must still set the data-tip attribute')
  const emitterCss = readFileSync(new URL('packages/dsh-chamber-client-ui-settings-connections/src/client/ConnectionsSection.module.css', repoRoot), 'utf8')
  assert.match(emitterCss, /content:\s*attr\(data-tip\)/, 'the emitter must still render the bubble through content: attr(data-tip)')
})
