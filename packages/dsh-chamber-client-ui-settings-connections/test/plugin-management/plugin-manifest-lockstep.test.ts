/**
 * Browser-side plugin-manifest lockstep (design 21 §3 「单一定义」): the
 * settings-connections diff consumes the ONE definition from the neutral wire
 * package through client-core's browser face — no local path/x-wildcard
 * grammar may exist here.
 *
 * Reference identity proves the face is a pass-through, not a copy; the
 * classifySpec matrix proves the diff's materialize decision IS the shared
 * ruler (including the phase-1 widening: backslash / drive-letter / bare-dot
 * path forms classify like every backend).
 *
 * Run directly: node packages/dsh-chamber-client-ui-settings-connections/test/plugin-management/plugin-manifest-lockstep.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  hasXWildcard as faceHasXWildcard,
  isMaterializedValue as faceIsMaterializedValue,
} from '@dsh-chamber/dsh-chamber-client-core/plugin-manifest'
import {
  hasXWildcard as wireHasXWildcard,
  isMaterializedValue as wireIsMaterializedValue,
} from '../../../dsh-chamber-wire/src/plugin-manifest.ts'
import { classifySpec } from '../../src/client/plugin-diff.ts'

test('client-core face is a pass-through: the same function objects as the wire source', () => {
  assert.equal(faceIsMaterializedValue, wireIsMaterializedValue)
  assert.equal(faceHasXWildcard, wireHasXWildcard)
})

test('classifySpec materialize decision === the shared wire ruler (path matrix)', () => {
  const matrix = [
    // path forms: every one must be materialize on both sides
    'file:../p', 'FILE:/abs/p', 'link:./p', './p', '../p', '.', '..', '/abs/p', '~/p', '~\\p', '~',
    'C:\\p', '\\\\server\\share', 'c:/p',
    // non-path values: registry/ranges/tags/aliases must never be materialize
    '~1.2.0', '^1.2.3', '1.2.3', '>=1.0.0 <2', '1.x', '*', 'latest', 'next', 'beta',
    'workspace:*', 'npm:alias@1.0.0', 'git+https://x/y.git', 'https://x/y.tgz', '.foo', '',
  ]
  for (const spec of matrix) {
    const isMaterializeRow = classifySpec(spec).type === 'materialize'
    assert.equal(isMaterializeRow, wireIsMaterializedValue(spec), spec)
  }
})

test('hasXWildcard parity with the wire definition', () => {
  for (const value of ['x', '1.x', '1.2.x', '^1.x', '~2.x', 'v1.x', '1.2.3', 'latest', 'lexical']) {
    assert.equal(faceHasXWildcard(value), wireHasXWildcard(value), value)
  }
})

test('plugin-diff.ts declares no local path/x-wildcard grammar and imports the face', () => {
  const source = readFileSync(fileURLToPath(new URL('../../src/client/plugin-diff.ts', import.meta.url)), 'utf8')
  assert.match(source, /from '@dsh-chamber\/dsh-chamber-client-core\/plugin-manifest'/,
    'the diff must import the single source through the browser face')
  assert.doesNotMatch(source, /function isPathSpec/, 'the local path grammar was deleted')
  assert.doesNotMatch(source, /function hasXWildcard/, 'the local x-wildcard grammar was deleted')
})
