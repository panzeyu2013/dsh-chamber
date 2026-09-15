/**
 * Managed-dsh spawn guards (merged): the two pre-spawn gates on the managed dsh
 * child, carried over verbatim from their source files.
 * - spawn-checkpoint.ts: the beforeSpawnCheckpoint closure the gateway hands to
 *   createControlPlane (design 21 section 6.3, decisions 6/17) - a spawn defers
 *   while a plugin-mutation profile lease is held.
 * - control-plane spawn-dsh.ts: the managed dsh child environment sanitizer -
 *   no gateway credential/config variable may reach the child.
 *
 * Merged from test/spawn-checkpoint.test.ts and test/spawn-env.test.ts.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPluginWriteCheckpoint } from '../../src/spawn-checkpoint.ts'
import type { GatewayRuntimeManager } from '../../src/runtime-manager.ts'
import { sanitizeManagedDshEnv } from '../../../control-plane/src/spawn-dsh.ts'

// --- merged from test/spawn-checkpoint.test.ts ---

/**
 * Design 21 §6.3 (decisions 6/17) — beforeSpawnCheckpoint wiring tests. The
 * checkpoint is the production closure the gateway passes as
 * localConnectionDeps.beforeSpawnCheckpoint into createControlPlane: a pure
 * factory over a lazy manager reference, so this file tests the exact closure
 * shape without a control plane.
 */

test('plugin-write spawn checkpoint: rejects while the profile lease is held, resolves when idle or managerless', async () => {
  const held = { profileWriteInFlight: () => true } as unknown as GatewayRuntimeManager
  const idle = { profileWriteInFlight: () => false } as unknown as GatewayRuntimeManager
  const runtimeManagerRef: { current: GatewayRuntimeManager | null } = { current: held }
  const checkpoint = createPluginWriteCheckpoint(runtimeManagerRef)
  // Held lease: the spawn (start or health restart) must defer — the seed
  // thunk must never interleave the executor's pnpm write on DSH_HOME.
  await assert.rejects(
    checkpoint(),
    /managed profile write in flight \(plugin mutation\); spawn deferred/,
  )
  // Null manager = plane constructed before the manager: no lease can exist.
  runtimeManagerRef.current = null
  await checkpoint()
  // Idle lease: normal spawns proceed.
  runtimeManagerRef.current = idle
  await checkpoint()
})

// --- merged from test/spawn-env.test.ts ---


test('managed dsh child environment strips every gateway credential/config variable', () => {
  const source = {
    PATH: '/bin',
    DSH_GATEWAY_PASSWORD: 'password-secret',
    DSH_GATEWAY_TOKEN: 'token-secret',
    DSH_GATEWAY_PUBLIC_ORIGIN: 'https://gateway.example',
    dsh_gateway_mixed_case_secret: 'windows-secret',
    DSH_CHAMBER_STATE: '/state',
  }
  assert.deepEqual(sanitizeManagedDshEnv(source), {
    PATH: '/bin',
    DSH_CHAMBER_STATE: '/state',
  })
  // Pure copy: sanitizing a child environment never mutates the gateway's own
  // process environment object.
  assert.equal(source.DSH_GATEWAY_TOKEN, 'token-secret')
  assert.equal(source.dsh_gateway_mixed_case_secret, 'windows-secret')
})
