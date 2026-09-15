// Batch-2 (2026-09 menu-density decision) value locks.
//
// Every chamber popup menu runs the official primitive's `compact` form
// (26px items / 12px labels = our row height) instead of the official default
// (40px) or `dense` (34px). Decision + evidence: design 06 §7, design 08 §3.3,
// design 20 §1 and STATUS「菜单密度 = chamber 档」.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripComments } from '../../../../scripts/dev/test-support/source-text.ts'

test('P2-A (A-5): the create-worktree field dropdown uses the chamber menu density', () => {
  const dialog = stripComments(readFileSync(new URL('../../src/client/CreateWorktreeDialog.tsx', import.meta.url), 'utf8'))
  const menus = [...dialog.matchAll(/<Menu\b/g)]
  assert.equal(menus.length, 1, 'the dialog has exactly one Menu tag')
  const tag = dialog.slice(menus[0].index, dialog.indexOf('items=', menus[0].index))
  assert.match(tag, /(?:^|\s)compact(?:\s|$)/, 'the field dropdown must pass compact')
  assert.equal(/\bdense\b/.test(tag), false, 'and must not go back to the 34px dense form')
  assert.ok(tag.includes('portal') && tag.includes('align="end"'), 'portal + align=end stay')
})

test('V1 (v0.2.4 rollback of G1-4): the git icon buttons keep their visual box and no hit rim', () => {
  const sheet = stripComments(readFileSync(new URL('../../src/client/SidebarGit.module.css', import.meta.url), 'utf8'))
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
    // 2026-09-14 (v0.2.4 rollback): no invisible hit rim. The -2px rim narrowed
    // the plain-header band around the button to 1px, so a pointer leaving the
    // 26px header FROM the button got a native pointerleave with no pointerout,
    // React synthesized no onPointerLeave, and the header's RowHoverCard
    // stranded. v0.2.4's geometry — the visual box IS the hit box — is the lock.
    assert.equal(declaration(selector, 'position'), undefined,
      `${selector} must not anchor a hit rim`)
    assert.equal(declaration(`${selector}::after`, 'inset'), undefined,
      `${selector} must not grow an invisible hit box`)
    assert.equal(declaration(`${selector}:disabled::after`, 'pointer-events'), undefined,
      `${selector} must not carry the rim's disabled switch`)
  }
  // The 4px -> 2px gap is the other half of the same 2026-09 hit-area pass: it
  // was widened only so two adjacent 24px rims stayed distinct, so the rollback
  // returns it to v0.2.4's 2px. (The gap is inert — this span holds at most one
  // action — so the value is fidelity, not layout.)
  const clusterGap = Number.parseInt(declaration('.headerGit', 'gap') ?? '0', 10)
  assert.equal(clusterGap, 2,
    `the git header cluster keeps the v0.2.4 2px gap (got ${clusterGap}px)`)
  // A scoped re-add (`:hover::after`, a variant class, …) must fail too: scan
  // every rule whose selector mentions either button for the rim signature.
  const mentionsClass = (selector: string, cls: string): boolean =>
    new RegExp(`${cls.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`).test(selector)
  for (const match of sheet.matchAll(/([^{}]*?)\s*\{([^{}]*)\}/g)) {
    for (const cls of ['.headerGitAction', '.unregisteredAction']) {
      if (!mentionsClass(match[1], cls)) continue
      // Split real declarations: `justify-content: center` must not read as
      // `content`, so match the property NAME, not a substring.
      const names = match[2].split(';')
        .map((entry) => entry.trim())
        .filter((entry) => entry.includes(':'))
        .map((entry) => entry.slice(0, entry.indexOf(':')).trim())
      assert.equal(names.some((name) => name === 'content' || name === 'inset'), false,
        `${match[1].trim()} re-adds an invisible hit rim to ${cls}`)
    }
  }
})
