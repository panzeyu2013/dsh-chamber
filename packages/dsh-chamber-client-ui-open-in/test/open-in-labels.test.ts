/**
 * Label coverage gate (design 20 §5/§9).
 *
 * The catalog is OURS: `packages/dsh-chamber-seed-open-in/src/catalog.ts` is the
 * authority on which application ids the entry can ever render, and this test
 * fails when
 *   - an id has no label key in `OPEN_IN_APP_LABEL_KEY`,
 *   - a mapped key is missing from the zh or the en dictionary,
 *   - or the table carries a row for an id the catalog cannot answer.
 *
 * The id set is read as SOURCE TEXT, not imported: this is a browser package
 * and the host domain is a Node seed package outside its `rootDir` (the repo's
 * established cross-package pattern — `chamber-seed-drift.test.ts` reads
 * `host-graph-seed.ts` the same way). The two row forms below are self-checking:
 * an id produced by a form the extraction does not know would make its label row
 * look "stray" and fail the last test loudly, instead of being silently missed.
 *
 * It replaces the retired mirror check that compared the chamber dictionary
 * against the vendor client's `OpenInAppAction.tsx` (design 20 §8): upstream's
 * copy is now kept honest by the fork gate (`FORKS` C1), and this gate keeps OUR
 * two halves honest with each other.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { OPEN_IN_APP_LABEL_KEY, en, zh } from '../src/locales.ts'

const catalogSource = readFileSync(
  join(import.meta.dirname, '..', '..', 'dsh-chamber-seed-open-in', 'src', 'catalog.ts'),
  'utf8',
)

/**
 * Every catalog id the host domain can answer: literal rows (`{ id: 'vscode' }`)
 * and the family helper that expands one call into one application
 * (`jetBrains('intellij', …)`), in menu order.
 */
const catalogIds = [...catalogSource.matchAll(/\bid: '([a-z0-9]+)'|\bjetBrains\('([a-z0-9]+)'/gu)]
  .map(match => match[1] ?? match[2]!)

test('the host catalog is non-trivially large (the extraction found the real table)', () => {
  assert.ok(catalogIds.length >= 30, `expected the full host catalog, got ${String(catalogIds.length)} ids`)
  for (const id of ['finder', 'terminal', 'vscode', 'intellij']) {
    assert.ok(catalogIds.includes(id), `the catalog must carry ${id}`)
  }
})

test('every host catalog id has a label key', () => {
  const missing = catalogIds.filter(id => OPEN_IN_APP_LABEL_KEY[id] === undefined)
  assert.deepEqual(missing, [], 'a catalog id without a label would render as a raw id')
})

test('every mapped label key exists in both dictionaries', () => {
  for (const [id, key] of Object.entries(OPEN_IN_APP_LABEL_KEY)) {
    assert.ok(key !== undefined, `${id} must map to a label key`)
    assert.equal(typeof zh[key], 'string', `${key} is missing from the zh dictionary`)
    assert.equal(typeof en[key], 'string', `${key} is missing from the en dictionary`)
    assert.notEqual(zh[key], '', `${key} must not be an empty zh label`)
    assert.notEqual(en[key], '', `${key} must not be an empty en label`)
  }
})

test('the label table owns no key outside the catalog', () => {
  // A stale row would keep a label alive for an id the host can never answer:
  // harmless but misleading, so it is pinned out.
  const stray = Object.keys(OPEN_IN_APP_LABEL_KEY).filter(id => !catalogIds.includes(id))
  assert.deepEqual(stray, [])
})
