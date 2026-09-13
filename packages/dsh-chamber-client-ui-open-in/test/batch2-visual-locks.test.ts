// Batch-2 (2026-09 menu-density decision) value locks.
//
// Every chamber popup menu runs the official primitive's `compact` form
// (26px items / 12px labels = our row height) instead of the official default
// (40px) or `dense` (34px). Decision + evidence: design 06 §7, design 08 §3.3,
// design 20 §1 and STATUS「菜单密度 = chamber 档」.

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

test('P2-A (A-5): the open-in app menu uses the chamber menu density', () => {
  const source = stripComments(readFileSync(new URL('../src/client/OpenInButton.tsx', import.meta.url), 'utf8'))
  const menus = [...source.matchAll(/<Menu\b/g)]
  assert.equal(menus.length, 1, 'the plugin renders exactly one Menu tag')
  const tag = source.slice(menus[0].index, source.indexOf('items=', menus[0].index))
  assert.match(tag, /(?:^|\s)compact(?:\s|$)/, 'the app menu must pass compact')
  assert.equal(/\bdense\b/.test(tag), false, 'and must not go back to dense')
  // What the upstream alignment won must survive the density change.
  assert.ok(tag.includes('autoFocus'), 'focus transfer stays')
  assert.ok(tag.includes('selection="fill"'), 'the fill selection stays')
})
