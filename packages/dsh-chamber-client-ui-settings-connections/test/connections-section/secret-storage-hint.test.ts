/**
 * S-29 residual lock: the connections settings page must carry a DEDICATED hint
 * for the `secretStorageUnreadable` projection (credentials another flavor
 * wrote with safeStorage; the file is preserved byte-for-byte and the entries
 * fail closed), distinct from the documented 0600 plaintext hint, in zh + en.
 *
 * The section is TSX with no DOM harness in this package, so the render wiring
 * is pinned over comment-stripped source text (same style as the sibling
 * connections-section locks); the dictionaries are asserted directly.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripComments } from '../../../../scripts/dev/test-support/source-text.ts'
import { en, zh } from '../../src/locales.ts'

const section = stripComments(
  readFileSync(new URL('../../src/client/ConnectionsSection.tsx', import.meta.url), 'utf8'),
)

test('S-29: both dictionaries carry the dedicated unreadable-credential hint', () => {
  assert.equal(typeof zh.secretStorageUnreadableHint, 'string')
  assert.equal(typeof en.secretStorageUnreadableHint, 'string')
  assert.ok(zh.secretStorageUnreadableHint.trim().length > 0, 'zh hint must not be empty')
  assert.ok(en.secretStorageUnreadableHint.trim().length > 0, 'en hint must not be empty')
  assert.notEqual(zh.secretStorageUnreadableHint, zh.secretStoragePlaintextHint)
  assert.notEqual(en.secretStorageUnreadableHint, en.secretStoragePlaintextHint)
  // Actionable copy: re-entering is the user's next step, not just a diagnosis.
  assert.match(zh.secretStorageUnreadableHint, /重新录入/)
  assert.match(en.secretStorageUnreadableHint, /Re-enter/)
})

test('S-29: the section renders the hint off the per-row projection and keeps the plaintext hint', () => {
  assert.match(section, /spec\.secretStorageUnreadable === true/,
    'the unreadable hint must key off the secretStorageUnreadable projection')
  assert.match(section, /t\('secretStorageUnreadableHint'\)/
,
    'the dedicated key must be rendered')
  // The existing plaintext hint stays (different condition, different copy).
  assert.match(section, /spec\.secretStorage === 'plaintext'/)
  assert.match(section, /t\('secretStoragePlaintextHint'\)/)
})
