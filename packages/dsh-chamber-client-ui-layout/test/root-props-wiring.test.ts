/**
 * Source-text wiring lock for the root standard props the fork provides.
 *
 * `ctx.slots.provideRoot` is typed loosely through the package's ambient
 * vendor declarations, so dropping or renaming the chamber standard prop would
 * still typecheck while silently starving the renderer's registered ui-chat
 * vendor patch (design 09 §3.6) — the file-API URL would fall back to the
 * control-plane origin and 404. Same discipline as the sidebar's
 * `panel-wiring.test.ts`.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const index = readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8')
const ambient = readFileSync(new URL('../src/vendor-modules.d.ts', import.meta.url), 'utf8')

test('the fork provides the chamber file-API base path as a root standard prop', () => {
  assert.ok(
    index.includes('const chamberFileApiBase = (ctx as ClientContext & { chamberBasePath?: string }).chamberBasePath'),
    'the per-entry base path must be read from the ctx boot fact',
  )
  assert.ok(
    index.includes('props: chamberFileApiBase === undefined ? {} : { chamberFileApiBase },'),
    'the prop must be provided only when the boot fact exists (an official-layout ctx has no chamberBasePath)',
  )
  // The same provideRoot call must keep the panelInfo hook (the usePanelInfo seat).
  assert.ok(index.includes('hooks: { panelInfo },'), 'the panelInfo hook must stay on the same contribution')
})

test('the ambient seat documents the prop', () => {
  assert.ok(ambient.includes('chamberFileApiBase'), 'vendor-modules.d.ts must name the chamber standard prop')
})
