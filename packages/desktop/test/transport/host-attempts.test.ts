/**
 * B（v2 §P2-B / O2）：宿主统一尝试调度器（transport-reconnect.ts）。
 * 1) planHostAttempts 纯函数矩阵（startup/added/wake × quitting/plane/suppressed/unknown/phase/terminal）；
 * 2) runHostAttempts 执行器：错峰定时器、票据四查（意图/行修订/传输代/退出）、永不 reject；
 * 3) reconnectStaleTransports 历史入口经同一规划器（唤醒相位筛/终态跳过/2 参告警面不变）；
 * 4) getAttemptFacts 的 manager 事实面（对象身份 + 传输代）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  cancelHostAttemptTimers, planHostAttempts, reconnectStaleTransports, runHostAttempts,
  type HostAttemptDeps, type HostAttemptFacts, type HostAttemptPlanInput, type HostAttemptTimer,
} from '../../transport-reconnect.ts'
import type { ConnectionIntentSnapshot } from '../../connection-intent.ts'
import { createTransportManager } from '../../transport-manager.ts'
import { sshProvider } from '../../ssh-provider.ts'
import { silentLogger, tempDir } from '../support/transport-manager-harness.ts'

const phaseStatus = (phase: string, requiresUserAction = false) => ({ phase: phase as never, requiresUserAction })

test('planHostAttempts: quitting short-circuits, plane gates startup/added only, suppression before phase', () => {
  const statuses: Record<string, { phase: string; requiresUserAction: boolean }> = {
    idle: phaseStatus('idle'), err: phaseStatus('error'), degraded: phaseStatus('degraded'),
    terminal: phaseStatus('error', true), ready: phaseStatus('ready'),
  }
  const input = (overrides: Partial<HostAttemptPlanInput> = {}): HostAttemptPlanInput => ({
    kind: 'startup',
    ids: Object.keys(statuses),
    isQuitting: false,
    planeBound: true,
    suppressed: new Set<string>(),
    status: (id: string) => statuses[id] === undefined ? null : phaseStatus(statuses[id]!.phase, statuses[id]!.requiresUserAction),
    ...overrides,
  })
  assert.deepEqual(planHostAttempts(input()).map(row => row.action),
    ['connect', 'skip-not-idle', 'skip-not-idle', 'skip-not-idle', 'skip-not-idle'])
  assert.deepEqual(planHostAttempts(input({ kind: 'added', ids: ['idle'] })).map(row => row.action), ['connect'])
  assert.deepEqual(planHostAttempts(input({ planeBound: false })).every(row => row.action === 'skip-plane'), true)
  // wake 不受 plane 门约束（既有 OS 唤醒时序），只 re-probe error/degraded 非终态。
  assert.deepEqual(planHostAttempts(input({ kind: 'wake', planeBound: false })).map(row => row.action),
    ['skip-not-idle', 'connect', 'connect', 'skip-terminal', 'skip-not-idle'])
  assert.deepEqual(planHostAttempts(input({ isQuitting: true })).every(row => row.action === 'skip-quitting'), true)
  assert.deepEqual(planHostAttempts(input({ suppressed: new Set(['idle']), ids: ['idle'] })).map(row => row.action), ['skip-suppressed'])
  assert.deepEqual(planHostAttempts(input({ ids: ['ghost'] })).map(row => row.action), ['skip-unknown'])
  assert.deepEqual(planHostAttempts(input({ ids: [] })), [])
})

interface FakeDeps {
  readonly deps: HostAttemptDeps
  readonly connected: string[]
  readonly timers: Array<{ run: () => void; ms: number }>
  readonly facts: Map<string, HostAttemptFacts>
  revision: number
  suppressed: Set<string>
  quitting: boolean
}

function fakeDeps(initial: {
  ids: string[]
  phases?: Record<string, string>
  requiresUserAction?: Record<string, boolean>
  suppressed?: string[]
  revision?: number
  quitting?: boolean
  planeBound?: boolean
}): FakeDeps {
  const connected: string[] = []
  const timers: Array<{ run: () => void; ms: number }> = []
  const facts = new Map<string, HostAttemptFacts>()
  const fake: FakeDeps = {
    deps: undefined as unknown as HostAttemptDeps,
    connected,
    timers,
    facts,
    revision: initial.revision ?? 0,
    suppressed: new Set(initial.suppressed ?? []),
    quitting: initial.quitting === true,
  }
  const snapshot = (): ConnectionIntentSnapshot => ({
    session: 'app-session-aaaa0000',
    suppressed: new Set(fake.suppressed),
    revision: fake.revision,
    rostersWritable: true,
  })
  const deps: HostAttemptDeps = {
    listInstances: () => initial.ids.map(id => ({ id })),
    status: id => initial.phases?.[id] === undefined ? null : phaseStatus(initial.phases[id]!, initial.requiresUserAction?.[id] === true),
    connect: id => { connected.push(id) },
    connectionIntents: snapshot,
    getAttemptFacts: id => facts.get(id) ?? null,
    isQuitting: () => fake.quitting,
    planeBound: () => initial.planeBound !== false,
    log: () => {},
    setTimer: (run, ms): HostAttemptTimer => {
      timers.push({ run, ms })
      return { cancel: () => { const index = timers.findIndex(timer => timer.run === run); if (index >= 0) timers.splice(index, 1) } }
    },
  }
  ;(fake as { deps: HostAttemptDeps }).deps = deps
  return fake
}

test('runHostAttempts startup: connects idle rows, skips suppressed/unknown/quitting/plane-unbound', async () => {
  const fake = fakeDeps({ ids: ['a', 'b', 'ghost'], phases: { a: 'idle', b: 'idle' }, suppressed: ['b'] })
  await runHostAttempts(fake.deps, { kind: 'startup' })
  assert.deepEqual(fake.connected, ['a'])
  const quitting = fakeDeps({ ids: ['a'], phases: { a: 'idle' }, quitting: true })
  await runHostAttempts(quitting.deps, { kind: 'startup' })
  assert.deepEqual(quitting.connected, [])
  const unbound = fakeDeps({ ids: ['a'], phases: { a: 'idle' }, planeBound: false })
  await runHostAttempts(unbound.deps, { kind: 'startup' })
  assert.deepEqual(unbound.connected, [])
})

test('runHostAttempts added: only the given ids; a row deleted before the wave is skipped', async () => {
  const fake = fakeDeps({ ids: ['a', 'b', 'c'], phases: { a: 'idle', b: 'idle', c: 'idle' } })
  await runHostAttempts(fake.deps, { kind: 'added', ids: ['b'] })
  assert.deepEqual(fake.connected, ['b'])
  const deleted = fakeDeps({ ids: ['x'], phases: { x: 'idle' } })
  await runHostAttempts(deleted.deps, { kind: 'added', ids: ['y', 'deleted'] })
  assert.deepEqual(deleted.connected, [])
})

test('runHostAttempts wake: keeps the historical error/degraded + non-terminal filter', async () => {
  const fake = fakeDeps({
    ids: ['idle', 'err', 'degraded', 'terminal', 'ready'],
    phases: { idle: 'idle', err: 'error', degraded: 'degraded', terminal: 'error', ready: 'ready' },
    requiresUserAction: { terminal: true },
  })
  await runHostAttempts(fake.deps, { kind: 'wake', staggerMs: 0 })
  assert.deepEqual(fake.connected, ['err', 'degraded'])
})

test('queued tails re-check the ticket: stale row revision, stale transport generation, new suppression, quit', async () => {
  // 每波：a 立即连、b 进错峰定时器；窗口内改变事实后 fire 必须丢弃 b。
  const base = () => fakeDeps({ ids: ['a', 'b'], phases: { a: 'idle', b: 'idle' } })

  const rowStale = base()
  await runHostAttempts(rowStale.deps, { kind: 'startup', staggerMs: 30 })
  assert.deepEqual(rowStale.connected, ['a'])
  assert.equal(rowStale.timers.length, 1)
  rowStale.facts.set('b', { state: { id: 'b' }, tunnelEpoch: 1 })
  rowStale.revision += 1 // 保存/意图写
  rowStale.timers[0]!.run()
  assert.deepEqual(rowStale.connected, ['a'], 'a stale row revision drops the queued attempt')

  const transportStale = base()
  const stateB = { id: 'b' }
  transportStale.facts.set('b', { state: stateB, tunnelEpoch: 1 })
  await runHostAttempts(transportStale.deps, { kind: 'startup', staggerMs: 30 })
  assert.deepEqual(transportStale.connected, ['a'])
  assert.equal(transportStale.timers.length, 1)
  transportStale.facts.set('b', { state: stateB, tunnelEpoch: 2 })
  transportStale.timers[0]!.run()
  assert.deepEqual(transportStale.connected, ['a'], 'a stale transport generation drops the queued attempt')

  const intentStale = fakeDeps({ ids: ['a', 'b', 'c'], phases: { a: 'idle', b: 'idle', c: 'idle' }, suppressed: ['a'] })
  await runHostAttempts(intentStale.deps, { kind: 'startup', staggerMs: 30 })
  assert.deepEqual(intentStale.connected, ['b'])
  assert.equal(intentStale.timers.length, 1)
  intentStale.suppressed = new Set(['a', 'c'])
  intentStale.timers[0]!.run()
  assert.deepEqual(intentStale.connected, ['b'], 'a new suppression inside the window drops the queued attempt')

  const quitting = base()
  await runHostAttempts(quitting.deps, { kind: 'startup', staggerMs: 30 })
  assert.deepEqual(quitting.connected, ['a'])
  quitting.quitting = true
  quitting.timers[0]!.run()
  assert.deepEqual(quitting.connected, ['a'], 'quit drops the queued attempt')
})

test('runHostAttempts never rejects: a throwing connect is a loud line, not an unhandled rejection', async () => {
  const fake = fakeDeps({ ids: ['a'], phases: { a: 'idle' } })
  const logs: string[] = []
  const throwing: HostAttemptDeps = {
    ...fake.deps,
    connect: () => { throw new Error('boom') },
    log: (level, message) => { logs.push(level + ' ' + message) },
  }
  await assert.doesNotReject(runHostAttempts(throwing, { kind: 'startup' }))
  assert.match(logs.join('\n'), /host-attempt a connect failed: boom/)
  // 旧唤醒替身保留 2 参告警面（sidecar-stdio / transport-connection-recovery 的文本口径）。
  const warnings: Array<{ id: string; error: unknown }> = []
  const legacyFake = fakeDeps({ ids: ['a'], phases: { a: 'error' } })
  const legacy: HostAttemptDeps = { ...legacyFake.deps, connect: () => { throw new Error('legacy boom') }, warnConnect: (id, error) => { warnings.push({ id, error }) } }
  await runHostAttempts(legacy, { kind: 'wake', staggerMs: 0 })
  assert.deepEqual(warnings.map(warning => warning.id), ['a'])
  assert.match(String(warnings[0]!.error), /legacy boom/)
})

test('cancelHostAttemptTimers cancels pending tails (dispose path) without touching the immediate attempt', async () => {
  const fake = fakeDeps({ ids: ['a', 'b', 'c'], phases: { a: 'idle', b: 'idle', c: 'idle' } })
  await runHostAttempts(fake.deps, { kind: 'startup', staggerMs: 30 })
  assert.deepEqual(fake.connected, ['a'])
  assert.equal(fake.timers.length, 2)
  cancelHostAttemptTimers()
  for (const timer of fake.timers) timer.run()
  assert.deepEqual(fake.connected, ['a'], 'cancelled timers never fire')
})

test('reconnectStaleTransports keeps its legacy contract: phase filter, terminal skip, 2-arg warning, null/quit no-op', () => {
  const statuses: Record<string, { phase: string; requiresUserAction: boolean }> = {
    idle: { phase: 'idle', requiresUserAction: false },
    err: { phase: 'error', requiresUserAction: false },
    degraded: { phase: 'degraded', requiresUserAction: false },
    terminal: { phase: 'error', requiresUserAction: true },
    ready: { phase: 'ready', requiresUserAction: false },
  }
  const connected: string[] = []
  const warnings: Array<{ message: string; error: unknown }> = []
  const sm = {
    listInstances: () => Object.keys(statuses).map(id => ({ id })),
    status: (id: string) => statuses[id] ?? null,
    connect: (id: string) => {
      if (id === 'degraded') throw new Error('boom')
      connected.push(id)
      return null
    },
  } as unknown as Parameters<typeof reconnectStaleTransports>[0]
  reconnectStaleTransports(sm, () => false, (message, error) => { warnings.push({ message, error }) }, '[flavor]')
  assert.deepEqual(connected, ['err'])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0]!.message, /\[flavor\] 唤醒重探 degraded 失败：/)
  assert.doesNotThrow(() => reconnectStaleTransports(null, () => false, () => { throw new Error('no-op') }, '[flavor]'))
  assert.doesNotThrow(() => reconnectStaleTransports(sm, () => true, () => { throw new Error('quit must not probe') }, '[flavor]'))
})

test('T8: disconnect inside the wake stagger window => zero late spawn (ticket transport generation)', () => {
  // 用 manager 结构面替身：第一行立即重试、第二行进错峰窗口；窗口内 disconnect 使
  // tunnelEpoch +1 ⇒ 到期票据 stale-transport，绝不复活已断开的行（B 切片 T8）。
  const facts = new Map<string, HostAttemptFacts>([
    ['err-1', { state: { row: 'err-1' }, tunnelEpoch: 1 }],
    ['err-2', { state: { row: 'err-2' }, tunnelEpoch: 1 }],
  ])
  const connected: string[] = []
  const timers: Array<() => void> = []
  const sm = {
    listInstances: () => [{ id: 'err-1' }, { id: 'err-2' }],
    status: (id: string) => ({ phase: id === 'err-1' || id === 'err-2' ? 'error' : 'idle', requiresUserAction: false }),
    connect: (id: string) => { connected.push(id); return null },
    connectionIntents: (): ConnectionIntentSnapshot => ({ session: 'app-session-aaaa0000', suppressed: new Set(), revision: 0, rostersWritable: true }),
    getAttemptFacts: (id: string) => facts.get(id) ?? null,
  } as unknown as Parameters<typeof reconnectStaleTransports>[0]
  reconnectStaleTransports(sm as never, () => false, () => {}, '[flavor]', {
    staggerMs: 40,
    setTimer: (run): HostAttemptTimer => { timers.push(run); return {} },
  })
  assert.deepEqual(connected, ['err-1'], 'the first wake retry is immediate')
  // 窗口内用户断开 err-2：传输代 +1（disconnect 语义）。
  facts.set('err-2', { state: { row: 'err-2' }, tunnelEpoch: 2 })
  for (const run of timers) run()
  assert.deepEqual(connected, ['err-1'], 'the queued retry is dropped as stale-transport (no resurrect)')
})

test('wiring lock: sidecar reconciles after ready, host owns added rows, Swift injects the app session id', () => {
  // T13/T12 的源文本锁（macOS XCTest 之外的便宜替代）：序列/接线漂移即红。
  const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')
  const entry = read('../../sidecar-entry.ts')
  const order = [
    entry.indexOf('await controlPlane.start()'),
    entry.indexOf("writeProtocolLine({ notify: 'ready'"),
    entry.indexOf("void headless.runHostAttempts({ kind: 'startup' })"),
    entry.indexOf('headless.runStartupTail()'),
  ]
  assert.ok(order.every(index => index >= 0), 'sidecar-entry must keep start/ready/reconcile/startup-tail anchors')
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'reconcile runs after the ready frame and before the startup tail (legacy branch covered)')
  const assembly = read('../../host-assembly.ts')
  assert.ok(assembly.includes("onInstancesAdded: ids => { void runHostAttempts(hostAttemptDeps(), { kind: 'added', ids }) }"),
    'authoritative additions route through the host attempt scheduler (registry stays timer-free)')
  assert.ok(assembly.includes('canAttempt: id => transportManager === null || !transportManager.connectionIntents().suppressed.has(id)'),
    'the internal attempt gate reads the single intent authority')
  // 会话身份单源：Swift 生成/注入 ↔ TS 常量/形状（跨语言锁步的源文本半）。
  const intent = read('../../connection-intent.ts')
  assert.ok(intent.includes("APP_SESSION_ID_ENV = 'DSH_CHAMBER_APP_SESSION_ID'"), 'TS mirrors the env name')
  const appDelegate = read('../../../../macos/Sources/DSHChamber/AppDelegate.swift')
  assert.ok(appDelegate.includes('childEnv["DSH_CHAMBER_APP_SESSION_ID"] = UUID().uuidString.lowercased()'),
    'AppDelegate must generate/inject the per-app-session id (one line, non-secret)')
})

test('manager getAttemptFacts exposes state-object identity and tunnelEpoch (ticket facts)', () => {
  const dir = tempDir()
  const manager = createTransportManager({
    provider: { ...sshProvider, transportSocketPath: () => null },
    spawnFn: () => { throw new Error('no spawn expected') },
    instancesFile: join(dir, 'ssh-instances.json'),
    logger: silentLogger,
  })
  try {
    assert.equal(manager.getAttemptFacts('missing'), null)
    manager.saveInstances([{ id: 's1', label: 'a', kind: 'dsh', transport: 'ssh', host: 'h.example.com', remotePort: 2222 }])
    assert.equal(manager.getAttemptFacts('s1'), null, 'no runtime state yet')
    manager.status('s1')
    const first = manager.getAttemptFacts('s1')
    assert.notEqual(first, null)
    assert.equal(manager.getAttemptFacts('s1')!.state, first!.state, 'state identity is stable')
    const epoch = first!.tunnelEpoch
    manager.disconnect('s1')
    assert.ok(manager.getAttemptFacts('s1')!.tunnelEpoch > epoch, 'disconnect bumps the transport generation')
        // 同 id 重加换状态对象（旧票据 stale-row 的既有判据）。
    const stateBefore = manager.getAttemptFacts('s1')!.state
    manager.saveInstances([])
    manager.saveInstances([{ id: 's1', label: 'a', kind: 'dsh', transport: 'ssh', host: 'h2.example.com', remotePort: 2222 }])
    const readded = manager.getAttemptFacts('s1')
    if (readded !== null) assert.notEqual(readded.state, stateBefore, 'delete+re-add gets a fresh state object')
  } finally {
    manager.dispose()
  }
})
