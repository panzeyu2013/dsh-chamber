/**
 * 2026-09 "batch 1 — pure visual consistency" locks.
 *
 * The batch moved a set of hand-picked values onto the official dsh 0.1.5-rc.1
 * counterpart (or onto the plugin's own row language). Every lock names the
 * official reference it copies, so a future vendor pin bump can re-check the
 * claim instead of guessing — the same duty as `upstream-alignment.test.ts`.
 *
 * These are SOURCE-TEXT locks (comments are stripped first, so no lock can be
 * satisfied by prose): the components value-import React and the dsh client
 * packages and cannot be imported by a plain `node test/…` run.
 *
 * Three mechanics keep the locks from passing for the wrong reason (all three
 * were proven necessary by mutation runs on copies of these sources):
 *   - `rule()` matches a WHOLE selector list, so a decoy compound rule
 *     (`.archiveManagerRowList .archiveManagerRow{…}` earlier in the file)
 *     cannot be mistaken for the base rule;
 *   - `pin()` asserts the EFFECTIVE declaration (last one wins) and rejects a
 *     competing longhand, so appending `margin-top: 2px` after `margin: 0`
 *     cannot slip through as "the pinned value is still present";
 *   - `rotationSelectors()` walks the whole sheet (at-rules included) and only
 *     the known chevron/keyframe rules may transform anything, so re-rotating
 *     the kebab under a new class name or inside `@media` is caught too.
 *
 * Coverage: the sidebar's 9 batch-1 ids (A1, A8, A8b, A10, A11, A12, B3, C2,
 * D2/D3) are locked here. E1 / E4 / F1 / F2 / G1 / G3 / H2 are NOT locked yet —
 * they live in four other packages whose test trees have no source locks for
 * this batch; treat the audit record as their only pin until per-package locks
 * land. Deliberately NOT locked: values the batch left as chamber decisions
 * (session-title 13/18, 26px session rows, trailing state slot).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalize, source, stripComments } from './source-lock.ts'

const css = stripComments(source('../src/client/sidebar-chamber.module.css'))
const section = stripComments(source('../src/client/ServerSection.tsx'))
const flat = normalize(css)

/** One rule's declarations, comment-free and whitespace-collapsed. */
function ruleBodies(selector: string): string | undefined {
  const bodies: string[] = []
  for (const match of flat.matchAll(/([^{}]*?)\s*\{([^{}]*)\}/g)) {
    const parts = match[1].split(/,(?![^(]*\))/).map((part) => part.trim())
    // Push the raw contents and re-join with `;`: gluing whole bodies would fuse
    // the previous body's `}` with the next declaration's property name.
    if (parts.includes(selector)) bodies.push(match[2].trim())
  }
  return bodies.length === 0 ? undefined : `{${bodies.join('; ')}}`
}

function rule(selector: string): string {
  // Cascade order: EVERY rule whose selector list contains this selector, merged
  // last-wins (see the batch-2 lock for the long form of this rationale).
  const merged = ruleBodies(selector)
  assert.notEqual(merged, undefined, `${selector} must exist as a selector`)
  return merged as string
}

/** Declarations of a rule body, in source order. */
function decls(body: string): [string, string][] {
  // `rule()` returns the body starting at `{`; drop it, or a single-declaration
  // rule reports its property as `"{ color"` (a mutation-proven false pass).
  return body
    .slice(body.indexOf('{') + 1)
    .split(';')
    .map((entry) => entry.trim())
    .filter((entry) => entry.includes(':'))
    .map((entry) => {
      const at = entry.indexOf(':')
      return [entry.slice(0, at).trim(), entry.slice(at + 1).trim()] as [string, string]
    })
}

/** The declaration a browser would use (last one wins). */
function effective(body: string, property: string): string | undefined {
  const hits = decls(body).filter(([name]) => name === property)
  return hits.length > 0 ? hits[hits.length - 1][1] : undefined
}

/**
 * Properties that would compete with a pinned shorthand. An explicit table
 * because a prefix test is wrong in both directions: `border-radius` is NOT a
 * sub-property of the `border` shorthand, while `min-height` competes with
 * `height` without sharing its prefix.
 */
const COMPETING: Record<string, RegExp> = {
  border: /^border-(?!radius$)(color|style|width|top|right|bottom|left|block|inline)/,
  padding: /^padding-/,
  margin: /^margin-/,
  height: /^(?:min|max)-height$/,
  width: /^(?:min|max)-width$/,
}

/** Competing declarations for a pinned property (empty when it has no family). */
function competing(body: string, property: string): string[] {
  const pattern = COMPETING[property]
  if (pattern === undefined) return []
  return decls(body)
    .filter(([name]) => pattern.test(name))
    .map(([name, value]) => `${name}: ${value}`)
}

/**
 * Pin a rule's effective values. Rejects a competing longhand for every pinned
 * shorthand, so "pinned declaration present but overridden later" fails.
 */
function pin(item: string, selector: string, wanted: Record<string, string>): void {
  const body = rule(selector)
  for (const [property, value] of Object.entries(wanted)) {
    assert.equal(effective(body, property), value, `${item}: ${selector} must effectively declare ${property}: ${value}`)
    assert.deepEqual(competing(body, property), [], `${item}: ${selector} must not add a competing ${property} declaration`)
  }
}

/** The `color:` declarations of a rule body (hyphenated properties excluded). */
function colorDecls(body: string): string[] {
  return body.match(/(?<![-\w])color\s*:[^;]*;/g) ?? []
}

/**
 * Every rule whose SELECTOR mentions the token — used to catch a second,
 * compound rule that quietly re-declares what the base rule just fixed (a
 * `.sessionActive .sessionTitle { color: … }` passes a base-rule-only lock).
 */
function rulesMentioning(token: string): string[] {
  return flat
    .split('}')
    .filter((block) => block.includes('{'))
    .filter((block) => block.slice(0, block.indexOf('{')).includes(token))
}

/**
 * Selectors of every rule that transforms anything, at-rule nesting included:
 * walking back from each occurrence to the nearest `{` finds the innermost
 * prelude (`@media(…){.a>svg{transform:…}}` resolves to `.a>svg`).
 */
function rotationSelectors(): string[] {
  const found = new Set<string>()
  for (const match of flat.matchAll(/transform\s*:|rotate\(/g)) {
    const index = match.index ?? 0
    const open = flat.lastIndexOf('{', index)
    const previous = flat.lastIndexOf('}', index)
    if (open <= previous) continue
    const prelude = flat.slice(previous + 1, open).trim()
    found.add(prelude.slice(prelude.lastIndexOf('{') + 1).trim())
  }
  return [...found]
}

/** The only rules allowed to rotate: the fold chevrons and the spinner keyframes. */
const ROTATION_ALLOWLIST = new Set([
  'to',
  'from',
  '.foldChevron',
  '.foldToggleFolded',
  '.foldToggleFolded .foldChevron',
  '.sourceFoldChevron',
  '.sourceFoldToggleFolded .sourceFoldChevron',
])

test('A1: session titles carry the official primary ink, and the hover override is gone', () => {
  // Official Rows: `.sessionRow{color:label-primary}` + `.title{font-size:14px}`
  // with no colour override — a title never dims to secondary.
  pin('A1', '.sessionTitle', { color: 'var(--dsw-alias-label-primary)' })
  assert.deepEqual(
    colorDecls(rule('.sessionTitle')),
    ['color: var(--dsw-alias-label-primary);'],
    'the title rule declares exactly one ink, the official primary',
  )
  assert.equal(
    css.includes('.sessionRow:hover .sessionTitle'),
    false,
    'the now-dead hover colour override must stay deleted',
  )
  // A compound selector (current row, hover variant, …) re-dimming the title
  // must fail too — scanning only the base rule would miss it.
  for (const block of rulesMentioning('sessionTitle')) {
    const selector = block.slice(0, block.indexOf('{')).trim()
    assert.equal(block.includes('label-secondary'), false, `no rule touching .sessionTitle may dim it: ${selector}`)
    const inks = colorDecls(block)
    if (inks.length > 0) {
      assert.deepEqual(inks, ['color: var(--dsw-alias-label-primary);'], `a .sessionTitle ink may only be primary: ${selector}`)
    }
  }
  // A1 knock-on: the todo strip mirrors the list rows, so it is primary too.
  pin('A1 knock-on', '.todoRow', { color: 'var(--dsw-alias-label-primary)' })
  // …and so does the search-result title (a session title in the result list):
  // the follow-up pass closed the last resting-secondary title.
  pin('A1 search result', '.searchResultTitle', { color: 'var(--dsw-alias-label-primary)' })
  assert.equal(
    css.includes('.searchResultRow:hover .searchResultTitle'),
    false,
    'the search-result hover ink override must stay deleted too',
  )
})

test('A8/A8b: the kebab is the official horizontal 16px glyph, cluster gap 12px', () => {
  // Official Rows: `<IconEllipsisOutline16/>` (default 16, no rotation) inside a
  // 16px `.iconButton`; the chamber keeps its 20px hit box (option C).
  const sites = section.match(/<IconEllipsisOutline16 size=\{16\} \/>/g) ?? []
  assert.equal(sites.length, 2, 'both kebab sites (workspace header + session row) render the 16px glyph')
  assert.equal(section.match(/<IconEllipsisOutline16/g)?.length, 2, 'no third kebab may appear with other props')
  assert.ok(
    section.includes('toggleMenu(workspaceKey)') && section.includes('toggleMenu(sessionKey)'),
    'the two glyphs stay on their own anchors (workspace header vs session row)',
  )
  assert.equal(section.includes('verticalDots'), false, 'no render site may rotate the glyph again')
  assert.equal(css.includes('.verticalDots'), false, 'the retired rotation rule must stay deleted')
  // A re-rotation could come back under a new name, in another rule, or nested
  // in an at-rule: the sheet-wide scan allows only the chevron/keyframe rules.
  assert.equal(/rotate/i.test(section), false, 'no JSX-side rotation may come back')
  for (const selector of rotationSelectors()) {
    assert.ok(ROTATION_ALLOWLIST.has(selector), `only chevrons/keyframes may transform, found: ${selector}`)
  }
  pin('A8b', '.rowActions', { gap: '12px' })
  pin('A8 (option C)', '.actionIcon', { width: '20px' })
})

test('A10: the overflow disclosure wears the official overflow-button geometry', () => {
  // Official WorkspaceBrowser `.sessionOverflowButton`: 28px / r8 /
  // `0 12px 0 28px` / 12px / hover label-secondary (chamber uses a 26px inset to
  // line up with its own title column, and its own 18px line-height — upstream
  // declares none).
  pin('A10', '.sessionRowsMore', {
    height: '28px',
    padding: '0 12px 0 26px',
    'border-radius': '8px',
    'font-size': '12px',
    'line-height': '18px',
  })
  pin('A10 hover', '.sessionRowsMore:hover', { color: 'var(--dsw-alias-label-secondary)' })
})

test('A11: the in-row rename field is the official renameInput (14/20, r4, 0 2px)', () => {
  pin('A11', '.inlineInput', {
    border: '0.5px solid var(--dsw-alias-border-l4)',
    'border-radius': '4px',
    padding: '0 2px',
    'font-size': '14px',
    'line-height': '20px',
  })
  // The ≈1px edit-height claim in design 06 rests on BOTH rename surfaces using
  // this class (session row + workspace header).
  assert.ok(
    (section.match(/cc\.inlineInput/g) ?? []).length >= 1,
    'the rename surface must actually use .inlineInput',
  )
})

test('A12/B3: empty, failure and search-status copy use the official metrics', () => {
  pin('A12 empty', '.empty', { padding: '8px' })
  pin('A12 failure', '.rowError', { 'line-height': '18px' })
  pin('A12 source note', '.sourceNote', { 'line-height': '18px' })
  pin('B3 status', '.searchStatus', { padding: '10px 12px', 'line-height': '18px' })
  // Official puts status and warning in ONE rule (warning only overrides the
  // ink), so the failure banner must keep the same box after the B3 pass.
  pin('B3 warning', '.searchWarning', { padding: '10px 12px', 'line-height': '18px' })
})

test('C2: the todo strip steps at the session rows\' 28px and its count is 12px', () => {
  pin('C2 count', '.todoCount', { 'font-size': '12px' })
  // 26px height + the container's 2px flex gap = the list's 28px pitch; the
  // toggle is a block-level SIBLING of .todoRows, so its own 2px margin is what
  // keeps the tail step at 28px.
  pin('C2 row', '.todoRow', { height: '26px', margin: '0' })
  pin('C2 toggle', '.todoMore', { height: '26px', margin: '2px 0' })
  pin('C2 container', '.todoRows', { gap: '2px' })
})

test('D2/D3: archive rows use the nav r8 language and no fractional type', () => {
  pin('D2 row', '.archiveManagerRow', { 'border-radius': '8px' })
  pin('D2 group header', '.archiveManagerGroupHeader', { 'border-radius': '8px' })
  assert.equal(css.includes('11.5px'), false, 'the 11.5px path column is gone')
  assert.equal(css.includes('12.5px'), false, 'the 12.5px note family is gone')
  pin('D3 path', '.archiveManagerRowPath', { 'font-size': '12px' })
})
