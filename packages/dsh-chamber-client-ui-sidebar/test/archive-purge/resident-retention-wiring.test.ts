import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Resident-retention wiring contract (design 24 §4 step 9, 2026-13).
 *
 * The dialog (`src/client/ArchiveManagerDialog.tsx`) imports React and CSS
 * modules and cannot be imported by a node test, so the GLUE between the
 * purge result and the row label — read `residentRetainedRoots` → union into
 * the dialog-lifetime label set → prune with the rows → render the tag and
 * carry the state into the checkbox's accessible name — has no other guard.
 * This source-text contract pins that glue the same way
 * `producer-purged-wiring.test.ts` pins the producer's convergence glue.
 *
 * It guards WIRING, not semantics: a green run proves the calls still exist
 * in the expected shape. The behavioural halves live in
 * `instance-api.test.ts` (id-list decode) and `archive-purge.test.ts`
 * (outcome wording), and the rendered surface stays a packaged visual/目检
 * item (this package has no DOM test infrastructure).
 */
const DIALOG = readFileSync(
  fileURLToPath(new URL('../../src/client/ArchiveManagerDialog.tsx', import.meta.url)),
  'utf8',
)
const CSS = readFileSync(
  fileURLToPath(new URL('../../src/client/sidebar-chamber.module.css', import.meta.url)),
  'utf8',
)

/** Collapse whitespace so assertions survive formatting churn. */
const flat = DIALOG.replace(/\s+/g, ' ')

test('wiring: the run result feeds the label set (union, never replace)', () => {
  assert.match(flat, /const retained = run\.purge\.residentRetainedRoots/)
  assert.match(flat, /if \(retained !== undefined && retained\.length > 0\) \{/)
  // A later run that reports nothing must NOT erase labels an earlier run set.
  assert.match(flat, /setResidentPurged\(prev => new Set\(\[\.\.\.prev, \.\.\.retained\]\)\)/)
  assert.doesNotMatch(flat, /setResidentPurged\(new Set\(/)
})

test('wiring: labels are pruned with the rows (a vanished row drops its label)', () => {
  assert.match(flat, /setSelected\(prev => pruneSet\(prev, rowSet\)\)/)
  assert.match(flat, /setResidentPurged\(prev => pruneSet\(prev, rowSet\)\)/)
})

test('wiring: the tag renders through the dictionary and carries its full text', () => {
  assert.match(flat, /className=\{cc\.archiveManagerRowTag\}/)
  assert.match(flat, /title=\{t\('archive\.manager\.residentPurged'\)\}/)
  assert.match(flat, /t\('archive\.manager\.residentPurged'\)/)
  // Guarded by the label set — never rendered for an unlabeled row.
  assert.match(flat, /\{residentPurged\.has\(row\.sessionId\) && \(/)
})

test('wiring: the row checkbox announces the resident state (a11y review 2026-13)', () => {
  assert.match(flat, /aria-label=\{rowAriaLabel\(row\)\}/)
  assert.match(flat, /const rowAriaLabel = \(row: \{ readonly sessionId: string; readonly title\?: string \}\): string =>/)
  assert.match(flat, /residentPurged\.has\(row\.sessionId\)\s*\? t\('archive\.manager\.rowAriaResidentPurged', \{ title: titleText\(row\.title\) \}\)/)
})

test('wiring: the tag class yields layout space instead of squeezing the title', () => {
  const rule = /\.archiveManagerRowTag \{([^}]*)\}/.exec(CSS)
  assert.ok(rule !== null, 'the tag class exists in the css module')
  const body = rule[1] ?? ''
  assert.match(body, /max-width:\s*45%/)
  assert.match(body, /text-overflow:\s*ellipsis/)
  assert.match(body, /overflow:\s*hidden/)
  // Token ink only (the module's design-token discipline).
  assert.match(body, /var\(--dsw-alias-label-secondary\)/)
})

test('wiring: the new dictionary keys exist in BOTH dictionaries', () => {
  const locales = readFileSync(
    fileURLToPath(new URL('../../src/client/locales.ts', import.meta.url)),
    'utf8',
  )
  for (const key of ['archive.manager.residentPurged', 'archive.manager.rowAriaResidentPurged']) {
    const hits = locales.match(new RegExp(`'${key.replace(/\./g, '\\.')}':`, 'g')) ?? []
    assert.equal(hits.length, 2, `${key} must exist in zh AND en`)
  }
})
