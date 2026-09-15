import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripComments } from '../../../../scripts/dev/test-support/source-text.ts'

function sheet(relative: string): string {
  return stripComments(readFileSync(new URL(relative, import.meta.url), 'utf8'))
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\s+/g, ' ')
}

function ruleBodies(flat: string, selector: string): string | undefined {
  const bodies: string[] = []
  for (const match of flat.matchAll(/([^{}]*?)\s*\{([^{}]*)\}/g)) {
    const parts = match[1].split(/,(?![^(]*\))/).map((part) => part.trim())
    // Push the raw contents and re-join with `;`: gluing whole bodies would fuse
    // the previous body's `}` with the next declaration's property name.
    if (parts.includes(selector)) bodies.push(match[2].trim())
  }
  return bodies.length === 0 ? undefined : `{${bodies.join('; ')}}`
}

function rule(flat: string, selector: string): string {
  // Cascade order: EVERY rule whose selector list contains this selector, merged
  // last-wins — a grouped sibling (`.a, .b { … }`) is the same declaration, and a
  // later rule for the same selector must be visible here (not shadowed by the
  // first match). Qualified competitors (`.x .y`, `.y.y`) are rejected separately
  // by assertSoleDeclaration.
  const merged = ruleBodies(flat, selector)
  assert.notEqual(merged, undefined, `${selector} must exist as a selector`)
  return merged as string
}

function decls(body: string): [string, string][] {
  return body.slice(body.indexOf('{') + 1).split(';')
    .map((entry) => entry.trim()).filter((entry) => entry.includes(':'))
    .map((entry) => {
      const at = entry.indexOf(':')
      return [entry.slice(0, at).trim(), entry.slice(at + 1).trim()] as [string, string]
    })
}

const COMPETING: Record<string, RegExp> = {
  border: /^border-(?!radius$)(color|style|width|top|right|bottom|left|block|inline)/,
  padding: /^padding-/,
  margin: /^margin-/,
  'border-radius': /^border-(top|bottom|left|right)-(left|right)-radius$/,
  // A later `border:` shorthand would silently reset the per-side value pinned above.
  'border-top': /^border$/,
  'border-bottom': /^border$/,
  height: /^(?:min|max)-height$/,
  'min-height': /^(?:min-|max-)?height$/,
  // `font:` is the shorthand that resets size/line-height/family alike.
  'font-size': /^font$/,
  'line-height': /^font$/,
  'font-family': /^font$/,
  background: /^background(-color)?$/,
  color: /^color$/,
  inset: /^(?:top|right|bottom|left)$/,
}

/** Every rule in the flat sheet, with at-rule preludes stripped from the selector. */
function allRules(flat: string): { selector: string; body: string }[] {
  return [...flat.matchAll(/([^{}]*)\{([^{}]*)\}/g)].map((match) => ({
    selector: match[1].trim().replace(/^@[a-z-]+[^)]*\)\s*/i, '').trim(),
    body: `{${match[2]}}`,
  }))
}

/**
 * Does this rule selector qualify ours (compound, descendant or sibling)?
 * A pseudo-ELEMENT (`::after`) is a different box, not a competitor.
 */
function mentions(selector: string, target: string): boolean {
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`${escaped}(?![\\w-])(?!::)`).test(selector)
}

/**
 * A MORE SPECIFIC rule (`.a .b`, `.b.b`, `X > .b`, …) would win the cascade while
 * the rule pinned below kept satisfying every assertion — the batch-1 lesson,
 * now checked per pinned property instead of per rule text.
 */
/** A selector list split into its components (commas inside :not(...) kept). */
function selectorParts(selector: string): string[] {
  return selector.split(/,(?![^(]*\))/).map((part) => part.trim()).filter(Boolean)
}

function assertSoleDeclaration(flat: string, selector: string, properties: string[]): void {
  for (const rule of allRules(flat)) {
    // A grouped rule (`.a::after, .b::after { … }`) declares for every component —
    // only a component that QUALIFIES ours without being ours is a competitor.
    const competitors = selectorParts(rule.selector).filter((part) => part !== selector && mentions(part, selector))
    if (competitors.length === 0) continue
    for (const property of properties) {
      // A competing rule may win through the SHORTHAND of the pinned longhand
      // (`font`, `padding-block`, `border`, `inset`), so match the whole family.
      const pattern = COMPETING[property]
      const declared = decls(rule.body).some(([name]) =>
        name === property || (pattern !== undefined && pattern.test(name)))
      assert.equal(declared, false,
        `${competitors.join(', ')} qualifies ${selector} and re-declares ${property} — it wins the cascade`)
    }
  }
}

function pin(item: string, flat: string, selector: string, wanted: Record<string, string>): void {
  const body = rule(flat, selector)
  assertSoleDeclaration(flat, selector, Object.keys(wanted))
  for (const [property, value] of Object.entries(wanted)) {
    const hits = decls(body).filter(([name]) => name === property)
    assert.equal(hits.length > 0 ? hits[hits.length - 1][1] : undefined, value,
      `${item}: ${selector} must effectively declare ${property}: ${value}`)
    const pattern = COMPETING[property]
    if (pattern !== undefined) {
      assert.deepEqual(decls(body).filter(([name]) => name !== property && pattern.test(name)).map(([n, v]) => `${n}: ${v}`), [],
        `${item}: ${selector} must not add a competing ${property} declaration`)
    }
  }
}

const css = sheet('../../src/client/sidebar-chamber.module.css')
const rootCss = sheet('../../src/client/SidebarRoot.module.css')
const section = stripComments(readFileSync(new URL('../../src/client/ServerSection.tsx', import.meta.url), 'utf8'))
const root = stripComments(readFileSync(new URL('../../src/client/SidebarRoot.tsx', import.meta.url), 'utf8'))

test('P2-A: every menu call site uses the primitive compact form (chamber density, v0.2.4)', () => {
  // STATUS「菜单密度 = chamber 档」+ design 06 §7. The official default item is
  // 40px/14px and `dense` is 34px — both sized against upstream's 32px rows, not
  // our 26px ones. `compact` is 26px/12px, i.e. exactly our row height.
  // Site-by-site (not a global line count): a decoy standalone `compact` line
  // elsewhere in the file must not stand in for a real call site.
  const tags = [...section.matchAll(/<Menu\b[\s\S]*?items=/g)].map((match) => match[0])
  assert.equal(tags.length, 3, 'the package renders exactly three menus')
  for (const tag of tags) {
    assert.match(tag, /(?:^|\s)compact(?:\s|$)/, 'every menu must pass compact')
    assert.equal(/\bdense\b/.test(tag), false, 'no menu may use the dense variant')
    assert.match(tag, /(?:^|\s)portal(?:\s|$)/, 'the menus stay portaled')
  }
  for (const tag of tags.slice(1)) {
    assert.match(tag, /align="end"/, 'row menus stay end-aligned')
  }
  assert.equal(/compact/.test(root), false, 'no other menu in this package may opt in')
})

test('P2-B B-1: the todo banner is separated from the list by a 0.5px neutral divider, not a card', () => {
  pin('B-1', css, '.todoArea', {
    'border-bottom': '0.5px solid var(--dsw-alias-border-l2)',
  })
  // Bottom edge only: the strip's upward neighbour is the New Session card, which
  // already draws its own outline (audit finding — no top hairline).
  assert.equal(/border-top\s*:/.test(rule(css, '.todoArea')), false,
    'the banner must not draw a top hairline')
})

test('V1 (v0.2.4 rollback of P2-B B-2 / G1-4): icon buttons keep their visual box and carry no invisible hit rim', () => {
  // 2026-09-14 (user directive 「按照 v0.2.4 恢复」): the stage-3 G1-4 rims are
  // rolled back. They grew every < 24px icon button's hit box with an invisible
  // `::after` (inset -2/-3/-4px); inside a 26px row that rim left 0px of plain
  // row above the button and 1px below (measured: elementFromPoint sweep, row
  // 183-209, kebab hit band 183.5-207.5), so a pointer leaving the row FROM the
  // button produced the native pointerleave chain with no pointerout, React
  // synthesized no onPointerLeave, and the row's hover card stranded. v0.2.4's
  // geometry — the visual box IS the hit box — is what this locks.
  for (const selector of ['.actionIcon', '.searchButton', '.searchClear', '.foldToggle',
    '.sourceFoldToggle', '.railDotButton']) {
    // Parse the declaration instead of substring-matching the text: a rule
    // written `position:relative` (no space) must fail this all the same.
    const body = ruleBodies(css, selector) ?? ''
    assert.equal(
      decls(body).some(([name, value]) => name === 'position' && value === 'relative'),
      false,
      `${selector} must not anchor a hit rim`,
    )
    assert.equal(ruleBodies(css, `${selector}::after`), undefined,
      `${selector} must not carry a hit rim`)
    assert.equal(ruleBodies(css, `${selector}:disabled::after`), undefined,
      `${selector} must not carry the rim's disabled switch`)
  }
  // The rollback did not grow any box to compensate: the visual boxes are the
  // sheet's own sizes, which is what keeps the 26px rows 26px.
  for (const [selector, size] of [['.actionIcon', '20px'], ['.searchButton', '20px'],
    ['.searchClear', '18px'], ['.foldToggle', '16px'], ['.sourceFoldToggle', '16px'],
    ['.railDotButton', '16px']] as const) {
    pin(`V1 ${selector} box`, css, selector, { width: size, height: size })
  }
  // The 2026-09-13 cluster-rhythm revision survives the rollback (its value was
  // set for the user-reported `+`/kebab cluster, not for rims): `.rowActions`
  // stays 4px, as does the footer row's chamber-added rhythm. `.sourceActions`
  // does NOT: its 4px came from the 2026-09 hit-area pass itself (widened so two
  // 24px rims stayed distinct), so the rollback returns it to v0.2.4's 2px.
  pin('V1 source-header cluster', css, '.sourceActions', { gap: '2px' })
  pin('V1 row cluster', css, '.rowActions', { gap: '4px' })
  pin('V1 footer action row', rootCss, '.footerActions', { gap: '4px' })
  // The rail: only the RIM half of the 2026-09 change is rolled back, i.e. the
  // column gap returns to 12px. The `-4px 0` margin STAYS — it is the
  // buttonization compensation (a 16px button box carrying an 8px dot must give
  // its extra 8px back or the dot rhythm loosens), so gap 12px + margins keep
  // the 20px box pitch / 12px visible gap the rail shipped with. Pinning both
  // halves separately is the point: dropping the margin instead of the gap is
  // the mistake this lock exists to catch (it would read as 20px visible gaps).
  pin('V1 rail cluster', css, '.railDots', { gap: '12px' })
  pin('V1 rail button margin', css, '.railDotButton', { margin: '-4px 0' })
  // The row geometry the rollback must NOT be allowed to change: the archive row
  // stays content-sized (this 20px button + 5px + 5px padding = 30px), so a later
  // box-growing "fix" has to show up as an explicit height here and fail.
  pin('B-2 row', css, '.archiveManagerRow', { padding: '5px 8px' })
  const row = rule(css, '.archiveManagerRow')
  assert.equal(/(?<![\w-])(?:min-|max-)?height\s*:/.test(row), false, 'the archive row must stay content-sized')
  assertSoleDeclaration(css, '.archiveManagerRow', ['height', 'min-height'])
  // A re-added rim must fail even when it is SCOPED (`:hover::after`,
  // `.rowActions .actionIcon::after`, a attribute variant …): scan every rule
  // whose selector mentions one of the rolled-back classes, not just the exact
  // `X::after` spelling the loop above checks. `content`/`inset` on any of these
  // classes is the rim signature (none of them has a legitimate pseudo-element).
  const mentionsClass = (selector: string, cls: string): boolean =>
    new RegExp(`${cls.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`).test(selector)
  for (const entry of allRules(css)) {
    for (const cls of ['.actionIcon', '.searchButton', '.searchClear', '.foldToggle',
      '.sourceFoldToggle', '.railDotButton']) {
      if (!mentionsClass(entry.selector, cls)) continue
      assert.equal(
        decls(entry.body).some(([name]) => name === 'content' || name === 'inset'),
        false,
        `${entry.selector} re-adds an invisible hit rim to ${cls}`,
      )
    }
  }
  // 2026-09 user decision: the row/select-all checkbox carries the dsh business
  // blue, not the official neutral `--dsw-alias-brand-primary` (near-black in the
  // light theme) — the same ruling as the settings page's on/selected states.
  pin('archive checkbox', css, '.archiveManagerCheck', {
    'accent-color': 'var(--dsw-alias-state-business-primary)',
  })
})
