/**
 * EMBEDDED PLUGIN PAGE SEAM LOCK.
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
// alpha.1: `ui-settings-plugins` (the rc.3 inventory section, order 15) was DELETED upstream;
// the order-15 anchor is now `ui-plugin-manager`'s own `settings.section` ('plugins' link)
// registration, which chamber does not load. This lock reads that page package instead.
const pluginManagerIndex = read('../../../../vendor/harness-checkout/packages/client/ui-plugin-manager/src/client/index.ts')

test('the embedded page keeps the upstream h1 + div.pageIntro shape the section renders', () => {
  assert.match(page, /data-plugin-panel/, 'the page panel attribute is the containment root')
  assert.match(page, /<header className=\{css\.pageHead\} data-window-drag>/, 'the header row stays a drag row')
  // 0.2.2: both header parts carry data-plugin-header-part (title/intro) and the page
  // drives sticky/compact geometry from them; the sibling relationship is unchanged.
  assert.match(page, /<h1 className=\{css\.pageTitle\} data-plugin-header-part="title">/,
    'the section content keeps the page title as its h1 (header part = title)')
  assert.match(page, /<\/h1>\s*<div className=\{css\.pageIntro\} data-plugin-header-part="intro">/,
    'the intro is the h1 immediate next sibling and a DIV (header part = intro)')
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
  // 0.2.2: the page also drives its sticky/compact header through the injected face
  // (createHeaderRef); the chamber synthesizes it onto the controller face like upstream does.
  // alpha.1 page contract (plan §12.3.4 / C1): the page also consumes `InjectFace<ClientSyncFace>`
  // (`props.useClientSync` + `props.retryClient` are read UNCONDITIONALLY at first render), so the
  // registration must synthesize the client-sync hooks + retry on the same face object. Chamber
  // ships the static fallback (the boot never calls modules.entries.start ⇒ entries.state vacuous);
  // the page opens, the sync line/notice never appears (registered limitation).
  assert.match(registration, /inject: \(\) => \(\{[\s\S]*?\.\.\.face,[\s\S]*?createHeaderRef: createPluginHeaderRef,[\s\S]*?hooks: \{ \.\.\.face\.hooks, clientSync: CLIENT_SYNC_OBSERVABLE \},[\s\S]*?retryClient: \(\) => \{\},/u,
    'the controller + header-layout + client-sync faces must ride the registration (the intersection is the type lock)')
  assert.match(registration, /as PluginManagerFace & PluginHeaderLayoutFace & ClientSyncFace/u,
    'the registration face intersection names the alpha.1 client-sync contract')
  assert.match(page, /& InjectFace<ClientSyncFace>/u, 'the pinned page still consumes the client-sync injected face')
  assert.match(page, /props\.useClientSync\(/u, 'the pinned page reads the bound useClientSync hook (unconditional first-render call)')
  assert.match(index, /const CLIENT_SYNC_IDLE: ClientSyncSnapshot = \{ syncing: false, failures: \[\] \}/u,
    'the static fallback snapshot is exactly the idle shape (no invented failures)')
  assert.match(index, /const CLIENT_SYNC_OBSERVABLE = \{/u, 'the static fallback observable is the one the face binds')
  assert.doesNotMatch(index, /ctx\.modules/u,
    'the fallback must not touch ctx.modules (U1 unproven; the static arm is the batch decision)')
  // The static fallback must never fabricate sync activity: a `syncing: true` literal would make the
  // page claim a sync that does not exist.
  assert.doesNotMatch(index, /syncing: true/u, 'the fallback never claims a sync in flight')
  assert.match(pluginManagerIndex, /order: 15,/u,
    'the upstream plugins-link settings.section stays at order 15 (chamber 16 sits directly after the upstream sequence)')
  assert.match(pluginManagerIndex, /settingsEntry/u, 'the order-15 anchor is the upstream Plugins settings link')
  assert.doesNotMatch(index, /settings\.plugins\.tab/u, 'the old inventory-tab embedding is retired')
  assert.match(registration, /children: MANAGER_CHILDREN/u, 'the page children table must be declared')
  assert.match(shell, /id === 'plugin-manager'/u, 'the settings shell needs a nav glyph for the new section id')
})
