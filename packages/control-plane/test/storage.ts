/**
 * Storage protocol (M3/M9 foundation) unit tests — design 04 §6 / 03 §2.1.
 *
 * Covers json-store.ts + catalog.ts: backup-first atomic writes, recovery
 * from .bak with an explicit recovery state, double corruption throwing
 * (never a fake-empty), revision increments, If-Match conflicts, legacy
 * (schemaVersion-less) in-place migration, dropped-row counting, and the
 * serialized mutation queue (parallel mutations never interleave).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createJsonStore, JsonStoreRevisionConflictError } from '../src/json-store.ts'
import { createCatalog, CATALOG_BACKUP_FILE, CATALOG_FILE } from '../src/catalog.ts'
import type { CatalogConnectionRow } from '../src/catalog.ts'

const silentLogger = { log() {}, warn() {}, error() {} }

function tempDir(t: any) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-storage-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function readJson(path: string) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

test('persist is backup-first: a mutation leaves a valid main and a valid .bak', async t => {
  const dir = tempDir(t)
  const path = join(dir, 'doc.json')
  const store = createJsonStore({ filePath: path, logger: silentLogger, initial: { revision: 0, items: [] } })
  store.load()
  await store.mutate((doc: any) => ({ next: { ...doc, items: [...doc.items, 'a'] }, changed: true }))
  const main = readJson(path)
  const backup = readJson(`${path}.bak`)
  assert.deepEqual(main, { revision: 1, items: ['a'] })
  assert.deepEqual(backup, main)
  assert.ok((store.getStatus().lastPersistSucceededAt ?? 0) > 0)
  assert.equal(store.getStatus().recoveryState, null)
})

test('a fresh dir loads the initial document with no recovery state', t => {
  const dir = tempDir(t)
  const store = createJsonStore({ filePath: join(dir, 'doc.json'), logger: silentLogger, initial: { revision: 0, items: [] } })
  assert.deepEqual(store.load(), { revision: 0, items: [] })
  const status = store.getStatus()
  assert.equal(status.loaded, true)
  assert.equal(status.recoveryState, null)
})

test('corrupt main with a valid .bak loads from the backup, recovery state visible, main not rewritten', async t => {
  const dir = tempDir(t)
  const path = join(dir, 'doc.json')
  const store = createJsonStore({ filePath: path, logger: silentLogger, initial: { revision: 0, items: [] } })
  store.load()
  await store.mutate(doc => ({ next: { ...doc, items: ['kept'] }, changed: true }))
  writeFileSync(path, '{corrupt')
  const reopened = createJsonStore({ filePath: path, logger: silentLogger, initial: { revision: 0, items: [] } })
  assert.deepEqual(reopened.load(), { revision: 1, items: ['kept'] })
  const status = reopened.getStatus()
  assert.equal(status.recoveryState!.source, 'backup')
  assert.equal(readFileSync(path, 'utf8'), '{corrupt')
})

test('double corruption throws instead of faking an empty document', t => {
  const dir = tempDir(t)
  const path = join(dir, 'doc.json')
  writeFileSync(path, 'nope')
  writeFileSync(`${path}.bak`, 'nope')
  const store = createJsonStore({ filePath: path, logger: silentLogger, initial: { revision: 0, items: [] } })
  assert.throws(() => store.load(), /corrupt/)
})

test('missing main with an unreadable .bak starts from initial with recovery visible', t => {
  const dir = tempDir(t)
  const path = join(dir, 'doc.json')
  writeFileSync(`${path}.bak`, 'broken')
  const store = createJsonStore({ filePath: path, logger: silentLogger, initial: { revision: 0, items: [] } })
  assert.deepEqual(store.load(), { revision: 0, items: [] })
  assert.equal(store.getStatus().recoveryState!.source, 'initial')
})

test('revision increments on every changed mutation only', async t => {
  const dir = tempDir(t)
  const store = createJsonStore({ filePath: join(dir, 'doc.json'), logger: silentLogger, initial: { revision: 0, n: 0 } })
  store.load()
  await store.mutate((doc: any) => ({ next: { ...doc, n: 1 }, changed: true }))
  await store.mutate((doc: any) => ({ next: doc, changed: false }))
  await store.mutate((doc: any) => ({ next: { ...doc, n: 3 }, changed: true }))
  const snap = await store.getSnapshot()
  assert.equal(snap.revision, 2)
  assert.equal(snap.n, 3)
})

test('mutateIfMatch throws a typed revision conflict on mismatch and passes on match', async t => {
  const dir = tempDir(t)
  const store = createJsonStore({ filePath: join(dir, 'doc.json'), logger: silentLogger, initial: { revision: 0, n: 0 } })
  store.load()
  await store.mutate((doc: any) => ({ next: { ...doc, n: 1 }, changed: true }))
  await assert.rejects(
    () => store.mutateIfMatch(0, (doc: any) => ({ next: { ...doc, n: 2 }, changed: true })),
    JsonStoreRevisionConflictError,
  )
  const result = await store.mutateIfMatch(1, (doc: any) => ({ next: { ...doc, n: 2 }, changed: true }))
  assert.equal(result.changed, true)
  const snap = await store.getSnapshot()
  assert.equal(snap.revision, 2)
  assert.equal(snap.n, 2)
})

test('legacy schemaVersion-less catalog migrates in place with connections preserved and v1 kept as .bak', t => {
  const dir = tempDir(t)
  const file = join(dir, CATALOG_FILE)
  const v1 = {
    connections: [{ connectionId: 'local', kind: 'local', status: 'ready', dshPort: 17510 }],
    // Thin-shell-era projects array: stripped at load (v4 has no project table).
    projects: [{ projectId: 'w1', connectionId: 'local', name: 'W', canonicalPath: '/tmp/w', sessionCount: 2 }],
  }
  writeFileSync(file, `${JSON.stringify(v1, undefined, 2)}\n`)
  const catalog = createCatalog({ stateDir: dir, logger: silentLogger })
  const { connections } = catalog.load()
  assert.equal(connections.length, 1)
  const main = readJson(file)
  assert.equal(main.schemaVersion, 2)
  assert.equal(main.revision, 0)
  assert.deepEqual(main.connections, v1.connections)
  assert.equal(main.projects, undefined)
  assert.deepEqual(main.migration, { legacyProjectsImported: false, pendingConnectionIds: [] })
  const backup = readJson(join(dir, CATALOG_BACKUP_FILE))
  assert.equal(backup.schemaVersion, undefined)
  assert.deepEqual(backup.connections, v1.connections)
  assert.equal(catalog.snapshotHealth().recoveryState, null)
})

test('invalid rows are dropped with counts surfaced in the recovery state', t => {
  const dir = tempDir(t)
  const file = join(dir, CATALOG_FILE)
  writeFileSync(file, `${JSON.stringify({
    schemaVersion: 2,
    revision: 3,
    connections: [
      { connectionId: 'local', kind: 'local', status: 'ready' },
      { connectionId: 'local', kind: 'local', status: 'ready' },
      { connectionId: '', kind: 'local' },
      { kind: 'local' },
      // v4: non-local kinds are dropped (remote instances live in the
      // desktop registry, never the catalog).
      { connectionId: 'ssh-1', kind: 'ssh', status: 'ready' },
    ],
  }, undefined, 2)}\n`)
  const catalog = createCatalog({ stateDir: dir, logger: silentLogger })
  catalog.load()
  assert.equal(catalog.listConnections().length, 1)
  assert.equal(catalog.listConnections()[0].connectionId, 'local')
  const health = catalog.snapshotHealth()
  assert.deepEqual(health.dropped, { connections: 4, projects: 0 })
  assert.equal(health.recoveryState!.source, 'main')
  assert.equal(health.recoveryState!.dropped.connections, 4)
})

test('serialized queue: 50 parallel mutations do not interleave or lose updates', async t => {
  const dir = tempDir(t)
  const path = join(dir, 'doc.json')
  const store = createJsonStore({ filePath: path, logger: silentLogger, initial: { revision: 0, counter: 0 } })
  store.load()
  const tasks = Array.from({ length: 50 }, () =>
    store.mutate((doc: any) => ({ next: { ...doc, counter: doc.counter + 1 }, changed: true })))
  await Promise.all(tasks)
  const snap = await store.getSnapshot()
  assert.equal(snap.counter, 50)
  assert.equal(snap.revision, 50)
  assert.equal(readJson(path).counter, 50)
})

test('catalog rows keep the wire shapes across persist and reload', async t => {
  const dir = tempDir(t)
  const catalog = createCatalog({ stateDir: dir, logger: silentLogger })
  catalog.load()
  const row: CatalogConnectionRow = { connectionId: 'local', kind: 'local', status: 'starting', dshPort: null }
  catalog.upsertConnection(row)
  row.status = 'ready'
  row.dshPort = 17510
  catalog.upsertConnection(row)
  assert.equal(catalog.removeConnection('missing'), false)
  await catalog.save()
  const reopened = createCatalog({ stateDir: dir, logger: silentLogger })
  const { connections } = reopened.load()
  assert.deepEqual(connections, [{ connectionId: 'local', kind: 'local', status: 'ready', dshPort: 17510 }])
  assert.equal(readJson(join(dir, CATALOG_FILE)).revision, 2)
})

test('catalog mutate surfaces the If-Match conflict as catalog_revision_conflict', async t => {
  const dir = tempDir(t)
  const catalog = createCatalog({ stateDir: dir, logger: silentLogger })
  catalog.load()
  catalog.upsertConnection({ connectionId: 'local', kind: 'local', status: 'starting' })
  await catalog.mutate(undefined, (doc: any) => ({ next: { ...doc, connections: [...doc.connections] }, changed: true }))
  await assert.rejects(
    () => catalog.mutate(0, (doc: any) => ({ next: doc, changed: false })),
    error => error instanceof JsonStoreRevisionConflictError
      && error.code === 'catalog_revision_conflict'
      && error.message === 'revision conflict',
  )
})

test('updateConnectionFields edits label/accentColor only, leaves the rest untouched', async t => {
  const dir = tempDir(t)
  const catalog = createCatalog({ stateDir: dir, logger: silentLogger })
  catalog.load()
  catalog.upsertConnection({ connectionId: 'local', kind: 'local', status: 'ready', label: 'old', dshPort: 17510 })
  const outcome = catalog.updateConnectionFields('local', { label: 'Local dsh', accentColor: '#1a1a2e' })
  assert.equal(outcome?.updated, true)
  const row = catalog.getConnection('local')!
  assert.equal(row.label, 'Local dsh')
  assert.equal(row.accentColor, '#1a1a2e')
  assert.equal(row.status, 'ready')
  assert.equal(row.dshPort, 17510)
  await catalog.save()
  const reopened = createCatalog({ stateDir: dir, logger: silentLogger })
  reopened.load()
  assert.equal(reopened.getConnection('local')!.accentColor, '#1a1a2e')
})
