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
 *  7. 纯函数：isRunningNonSubagentRow / writeBackTargets。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  SessionAuthorityReconciler,
  isRunningNonSubagentRow,
  writeBackTargets,
  type AuthorityActionLogEntry,
  type SessionAuthoritySnapshot,
} from '@dsh-chamber/dsh-chamber-client-core/session-fact-reconcile'
import type { AuthorityOfficialRow, AuthorityRead } from '@dsh-chamber/dsh-stream-state'

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
  private readonly reads: (AuthorityRead | undefined)[]
  private readonly resolvers: (() => void)[] = []
  readonly reconciler: SessionAuthorityReconciler

  constructor(options: { reads?: (AuthorityRead | undefined)[]; correctResult?: boolean } = {}) {
    this.reads = options.reads ?? []
    this.correctResult = options.correctResult ?? true
    this.reconciler = new SessionAuthorityReconciler({
      now: () => this.now,
      generation: () => this.generation,
      readOfficial: () => ({ rows: this.official, listComplete: this.listComplete }),
      readAuthority: async () => {
        const next = this.reads[this.readCount]
        this.readCount += 1
        return next
      },
      correct: async (sessionIds) => {
        this.correctCalls.push([...sessionIds])
        return this.correctResult
      },
      warn: (message) => { this.warned.push(message) },
      record: (entry) => { this.records.push(entry) },
      onSettled: () => {
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

const ALLOW: AuthorityRead = { ok: true, complete: true, rows: { s1: true } }
const DENY: AuthorityRead = { ok: true, complete: true, rows: { s1: false } }

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

test('the running-bit helpers keep the subagent exclusion and the minimal write surface', () => {
  assert.equal(isRunningNonSubagentRow({ running: true }), true)
  assert.equal(isRunningNonSubagentRow({ running: true, subagent: true }), false)
  assert.equal(isRunningNonSubagentRow({ running: false }), false)
  assert.equal(isRunningNonSubagentRow(undefined), false)
  const targets = writeBackTargets(new Set(['a', 'b', 'c']), {
    a: { running: true },
    b: { running: false },
    c: { running: true, subagent: true },
  })
  assert.deepEqual(targets, ['a', 'c'],
    'the filter is "still claiming running"; the subagent exclusion happens upstream in the reducer')
})
