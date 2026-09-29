/**
 * EMBEDDED PLUGIN PAGE SEAM LOCK (finding M-7/V5-08).
 *
 * The embedded upstream plugin page repeats the settings section title: the
 * chamber shell hides the head row's first block (h1 + the intro beside it).
 * Upstream's structure (rc.1 and rc.2 alike) is  <header data-window-drag><div>
 * <h1>…</h1><div class=pageIntro>…, and pageIntro is a DIV — a tag-pinned
 * selector (h1 + p) missed it once and left the intro visible. Because the
 * vendor class names are CSS-module hashes and the intro has already changed
 * tag once, the hide is anchored to the head row's POSITION (its first child
 * block), never to a tag inside it; this lock pins BOTH sides (the upstream
 * shape we rely on and our selector) so a pin upgrade or a local edit cannot
 * silently reopen the seam.
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

test('the shell hides the head block contents by position (no hashed class names)', () => {
  assert.match(css, /\.embedded \[data-plugin-panel\] > \[data-window-drag\] > :first-child > \* \{/, 'the repeated head block contents shall be hidden')
  assert.match(css, /display: none/, 'the hidden declaration must survive')
})
