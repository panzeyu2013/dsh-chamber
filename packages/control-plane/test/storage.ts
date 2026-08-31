/**
 * Storage protocol (M3/M9 foundation) unit tests — design 04 §6 / 03 §2.1.
 *
 * Covers json-store.ts + catalog.ts: backup-first atomic writes, recovery
 * from .bak with an explicit recovery state, double corruption throwing
 * (never a fake-empty), revision increments, If-Match conflicts, legacy
 * (schemaVersion-less) in-place migration, dropped-row counting, and the
 * write-through mutation serialization (parallel call sites never lose updates).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn as spawnChild } from 'node:child_process'
import fs, { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createJsonStore, JsonStorePersistError, JsonStoreRevisionConflictError } from '../src/json-store.ts'
import { createCatalog, CATALOG_BACKUP_FILE, CATALOG_FILE } from '../src/catalog.ts'
import type { CatalogConnectionRow } from '../src/catalog.ts'
import { ensureInstanceId } from '../src/instance-id.ts'
import { ensurePrivateDirectoryNoFollow, readPrivateFileNoFollow } from '../src/private-file.ts'

const silentLogger = { log() {}, warn() {}, error() {} }

function tempDir(t: any) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-storage-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function readJson(path: string) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function failAfterDirectoryFsync(target: number, failure: Error): () => void {
  const original = fs.fsyncSync
  let directorySyncs = 0
  fs.fsyncSync = ((fd: number) => {
    const directory = fs.fstatSync(fd).isDirectory()
    original(fd)
    if (directory && ++directorySyncs === target) throw failure
  }) as typeof fs.fsyncSync
  syncBuiltinESMExports()
  return () => {
    fs.fsyncSync = original
    syncBuiltinESMExports()
  }
}

test('private-file requiredMode validates without chmod; tightenMode is explicit migration', t => {
  const dir = tempDir(t)
  const file = join(dir, 'mode-split')
  writeFileSync(file, 'private\n', { mode: 0o644 })
  assert.throws(
    () => readPrivateFileNoFollow(file, { requiredMode: 0o600, maxBytes: 64 }),
    /must have mode 0600/,
  )
  assert.equal(statSync(file).mode & 0o777, 0o644, 'validation-only read must preserve mode')
  assert.equal(readPrivateFileNoFollow(file, {
    tightenMode: 0o600,
    requiredMode: 0o600,
    maxBytes: 64,
  }).value, 'private\n')
  assert.equal(statSync(file).mode & 0o777, 0o600)
})

test('instance-id exclusive create fsyncs the file and its parent directory', { skip: process.platform === 'win32' }, t => {
  const dir = tempDir(t)
  const stateDir = join(dir, 'state')
  const original = fs.fsyncSync
  const synced: Array<'file' | 'directory'> = []
  fs.fsyncSync = ((fd: number) => {
    synced.push(fs.fstatSync(fd).isDirectory() ? 'directory' : 'file')
    original(fd)
  }) as typeof fs.fsyncSync
  syncBuiltinESMExports()
  try {
    const id = ensureInstanceId(stateDir, {
      randomUUID: () => '11111111-1111-4111-8111-111111111111',
    })
    assert.equal(id, '11111111-1111-4111-8111-111111111111')
  } finally {
    fs.fsyncSync = original
    syncBuiltinESMExports()
  }
  assert.deepEqual(synced, ['file', 'directory'])
  assert.equal(statSync(join(stateDir, 'instance-id')).mode & 0o777, 0o600)
})

test('instance-id waits for an O_EXCL winner to finish its visible empty file', async t => {
  const stateDir = tempDir(t)
  const file = join(stateDir, 'instance-id')
  const winner = '22222222-2222-4222-8222-222222222222'
  const childScript = [
    "import { closeSync, fsyncSync, openSync, writeFileSync } from 'node:fs'",
    `const fd = openSync(${JSON.stringify(file)}, 'wx', 0o600)`,
    "process.send?.('opened')",
    'setTimeout(() => {',
    `  writeFileSync(fd, ${JSON.stringify(`${winner}\n`)})`,
    '  fsyncSync(fd)',
    '  closeSync(fd)',
    '}, 75)',
  ].join('\n')
  const child = spawnChild(process.execPath, ['--input-type=module', '-e', childScript], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  })
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL') })
  let stderr = ''
  child.stderr!.setEncoding('utf8')
  child.stderr!.on('data', chunk => { stderr += chunk })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`competitor did not open instance-id: ${stderr}`)), 3_000)
    child.once('message', () => {
      clearTimeout(timer)
      resolve()
    })
    child.once('error', reject)
    child.once('exit', code => {
      if (code !== 0) reject(new Error(`competitor exited ${code}: ${stderr}`))
    })
  })
  const id = ensureInstanceId(stateDir, {
    randomUUID: () => '33333333-3333-4333-8333-333333333333',
    retryAttempts: 100,
    retryDelayMs: 5,
  })
  assert.equal(id, winner)
  await new Promise<void>((resolve, reject) => {
    if (child.exitCode !== null) return child.exitCode === 0 ? resolve() : reject(new Error(stderr))
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(stderr)))
  })
})

test('instance-id rejects symlinks and bounded/full-width invalid evidence without mutation or delay', t => {
  const stateDir = tempDir(t)
  const victim = join(stateDir, 'victim')
  const file = join(stateDir, 'instance-id')
  writeFileSync(victim, '44444444-4444-4444-8444-444444444444\n', { mode: 0o644 })
  try {
    symlinkSync(victim, file, 'file')
  } catch (error) {
    if (['EPERM', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      t.skip('symbolic links are unavailable on this platform')
      return
    }
    throw error
  }
  assert.throws(() => ensureInstanceId(stateDir, { retryAttempts: 0 }), /unsafe/)
  assert.equal(readFileSync(victim, 'utf8'), '44444444-4444-4444-8444-444444444444\n')
  assert.equal(statSync(victim).mode & 0o777, 0o644)

  rmSync(file)
  writeFileSync(file, 'z'.repeat(36), { mode: 0o600 })
  let sleeps = 0
  assert.throws(
    () => ensureInstanceId(stateDir, { retryAttempts: 50, sleep: () => { sleeps += 1 } }),
    /exactly one UUID/,
  )
  assert.equal(sleeps, 0, 'a full-width invalid value is not a competing partial write')

  writeFileSync(file, 'x'.repeat(129), { mode: 0o600 })
  assert.throws(() => ensureInstanceId(stateDir, { retryAttempts: 0 }), /exceeds its read bound/)
})

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
  const defaultMode = 0o666 & ~process.umask()
  assert.equal(statSync(path).mode & 0o777, defaultMode, 'an omitted fileMode preserves the process umask')
  assert.equal(statSync(`${path}.bak`).mode & 0o777, defaultMode)
  assert.ok((store.getStatus().lastPersistSucceededAt ?? 0) > 0)
  assert.equal(store.getStatus().recoveryState, null)
})

test('fileMode hardens legacy files and every persisted document artifact', async t => {
  const dir = tempDir(t)
  const path = join(dir, 'private.json')
  writeFileSync(path, '{"revision":0,"items":[]}\n')
  chmodSync(path, 0o644)
  const store = createJsonStore({
    filePath: path,
    logger: silentLogger,
    initial: { revision: 0, items: [] },
    fileMode: 0o600,
  })
  store.load()
  assert.equal(statSync(path).mode & 0o777, 0o600)
  await store.mutate((doc: any) => ({ next: { ...doc, items: ['secret'] }, changed: true }))
  assert.equal(statSync(path).mode & 0o777, 0o600)
  assert.equal(statSync(`${path}.bak`).mode & 0o777, 0o600)
})

test('atomic JSON persistence never follows predictable temp or backup symlinks', async t => {
  const dir = tempDir(t)
  const path = join(dir, 'private.json')
  const tempVictim = join(dir, 'temp-victim')
  const backupVictim = join(dir, 'backup-victim')
  writeFileSync(tempVictim, 'DO NOT TOUCH TEMP', { mode: 0o644 })
  writeFileSync(backupVictim, 'DO NOT TOUCH BACKUP', { mode: 0o644 })
  try {
    // The legacy writer used this predictable name. The random O_EXCL writer
    // must ignore it rather than opening/truncating its target.
    symlinkSync(tempVictim, `${path}.tmp`, 'file')
  } catch (error) {
    if (['EPERM', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      t.skip('symbolic links are unavailable on this platform')
      return
    }
    throw error
  }
  const store = createJsonStore({ filePath: path, logger: silentLogger, initial: { revision: 0, items: [] }, fileMode: 0o600 })
  store.load()
  await store.mutate((doc: any) => ({ next: { ...doc, items: ['safe'] }, changed: true }))
  assert.equal(readFileSync(tempVictim, 'utf8'), 'DO NOT TOUCH TEMP')
  assert.equal(statSync(tempVictim).mode & 0o777, 0o644)
  assert.equal(existsSync(`${path}.tmp`), true, 'unowned legacy temp symlink is left untouched')

  rmSync(`${path}.bak`)
  symlinkSync(backupVictim, `${path}.bak`, 'file')
  assert.throws(
    () => store.mutate((doc: any) => ({ next: { ...doc, items: ['must-not-commit'] }, changed: true })),
    JsonStorePersistError,
  )
  assert.equal(readFileSync(backupVictim, 'utf8'), 'DO NOT TOUCH BACKUP')
  assert.equal(statSync(backupVictim).mode & 0o777, 0o644)
  assert.deepEqual(store.getDoc(), { revision: 1, items: ['safe'] })
})

test('a failed mutation persist throws and rolls the in-memory document back', t => {
  const dir = tempDir(t)
  const blocker = join(dir, 'not-a-directory')
  writeFileSync(blocker, 'block')
  const warnings: unknown[] = []
  const store = createJsonStore({
    filePath: join(blocker, 'doc.json'),
    logger: { warn: warning => warnings.push(warning) },
    initial: { revision: 0, items: [] },
  })
  store.load()
  assert.throws(
    () => store.mutate((doc: any) => ({ next: { ...doc, items: ['lost'] }, changed: true })),
    (error: unknown) => {
      assert.ok(error instanceof JsonStorePersistError)
      assert.equal(error.onlinePublished, false)
      assert.equal(error.durabilityUnknown, false)
      return true
    },
  )
  assert.deepEqual(store.getDoc(), { revision: 0, items: [] })
  assert.equal(store.getStatus().lastPersistSucceededAt, null)
  assert.equal(warnings.length, 1)
})

test('a post-publish fsync error stays loud but retains the exact online revision', async t => {
  const dir = tempDir(t)
  const path = join(dir, 'doc.json')
  const store = createJsonStore({ filePath: path, logger: silentLogger, initial: { revision: 0, counter: 0 } })
  store.load()
  const injected = new Error('injected failure after published parent fsync')
  const restoreFsync = failAfterDirectoryFsync(2, injected)
  let observed: unknown = null
  try {
    store.mutate((doc: any) => ({ next: { ...doc, counter: doc.counter + 1 }, changed: true }))
    assert.fail('the durability-unknown mutation must still throw')
  } catch (error) {
    observed = error
  } finally {
    restoreFsync()
  }

  assert.ok(observed instanceof JsonStorePersistError)
  assert.equal(observed.onlinePublished, true)
  assert.equal(observed.durabilityUnknown, true)
  assert.equal(observed.cause, injected)
  assert.deepEqual(store.getDoc(), { revision: 1, counter: 1 })
  assert.deepEqual(readJson(path), { revision: 1, counter: 1 })
  assert.equal(store.getStatus().lastPersistSucceededAt, null)

  await assert.rejects(
    store.mutateIfMatch(0, (doc: any) => ({ next: { ...doc, counter: doc.counter + 1 }, changed: true })),
    JsonStoreRevisionConflictError,
  )
  await store.mutateIfMatch(1, (doc: any) => ({ next: { ...doc, counter: doc.counter + 1 }, changed: true }))
  assert.deepEqual(store.getDoc(), { revision: 2, counter: 2 })
  assert.deepEqual(readJson(path), { revision: 2, counter: 2 })
})

test('catalog synchronous row APIs propagate persist failure and keep no phantom row', t => {
  const dir = tempDir(t)
  const catalog = createCatalog({ stateDir: dir, logger: silentLogger })
  catalog.load()
  rmSync(dir, { recursive: true, force: true })
  writeFileSync(dir, 'block')
  assert.throws(
    () => catalog.upsertConnection({ connectionId: 'local', kind: 'local', label: 'Local dsh' }),
    JsonStorePersistError,
  )
  assert.equal(catalog.getConnection('local'), null)
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

test('missing main with a corrupt .bak fails loudly and preserves the recovery evidence', t => {
  const dir = tempDir(t)
  const path = join(dir, 'doc.json')
  writeFileSync(`${path}.bak`, 'broken')
  const store = createJsonStore({ filePath: path, logger: silentLogger, initial: { revision: 0, items: [] } })
  assert.throws(() => store.load(), /missing.*backup.*corrupt or unsafe/)
  assert.equal(existsSync(path), false)
  assert.equal(readFileSync(`${path}.bak`, 'utf8'), 'broken')
})

test('missing main with an unsafe .bak fails loudly without following its target', t => {
  const dir = tempDir(t)
  const path = join(dir, 'doc.json')
  const victim = join(dir, 'backup-victim.json')
  const victimText = '{"revision":77,"items":["evidence"]}\n'
  writeFileSync(victim, victimText)
  try {
    symlinkSync(victim, `${path}.bak`, 'file')
  } catch (error) {
    if (['EPERM', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      t.skip('symbolic links are unavailable on this platform')
      return
    }
    throw error
  }
  const store = createJsonStore({ filePath: path, logger: silentLogger, initial: { revision: 0, items: [] } })
  assert.throws(() => store.load(), /missing.*backup.*corrupt or unsafe/)
  assert.equal(existsSync(path), false)
  assert.equal(readFileSync(victim, 'utf8'), victimText)
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
    connections: [{
      connectionId: 'local', kind: 'local', label: 'Local dsh',
      status: 'ready', dshPort: 17510, error: 'legacy runtime detail',
    }],
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
  assert.deepEqual(main.connections, [{ connectionId: 'local', kind: 'local', label: 'Local dsh' }])
  assert.equal(main.projects, undefined)
  assert.deepEqual(main.migration, { legacyProjectsImported: false, pendingConnectionIds: [] })
  const backup = readJson(join(dir, CATALOG_BACKUP_FILE))
  assert.equal(backup.schemaVersion, undefined)
  assert.deepEqual(backup.connections, v1.connections)
  assert.deepEqual(catalog.getConnection('local'), { connectionId: 'local', kind: 'local', label: 'Local dsh' })
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
  // The surviving valid row is readable and narrowed to durable metadata;
  // dropped rows are gone from memory (drop counts live in recovery status;
  // the v2 file is rewritten only by the next write-through mutation).
  assert.deepEqual(catalog.getConnection('local'), { connectionId: 'local', kind: 'local' })
  assert.equal(catalog.getConnection('ssh-1'), null)
  assert.equal(catalog.getConnection(''), null)
})

test('write-through transactions: 50 parallel callers do not interleave or lose updates', async t => {
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

test('catalog persists durable metadata only and strips supplied runtime projections', async t => {
  const dir = tempDir(t)
  const catalog = createCatalog({ stateDir: dir, logger: silentLogger })
  catalog.load()
  const row: CatalogConnectionRow & { status: string; dshPort: number; error: string } = {
    connectionId: 'local',
    kind: 'local',
    label: 'Local dsh',
    accentColor: '#1a1a2e',
    status: 'ready',
    dshPort: 17510,
    error: 'must not persist',
  }
  catalog.upsertConnection(row)
  const reopened = createCatalog({ stateDir: dir, logger: silentLogger })
  const { connections } = reopened.load()
  assert.deepEqual(connections, [{
    connectionId: 'local', kind: 'local', label: 'Local dsh', accentColor: '#1a1a2e',
  }])
  const persisted = readJson(join(dir, CATALOG_FILE))
  assert.equal(persisted.revision, 1)
  assert.equal('status' in persisted.connections[0], false)
  assert.equal('dshPort' in persisted.connections[0], false)
  assert.equal('error' in persisted.connections[0], false)
})

test('updateConnectionFields edits only label/accentColor and rejects runtime projections', async t => {
  const dir = tempDir(t)
  const catalog = createCatalog({ stateDir: dir, logger: silentLogger })
  catalog.load()
  catalog.upsertConnection({ connectionId: 'local', kind: 'local', label: 'old' })
  const outcome = catalog.updateConnectionFields('local', { label: 'Local dsh', accentColor: '#1a1a2e' })
  assert.equal(outcome?.updated, true)
  const row = catalog.getConnection('local')!
  assert.equal(row.label, 'Local dsh')
  assert.equal(row.accentColor, '#1a1a2e')
  assert.throws(
    () => catalog.updateConnectionFields('local', { status: 'ready' } as any),
    (error: Error & { code?: string }) => error.code === 'catalog_invalid_input',
  )
  const reopened = createCatalog({ stateDir: dir, logger: silentLogger })
  reopened.load()
  assert.equal(reopened.getConnection('local')!.accentColor, '#1a1a2e')
})

test('json-store creates missing parent directories at 0700', async t => {
  const dir = tempDir(t)
  const path = join(dir, 'nested', 'doc.json')
  const store = createJsonStore({
    filePath: path,
    logger: silentLogger,
    initial: { revision: 0, items: [] },
    fileMode: 0o600,
  })
  store.load()
  await store.mutate((doc: any) => ({ next: { ...doc, items: ['x'] }, changed: true }))
  assert.equal(statSync(join(dir, 'nested')).mode & 0o777, 0o700, 'missing parent chain must be created 0700')
  assert.equal(statSync(path).mode & 0o777, 0o600)
  assert.equal(statSync(`${path}.bak`).mode & 0o777, 0o600)
})

test('private-directory primitive converges fresh/loose dirs and honors require/preserve', t => {
  const dir = tempDir(t)
  const fresh = join(dir, 'fresh')
  ensurePrivateDirectoryNoFollow(fresh)
  assert.equal(statSync(fresh).mode & 0o777, 0o700, 'fresh directory is created 0700')

  const loose = join(dir, 'loose')
  mkdirSync(loose, { mode: 0o755 })
  ensurePrivateDirectoryNoFollow(loose)
  assert.equal(statSync(loose).mode & 0o777, 0o700, 'a loose pre-existing directory is tightened by default')

  const required = join(dir, 'required')
  mkdirSync(required, { mode: 0o755 })
  assert.throws(
    () => ensurePrivateDirectoryNoFollow(required, 0o700, { existingMode: 'require' }),
    /must already have mode 0700/,
  )
  assert.equal(statSync(required).mode & 0o777, 0o755, 'require refuses without touching the loose directory')

  const preserved = join(dir, 'preserved')
  mkdirSync(preserved, { mode: 0o755 })
  ensurePrivateDirectoryNoFollow(preserved, 0o700, { existingMode: 'preserve' })
  assert.equal(statSync(preserved).mode & 0o777, 0o755, 'preserve leaves an existing loose directory untouched')

  const target = join(dir, 'symlink-target')
  const link = join(dir, 'symlink-leaf')
  mkdirSync(target, { mode: 0o755 })
  try {
    symlinkSync(target, link, 'dir')
  } catch (error) {
    if (['EPERM', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      t.skip('symbolic links are unavailable on this platform')
      return
    }
    throw error
  }
  assert.throws(() => ensurePrivateDirectoryNoFollow(link), /not a real directory/)
  assert.equal(statSync(target).mode & 0o777, 0o755, 'a symlinked leaf is refused without touching its target')
})
