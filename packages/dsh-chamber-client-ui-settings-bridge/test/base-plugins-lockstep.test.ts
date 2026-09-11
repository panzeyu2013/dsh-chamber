/**
 * Nav provenance classification (design 15 v1 flat form; 2026-12 完整桥接修订).
 *
 * The panel renders the selected source's OWN ledger, so a nav row's
 * registrant decides whether the shell marks it "插件". The set below is a
 * CLASSIFICATION list only — since the detached child context was retired it
 * no longer constrains what may be mounted anywhere, so the old
 * base-plugin ↔ composite-covered lockstep invariant no longer exists.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OFFICIAL_SECTION_REGISTRANTS, RUNTIME_SECTION_ID, isBasePluginId } from '../src/client/base-plugins.ts'
import { isPluginProvidedRow } from '../src/client/section-rows.ts'

test('official registrants classify as official, third parties do not', () => {
  for (const id of OFFICIAL_SECTION_REGISTRANTS) {
    assert.equal(isBasePluginId(id), true, `${id} must classify as official`)
  }
  assert.equal(isBasePluginId('@acme/dsh-client-ui-settings-acme'), false,
    'an unknown package is plugin-provided')
})

test('the chamber runtime section registers from the bridge plugin on the source’s own ctx', () => {
  assert.equal(RUNTIME_SECTION_ID, 'dsh-runtime')
  assert.equal(isBasePluginId('@dsh-chamber/dsh-chamber-client-ui-settings-bridge'), true)
})

test('the composite mount context classifies as official (cordis name inheritance)', () => {
  // The stamp is the registrant fiber's name and cordis inherits an unnamed
  // fiber's name from its nearest NAMED ancestor, so anything the chamber
  // composite mounts bare is stamped `@dsh-chamber/app` — a chamber-owned mount
  // context, never a plugin. The deferred rows themselves now mount under their
  // package ids (chamber-entry.ts registerDeferred, locked by
  // packages/renderer/test/required-extra-rows.test.ts); this entry keeps a bare
  // mount from being accused of being third-party.
  assert.equal(isBasePluginId('@dsh-chamber/app'), true)
  assert.equal(isPluginProvidedRow({ registrant: '@dsh-chamber/app' }, isBasePluginId), false)
})

test('a plugin-provided row is marked; an official or unattributed row is not', () => {
  assert.equal(isPluginProvidedRow({ registrant: '@acme/x' }, isBasePluginId), true)
  assert.equal(isPluginProvidedRow({ registrant: '@deepseek-ai/dsh-client-ui-settings-models' }, isBasePluginId), false)
  assert.equal(isPluginProvidedRow({}, isBasePluginId), false,
    'an unattributed row must not be accused of being third-party')
})
