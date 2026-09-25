/**
 * Base-path normalization lock (design 05 §6): the api-gateway fork's
 * `RemoteStreamMuxClient` normalizes its per-entry base path with the SAME rule
 * as `resolveInstanceBasePath` (packages/dsh-client-connection/src/api-path.ts).
 * It cannot import it: the connection package exports only `.`/`./client`, its
 * `src/index.ts` is a [pure] upstream copy (a new export face there would need a
 * registry reclassification), and this fork file is deliberately import-light.
 * This suite therefore pins the shared rule from BOTH sides — the source
 * expressions and the runtime behaviour over one table — so a one-sided edit
 * (trailing-slash stripping, the empty/`/api` collapse) fails loud.
 *
 * Run directly: node --experimental-transform-types --import ./test/support/register-vendor-stubs.mjs test/patch-lock/base-path-normalization-lock.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { RemoteStreamMuxClient } from '../../src/client/stream-client.ts'
import { resolveInstanceBasePath } from '../../../dsh-client-connection/src/api-path.ts'

const clientSource = readFileSync(new URL('../../src/client/stream-client.ts', import.meta.url), 'utf8')
const apiPathSource = readFileSync(new URL('../../../dsh-client-connection/src/api-path.ts', import.meta.url), 'utf8')

/** The private normalized field, read structurally. */
const basePathOf = (value?: string): string =>
  (new RemoteStreamMuxClient(value) as unknown as { basePath: string }).basePath

test('both sides spell the same normalization rule', () => {
  assert.ok(clientSource.includes("const normalized = basePath.replace(/\\/+$/, '')"),
    'stream-client.ts must strip trailing slashes')
  assert.ok(clientSource.includes("this.basePath = normalized === '' || normalized === '/api' ? '' : normalized"),
    'stream-client.ts must collapse empty and the stock /api to the no-prefix form')
  assert.ok(apiPathSource.includes("const base = (explicit ?? '').replace(/\\/+$/, '')"),
    'api-path.ts must strip trailing slashes')
  assert.ok(apiPathSource.includes("return base === '' || base === API_PATH ? '' : base"),
    'api-path.ts must collapse empty and API_PATH to the no-prefix form')
})

test('the fork constructor agrees with resolveInstanceBasePath across the domain', () => {
  for (const value of [undefined, '', '/', '///', '/api', '/api/', '//api//', '/api/i/local', '/api/i/local/', '/api/i/local//', 'api/i/local']) {
    assert.equal(basePathOf(value), resolveInstanceBasePath(value), JSON.stringify(value))
  }
})
