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

const flat = stripComments(readFileSync(new URL('../src/client/SettingsShell.module.css', import.meta.url), 'utf8')).replace(/\s+/g, ' ')

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

test('E1: settings cards carry the official l4 hairline (r12 + layer-3 kept)', () => {
  // Official `ModelsSection.rowCard` is `border-l4 + r16 + no background`;
  // chamber keeps its own r12 + bg-layer-3 tile and takes the hairline only.
  pin('E1 card', '.generalCard', { border: '0.5px solid var(--dsw-alias-border-l4)' })
  pin('E1 notify card', '.generalNotifyCard', { border: '0.5px solid var(--dsw-alias-border-l4)' })
})

test('E4 (2026-09 amended): the server dropdown keeps the official Menu chrome', () => {
  // Official `Menu.module.css`: `.list{…border-radius:20px}` and
  // `.item{…border-radius:10px}` — the chrome this item won.
  // The ITEM DENSITY is no longer pinned here: phase 2 (A-4) moved it back to the
  // chamber scale (7px 10px / 13px / 18px, no 34px dense floor), so
  // `test/batch2-visual-locks.test.ts` owns those numbers. Pinning both would
  // make the two files contradict each other.
  pin('E4 list', '.dropdownList', { 'border-radius': '20px' })
  pin('E4 item', '.dropdownItem', { 'border-radius': '10px' })
})

test('F1 sibling: the runtime status pill uses the official Tag metrics', () => {
  // Same vocabulary the connections page moved to: 11px/17px, 1px 8px, l4.
  pin('F1 runtimeBadge', '.runtimeBadge', {
    height: '20px',
    padding: '1px 8px',
    'font-size': '11px',
    'line-height': '17px',
    border: '0.5px solid var(--dsw-alias-border-l4)',
  })
})
