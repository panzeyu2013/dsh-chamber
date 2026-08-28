import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bindChamberBootContext } from '../src/chamber-context.ts'

test('bindChamberBootContext binds matching instance and carrier facts to one context', () => {
  const provided: Array<[string, unknown]> = []
  bindChamberBootContext({
    provide(name, value) {
      provided.push([name, value])
    },
  }, { instanceId: 'ssh-host_1', basePath: '/api/i/ssh-host_1', generation: 7 })
  assert.deepEqual(provided, [
    ['chamberInstanceId', 'ssh-host_1'],
    ['chamberConnectionBasePath', '/api/i/ssh-host_1'],
    ['chamberBootGeneration', 7],
  ])
})

test('bindChamberBootContext rejects invalid ids and cross-instance base paths before providing anything', () => {
  const provided: Array<[string, unknown]> = []
  const target = {
    provide(name: string, value: unknown) {
      provided.push([name, value])
    },
  }
  assert.throws(
    () => bindChamberBootContext(target, { instanceId: '../remote', basePath: '/api/i/../remote', generation: 1 }),
    /invalid chamber instance id/,
  )
  assert.throws(
    () => bindChamberBootContext(target, { instanceId: 'ssh-a', basePath: '/api/i/ssh-b', generation: 1 }),
    /chamber routing mismatch/,
  )
  assert.throws(
    () => bindChamberBootContext(target, { instanceId: 'ssh-a', basePath: '/api/i/ssh-a', generation: 0 }),
    /invalid chamber boot generation/,
  )
  assert.deepEqual(provided, [])
})
