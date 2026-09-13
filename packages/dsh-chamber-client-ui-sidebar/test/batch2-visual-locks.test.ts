import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/** Comments stripped first, so prose can never satisfy a lock. */
function stripComments(code: string): string {
  let out = ''
  let quote: string | undefined
  let line = false
  let block = false
  for (let i = 0; i < code.length; i += 1) {
    const ch = code[i]
    const next = code[i + 1]
    if (line) { if (ch === '\n') { line = false; out += ch } else out += ' '; continue }
    if (block) { if (ch === '*' && next === '/') { block = false; out += '  '; i += 1 } else out += ch === '\n' ? ch : ' '; continue }
    if (quote !== undefined) {
      out += ch
      if (ch === '\\') { out += next ?? ''; i += 1; continue }
      if (ch === quote) quote = undefined
      continue
    }
    if (ch === '/' && next === '/') { line = true; out += '  '; i += 1; continue }
    if (ch === '/' && next === '*') { block = true; out += '  '; i += 1; continue }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; out += ch; continue }
    out += ch
  }
  return out
}

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

const css = sheet('../src/client/sidebar-chamber.module.css')
const section = stripComments(readFileSync(new URL('../src/client/ServerSection.tsx', import.meta.url), 'utf8'))
const root = stripComments(readFileSync(new URL('../src/client/SidebarRoot.tsx', import.meta.url), 'utf8'))

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

test('P2-B B-2 / G1-4: icon buttons keep their box and row, and carry a 24px hit area', () => {
  // Generalized by stage-3 G1-4: one block now serves every icon button in the
  // sheet, so the assertion moved from the archive-scoped rule to `.actionIcon`.
  pin('G1-4 action icon hit area', css, '.actionIcon::after', {
    content: "''", position: 'absolute', inset: '-2px',
  })
  pin('G1-4 action icon anchor', css, '.actionIcon', { position: 'relative' })
  for (const [selector, inset] of [['.searchButton::after', '-2px'], ['.searchClear::after', '-3px']] as const) {
    pin(`G1-4 ${selector}`, css, selector, { content: "''", position: 'absolute', inset })
  }
  for (const selector of ['.foldToggle::after', '.sourceFoldToggle::after', '.railDotButton::after']) {
    pin(`G1-4 ${selector}`, css, selector, { content: "''", position: 'absolute', inset: '-4px' })
  }
  // A disabled button still hit-tests: the enlarged rim must be switched off, or
  // it would swallow pointer events meant for a neighbour.
  for (const selector of ['.actionIcon:disabled::after', '.searchClear:disabled::after',
    '.foldToggle:disabled::after', '.railDotButton:disabled::after']) {
    pin(`G1-4 ${selector}`, css, selector, { 'pointer-events': 'none' })
  }
  // 24px boxes need a >=4px cluster gap to stay distinct.
  const clusterGap = Number.parseInt(
    decls(rule(css, '.sourceActions')).find(([name]) => name === 'gap')?.[1] ?? '0', 10)
  assert.ok(clusterGap >= 4,
    `the source-header cluster needs >= 4px between two 24px hit boxes (got ${clusterGap}px)`)
  // The row geometry the hit-area overlay must NOT be allowed to change: the row
  // stays content-sized (this 20px button + 5px + 5px padding = 30px), so a later
  // box-growing "fix" has to show up as an explicit height here and fail.
  pin('B-2 row', css, '.archiveManagerRow', { padding: '5px 8px' })
  const row = rule(css, '.archiveManagerRow')
  assert.equal(/(?<![\w-])(?:min-|max-)?height\s*:/.test(row), false, 'the archive row must stay content-sized')
  assertSoleDeclaration(css, '.archiveManagerRow', ['height', 'min-height'])
  assertSoleDeclaration(css, '.archiveManagerRow .actionIconDanger::after', ['inset'])
  // 2026-09 user decision: the row/select-all checkbox carries the dsh business
  // blue, not the official neutral `--dsw-alias-brand-primary` (near-black in the
  // light theme) — the same ruling as the settings page's on/selected states.
  pin('archive checkbox', css, '.archiveManagerCheck', {
    'accent-color': 'var(--dsw-alias-state-business-primary)',
  })
})
