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

const css = sheet('../src/client/SettingsShell.module.css')
const segmented = sheet('../src/client/SegmentedControl.module.css')
const shell = stripComments(readFileSync(new URL('../src/client/SettingsShell.tsx', import.meta.url), 'utf8'))

test('P2-A A-4: the server dropdown is chamber density on official chrome', () => {
  // Density = the v0.2.4 release values (7px 10px / 13px / explicit 18px line
  // box); chrome = what batch 1 E4 won from the official Menu (item r10, list r20).
  pin('A-4 item', css, '.dropdownItem', {
    padding: '7px 10px',
    'font-size': '13px',
    'line-height': '18px',
    'border-radius': '10px',
  })
  // Spacing-insensitive, and the rule must not carry ANY box height: a uniform
  // `min-height: 40px` (the official default item) would otherwise slip through.
  assert.equal(/\bmin-height\s*:\s*34px/.test(css), false, 'the official dense min-height must stay gone')
  assert.equal(/(?<![\w-])(?:min-|max-)?height\s*:/.test(rule(css, '.dropdownItem')), false,
    'the dropdown item must stay content-sized (no dense/default floor)')
  // …and no competitor rule may impose one either (min/max included).
  assertSoleDeclaration(css, '.dropdownItem', ['height', 'min-height'])
  pin('A-4 list', css, '.dropdownList', { 'border-radius': '20px' })
})

test('P2-B B-3/B-4: every "on" state uses the official neutral, at chamber geometry', () => {
  pin('B-3 checkbox', css, '.generalCardCheck', { 'accent-color': 'var(--dsw-alias-brand-primary)' })
  pin('B-4 segmented thumb', segmented, '.thumb', { background: 'var(--dsw-alias-brand-primary)' })
  // Geometry must stay chamber's (the cancelled E3-C enlargement).
  pin('B-4 geometry', segmented, '.segment span', {
    height: '26px', 'font-size': '12px', 'line-height': '18px',
  })
})

test('P2-B B-5/B-5b: official header alignment (at chamber height) and the official Button', () => {
  // The official padding (20px 14px 8px 10px) is composed for the official 26px
  // content row; our close control is 28px, so that padding would grow the header
  // 54 -> 56px. We pin OUR padding + the official alignment instead.
  pin('B-5 header', css, '.header', { padding: '12px 14px 10px', 'align-items': 'flex-start' })
  assert.equal(/align-items:\s*center/.test(rule(css, '.header')), false, 'the header must not go back to centred')
  // The last self-drawn action is gone: the primitive owns the button chrome.
  assert.ok(shell.includes('<Button'), 'the connections action must be the official Button')
  assert.ok(shell.includes('variant="outline"'), 'it must use the outline variant')
  pin('B-5b layout-only class', css, '.inlineAction', { 'margin-top': '8px', 'align-self': 'flex-start' })
  assert.equal(rule(css, '.inlineAction').includes('border'), false, 'the class must not re-draw a button chrome')
  assert.equal(rule(css, '.inlineAction').includes('padding'), false, 'the class must not re-draw a button chrome')
})
