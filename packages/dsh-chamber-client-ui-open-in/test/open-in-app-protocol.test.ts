/**
 * Lockstep test for the absorbed official open-in-app contract (Batch 3
 * Phase 2): the three route literals and the product-label key set are mirrored
 * from the vendored upstream packages, so a vendor upgrade that renames a
 * route or adds an application label must be absorbed here. Reads the vendor
 * sources read-only — the same discipline as verify-upstream-touchpoints C1.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  OPEN_IN_APP_APPS_ROUTE,
  OPEN_IN_APP_ICON_PREFIX,
  OPEN_IN_APP_OPEN_ROUTE,
} from '../src/shared/open-in-app-protocol.ts'
import { OPEN_IN_APP_LABEL_KEY, en, zh } from '../src/locales.ts'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const vendorHostShared = join(repoRoot, 'vendor', 'harness-checkout', 'packages', 'host', 'open-in-app', 'src', 'shared.ts')
const vendorClientAction = join(repoRoot, 'vendor', 'harness-checkout', 'packages', 'client', 'ui-open-in-app', 'src', 'client', 'OpenInAppAction.tsx')

test('the mirrored host routes equal the vendored host contract byte for byte', () => {
  const source = readFileSync(vendorHostShared, 'utf8')
  const literal = (name: string): string => {
    const match = source.match(new RegExp(`export const ${name} = '([^']+)'`))
    assert.ok(match !== null, `${name} must exist in the vendored shared.ts`)
    return match[1]!
  }
  assert.equal(OPEN_IN_APP_APPS_ROUTE, literal('OPEN_IN_APP_APPS_ROUTE'))
  assert.equal(OPEN_IN_APP_ICON_PREFIX, literal('OPEN_IN_APP_ICON_PREFIX'))
  assert.equal(OPEN_IN_APP_OPEN_ROUTE, literal('OPEN_IN_APP_OPEN_ROUTE'))
})

test('every vendored catalog label key has a chamber dictionary entry', () => {
  const source = readFileSync(vendorClientAction, 'utf8')
  const table = source.slice(source.indexOf('const APP_LABEL_KEY'))
  const keys = [...table.matchAll(/^\s{2}([a-z]+): '(app\.[a-z]+)',$/gm)].map(match => ({ id: match[1]!, key: match[2]! }))
  assert.ok(keys.length >= 30, `expected the full vendored label table, got ${String(keys.length)} keys`)
  for (const { id, key } of keys) {
    assert.equal(OPEN_IN_APP_LABEL_KEY[id], key, `catalog id ${id} must map to ${key}`)
    assert.equal(typeof zh[key as keyof typeof zh], 'string', `zh dictionary is missing ${key}`)
    assert.equal(typeof en[key as keyof typeof en], 'string', `en dictionary is missing ${key}`)
  }
})
