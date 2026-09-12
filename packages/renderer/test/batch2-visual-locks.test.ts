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

/** One sheet as flat text, comments (TS and, for a CSS-in-template source, CSS) gone. */
function sheet(relative: string): string {
  return stripComments(readFileSync(new URL(relative, import.meta.url), 'utf8'))
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\s+/g, ' ')
}

/** Every rule in the flat sheet, with at-rule preludes stripped from the selector. */
function allRules(flat: string): { selector: string; body: string }[] {
  return [...flat.matchAll(/([^{}]*)\{([^{}]*)\}/g)].map((match) => ({
    selector: match[1].trim().replace(/^@[a-z-]+[^)]*\)\s*/i, '').trim(),
    body: `{${match[2]}}`,
  }))
}

/** A rule selector that qualifies `target` (compound/descendant) — not a pseudo-element. */
function mentions(selector: string, target: string): boolean {
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // BOTH sides of the match are fenced, so `target` has to be a type selector:
  // with a trailing-only guard, an unrelated chamber class name matches — the
  // boot-gap banner's `.boot-gap-body` (and any class ending in `body`, e.g.
  // `.somebody`) reads as "this rule qualifies the body element".
  return new RegExp(`(?<![\\w-])${escaped}(?![\\w-])(?!::)`).test(selector)
}

/**
 * `body` must be the ONLY rule that sets the shell's type: a later `body { … }`
 * (caught by `ruleExact`'s uniqueness in the sheet below? no — that one only sees
 * the first match) or a `html body` / `.shell body` override would win silently.
 */
/** A selector list split into its components (commas inside :not(...) kept). */
function selectorParts(selector: string): string[] {
  return selector.split(/,(?![^(]*\))/).map((part) => part.trim()).filter(Boolean)
}

function assertSoleTypeRule(flat: string, properties: string[]): void {
  const bodies = allRules(flat).filter((rule) =>
    selectorParts(rule.selector).includes('body')
    && properties.some((property) => rule.body.includes(`${property}:`)))
  assert.equal(bodies.length, 1, `exactly one rule may set the shell type on body (found ${bodies.length})`)
  for (const rule of allRules(flat)) {
    const competitors = selectorParts(rule.selector).filter((part) => part !== 'body' && mentions(part, 'body'))
    if (competitors.length === 0) continue
    for (const property of properties) {
      const declared = rule.body.slice(rule.body.indexOf('{') + 1).split(';')
        .map((entry) => entry.trim()).filter((entry) => entry.includes(':'))
        .some((entry) => entry.slice(0, entry.indexOf(':')).trim() === property)
      assert.equal(declared, false, `${rule.selector} qualifies body and re-declares ${property}`)
    }
  }
}

/** Exactly this selector (not a member of a bigger selector list). */
function ruleExact(flat: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`(?:^|[{}])\\s*${escaped}\\s*\\{`).exec(flat)
  assert.ok(match !== null, `${selector} must exist as its own selector`)
  const open = flat.indexOf('{', match.index)
  return flat.slice(open, flat.indexOf('}', open))
}

/** The effective value of one property inside a rule body (last declaration wins). */
function prop(body: string, name: string): string | undefined {
  const hits = body.slice(body.indexOf('{') + 1).split(';')
    .map((entry) => entry.trim()).filter((entry) => entry.includes(':'))
    .map((entry) => {
      const at = entry.indexOf(':')
      return [entry.slice(0, at).trim(), entry.slice(at + 1).trim()]
    })
    .filter(([key]) => key === name)
  return hits.length > 0 ? hits[hits.length - 1][1] : undefined
}

const styles = sheet('../src/styles.css')
// HTML comments removed: the decision itself is DOCUMENTED in the skeleton, so a
// raw text search would match the explanation instead of a media query.
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
  .replace(/<!--[\s\S]*?-->/g, ' ')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')

test('P2-B B-7: the shell body takes the dsh font stack with the literal stack as fallback', () => {
  const body = ruleExact(styles, 'body')
  assertSoleTypeRule(styles, ['font-family', 'font-size', 'line-height'])
  // Assert the VALUE, not a substring: the fallback must live INSIDE the var()
  // (a trailing `var(--dsw-font-family), system-ui, …` is invalid-at-computed-value
  // time until the theme module injects the token, and flips the paint to serif).
  const family = prop(body, 'font-family') ?? ''
  assert.match(family, /^var\(\s*--dsw-font-family\s*,/, 'the theme family must lead the var() fallback list')
  assert.ok(family.includes("'PingFang SC'"), 'the literal stack must remain as the var() fallback')
  assert.equal(/\),\s*system-ui/.test(family), false, 'the literal stack may not sit outside the var()')
  assert.equal(prop(body, 'font-size'), '14px', 'the shell type scale stays 14px')
  assert.equal(prop(body, 'line-height'), '1.5', 'the shell leading stays 1.5')
})

test('P2-B B-6 (cancelled): the boot skeleton stays on the dark shell palette', () => {
  // Decision recorded in src/styles.css and index.html: the dsh theme is projected
  // per instance AFTER the module graph loads, so a skeleton keyed off
  // `prefers-color-scheme` would flash the wrong way for "light OS + dark app".
  assert.equal(/prefers-color-scheme/.test(html), false, 'the skeleton must not follow the OS theme')
  const style = html.slice(html.indexOf('<style>') + '<style>'.length, html.indexOf('</style>'))
  assert.equal(/light-dark\(/.test(style), false,
    'the skeleton must not switch colours through light-dark() either')
  // Assert the actual VALUE of the two painting rules (a literal text search would
  // still pass with `background: light-dark(#ffffff, #0f1115)`).
  const flat = style.replace(/\s+/g, ' ')
  assert.equal(prop(ruleExact(flat, 'body'), 'background'), '#0f1115', 'the skeleton body stays dark')
  assert.equal(prop(ruleExact(flat, '.dsh-boot'), 'background'), '#0f1115', 'the skeleton shell stays dark')
})
