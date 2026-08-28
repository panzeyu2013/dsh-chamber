/**
 * node:test for the boot-row composition (`packages/dsh-client-web/src/boot-rows.ts`)
 * — the chamber per-instance extraRows merge decision (design 09 module D):
 * kernel-adopted entries first (modules / ui-renderer), then the manifest
 * rows minus those two, then the per-instance extra rows. Pure, no DOM —
 * runs under plain node (`pnpm run test:client-web`).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { MODULES_ID, UI_RENDERER_ID, composeBootRows } from '../src/boot-rows.ts'

test('rows: kernel entries lead, manifest follows minus the two, extras last', () => {
  const manifest = ['@deepseek-ai/dsh-client-modules', '@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-ui-renderer', '@deepseek-ai/dsh-client-ui-tool']
  const extras = ['@third-party/plugin-a', '@third-party/plugin-b']
  assert.deepEqual(composeBootRows(manifest, extras), [
    MODULES_ID,
    UI_RENDERER_ID,
    '@deepseek-ai/dsh-client-runtime',
    '@deepseek-ai/dsh-client-ui-tool',
    '@third-party/plugin-a',
    '@third-party/plugin-b',
  ])
})

test('rows: a manifest that already carries the kernel entries deduplicates them', () => {
  const manifest = ['@deepseek-ai/dsh-client-modules', '@deepseek-ai/dsh-client-ui-renderer']
  assert.deepEqual(composeBootRows(manifest), [MODULES_ID, UI_RENDERER_ID])
})

test('rows: no extras yields exactly kernel + manifest', () => {
  assert.deepEqual(composeBootRows(['@deepseek-ai/dsh-client-ui-tool']), [
    MODULES_ID,
    UI_RENDERER_ID,
    '@deepseek-ai/dsh-client-ui-tool',
  ])
})

test('rows: an extra row whose id equals a kernel id is still listed once (union model, first wins in the loader)', () => {
  const rows = composeBootRows([], ['@deepseek-ai/dsh-client-modules'])
  assert.deepEqual(rows, [MODULES_ID, UI_RENDERER_ID, '@deepseek-ai/dsh-client-modules'])
  // order matters for the loader: kernel rows are created first
  assert.equal(rows[0], MODULES_ID)
  assert.equal(rows[1], UI_RENDERER_ID)
})

test('rows: duplicate EXTRA ids collapse; manifest-overlapping extras stay (union model, first wins)', () => {
  const rows = composeBootRows(['pkg-a'], ['pkg-x', 'pkg-x', 'pkg-a'])
  // 'pkg-x' deduped; 'pkg-a' appears once per source (manifest + extra) —
  // the loader creates kernel/manifest rows first and union-first-wins.
  assert.deepEqual(rows, [MODULES_ID, UI_RENDERER_ID, 'pkg-a', 'pkg-x', 'pkg-a'])
})
