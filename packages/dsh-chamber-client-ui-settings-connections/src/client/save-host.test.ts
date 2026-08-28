import { test } from 'node:test'
import assert from 'node:assert/strict'
import type {
  DesktopSshSurface,
  SshInstanceInput,
  SshInstanceSpec,
  SshPasswordSubmission,
} from '../global.d.ts'
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

type Bridge = Pick<DesktopSshSurface, 'instances_set'>
type Call = { instances: SshInstanceInput[]; password: SshPasswordSubmission | undefined }

/** Main-like atomic bridge: only publish state after the registry/password
 * commit callback succeeds. */
function atomicBridge(overrides: {
  initial?: SshInstanceSpec[]
  commit?: (
    next: SshInstanceSpec[],
    password: SshPasswordSubmission | undefined,
  ) => SshInstanceSpec[]
} = {}): Bridge & { calls: Call[]; state: SshInstanceSpec[] } {
  const calls: Call[] = []
  const state = [...(overrides.initial ?? [oldHost])]
  return {
    calls,
    state,
    instances_set: async (instances, password) => {
      calls.push({ instances, password })
      const proposed = instances.map(project)
      const committed = overrides.commit?.(proposed, password) ?? proposed
      state.splice(0, state.length, ...committed)
      return [...state]
    },
  }
}

test('edit with a replacement password is one atomic instances_set IPC', async () => {
  const bridge = atomicBridge()
  const edited = { ...oldHost, host: 'moved.example.com' }
  const result = await saveHostWithPassword(bridge, [oldHost], [edited], 'old', 'new-password')
  assert.equal(result.ok, true)
  assert.equal(bridge.calls.length, 1)
  assert.deepEqual(bridge.calls[0].password, { id: 'old', password: 'new-password' })
  assert.equal(bridge.state[0].host, 'moved.example.com')
})

test('a password-store failure rejects the one IPC and leaves the old registry visible', async () => {
  const bridge = atomicBridge({
    commit: () => { throw new Error('password write failed') },
  })
  const result = await saveHostWithPassword(
    bridge,
    [oldHost],
    [{ ...oldHost, host: 'moved.example.com' }],
    'old',
    'new-password',
  )
  assert.deepEqual(result, { ok: false, instances: [oldHost], error: 'password write failed' })
  assert.equal(bridge.calls.length, 1)
  assert.deepEqual(bridge.state, [oldHost])
})

test('new host and password are submitted in the same registry call', async () => {
  const bridge = atomicBridge()
  const result = await saveHostWithPassword(bridge, [oldHost], [oldHost, newHost], 'new', 'pw')
  assert.equal(result.ok, true)
  assert.equal(bridge.calls.length, 1)
  assert.deepEqual(bridge.calls[0].password, { id: 'new', password: 'pw' })
  assert.deepEqual(bridge.state.map(instance => instance.id), ['old', 'new'])
})

test('empty password omits the replacement while committing registry metadata', async () => {
  const bridge = atomicBridge()
  const result = await saveHostWithPassword(bridge, [oldHost], [{ ...oldHost, label: 'Edited' }], 'old', '')
  assert.equal(result.ok, true)
  assert.equal(bridge.calls.length, 1)
  assert.equal(bridge.calls[0].password, undefined)
})
