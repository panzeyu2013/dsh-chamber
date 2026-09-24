/**
 * P2b：dsh/SSH 无壳观察者的 goal 事实锁。
 *
 * 钉死四件事：① 基线只从 `projections.values.goal` 取白名单（title/todos/inbox、
 * objective/blockedReason/maxGoalRounds 等其余投影键绝不落行）；② 三值语义（unknown 不写字段 /
 * null 明确无 goal / 对象 = 有 goal），unknown 绝不折成「无 goal」；③
 * `goal/activation-changed` 与行的合并 + 新 ready 代际清空（activation 仅进程内存）；
 * ④ 与 status 完成边沿互不干扰。
 *
 * Run directly: node test/session-state/source-mux-facts-goal.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  createSourceMuxFacts,
  mergeBaselineRow,
  parseGoalActivationArgs,
  parseProjectedGoalFact,
  rowFromListItem,
  type MuxSocket,
} from '../../src/source-mux-facts.ts'

const SOURCE = readFileSync(fileURLToPath(new URL('../../src/source-mux-facts.ts', import.meta.url)), 'utf8')

class FakeSocket implements MuxSocket {
  sent: string[] = []
  followOpens: Array<{ streamId: string; payload: unknown }> = []
  onFollowOpen: ((streamId: string, payload: unknown) => void) | null = null
  closed = false
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event?: unknown) => void) | null = null
  onerror: ((event?: unknown) => void) | null = null
  send(data: string): void {
    this.sent.push(data)
    const frame = JSON.parse(data) as { type: string; streamId: string; endpoint?: string; payload?: unknown }
    if (frame.type === 'open' && frame.endpoint === 'session/follow') {
      this.followOpens.push({ streamId: frame.streamId, payload: frame.payload })
      this.onFollowOpen?.(frame.streamId, frame.payload)
    }
  }
  close(): void { this.closed = true }
  open(): void { this.onopen?.() }
  item(value: unknown): void { this.onmessage?.({ data: JSON.stringify({ type: 'item', streamId: 'events', value }) }) }
  followItem(streamId: string, value: unknown): void {
    this.onmessage?.({ data: JSON.stringify({ type: 'item', streamId, value }) })
  }
  replyFollow(index: number, value: unknown): void {
    const streamId = this.followOpens[index]?.streamId
    assert.ok(streamId, 'follow stream was not opened')
    this.followItem(streamId, value)
  }
}

/** fetch 假件：按 rpcId 回显信封（envelope 校验要求 rpcId 一致）。 */
function rpcFetch(handlers: Record<string, (payload: unknown) => unknown>) {
  return async (_url: string, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { rpcId: string; method: string; payload: unknown }
    const handler = handlers[body.method]
    const value = handler === undefined ? null : handler(body.payload)
    const result = value === 'FAIL' ? { ok: false, error: { code: 'x' } } : { ok: true, value }
    return { ok: true, status: 200, json: async () => ({ type: 'server-response', rpcId: body.rpcId, result }) } as never
  }
}

function hasKey(value: unknown, key: string): boolean {
  return value !== null && value !== undefined && Object.hasOwn(value as object, key)
}

/** 隐私诱饵：解析器一旦读它们，下面的行/源码断言就会抓到。 */
const SECRET_OBJECTIVE = 'PRIVATE-OBJECTIVE-TEXT'
const SECRET_REASON = 'PRIVATE-BLOCKED-REASON'

/**
 * 冻结 wire 形的 goal 投影包装：
 * `{ goal: { id, revision, phase, objective?, blockedReason?, ... }, roundsStarted, createdAt, updatedAt }`。
 */
function goalProjection(options: { id?: unknown; revision?: unknown; phase?: unknown; updatedAt?: unknown } = {}): Record<string, unknown> {
  const goal = {
    id: options.id ?? 'g1',
    revision: options.revision ?? 1,
    phase: options.phase ?? 'active',
    objective: SECRET_OBJECTIVE,
    blockedReason: SECRET_REASON,
    maxGoalRounds: 9,
  }
  const value: Record<string, unknown> = { goal, roundsStarted: 3, createdAt: 7 }
  if (options.updatedAt !== undefined) value.updatedAt = options.updatedAt
  return value
}

/** 一条携带其余投影诱饵的 session/list item。 */
function leakyItem(values: unknown): Record<string, unknown> {
  return {
    sessionId: 's1',
    running: false,
    updatedAt: 100,
    title: 'PRIVATE-TITLE',
    cwd: '/private/cwd',
    parentSessionId: 'p0',
    projections: { values },
  }
}

test('P2b: the projection whitelist drops every non-goal key plus objective/blockedReason', () => {
  const item = leakyItem({
    title: 'PRIVATE-TITLE',
    todos: [{ text: 'PRIVATE-TODO' }],
    inbox: { body: 'PRIVATE-INBOX' },
    goal: goalProjection({ id: 'g1', revision: 4, phase: 'active', updatedAt: 1_700_000_000_000 }),
  })
  const row = rowFromListItem(item)
  assert.notEqual(row, null)
  assert.deepEqual(row?.goal, {
    goalId: 'g1', revision: 4, phase: 'active', updatedAt: 1_700_000_000_000,
  })
  assert.deepEqual(Object.keys((row?.goal ?? {}) as object).sort(), ['goalId', 'phase', 'revision', 'updatedAt'])
  const serialized = JSON.stringify(row)
  for (const secret of [
    'PRIVATE-TITLE', 'PRIVATE-TODO', 'PRIVATE-INBOX', SECRET_OBJECTIVE, SECRET_REASON,
    'maxGoalRounds', 'roundsStarted', 'createdAt', 'todos', 'inbox', 'cwd',
  ]) {
    assert.equal(serialized.includes(secret), false, 'the row must not carry ' + secret)
  }
  // 解析器只读白名单字段：可执行源码（去注释）不得出现禁键 —— 「读了又扔」不算丢弃。
  const code = SOURCE.split('\n')
    .filter(line => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'))
    .join('\n')
  for (const forbidden of ["'objective'", 'blockedReason', 'maxGoalRounds', 'roundsStarted', 'todos', 'inbox', "'cwd'", "'title'"]) {
    assert.equal(code.includes(forbidden), false, 'executable source must not read ' + forbidden)
  }
})

test('P2b: goal keeps three distinguishable values (unknown never becomes "no goal")', () => {
  const unknownItems: Record<string, unknown>[] = [
    { sessionId: 's1', running: false, updatedAt: 1 },
    { sessionId: 's1', running: false, updatedAt: 1, projections: {} },
    { sessionId: 's1', running: false, updatedAt: 1, projections: { values: {} } },
    { sessionId: 's1', running: false, updatedAt: 1, projections: { values: { goal: undefined } } },
    { sessionId: 's1', running: false, updatedAt: 1, projections: 'not-a-record' },
    leakyItem({ goal: { goal: null } }),
    leakyItem({ goal: { goal: { id: 'g1', revision: 0, phase: 'active' } } }),
    leakyItem({ goal: { goal: { id: 'g1', revision: 1.5, phase: 'active' } } }),
    leakyItem({ goal: { goal: { id: '', revision: 1, phase: 'active' } } }),
    leakyItem({ goal: { goal: { id: 'g1', revision: 1, phase: 'running' } } }),
    leakyItem({ goal: { goal: [] } }),
    leakyItem({ goal: 'nope' }),
  ]
  for (const item of unknownItems) {
    const row = rowFromListItem(item)
    assert.notEqual(row, null)
    assert.equal(hasKey(row, 'goal'), false, 'unknown must not write the field: ' + JSON.stringify(item))
    assert.equal(parseProjectedGoalFact(item), undefined)
  }
  // null = 宿主明确无当前 goal（字段存在且为 null）。
  const nulled = rowFromListItem(leakyItem({ goal: null }))
  assert.equal(hasKey(nulled, 'goal'), true)
  assert.equal(nulled?.goal, null)
  assert.equal(parseProjectedGoalFact(leakyItem({ goal: null })), null)
  // 对象 = 白名单事实；非法/缺失水位只是水位缺席（不否决事实、不臆造钟）。
  const known = rowFromListItem(leakyItem({ goal: goalProjection({ id: 'g2', revision: 2, phase: 'blocked' }) }))
  assert.deepEqual(known?.goal, { goalId: 'g2', revision: 2, phase: 'blocked' })
  assert.equal(hasKey(known?.goal, 'updatedAt'), false)
  assert.equal(parseProjectedGoalFact(leakyItem({ goal: goalProjection({ updatedAt: 1.5 }) }))?.updatedAt, undefined)
  assert.equal(parseProjectedGoalFact(leakyItem({ goal: goalProjection({ updatedAt: -1 }) }))?.updatedAt, undefined)
})

test('P2b: baseline goal merge is three-valued and preserves activation only for the same goalId', () => {
  const previous = rowFromListItem(leakyItem({ goal: goalProjection({ id: 'g1', revision: 1, phase: 'active' }) }))
  assert.notEqual(previous, null)
  const armed = { ...previous!, goal: { goalId: 'g1', revision: 1, phase: 'active' as const, activation: 'armed' as const } }
  // unknown 的基线行（无 projections/goal 键）绝不擦掉已知 goal 与 activation。
  const kept = mergeBaselineRow(armed, rowFromListItem({ sessionId: 's1', running: false, updatedAt: 2 })!, 10)
  assert.deepEqual(kept.goal, { goalId: 'g1', revision: 1, phase: 'active', activation: 'armed' })
  // null 明确清空。
  const cleared = mergeBaselineRow(armed, rowFromListItem(leakyItem({ goal: null }))!, 11)
  assert.equal(cleared.goal, null)
  // 对象刷新 revision/相位/水位；goalId 不变 ⇒ activation 保留。
  const refreshed = mergeBaselineRow(armed, rowFromListItem(leakyItem({
    goal: goalProjection({ id: 'g1', revision: 2, phase: 'paused', updatedAt: 77 }),
  }))!, 12)
  assert.deepEqual(refreshed.goal, { goalId: 'g1', revision: 2, phase: 'paused', updatedAt: 77, activation: 'armed' })
  // goalId 变了 ⇒ 旧 activation 绝不继承（新目标未武装 = unknown）。
  const replaced = mergeBaselineRow(armed, rowFromListItem(leakyItem({
    goal: goalProjection({ id: 'g9', revision: 1, phase: 'active' }),
  }))!, 13)
  assert.deepEqual(replaced.goal, { goalId: 'g9', revision: 1, phase: 'active' })
})

test('P2b: goal/activation-changed parsing never guesses a malformed edge', () => {
  assert.deepEqual(
    parseGoalActivationArgs([{ sessionId: 's1', goal: { id: 'g1', revision: 1, activation: 'armed' } }]),
    { sessionId: 's1', activation: 'armed', goalId: 'g1' },
  )
  assert.deepEqual(
    parseGoalActivationArgs({ sessionId: 's1', goal: { id: 'g1', revision: 2, activation: 'disarmed' } }),
    { sessionId: 's1', activation: 'disarmed', goalId: 'g1' },
  )
  // goal 缺席 = 宿主当前无 goal（明确 null），不是形状错误。
  assert.deepEqual(parseGoalActivationArgs([{ sessionId: 's1' }]), { sessionId: 's1', activation: null, goalId: null })
  // id 缺失但 activation 有效：接受为未绑定边（镜像 P2a 只读 activation 的宽松）。
  assert.deepEqual(
    parseGoalActivationArgs([{ sessionId: 's1', goal: { activation: 'armed' } }]),
    { sessionId: 's1', activation: 'armed', goalId: null },
  )
  for (const bad of [
    undefined, null, 'nope', [], [{}],
    [{ sessionId: '' }],
    [{ sessionId: 5 }],
    [{ sessionId: 's1', goal: null }],
    [{ sessionId: 's1', goal: 'armed' }],
    [{ sessionId: 's1', goal: { id: 'g1', activation: 'maybe' } }],
    [{ sessionId: 's1', goal: { activation: 'ARMED' } }],
    ['not-a-record'],
  ]) {
    assert.equal(parseGoalActivationArgs(bad), null, JSON.stringify(bad))
  }
})

test('P2b: activation merges into the row, emits only on change, and waits for a late baseline row', async () => {
  const sockets: FakeSocket[] = []
  const snapshots: unknown[] = []
  const facts = createSourceMuxFacts({
    sourceId: 'ssh-goal-1', origin: 'http://cp', now: () => 500, onSnapshot: s => snapshots.push(s),
    openSocket: () => { const s = new FakeSocket(); sockets.push(s); return s },
    fetchImpl: rpcFetch({
      'session/list': () => ({ items: [leakyItem({ goal: goalProjection({ id: 'g1', revision: 1, phase: 'active', updatedAt: 9 }) })] }),
    }) as never,
  })
  try {
    facts.start()
    sockets[0].open()
    await new Promise(resolve => setTimeout(resolve, 5))
    sockets[0].item({ type: 'ready', clientId: 'c' })
    await new Promise(resolve => setTimeout(resolve, 5))
    const before = snapshots.length
    // 未知会话 s2 的 activation 先到：只记进程内表，不建行、不推快照。
    sockets[0].item({ type: 'emit', event: 'goal/activation-changed', args: [{ sessionId: 's2', goal: { id: 'g2', revision: 1, activation: 'armed' } }] })
    assert.equal(snapshots.length, before, 'no row yet means no snapshot churn')
    // 已知行 s1：armed 值变化 ⇒ 走既有 snapshot emit 路径；事件不得改写 goal 身份/水位。
    sockets[0].item({ type: 'emit', event: 'goal/activation-changed', args: [{ sessionId: 's1', goal: { id: 'g1', revision: 1, activation: 'armed' } }] })
    let last = snapshots.at(-1) as { rows: Record<string, Record<string, unknown>> }
    assert.deepEqual(last.rows['s1']?.goal, {
      goalId: 'g1', revision: 1, phase: 'active', updatedAt: 9, activation: 'armed',
    })
    const armedCount = snapshots.length
    // 重复边：值未变 ⇒ 不再推快照。
    sockets[0].item({ type: 'emit', event: 'goal/activation-changed', args: [{ sessionId: 's1', goal: { id: 'g1', revision: 1, activation: 'armed' } }] })
    assert.equal(snapshots.length, armedCount, 'an unchanged activation must not re-emit')
    // disarmed 值变化 ⇒ 推快照。
    sockets[0].item({ type: 'emit', event: 'goal/activation-changed', args: [{ sessionId: 's1', goal: { id: 'g1', revision: 1, activation: 'disarmed' } }] })
    last = snapshots.at(-1) as { rows: Record<string, Record<string, unknown>> }
    assert.equal((last.rows['s1']?.goal as Record<string, unknown>)?.activation, 'disarmed')
    // s2 后来由 added 带 goal 建行：进程内 armed 必须合并上去（边先于基线到）。
    sockets[0].item({ type: 'emit', event: 'api-session/added', args: [{ sessionId: 's2', running: false, updatedAt: 3, projections: { values: { goal: goalProjection({ id: 'g2', revision: 1, phase: 'paused' }) } } }] })
    last = snapshots.at(-1) as { rows: Record<string, Record<string, unknown>> }
    assert.deepEqual(last.rows['s2']?.goal, { goalId: 'g2', revision: 1, phase: 'paused', activation: 'armed' })
    // goal 缺席的 activation 边 = 宿主明确无 goal：已知对象 ⇒ 清成 null（不是忽略）。
    sockets[0].item({ type: 'emit', event: 'goal/activation-changed', args: [{ sessionId: 's1' }] })
    last = snapshots.at(-1) as { rows: Record<string, Record<string, unknown>> }
    assert.equal(hasKey(last.rows['s1'], 'goal'), true)
    assert.equal(last.rows['s1']?.goal, null)
    assert.equal(sockets[0].followOpens.length, 0, 'goal edges never open a follow')
  } finally {
    facts.stop()
  }
})

test('P2b: activation is bound to the goal identity — a stale edge never arms a different goal', async () => {
  const sockets: FakeSocket[] = []
  const snapshots: unknown[] = []
  const facts = createSourceMuxFacts({
    sourceId: 'ssh-goal-bind', origin: 'http://cp', now: () => 700, onSnapshot: s => snapshots.push(s),
    openSocket: () => { const s = new FakeSocket(); sockets.push(s); return s },
    fetchImpl: rpcFetch({
      'session/list': () => ({ items: [leakyItem({ goal: goalProjection({ id: 'g1', revision: 1, phase: 'active', updatedAt: 5 }) })] }),
    }) as never,
  })
  try {
    facts.start()
    sockets[0].open()
    await new Promise(resolve => setTimeout(resolve, 5))
    sockets[0].item({ type: 'ready', clientId: 'c' })
    sockets[0].item({ type: 'emit', event: 'goal/activation-changed', args: [{ sessionId: 's1', goal: { id: 'g1', revision: 1, activation: 'armed' } }] })
    let last = snapshots.at(-1) as { rows: Record<string, Record<string, unknown>> }
    assert.equal((last.rows['s1']?.goal as Record<string, unknown>)?.activation, 'armed')
    // 宿主换了目标：added 带来 g2 ⇒ 旧 g1 的 armed 绝不落到 g2 上，且缓存被 drop。
    sockets[0].item({ type: 'emit', event: 'api-session/added', args: [{ sessionId: 's1', running: false, updatedAt: 101, projections: { values: { goal: goalProjection({ id: 'g2', revision: 1, phase: 'active' }) } } }] })
    last = snapshots.at(-1) as { rows: Record<string, Record<string, unknown>> }
    assert.deepEqual(last.rows['s1']?.goal, { goalId: 'g2', revision: 1, phase: 'active' })
    // 缓存已 drop：即使 g1 再次出现，也不得复活旧 armed。
    sockets[0].item({ type: 'emit', event: 'api-session/added', args: [{ sessionId: 's1', running: false, updatedAt: 102, projections: { values: { goal: goalProjection({ id: 'g1', revision: 1, phase: 'active', updatedAt: 5 }) } } }] })
    last = snapshots.at(-1) as { rows: Record<string, Record<string, unknown>> }
    assert.deepEqual(last.rows['s1']?.goal, { goalId: 'g1', revision: 1, phase: 'active', updatedAt: 5 })
  } finally {
    facts.stop()
  }
})

test('P2b: a fresh ready generation clears the in-memory activation but keeps the durable fact', async () => {
  const sockets: FakeSocket[] = []
  const snapshots: unknown[] = []
  const facts = createSourceMuxFacts({
    sourceId: 'ssh-goal-2', origin: 'http://cp', now: () => 600, onSnapshot: s => snapshots.push(s),
    silenceTimeoutMs: 25,
    openSocket: () => { const s = new FakeSocket(); sockets.push(s); return s },
    fetchImpl: rpcFetch({
      'session/list': () => ({ items: [leakyItem({ goal: goalProjection({ id: 'g1', revision: 2, phase: 'active', updatedAt: 9 }) })] }),
    }) as never,
  })
  try {
    facts.start()
    sockets[0].open()
    await new Promise(resolve => setTimeout(resolve, 5))
    sockets[0].item({ type: 'ready', clientId: 'c' })
    sockets[0].item({ type: 'emit', event: 'goal/activation-changed', args: [{ sessionId: 's1', goal: { id: 'g1', revision: 2, activation: 'armed' } }] })
    let last = snapshots.at(-1) as { rows: Record<string, Record<string, unknown>> }
    assert.equal((last.rows['s1']?.goal as Record<string, unknown>)?.activation, 'armed')
    // 静默重订 ⇒ 新 socket + 新 ready 代际。
    await new Promise(resolve => setTimeout(resolve, 60))
    assert.ok(sockets.length >= 2, 'silence must resubscribe')
    sockets.at(-1)!.open()
    sockets.at(-1)!.item({ type: 'ready', clientId: 'c' })
    await new Promise(resolve => setTimeout(resolve, 10))
    last = snapshots.at(-1) as { rows: Record<string, Record<string, unknown>> }
    const goal = last.rows['s1']?.goal as Record<string, unknown>
    assert.equal(goal?.goalId, 'g1', 'the durable goal fact survives the generation change')
    assert.equal(goal?.revision, 2)
    assert.equal(hasKey(goal, 'activation'), false, 'activation is cleared back to unknown')
    // 表也被清空：后继 added 携带同 goalId 时不得复活旧 armed。
    sockets.at(-1)!.item({ type: 'emit', event: 'api-session/added', args: [{ sessionId: 's1', running: false, updatedAt: 100, projections: { values: { goal: goalProjection({ id: 'g1', revision: 2, phase: 'active', updatedAt: 9 }) } } }] })
    last = snapshots.at(-1) as { rows: Record<string, Record<string, unknown>> }
    assert.equal(hasKey(last.rows['s1']?.goal, 'activation'), false, 'the cleared map must not re-apply the old activation')
  } finally {
    facts.stop()
  }
})

test('P2b: stop() ends the generation and leaves no process-local activation behind', async () => {
  const sockets: FakeSocket[] = []
  const snapshots: unknown[] = []
  const facts = createSourceMuxFacts({
    sourceId: 'ssh-goal-stop', origin: 'http://cp', now: () => 800, onSnapshot: s => snapshots.push(s),
    openSocket: () => { const s = new FakeSocket(); sockets.push(s); return s },
    fetchImpl: rpcFetch({
      'session/list': () => ({ items: [leakyItem({ goal: goalProjection({ id: 'g1', revision: 1, phase: 'active', updatedAt: 5 }) })] }),
    }) as never,
  })
  try {
    facts.start()
    sockets[0].open()
    await new Promise(resolve => setTimeout(resolve, 5))
    sockets[0].item({ type: 'ready', clientId: 'c' })
    sockets[0].item({ type: 'emit', event: 'goal/activation-changed', args: [{ sessionId: 's1', goal: { id: 'g1', revision: 1, activation: 'armed' } }] })
    let last = snapshots.at(-1) as { rows: Record<string, Record<string, unknown>> }
    assert.equal((last.rows['s1']?.goal as Record<string, unknown>)?.activation, 'armed')
    facts.stop()
    const before = snapshots.length
    facts.start()
    // 基线挂在载波 onopen 上（可靠性轮：握手前不得宣称有可信事实）⇒ 重连须显式开新 socket。
    sockets.at(-1)!.open()
    await new Promise(resolve => setTimeout(resolve, 5))
    assert.ok(snapshots.length > before, 'restart re-baselines')
    last = snapshots.at(-1) as { rows: Record<string, Record<string, unknown>> }
    assert.equal(last.rows['s1']?.goal !== null && typeof last.rows['s1']?.goal === 'object', true, 'the durable fact is re-read')
    assert.equal(hasKey(last.rows['s1']?.goal, 'activation'), false, 'a retired generation leaves no activation behind')
  } finally {
    facts.stop()
  }
})

test('P2b: goal edges never disturb the status completion edge', async () => {
  const sockets: FakeSocket[] = []
  const snapshots: unknown[] = []
  const follows: unknown[] = []
  const facts = createSourceMuxFacts({
    sourceId: 'ssh-goal-3', origin: 'http://cp', now: () => 900, onSnapshot: s => snapshots.push(s),
    openSocket: () => { const s = new FakeSocket(); sockets.push(s); return s },
    fetchImpl: rpcFetch({
      'session/list': () => ({ items: [leakyItem({ goal: goalProjection({ id: 'g1', revision: 1, phase: 'active', updatedAt: 5 }) })] }),
    }) as never,
  })
  try {
    facts.start()
    sockets[0].open()
    // follow 走 MUX 流：对 open 帧回一条 legacy snapshot.tail（无 host 时间 ⇒ 观察者戳降级）。
    sockets[0].onFollowOpen = (streamId, payload) => {
      follows.push(payload)
      sockets[0].followItem(streamId, { snapshot: { tail: { turn: { reason: { kind: 'completed' } } } } })
    }
    await new Promise(resolve => setTimeout(resolve, 5))
    sockets[0].item({ type: 'ready', clientId: 'c' })
    assert.equal(follows.length, 0, 'consuming the baseline opens no follow')
    sockets[0].item({ type: 'emit', event: 'api-session/status', args: ['s1', true] })
    sockets[0].item({ type: 'emit', event: 'goal/activation-changed', args: [{ sessionId: 's1', goal: { id: 'g1', revision: 1, activation: 'armed' } }] })
    sockets[0].item({ type: 'emit', event: 'api-session/status', args: ['s1', false] })
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(follows.length, 1, 'exactly one follow per status true->false edge')
    assert.equal(facts.status().edges, 1)
    let row = (snapshots.at(-1) as { rows: Record<string, Record<string, unknown>> }).rows['s1']
    assert.equal(row?.completedAt, 900)
    assert.equal(row?.completedAtSource, 'reconstructed')
    assert.equal((row?.goal as Record<string, unknown>)?.activation, 'armed', 'the completion edge must not clobber the goal fact')
    // re-run（running=true）照旧结算旧完成，但 goal/activation 保留。
    sockets[0].item({ type: 'emit', event: 'api-session/status', args: ['s1', true] })
    row = (snapshots.at(-1) as { rows: Record<string, Record<string, unknown>> }).rows['s1']
    assert.equal(row?.completedAt, null)
    assert.equal((row?.goal as Record<string, unknown>)?.activation, 'armed')
  } finally {
    facts.stop()
  }
})

// ── no-goal 边的即时语义与 bound 边保留（2026-12 修复批次） ──────────────────────

function itemFor(sessionId: string, goal: Record<string, unknown>): Record<string, unknown> {
  return { ...leakyItem({ goal }), sessionId }
}

test('P2b: an unknown row no-goal edge is never cached — the in-flight baseline goal survives it', async () => {
  const sockets: FakeSocket[] = []
  const snapshots: unknown[] = []
  let items: unknown[] = []
  const facts = createSourceMuxFacts({
    sourceId: 'ssh-goal-nogoal-race', origin: 'http://cp', now: () => 1_100, onSnapshot: s => snapshots.push(s),
    openSocket: () => { const s = new FakeSocket(); sockets.push(s); return s },
    fetchImpl: rpcFetch({ 'session/list': () => ({ items }) }) as never,
  })
  try {
    facts.start()
    sockets[0].open()
    await new Promise(resolve => setTimeout(resolve, 5))
    sockets[0].item({ type: 'ready', clientId: 'c' })
    const before = snapshots.length
    // 竞态：新 baseline 在途时 no-goal 先到（s2 行尚不存在）。
    items = [itemFor('s2', goalProjection({ id: 'g2', revision: 1, phase: 'active', updatedAt: 7 }))]
    sockets[0].open()
    sockets[0].item({ type: 'emit', event: 'goal/activation-changed', args: [{ sessionId: 's2' }] })
    assert.equal(snapshots.length, before, 'no-goal for an unknown row must not fabricate a row or a snapshot')
    await new Promise(resolve => setTimeout(resolve, 5))
    const last = snapshots.at(-1) as { rows: Record<string, Record<string, unknown>> }
    // 旧 bug：缓存的 no-goal 在基线建行时把 g2 压成 null（且此后 armed 永远 no-op）。
    assert.deepEqual(last.rows['s2']?.goal, { goalId: 'g2', revision: 1, phase: 'active', updatedAt: 7 })
    assert.notEqual(last.rows['s2']?.goal, null)
  } finally {
    facts.stop()
  }
})

test('P2b: a no-goal edge clears a known goal row to explicit null and is not retained', async () => {
  const sockets: FakeSocket[] = []
  const snapshots: unknown[] = []
  const facts = createSourceMuxFacts({
    sourceId: 'ssh-goal-nogoal-known', origin: 'http://cp', now: () => 1_200, onSnapshot: s => snapshots.push(s),
    openSocket: () => { const s = new FakeSocket(); sockets.push(s); return s },
    fetchImpl: rpcFetch({
      'session/list': () => ({ items: [leakyItem({ goal: goalProjection({ id: 'g1', revision: 1, phase: 'active', updatedAt: 5 }) })] }),
    }) as never,
  })
  try {
    facts.start()
    sockets[0].open()
    await new Promise(resolve => setTimeout(resolve, 5))
    sockets[0].item({ type: 'ready', clientId: 'c' })
    sockets[0].item({ type: 'emit', event: 'goal/activation-changed', args: [{ sessionId: 's1' }] })
    let last = snapshots.at(-1) as { rows: Record<string, Record<string, unknown>> }
    assert.equal(hasKey(last.rows['s1'], 'goal'), true, 'a known object goal resolves to an explicit null field')
    assert.equal(last.rows['s1']?.goal, null)
    // 重复 no-goal：已知事实已是 null ⇒ 不再推快照（也绝不缓存成边）。
    const settled = snapshots.length
    sockets[0].item({ type: 'emit', event: 'goal/activation-changed', args: [{ sessionId: 's1' }] })
    assert.equal(snapshots.length, settled, 'a repeated no-goal over an explicit null must not re-emit')
  } finally {
    facts.stop()
  }
})

test('P2b: after a no-goal edge, a same-id armed event still lands (no stale no-goal cache)', async () => {
  const sockets: FakeSocket[] = []
  const snapshots: unknown[] = []
  const items: unknown[] = []
  const facts = createSourceMuxFacts({
    sourceId: 'ssh-goal-nogoal-then-armed', origin: 'http://cp', now: () => 1_300, onSnapshot: s => snapshots.push(s),
    openSocket: () => { const s = new FakeSocket(); sockets.push(s); return s },
    fetchImpl: rpcFetch({ 'session/list': () => ({ items }) }) as never,
  })
  try {
    facts.start()
    sockets[0].open()
    await new Promise(resolve => setTimeout(resolve, 5))
    sockets[0].item({ type: 'ready', clientId: 'c' })
    // no-goal 先到（未知行）⇒ 不缓存；基线随后报出 g2；再来的 g2 armed 必须能落行。
    sockets[0].item({ type: 'emit', event: 'goal/activation-changed', args: [{ sessionId: 's2' }] })
    items.push(itemFor('s2', goalProjection({ id: 'g2', revision: 1, phase: 'active' })))
    sockets[0].open()
    await new Promise(resolve => setTimeout(resolve, 5))
    let last = snapshots.at(-1) as { rows: Record<string, Record<string, unknown>> }
    assert.deepEqual(last.rows['s2']?.goal, { goalId: 'g2', revision: 1, phase: 'active' })
    sockets[0].item({ type: 'emit', event: 'goal/activation-changed', args: [{ sessionId: 's2', goal: { id: 'g2', revision: 1, activation: 'armed' } }] })
    last = snapshots.at(-1) as { rows: Record<string, Record<string, unknown>> }
    assert.deepEqual(last.rows['s2']?.goal, { goalId: 'g2', revision: 1, phase: 'active', activation: 'armed' })
  } finally {
    facts.stop()
  }
})

test('P2b: a bound edge whose id differs from the projection is retained for a later matching baseline', async () => {
  const sockets: FakeSocket[] = []
  const snapshots: unknown[] = []
  let items: unknown[] = [leakyItem({ goal: goalProjection({ id: 'g1', revision: 1, phase: 'active', updatedAt: 5 }) })]
  const facts = createSourceMuxFacts({
    sourceId: 'ssh-goal-retain-bound', origin: 'http://cp', now: () => 1_400, onSnapshot: s => snapshots.push(s),
    openSocket: () => { const s = new FakeSocket(); sockets.push(s); return s },
    fetchImpl: rpcFetch({ 'session/list': () => ({ items }) }) as never,
  })
  try {
    facts.start()
    sockets[0].open()
    await new Promise(resolve => setTimeout(resolve, 5))
    sockets[0].item({ type: 'ready', clientId: 'c' })
    // g2 的 armed 边早于投影：只保留，绝不落到当前 g1 上。
    sockets[0].item({ type: 'emit', event: 'goal/activation-changed', args: [{ sessionId: 's1', goal: { id: 'g2', revision: 1, activation: 'armed' } }] })
    let last = snapshots.at(-1) as { rows: Record<string, Record<string, unknown>> }
    assert.deepEqual(last.rows['s1']?.goal, { goalId: 'g1', revision: 1, phase: 'active', updatedAt: 5 })
    // 一次投影仍为 g1（不一致）不得丢弃保留边（P2a applyRetainedGoalActivation 同规）。
    sockets[0].open()
    await new Promise(resolve => setTimeout(resolve, 5))
    last = snapshots.at(-1) as { rows: Record<string, Record<string, unknown>> }
    assert.deepEqual(last.rows['s1']?.goal, { goalId: 'g1', revision: 1, phase: 'active', updatedAt: 5 })
    // 投影终于带上 g2：保留边在命中的那一刻落行并被消费。
    items = [leakyItem({ goal: goalProjection({ id: 'g2', revision: 1, phase: 'active', updatedAt: 7 }) })]
    sockets[0].open()
    await new Promise(resolve => setTimeout(resolve, 5))
    last = snapshots.at(-1) as { rows: Record<string, Record<string, unknown>> }
    assert.deepEqual(last.rows['s1']?.goal, { goalId: 'g2', revision: 1, phase: 'active', updatedAt: 7, activation: 'armed' })
    // 已消费：再报 g1 也不得复活 g2 的 armed。
    items = [leakyItem({ goal: goalProjection({ id: 'g1', revision: 1, phase: 'active', updatedAt: 5 }) })]
    sockets[0].open()
    await new Promise(resolve => setTimeout(resolve, 5))
    last = snapshots.at(-1) as { rows: Record<string, Record<string, unknown>> }
    assert.deepEqual(last.rows['s1']?.goal, { goalId: 'g1', revision: 1, phase: 'active', updatedAt: 5 })
  } finally {
    facts.stop()
  }
})
