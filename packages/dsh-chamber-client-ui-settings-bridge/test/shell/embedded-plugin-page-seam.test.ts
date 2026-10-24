/**
 * EMBEDDED PLUGIN PAGE SEAM LOCK (finding M-7/V5-08; 2026-10 section revision).
 *
 * The embedded upstream plugin page is now the content of its own settings
 * SECTION, not a tab under the inventory section: its own h1 + intro row,
 * toolbar, inner tabs, groups, More head and detail heads are the section's
 * chrome, so the containment must NOT hide or re-track any of them. The old
 * lock pinned a hide rule that removed the h1 + intro; that rule also hit the
 * More head (its first child is the back button) and is retired together with
 * the two-track/subgrid layout.
 *
 * This cross-package lock pins the upstream page shape the section renders and
 * the chamber's settings.section registration + settings-shell nav glyph. The
 * containment CSS invariants are owned by the plugin-manager package's
 * containment-selectors lock, so they are not duplicated here.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripComments } from '../../../../scripts/dev/test-support/source-text.ts'

const read = (relative: string): string =>
  stripComments(readFileSync(new URL(relative, import.meta.url), 'utf8'))

const page = read('../../../../vendor/harness-checkout/packages/client/ui-plugin-manager/src/client/PluginManagerPage.tsx')
const index = read('../../../dsh-chamber-client-ui-settings-plugin-manager/src/client/index.ts')
const shell = read('../../src/client/SettingsShell.tsx')
const inventory = read('../../../../vendor/harness-checkout/packages/client/ui-settings-plugins/src/client/index.ts')

test('the embedded page keeps the upstream h1 + div.pageIntro shape the section renders', () => {
  assert.match(page, /data-plugin-panel/, 'the page panel attribute is the containment root')
  assert.match(page, /<header className=\{css\.pageHead\} data-window-drag>/, 'the header row stays a drag row')
  assert.match(page, /<h1 className=\{css\.pageTitle\}>/, 'the section content keeps the page title as its h1')
  assert.match(page, /<\/h1>\s*<div className=\{css\.pageIntro\}>/, 'the intro is the h1 immediate next sibling and a DIV')
})

test('the chamber mounts the page as the plugin-manager settings section', () => {
  const start = index.search(/ctx\.slots\.inject\(\s*'settings\.section'/)
  const end = index.indexOf('EmbeddedPluginManagerPage as never)')
  assert.ok(start >= 0 && end > start, 'the settings.section registration must be present')
  const registration = index.slice(start, end)
  assert.match(registration, /name: 'settings\.section'/u)
  // The id is single-sourced (the seat opens the same constant); its VALUE is pinned here.
  assert.match(index, /const PLUGIN_SECTION_ID = 'plugin-manager'/u)
  assert.match(registration, /id: PLUGIN_SECTION_ID/u)
  assert.match(registration, /order: 16/u, 'the section sits directly after the upstream plugins inventory (order 15)')
  assert.match(registration, /label: \(\) => sectionLabel\('nav'\)/u, 'the nav label comes from the chamber section dictionary')
  assert.match(registration, /locale: MANAGER_NS/u, "the page's t seat must be the pluginManager dictionary")
  assert.match(registration, /store,/u, 'the navigation store must ride the registration')
  assert.match(registration, /inject: \(\) => face as PluginManagerFace/u, 'the controller face must ride the registration')
  assert.match(registration, /children: MANAGER_CHILDREN/u, 'the page children table must be declared')
  assert.doesNotMatch(index, /settings\.plugins\.tab/u, 'the old inventory-tab embedding is retired')
  assert.match(shell, /id === 'plugin-manager'/u, 'the settings shell needs a nav glyph for the new section id')
  assert.match(inventory, /order: 15/u, 'the upstream inventory section stays at order 15; 16 must stay directly after it')
})
