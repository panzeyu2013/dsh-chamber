/**
 * Real-Cordis regression for the public client-plugin context contract v1
 * (design 09 §4): a per-entry chamberBasePath is visible to a child plugin's
 * apply(ctx) through Cordis get(), and a native (non-chamber) context exposes
 * no value. The value-shape/rejection cases live in
 * test/lifecycle/chamber-base-path-contract.test.ts; this file covers the
 * framework provide/get join the fake-context tests cannot.
 *
 * Runs under --experimental-transform-types (vendored Cordis source uses
 * parameter properties) plus the shell and Cordis source loaders. A missing
 * vendor tree fails with an explicit hint instead of a bare module-not-found.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CORDIS_SRC = fileURLToPath(new URL('../../../vendor/harness-packages/@deepseek-ai/cordis/src/index.ts', import.meta.url))
const COSMOKIT_SRC = fileURLToPath(new URL('../../../vendor/harness-packages/@deepseek-ai/cosmokit/src/index.ts', import.meta.url))
assert.ok(
  existsSync(CORDIS_SRC) && existsSync(COSMOKIT_SRC),
  'real-Cordis contract test needs the pinned vendor sources; run node scripts/dev/bootstrap/ensure-harness-vendor.mjs',
)

const { Context } = await import('@deepseek-ai/cordis')
const { createChamberContextSetup } = await import('../src/shell.ts')

const tick = () => new Promise(resolve => setTimeout(resolve, 20))

test('real Cordis: a child plugin apply sees its own per-entry base path', async () => {
  const local = new Context()
  createChamberContextSetup('local', '/api/i/local', 'local', 'local')(local)
  const ssh = new Context()
  createChamberContextSetup('ssh-a', '/api/i/ssh-a', 'ab'.repeat(32), 'ssh')(ssh)

  let seenLocal
  let seenSsh
  local.plugin({ name: 'local-probe', apply(child) { seenLocal = child.get('chamberBasePath') } })
  ssh.plugin({ name: 'ssh-probe', apply(child) { seenSsh = child.get('chamberBasePath') } })
  await tick()

  assert.equal(seenLocal, '/api/i/local')
  assert.equal(seenSsh, '/api/i/ssh-a')
})

test('real Cordis: a native context has no base path and the property read is not a fallback', async () => {
  const native = new Context()
  let get
  let propertyRead
  native.plugin({
    name: 'native-probe',
    apply(child) {
      get = child.get('chamberBasePath')
      try {
        propertyRead = child.chamberBasePath
      } catch (error) {
        propertyRead = error
      }
    },
  })
  await tick()

  assert.equal(get, undefined, 'a native dsh host must leave the service absent')
  assert.ok(propertyRead instanceof Error, 'an uninjected property read must throw, not return undefined')
  assert.match(String(propertyRead), /inject|cannot get property/i)
})
