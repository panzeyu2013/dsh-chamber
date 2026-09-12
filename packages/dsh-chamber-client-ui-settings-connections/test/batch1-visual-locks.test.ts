/**
 * 2026-09 "batch 1 — pure visual consistency" locks for this package.
 *
 * SOURCE-TEXT locks (comments stripped first, so prose can never satisfy one).
 * `rule()` matches a WHOLE selector list (a decoy compound rule cannot be
 * mistaken for the base rule); `pin()` asserts the EFFECTIVE declaration (last
 * wins) and rejects competing longhands, so a later `padding-left`/`height`
 * override fails the lock.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

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

const flat = stripComments(readFileSync(new URL('../src/client/ConnectionsSection.module.css', import.meta.url), 'utf8')).replace(/\s+/g, ' ')

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
  height: /^(?:min|max)-height$/,
  width: /^(?:min|max)-width$/,
}

function pin(item: string, selector: string, wanted: Record<string, string>): void {
  const body = rule(selector)
  for (const [property, value] of Object.entries(wanted)) {
    const hits = decls(body).filter(([name]) => name === property)
    assert.equal(hits.length > 0 ? hits[hits.length - 1][1] : undefined, value,
      `${item}: ${selector} must effectively declare ${property}: ${value}`)
    const pattern = COMPETING[property]
    if (pattern !== undefined) {
      assert.deepEqual(decls(body).filter(([name]) => pattern.test(name)).map(([n, v]) => `${n}: ${v}`), [],
        `${item}: ${selector} must not add a competing ${property} declaration`)
    }
  }
}

test('E1: both connection cards carry the official l4 hairline', () => {
  pin('E1 localCard', '.localCard', { border: '0.5px solid var(--dsw-alias-border-l4)' })
  pin('E1 card', '.card', { border: '0.5px solid var(--dsw-alias-border-l4)' })
  // Hover must not FADE the outline below its resting weight (the old
  // `border-color: label-dimmed` did exactly that once rest moved to l4): it
  // keeps the hairline and paints the system's interactive tint.
  pin('E1 card hover', '.card:hover', {
    'border-color': 'var(--dsw-alias-border-l4)',
    background: 'var(--dsw-alias-interactive-bg-hover)',
  })
})

test('F1: status/kind pills are the official Tag tones (10%/12% tint + Tag metrics)', () => {
  // Official `_tag_brmue_4` base + tones, verified in the pinned bundle.
  pin('F1 badge base', '.badge', {
    padding: '1px 8px',
    'font-size': '11px',
    'line-height': '17px',
    border: '0.5px solid var(--dsw-alias-border-l4)',
  })
  pin('F1 ok', '.badgeOk', {
    background: 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent)',
    color: 'var(--dsw-alias-state-success-primary)',
  })
  pin('F1 bad', '.badgeBad', {
    background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent)',
    color: 'var(--dsw-alias-state-error-primary)',
  })
  pin('F1 kind', '.kindBadge', {
    padding: '1px 8px', 'font-size': '11px', 'line-height': '17px',
    border: '0.5px solid var(--dsw-alias-border-l4)',
  })
  // The co-rendered plugin-kind chip must not drift back to the old vocabulary.
  pin('F1 kind (plugin)', '.pluginKindBadge', {
    padding: '1px 8px', 'font-size': '11px', 'line-height': '17px',
    border: '0.5px solid var(--dsw-alias-border-l4)',
  })
  pin('F1 plugin client', '.pluginKindClient', {
    background: 'color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent)',
    color: 'var(--dsw-alias-state-warn-primary)',
  })
})

test('F2: banners are official tinted notes (no state-coloured border)', () => {
  pin('F2 recovery', '.recoveryBanner', {
    border: '0',
    background: 'color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent)',
  })
  pin('F2 writer', '.writerBlocked', {
    border: '0',
    'border-radius': '8px',
    background: 'color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent)',
  })
})

test('G3 sibling: the page form input is the official Input atom', () => {
  pin('G3 sibling input', '.input', {
    height: '32px',
    padding: '0 8px',
    border: '0.5px solid var(--dsw-alias-border-l4)',
    'border-radius': '8px',
    'font-size': '14px',
    'line-height': '22px',
  })
})
