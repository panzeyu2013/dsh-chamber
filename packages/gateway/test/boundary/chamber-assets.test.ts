/**
 * Gateway browser-app asset fixtures (2026-12 audit F2 split): the embedded
 * control panel (HTML + script) and the mobile light surface now live in
 * chamber-assets.ts. These checks pin the structural contract the split must
 * keep: served shape, the single interpolation (dashboard semver helpers),
 * the id contract between the HTML and the script's byId() lookups, and that
 * the script stays parseable and inlinable (no leftover ${, no </script).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { transformSync } from 'esbuild'
import { CHAMBER_APP_HTML, CHAMBER_APP_JS, MOBILE_HTML } from '../../src/chamber-assets.ts'

test('app assets keep the served shape (doctype, one script tag, mobile surface)', () => {
  assert.ok(CHAMBER_APP_HTML.startsWith('<!doctype html>'), 'the app page keeps its doctype')
  assert.ok(CHAMBER_APP_HTML.trimEnd().endsWith('</html>'), 'the app page is a complete document')
  assert.equal((CHAMBER_APP_HTML.match(/<script/g) ?? []).length, 1, 'exactly one script tag')
  assert.ok(CHAMBER_APP_HTML.includes('src="/chamber/app.js"'), 'the script is served, never inlined')
  assert.ok(MOBILE_HTML.startsWith('<!doctype html>'), 'the mobile surface keeps its doctype')
  assert.ok(MOBILE_HTML.includes('name="viewport"'), 'the mobile surface keeps its viewport meta')
  assert.ok(MOBILE_HTML.includes('/?desktop=1'), 'the mobile escape hatch is preserved (dispatch.ts 4.5)')
})

test('the script embeds the dashboard semver helpers with no leftover interpolation', () => {
  assert.ok(CHAMBER_APP_JS.startsWith('(function () {'), 'the script stays one IIFE')
  assert.ok(CHAMBER_APP_JS.includes('semverNumericCompare'), 'the interpolated comparator landed')
  assert.ok(CHAMBER_APP_JS.includes('semverCompare'), 'the interpolated comparator landed')
  assert.ok(!CHAMBER_APP_JS.includes('${'), 'no un-interpolated template slot survives')
  assert.ok(!CHAMBER_APP_JS.includes('DASHBOARD_SEMVER_JS'), 'the helper name is not leaked into the asset')
  assert.ok(!CHAMBER_APP_JS.includes('</script'), 'the script stays safely inlinable')
})

test('every byId() the script uses is declared by the served HTML (fixture contract)', () => {
  const referenced = [...CHAMBER_APP_JS.matchAll(/byId\('([^']+)'\)/g)].map(match => match[1])
  const declared = new Set([...CHAMBER_APP_HTML.matchAll(/id="([^"]+)"/g)].map(match => match[1]))
  const missing = [...new Set(referenced)].filter(id => !declared.has(id))
  assert.equal(referenced.length > 0, true, 'the script still resolves elements through byId()')
  assert.deepEqual(missing, [], 'every byId() target is declared in the HTML')
})

test('the script parses as JavaScript (esbuild loader, no execution)', () => {
  const parsed = transformSync(CHAMBER_APP_JS, { loader: 'js' })
  assert.ok(parsed.code.includes('semverCompare'), 'the parsed output keeps the helper call sites')
})
