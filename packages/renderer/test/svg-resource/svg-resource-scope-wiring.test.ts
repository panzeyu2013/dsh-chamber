/**
 * Wiring locks for the document-level SVG resource-id scoper (design 05 §4.2).
 *
 * `main.tsx` renders (and the scoper installs into) the whole page, so neither can
 * be imported by a plain `node test/…` run; the rule itself is proved in
 * svg-resource-scope.test.ts. What is pinned here is the call order and the two
 * properties a future refactor could silently drop:
 *   1. the scoper is installed BEFORE React mounts (a shell booting first would
 *      paint its icons under the old, duplicate-id regime);
 *   2. the default observer watches the whole body subtree (instance shells AND
 *      the body-level portals of the hover card / settings panel);
 *   3. the rename面 stays resource-only — no aria/for/id attribute may appear in
 *      the module's code (a11y ids must never be renamed).
 * Source-text locks match comment-stripped, normalized source, so a comment
 * cannot satisfy them and formatting cannot break them.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { normalize, stripComments } from '../support/source-text.ts'

/** Comment-stripped, whitespace-collapsed source: the semantic text of a file. */
const read = (rel: string): string =>
  normalize(stripComments(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')))

test('main.tsx installs the scoper before it mounts React', () => {
  const source = read('../../src/main.tsx')
  const install = source.indexOf('installSvgResourceScope()')
  const mount = source.indexOf('createRoot(')
  assert.notEqual(install, -1, 'main.tsx must install the SVG resource scoper')
  assert.notEqual(mount, -1, 'main.tsx must mount React')
  assert.ok(install < mount, 'installSvgResourceScope() must run before createRoot(…)')
})

test('the default observer covers the whole body subtree (shells + body portals)', () => {
  const source = read('../../src/svg-resource-scope.ts')
  assert.ok(source.includes('childList: true, subtree: true'), 'default observer options changed')
  assert.ok(source.includes('document.body'), 'default root must stay document.body')
})

test('the default flush runs before the first paint (microtask, never rAF)', () => {
  const source = read('../../src/svg-resource-scope.ts')
  assert.ok(source.includes('queueMicrotask(run)'), 'default scheduler must be a microtask')
  assert.ok(
    !source.includes('requestAnimationFrame('),
    'rAF is throttled in occluded WKWebViews: scoping after the first paint cannot heal the shape',
  )
})

test('the source-text locks really are comment-stripped (not satisfied by comments)', () => {
  const source = read('../../src/svg-resource-scope.ts')
  // '宁可少改' / '克隆件' only ever appear in COMMENTS of the module. If the shared
  // stripComments helper loses the regex/quote state again, these phrases come back and
  // this lock fails loudly instead of the locks below quietly going vacuous.
  assert.ok(!source.includes('宁可少改'), 'comment text survived stripping: the locks below would be vacuous')
  assert.ok(!source.includes('克隆件'), 'comment text survived stripping: the clone comment must be stripped too')
})

test('the rename面 stays resource-only and the module stays framework-free', () => {
  const source = read('../../src/svg-resource-scope.ts')
  for (const attribute of ["'clip-path'", "'mask'", "'filter'", "'fill'", "'stroke'", "'style'"]) {
    assert.ok(source.includes(attribute), 'resource attribute face must keep ' + attribute)
  }
  // aria / form ids are read ONLY to preserve them (never to rename them); the rename face
  // itself stays the resource attribute list asserted above.
  assert.ok(source.includes('ID_REFERENCE_ATTRIBUTES'), 'a11y id references must be collected to preserve them')
  assert.ok(
    !/RESOURCE_REFERENCE_ATTRIBUTES = \[[^\]]*aria/.test(source),
    'no aria attribute may enter the rename face',
  )
  assert.ok(!source.includes('import '), 'the scoper must stay framework-free (no imports)')
})
