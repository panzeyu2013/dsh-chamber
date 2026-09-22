/**
 * Tables lockstep: the literals in `src/tables.ts` and the cross-language
 * projection in `tables.json` must agree exactly.
 *
 * WHY A SEPARATE FILE. The TS literals are the runtime source (the module is
 * import-clean for the browser); the JSON is what the Swift mirror reads. Two
 * representations of one truth drift silently without this assertion - and a
 * drifted threshold in the shell is exactly the class of bug this lockstep
 * exists to prevent (uncalibrated numbers nobody can see).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { TABLE_SNAPSHOT } from '../../src/tables.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const JSON_PATH = join(HERE, '..', '..', 'tables.json')

test('tables.json mirrors the TS literals exactly', () => {
  const parsed = JSON.parse(readFileSync(JSON_PATH, 'utf8')) as { tables?: unknown }
  assert.ok(parsed.tables !== undefined, 'tables.json must carry a tables object')
  const jsonTables = parsed.tables as Record<string, unknown>
  const tsTables = TABLE_SNAPSHOT as unknown as Record<string, unknown>
  assert.deepEqual(jsonTables, tsTables, 'tables.json and src/tables.ts drifted')
})

test('the projection carries every field the Swift mirror reads', () => {
  // A missing field would make the Swift side default silently, which is worse
  // than a red gate: the shell would run on a number nobody chose.
  const required = [
    'rebuildWindowMs',
    'maxRebuildsPerWindow',
    'minRebuildSpacingMs',
    'inFlightGraceMs',
    'openingTimeoutLadderMs',
    'silentTeardownMinMs',
    'openingStallStreak',
  ]
  for (const field of required) {
    assert.ok(field in (TABLE_SNAPSHOT as unknown as Record<string, unknown>), 'missing table field ' + field)
  }
})
