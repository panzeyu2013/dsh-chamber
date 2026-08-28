import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { DesktopSshSurface, SshInstanceInput, SshInstanceSpec } from '../global.d.ts'
import { saveHostWithPassword } from './save-host.ts'

const oldHost: SshInstanceSpec = {
  id: 'old', label: 'Old', kind: 'ssh', host: 'old.example.com', user: null,
  sshPort: null, remotePort: 30800, serviceName: null, remoteDshHome: null,
  sourceFingerprint: 'a'.repeat(64),
}
const newHost: SshInstanceInput = { id: 'new', label: 'New', host: 'new.example.com', remotePort: 30800 }
function project(input: SshInstanceInput): SshInstanceSpec {
  return {
    ...input,
    kind: 'ssh',
    user: input.user ?? null,
    sshPort: input.sshPort ?? null,
    serviceName: input.serviceName ?? null,
    remoteDshHome: input.remoteDshHome ?? null,
    sourceFingerprint: (input.id === 'old' ? 'a' : 'b').repeat(64),
  }
}
const savedNew: SshInstanceSpec = project(newHost)

type Bridge = Pick<DesktopSshSurface, 'instances_get' | 'instances_set' | 'set_password'>

/**
 * A bridge replicating the MAIN-PROCESS gate (main.ts desktop_ssh_set_password):
 * set_password REFUSES ids that are not in the current registry
 * ('invalid or unknown instance id') — every save must land and verify the
 * registry before it reaches set_password.
 */
function gatedBridge(overrides: {
  initial?: SshInstanceSpec[]
  registry?: (next: SshInstanceInput[]) => SshInstanceSpec[]
  password?: (id: string) => { ok: true } | { error: string } | never
} = {}): Bridge & { calls: string[]; state: SshInstanceSpec[] } {
  const calls: string[] = []
  const state: SshInstanceSpec[] = [...(overrides.initial ?? [oldHost])]
  const registry = overrides.registry ?? ((next) => next.map(project))
  return {
    calls,
    state,
    instances_get: async () => [...state],
    instances_set: async (next) => {
      calls.push('instances_set')
      // Compute BEFORE mutating state: a throwing registry must leave the
      // committed state intact (the rollback-failure test relies on it).
      const nextState = registry(next)
      state.length = 0
      state.push(...nextState)
      return [...state]
    },
    set_password: async (id) => {
      calls.push('set_password')
      // Main-process gate: unknown ids are refused, never stored.
      if (!state.some(spec => spec.id === id)) return { error: 'invalid or unknown instance id' }
      if (overrides.password !== undefined) return overrides.password(id)
      return { ok: true }
    },
  }
}

test('edit: metadata lands first; password failure restores the previous registry', async () => {
  const bridge = gatedBridge({ password: () => ({ error: 'password write failed' }) })
  const result = await saveHostWithPassword(bridge, [oldHost], [{ ...oldHost, label: 'Old2' }], 'old', 'pw')
  assert.deepEqual(result, { ok: false, instances: [oldHost], error: 'password write failed', metadataCommitted: false })
  assert.deepEqual(bridge.calls, ['instances_set', 'set_password', 'instances_set'])
  assert.deepEqual(bridge.state, [oldHost])
})

test('rollback strips lifecycle proof and accepts a freshly reprojected proof', async () => {
  let registryCalls = 0
  let rollbackInput: SshInstanceInput[] | null = null
  const bridge = gatedBridge({
    password: () => ({ error: 'password write failed' }),
    registry: (next) => {
      registryCalls += 1
      if (registryCalls === 2) rollbackInput = next
      return next.map(input => ({
        ...project(input),
        sourceFingerprint: registryCalls === 2 ? 'c'.repeat(64) : project(input).sourceFingerprint,
      }))
    },
  })
  const result = await saveHostWithPassword(bridge, [oldHost], [{ ...oldHost, label: 'Old2' }], 'old', 'pw')
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.metadataCommitted, false)
  assert.equal(result.instances[0].sourceFingerprint, 'c'.repeat(64))
  assert.equal(Object.hasOwn(rollbackInput?.[0] ?? {}, 'sourceFingerprint'), false)
})

test('edit: success commits registry then password, in that order', async () => {
  const bridge = gatedBridge()
  const edited = { ...oldHost, label: 'Old2' }
  const result = await saveHostWithPassword(bridge, [oldHost], [edited], 'old', 'pw')
  assert.equal(result.ok, true)
  assert.deepEqual(bridge.calls, ['instances_set', 'set_password'])
})

test('new host: the registry lands FIRST (set_password refuses unknown ids), then the password (M9)', async () => {
  const bridge = gatedBridge()
  const result = await saveHostWithPassword(bridge, [oldHost], [oldHost, newHost], 'new', 'pw')
  assert.equal(result.ok, true)
  assert.deepEqual(bridge.calls, ['instances_set', 'set_password'], 'registry before password for a NEW id')
  assert.deepEqual(bridge.state, [oldHost, savedNew])
})

test('new host: a password failure rolls the registry back (design 05 §8 compensation)', async () => {
  const bridge = gatedBridge({ password: () => ({ error: 'password denied' }) })
  const result = await saveHostWithPassword(bridge, [oldHost], [oldHost, newHost], 'new', 'pw')
  assert.deepEqual(result, { ok: false, instances: [oldHost], error: 'password denied', metadataCommitted: false })
  assert.deepEqual(bridge.calls, ['instances_set', 'set_password', 'instances_set'], 'rollback after the password failure')
  assert.deepEqual(bridge.state, [oldHost])
})

test('new host: a failed rollback reports metadataCommitted=true so the form turns the row into an edit target', async () => {
  let registryCalls = 0
  const bridge = gatedBridge({
    password: () => { throw new Error('disk full') },
    registry: (next) => {
      registryCalls += 1
      // First write lands; the ROLLBACK write fails (registry stays committed).
      if (registryCalls >= 2) throw new Error('registry unavailable')
      return next.map(project)
    },
  })
  const result = await saveHostWithPassword(bridge, [oldHost], [oldHost, newHost], 'new', 'pw')
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.metadataCommitted, true)
  assert.deepEqual(result.instances, [oldHost, savedNew])
  assert.match(result.error, /disk full; host metadata rollback failed/)
})

test('new host: a REFUSED rollback is verified and keeps the committed row in edit mode', async () => {
  let registryCalls = 0
  const bridge = gatedBridge({
    password: () => ({ error: 'password denied' }),
    registry: (next) => {
      registryCalls += 1
      if (registryCalls >= 2) return [oldHost, savedNew]
      return next.map(project)
    },
  })
  const result = await saveHostWithPassword(bridge, [oldHost], [oldHost, newHost], 'new', 'pw')
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.metadataCommitted, true)
  assert.deepEqual(result.instances, [oldHost, savedNew])
  assert.match(result.error, /password denied; host metadata rollback was refused/)
  assert.deepEqual(bridge.calls, ['instances_set', 'set_password', 'instances_set'])
})

test('empty password skips set_password entirely and commits the registry', async () => {
  const bridge = gatedBridge()
  const result = await saveHostWithPassword(bridge, [oldHost], [oldHost, newHost], 'new', '')
  assert.equal(result.ok, true)
  assert.deepEqual(bridge.calls, ['instances_set'])
})

test('new host: a ROLLBACK throw must never masquerade as the password error (round-3 review)', async () => {
  let registryCalls = 0
  const bridge = gatedBridge({
    password: () => ({ error: 'password denied' }),
    registry: (next) => {
      registryCalls += 1
      if (registryCalls >= 2) throw new Error('registry unavailable')
      return next.map(project)
    },
  })
  const result = await saveHostWithPassword(bridge, [oldHost], [oldHost, newHost], 'new', 'pw')
  assert.equal(result.ok, false)
  if (result.ok) return
  // The user-visible error must lead with the PASSWORD error, not the
  // rollback error (the pre-fix code swapped them).
  assert.ok(result.error.startsWith('password denied'), `password error preserved: ${result.error}`)
  assert.match(result.error, /host metadata rollback failed/)
  assert.equal(result.metadataCommitted, true)
})

test('new host: a REFUSED registry save (instances_set returns the original list) is a loud failure, not a silent success', async () => {
  const bridge = gatedBridge({ registry: () => [oldHost] }) // 主进程拒绝：返回当前 registry，无错误通道
  const result = await saveHostWithPassword(bridge, [oldHost], [oldHost, newHost], 'new', 'pw')
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.match(result.error, /保存未生效/, `refusal error surfaced: ${result.error}`)
  assert.equal(result.metadataCommitted, false)
  assert.deepEqual(result.instances, [oldHost])
  assert.deepEqual(bridge.calls, ['instances_set'], 'set_password must not run for a save that never landed')
  assert.deepEqual(bridge.state, [oldHost])
})

test('new host: a same-id row with different metadata is not accepted and never receives this form password', async () => {
  const collidingHost: SshInstanceSpec = {
    ...savedNew,
    label: 'Another caller',
    host: 'other.example.com',
  }
  const bridge = gatedBridge({ registry: () => [oldHost, collidingHost] })
  const result = await saveHostWithPassword(bridge, [oldHost], [oldHost, newHost], 'new', 'pw')
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.match(result.error, /保存未生效/)
  assert.equal(result.metadataCommitted, false)
  assert.deepEqual(result.instances, [oldHost, collidingHost])
  assert.deepEqual(bridge.calls, ['instances_set'], 'a colliding row must never receive this form password')
})

test('edit: a REFUSED registry save never reaches the password write', async () => {
  const bridge = gatedBridge({ registry: () => [oldHost] }) // 拒绝编辑：返回旧条目
  const result = await saveHostWithPassword(bridge, [oldHost], [{ ...oldHost, host: 'moved.example.com' }], 'old', 'new-password')
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.match(result.error, /保存未生效/, `refusal error surfaced: ${result.error}`)
  assert.equal(result.metadataCommitted, false)
  assert.deepEqual(bridge.calls, ['instances_set'])
})

test('edit: a throwing registry write leaves the stored password untouched', async () => {
  const bridge = gatedBridge({
    registry: () => { throw new Error('registry disk full') },
  })
  const result = await saveHostWithPassword(
    bridge,
    [oldHost],
    [{ ...oldHost, label: 'Edited' }],
    'old',
    'new-password',
  )
  assert.deepEqual(result, {
    ok: false,
    instances: [oldHost],
    error: 'registry disk full',
    metadataCommitted: false,
  })
  assert.deepEqual(bridge.calls, ['instances_set'], 'set_password must not run after registry persistence failed')
  assert.deepEqual(bridge.state, [oldHost])
})

test('edit: submitting the CURRENT values (no actual change) still reports ok:true', async () => {
  const bridge = gatedBridge()
  const result = await saveHostWithPassword(bridge, [oldHost], [{ ...oldHost }], 'old', '')
  assert.equal(result.ok, true)
  assert.deepEqual(bridge.calls, ['instances_set'])
})
