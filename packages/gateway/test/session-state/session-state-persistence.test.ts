/**
 * Session-state persistence: createJsonStore semantics (main -> .bak ->
 * initial, corrupt is never empty, 0600 leaves under 0700), cursor durability,
 * gap candidates across a restart, limit accounting and the privacy whitelist
 * (plan W1 / WS-B, blueprint sections 4.3/5.2/7).
 *
 * Run directly:
 *   node --import ./test/session-state/workspace-loader.mjs test/session-state/session-state-persistence.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  MAX_SESSIONS,
  READ_MARK_TTL_MS,
  SESSION_STATE_DIR_NAME,
  SESSION_STATE_FILE_NAME,
  createSessionStateStore,
} from '../../src/session-state.ts'
import { baselineItem, capturingLogger, scratch, silentLogger } from './harness.ts'

function stateFile(stateDir: string): string {
  return join(stateDir, SESSION_STATE_DIR_NAME, SESSION_STATE_FILE_NAME)
}

test('the snapshot is 0600 inside a 0700 directory (posix)', async t => {
  const stateDir = scratch(t)
  const store = createSessionStateStore({ stateDir, logger: silentLogger, now: () => 100 })
  store.applyBaseline([baselineItem('s1', true, 5)], { at: 100 })
  await store.flush()
  if (process.platform !== 'win32') {
    assert.equal(statSync(join(stateDir, SESSION_STATE_DIR_NAME)).mode & 0o777, 0o700)
    assert.equal(statSync(stateFile(stateDir)).mode & 0o777, 0o600)
  }
  store.dispose()
})

test('reload preserves the cursor, rows, completion classification and read marks', async t => {
  const stateDir = scratch(t)
  const first = createSessionStateStore({ stateDir, logger: silentLogger, now: () => 100 })
  first.applyBaseline([baselineItem('s1', true, 5)], { at: 100 })
  first.applyStatus('s1', false, 110)
  first.settleCompletion('s1', { at: 110, turnEnd: { kind: 'completed', cause: null, at: 110, seq: 7 }, source: 'observed', unreadable: false })
  first.markRead('install-1', 's1', 110, 120)
  first.markAllRead('install-1', 500, 121)
  const cursor = first.status().cursor
  await first.flush()
  first.dispose()

  const second = createSessionStateStore({ stateDir, logger: silentLogger, now: () => 200 })
  assert.equal(second.status().integrity, 'ok')
  assert.equal(second.status().cursor, cursor, 'the cursor must not fall back across a restart')
  const row = second.snapshotFor(null, 'sse', second.host()).sessions[0]
  assert.equal(row.completedAt, 110)
  assert.equal(row.completedAtSource, 'observed')
  assert.equal(row.lastTurnEnd?.seq, 7)
  const read = second.readStateFor('install-1')
  assert.equal(read.marks['s1'], 110)
  assert.equal(read.floor, 500)
})

test('a stored running row stays a gap candidate across a restart until classified', async t => {
  const stateDir = scratch(t)
  const first = createSessionStateStore({ stateDir, logger: silentLogger, now: () => 100 })
  first.applyBaseline([baselineItem('s1', true, 5)], { at: 100 })
  await first.flush()
  first.dispose()

  const second = createSessionStateStore({ stateDir, logger: silentLogger, now: () => 200 })
  const edges = second.applyBaseline([baselineItem('s1', false, 5)], { at: 200 })
  assert.deepEqual(edges, [{ sessionId: 's1', source: 'reconstructed' }])
  assert.equal(second.snapshotFor(null, 'sse', second.host()).sessions[0].completedAt, null)
})

test('a corrupt main falls back to the backup with an explicit recovery state', async t => {
  const stateDir = scratch(t)
  const first = createSessionStateStore({ stateDir, logger: silentLogger, now: () => 100 })
  first.applyBaseline([baselineItem('durable', false, 5)], { at: 100 })
  await first.flush()
  first.dispose()
  // createJsonStore persists backup-first (the backup holds the new document),
  // so the last durable document survives a corrupted main.
  writeFileSync(stateFile(stateDir), 'this is not json')
  const recovered = createSessionStateStore({ stateDir, logger: silentLogger, now: () => 300 })
  assert.equal(recovered.status().integrity, 'recovered')
  assert.match(recovered.status().recoveryDetail ?? '', /backup/)
  const ids = recovered.snapshotFor(null, 'sse', recovered.host()).sessions.map(row => row.sessionId)
  assert.equal(ids.includes('durable'), true)
})

test('double corruption is sticky, loud and never overwritten', async t => {
  const stateDir = scratch(t)
  const store = createSessionStateStore({ stateDir, logger: silentLogger, now: () => 100 })
  store.applyBaseline([baselineItem('s1', false, 5)], { at: 100 })
  await store.flush()
  store.dispose()
  writeFileSync(stateFile(stateDir), 'broken-main')
  writeFileSync(stateFile(stateDir) + '.bak', 'broken-backup')
  const before = readFileSync(stateFile(stateDir), 'utf8')

  const logger = capturingLogger()
  const corrupt = createSessionStateStore({ stateDir, logger, now: () => 200 })
  assert.equal(corrupt.status().integrity, 'corrupt')
  assert.equal(corrupt.status().loaded, false)
  assert.match(corrupt.status().recoveryDetail ?? '', /broken|unsupported|JSON/i)
  assert.equal(corrupt.snapshotFor(null, 'sse', corrupt.host()).sessions.length, 0)
  corrupt.applyBaseline([baselineItem('s2', false, 5)], { at: 200 })
  await corrupt.flush()
  assert.equal(readFileSync(stateFile(stateDir), 'utf8'), before, 'the damaged evidence must not be overwritten')
  assert.equal(logger.lines.some(line => line.includes('will NOT be overwritten')), true, 'corruption stays loud')
})

test('a schemaVersion-less document is corruption, not an empty state', async t => {
  const stateDir = scratch(t)
  const directory = join(stateDir, SESSION_STATE_DIR_NAME)
  const { ensurePrivateDirectoryNoFollow } = await import('@dsh-chamber/control-plane')
  ensurePrivateDirectoryNoFollow(directory, 0o700)
  writeFileSync(stateFile(stateDir), JSON.stringify({ sessions: [{ sessionId: 'legacy' }] }))
  const store = createSessionStateStore({ stateDir, logger: silentLogger, now: () => 100 })
  assert.equal(store.status().integrity, 'corrupt')
})

test('unreadable rows are dropped with a loud counter, never silently', async t => {
  const stateDir = scratch(t)
  const { ensurePrivateDirectoryNoFollow } = await import('@dsh-chamber/control-plane')
  const directory = join(stateDir, SESSION_STATE_DIR_NAME)
  ensurePrivateDirectoryNoFollow(directory, 0o700)
  writeFileSync(stateFile(stateDir), JSON.stringify({
    schemaVersion: 1,
    revision: 1,
    cursor: 3,
    watcherEpoch: 'e',
    mode: 'poll',
    host: { state: 'unknown', serviceable: false, since: 1, lastBaselineAt: null, baselineOk: false },
    sessions: [
      { sessionId: '' },
      { sessionId: 's1', running: false, updatedAt: 4, present: true, observedAt: 5 },
    ],
    readMarks: {},
    readFloor: 0,
    dropped: { sessions: 0, readClients: 0, readMarks: 0 },
  }))
  const logger = capturingLogger()
  const store = createSessionStateStore({ stateDir, logger, now: () => 100 })
  assert.equal(store.status().integrity, 'ok', 'a readable main with bad rows is not a corrupt file')
  assert.equal(store.status().dropped.sessions, 1)
  assert.equal(store.snapshotFor(null, 'sse', store.host()).sessions.length, 1)
  assert.equal(logger.lines.some(line => line.includes('dropped 1 unreadable session row')), true)
})

test('the row cap evicts the oldest rows and counts the loss', async t => {
  const stateDir = scratch(t)
  const logger = capturingLogger()
  const store = createSessionStateStore({ stateDir, logger, now: () => 100 })
  const items = Array.from({ length: MAX_SESSIONS + 1 }, (_, index) => baselineItem('s' + index, false, index + 1))
  store.applyBaseline(items, { at: 100 })
  await store.flush()
  assert.equal(store.status().sessions, MAX_SESSIONS)
  assert.equal(store.status().dropped.sessions, 1)
  assert.equal(logger.lines.some(line => line.includes('cap reached')), true)
})

test('read-mark clients expire on TTL and the drop is counted', async t => {
  const stateDir = scratch(t)
  const start = 1_000
  const first = createSessionStateStore({ stateDir, logger: silentLogger, now: () => start })
  first.applyBaseline([baselineItem('s1', false, 5)], { at: start })
  first.markRead('install-old', 's1', 500, start)
  await first.flush()
  first.dispose()

  const later = createSessionStateStore({ stateDir, logger: silentLogger, now: () => start + READ_MARK_TTL_MS + 1 })
  assert.deepEqual(later.readStateFor(null).marks, {})
  assert.equal(later.status().dropped.readClients >= 1, true)
})

test('the persisted document carries only session ids and state metadata (privacy whitelist)', async t => {
  const stateDir = scratch(t)
  const store = createSessionStateStore({ stateDir, logger: silentLogger, now: () => 100 })
  // Feed a hostile baseline row carrying every sensitive field session/list
  // could hold; the store must persist none of them.
  const hostile = baselineItem('s1', false, 5, {
    title: 'TOP-SECRET-TITLE',
    cwd: '/TOP-SECRET-CWD',
    todos: [{ text: 'TOP-SECRET-TODO' }],
    agentPreset: 'TOP-SECRET-PRESET',
    projections: { values: { secret: 'TOP-SECRET-PROJECTION' } },
  })
  store.applyBaseline([hostile as never], { at: 100 })
  store.applyPending('s1', 'approval', 101)
  await store.flush()
  store.dispose()
  const text = readFileSync(stateFile(stateDir), 'utf8')
  for (const secret of ['TOP-SECRET-TITLE', 'TOP-SECRET-CWD', 'TOP-SECRET-TODO', 'TOP-SECRET-PRESET', 'TOP-SECRET-PROJECTION']) {
    assert.equal(text.includes(secret), false, secret + ' must never reach the snapshot')
  }
  const document = JSON.parse(text) as { sessions: Array<Record<string, unknown>> }
  assert.deepEqual(Object.keys(document.sessions[0]).sort(), [
    'completedAt', 'completedAtSource', 'error', 'lastRunningAt', 'lastTurnEnd', 'observedAt',
    'origin', 'parentSessionId', 'pendingKind', 'pendingSince', 'present', 'running', 'sessionId',
    'subagentCount', 'updatedAt',
  ])
})
