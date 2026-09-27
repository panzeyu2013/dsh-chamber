import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerExtraChunkOwners, removeExtraChunkOwners } from '../src/extra-chunk-owners.ts'

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

test('an empty row batch never touches the module system (register half)', () => {
  // The guard shape stays behind the early return: no rows means nothing to own.
  assert.deepEqual(registerExtraChunkOwners({} as never, undefined), [])
  assert.deepEqual(registerExtraChunkOwners({} as never, []), [])
})

test('removeExtraChunkOwners drops live-synced owners, skips unknown ids and is idempotent', () => {
  const boot = row('@app/boot')
  const live = row('@plugin/live')
  const modules = { graphRows: new Map([[boot.id, boot], [live.id, live]]) }

  assert.deepEqual(removeExtraChunkOwners(modules as never, [live.id, '@plugin/absent']), [live.id])
  assert.equal(modules.graphRows.has(live.id), false, 'the removed row stops owning its chunks')
  assert.deepEqual(removeExtraChunkOwners(modules as never, [live.id]), [], 'removal is idempotent')
})

test('removeExtraChunkOwners can delete a boot row: the descriptor authority is register-only (design 09 §3.7 ⑥)', () => {
  const boot = row('@app/boot')
  const modules = { graphRows: new Map([[boot.id, boot]]) }

  assert.deepEqual(removeExtraChunkOwners(modules as never, [boot.id]), [boot.id])
  assert.equal(modules.graphRows.has(boot.id), false, 'a live graph no longer naming the row means the host dropped it')
})

test('a missing upstream chunk-owner index fails loudly on the remove half too', () => {
  assert.throws(
    () => removeExtraChunkOwners({} as never, ['@plugin/with-chunks']),
    /boot-row chunk-owner index/,
  )
})
