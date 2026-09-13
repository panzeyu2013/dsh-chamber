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

test('P2-A (A-5): the create-worktree field dropdown uses the chamber menu density', () => {
  const dialog = stripComments(readFileSync(new URL('../src/client/CreateWorktreeDialog.tsx', import.meta.url), 'utf8'))
  const menus = [...dialog.matchAll(/<Menu\b/g)]
  assert.equal(menus.length, 1, 'the dialog has exactly one Menu tag')
  const tag = dialog.slice(menus[0].index, dialog.indexOf('items=', menus[0].index))
  assert.match(tag, /(?:^|\s)compact(?:\s|$)/, 'the field dropdown must pass compact')
  assert.equal(/\bdense\b/.test(tag), false, 'and must not go back to the 34px dense form')
  assert.ok(tag.includes('portal') && tag.includes('align="end"'), 'portal + align=end stay')
})

test('G1-4: the git icon buttons keep their 20px box and grow a 24px hit area', () => {
  const sheet = stripComments(readFileSync(new URL('../src/client/SidebarGit.module.css', import.meta.url), 'utf8'))
    .replace(/\s+/g, ' ')
  // Reads a property from every rule whose selector LIST contains the selector
  // (grouped rules like `.a, .b { … }` included), last declaration winning.
  const declaration = (selector: string, property: string): string | undefined => {
    const pattern = new RegExp(`([^{}]*?)\\s*\\{([^{}]*)\\}`, 'g')
    const values: string[] = []
    for (const match of sheet.matchAll(pattern)) {
      const parts = match[1].split(/,(?![^(]*\))/).map((part) => part.trim())
      if (!parts.includes(selector)) continue
      for (const entry of match[2].split(';').map((item) => item.trim()).filter((item) => item.includes(':'))) {
        if (entry.slice(0, entry.indexOf(':')).trim() === property) values.push(entry.slice(entry.indexOf(':') + 1).trim())
      }
    }
    return values.length > 0 ? values[values.length - 1] : undefined
  }
  for (const selector of ['.headerGitAction', '.unregisteredAction']) {
    assert.equal(declaration(selector, 'width'), '20px', `${selector} keeps its 20px visual box`)
    assert.equal(declaration(selector, 'height'), '20px', `${selector} keeps its 20px visual box`)
    assert.equal(declaration(selector, 'position'), 'relative', `${selector} anchors the overlay`)
    assert.equal(declaration(`${selector}::after`, 'inset'), '-2px', `${selector} grows a 24px hit box`)
  }
  for (const selector of ['.headerGitAction', '.unregisteredAction']) {
    assert.equal(declaration(`${selector}:disabled::after`, 'pointer-events'), 'none',
      `${selector}'s disabled state must switch the enlarged rim off`)
  }
  // Two adjacent 24px boxes must stay distinct.
  const clusterGap = Number.parseInt(declaration('.headerGit', 'gap') ?? '0', 10)
  assert.ok(clusterGap >= 4,
    `the git header cluster needs >= 4px between two 24px hit boxes (got ${clusterGap}px)`)
})
