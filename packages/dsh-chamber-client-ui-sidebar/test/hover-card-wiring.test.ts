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
 *     the measured defect this port replaces;
 *  2. the component never re-implements the racy open (a bare `setTimeout` that
 *     commits `open` on its own) — the dwell/grace decisions belong to
 *     `createHoverIntent`;
 *  3. the three interaction rules the official atom defines survive the port:
 *     enter/leave drive the intent, a press outside the card dismisses, and a
 *     press inside the card is left alone so text selection still works.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalize, source, stripComments } from './source-lock.ts'

const serverSection = stripComments(source('../src/client/ServerSection.tsx'))
const hoverIntent = stripComments(source('../src/shared/hover-intent.ts'))
const rowHoverCard = stripComments(source('../src/client/RowHoverCard.tsx'))
const css = source('../src/client/sidebar-chamber.module.css')

test('both row kinds render the chamber-owned RowHoverCard instead of the vendored HoverCard', () => {
  assert.equal(
    serverSection.includes('HoverCard,'),
    false,
    'ServerSection must not import the vendored HoverCard any more (its open/close pair strands a card; see shared/hover-intent.ts)',
  )
  assert.match(serverSection, /import \{ RowHoverCard \} from '\.\/RowHoverCard\.tsx'/)
  const anchors = serverSection.match(/<RowHoverCard\b[\s\S]*?anchor=\{(workspaceHeader|sessionRow)\}/g) ?? []
  assert.equal(anchors.length, 2, 'the workspace header and the session row must both be wrapped')
  assert.ok(anchors.some(block => block.includes('workspaceHeader')), 'workspace header card missing')
  assert.ok(anchors.some(block => block.includes('sessionRow')), 'session row card missing')
  // The card contract the call sites rely on: copy affordance + owner gating.
  assert.ok(normalize(serverSection).includes("copyLabel={t('action.copy')}"), 'copy label must stay threaded')
  assert.ok(normalize(serverSection).includes("copiedLabel={t('hover.copied')}"), 'copied label must stay threaded')
  assert.ok(normalize(serverSection).includes('disabled={menuOpen[sessionKey] === true'), 'session-card gating must stay')
})

test('the component delegates every dwell/grace decision to the intent machine', () => {
  assert.match(rowHoverCard, /import \{ createHoverIntent, type HoverIntent \} from '\.\.\/shared\/hover-intent\.ts'/)
  assert.match(rowHoverCard, /createHoverIntent\(\{ disabled \}\)/)
  // No second, self-committing dwell timer: the vendored defect was exactly
  // this shape (`setTimeout(() => setOpen(true), openDelayMs)`), so its return
  // would silently restore the bug.
  assert.equal(
    /setTimeout\(\(\)\s*=>\s*\{\s*setOpen\(true\)/.test(rowHoverCard.replace(/\s+/g, ' ')),
    false,
    'RowHoverCard must not arm its own open timer — hover-intent.ts owns the decision',
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

test('the machine keeps the page-global slot and the blur/hidden dismissal', () => {
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
})
