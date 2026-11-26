/**
 * The page build must define `process.platform`: the vendored cordis loader reads it
 * inside EntryTree.import (vendor/loader/src/config/tree.ts) for its Windows
 * drive-letter branch. Vite folds `process.env.*` but leaves a bare `process`
 * member untouched, so a missing define makes EVERY loader entry import throw
 * `ReferenceError: process is not defined` in the browser — the page boot then
 * reports every row as fiberless ("import failed"). Upstream parity:
 * vendor/harness-checkout/apps/web/vite.config.ts defines the same key.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (relative) => readFileSync(new URL(relative, import.meta.url), 'utf8')

test('renderer vite config defines process.platform for the bundled loader', () => {
  const tree = read('../../../vendor/harness-checkout/vendor/loader/src/config/tree.ts')
  assert.match(tree, /process\.platform/, 'the vendored loader still reads process.platform during entry import')
  // Strip full-line comments first: a commented-out define must NOT satisfy the lock.
  const config = read('../vite.config.mjs').replace(/^\s*\/\/.*$/gm, '')
  assert.match(config, /'process\.platform':\s*'"browser"'/, 'the page build must define process.platform (upstream apps/web parity)')
})
