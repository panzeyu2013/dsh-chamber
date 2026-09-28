/**
 * Session-state persistence: createJsonStore semantics (main -> .bak ->
 * initial, corrupt is never empty, 0600 leaves under 0700), cursor durability,
 * gap candidates across a restart, limit accounting and the privacy whitelist.
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

test('reload preserves the cursor, rows and completion classification', async t => {
  const stateDir = scratch(t)
  const first = createSessionStateStore({ stateDir, logger: silentLogger, now: () => 100 })
  first.applyBaseline([baselineItem('s1', true, 5)], { at: 100 })
  const [edge] = first.applyStatus('s1', false, 110)
  first.settleCompletion(edge!, { at: 110, turnEnd: { kind: 'completed', cause: null, at: 110, seq: 7 }, unreadable: false })
  const cursor = first.status().cursor
  await first.flush()
  first.dispose()

  const second = createSessionStateStore({ stateDir, logger: silentLogger, now: () => 200 })
  assert.equal(second.status().integrity, 'ok')
  assert.equal(second.status().cursor, cursor, 'the cursor must not fall back across a restart')
  const row = second.snapshotFor('sse', second.host()).sessions[0]
  assert.equal(row.completedAt, 110)
  assert.equal(row.completedAtSource, 'observed')
  assert.equal(row.lastTurnEnd?.seq, 7)
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
  assert.equal(second.snapshotFor('sse', second.host()).sessions[0].completedAt, null)
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
  const ids = recovered.snapshotFor('sse', recovered.host()).sessions.map(row => row.sessionId)
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
  assert.equal(corrupt.snapshotFor('sse', corrupt.host()).sessions.length, 0)
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
      { sessionId: 's1', running: false, updatedAt: 4, present: true, observedAt: 5, originKnown: true },
    ],
    dropped: { sessions: 0, goalActivations: 0 },
  }))
  const logger = capturingLogger()
  const store = createSessionStateStore({ stateDir, logger, now: () => 100 })
  assert.equal(store.status().integrity, 'ok', 'a readable main with bad rows is not a corrupt file')
  assert.equal(store.status().dropped.sessions, 1)
  assert.equal(store.snapshotFor('sse', store.host()).sessions.length, 1)
  assert.equal(logger.lines.some(line => line.includes('dropped 1 unreadable session row')), true)
})

test('process-local dropped counters restart at 0 on reload (normalization, not a persisted read)', async t => {
  const stateDir = scratch(t)
  const { ensurePrivateDirectoryNoFollow } = await import('@dsh-chamber/control-plane')
  const directory = join(stateDir, SESSION_STATE_DIR_NAME)
  ensurePrivateDirectoryNoFollow(directory, 0o700)
  // A document written by a previous run carries non-zero process-local counters
  // (goalActivations counts retained edges that are deliberately never persisted).
  writeFileSync(stateFile(stateDir), JSON.stringify({
    schemaVersion: 1,
    revision: 1,
    cursor: 3,
    watcherEpoch: 'e',
    mode: 'poll',
    host: { state: 'unknown', serviceable: false, since: 1, lastBaselineAt: null, baselineOk: false },
    sessions: [{ sessionId: 's1', running: false, updatedAt: 4, present: true, observedAt: 5, originKnown: true }],
    dropped: { sessions: 0, goalActivations: 9 },
  }))
  const store = createSessionStateStore({ stateDir, logger: silentLogger, now: () => 100 })
  // 单一口径：validateDocument 把进程内累计计数归 0，adoptDocument 不从持久值读
  // （否则就是一个永不产生非零值的死读分支）。键都在，形状不缩水。
  assert.deepEqual(store.status().dropped, { sessions: 0, goalActivations: 0 })
  assert.equal(store.snapshotFor('sse', store.host()).sessions.length, 1)
})

test('a legacy document without originKnown is read as UNCONFIRMED: hidden until a list fact confirms it (S1)', async t => {
  const stateDir = scratch(t)
  const { ensurePrivateDirectoryNoFollow } = await import('@dsh-chamber/control-plane')
  ensurePrivateDirectoryNoFollow(join(stateDir, SESSION_STATE_DIR_NAME), 0o700)
  // 旧文档（S1 之前写入）没有 originKnown 字段；按未确认读，保守地等本进程的列表事实。
  writeFileSync(stateFile(stateDir), JSON.stringify({
    schemaVersion: 1,
    revision: 1,
    cursor: 3,
    watcherEpoch: 'e',
    mode: 'poll',
    host: { state: 'unknown', serviceable: false, since: 1, lastBaselineAt: null, baselineOk: false },
    sessions: [{ sessionId: 'legacy', running: false, updatedAt: 4, present: true, observedAt: 5 }],
    dropped: { sessions: 0, goalActivations: 0 },
  }))
  const store = createSessionStateStore({ stateDir, logger: silentLogger, now: () => 100 })
  assert.deepEqual(store.snapshotFor('sse', store.host()).sessions, [],
    '缺 originKnown 的旧行按未确认读：基线前不得投递（它可能其实是子代理）')
  // 列表事实确认顶层身份：同一拍上线（持久行的字段原样保留）。
  store.applyBaseline([baselineItem('legacy', false, 4)], { at: 200 })
  const row = store.snapshotFor('sse', store.host()).sessions[0]
  assert.equal(row.sessionId, 'legacy')
  assert.equal(row.updatedAt, 4)
})

test('a legacy row with present:false stays hidden until a list fact re-confirms it (compat read)', async t => {
  const stateDir = scratch(t)
  const { ensurePrivateDirectoryNoFollow } = await import('@dsh-chamber/control-plane')
  ensurePrivateDirectoryNoFollow(join(stateDir, SESSION_STATE_DIR_NAME), 0o700)
  // S3 之前写入的隐藏行（present:false）：兼容读保留该位——「行在即 present」只适用于新
  // 写入者，绝不把历史隐藏行突然投递；本进程的列表事实确认后同拍上线（与 S1 originKnown 同款）。
  writeFileSync(stateFile(stateDir), JSON.stringify({
    schemaVersion: 1,
    revision: 1,
    cursor: 3,
    watcherEpoch: 'e',
    mode: 'poll',
    host: { state: 'unknown', serviceable: false, since: 1, lastBaselineAt: null, baselineOk: false },
    sessions: [{ sessionId: 'hidden', running: false, updatedAt: 4, present: false, observedAt: 5, originKnown: true }],
    dropped: { sessions: 0, goalActivations: 0 },
  }))
  const store = createSessionStateStore({ stateDir, logger: silentLogger, now: () => 100 })
  assert.equal(store.snapshotFor('sse', store.host()).sessions.length, 0,
    'present:false 的旧行不得投递（兼容读保留该位）')
  // 列表事实确认顶层身份：row.present = true ⇒ 同一拍上线，持久字段原样保留。
  store.applyBaseline([baselineItem('hidden', false, 4)], { at: 200 })
  const row = store.snapshotFor('sse', store.host()).sessions[0]
  assert.equal(row.sessionId, 'hidden')
  assert.equal(row.updatedAt, 4)
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

test('a doubly-corrupt store still enforces the row cap on an oversized baseline (never silent)', async t => {
  const stateDir = scratch(t)
  const seed = createSessionStateStore({ stateDir, logger: silentLogger, now: () => 100 })
  seed.applyBaseline([baselineItem('durable', false, 5)], { at: 100 })
  await seed.flush()
  seed.dispose()
  writeFileSync(stateFile(stateDir), 'broken-main')
  writeFileSync(stateFile(stateDir) + '.bak', 'broken-backup')
  const evidence = readFileSync(stateFile(stateDir), 'utf8')

  const logger = capturingLogger()
  const corrupt = createSessionStateStore({ stateDir, logger, now: () => 200 })
  assert.equal(corrupt.status().integrity, 'corrupt')
  assert.equal(corrupt.status().loaded, false)

  // 双损坏下 persistBlocked 早退不得变成"上限失效"：2005 行基线仍必须被裁到
  // MAX_SESSIONS，且丢失在 dropped.sessions 里可见（快照是仅剩的证据）。
  const items = Array.from({ length: MAX_SESSIONS + 5 }, (_, index) => baselineItem('s' + index, false, index + 1))
  corrupt.applyBaseline(items, { at: 200 })
  await corrupt.flush()
  assert.equal(corrupt.status().sessions, MAX_SESSIONS)
  assert.equal(corrupt.status().dropped.sessions, 5)
  assert.equal(corrupt.snapshotFor('sse', corrupt.host()).sessions.length, MAX_SESSIONS)
  assert.equal(logger.lines.some(line => line.includes('cap reached')), true, 'the loss is loud')

  // 持久化仍被拒绝：损坏证据不被覆盖，flush 也没有偷偷写盘。
  assert.equal(readFileSync(stateFile(stateDir), 'utf8'), evidence)
  assert.equal(corrupt.status().persistedAt, null)

  // flush 收敛：重复 flush 幂等，不二次计数。
  await corrupt.flush()
  assert.equal(corrupt.status().sessions, MAX_SESSIONS)
  assert.equal(corrupt.status().dropped.sessions, 5)
  corrupt.dispose()
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
    // The projector never emits these fields; the store whitelist must drop
    // them even when they arrive smuggled through the (typed) seam.
    goal: {
      goalId: 'goal-1', revision: 2, phase: 'active', updatedAt: 5, activation: 'armed',
      objective: 'TOP-SECRET-OBJECTIVE', blockedReason: { code: 'x', message: 'TOP-SECRET-BLOCK' },
    },
  })
  store.applyBaseline([hostile as never], { at: 100 })
  store.applyPending('s1', 'approval', 101)
  await store.flush()
  store.dispose()
  const text = readFileSync(stateFile(stateDir), 'utf8')
  for (const secret of [
    'TOP-SECRET-TITLE', 'TOP-SECRET-CWD', 'TOP-SECRET-TODO', 'TOP-SECRET-PRESET', 'TOP-SECRET-PROJECTION',
    'TOP-SECRET-OBJECTIVE', 'TOP-SECRET-BLOCK',
  ]) {
    assert.equal(text.includes(secret), false, secret + ' must never reach the snapshot')
  }
  assert.equal(text.includes('activation'), false, 'activation is process-local and never persisted')
  const document = JSON.parse(text) as { sessions: Array<Record<string, unknown>> }
  assert.deepEqual(Object.keys(document.sessions[0]).sort(), [
    'completedAt', 'completedAtSource', 'error', 'goal', 'lastRunningAt', 'lastTurnEnd', 'observedAt',
    'origin', 'originKnown', 'parentSessionId', 'pendingKind', 'pendingSince', 'present', 'running',
    'sessionId', 'subagentCount', 'updatedAt',
  ])
  // The persisted goal carries ONLY the whitelisted durable fields.
  assert.deepEqual(document.sessions[0].goal, { goalId: 'goal-1', revision: 2, phase: 'active', updatedAt: 5 })
})

test('a restart preserves the durable goal fact but clears the process-local activation', async t => {
  const stateDir = scratch(t)
  const first = createSessionStateStore({ stateDir, logger: silentLogger, now: () => 100 })
  first.applyBaseline([baselineItem('s1', false, 5, {
    goal: { goalId: 'g1', revision: 2, phase: 'active', updatedAt: 5 },
  })], { at: 100 })
  assert.equal(first.applyGoalActivation({ sessionId: 's1', goalId: 'g1', activation: 'armed' }, 101), true)
  assert.equal(first.snapshotFor('sse', first.host()).sessions[0].goal?.activation, 'armed')
  await first.flush()
  first.dispose()

  const persisted = JSON.parse(readFileSync(stateFile(stateDir), 'utf8')) as {
    sessions: Array<{ goal: Record<string, unknown> }>
  }
  assert.deepEqual(persisted.sessions[0].goal, { goalId: 'g1', revision: 2, phase: 'active', updatedAt: 5 })

  // A new store = a new watcher epoch: activation degrades to unknown, the
  // durable phase/watermark survive.
  const second = createSessionStateStore({ stateDir, logger: silentLogger, now: () => 200 })
  const after = second.snapshotFor('sse', second.host()).sessions[0]
  assert.deepEqual(after.goal, { goalId: 'g1', revision: 2, phase: 'active', updatedAt: 5 })
  assert.equal(after.goal?.activation, undefined)
})
