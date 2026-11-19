/**
 * Shell boot binding (roster D2): shell.ts records the transport word each boot was started
 * with, and the roster commit planner compares it with the authoritative row to decide ONE
 * narrow remount (a transport MECHANISM switch; the source is never retired). These tests
 * pin the memory table's lifecycle — written at the boot generation, deleted by both dispose
 * primitives — and that a remount (dispose + new boot) updates the binding while the
 * displaced generation's late settle stays fenced off.
 *
 * Shared harness: test/support/shell-harness.ts.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  __testQueueRunGate, bootInstanceShell, disposeAllShells, disposeInstanceShell,
  shellModule, shellTestScope, testSourceFingerprint,
} from '../support/shell-harness.ts'

/** Boot with an explicit transport word (the harness wrapper pins the shipped default). */
function bootWithTransport(
  instanceId: string,
  transport: 'ssh' | 'http',
): ReturnType<typeof bootInstanceShell> {
  return shellModule.bootInstanceShell(
    instanceId, `/api/i/${instanceId}`, {} as HTMLElement, () => {},
    testSourceFingerprint(instanceId), transport,
    { retry: { sleep: async () => {} } },
  )
}

test('bootTransports: the boot entry binds the word and both dispose primitives delete it', async (t) => {
  shellTestScope(t, { graph: 'ready', timers: false })
  const first = 'ssh-test-boot-binding-1'
  const second = 'ssh-test-boot-binding-2'
  assert.equal(shellModule.bootTransportOf(first), null, 'no boot attempt = no binding')
  const firstBoot = bootWithTransport(first, 'ssh')
  // The binding is written synchronously at the boot entry (a queued/in-flight attempt counts,
  // so the planner sees the attempt binding instead of missing the switch).
  assert.equal(shellModule.bootTransportOf(first), 'ssh')
  assert.equal((await firstBoot).booted, true)
  assert.equal(shellModule.bootTransportOf(first), 'ssh', 'the settled shell keeps its word')
  const secondBoot = bootWithTransport(second, 'http')
  assert.equal(shellModule.bootTransportOf(second), 'http')
  assert.equal((await secondBoot).booted, true)
  // Per-id dispose drops that binding and only that one.
  disposeInstanceShell(first)
  assert.equal(shellModule.bootTransportOf(first), null, 'per-id dispose drops the binding')
  assert.equal(shellModule.bootTransportOf(second), 'http', 'an unrelated shell keeps its word')
  // Page teardown clears every remaining binding.
  disposeAllShells()
  assert.equal(shellModule.bootTransportOf(first), null)
  assert.equal(shellModule.bootTransportOf(second), null, 'page teardown clears every binding')
})

test('a remount updates the binding and the displaced boot settle cannot rewrite it', async (t) => {
  const instanceId = 'ssh-test-boot-binding-remount-3'
  shellTestScope(t, { graph: 'ready', timers: false })
  const firstGate = __testQueueRunGate('binding-ssh')
  let secondGate: ReturnType<typeof __testQueueRunGate> | undefined
  let firstBoot: ReturnType<typeof bootInstanceShell> | undefined
  let secondBoot: ReturnType<typeof bootInstanceShell> | undefined
  try {
    firstBoot = bootWithTransport(instanceId, 'ssh')
    await firstGate.started
    assert.equal(shellModule.bootTransportOf(instanceId), 'ssh')
    // The narrow remount sink's shape: dispose the old shell, then a replacement boot under the
    // authoritative word. The old boot is still in flight here (its settle is fenced).
    disposeInstanceShell(instanceId)
    assert.equal(shellModule.bootTransportOf(instanceId), null,
      'dispose deletes the binding before the replacement boot')
    secondGate = __testQueueRunGate('binding-http')
    secondBoot = bootWithTransport(instanceId, 'http')
    assert.equal(shellModule.bootTransportOf(instanceId), 'http',
      'the replacement attempt binds at its own entry')
    secondGate.release()
    firstGate.release()
    const displaced = await firstBoot
    assert.equal(displaced.booted, false, 'the displaced generation settles as a failure')
    assert.match(displaced.error ?? '', /superseded/,
      'the old generation is fenced by the boot generation, never published')
    assert.equal(shellModule.bootTransportOf(instanceId), 'http',
      'a late old settle never rewrites the replacement binding')
    const settled = await secondBoot
    assert.equal(settled.booted, true)
    assert.equal(shellModule.bootTransportOf(instanceId), 'http')
    disposeInstanceShell(instanceId)
    assert.equal(shellModule.bootTransportOf(instanceId), null,
      'per-id dispose drops the binding (a re-add boots from its own row)')
  } finally {
    firstGate.release()
    secondGate?.release()
    disposeAllShells()
    await Promise.allSettled([
      ...(firstBoot === undefined ? [] : [firstBoot]),
      ...(secondBoot === undefined ? [] : [secondBoot]),
    ])
  }
})
