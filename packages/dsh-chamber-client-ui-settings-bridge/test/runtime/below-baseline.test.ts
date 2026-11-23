/**
 * N1 (design 18 §3.4 compatibility floor): the version picker must WARN when the
 * selected version sits below the projected compatibility baseline — the boot
 * gate is only the first-screen fatal overlay afterwards. belowBaseline is
 * projected by BOTH runtime shapes (local RuntimeVersionEntry and the gateway
 * RemoteVersionEntry are structurally identical), and the pure selection helper
 * is shared client-core code, so this file covers the truth table + the display
 * sentence + the source wiring of the warning row and the option tag.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  selectedBelowBaselineVersion,
  type RuntimeVersionEntry,
} from '@dsh-chamber/dsh-chamber-client-core/runtime-management'
import { selectedBelowBaselineNotice } from '../../src/client/below-baseline.ts'

const VERSIONS: RuntimeVersionEntry[] = [
  { version: '1.2.0', latest: true, cached: false, belowBaseline: false },
  { version: '1.1.0', latest: false, cached: true, belowBaseline: false },
  { version: '0.9.0', latest: false, cached: true, belowBaseline: true },
]

test('selectedBelowBaselineVersion: only a projected below-baseline selection claims the floor', () => {
  assert.equal(selectedBelowBaselineVersion(VERSIONS, '0.9.0'), '0.9.0', 'below-baseline selection warns')
  assert.equal(selectedBelowBaselineVersion(VERSIONS, '1.2.0'), null, 'supported selection stays silent')
  assert.equal(selectedBelowBaselineVersion(VERSIONS, '1.1.0'), null)
  assert.equal(selectedBelowBaselineVersion(VERSIONS, null), null, 'no selection = no claim')
  assert.equal(selectedBelowBaselineVersion(VERSIONS, '3.0.0'), null,
    'a selection absent from the list (stale id) is not a below-baseline claim')
  assert.equal(selectedBelowBaselineVersion([], '0.9.0'), null, 'empty list = unknown = silent')
  // The gateway version list is the same shape; the warning is not local-only.
  const gatewayShape: { version: string; belowBaseline: boolean }[] = [{ version: '0.8.0', belowBaseline: true }]
  assert.equal(selectedBelowBaselineVersion(gatewayShape, '0.8.0'), '0.8.0')
})

test('selectedBelowBaselineNotice: localized sentence carries the version, otherwise null', () => {
  const calls: { key: string; version: unknown }[] = []
  const translate = (key: string, params?: Record<string, unknown>): string => {
    calls.push({ key, version: params?.version })
    return key + ':' + String(params?.version)
  }
  assert.equal(selectedBelowBaselineNotice(VERSIONS, '0.9.0', translate as never),
    'dshRuntimeBelowBaselineHint:0.9.0')
  assert.deepEqual(calls, [{ key: 'dshRuntimeBelowBaselineHint', version: '0.9.0' }])
  assert.equal(selectedBelowBaselineNotice(VERSIONS, '1.2.0', translate as never), null)
  assert.equal(selectedBelowBaselineNotice(VERSIONS, null, translate as never), null)
  assert.equal(calls.length, 1, 'no translation is requested when the selection is supported')
})

test('the runtime section renders the warning row and tags the below-baseline option (source lock)', () => {
  const section = readFileSync(new URL('../../src/client/DshRuntimeSection.tsx', import.meta.url), 'utf8')
  assert.match(section, /const belowBaselineNotice = selectedBelowBaselineNotice\(versions, chosen, t\)/u,
    'the LOCAL managed-runtime branch computes the notice from the projected version list')
  assert.match(section,
    /\{belowBaselineNotice !== null && <p className=\{css\.generalHint\} role="status">\{belowBaselineNotice\}<\/p>\}/u,
    'the notice is a visible status row (hint tone), not console-only')
  const tagSites = (section.match(/dshRuntimeBelowBaselineTag/gu) ?? []).length
  assert.equal(tagSites, 2, 'both picker branches (local + gateway) tag the below-baseline option')
  assert.equal((section.match(/entry\.belowBaseline \?/gu) ?? []).length, 2,
    'the tag is driven by the projected per-entry belowBaseline flag')
  const locales = readFileSync(new URL('../../src/locales.ts', import.meta.url), 'utf8')
  assert.match(locales, /dshRuntimeBelowBaselineTag: '低于兼容基线'/u, 'zh tag copy')
  assert.match(locales, /dshRuntimeBelowBaselineTag: 'below baseline'/u, 'en tag copy')
  assert.match(locales, /dshRuntimeBelowBaselineHint: '所选版本 v\{version\} 低于兼容基线/u, 'zh notice copy')
  assert.match(locales, /dshRuntimeBelowBaselineHint: 'The selected version v\{version\} is below the compatibility baseline/u,
    'en notice copy')
})
