/**
 * dist ↔ src lockstep (design 18 §9.1 packaging discipline): the committed
 * dist/index.js artifact must expose exactly the same named exports as the
 * source entry. Catches a stale bundle after a src/index.ts edit that was
 * not followed by `pnpm run build:dsh-runtime`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

test('dist/index.js exports exactly the src/index.ts export set', async () => {
  const src = await import('../src/index.ts') as Record<string, unknown>
  // The committed bundle has no type surface (dist/index.d.ts would be wiped
  // by build.mjs on every rebuild); a string-typed specifier keeps tsc from
  // failing the typecheck:runtime gate on TS7016 (CI runs it).
  const dist = await import('../dist/index.js' as string) as Record<string, unknown>
  const srcKeys = Object.keys(src).sort()
  const distKeys = Object.keys(dist).sort()
  assert.deepEqual(distKeys, srcKeys, 'export sets diverge — rebuild with `pnpm run build:dsh-runtime`')
  for (const key of srcKeys) {
    assert.equal(typeof dist[key], typeof src[key], `export kind diverges for ${key}`)
  }
})

test('the committed dist artifact exists on disk (gitignore exception)', () => {
  const files = readdirSync(join(here, '..', 'dist'))
  assert.ok(files.includes('index.js'), 'dist/index.js missing')
})
