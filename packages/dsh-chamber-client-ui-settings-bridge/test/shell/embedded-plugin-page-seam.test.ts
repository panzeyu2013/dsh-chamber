/**
 * EMBEDDED PLUGIN PAGE SEAM LOCK (finding M-7/V5-08).
 *
 * The embedded upstream plugin page repeats the settings section title: the
 * chamber shell hides its h1 and the intro that follows. Upstream's structure
 * (rc.1 and rc.2 alike) is  <header data-window-drag><div><h1>…</h1>
 * <div class=pageIntro>…, and pageIntro is a DIV — the earlier selector only
 * covered h1 + p, so the intro stayed visible. Because the vendor class names
 * are CSS-module hashes, the fix must be a structural selector; this lock pins
 * BOTH sides (the upstream shape we rely on and our selector) so a pin upgrade
 * or a local edit cannot silently reopen the seam.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripComments } from '../../../../scripts/dev/test-support/source-text.ts'

const read = (relative: string): string =>
  stripComments(readFileSync(new URL(relative, import.meta.url), 'utf8'))

const page = read('../../../../vendor/harness-checkout/packages/client/ui-plugin-manager/src/client/PluginManagerPage.tsx')
const css = read('../../../dsh-chamber-client-ui-settings-plugin-manager/src/client/EmbeddedPluginManagerPage.module.css')

test('the embedded page keeps the upstream h1 + div.pageIntro shape the shell hides', () => {
  assert.match(page, /data-plugin-panel/, 'the page panel attribute is the seam root')
  assert.match(page, /<header className=\{css\.pageHead\} data-window-drag>/, 'the header row stays a drag row')
  assert.match(page, /<h1 className=\{css\.pageTitle\}>/, 'the page title stays an h1')
  assert.match(page, /<\/h1>\s*<div className=\{css\.pageIntro\}>/, 'the intro is the h1 immediate next sibling and a DIV')
})

test('the shell hides both via a structural selector (no hashed class names)', () => {
  assert.match(css, /\.embedded \[data-plugin-panel\] > \[data-window-drag\] :is\(h1, h1 \+ p, h1 \+ div\) \{/, 'the intro shall be hidden')
  assert.match(css, /display: none/, 'the hidden declaration must survive')
})
