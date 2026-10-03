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
