import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerExtraChunkOwners } from '../src/extra-chunk-owners.ts'

const row = (id: string, rev = 'r1') => ({
  id,
  url: `/api/i/local/api/clientGraph/${encodeURIComponent(id)}/client.js?rev=${rev}`,
  initialUrl: `/api/i/local/api/clientGraph/${encodeURIComponent(id)}/client.js?rev=${rev}`,
  rev,
  inject: [],
  external: [],
})

test('extra host rows become package-local chunk owners without replacing boot descriptors', () => {
  const boot = row('@app/boot')
  const modules = { graphRows: new Map([[boot.id, boot]]) }
  const terminal = row('@deepseek-ai/dsh-client-ui-sidebar-terminal')

  assert.deepEqual(registerExtraChunkOwners(modules as never, [terminal, boot]), [terminal.id])
  assert.deepEqual(modules.graphRows.get(terminal.id), terminal)
  assert.equal(modules.graphRows.get(boot.id), boot, 'the initial boot graph remains authoritative')
  assert.deepEqual(registerExtraChunkOwners(modules as never, [row(terminal.id, 'r2')]), [], 'registration is idempotent')
  assert.equal(modules.graphRows.get(terminal.id)?.rev, 'r1')
})

test('a missing upstream chunk-owner index fails loudly at the shell boundary', () => {
  assert.throws(
    () => registerExtraChunkOwners({} as never, [row('@plugin/with-chunks')]),
    /boot-row chunk-owner index/,
  )
})

test('a remote host row keeps its dynamic-chunk owner on that source proxy', () => {
  const id = '@deepseek-ai/dsh-client-ui-sidebar-terminal'
  const basePath = '/api/i/ssh-remote'
  const rev = 'remote-rev'
  const url = `${basePath}/plugins/??${id}/client.js&rev=${rev}`
  const remoteRow = { id, url, initialUrl: url, rev, inject: [], external: [] }
  const modules = { graphRows: new Map() }

  assert.deepEqual(registerExtraChunkOwners(modules as never, [remoteRow]), [id])
  assert.deepEqual(modules.graphRows.get(id), remoteRow)
  assert.match(modules.graphRows.get(id)?.url ?? '', new RegExp(`^${basePath}/`))
})
