/**
 * Frame slot declaration lock (design 06, workspace W15): the fork's `root`
 * registration declares its child seats and its SlotMap mirror must state the
 * same spec. `shell.leading` is mounted by the vendor AppFrame only while the
 * darwin collapse hides the sidebar column entirely; `shell.bottom` (added by
 * the pinned vendor AppFrame) is mounted unconditionally and hosts the Developer
 * Tools bottom panel. The vendor AppFrame resolves through the loose repo
 * ambient seam (`(props: any) => any`), so a missing declaration is NOT a type
 * error: at render the frame's bound renderSlot throws
 * `SlotOwnershipError: slot '...' is not declared by this entry's children`.
 * These source-text locks are the automatic net for that failure.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import type { SlotMap } from '@deepseek-ai/dsh-client-ui-slots'
import { stripComments } from '../../../scripts/dev/test-support/source-text.ts'

const source = readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8')

// Compile-time lock: the SlotMap merge must carry the seat spec (a missing or
// renamed member fails the package typecheck here, not at a consumer).
const leadingSpec: SlotMap['shell.leading'] = { kind: 'single', scope: 'root' }
// Compile-time lock for the bottom seat the pinned vendor AppFrame renders unconditionally.
const bottomSpec: SlotMap['shell.bottom'] = { kind: 'single', scope: 'root' }

test('the SlotMap mirror declares the frame leading seat spec', () => {
  // Parse the REAL declaration instead of comparing a literal to itself: the
  // typed const above is the compile-time arm, this is the source arm.
  const code = stripComments(source)
  const mirrorAt = code.indexOf('interface SlotMap {')
  assert.notEqual(mirrorAt, -1, 'src/client/index.ts declares the SlotMap augmentation')
  const memberAt = code.indexOf("'shell.leading'", mirrorAt)
  assert.notEqual(memberAt, -1, 'the SlotMap mirror declares shell.leading')
  const member = /\{\s*kind:\s*'([^']+)';\s*scope:\s*'([^']+)'\s*\}/u.exec(code.slice(memberAt))
  assert.ok(member !== null, 'the mirror member carries a kind/scope spec')
  assert.deepEqual({ kind: member[1], scope: member[2] }, leadingSpec)
})

test('the root registration declares the frame leading seat as its child', () => {
  const code = stripComments(source)
  const childrenAt = code.indexOf('children: {')
  assert.notEqual(childrenAt, -1, 'the root registration declares its children')
  const registration = code.slice(childrenAt, code.indexOf('}, AppFrame)', childrenAt))
  assert.match(registration, /'shell\.leading': \{ kind: 'single', scope: 'root' \},/)
  assert.match(registration, /'shell\.overlay': \{ kind: 'list', scope: 'root' \},/)
})

test('the SlotMap mirror declares the frame bottom seat spec', () => {
  const code = stripComments(source)
  const mirrorAt = code.indexOf('interface SlotMap {')
  assert.notEqual(mirrorAt, -1, 'src/client/index.ts declares the SlotMap augmentation')
  const memberAt = code.indexOf("'shell.bottom'", mirrorAt)
  assert.notEqual(memberAt, -1, 'the SlotMap mirror declares shell.bottom')
  const member = /\{\s*kind:\s*'([^']+)';\s*scope:\s*'([^']+)'\s*\}/u.exec(code.slice(memberAt))
  assert.ok(member !== null, 'the mirror member carries a kind/scope spec')
  assert.deepEqual({ kind: member[1], scope: member[2] }, bottomSpec)
})

test('the root registration declares the frame bottom seat as its child', () => {
  const code = stripComments(source)
  const childrenAt = code.indexOf('children: {')
  assert.notEqual(childrenAt, -1, 'the root registration declares its children')
  const registration = code.slice(childrenAt, code.indexOf('}, AppFrame)', childrenAt))
  assert.match(registration, /'shell\.bottom': \{ kind: 'single', scope: 'root' \},/)
})

/** Pinned vendor frame sources (the frame our registration renders). */
const VENDOR_FRAME_DIR = new URL('../../../vendor/harness-checkout/packages/client/ui-layout/src/client/', import.meta.url)

/** The `{ … }` block opened after the first occurrence of `start`, comments already stripped. */
const bracedBlock = (text: string, start: string): string => {
  const from = text.indexOf(start)
  assert.notEqual(from, -1, 'source carries ' + start)
  const open = text.indexOf('{', from)
  assert.notEqual(open, -1, start + ' opens a block')
  let depth = 0
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === '{') depth += 1
    else if (text[index] === '}') {
      depth -= 1
      if (depth === 0) return text.slice(open, index + 1)
    }
  }
  assert.fail(start + ' block is unterminated')
}

/**
 * Frame store wiring (design 06 §13): the frame's `layoutInfo.rightbarInstant` is only
 * meaningful if the AppFrame reads THIS fork's store instance — the registration's
 * `store` share. The vendor-source locks above never prove that: reverting the import to
 * the vendor store, or dropping `store,` from the registration, leaves them all green
 * while the fork's rightbarInstant never reaches the frame. Pin the two wiring edges.
 */
test('the frame consumes the fork layout store instance, not the vendor store', () => {
  const code = stripComments(source)
  assert.match(code, /import \{[^}]*\bcreateLayoutStore\b[^}]*\} from '\.\/stores\.ts'/u,
    'createLayoutStore must come from the fork ./stores.ts (the frame must consume the fork store, whose rightbarInstant also covers docked open/close)')
  const registration = bracedBlock(code, 'ctx.slots.register({')
  assert.match(registration, /^\s*store,$/mu,
    'the root registration must pass the fork store instance to the frame')
})

/** Every `'key': { kind: '…', scope: '…' }` spec in one declaration block. */
const specsIn = (block: string): Array<{ key: string; kind: string; scope: string }> =>
  [...block.matchAll(/'([^']+)':\s*\{\s*kind:\s*'(single|keyed|list|chain)'\s*[,;]\s*scope:\s*'([a-z-]+)'/gu)]
    .map((match) => ({ key: match[1] as string, kind: match[2] as string, scope: match[3] as string }))

/**
 * Cross-lock against the pinned vendor frame (design 06). The two locks above
 * catch a renamed or moved seat; this one catches a NEW unconditional seat the
 * frame starts rendering — a failure that reaches the browser as a
 * SlotOwnershipError on the first frame render, because the loose ambient
 * AppFrame face (`(props: any) => any`) gives typecheck nothing to see. It
 * derives the vendor frame's renderSlot keys, the vendor registration's
 * children, our registration children and our SlotMap mirror; all four must
 * agree on key and spec.
 */
test('the pinned vendor frame renderSlot keys, children table and our registration agree', () => {
  const vendorIndex = stripComments(readFileSync(new URL('index.ts', VENDOR_FRAME_DIR), 'utf8'))
  const vendorFrame = stripComments(readFileSync(new URL('AppFrame.tsx', VENDOR_FRAME_DIR), 'utf8'))
  const own = stripComments(source)
  const vendorChildren = specsIn(bracedBlock(vendorIndex, 'children: {'))
  const vendorRendered = [...new Set([...vendorFrame.matchAll(/renderSlot\(\s*'([^']+)'/gu)].map((match) => match[1] as string))].sort()
  const ownChildren = specsIn(bracedBlock(own, 'children: {'))
  const ownMirror = specsIn(bracedBlock(own, 'interface SlotMap {'))
  // A key the extractor cannot see would silently shrink both sides of the comparison.
  const specOccurrences = (block: string): number => (block.match(/:\s*\{\s*kind:\s*'/gu) ?? []).length
  assert.equal(vendorChildren.length, specOccurrences(bracedBlock(vendorIndex, 'children: {')),
    'every vendor children entry must be extracted: an unextractable key would hide a new seat')
  assert.equal(ownChildren.length, specOccurrences(bracedBlock(own, 'children: {')),
    'every own children entry must be extracted')
  assert.equal(ownMirror.length, specOccurrences(bracedBlock(own, 'interface SlotMap {')),
    'every SlotMap mirror entry must be extracted')
  assert.ok(vendorChildren.length >= 6 && vendorRendered.length >= 6 && ownChildren.length >= 6,
    'the locks must extract non-empty sets (vendor children ' + vendorChildren.length
    + ', rendered ' + vendorRendered.length + ', own ' + ownChildren.length + ')')
  assert.deepEqual(vendorRendered, vendorChildren.map((entry) => entry.key).sort(),
    'the vendor AppFrame renderSlot set differs from the vendor registration children set')
  for (const key of vendorRendered) {
    const vendorSpec = vendorChildren.find((entry) => entry.key === key)
    assert.ok(vendorSpec !== undefined, 'the vendor registration lacks the rendered seat ' + key)
    for (const [label, list] of [['registration children', ownChildren], ['SlotMap mirror', ownMirror]] as const) {
      const ownSpec = list.find((entry) => entry.key === key)
      assert.ok(ownSpec !== undefined, 'our ' + label + ' does not declare the seat the pinned frame renders: ' + key)
      assert.deepEqual({ kind: ownSpec.kind, scope: ownSpec.scope }, { kind: vendorSpec.kind, scope: vendorSpec.scope },
        'spec drift for ' + key + ' in the ' + label)
    }
  }
  // Negative control: the extractor must see keys with hyphens and camel case
  // (the first revision's [a-z][a-z.]* class silently dropped both), and a
  // missing key must stay visible to the arms above.
  const fixture = specsIn("{ 'shell.top-2': { kind: 'single'; scope: 'root' }, 'shell.topBar': { kind: 'list', scope: 'root' } }")
  assert.deepEqual(fixture.map((entry) => entry.key).sort(), ['shell.top-2', 'shell.topBar'],
    'negative control: hyphen/camel keys must be extracted')
  assert.deepEqual(fixture.map((entry) => entry.key).filter((key) => !['shell.top-2'].includes(key)), ['shell.topBar'],
    'negative control: a missing key must be visible')
  assert.equal(fixture.length, specOccurrences("{ 'shell.top-2': { kind: 'single'; scope: 'root' }, 'shell.topBar': { kind: 'list'; scope: 'root' } }"),
    'negative control: the count arm must see every fixture entry')
})

test('the pinned frame consumes rightbarInstant as the docked-track transition suppressor', () => {
  // The store flag is only worth anything if the pinned vendor frame actually maps it
  // to `transition: none` on the frame that carries the eased `grid-template-columns`.
  // These are source-text locks on the vendored frame (pin drift fails visibly here).
  const vendorFrame = stripComments(readFileSync(new URL('AppFrame.tsx', VENDOR_FRAME_DIR), 'utf8'))
  assert.match(vendorFrame, /data-rightbar-instant=\{layoutInfo\.rightbarInstant \|\| undefined\}/u)
  const vendorCss = stripComments(readFileSync(new URL('AppFrame.module.css', VENDOR_FRAME_DIR), 'utf8'))
  // The transition the chamber store suppresses: the eased center-column track.
  const eased = bracedBlock(vendorCss, '.frame[data-animating]')
  assert.match(eased, /transition:\s*grid-template-columns/u)
  // The suppression arm: the instant attribute turns the frame and its handle off.
  const instant = bracedBlock(vendorCss, '.frame[data-rightbar-instant]')
  assert.match(instant, /transition:\s*none/u)
  assert.match(vendorCss, /\.frame\[data-rightbar-instant\] \.handle/u)
  // The bare selector must carry the arm: keeping only the `.handle` arm would still pass
  // bracedBlock above but leave the frame track's 300ms transition easing.
  assert.match(vendorCss, /\.frame\[data-rightbar-instant\]\s*[,{]/u)
  // The bare selector must reach the transition:none block, not an empty decoy rule.
  assert.match(vendorCss, /\.frame\[data-rightbar-instant\][^{}]*\{[^}]*transition:\s*none/u)
  assert.doesNotMatch(vendorCss, /\.frame\[data-rightbar-instant\]\s*\{\s*\}/u, 'empty bare rule would let the track keep easing')
  // Every rule whose selector mentions the arm must suppress the transition; a later
  // equal-specificity rule would win the cascade and resurrect the eased track.
  const instantRules = [...vendorCss.matchAll(/[^{}]*\.frame\[data-rightbar-instant\][^{}]*\{([^}]*)\}/gu)]
  assert.ok(instantRules.length > 0)
  assert.ok(instantRules.some((match) => /transition:\s*none/u.test(match[1])))
  for (const match of instantRules) {
    if (/transition\s*:/u.test(match[1])) assert.match(match[1], /transition:\s*none/u)
  }
  // The instant arm must win the cascade: equal specificity means source order decides.
  // First-occurrence indexOf is NOT enough: a pin upgrade may append ANOTHER
  // `.frame[data-animating]` rule after the instant block — same specificity, later in
  // source order — which wins the cascade and resurrects the eased track while the old
  // first-occurrence check stayed green. Compare every eased animating rule instead.
  const firstInstantAt = Math.min(...instantRules.map((match) => match.index ?? Number.MAX_SAFE_INTEGER))
  assert.ok(Number.isFinite(firstInstantAt), 'the instant rule set must carry a source position')
  const animatingRules = [...vendorCss.matchAll(/[^{}]*\.frame\[data-animating\][^{}]*\{([^}]*)\}/gu)]
  assert.ok(animatingRules.length >= 3,
    'every animated-track mention must be extracted (base track, handle arm, reduced motion)')
  /** Every `transition` value declared by one rule body (`none` = a pure suppressor). */
  const transitionValues = (body: string): string[] =>
    [...body.matchAll(/transition\s*:\s*([^;]+)/gu)].map((match) => (match[1] as string).trim())
  // (1) Every animating rule that declares a transition other than `none` must precede the
  // instant block — this covers the base `.frame[data-animating]` track AND its `.handle` arm,
  // so a later equal-specificity easing rule can never win the cascade.
  const easingRules = animatingRules.filter((match) =>
    transitionValues(match[1]).some((value) => value !== 'none'))
  assert.ok(easingRules.length >= 2,
    'the base track and its handle arm both ease; the lock must see both (' + easingRules.length + ')')
  for (const match of easingRules) {
    const selector = match[0].slice(0, match[0].indexOf('{')).trim().replace(/\s+/gu, ' ')
    assert.ok((match.index ?? -1) < firstInstantAt,
      'an eased animating rule must precede the instant suppressor: ' + selector
      + ' @ ' + match.index + ' is not < ' + firstInstantAt)
  }
  // (2) No animating rule AFTER the instant block may re-enable a transition; the only
  // legal tail is suppression (the pinned CSS keeps the reduced-motion handle suppressor
  // after the instant block). A new post-instant `transition: …` rule fails here even
  // when it escapes the easing-rule scan above.
  for (const match of animatingRules.filter((rule) => (rule.index ?? -1) > firstInstantAt)) {
    for (const value of transitionValues(match[1])) {
      assert.equal(value, 'none',
        'an animating rule after the instant suppressor must only suppress, never re-enable, a transition')
    }
  }
  assert.doesNotMatch(instant, /!important/u, 'the suppression must win by source order, not !important')
})
