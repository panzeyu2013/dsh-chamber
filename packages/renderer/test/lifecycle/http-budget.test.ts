/**
 * Page-level same-origin HTTP budget (design 26 §D5 extension / design 14 §D4):
 * bounded dispatch, strict local reserve, dispatch bookkeeping that lets the
 * evidence layer distinguish "never dispatched" from "dispatched and timed out".
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  HTTP_BUDGET_LIMITS,
  HttpBudgetUnscheduledError,
  acquireHttpBudget,
  httpBudgetLaneFor,
  remainingDispatchBudgetMs,
  configureHttpBudgetForTests,
  evictHttpBudgetSource,
  readHttpBudgetStats,
  resetHttpBudgetForTests,
  runWithHttpBudget,
  type HttpBudgetAcquire,
} from '@dsh-chamber/dsh-chamber-client-core/http-budget'
import { readEvidenceLog, resetEvidenceLogForTests } from '../../../dsh-chamber-client-core/src/evidence-log.ts'
import { LOCAL_INSTANCE_ID } from '../../src/local-instance.ts'

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

function request(sourceId: string, lane: 'local' | 'foreground' | 'background' = 'background', extra: Record<string, unknown> = {}) {
  return { sourceId, kind: 'unary' as const, lane, ...extra }
}

function granted(result: HttpBudgetAcquire) {
  assert.equal(result.kind, 'granted')
  return result as Extract<HttpBudgetAcquire, { kind: 'granted' }>
}

test('the local lane literal is pinned to the renderer source id', () => {
  // Two packages, one literal: if either side renames the local source, the strict
  // reserve silently stops applying (design 26 §D7) — lock the pair.
  assert.equal(LOCAL_INSTANCE_ID, 'local')
  assert.equal(httpBudgetLaneFor(LOCAL_INSTANCE_ID), 'local')
  assert.equal(httpBudgetLaneFor('dsh-abc'), 'foreground')
  assert.equal(httpBudgetLaneFor('gateway-abc'), 'foreground')
  assert.equal(httpBudgetLaneFor('control-plane'), 'foreground')
})

test('the dispatch budget is what the queue left: a 5s baseline stays 5s end to end', () => {
  assert.equal(remainingDispatchBudgetMs(5_000, 0), 5_000)
  assert.equal(remainingDispatchBudgetMs(5_000, 1_200), 3_800)
  assert.equal(remainingDispatchBudgetMs(500, 900), 1, 'an over-spent budget still allows a 1ms attempt')
  assert.equal(remainingDispatchBudgetMs(10, -5), 10, 'a negative queue wait cannot inflate the budget')
})

test('the default budget leaves headroom below the browser pool cap', () => {
  assert.ok(HTTP_BUDGET_LIMITS.totalMax < 6, 'must reserve room for non-scheduled consumers')
  assert.ok(HTTP_BUDGET_LIMITS.localReserve >= 1)
})

test('bounded: a third background request waits until a slot is released', async () => {
  const restore = configureHttpBudgetForTests({ totalMax: 2, localReserve: 0, queueMax: 8 })
  try {
    const first = granted(await acquireHttpBudget(request('r1')))
    const second = granted(await acquireHttpBudget(request('r2')))
    let settled = false
    const thirdPromise = acquireHttpBudget(request('r3')).then(result => { settled = true; return result })
    await sleep(10)
    assert.equal(settled, false)
    assert.equal(readHttpBudgetStats().queued, 1)
    assert.equal(readHttpBudgetStats().inflight, 2)
    second.slot.release()
    const third = granted(await thirdPromise)
    assert.equal(readHttpBudgetStats().inflight, 2)
    first.slot.release()
    third.slot.release()
  } finally {
    resetHttpBudgetForTests()
    restore()
  }
})

test('local reserve is strict: background cannot borrow it while local is waiting', async () => {
  const restore = configureHttpBudgetForTests({ totalMax: 2, localReserve: 1, queueMax: 8 })
  try {
    const background = granted(await acquireHttpBudget(request('remote')))
    // inflight = 1 = totalMax - reserve: the second background must queue.
    let backgroundSettled = false
    const secondBackground = acquireHttpBudget(request('remote')).then(result => { backgroundSettled = true; return result })
    await sleep(10)
    assert.equal(backgroundSettled, false)
    // A local request jumps the queue and gets the reserved slot immediately.
    const local = granted(await acquireHttpBudget(request('local', 'local')))
    assert.equal(readHttpBudgetStats().inflightByLane.local, 1)
    assert.equal(backgroundSettled, false)
    local.slot.release()
    await sleep(10)
    // The reserve is released, but background concurrency is capped at
    // totalMax - localReserve, so the first background still holds its slot.
    assert.equal(backgroundSettled, false)
    background.slot.release()
    const admitted = granted(await secondBackground)
    admitted.slot.release()
  } finally {
    resetHttpBudgetForTests()
    restore()
  }
})

test('queue deadline resolves unscheduled with the queue wait, never a fake grant', async () => {
  const restore = configureHttpBudgetForTests({ totalMax: 1, localReserve: 0, queueMax: 8 })
  try {
    const holder = granted(await acquireHttpBudget(request('remote')))
    const startedAt = Date.now()
    const result = await acquireHttpBudget(request('local', 'local', { queueDeadlineAt: startedAt + 25 }))
    assert.equal(result.kind, 'unscheduled')
    if (result.kind === 'unscheduled') {
      assert.equal(result.reason, 'queue-deadline')
      assert.ok(result.queuedMs >= 15, 'queue wait is reported: ' + String(result.queuedMs))
    }
    assert.equal(readHttpBudgetStats().unscheduled['queue-deadline'], 1)
    holder.slot.release()
  } finally {
    resetHttpBudgetForTests()
    restore()
  }
})

test('abort while queued resolves unscheduled, and never dispatches', async () => {
  const restore = configureHttpBudgetForTests({ totalMax: 1, localReserve: 0, queueMax: 8 })
  try {
    const holder = granted(await acquireHttpBudget(request('remote')))
    const controller = new AbortController()
    const pending = acquireHttpBudget(request('r2', 'background', { signal: controller.signal }))
    await sleep(10)
    controller.abort()
    const result = await pending
    assert.equal(result.kind, 'unscheduled')
    if (result.kind === 'unscheduled') assert.equal(result.reason, 'aborted')
    holder.slot.release()
  } finally {
    resetHttpBudgetForTests()
    restore()
  }
})

test('source retirement evicts queued requests only and counts them', async () => {
  const restore = configureHttpBudgetForTests({ totalMax: 1, localReserve: 0, queueMax: 8 })
  try {
    const holder = granted(await acquireHttpBudget(request('remote')))
    const queuedA = acquireHttpBudget(request('gone'))
    const queuedB = acquireHttpBudget(request('gone'))
    await sleep(10)
    assert.equal(readHttpBudgetStats().queued, 2)
    assert.equal(evictHttpBudgetSource('gone'), 2)
    for (const pending of [queuedA, queuedB]) {
      const result = await pending
      assert.equal(result.kind, 'unscheduled')
      if (result.kind === 'unscheduled') assert.equal(result.reason, 'source-retired')
    }
    assert.equal(readHttpBudgetStats().evicted, 2)
    holder.slot.release()
  } finally {
    resetHttpBudgetForTests()
    restore()
  }
})

test('a deep queue does not reject a bounded caller while capacity is free', async () => {
  const restore = configureHttpBudgetForTests({
    totalMax: 4, localReserve: 1, bundleMax: 2, queueMax: 64, perSourceQueueMax: 8,
  })
  try {
    const bundleA = granted(await acquireHttpBudget(request('q', 'background', { kind: 'bundle' })))
    const bundleB = granted(await acquireHttpBudget(request('q', 'background', { kind: 'bundle' })))
    const queued: Promise<HttpBudgetAcquire>[] = []
    for (let index = 0; index < 9; index += 1) {
      queued.push(acquireHttpBudget(request('q', 'background', { kind: 'bundle' })))
    }
    await sleep(5)
    // Queue depth >= perSourceQueueMax, but a unary slot is free right now: admit it.
    const bounded = await acquireHttpBudget(request('q', 'foreground', {
      queueDeadlineAt: Date.now() + 5_000,
    }))
    assert.equal(bounded.kind, 'granted', 'capacity-free bounded callers must not be queue-full rejected')
    if (bounded.kind === 'granted') bounded.slot.release()
    bundleA.slot.release()
    bundleB.slot.release()
  } finally {
    resetHttpBudgetForTests()
    restore()
  }
})

test('an undeadlined bundle queue never refuses a same-source bounded caller', async () => {
  const restore = configureHttpBudgetForTests({
    totalMax: 1, localReserve: 0, bundleMax: 2, queueMax: 64, perSourceQueueMax: 1,
  })
  resetEvidenceLogForTests()
  try {
    const holder = granted(await acquireHttpBudget(request('other')))
    // The boot-wave shape: many undeadlined bundle rows of ONE source could be
    // refused, so they must not consume the per-source bound of bounded reads.
    const bundles: Promise<HttpBudgetAcquire>[] = []
    for (let index = 0; index < 9; index += 1) {
      bundles.push(acquireHttpBudget({ sourceId: 'boot', kind: 'bundle', lane: 'background' }))
    }
    await sleep(5)
    assert.equal(readHttpBudgetStats().queued, 9)
    const sameSource = await acquireHttpBudget(request('boot', 'foreground', { queueDeadlineAt: Date.now() + 20 }))
    assert.equal(sameSource.kind, 'unscheduled')
    if (sameSource.kind === 'unscheduled') {
      assert.equal(sameSource.reason, 'queue-deadline', 'bundle depth must not team-kill a bounded read')
    }
    // The BOUNDED depth still refuses instantly (the cap keeps protecting the queue).
    const firstBounded = acquireHttpBudget(request('boot', 'foreground', { queueDeadlineAt: Date.now() + 60_000 }))
    void firstBounded
    await sleep(2)
    const secondBounded = await acquireHttpBudget(request('boot', 'foreground', { queueDeadlineAt: Date.now() + 60_000 }))
    assert.equal(secondBounded.kind, 'unscheduled')
    if (secondBounded.kind === 'unscheduled') assert.equal(secondBounded.reason, 'queue-full')
    const refusal = readEvidenceLog().filter(entry =>
      entry.owner === 'http-budget' && entry.detail.reason === 'queue-full')
    assert.equal(refusal.length, 1, 'the refusal is in the ledger')
    assert.equal(refusal[0]?.detail.cap, 'per-source', 'the per-source cap still reports its own name')
    holder.slot.release()
  } finally {
    resetHttpBudgetForTests()
    resetEvidenceLogForTests()
    restore()
  }
})

test('a running local request does not shrink the non-local quota twice', async () => {
  const restore = configureHttpBudgetForTests({ totalMax: 4, localReserve: 1 })
  try {
    const local = granted(await acquireHttpBudget(request('local', 'local')))
    const first = granted(await acquireHttpBudget(request('r1')))
    const second = granted(await acquireHttpBudget(request('r2')))
    const third = await acquireHttpBudget(request('r3', 'foreground', {
      queueDeadlineAt: Date.now() + 5_000,
    }))
    assert.equal(third.kind, 'granted', 'non-local in-flight (2) is below totalMax-localReserve (3)')
    if (third.kind === 'granted') third.slot.release()
    local.slot.release()
    first.slot.release()
    second.slot.release()
  } finally {
    resetHttpBudgetForTests()
    restore()
  }
})

test('queue-full only refuses callers that opted into a bounded wait; local is never refused', async () => {
  const restore = configureHttpBudgetForTests({ totalMax: 1, localReserve: 0, queueMax: 0, perSourceQueueMax: 0 })
  try {
    const holder = granted(await acquireHttpBudget(request('remote')))
    // Undeadlined callers always wait: their producers bound themselves, and a
    // refusal here would become a new failure surface (review M1–M4).
    const queued = acquireHttpBudget(request('r2'))
    await sleep(5)
    const refused = await acquireHttpBudget(request('r2', 'background', { queueDeadlineAt: Date.now() + 60_000 }))
    assert.equal(refused.kind, 'unscheduled')
    if (refused.kind === 'unscheduled') assert.equal(refused.reason, 'queue-full')
    // The local lane is never refused, bounded or not.
    const local = acquireHttpBudget(request('local', 'local', { queueDeadlineAt: Date.now() + 60_000 }))
    let localSettled = false
    void local.then(() => { localSettled = true })
    await sleep(5)
    assert.equal(localSettled, false, 'local waits for the reserved slot instead of being refused')
    holder.slot.release()
    const admitted = granted(await queued)
    admitted.slot.release()
    const localAdmitted = granted(await local)
    localAdmitted.slot.release()
  } finally {
    resetHttpBudgetForTests()
    restore()
  }
})

test('an expired bounded wait is never granted', async () => {
  const restore = configureHttpBudgetForTests({ totalMax: 1, localReserve: 0, queueMax: 8 })
  try {
    const holder = granted(await acquireHttpBudget(request('holder')))
    const pending = acquireHttpBudget(request('r2', 'background', { queueDeadlineAt: Date.now() + 10 }))
    await sleep(25)
    holder.slot.release()
    const result = await pending
    assert.equal(result.kind, 'unscheduled')
    if (result.kind === 'unscheduled') assert.equal(result.reason, 'queue-deadline')
    assert.ok(readHttpBudgetStats().maxQueueWaitMs >= 5, 'queue-deadline feeds the calibration reads')
  } finally {
    resetHttpBudgetForTests()
    restore()
  }
})

test('eviction drops queued requests only; an active slot survives', async () => {
  const restore = configureHttpBudgetForTests({ totalMax: 1, localReserve: 0, queueMax: 8 })
  try {
    const active = granted(await acquireHttpBudget(request('gone')))
    const queued = acquireHttpBudget(request('gone'))
    await sleep(5)
    assert.equal(evictHttpBudgetSource('gone'), 1)
    const dropped = await queued
    assert.equal(dropped.kind, 'unscheduled')
    assert.equal(readHttpBudgetStats().inflight, 1, 'the dispatched slot is not evicted')
    active.slot.release()
  } finally {
    resetHttpBudgetForTests()
    restore()
  }
})

test('bundle sub-cap: boot scripts cannot occupy the whole pool', async () => {
  const restore = configureHttpBudgetForTests({ totalMax: 3, localReserve: 0, bundleMax: 1, queueMax: 8 })
  try {
    const bundleA = granted(await acquireHttpBudget({ sourceId: 'r1', kind: 'bundle', lane: 'background' }))
    const unary = granted(await acquireHttpBudget(request('r1')))
    let secondBundleSettled = false
    const secondBundle = acquireHttpBudget({ sourceId: 'r1', kind: 'bundle', lane: 'background' })
      .then(result => { secondBundleSettled = true; return result })
    await sleep(10)
    assert.equal(secondBundleSettled, false, 'a second bundle waits behind the bundle sub-cap')
    assert.equal(readHttpBudgetStats().inflightByKind.unary, 1, 'unary still gets a slot')
    bundleA.slot.release()
    const admitted = granted(await secondBundle)
    admitted.slot.release()
    unary.slot.release()
  } finally {
    resetHttpBudgetForTests()
    restore()
  }
})

test('runWithHttpBudget releases the slot after the task and surfaces refusals', async () => {
  const restore = configureHttpBudgetForTests({ totalMax: 1, localReserve: 0, queueMax: 1, perSourceQueueMax: 1 })
  try {
    const value = await runWithHttpBudget(request('wrapped'), async () => 'task-value')
    assert.equal(value, 'task-value')
    assert.equal(readHttpBudgetStats().inflight, 0, 'the slot is released after the task')

    const holder = granted(await acquireHttpBudget(request('holder')))
    const queued = runWithHttpBudget(request('wrapped'), async () => 'late')
    await sleep(5)
    await assert.rejects(
      // Only a bounded wait can be refused; the deadline request hits the cap.
      () => runWithHttpBudget(
        request('wrapped', 'background', { queueDeadlineAt: Date.now() + 60_000 }),
        async () => 'never',
      ),
      (error: unknown) => error instanceof HttpBudgetUnscheduledError,
      'a queue-full refusal is an explicit budget error',
    )
    holder.slot.release()
    assert.equal(await queued, 'late', 'a waiting request runs once a slot frees')
    assert.equal(readHttpBudgetStats().inflight, 0)
  } finally {
    resetHttpBudgetForTests()
    restore()
  }
})

test('remoteRuntimeControl: budgeted, self-bounded, and refusal/timeout are data not faults', async () => {
  const { remoteRuntimeControl } = await import('../../../dsh-chamber-client-core/src/gateway-runtime.ts')
  resetHttpBudgetForTests()
  const restore = configureHttpBudgetForTests({ totalMax: 1, localReserve: 0, perSourceQueueMax: 0 })
  let fetches = 0
  try {
    const holder = granted(await acquireHttpBudget(request('other')))
    const busy = await remoteRuntimeControl('gateway-west', 'restart', {
      fetchImpl: (async () => { fetches += 1; return new Response(null, { status: 202 }) }) as unknown as typeof fetch,
    })
    assert.deepEqual(busy, { kind: 'busy' }, 'a page refusal is a data arm: the panel owns the copy')
    assert.equal(fetches, 0, 'a refused control POST never reaches fetch')
    holder.slot.release()
    const accepted = await remoteRuntimeControl('gateway-west', 'start', {
      fetchImpl: (async () => new Response(null, { status: 202 })) as unknown as typeof fetch,
    })
    assert.deepEqual(accepted, { kind: 'response', status: 202, body: null })
    const refused = await remoteRuntimeControl('gateway-west', 'restart', {
      fetchImpl: (async () => new Response(JSON.stringify({ code: 'runtime_busy' }), {
        status: 409, headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch,
    })
    assert.equal(refused.kind, 'response')
    if (refused.kind === 'response') {
      assert.equal(refused.status, 409)
      assert.deepEqual(refused.body, { code: 'runtime_busy' }, 'the refusal body stays readable for the localized projection')
    }
    const timedOut = await remoteRuntimeControl('gateway-west', 'restart', {
      timeoutMs: 10,
      fetchImpl: (async (_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const aborted = new Error('aborted')
          aborted.name = 'AbortError'
          reject(aborted)
        })
      })) as unknown as typeof fetch,
    })
    assert.deepEqual(timedOut, { kind: 'timeout' }, 'our own ceiling reports the unknown outcome explicitly')
  } finally {
    resetHttpBudgetForTests()
    restore()
  }
})

test('stats sample positive waits only; zero-wait is counted as GRANTS, never as refusals', async () => {
  const restore = configureHttpBudgetForTests({ totalMax: 1, localReserve: 0, perSourceQueueMax: 0 })
  try {
    const instant = granted(await acquireHttpBudget(request('a')))
    instant.slot.release()
    const holder = granted(await acquireHttpBudget(request('b')))
    const refused = await acquireHttpBudget(request('b', 'foreground', { queueDeadlineAt: Date.now() + 60_000 }))
    assert.equal(refused.kind, 'unscheduled')
    const stats = readHttpBudgetStats()
    // Two grants happened (the instant one and the holder); the refusal is not a grant.
    assert.equal(stats.zeroWaitGrants, 2, 'only zero-wait GRANTS are counted; the instant refusal is not')
    assert.equal(stats.granted, 2, 'the refusal is not a grant')
    assert.equal(stats.queueMsP50, 0, 'a refusal contributes no positive sample')
    holder.slot.release()
  } finally {
    resetHttpBudgetForTests()
    restore()
  }
})

test('stats percentiles read the positive queue wait, not the zero-wait grants around it', async () => {
  const restore = configureHttpBudgetForTests({ totalMax: 1, localReserve: 0, queueMax: 8 })
  try {
    const holder = granted(await acquireHttpBudget(request('slow')))
    const deadline = new Promise<void>((resolve) => setTimeout(resolve, 40))
    const refused = acquireHttpBudget(request('slow', 'foreground', { queueDeadlineAt: Date.now() + 30 }))
    await Promise.all([deadline, refused])
    for (let index = 0; index < 20; index += 1) {
      const slot = granted(await acquireHttpBudget(request('fast')))
      slot.slot.release()
    }
    holder.slot.release()
    const stats = readHttpBudgetStats()
    assert.ok(stats.queueMsP50 >= 15, 'p50 is the real wait (' + String(stats.queueMsP50) + 'ms)')
    assert.ok(stats.queueMsP95 >= 15, 'p95 is not diluted by the 20 instant grants')
    assert.ok(stats.queueMsMax >= 15)
    assert.equal(stats.zeroWaitGrants, 20)
  } finally {
    resetHttpBudgetForTests()
    restore()
  }
})

test('evict writes ONE ledger line with the count of dropped requests', async () => {
  const restore = configureHttpBudgetForTests({ totalMax: 1, localReserve: 0, queueMax: 8 })
  resetEvidenceLogForTests()
  try {
    const holder = granted(await acquireHttpBudget(request('holder')))
    void acquireHttpBudget(request('gone'))
    void acquireHttpBudget(request('gone'))
    await sleep(5)
    assert.equal(evictHttpBudgetSource('gone'), 2)
    const lines = readEvidenceLog().filter(entry => entry.owner === 'http-budget' && entry.verdict === 'superseded')
    assert.equal(lines.length, 1, 'one line per eviction call, not one per request')
    assert.equal(lines[0]?.detail.count, 2)
    holder.slot.release()
  } finally {
    resetHttpBudgetForTests()
    resetEvidenceLogForTests()
    restore()
  }
})

test('remoteRuntimeControl releases the slot even when the caller signal is unusable', async () => {
  const { remoteRuntimeControl } = await import('../../../dsh-chamber-client-core/src/gateway-runtime.ts')
  resetHttpBudgetForTests()
  const restore = configureHttpBudgetForTests({ totalMax: 2, localReserve: 0 })
  let fetches = 0
  try {
    const outcome = await remoteRuntimeControl('gateway-west', 'restart', {
      signal: {} as AbortSignal,
      fetchImpl: (async () => { fetches += 1; return new Response(null, { status: 202 }) }) as unknown as typeof fetch,
    })
    assert.equal(outcome.kind, 'failed', 'a throwing signal composition is a failed arm, not a crash')
    assert.equal(fetches, 0)
    assert.equal(readHttpBudgetStats().inflight, 0, 'the granted slot must not leak on that path')
  } finally {
    resetHttpBudgetForTests()
    restore()
  }
})

test('kill switch bypasses the budget without queueing', async () => {
  const globals = globalThis as Record<string, unknown>
  try {
    globals.__DSH_CHAMBER_HTTP_BUDGET_OFF__ = true
    const result = granted(await acquireHttpBudget(request('local', 'local')))
    assert.equal(result.bypass, 'kill-switch')
    assert.equal(readHttpBudgetStats().mode, 'off')
    result.slot.release()
  } finally {
    delete globals.__DSH_CHAMBER_HTTP_BUDGET_OFF__
    resetHttpBudgetForTests()
  }
})

test('a bypassed request is still counted as in flight (honest capacity)', async () => {
  const globals = globalThis as Record<string, unknown>
  const restore = configureHttpBudgetForTests({ totalMax: 4, localReserve: 0 })
  try {
    globals.__DSH_CHAMBER_HTTP_BUDGET_OFF__ = true
    const result = granted(await acquireHttpBudget(request('remote')))
    const off = readHttpBudgetStats()
    assert.equal(off.inflight, 1, 'kill switch must not hide a real connection')
    assert.equal(off.bypass, 1, 'the bypass is counted exactly once')
    result.slot.release()
    assert.equal(readHttpBudgetStats().inflight, 0, 'release still frees the slot')
  } finally {
    delete globals.__DSH_CHAMBER_HTTP_BUDGET_OFF__
    resetHttpBudgetForTests()
    restore()
  }
})

test('a leaked slot is reclaimed by the watchdog lease', async () => {
  const restore = configureHttpBudgetForTests({ totalMax: 2, localReserve: 0, watchdogMs: 10, defaultLeaseMs: 15 })
  try {
    granted(await acquireHttpBudget(request('leaky'))) // never released on purpose
    await sleep(80)
    const stats = readHttpBudgetStats()
    assert.ok(stats.leaseExpired >= 1, 'lease expiry counted: ' + String(stats.leaseExpired))
    assert.equal(stats.inflight, 0)
  } finally {
    resetHttpBudgetForTests()
    restore()
  }
})
