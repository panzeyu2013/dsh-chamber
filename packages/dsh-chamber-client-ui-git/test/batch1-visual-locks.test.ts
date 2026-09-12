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

const flat = stripComments(readFileSync(new URL('../src/client/SidebarGit.module.css', import.meta.url), 'utf8')).replace(/\s+/g, ' ')

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`(?:^|[{},])\\s*${escaped}\\s*(?:,|\\{)`).exec(flat)
  assert.notEqual(match, null, `${selector} must exist as a standalone selector`)
  const open = flat.indexOf('{', match.index)
  return flat.slice(open, flat.indexOf('}', open))
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

test('G1: unregistered worktree rows take the derived-workspace row language', () => {
  // design 08 §3.4: these rows share the derived workspace row (26px, r8, a
  // 14px/600 secondary name, a 20px in-row action box).
  pin('G1 row', '.unregisteredRow', { height: '26px', margin: '0', 'border-radius': '8px' })
  pin('G1 name', '.unregisteredName', {
    'font-size': '14px', 'font-weight': '600', 'line-height': '18px',
    color: 'var(--dsw-alias-label-secondary)',
  })
  pin('G1 action', '.unregisteredAction', { width: '20px', height: '20px', 'border-radius': '5px' })
  // The 2px rhythm is the section's flex gap, not a row margin (flex margins do
  // not collapse; a row margin on top of the gap doubled the nav rhythm).
  pin('G1 rhythm', '.unregisteredSection', { gap: '2px' })
})

test('G3: the source-branch select and the dialog inputs are the official Input atom', () => {
  // Official `_wrap_1g6ru_1`: 32px / `border: .5px solid border-l4` / r8 /
  // bg-layer-1 / 14px-22px. Both fields must match, or the three stacked fields
  // stop reading as one control family.
  pin('G3 select', '.fieldSelect', {
    border: '0.5px solid var(--dsw-alias-border-l4)',
    'border-radius': '8px',
    height: '32px',
    'font-size': '14px',
    'line-height': '22px',
  })
  pin('G3 input', '.fieldInput', { 'border-radius': '8px' })
})
