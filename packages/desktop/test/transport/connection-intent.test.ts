/**
 * B（v2 §P2-B）：连接意图。三层：
 * 1) 纯函数/行元数据兼容（resolveAppSessionId 形状、readRowHostMetadata 宽松、attach 不改 spec、
 *    T1 provider validateSpec 剥键、isSuppressedByIntent 会话过滤、attemptStillAuthorized 矩阵）；
 * 2) registry/manager 意图写（round-trip、编辑保留、删除/重加、健康门只在内存生效（0 写、
 *    volatile）、写失败 pending 重试、补偿恢复、权威新增 onInstancesAdded、canAttempt 门含定时器路径）；
 * 3) 全部 Node-only（无 fs 以外的宿主依赖；manager 注入 fake spawn/probe）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  APP_SESSION_ID_ENV, APP_SESSION_ID_FLAG, attachRowHostMetadata, attemptStillAuthorized,
  createIntentStore, isSuppressedByIntent, readRowHostMetadata, resolveAppSessionId, serializeRoster,
  type AttemptTicket, type IntentRosterHealth,
} from '../../connection-intent.ts'
import { createTransportManager, type TransportManager } from '../../transport-manager.ts'
import { sshProvider } from '../../ssh-provider.ts'
import { FakeChild, silentLogger, tempDir } from '../support/transport-manager-harness.ts'

const SESSION_A = 'app-session-aaaa0000'
const SESSION_B = 'app-session-bbbb1111'

/** A persisted row WITHOUT host metadata (pre-B shape). */
const OLD_ROW = {
  id: 's1', label: 'home', kind: 'dsh', transport: 'ssh', host: 'home.example.com',
  user: 'alice', sshPort: 22, remotePort: 2222, serviceName: 'dsh', remoteDshHome: null, insecureHttp: false,
}

/** Save input accepted by sshProvider.validateSpec (defaults filled by the provider). */
const saveInput = (id: string, host: string) => ({ id, label: id, kind: 'dsh' as const, transport: 'ssh' as const, host, remotePort: 2222 })

function managerWithIntent(
  dir: string,
  appSessionId: string | null,
  extras: Pick<Parameters<typeof createTransportManager>[0], 'canAttempt'> & { added?: string[] } = {},
) {
  const file = join(dir, 'ssh-instances.json')
  const manager = createTransportManager({
    provider: sshProvider,
    instancesFile: file,
    logger: silentLogger,
    connectionIntent: {
      appSessionId,
      ...(extras.added === undefined ? {} : { onInstancesAdded: ids => { extras.added!.push(...ids) } }),
    },
    ...(extras.canAttempt === undefined ? {} : { canAttempt: extras.canAttempt }),
  })
  return { manager, file }
}

const readRows = (file: string): Array<Record<string, unknown>> => JSON.parse(readFileSync(file, 'utf8')) as Array<Record<string, unknown>>
const rowMetadata = (rows: Array<Record<string, unknown>>, id: string): Record<string, unknown> | undefined =>
  (rows.find(row => row.id === id)?.dshChamber as Record<string, unknown> | undefined)

test('resolveAppSessionId: flag > env, shape whitelist, illegal/missing = disabled (null)', () => {
  assert.deepEqual(resolveAppSessionId([], {}), { session: null, rejected: null })
  assert.deepEqual(resolveAppSessionId([], { [APP_SESSION_ID_ENV]: SESSION_A }), { session: SESSION_A, rejected: null })
  assert.deepEqual(resolveAppSessionId([APP_SESSION_ID_FLAG, SESSION_B], { [APP_SESSION_ID_ENV]: SESSION_A }), { session: SESSION_B, rejected: null })
  // 非法形状：绝不进入持久文件；rejected 只报来源（不回显值）。
  assert.deepEqual(resolveAppSessionId([APP_SESSION_ID_FLAG, 'short'], { [APP_SESSION_ID_ENV]: SESSION_A }), { session: null, rejected: 'flag' })
  assert.deepEqual(resolveAppSessionId([APP_SESSION_ID_FLAG], {}), { session: null, rejected: 'flag' })
  assert.deepEqual(resolveAppSessionId([], { [APP_SESSION_ID_ENV]: 'bad id with spaces' }), { session: null, rejected: 'env' })
  assert.deepEqual(resolveAppSessionId([], { [APP_SESSION_ID_ENV]: '' }), { session: null, rejected: null })
  // 形状：8–64 位 [A-Za-z0-9_-]。
  assert.equal(resolveAppSessionId([], { [APP_SESSION_ID_ENV]: 'a'.repeat(64) }).session, 'a'.repeat(64))
  assert.equal(resolveAppSessionId([], { [APP_SESSION_ID_ENV]: 'a'.repeat(65) }).session, null)
})

test('readRowHostMetadata is tolerant: bad shapes are empty, never a dropped row', () => {
  assert.deepEqual(readRowHostMetadata(null), {})
  assert.deepEqual(readRowHostMetadata('row'), {})
  assert.deepEqual(readRowHostMetadata([OLD_ROW]), {})
  assert.deepEqual(readRowHostMetadata({ id: 'x' }), {})
  assert.deepEqual(readRowHostMetadata({ id: 'x', dshChamber: 'nope' }), {})
  assert.deepEqual(readRowHostMetadata({ id: 'x', dshChamber: [] }), {})
  assert.deepEqual(readRowHostMetadata({ id: 'x', dshChamber: { manualDisconnectSessionId: 42 } }), {})
  assert.deepEqual(readRowHostMetadata({ id: 'x', dshChamber: { manualDisconnectSessionId: '' } }), {})
  assert.deepEqual(readRowHostMetadata({ id: 'x', dshChamber: { manualDisconnectSessionId: SESSION_A } }), { manualDisconnectSessionId: SESSION_A })
})

test('attachRowHostMetadata returns a NEW row and the provider whitelist strips the namespace (T1)', () => {
  const plain = sshProvider.validateSpec(OLD_ROW)
  assert.notEqual(plain, null)
  const attached = attachRowHostMetadata(plain!, { manualDisconnectSessionId: SESSION_A })
  assert.notEqual(attached, plain, 'never mutate the passed spec')
  assert.deepEqual((attached as unknown as Record<string, unknown>).dshChamber, { manualDisconnectSessionId: SESSION_A })
  assert.equal((plain as unknown as Record<string, unknown>).dshChamber, undefined)
  // 旧读者/provider：白名单闭包剥掉未知键，行照常可用（droppedCount 不受宿主元数据影响）。
  const normalized = sshProvider.validateSpec(attached)
  assert.deepEqual(normalized, plain)
  assert.equal(Object.hasOwn(normalized as object, 'dshChamber'), false)
  // 无意图 = 与旧行逐字相同（零 key）。
  assert.deepEqual(attachRowHostMetadata(plain!, {}), plain)
})

test('isSuppressedByIntent only honors the CURRENT app session (old/missing sessions default-connect)', () => {
  assert.equal(isSuppressedByIntent({ manualDisconnectSessionId: SESSION_A }, SESSION_A), true)
  assert.equal(isSuppressedByIntent({ manualDisconnectSessionId: SESSION_A }, SESSION_B), false)
  assert.equal(isSuppressedByIntent({ manualDisconnectSessionId: SESSION_A }, null), false)
  assert.equal(isSuppressedByIntent({}, SESSION_A), false)
})

test('serializeRoster keeps the old byte shape when there is no intent and adds dshChamber otherwise', () => {
  const plain = sshProvider.validateSpec(OLD_ROW)!
  assert.equal(serializeRoster([plain], new Map()), `${JSON.stringify([plain], undefined, 2)}\n`)
  const withIntent = serializeRoster([plain], new Map([['s1', { manualDisconnectSessionId: SESSION_A }]]))
  assert.deepEqual(JSON.parse(withIntent)[0].dshChamber, { manualDisconnectSessionId: SESSION_A })
})

test('attemptStillAuthorized: quitting > row identity > transport generation > intent', () => {
  const state = { phase: 'idle' }
  const ticket: AttemptTicket = { id: 's1', state, tunnelEpoch: 3 }
  const deps = (overrides: Partial<Parameters<typeof attemptStillAuthorized>[1]> = {}) => ({
    isQuitting: () => false,
    stateOf: () => state,
    tunnelEpochOf: () => 3,
    suppressed: new Set<string>(),
    ...overrides,
  })
  assert.equal(attemptStillAuthorized(ticket, deps()), 'authorized')
  assert.equal(attemptStillAuthorized(ticket, deps({ isQuitting: () => true, suppressed: new Set(['s1']) })), 'quitting')
  // 行对象身份变了（同 id 删行/重加、机制/参数改址）→ stale-row（由调用方重规划一次）。
  assert.equal(attemptStillAuthorized(ticket, deps({ stateOf: () => ({ phase: 'idle' }) })), 'stale-row')
  assert.equal(attemptStillAuthorized(ticket, deps({ stateOf: () => null })), 'stale-row')
  // 传输代变了（disconnect/restart）→ stale-transport（永不重规划）。
  assert.equal(attemptStillAuthorized(ticket, deps({ tunnelEpochOf: () => 4 })), 'stale-transport')
  assert.equal(attemptStillAuthorized(ticket, deps({ suppressed: new Set(['s1']) })), 'suppressed')
  // 两事实同时换代时行身份优先：重规划会按当前 level 再判。
  assert.equal(attemptStillAuthorized(ticket, deps({ stateOf: () => ({ phase: 'idle' }), tunnelEpochOf: () => 4 })), 'stale-row')
  // 事实缺失（无该事实）→ 跳过该查，绝不假阳。
  const bare: AttemptTicket = { id: 's1', state: null, tunnelEpoch: null }
  assert.equal(attemptStillAuthorized(bare, deps({ tunnelEpochOf: () => null, stateOf: () => null })), 'authorized')
})

test('createIntentStore: single write, compensation restore (C3), volatile failure, degrade/incomplete refusal', () => {
  const writes: string[] = []
  const added: string[][] = []
  const health: IntentRosterHealth = { loadFailure: null, incomplete: false }
  const rowA = sshProvider.validateSpec(OLD_ROW)!
  const rowB = sshProvider.validateSpec({ ...OLD_ROW, id: 's2', host: 'other.example.com' })!
  let currentRows = [rowA, rowB]
  const store = createIntentStore({
    session: SESSION_A,
    write: text => { writes.push(text) },
    rows: () => currentRows,
    onInstancesAdded: ids => added.push([...ids]),
    warn: () => {},
  })
  store.beginLoad()
  store.observeRow({ ...rowA, dshChamber: { manualDisconnectSessionId: SESSION_A } }, rowA.id)
  assert.deepEqual([...store.snapshot(health).suppressed], ['s1'])
  // 显式写：内存先生效 + 单次整文件写（含命名空间回填）。
  const before = store.beginSave([rowA, rowB])
  store.writeSave([rowA, rowB], before)
  store.commitSave(before, 'authoritative', [rowA, rowB])
  assert.equal(store.setManual('s2', true, health, true).ok, true)
  assert.deepEqual([...store.snapshot(health).suppressed].sort(), ['s1', 's2'])
  assert.deepEqual(JSON.parse(writes[writes.length - 1]!).map((row: { dshChamber?: unknown }) => row.dshChamber), [{ manualDisconnectSessionId: SESSION_A }, { manualDisconnectSessionId: SESSION_A }])
  // I6：健康门 = 写盘门，不是意图门——0 次写、内存照常生效、volatile:true。
  const writesBeforeGate = writes.length
  const degraded = store.setManual('s1', false, { loadFailure: 'corrupt', incomplete: false }, true)
  assert.deepEqual(degraded, { ok: false, error: 'registry load is degraded; intent not persisted', volatile: true })
  assert.deepEqual([...store.snapshot(health).suppressed], ['s2'], 'the in-memory clear still applied (volatile)')
  const incomplete = store.setManual('s1', true, { loadFailure: null, incomplete: true }, true)
  assert.deepEqual(incomplete, { ok: false, error: 'roster is incomplete; intent not persisted', volatile: true })
  assert.deepEqual([...store.snapshot(health).suppressed].sort(), ['s1', 's2'], 'the in-memory disconnect still applied')
  assert.equal(writes.length, writesBeforeGate, 'a closed health gate performs zero writes')
  assert.deepEqual(store.setManual('unknown', true, health, false), { ok: false, error: 'unknown instance', volatile: false })
  // 写失败：内存保持用户事实（volatile），并保留 pending：下一次成功整文件写回填。
  let failWrites = true
  const backfillWrites: string[] = []
  const failing = createIntentStore({
    session: SESSION_A,
    write: text => { if (failWrites) throw new Error('disk full'); backfillWrites.push(text) },
    rows: () => [rowA],
    warn: () => {},
  })
  failing.beginLoad()
  const failed = failing.setManual('s1', true, health, true)
  assert.equal(failed.ok, false)
  assert.equal(failed.ok === false && failed.volatile, true)
  assert.deepEqual([...failing.snapshot(health).suppressed], ['s1'])
  // 恢复可写后的下一次 save 整文件回填 pending 意图（D1 验收：save 回填）。
  failWrites = false
  const backfillSave = failing.beginSave([rowA])
  failing.writeSave([rowA], backfillSave)
  assert.equal(backfillWrites.length, 1, 'the next successful save is the ONE backfill write')
  assert.deepEqual(JSON.parse(backfillWrites[0]!)[0].dshChamber, { manualDisconnectSessionId: SESSION_A })
  failing.commitSave(backfillSave, 'authoritative', [rowA])
  // 回填后内存=盘，同会话重复 set 是幂等 no-op（不产生第二次写）。
  assert.deepEqual(failing.setManual('s1', true, health, true), { ok: true })
  assert.equal(backfillWrites.length, 1, 'the idempotent re-set after backfill writes nothing')
  // C3：补偿回滚恢复入口快照——回滚只恢复入口前已存在 id 的意图，内存意图保持（不落盘也保持）。
  const beforeDelete = store.beginSave([rowA, rowB])
  store.observeRow({ ...rowA, dshChamber: { manualDisconnectSessionId: SESSION_A } }, 's1')
  store.commitSave(beforeDelete, 'compensation', [rowA, rowB])
  assert.deepEqual([...store.snapshot(health).suppressed].sort(), ['s1', 's2'])
  // 权威新增：只报 nextIds - beforeIds。
  const empty = store.beginSave([])
  store.writeSave([rowA, rowB], empty)
  const newIds = store.commitSave(empty, 'authoritative', [rowA, rowB])
  assert.deepEqual(newIds, ['s1', 's2'])
  assert.deepEqual(added, [['s1', 's2']])
  // 删除：意图随行消失；同 id 重加无意图（新行 = 新资源）。
  const readd = store.beginSave([rowA, rowB])
  store.writeSave([rowB], readd)
  store.commitSave(readd, 'authoritative', [rowB])
  assert.deepEqual([...store.snapshot(health).suppressed], ['s2'], 'only kept rows keep their intent')
  const removeAll = store.beginSave([rowB])
  store.writeSave([], removeAll)
  store.commitSave(removeAll, 'authoritative', [])
  const reAdded = store.beginSave([])
  store.writeSave([rowB], reAdded)
  store.commitSave(reAdded, 'authoritative', [rowB])
  assert.deepEqual([...store.snapshot(health).suppressed], [], 'delete then same-id re-add starts with no intent')
})

test('manager intent round-trip: load current-session intent, edit preserves it, intent write is one atomic roster write', () => {
  const dir = tempDir()
  const file = join(dir, 'ssh-instances.json')
  writeFileSync(file, JSON.stringify([
    { ...OLD_ROW, dshChamber: { manualDisconnectSessionId: SESSION_A } },
    { ...OLD_ROW, id: 's2', host: 'other.example.com', dshChamber: { manualDisconnectSessionId: SESSION_B } },
  ]))
  const { manager } = managerWithIntent(dir, SESSION_A)
  manager.loadInstances()
  const loaded = manager.connectionIntents()
  assert.equal(loaded.session, SESSION_A)
  assert.deepEqual([...loaded.suppressed], ['s1'], 'only THIS session suppresses; old-session intent is inert')
  assert.equal(manager.loadDroppedCount(), 0, 'host metadata never counts as a dropped row')
  // 编辑同一 id（label/host 变化）保留 previous 意图：行文件仍带本会话标记。
  manager.saveInstances([{ ...saveInput('s2', 'other2.example.com'), label: 'edited' }])
  assert.deepEqual(rowMetadata(readRows(file), 's2'), { manualDisconnectSessionId: SESSION_B }, 'edit preserves previous metadata')
  assert.equal(rowMetadata(readRows(file), 's1'), undefined, 'an edited-away row disappears with its intent')
  assert.deepEqual([...manager.connectionIntents().suppressed], [])
  // 显式意图写：与行同一次整文件写；无 .tmp 残留。
  const written = manager.setManualDisconnectIntent('s2', true)
  assert.deepEqual(written, { ok: true })
  assert.deepEqual(rowMetadata(readRows(file), 's2'), { manualDisconnectSessionId: SESSION_A })
  assert.deepEqual([...manager.connectionIntents().suppressed], ['s2'])
  assert.deepEqual(readdirSync(dir).filter(name => name.includes('.tmp')), [])
  // 幂等：同会话再写 no-op（ok:true 且不落盘）；显式连接清意图（写盘）。
  const beforeIdempotentRetry = readFileSync(file, 'utf8')
  assert.deepEqual(manager.setManualDisconnectIntent('s2', true), { ok: true })
  assert.equal(readFileSync(file, 'utf8'), beforeIdempotentRetry,
    'an idempotent re-set must not touch the file')
  assert.deepEqual(manager.setManualDisconnectIntent('s2', false), { ok: true })
  assert.equal(rowMetadata(readRows(file), 's2'), undefined)
  // 删除 → 行+意图同一次写消失；同 id 重加 = 新行 = 无意图。
  manager.saveInstances([])
  assert.deepEqual(readRows(file), [])
  assert.deepEqual([...manager.connectionIntents().suppressed], [])
  manager.saveInstances([saveInput('s2', 'other.example.com')])
  assert.equal(rowMetadata(readRows(file), 's2'), undefined)
  assert.deepEqual([...manager.connectionIntents().suppressed], [])
})

test('manager degrades: an unknown id stays unknown; a known row keeps its intent in memory with zero writes', () => {
  const dir = tempDir()
  const file = join(dir, 'ssh-instances.json')
  writeFileSync(file, '{not json')
  const { manager } = managerWithIntent(dir, SESSION_A)
  assert.throws(() => manager.loadInstances(), /corrupt/)
  const corrupt = readFileSync(file, 'utf8')
  // degraded 态内存 roster 为空：未知 id 仍回 unknown（健康门不改写这一判据）。
  assert.deepEqual(manager.setManualDisconnectIntent('s1', true), { ok: false, error: 'unknown instance', volatile: false })
  assert.equal(readFileSync(file, 'utf8'), corrupt)
  assert.equal(manager.loadFailure() !== null, true, 'the degraded gate stays closed')
  // 先成功 load（行已知）再损坏 load：行仍在内存 ⇒ 意图内存生效、0 次写、volatile:true。
  const secondDir = tempDir()
  const secondFile = join(secondDir, 'ssh-instances.json')
  writeFileSync(secondFile, JSON.stringify([OLD_ROW]))
  const second = managerWithIntent(secondDir, SESSION_A).manager
  assert.deepEqual(second.loadInstances().map(instance => instance.id), ['s1'])
  writeFileSync(secondFile, '{not json')
  assert.throws(() => second.loadInstances(), /corrupt/)
  assert.equal(second.loadFailure() !== null, true)
  const before = readFileSync(secondFile, 'utf8')
  assert.deepEqual(second.setManualDisconnectIntent('s1', true),
    { ok: false, error: 'registry load is degraded; intent not persisted', volatile: true })
  assert.deepEqual([...second.connectionIntents().suppressed], ['s1'], 'the in-memory intent applies under the closed gate')
  assert.equal(readFileSync(secondFile, 'utf8'), before, 'the degraded live file stays byte-identical')
})

test('manager incomplete roster: the intent still applies in memory with zero writes', () => {
  const dir = tempDir()
  const file = join(dir, 'ssh-instances.json')
  writeFileSync(file, JSON.stringify([OLD_ROW, { id: 'legacy-drop', label: 'old', host: 'x' }]))
  const { manager } = managerWithIntent(dir, SESSION_A)
  manager.loadInstances()
  assert.equal(manager.registryIncomplete(), true)
  const before = readFileSync(file, 'utf8')
  assert.deepEqual(manager.setManualDisconnectIntent('s1', true),
    { ok: false, error: 'roster is incomplete; intent not persisted', volatile: true })
  assert.deepEqual([...manager.connectionIntents().suppressed], ['s1'], 'a partial roster no longer swallows the in-memory intent')
  assert.equal(readFileSync(file, 'utf8'), before, 'the incomplete live file stays byte-identical')
})

test('createIntentStore: memory-first under a closed health gate — intent applies, zero writes, a later writable action backfills it', () => {
  const writes: string[] = []
  const closed: IntentRosterHealth = { loadFailure: null, incomplete: true }
  const open: IntentRosterHealth = { loadFailure: null, incomplete: false }
  const rowA = sshProvider.validateSpec(OLD_ROW)!
  const store = createIntentStore({
    session: SESSION_A,
    write: text => { writes.push(text) },
    rows: () => [rowA],
  })
  store.beginLoad()
  const applied = store.setManual('s1', true, closed, true)
  assert.deepEqual(applied, { ok: false, error: 'roster is incomplete; intent not persisted', volatile: true })
  assert.equal(writes.length, 0, 'the closed gate performs zero writes')
  assert.deepEqual([...store.snapshot(closed).suppressed], ['s1'], 'the intent is live in memory (volatile)')
  // 恢复可写后的下一次显式意图写把未落盘事实整文件回填（单次写）。
  assert.deepEqual(store.setManual('s1', true, open, true), { ok: true })
  assert.equal(writes.length, 1, 'the pending fact is backfilled by exactly one whole-file write')
  assert.deepEqual(JSON.parse(writes[0]!)[0].dshChamber, { manualDisconnectSessionId: SESSION_A })
})

test('createIntentStore: a failed write stays pending and the next explicit action retries it', () => {
  const attempts: string[] = []
  const health: IntentRosterHealth = { loadFailure: null, incomplete: false }
  const rowA = sshProvider.validateSpec(OLD_ROW)!
  let fail = true
  const store = createIntentStore({
    session: SESSION_A,
    write: text => { attempts.push(text); if (fail) throw new Error('disk full') },
    rows: () => [rowA],
    warn: () => {},
  })
  store.beginLoad()
  const first = store.setManual('s1', true, health, true)
  assert.equal(first.ok, false)
  assert.equal(first.ok === false && first.volatile, true)
  assert.equal(attempts.length, 1, 'the first write attempt fails loudly')
  fail = false
  // 同一次显式动作就是重试点（无 timer、无队列）：第二次整文件写成功返回 ok:true。
  assert.deepEqual(store.setManual('s1', true, health, true), { ok: true })
  assert.equal(attempts.length, 2)
  assert.deepEqual(JSON.parse(attempts[1]!)[0].dshChamber, { manualDisconnectSessionId: SESSION_A })
})

test('createIntentStore: a no-op action answers ok and never reports another row\'s pending write as its failure', () => {
  const attempts: string[] = []
  const health: IntentRosterHealth = { loadFailure: null, incomplete: false }
  const rowA = sshProvider.validateSpec(OLD_ROW)!
  const store = createIntentStore({
    session: SESSION_A,
    write: text => { attempts.push(text); throw new Error('disk full') },
    rows: () => [rowA],
    warn: () => {},
  })
  store.beginLoad()
  // s1 fails to persist: the intent is live in memory and the store now carries a pending write.
  assert.equal(store.setManual('s1', true, health, true).ok, false)
  assert.equal(attempts.length, 1)
  // A later action on a row that HAS NO intent changes nothing: its own result is ok even though
  // the store still holds s1's pending write (the retry rides along; its failure is not this action's).
  assert.deepEqual(store.setManual('s2', false, health, true), { ok: true },
    'a no-op action never reports the other row\'s pending as its own persist failure')
  assert.equal(attempts.length, 2, 'the no-op still acts as the opportunistic retry point (no timer)')
  assert.deepEqual([...store.snapshot(health).suppressed], ['s1'], 'the pending intent stays live in memory')
})

test('manager reports added ids only for an authoritative save; compensation and empty adds never fire', () => {
  const dir = tempDir()
  const added: string[] = []
  const { manager } = managerWithIntent(dir, SESSION_A, { added })
  manager.loadInstances()
  assert.deepEqual(added, [])
  manager.saveInstances([saveInput('a', 'a.example.com')])
  assert.deepEqual(added, ['a'])
  manager.saveInstances([saveInput('a', 'a2.example.com')]) // edit, no add
  assert.deepEqual(added, ['a'])
  manager.saveInstances([saveInput('a', 'a2.example.com'), saveInput('b', 'b.example.com')]) // +b
  assert.deepEqual(added, ['a', 'b'])
  manager.saveInstances([saveInput('a', 'a2.example.com')], 'compensation') // rollback never counts as add
  assert.deepEqual(added, ['a', 'b'])
})

test('manager canAttempt gate refuses connect without transition and covers the scheduled startTransport path', async () => {
  const dir = tempDir()
  const spawnCalls: FakeChild[] = []
  let allowed = false
  const manager: TransportManager = createTransportManager({
    provider: { ...sshProvider, transportSocketPath: () => null },
    spawnFn: () => { const child = new FakeChild(); spawnCalls.push(child); return child },
    instancesFile: join(dir, 'ssh-instances.json'),
    logger: silentLogger,
    portProbe: async () => false,
    allocatePort: async () => 43210,
    canAttempt: () => allowed,
    options: { readyTimeoutMs: 50, probeIntervalMs: 5, retryBaseMs: 10, retryMaxMs: 20, maxRetryAttempts: 2 },
  })
  try {
    manager.saveInstances([saveInput('s1', 'h.example.com')])
    const refused = manager.connect('s1')
    assert.equal(refused?.phase, 'idle', 'refused connect stays idle (no transition)')
    assert.equal(spawnCalls.length, 0, 'refused connect never spawns')
    // 定时器路径（退避/慢探绕过 connect()）：放行首连 → 失败进入 degraded → 关闸后重试拍必须零 spawn。
    allowed = true
    manager.connect('s1')
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(spawnCalls.length, 1, 'allowed connect spawns once')
    allowed = false
    spawnCalls[0]!.simulateExit(1)
    await new Promise(resolve => setTimeout(resolve, 120))
    assert.equal(spawnCalls.length, 1, 'the scheduled startTransport is gated too (no spawn while suppressed)')
  } finally {
    manager.dispose()
  }
})
