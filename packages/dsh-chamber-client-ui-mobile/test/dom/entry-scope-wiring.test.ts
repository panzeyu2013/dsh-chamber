/**
 * Wiring locks for the mobile client entry's SVG resource scoper install
 * (design 05 §4.2). This is the mobile mirror of
 * packages/renderer/test/svg-resource/svg-resource-scope-wiring.test.ts, whose
 * `install < createRoot` lock is the desktop counterpart.
 *
 * The entry cannot be imported by a plain `node test/…` run (module-scope DOM
 * install + cordis vendor imports), so what is pinned here is the source-text
 * contract a future refactor could silently drop:
 *   1. installSvgResourceScope() is called at MODULE SCOPE — before
 *      `export function apply`, i.e. before the shell can be adapted and before
 *      any official icon can paint;
 *   2. exactly one install exists and it is not tier-gated;
 *   3. the scoper is IMPORTED from the renderer source (single implementation),
 *      never reimplemented or copied into this package.
 * Source locks match comment-stripped source, so prose cannot satisfy them.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SOURCE = readFileSync(new URL('../../src/client/index.ts', import.meta.url), 'utf8')
/** Comment-stripped: a lock must be satisfied by CODE, never by the prose. */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

test('the client entry installs the scoper at module scope, before apply()', () => {
  const install = CODE.indexOf('installSvgResourceScope()')
  const apply = CODE.indexOf('export function apply')
  assert.notEqual(install, -1, 'the entry must call installSvgResourceScope()')
  assert.notEqual(apply, -1, 'the entry must define apply()')
  assert.ok(install < apply, 'installSvgResourceScope() must run before apply() can adapt the shell')
  const calls = CODE.split('installSvgResourceScope()').length - 1
  assert.equal(calls, 1, `exactly one install call expected, found ${calls}`)
})

test('the install is a top-level statement, not hidden behind a tier branch', () => {
  assert.match(
    SOURCE,
    /^installSvgResourceScope\(\)$/m,
    'the install must be an unindented module-scope statement (no if/matchMedia gate)',
  )
})

test('the scoper stays one implementation, imported from the renderer source', () => {
  assert.match(
    CODE,
    /import \{ installSvgResourceScope \} from '\.\.\/\.\.\/\.\.\/\.\.\/packages\/renderer\/src\/svg-resource-scope\.ts'/,
    'the scoper must be imported from packages/renderer/src/svg-resource-scope.ts',
  )
  assert.ok(
    !CODE.includes('data-chamber-svg-scope'),
    'a local scoper implementation in the entry would duplicate the renderer module',
  )
})
