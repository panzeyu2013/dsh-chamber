/**
 * dist ↔ src lockstep (design 18 §9.1 packaging discipline): the committed
 * dist/index.js artifact must expose exactly the same named exports as the
 * source entry AND carry the same constant VALUES — a stale bundle whose
 * export names survive but whose probe-contract constants (probe sets,
 * settings cap, …) or activation semantics drifted would otherwise pass the
 * name check while desktop/gateway (which import the package main → dist)
 * keep executing the old semantics. Catches a stale bundle after a
 * src/index.ts edit that was not followed by
 * `pnpm run build:dsh-runtime`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROBE_NAMES_WITHOUT_HOST_DOMAINS, REQUIRED_ACTIVATION_PROBES } from '../src/activation-gate.ts'
import { HOST_DOMAIN_PROBE_NAMES } from '../src/activation-gate.ts'
import { SETTINGS_FILE_MAX_BYTES } from '../src/runtime-probes.ts'

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

test('dist/index.js carries the CURRENT probe-contract constant values (value-level lockstep)', async () => {
  const dist = await import('../dist/index.js' as string) as Record<string, unknown>
  const constCases: Array<[string, unknown]> = [
    ['REQUIRED_ACTIVATION_PROBES', REQUIRED_ACTIVATION_PROBES],
    ['HOST_DOMAIN_PROBE_NAMES', HOST_DOMAIN_PROBE_NAMES],
    ['PROBE_NAMES_WITHOUT_HOST_DOMAINS', PROBE_NAMES_WITHOUT_HOST_DOMAINS],
    ['SETTINGS_FILE_MAX_BYTES', SETTINGS_FILE_MAX_BYTES],
  ]
  for (const [name, expected] of constCases) {
    assert.deepEqual(dist[name], expected, `${name} drifted in the committed dist — rebuild with \`pnpm run build:dsh-runtime\``)
  }
  // Behavioural marker: the identity probe name must be part of the closed
  // activation set (a stale pre-migration bundle carries session/list +
  // data.sessions instead).
  const required = dist.REQUIRED_ACTIVATION_PROBES as readonly string[]
  assert.equal(required.includes('session/canOpenWorkspacePath'), true,
    'the committed dist predates the identity probe — rebuild with `pnpm run build:dsh-runtime`')
  assert.equal(required.includes('session/list'), false,
    'the committed dist still probes session/list — rebuild with `pnpm run build:dsh-runtime`')
  assert.equal(required.includes('data.sessions'), false,
    'the committed dist still carries data.sessions — rebuild with `pnpm run build:dsh-runtime`')
})

test('the committed dist artifact exists on disk (gitignore exception)', () => {
  const files = readdirSync(join(here, '..', 'dist'))
  assert.ok(files.includes('index.js'), 'dist/index.js missing')
})
