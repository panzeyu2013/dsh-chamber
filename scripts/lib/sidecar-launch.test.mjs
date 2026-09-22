/**
 * The shared sidecar launch plumbing (scripts/lib/sidecar-launch.mjs): the
 * free-port picker and the launch argv/env both the compiled-sidecar smoke gate
 * and the GUI-acceptance native leg use.
 *
 * Run directly: node scripts/lib/sidecar-launch.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { SIDECAR_COMPILED_ENV, freeLoopbackPort, sidecarLaunchArgs, sidecarLaunchEnv } from './sidecar-launch.mjs'

const bind = port => new Promise((resolveBind, rejectBind) => {
  const server = createServer()
  server.once('error', rejectBind)
  server.listen(port, '127.0.0.1', () => server.close(() => resolveBind(true)))
})

test('freeLoopbackPort hands back a port that is genuinely free again', async () => {
  const first = await freeLoopbackPort()
  assert.ok(Number.isInteger(first) && first > 0, 'a real ephemeral port')
  // The picker closes its probe socket before resolving: the caller must be able
  // to bind the port itself (the sidecar does exactly that).
  assert.equal(await bind(first), true)
  const second = await freeLoopbackPort()
  assert.notEqual(second, first, 'two calls must not hand back the same port')
})

test('the launch argv is the contract both legs pass to the sidecar', () => {
  assert.deepEqual(
    sidecarLaunchArgs({ userDataDir: '/tmp/u', port: 12345 }),
    ['--user-data-dir', '/tmp/u', '--port', '12345'],
  )
})

test('the launch env carries the compiled marker, the node-as-electron flag and the update opt-out', () => {
  assert.deepEqual(sidecarLaunchEnv({ KEEP: '1' }), {
    KEEP: '1',
    [SIDECAR_COMPILED_ENV]: '1',
    ELECTRON_RUN_AS_NODE: '1',
    DSH_SIDECAR_TEST_NO_UPDATE_CHECK: '1',
  })
  assert.equal(SIDECAR_COMPILED_ENV, 'DSH_CHAMBER_SIDECAR_COMPILED')
})
