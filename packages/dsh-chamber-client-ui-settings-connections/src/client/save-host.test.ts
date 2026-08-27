import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { DesktopSshSurface, SshInstanceInput, SshInstanceSpec } from '../global.d.ts'
import { saveHostWithPassword } from './save-host.ts'

const oldHost: SshInstanceSpec = {
  id: 'old', label: 'Old', kind: 'ssh', host: 'old.example.com', user: null,
  sshPort: null, remotePort: 30800, serviceName: null, remoteDshHome: null,
}
const newHost: SshInstanceInput = { id: 'new', label: 'New', host: 'new.example.com', remotePort: 30800 }
const savedNew: SshInstanceSpec = { ...newHost, kind: 'ssh', user: null, sshPort: null, serviceName: null, remoteDshHome: null }

type Bridge = Pick<DesktopSshSurface, 'instances_get' | 'instances_set' | 'set_password'>

/**
 * A bridge replicating the MAIN-PROCESS gate (main.ts desktop_ssh_set_password):
 * set_password REFUSES ids that are not in the current registry
 * ('invalid or unknown instance id') — the new-host password-first order must
 * therefore never reach set_password before the registry write.
 */
function gatedBridge(overrides: {
  initial?: SshInstanceSpec[]
  registry?: (next: SshInstanceInput[]) => SshInstanceSpec[]
  password?: (id: string) => { ok: true } | { error: string } | never
} = {}): Bridge & { calls: string[]; state: SshInstanceSpec[] } {
  const calls: string[] = []
  const state: SshInstanceSpec[] = [...(overrides.initial ?? [oldHost])]
  const registry = overrides.registry ?? ((next) => next.map(input => ({ ...input, kind: 'ssh' as const, user: null, sshPort: null, serviceName: null, remoteDshHome: null })))
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

test('edit: password commits FIRST, then the registry (M9 — password failure leaves the registry untouched)', async () => {
  const bridge = gatedBridge({ password: () => ({ error: 'password write failed' }) })
  const result = await saveHostWithPassword(bridge, [oldHost], [{ ...oldHost, label: 'Old2' }], 'old', 'pw')
  assert.deepEqual(result, { ok: false, instances: [oldHost], error: 'password write failed', metadataCommitted: false })
  assert.deepEqual(bridge.calls, ['set_password'], 'instances_set must not run when the password failed')
  assert.deepEqual(bridge.state, [oldHost])
})

test('edit: success commits password then registry, in that order', async () => {
  const bridge = gatedBridge()
  const edited = { ...oldHost, label: 'Old2' }
  const result = await saveHostWithPassword(bridge, [oldHost], [edited], 'old', 'pw')
  assert.equal(result.ok, true)
  assert.deepEqual(bridge.calls, ['set_password', 'instances_set'])
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
      return next.map(input => ({ ...input, kind: 'ssh' as const, user: null, sshPort: null, serviceName: null, remoteDshHome: null }))
    },
  })
  const result = await saveHostWithPassword(bridge, [oldHost], [oldHost, newHost], 'new', 'pw')
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.metadataCommitted, true)
  assert.deepEqual(result.instances, [oldHost, savedNew])
  assert.match(result.error, /disk full; host metadata rollback failed/)
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
      return next.map(input => ({ ...input, kind: 'ssh' as const, user: null, sshPort: null, serviceName: null, remoteDshHome: null }))
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
