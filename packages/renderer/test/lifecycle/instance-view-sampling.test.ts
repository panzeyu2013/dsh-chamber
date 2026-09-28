/**
 * InstanceView 的 1 Hz 会话采样座位：**可执行**行为断言（不是源码形状锁）。
 *
 * 组件在 plain node test 里不可 value-import（React + vendor UI），所以这里把源码里的
 * effect 回调整体抽出来，用插桩 scope 直接执行：隐藏门、座位门与「隐藏 = 断档
 * re-anchor」跑的是随包发布的真实控制流，而不是重写的副本。
 *
 * 两条契约（A6）：
 *  ① 只有 active + settled + 会话在场的视图才挂 1 Hz 采样表：其余座位不读健康、不挂表；
 *  ② hidden 分支先于任何健康读取 / ladder 推进 / setState，只清 streak/rebound refs；
 *     可见期逻辑不变（mount 与每拍照常采样）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripComments } from '../../../../scripts/dev/test-support/source-text.ts'

const SOURCE = stripComments(
  readFileSync(new URL('../../src/components/InstanceView.tsx', import.meta.url), 'utf8'),
)
const EFFECT_END = '}, [active, shell.booted, shell.error, currentSessionId, instanceId])'

/** 抽出自带该依赖数组的 effect 回调体（effect 自己的闭括号不在内）。 */
function extractSamplerEffectBody(): string {
  const end = SOURCE.indexOf(EFFECT_END)
  assert.notEqual(end, -1, 'the sampler effect dep array moved — re-derive this extraction: ' + EFFECT_END)
  const start = SOURCE.lastIndexOf('useEffect(() => {', end)
  assert.notEqual(start, -1, 'the sampler effect moved — no useEffect before its dep array')
  const open = start + 'useEffect(() => {'.length
  // 去掉 TS 的 `(): void` 标注：new Function 只接受可执行的 JS。
  return SOURCE.slice(open, end).replace(/\(\): void =>/gu, '() =>')
}

const EFFECT_BODY = extractSamplerEffectBody()

/** `with` 的 scope 代理：自由标识符取自插桩表，表里没有的回落 globalThis。 */
function scopedRun(scope: Record<string, unknown>): (() => void) | undefined {
  const proxy = new Proxy(scope, {
    has: () => true,
    get: (target, key) =>
      Reflect.has(target, key) ? Reflect.get(target, key) : Reflect.get(globalThis, key),
  })
  const run = new Function('scope', `with (scope) { return (() => {${EFFECT_BODY}\n})(); }`) as
    (scope: Record<string, unknown>) => (() => void) | undefined
  return run(proxy)
}

interface SeatOptions {
  readonly active?: boolean
  readonly settled?: boolean
  /** null = 当前没有在呈会话。 */
  readonly sessionId?: string | null
}

/** 真实 effect 回调体 + 插桩 scope 的一次挂载。 */
function mountSampler(options: SeatOptions = {}) {
  const counters = { reads: 0, advances: 0, phaseWrites: [] as unknown[] }
  const intervals: Array<{ delay: number; handler: () => void }> = []
  const clearedIntervals: unknown[] = []
  const listeners = new Map<string, Array<() => void>>()
  const documentStub = {
    visibilityState: 'visible' as string,
    addEventListener: (type: string, handler: () => void): void => {
      listeners.set(type, [...(listeners.get(type) ?? []), handler])
    },
    removeEventListener: (type: string, handler: () => void): void => {
      listeners.set(type, (listeners.get(type) ?? []).filter(entry => entry !== handler))
    },
  }
  const refs = {
    sessionOpenHealth: { current: null as unknown },
    schedule: { current: { sessionId: 's1', start: 11 } as unknown },
    inputBlock: { current: { sessionId: 's1', start: 12 } as unknown },
    resync: { current: 13 as unknown },
  }
  const cleanup = scopedRun({
    document: documentStub,
    active: options.active ?? true,
    shell: { booted: options.settled ?? true, error: undefined },
    currentSessionId: options.sessionId === null ? undefined : (options.sessionId ?? 's1'),
    instanceId: 'view-under-test',
    currentSessionKnownBlank: false,
    sourceFingerprint: 'fp-under-test',
    retryToken: 0,
    isSettledShellState: (shell: { booted?: boolean; error?: unknown }) =>
      shell.error !== undefined || shell.booted === true,
    // 观察到的健康为 null：真实采样在这一拍就返回，streak/ladder 段不参与本契约。
    readInstanceSessionStreamHealth: () => { counters.reads += 1; return null },
    monotonicNow: () => 1_000,
    advanceSessionOpenHealth: () => { counters.advances += 1; return null },
    presentedSessionOpenRecoveryPhase: () => 'quiet',
    setSessionOpenPhase: (update: unknown) => { counters.phaseWrites.push(update) },
    setHostStallSessions: () => {},
    sessionOpenHealthRef: refs.sessionOpenHealth,
    scheduleStallRef: refs.schedule,
    inputBlockStallRef: refs.inputBlock,
    resyncDispatchedForRef: refs.resync,
    setInterval: (handler: () => void, delay: number) => {
      intervals.push({ delay, handler })
      return intervals.length
    },
    clearInterval: (handle: unknown) => { clearedIntervals.push(handle) },
  })
  return {
    refs,
    intervals,
    reads: () => counters.reads,
    advances: () => counters.advances,
    phaseWrites: () => counters.phaseWrites,
    tick: (): void => { for (const interval of intervals) interval.handler() },
    setVisible: (visible: boolean): void => { documentStub.visibilityState = visible ? 'visible' : 'hidden' },
    fireVisibility: (): void => {
      for (const handler of listeners.get('visibilitychange') ?? []) handler()
    },
    listenerCount: (type: string): number => (listeners.get(type) ?? []).length,
    clearedIntervals: () => clearedIntervals,
    dispose: (): void => { cleanup?.() },
  }
}

test('only an on-screen, settled seat with a session mounts the 1 Hz sampler', () => {
  const offscreen = mountSampler({ active: false })
  assert.equal(offscreen.reads(), 0, 'a background view never reads session health')
  assert.equal(offscreen.intervals.length, 0, 'a background view mounts no 1 Hz table')
  assert.equal(offscreen.listenerCount('visibilitychange'), 0, 'a background view follows nothing')

  const pending = mountSampler({ settled: false })
  assert.equal(pending.reads(), 0, 'an unsettled shell never reads session health')
  assert.equal(pending.intervals.length, 0, 'an unsettled shell mounts no 1 Hz table')

  const noSession = mountSampler({ sessionId: null })
  assert.equal(noSession.reads(), 0, 'a view with no current session mounts no sampler')
  assert.equal(noSession.intervals.length, 0)

  const seated = mountSampler()
  assert.equal(seated.reads(), 1, 'the seated view samples once on mount')
  assert.deepEqual(seated.intervals.map(interval => interval.delay), [1_000], 'the cadence is 1 Hz')
  assert.equal(seated.listenerCount('visibilitychange'), 1, 'the seated view follows document visibility')
  assert.deepEqual(
    seated.refs.schedule.current,
    { sessionId: 's1', start: 11 },
    'a visible sample keeps the pre-gap streak refs (no re-anchor while visible)',
  )

  seated.dispose()
  assert.equal(seated.listenerCount('visibilitychange'), 0, 'disposing detaches the visibility listener')
  assert.equal(seated.clearedIntervals().length, 1, 'disposing clears the 1 Hz table')
})

test('hidden re-anchors before any health read, ladder advance or setState', () => {
  const seated = mountSampler()
  const readsAtMount = seated.reads()
  const advancesAtMount = seated.advances()
  const writesAtMount = seated.phaseWrites().length

  // 隐藏中到点的那一拍：不读健康、不推进 ladder、不 setState，只清 streak/rebound。
  seated.refs.schedule.current = { sessionId: 's1', start: 21 }
  seated.refs.inputBlock.current = { sessionId: 's1', start: 22 }
  seated.refs.resync.current = 23
  seated.setVisible(false)
  seated.tick()
  assert.equal(seated.reads(), readsAtMount, 'a hidden tick performs no health read')
  assert.equal(seated.advances(), advancesAtMount, 'a hidden tick does not advance the open ledger')
  assert.equal(seated.phaseWrites().length, writesAtMount, 'a hidden tick writes no state')
  assert.equal(seated.refs.schedule.current, null, 'the schedule streak is re-anchored')
  assert.equal(seated.refs.inputBlock.current, null, 'the input-block streak is re-anchored')
  assert.equal(seated.refs.resync.current, undefined, 'the rebound conclusion is re-anchored')

  // visibilitychange → hidden：不等下一拍，立即 re-anchor。
  seated.refs.schedule.current = { sessionId: 's1', start: 24 }
  seated.fireVisibility()
  assert.equal(seated.refs.schedule.current, null, 'the hide edge re-anchors immediately')
  assert.equal(seated.reads(), readsAtMount, 'the hide edge reads nothing')

  // 恢复可见：立即采一次（新读数），而不是等下一拍；可见期节奏不变。
  seated.setVisible(true)
  seated.fireVisibility()
  assert.equal(seated.reads(), readsAtMount + 1, 'returning to visible samples once immediately')
  assert.equal(seated.advances(), advancesAtMount + 1)
  seated.tick()
  assert.equal(seated.reads(), readsAtMount + 2, 'the visible 1 Hz cadence is unchanged')
  seated.dispose()
})
