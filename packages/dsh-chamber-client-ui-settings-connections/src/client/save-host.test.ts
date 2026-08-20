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

test('saveHostWithPassword commits metadata and password on success', async () => {
  let setCalls = 0
  const bridge: Bridge = {
    instances_set: async () => { setCalls += 1; return [oldHost, savedNew] },
    instances_get: async () => [oldHost, savedNew],
    set_password: async () => ({ ok: true }),
  }
  const result = await saveHostWithPassword(bridge, [oldHost], [oldHost, newHost], 'new', 'pw')
  assert.equal(result.ok, true)
  assert.equal(setCalls, 1)
})

test('saveHostWithPassword rolls metadata back when password persistence fails', async () => {
  let setCalls = 0
  const bridge: Bridge = {
    instances_set: async () => { setCalls += 1; return setCalls === 1 ? [oldHost, savedNew] : [oldHost] },
    instances_get: async () => [oldHost],
    set_password: async () => ({ error: 'password write failed' }),
  }
  const result = await saveHostWithPassword(bridge, [oldHost], [oldHost, newHost], 'new', 'pw')
  assert.deepEqual(result, { ok: false, instances: [oldHost], error: 'password write failed', metadataCommitted: false })
  assert.equal(setCalls, 2)
})

test('saveHostWithPassword re-reads authoritative state when rollback rejects after taking effect', async () => {
  let setCalls = 0
  const bridge: Bridge = {
    instances_set: async () => {
      setCalls += 1
      if (setCalls === 1) return [oldHost, savedNew]
      throw new Error('password cleanup failed after registry rollback')
    },
    instances_get: async () => [oldHost],
    set_password: async () => { throw new Error('disk full') },
  }
  const result = await saveHostWithPassword(bridge, [oldHost], [oldHost, newHost], 'new', 'pw')
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.metadataCommitted, false)
  assert.deepEqual(result.instances, [oldHost])
  assert.match(result.error, /disk full; host metadata rollback failed/)
})

test('saveHostWithPassword reports a real partial commit so a new host is not blindly duplicated', async () => {
  let setCalls = 0
  const bridge: Bridge = {
    instances_set: async () => {
      setCalls += 1
      if (setCalls === 1) return [oldHost, savedNew]
      throw new Error('registry unavailable')
    },
    instances_get: async () => [oldHost, savedNew],
    set_password: async () => ({ error: 'password denied' }),
  }
  const result = await saveHostWithPassword(bridge, [oldHost], [oldHost, newHost], 'new', 'pw')
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.metadataCommitted, true)
  assert.deepEqual(result.instances, [oldHost, savedNew])
})
