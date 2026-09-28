/**
 * 执行端契约（dsh-chamber-client-core/src/session-fact-reconcile.ts）。
 *
 * 策略测试在纯包（packages/dsh-stream-state/test/authority/）；本文件只锁执行端与
 * reducer 的接线行为：
 *  1. probe ladder：60s 门槛内不读权威，到点才读（数值来自 LADDER_TABLES.authority）；
 *  2. N=2：第一次证伪后同一 probe 内立刻发第二次独立读，两次一致才写回；
 *  3. 写回只通过 correct seam（只写 false 由生产端 adapter 保证，锁在 wiring test）；
 *  4. 失败（读失败/写回失败）⇒ stuck 证据（App 升级 ladder 的唯一输入）；
 *  5. 健康结论 ⇒ progressStamp 前进、stuckSince 清除；
 *  6. 代际变化重置 episode；
 *  7. 不完整官方列表保留 episode；写回目标只含仍声称 running 的行。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  SessionAuthorityReconciler,
  writeBackTargets,
  type AuthorityActionLogEntry,
  type SessionAuthoritySnapshot,
} from '@dsh-chamber/dsh-chamber-client-core/session-fact-reconcile'
import type { AuthorityOfficialRow, AuthorityRead, Scheduler } from '@dsh-chamber/dsh-stream-state'
// 页面调度记录的唯一所有者：本文件需要一个「两次窗口都未调度」的场景（design 14 §D4）。
import { noteFocus, resetPageScheduleForTests } from '../../../dsh-chamber-client-core/src/page-schedule.ts'

class Harness {
  now = 0
  generation = 'g1'
  official: Record<string, AuthorityOfficialRow> = {}
  listComplete = true
  readCount = 0
  correctCalls: string[][] = []
  correctResult = true
  warned: string[] = []
  records: AuthorityActionLogEntry[] = []
  settles = 0
  private readonly reads: (AuthorityRead | undefined)[]
  private readonly resolvers: (() => void)[] = []
  readonly reconciler: SessionAuthorityReconciler

  constructor(options: {
    reads?: (AuthorityRead | undefined)[]
    correctResult?: boolean
    readAuthority?: () => Promise<AuthorityRead | undefined>
    correct?: (sessionIds: readonly string[]) => Promise<boolean>
    readDeadlineMs?: number
    scheduler?: Scheduler
  } = {}) {
    this.reads = options.reads ?? []
    this.correctResult = options.correctResult ?? true
    this.reconciler = new SessionAuthorityReconciler({
      now: () => this.now,
      generation: () => this.generation,
      readOfficial: () => ({ rows: this.official, listComplete: this.listComplete }),
      readAuthority: async () => {
        const next = this.reads[this.readCount]
        this.readCount += 1
        return options.readAuthority === undefined ? next : options.readAuthority()
      },
      ...(options.readDeadlineMs === undefined ? {} : { readDeadlineMs: options.readDeadlineMs }),
      ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }),
      correct: async (sessionIds) => {
        this.correctCalls.push([...sessionIds])
        return options.correct === undefined ? this.correctResult : options.correct(sessionIds)
      },
      warn: (message) => { this.warned.push(message) },
      record: (entry) => { this.records.push(entry) },
      onSettled: () => {
        this.settles += 1
        const resolve = this.resolvers.shift()
        if (resolve !== undefined) resolve()
      },
    })
  }

  /** Start one authority tick without awaiting it (settle() resolves when done). */
  pending(
    at: number,
    official: Record<string, AuthorityOfficialRow>,
    listComplete = true,
    generation = this.generation,
  ): Promise<void> {
    this.now = at
    this.official = official
    this.listComplete = listComplete
    this.generation = generation
    const settled = new Promise<void>(resolve => { this.resolvers.push(resolve) })
    this.reconciler.request()
    return settled
  }

  async tick(
    at: number,
    official: Record<string, AuthorityOfficialRow>,
    listComplete = true,
    generation = this.generation,
  ): Promise<void> {
    await this.pending(at, official, listComplete, generation)
  }

  snapshot(): SessionAuthoritySnapshot | undefined {
    return this.reconciler.snapshot()
  }
}

const ALLOW: AuthorityRead = { ok: true, proof: { kind: 'asOfSeq', asOfSeq: 1 }, rows: { s1: true } }
const DENY: AuthorityRead = { ok: true, proof: { kind: 'asOfSeq', asOfSeq: 1 }, rows: { s1: false } }

test('nothing is read before the probe threshold, and a verdict advances progress', async () => {
  const h = new Harness({ reads: [ALLOW] })
  await h.tick(0, { s1: { running: true } })
  assert.equal(h.readCount, 0, 'episode just started: no probe yet')
  assert.equal(h.snapshot()?.ok, true)
  await h.tick(60_000, { s1: { running: true } })
  assert.equal(h.readCount, 1)
  assert.equal(h.snapshot()?.progressStamp, 1)
  assert.equal(h.snapshot()?.stuckSince, undefined)
  assert.equal(h.snapshot()?.probes, 1)
})

test('N=2: one probe performs two serial reads and writes back only after agreement', async () => {
  const h = new Harness({ reads: [DENY, DENY] })
  await h.tick(0, { s1: { running: true } })
  await h.tick(60_000, { s1: { running: true } })
  assert.equal(h.readCount, 2, 'the confirmation read happens inside the same probe')
  assert.deepEqual(h.correctCalls, [['s1']])
  assert.equal(h.snapshot()?.corrections, 1)
  assert.equal(h.snapshot()?.ok, true)
})

test('every action is handed to the persistence seam exactly once, in order', async () => {
  const h = new Harness({ reads: [DENY, DENY] })
  await h.tick(0, { s1: { running: true } })
  await h.tick(60_000, { s1: { running: true } })
  assert.deepEqual(h.records.map(entry => entry.kind), ['probe', 'correct', 'complete'])
})

test('a second read that says running cancels the denial (no write-back)', async () => {
  const h = new Harness({ reads: [DENY, ALLOW] })
  await h.tick(0, { s1: { running: true } })
  await h.tick(60_000, { s1: { running: true } })
  assert.equal(h.readCount, 2)
  assert.deepEqual(h.correctCalls, [])
  assert.equal(h.snapshot()?.ok, true)
})

test('a failed authority read is stuck evidence and never writes back', async () => {
  const h = new Harness({ reads: [undefined] })
  await h.tick(0, { s1: { running: true } })
  await h.tick(60_000, { s1: { running: true } })
  assert.equal(h.readCount, 1)
  assert.deepEqual(h.correctCalls, [])
  assert.equal(h.snapshot()?.ok, false)
  assert.equal(h.snapshot()?.stuckSince, 60_000)
})

test('an incomplete authority list is unknown, not a healthy verdict', async () => {
  const h = new Harness({ reads: [{ ok: true, proof: { kind: 'none' }, rows: { s1: true } }] })
  await h.tick(0, { s1: { running: true }, s2: { running: true } })
  await h.tick(60_000, { s1: { running: true }, s2: { running: true } })
  assert.equal(h.snapshot()?.ok, false)
  assert.equal(h.snapshot()?.stuckSince, 60_000)
  assert.equal(h.snapshot()?.progressStamp, 0)
  assert.match(h.records.find(entry => entry.kind === 'read-failed')?.detail ?? '', /s2/)
})

test('an incomplete official list cannot erase the active episode or its stuck evidence', async () => {
  const h = new Harness({ reads: [undefined] })
  await h.tick(0, { s1: { running: true } })
  await h.tick(60_000, {}, false)
  assert.equal(h.readCount, 1, 'the retained episode still drives the probe ladder')
  assert.equal(h.snapshot()?.runningSince, 0)
  assert.equal(h.snapshot()?.stuckSince, 60_000)
  await h.tick(90_000, {}, false)
  assert.equal(h.snapshot()?.stuckSince, 60_000, 'missing rows in an incomplete list cannot claim recovery')
})

test('a failed write-back keeps stuck evidence (the store never changed)', async () => {
  const h = new Harness({ reads: [DENY, DENY], correctResult: false })
  await h.tick(0, { s1: { running: true } })
  await h.tick(60_000, { s1: { running: true } })
  assert.deepEqual(h.correctCalls, [['s1']])
  assert.equal(h.snapshot()?.corrections, 0)
  assert.equal(h.snapshot()?.ok, false)
  assert.equal(h.snapshot()?.stuckSince, 60_000)
})

test('no running row means no probe and a healthy settle', async () => {
  const h = new Harness()
  await h.tick(0, { s1: { running: false } })
  assert.equal(h.readCount, 0)
  assert.equal(h.snapshot()?.ok, true)
  assert.equal(h.snapshot()?.runningSince, undefined)
})

test('a generation change re-bases the episode clock', async () => {
  const h = new Harness({ reads: [ALLOW] })
  await h.tick(0, { s1: { running: true } }, true, 'g1')
  await h.tick(30_000, { s1: { running: true } }, true, 'g2')
  assert.equal(h.snapshot()?.runningSince, 30_000)
  assert.equal(h.readCount, 0, 'the fresh episode has no probe age yet')
})

test('a generation change also resets the old source probe quota', async () => {
  const h = new Harness({ reads: [ALLOW, ALLOW] })
  await h.tick(0, { s1: { running: true } }, true, 'g1')
  await h.tick(60_000, { s1: { running: true } }, true, 'g1')
  assert.equal(h.readCount, 1)
  await h.tick(100_000, { s1: { running: true } }, true, 'g2')
  await h.tick(160_000, { s1: { running: true } }, true, 'g2')
  assert.equal(h.readCount, 2, 'the g1 cooldown must not suppress the first g2 probe')
})

test('the probe ladder throttles a second read inside the coalesce window', async () => {
  const h = new Harness({ reads: [ALLOW, ALLOW] })
  await h.tick(0, { s1: { running: true } })
  await h.tick(60_000, { s1: { running: true } })
  assert.equal(h.readCount, 1)
  await h.tick(90_000, { s1: { running: true } })
  assert.equal(h.readCount, 1, 'inside probeCoalesceMs')
  await h.tick(260_000, { s1: { running: true } })
  assert.equal(h.readCount, 2)
})

test('a hanging authority read is fenced by the read budget (I-11), not the ladder', async () => {
  let armed = 0
  const h = new Harness({
    readAuthority: () => new Promise<AuthorityRead | undefined>(() => {}),
    readDeadlineMs: 5_000,
    scheduler: {
      setTimeout: (run) => { armed += 1; run(); return armed },
      clearTimeout: () => {},
    },
  })
  await h.tick(0, { s1: { running: true } })
  await h.tick(60_000, { s1: { running: true } })
  assert.equal(armed, 1, 'exactly one deadline is armed for the hanging read')
  assert.deepEqual(h.correctCalls, [], 'a timed-out read is no verdict: never write back')
  assert.equal(h.snapshot()?.ok, false)
  assert.equal(h.snapshot()?.stuckSince, 60_000)
  assert.ok(h.warned.some(line => line.includes('read deadline exceeded')), h.warned.join(' | '))
  assert.match(h.records.find(entry => entry.kind === 'read-failed')?.detail ?? '', /deadline/)
})

test('a round whose windows were both unscheduled books neither a failure nor a recovery', async () => {
  // 从未 tick + 失焦 ⇒ hadSchedulingGap 对任何窗口都为真 ⇒ readBounded 的两次窗口都判 unscheduled，
  // 末路返回 { read: undefined, timedOut: false }。design 14 §D4：未调度的窗口不携带来源事实，
  // 所以这一轮既不能进 stuck 证据、也不能落 read-failed，更不能把既有的 stuck 当恢复清掉。
  resetPageScheduleForTests()
  noteFocus(false)
  try {
    let armed = 0
    const h = new Harness({
      readAuthority: () => new Promise<AuthorityRead | undefined>(() => {}),
      readDeadlineMs: 5_000,
      scheduler: {
        setTimeout: (run) => { armed += 1; run(); return armed },
        clearTimeout: () => {},
      },
    })
    await h.tick(0, { s1: { running: true } })
    await h.tick(60_000, { s1: { running: true } })
    assert.equal(armed, 2, 'both windows must be judged before the round is given up')
    assert.equal(h.snapshot()?.stuckSince, undefined, 'an unscheduled round is not stuck evidence')
    assert.equal(h.records.some(entry => entry.kind === 'read-failed'), false,
      'no read-failed verdict may be booked for an observation the page never got to make')
    assert.ok(h.warned.some(line => line.includes('not scheduled in either window')), h.warned.join(' | '))
  } finally {
    resetPageScheduleForTests()
  }
})

test('a confirmed correction survives a final unscheduled window', async () => {
  // 混合归约：同一轮第一次读同时否认 sA（第二次否认 ⇒ 已签发 correct）与 sB（首次 ⇒ 签发确认读），
  // 随后失焦、确认窗口两次都未调度 ⇒ 本轮以 skipped 收轮。已签发的 correct(sA) 必须照常结算：
  // 提前 return 会把它丢在循环里，reducer 的 correctionTicket 永不结算，此后每轮都命中
  // 「ticket 未结算」分支，只写 false 的 tier-3 写回对该会话永久静默（design 14 §D4 的执行端契约）。
  resetPageScheduleForTests()
  try {
    const read = (rows: Record<string, boolean>): AuthorityRead => ({
      ok: true, proof: { kind: 'asOfSeq', asOfSeq: 1 }, rows,
    })
    const rows = { sA: { running: true }, sB: { running: true } }
    // 每轮第一读在 20ms 期限内的真实窗口里返回；读完失焦、确认读挂起 ⇒ 两次尝试都在未调度
    // 窗口里过期 ⇒ readBounded 的 skipped 末路（design 14 §D4 的 skipped 轮次）。
    let firstOfRound = true
    let verdict: 'denyA' | 'denyAB' = 'denyA'
    const h = new Harness({
      readAuthority: async () => {
        noteFocus(false)
        if (!firstOfRound) return new Promise<AuthorityRead | undefined>(() => {})
        firstOfRound = false
        // rows 是「谁在跑」的全量声明：第一读只否认 sA（sB 申明在跑），第二读否认两者。
        return verdict === 'denyA' ? read({ sA: false, sB: true }) : read({ sA: false, sB: false })
      },
      readDeadlineMs: 20,
    })
    noteFocus(true)
    await h.tick(0, rows)
    await h.tick(60_000, rows)
    assert.deepEqual(h.correctCalls, [], 'the first denial is unconfirmed: nothing to write')
    // 第二轮：同一次读同时否认 sA（第二次 ⇒ 签发 correct）与 sB（首次 ⇒ 签发确认读），
    // 确认读被 skipped 收轮 —— 已签发的 correct(sA) 必须仍然结算。
    noteFocus(true)
    firstOfRound = true
    verdict = 'denyAB'
    await h.tick(260_000, rows)
    assert.deepEqual(h.correctCalls, [['sA']],
      'the correction signed before the unscheduled window must still settle')
    assert.equal(h.snapshot()?.corrections, 1)
    assert.equal(h.records.filter(entry => entry.kind === 'read-failed').length, 0,
      'an unscheduled round is not failure evidence')
    assert.equal(h.snapshot()?.stuckSince, undefined)
  } finally {
    resetPageScheduleForTests()
  }
})

test('a later healthy verdict clears stuck evidence and advances progress', async () => {
  const h = new Harness({ reads: [undefined, ALLOW] })
  await h.tick(0, { s1: { running: true } })
  await h.tick(60_000, { s1: { running: true } })
  assert.notEqual(h.snapshot()?.stuckSince, undefined)
  await h.tick(260_000, { s1: { running: true } })
  assert.equal(h.snapshot()?.stuckSince, undefined)
  assert.equal(h.snapshot()?.ok, true)
})

test('a second request while an attempt is in flight does not start a second read', async () => {
  const h = new Harness({ reads: [ALLOW] })
  await h.tick(0, { s1: { running: true } })
  const settled = h.pending(60_000, { s1: { running: true } })
  h.reconciler.request()
  await settled
  assert.equal(h.readCount, 1)
})

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

test('a request during an authority read gets a fresh official tick before the snapshot settles', async () => {
  const inFlight = deferred<AuthorityRead | undefined>()
  const h = new Harness({ readAuthority: () => inFlight.promise })
  await h.tick(0, { s1: { running: true } })
  const settled = h.pending(60_000, { s1: { running: true } })
  assert.equal(h.readCount, 1)
  h.now = 60_001
  h.official = { s1: { running: false } }
  h.reconciler.request()
  assert.equal(h.snapshot()?.settledAt, undefined)
  inFlight.resolve(ALLOW)
  await settled
  assert.equal(h.snapshot()?.runningSince, undefined)
  assert.equal(h.snapshot()?.settledAt, 60_001)
  assert.equal(h.settles, 2, 'the initial seed and the latest request settle; the obsolete pass does not')
  assert.equal(h.records.filter(entry => entry.kind === 'complete').length, 1)
})

test('a read from an old source generation cannot trigger a write in the new generation', async () => {
  const inFlight = deferred<AuthorityRead | undefined>()
  const h = new Harness({ readAuthority: () => inFlight.promise })
  await h.tick(0, { s1: { running: true } }, true, 'g1')
  const settled = h.pending(60_000, { s1: { running: true } }, true, 'g1')
  h.generation = 'g2'
  h.reconciler.request()
  inFlight.resolve(DENY)
  await settled
  assert.equal(h.snapshot()?.runningSince, 60_000, 'the new generation starts a fresh episode')
  assert.deepEqual(h.correctCalls, [])
  assert.equal(h.readCount, 1)
})

test('disposing while a read is in flight prevents confirmation, correction and publishing', async () => {
  const inFlight = deferred<AuthorityRead | undefined>()
  const h = new Harness({ readAuthority: () => inFlight.promise })
  await h.tick(0, { s1: { running: true } })
  h.pending(60_000, { s1: { running: true } })
  h.reconciler.dispose()
  inFlight.resolve(DENY)
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(h.readCount, 1)
  assert.deepEqual(h.correctCalls, [])
  assert.equal(h.settles, 1)
})

test('separate confirmed groups in one probe both receive their own correction', async () => {
  const h = new Harness({ reads: [
    { ok: true, proof: { kind: 'asOfSeq', asOfSeq: 1 }, rows: { s1: false, s2: true } },
    undefined,
    { ok: true, proof: { kind: 'asOfSeq', asOfSeq: 1 }, rows: { s1: false, s2: false } },
    { ok: true, proof: { kind: 'asOfSeq', asOfSeq: 1 }, rows: { s2: false } },
  ] })
  await h.tick(0, { s1: { running: true }, s2: { running: true } })
  await h.tick(60_000, { s1: { running: true }, s2: { running: true } })
  await h.tick(260_000, { s1: { running: true }, s2: { running: true } })
  assert.deepEqual(h.correctCalls, [['s1'], ['s2']])
  assert.equal(h.snapshot()?.corrections, 2)
  assert.equal(h.snapshot()?.ok, true)
})

test('the write-back helper keeps the minimal write surface', () => {
  const targets = writeBackTargets(new Set(['a', 'b', 'c']), {
    a: { running: true },
    b: { running: false },
    c: { running: true, subagent: true },
  })
  assert.deepEqual(targets, ['a', 'c'],
    'the filter is "still claiming running"; the subagent exclusion happens upstream in the reducer')
})
