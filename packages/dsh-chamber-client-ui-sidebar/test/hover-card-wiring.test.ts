/**
 * Row hover-card wiring lock (source text, no React runtime).
 *
 * `ServerSection.tsx` and `RowHoverCard.tsx` value-import React and the dsh
 * client packages, so a plain `node test/…` run cannot import them; the
 * behavior of the state machine they delegate to IS unit-tested
 * (`hover-intent.test.ts`). This lock pins the GLUE a green machine test cannot
 * see:
 *
 *  1. both row kinds (workspace header, session row) render the chamber-owned
 *     `RowHoverCard` — not the vendored `HoverCard`, whose open/close pair is
 *     the measured defect this port replaces — and the workspace card stays
 *     read-only (no `copyText`, hence no copy props that could never render);
 *  2. the component never re-implements the racy open (a bare `setTimeout` that
 *     commits `open` on its own) — the dwell/grace decisions belong to
 *     `createHoverIntent`, including the `openDelayMs` override;
 *  3. the three interaction rules the official atom defines survive the port:
 *     enter/leave drive the intent, a press outside the card dismisses, and a
 *     press inside the card is left alone so text selection still works;
 *  4. the render half really renders (anchor handlers, the portaled card, the
 *     marked card/anchor) — an "inert" component that renders nothing must not
 *     pass by leaving the identifiers in dead code (mutation-testing finding);
 *  5. the close path bumps the copy epoch (upstream `close()`,
 *     ui-primitives HoverCard.tsx:54-58), so an in-flight clipboard write that
 *     settles after close→reopen cannot paint `copiedLabel` on the NEW card;
 *  6. placement: no invented top floor, an off-screen anchor closes instead of
 *     pinning the card at the edge, and layout changes re-place it
 *     (ResizeObserver) rather than leaving stale coordinates;
 *  7. the page-global slot, the blur/visibility dismissal and the barrel export
 *     of `dismissVisibleRowCard()` (the renderer's hidden-view closer) stay.
 *
 * LIMITS, stated honestly (the repo's convention, see `source-lock.ts`): these
 * are SOURCE-TEXT locks. They prove the SHAPE of the glue, never its runtime
 * behavior — a mutant that keeps every pinned identifier while inverting the
 * surrounding logic still passes, and no lock here can see the DOM. The
 * machine's own decisions are covered for real in `hover-intent.test.ts`; for
 * the component there is no counterpart, because a plain `node test/…` run
 * cannot mount React (`RowHoverCard.tsx` portals to the DOM). Two consequences
 * are deliberate: every read is comment-stripped (prose can never satisfy a
 * lock), and the render half is asserted as ONE extracted block so that
 * deleting the card, the portal or the pointer handlers fails loudly.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalize, source, stripComments } from './source-lock.ts'

const serverSection = stripComments(source('../src/client/ServerSection.tsx'))
const hoverIntent = stripComments(source('../src/shared/hover-intent.ts'))
const sharedIndex = stripComments(source('../src/shared/index.ts'))
const rowHoverCard = stripComments(source('../src/client/RowHoverCard.tsx'))
const css = source('../src/client/sidebar-chamber.module.css')

/**
 * The component's render half: the `card` element it builds plus everything the
 * component returns, from the `copyable` verdict to the end of the file (the
 * component is the last declaration in the module).
 *
 * The slice starts one statement above `return (` on purpose: the portaled card
 * element — `cc.hoverCard`, `data-chamber-hovercard` — is built there, and a
 * mutant that stops rendering has to delete this whole region, which is exactly
 * what the assertions over it exist to catch.
 * @param text - comment-stripped component source.
 * @returns the render half of the component.
 */
function renderHalfOf(text: string): string {
  const start = text.indexOf('const copyable = ')
  assert.notEqual(start, -1, 'the render half must start at the copyable verdict')
  const half = text.slice(start)
  assert.ok(half.includes('return ('), 'the render half must include the returned JSX')
  return half
}

/** The two `<RowHoverCard …/>` elements `ServerSection` renders, by anchor. */
function callSites(): { workspace: string; session: string } {
  const calls = serverSection.match(/<RowHoverCard[\s\S]*?\/>/g) ?? []
  assert.equal(calls.length, 2, 'the workspace header and the session row must both be wrapped')
  const workspace = calls.find(block => block.includes('anchor={workspaceHeader}'))
  const session = calls.find(block => block.includes('anchor={sessionRow}'))
  assert.notEqual(workspace, undefined, 'workspace header card missing')
  assert.notEqual(session, undefined, 'session row card missing')
  return { workspace: normalize(workspace ?? ''), session: normalize(session ?? '') }
}

test('both row kinds render the chamber-owned RowHoverCard instead of the vendored HoverCard', () => {
  assert.equal(
    serverSection.includes('HoverCard,'),
    false,
    'ServerSection must not import the vendored HoverCard any more (its open/close pair strands a card; see shared/hover-intent.ts)',
  )
  assert.match(serverSection, /import \{ RowHoverCard \} from '\.\/RowHoverCard\.tsx'/)
  const { workspace, session } = callSites()
  // Owner gating survives on both cards.
  assert.ok(workspace.includes('disabled={menuOpen[workspaceKey] === true'), 'workspace-card gating must stay')
  assert.ok(session.includes('disabled={menuOpen[sessionKey] === true'), 'session-card gating must stay')
  // The session card is the copyable one: primary value + both labels.
  assert.ok(session.includes('copyText={session.blank === true ? undefined : sessionTitleText}'), 'the session card must copy the session title')
  assert.ok(session.includes("copyLabel={t('action.copy')}"), 'the session copy label must stay threaded')
  assert.ok(session.includes("copiedLabel={t('hover.copied')}"), 'the session copied label must stay threaded')
  // The workspace card is READ-ONLY by design (the projection has no cwd), so a
  // label without a `copyText` could never render: threading them back would be
  // dead, misleading props (DEFECT 5).
  for (const dead of ['copyText', 'copyLabel', 'copiedLabel']) {
    assert.equal(workspace.includes(dead), false, `the workspace header card must not carry the dead \`${dead}\` prop`)
  }
})

test('the component delegates every dwell/grace decision to the intent machine', () => {
  assert.match(rowHoverCard, /import \{ createHoverIntent, HOVER_OPEN_DELAY_MS, type HoverIntent \} from '\.\.\/shared\/hover-intent\.ts'/)
  // The machine's own default is what an omitted prop resolves to; the two-option
  // call is the ONLY construction site (a second one would fork the machine).
  assert.match(hoverIntent, /openDelayMs\?: number/)
  assert.match(hoverIntent, /const openDelayMs = options\.openDelayMs \?\? HOVER_OPEN_DELAY_MS/)
  assert.match(rowHoverCard, /openDelayMs\?: number/)
  assert.match(rowHoverCard, /openDelayMs = HOVER_OPEN_DELAY_MS/)
  assert.match(normalize(rowHoverCard), /createHoverIntent\(\{ disabled, openDelayMs \}\)/)
  assert.equal(
    (rowHoverCard.match(/createHoverIntent\(/g) ?? []).length,
    1,
    'RowHoverCard must create exactly one intent machine',
  )
  // No second, self-committing dwell timer: the vendored defect was exactly
  // this shape (`setTimeout(() => setOpen(true), openDelayMs)`), so its return
  // would silently restore the bug.
  assert.equal(
    /setTimeout\(\(\)\s*=>\s*\{\s*setOpen\(true\)/.test(rowHoverCard.replace(/\s+/g, ' ')),
    false,
    'RowHoverCard must not arm its own open timer — hover-intent.ts owns the decision',
  )
  assert.equal(
    (rowHoverCard.match(/setTimeout\(/g) ?? []).length,
    1,
    'the copy-feedback timer is the only timer the component may own',
  )
  assert.match(normalize(rowHoverCard), /intent\.enter\(\)/)
  assert.match(normalize(rowHoverCard), /intent\.leave\(\)/)
  assert.match(normalize(rowHoverCard), /intent\.press\(\)/)
  assert.match(normalize(rowHoverCard), /intent\.setDisabled\(disabled\)/)
})

test('visibility is READ from the machine, never mirrored into component state', () => {
  // One fact, one owner: a mirrored boolean can be committed in the wrong order
  // against the machine's decision (a press closing while the dwell's open is in
  // flight would then mount a card the machine believes is closed, and every
  // later close would start by checking that stale flag). The store subscription
  // makes React re-check the snapshot after commit instead.
  assert.match(
    normalize(rowHoverCard),
    /const open = useSyncExternalStore\(intent\.subscribe, intent\.isOpen\)/,
    'the card must render from the intent store',
  )
  assert.equal(
    rowHoverCard.includes('setOpen('),
    false,
    'no second copy of the visibility fact may exist in the component',
  )
  assert.equal(
    /\[open, setOpen\]/.test(rowHoverCard),
    false,
    'visibility must not be a useState pair',
  )
  // The component may hold exactly two pieces of state — placement and the copy
  // feedback. A third one is a mirror of something the machine already owns.
  const stateNames = [...rowHoverCard.matchAll(/const \[(\w+), (\w+)\] = useState/g)].map(match => match[1])
  assert.deepEqual(stateNames.sort(), ['copied', 'pos'], 'no hidden state mirror (open/visible/…) may be added')
})

test('the render half renders: handlers, the marked anchor, the portal and the marked card', () => {
  const half = renderHalfOf(rowHoverCard)
  const flat = normalize(half)
  // The anchor drives the machine (the vendored defect was exactly a card that
  // no later pointer event could reach).
  for (const handler of ['onPointerEnter', 'onPointerLeave', 'onPointerDownCapture']) {
    assert.ok(flat.includes(handler), `the anchor must keep its ${handler} handler`)
  }
  assert.ok(flat.includes('data-chamber-hovercard-anchor=""'), 'the anchor must carry its acceptance marker')
  assert.ok(flat.includes('{anchor}'), 'the render half must render the anchor node')
  // The card itself: chrome class, acceptance marker, content, portal.
  assert.ok(flat.includes('cc.hoverCard'), 'the card must use the ported chrome class')
  assert.ok(flat.includes('data-chamber-hovercard=""'), 'the card must carry its acceptance marker')
  assert.ok(flat.includes('{card !== null && createPortal(card, document.body)}'), 'the card must be portaled to body (placement is viewport-fixed)')
  assert.ok(flat.includes('{copied ? <span className={cc.hoverCardCopied} aria-hidden="true">{copiedLabel}</span> : content}'), 'the card body must render the content / copied label')
  // a11y and the copy affordance (role/tabIndex/aria + Enter/Space activation).
  assert.ok(flat.includes('role={copyable ? \'button\' : undefined}'), 'the copyable card must stay a keyboard-reachable button')
  assert.ok(flat.includes('tabIndex={copyable ? 0 : undefined}'))
  assert.ok(flat.includes('aria-label={copyable ?'), 'the copyable card must keep its accessible label')
  assert.ok(flat.includes("if (e.key !== 'Enter' && e.key !== ' ') return"), 'Enter/Space must activate the copy')
  assert.ok(flat.includes('void copy(copyText)'), 'activation must run the clipboard write')
  assert.ok(flat.includes('className={cc.hoverCardStatus} role="status"'), 'the copy announcement must stay a live region')
})

test('the close path bumps the copy epoch (upstream HoverCard close(), DEFECT 1)', () => {
  // `open === false` is the one close funnel (grace close, press, disabled
  // flip); the bump invalidates a clipboard write still in flight when the card
  // closed, so its late continuation cannot paint `copiedLabel` on the next
  // card or arm a stray 1000ms timer.
  const closeEffect = rowHoverCard.match(/useEffect\(\(\) => \{\s*if \(open\) return[\s\S]*?\}, \[open, clearCopied\]\)/)?.[0] ?? ''
  assert.notEqual(closeEffect, '', 'the open→false effect must exist')
  // The ORDER of the bump against `clearCopied()` is deliberately NOT pinned:
  // both statements are synchronous and the pending clipboard continuation is a
  // microtask that cannot interleave them, so "bump after clear" is a
  // behaviourally equivalent mutant (adversarial verifier M5) and forbidding it
  // would be false rigidity. What must hold is that the bump lives in THIS
  // effect — the one funnel every close goes through — and that the feedback is
  // still cleared there.
  const closeBody = normalize(closeEffect)
  assert.ok(
    closeBody.includes('copyEpochRef.current += 1'),
    'the epoch must be bumped inside the close effect every close funnels through',
  )
  assert.ok(closeBody.includes('clearCopied()'), 'the close effect must still clear the copy feedback')
  // The other bump — the unmount cleanup — must stay too (a write settling after
  // unmount must not resurrect a card's feedback).
  const unmountEffect = rowHoverCard.match(/mountedRef\.current = false[\s\S]*?copyEpochRef\.current \+= 1[\s\S]*?intent\.dispose\(\)/)?.[0] ?? ''
  assert.notEqual(unmountEffect, '', 'the unmount cleanup must keep its epoch bump and dispose()')
  // Every decision the late write makes is guarded by the epoch it captured.
  assert.match(
    normalize(rowHoverCard),
    /const accepted = await writeClipboard\(text\)[\s\S]*?if \(!accepted \|\| !mountedRef\.current \|\| copyEpoch !== copyEpochRef\.current \|\| card === null\) return/,
    'the copy continuation must compare the captured epoch before rendering feedback',
  )
})

test('the copy window, the edge margin and the mounted flag are pinned values, not just expressions', () => {
  // The locks above match placement and feedback EXPRESSIONS; these three values
  // survived as mutants in the adversarial verification (§4.1 S1-S3) because no
  // assertion read them.
  // 1s is the upstream feedback dwell: a longer value leaves `copiedLabel` on a
  // card that long ago showed its content again.
  assert.match(rowHoverCard, /const COPY_FEEDBACK_MS = 1000\b/, 'the copied label must clear after exactly 1s, not 100s')
  // 8px is the official atom's viewport edge margin (horizontal clamp): widening
  // it silently shifts every card 32px further from the sidebar.
  assert.match(rowHoverCard, /const EDGE_MARGIN = 8\b/, 'the viewport edge margin must stay the official 8px')
  // The mount effect is what lets a late clipboard continuation paint at all:
  // with `mountedRef.current = true` deleted, a StrictMode cleanup leaves the
  // flag false and the copy feedback never shows in dev.
  assert.match(
    normalize(rowHoverCard),
    /useEffect\(\(\) => \{ mountedRef\.current = true/,
    'the mount effect must mark the card mounted before anything awaits',
  )
  assert.match(normalize(rowHoverCard), /mountedRef\.current = false/, 'the unmount cleanup must clear the mounted flag')
})

test('placement: no top floor, degenerate and off-screen anchors close, layout changes re-place (DEFECT 2)', () => {
  const flat = normalize(rowHoverCard)
  assert.equal(
    /Math\.max\(EDGE_MARGIN, Math\.min\(r\.top/.test(flat),
    false,
    'the invented EDGE_MARGIN top floor must never come back — upstream has none (an anchor above the viewport must not pin the card at y=8)',
  )
  // A degenerate rect is what a row inside a `display: none` ancestor (folded
  // workspace group) or a detached node reports: the origin, which the off-screen
  // test below reads as an on-screen anchor. Without this guard the card stays
  // pinned at the top-left corner with nothing under it (adversarial verifier
  // §3.2, harness: 'degenerate 0×0 anchor stays OPEN at the viewport corner').
  assert.match(
    flat,
    /if \(!Number\.isFinite\(r\.left\) \|\| !Number\.isFinite\(r\.top\) \|\| !Number\.isFinite\(r\.right\) \|\| !Number\.isFinite\(r\.bottom\) \|\| !\(r\.right > r\.left\) \|\| !\(r\.bottom > r\.top\)\) \{ intent\.press\(\) return \}/,
    'a zero-area / non-finite anchor must close the card, never be placed at the origin',
  )
  assert.match(
    flat,
    /if \(r\.bottom < 0 \|\| r\.top > window\.innerHeight \|\| r\.right < 0 \|\| r\.left > window\.innerWidth\) \{ intent\.press\(\) return \}/,
    'an anchor outside the viewport must close the card through the machine, not pin it (both axes — the horizontal arms are defensive symmetry; the vertical pair is the reachable one)',
  )
  // Bottom-clamped like upstream AND floored at the viewport top: a partially
  // visible anchor can leave less room above it than the card is tall, and an
  // unclamped negative `top` would hang the whole card off-screen (the verifier's
  // half-visible case: r=(100,-30,240,20) → top was -30px).
  assert.match(
    flat,
    /const top = Math\.max\(0, Math\.min\(r\.top, window\.innerHeight - card\.offsetHeight - EDGE_MARGIN\)\)/,
    'the vertical placement must clamp to the bottom edge and never go above the viewport top',
  )
  // The horizontal clamp stays (the sidebar sits at the left edge of a possibly
  // narrow window).
  assert.match(flat, /const left = Math\.max\(EDGE_MARGIN, Math\.min\(r\.right \+ ANCHOR_GAP, window\.innerWidth - card\.offsetWidth - EDGE_MARGIN\)\)/)
  // Placement must re-run on layout changes, not only on open/scroll/resize.
  assert.match(flat, /const observer = new ResizeObserver\(place\)/)
  assert.match(flat, /observer\.observe\(wrapper\)/, 'the anchor box must be observed')
  assert.match(flat, /observer\.observe\(container\)/, "the anchor's containing block must be observed (a reflow above moves the row without resizing it)")
  // One cleanup releases everything the effect installed.
  assert.match(
    flat,
    /return \(\) => \{ observer\.disconnect\(\) window\.removeEventListener\('scroll', place, true\) window\.removeEventListener\('resize', place\) \}/,
    'the observer and both listeners must die in the same cleanup',
  )
  // The identity-guarded setPos: placement may not feed itself a render loop.
  assert.match(flat, /setPos\(prev => \(prev !== null && prev\.left === left && prev\.top === top \? prev : \{ left, top \}\)\)/)
  assert.match(flat, /if \(!open\) \{ setPos\(null\); return \}/, 'closing must drop the stale coordinates')
})

test('a press inside the card is exempt from dismissal, so text selection survives the port', () => {
  const press = rowHoverCard.match(/onPointerDownCapture=\{[\s\S]*?\n      \}\}/)?.[0] ?? ''
  assert.notEqual(press, '', 'the anchor press rule must be present')
  assert.ok(
    normalize(press).includes('if (cardRef.current?.contains(e.target as Node)) return'),
    'the card-contained press must return before the intent press()',
  )
})

test('the ported card chrome exists in the sidebar stylesheet (surface, radius, hit-testable card)', () => {
  assert.match(css, /\.hoverCard \{[\s\S]*?position: fixed;/)
  assert.match(css, /\.hoverCard \{[\s\S]*?width: 244px;/)
  assert.match(css, /\.hoverCard \{[\s\S]*?--chamber-hovercard-bg: #2C2C2E;/)
  assert.match(css, /\.hoverAnchor \{[\s\S]*?display: block;/)
})

test('the machine keeps the page-global slot, the blur/hidden dismissal and the hidden-view closer', () => {
  // The exclusivity slot must be page-global (every N-ctx shell mounts its own
  // sidebar tree) — dropping the singleton guard would silently degrade the
  // self-heal to per-shell, which is exactly the case that strands a card while
  // the pointer works in another shell.
  assert.match(hoverIntent, /assertSingletonModule\('hover-intent'\)/)
  assert.match(normalize(hoverIntent), /let visibleCard: \(\(\) => void\) \| null = null/)
  assert.match(normalize(hoverIntent), /visibleCard = dismissSelf/)
  // A boundary event is not guaranteed when the window loses focus with the
  // pointer parked on a row; the visible card must not survive that.
  assert.match(normalize(hoverIntent), /window\.addEventListener\('blur', dismissVisibleCard\)/)
  assert.match(normalize(hoverIntent), /document\.visibilityState === 'hidden'/)
  assert.match(normalize(hoverIntent), /if \(next\) \{ bindDismissWatch\(\) claimSlot\(\) \}/)
  // The external closer the renderer's view-hide path uses: it must reuse the
  // slot (never a second registry) and must be reachable from the package
  // barrel the renderer imports from.
  assert.match(
    normalize(hoverIntent),
    /export function dismissVisibleRowCard\(\): void \{ dismissVisibleCard\(\) \}/,
    'dismissVisibleRowCard must close through the one page slot',
  )
  assert.match(sharedIndex, /export \* from '\.\/hover-intent\.ts'/, 'the shared barrel must re-export the closer the renderer imports')
})
