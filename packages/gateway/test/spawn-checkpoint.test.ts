/**
 * Design 21 §6.3 (decisions 6/17) — beforeSpawnCheckpoint wiring tests. The
 * checkpoint is the production closure the gateway passes as
 * localConnectionDeps.beforeSpawnCheckpoint into createControlPlane: a pure
 * factory over a lazy manager reference, so this file tests the exact closure
 * shape without a control plane.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPluginWriteCheckpoint } from '../src/spawn-checkpoint.ts'
import type { GatewayRuntimeManager } from '../src/runtime-manager.ts'

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
