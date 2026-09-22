/**
 * restart-window-reload.ts tests: the PAGE-OWNED "wait for the restarted dsh to serve, then reload the
 * window once" completion behind 「重启 dsh」 and the other restart-to-apply entry points (design 18 §3.6 item 8).
 * Waiters/fetch/clock are injected and the page reload is spied through a stubbed window global, so the policy runs
 * in plain node.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  RESTART_RELOAD_BUDGET_MS, armLocalDshRestartCompletion, armWindowReloadWhenServed, reloadWindow,
  waitForLocalDshServing,
} from '../../src/shared/restart-window-reload.ts'

/** Run `body` with a countable page-reload spy installed as globalThis.window. */
async function withReloadSpy<T>(body: (reloads: () => number) => Promise<T>): Promise<T> {
  let count = 0
  const holder = globalThis as { window?: unknown }
  const original = holder.window
  holder.window = { location: { reload: () => { count += 1 } } }
  try { return await body(() => count) } finally {
    if (original === undefined) delete holder.window
    else holder.window = original
  }
}

/** Run `arm` under the reload spy: its outcome plus how many page reloads it caused. */
async function armAndCount<T>(arm: () => Promise<T>): Promise<[T, number]> {
  let outcome!: T
  const count = await withReloadSpy(async reloads => { outcome = await arm(); return reloads() })
  return [outcome, count]
}

/** One JSON response stub for the /health waits. */
const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** A /health fetch stub answering one dsh status. */
const dshHealth = (status: string): typeof fetch => (async () => jsonResponse({ ok: true, dsh: { status } })) as typeof fetch

test('a serving waiter reloads the window once and reports reloaded', async () => {
  assert.deepEqual(await armAndCount(() => armWindowReloadWhenServed('served', async () => true)), ['reloaded', 1])
})

test('a waiter that gives up never reloads', async () => {
  assert.deepEqual(await armAndCount(() => armWindowReloadWhenServed('gave-up', async () => false)), ['not-served', 0])
})

test('a rejecting waiter counts as not-serving and never throws', async () => {
  const rejecting = () => armWindowReloadWhenServed('rejects', async () => { throw new Error('channel down') })
  assert.deepEqual(await armAndCount(rejecting), ['not-served', 0])
})

test('the same key shares one pending completion (no second poll, no second reload)', async () => {
  let calls = 0
  const waiter = async (): Promise<boolean> => { calls += 1; await new Promise(resolve => setTimeout(resolve, 10)); return true }
  const count = await withReloadSpy(async reloads => {
    const first = armWindowReloadWhenServed('shared', waiter)
    const second = armWindowReloadWhenServed('shared', waiter)
    assert.equal(first, second, 'a second arm while pending must reuse the same promise')
    assert.equal(await first, 'reloaded')
    return reloads()
  })
  assert.equal(calls, 1)
  assert.equal(count, 1)
})

test('a settled key can be armed again (retry after a stalled restart)', async () => {
  assert.equal(await armWindowReloadWhenServed('retry', async () => false), 'not-served')
  assert.deepEqual(await armAndCount(() => armWindowReloadWhenServed('retry', async () => true)), ['reloaded', 1])
})

test('distinct keys complete independently', async () => {
  const count = await withReloadSpy(async reloads => {
    const armA = armWindowReloadWhenServed('source-a', async () => true)
    const armB = armWindowReloadWhenServed('source-b', async () => true)
    assert.deepEqual(await Promise.all([armA, armB]), ['reloaded', 'reloaded'])
    return reloads()
  })
  assert.equal(count, 2)
})

test('the page-level budget aborts the waiter signal and reports not-served', async () => {
  let sawAbort = false
  const outcome = await armWindowReloadWhenServed('budget', signal => new Promise<boolean>(resolve => {
    signal.addEventListener('abort', () => { sawAbort = true; resolve(false) }, { once: true })
  }), { budgetMs: 20 })
  assert.equal(outcome, 'not-served')
  assert.equal(sawAbort, true)
})

test('waitForLocalDshServing accepts ready and degraded, polls through starting', async () => {
  assert.equal(await waitForLocalDshServing(new AbortController().signal, { fetchImpl: dshHealth('ready') }), true)
  assert.equal(await waitForLocalDshServing(new AbortController().signal, { fetchImpl: dshHealth('degraded') }), true)
  let calls = 0
  const fetchImpl = (async () => jsonResponse({ ok: true, dsh: { status: (calls += 1) >= 2 ? 'ready' : 'starting' } })) as typeof fetch
  assert.equal(await waitForLocalDshServing(new AbortController().signal, { pollMs: 5, fetchImpl }), true)
  assert.equal(calls, 2)
})

test('waitForLocalDshServing gives up on a non-serving channel within its budget', async () => {
  let calls = 0
  const fetchImpl = (async () => { calls += 1; return jsonResponse({ error: 'unavailable' }, 503) }) as typeof fetch
  assert.equal(await waitForLocalDshServing(new AbortController().signal, { budgetMs: 0, fetchImpl }), false)
  assert.equal(calls, 1)
})

test('waitForLocalDshServing resolves false immediately on an aborted signal', async () => {
  const controller = new AbortController()
  controller.abort()
  let calls = 0
  const fetchImpl = (async () => { calls += 1; return jsonResponse({ ok: true, dsh: { status: 'ready' } }) }) as typeof fetch
  assert.equal(await waitForLocalDshServing(controller.signal, { fetchImpl }), false)
  assert.equal(calls, 0)
})

test('armLocalDshRestartCompletion wires the local /health waiter', async () => {
  const holder = globalThis as { fetch?: typeof fetch }
  const originalFetch = holder.fetch
  holder.fetch = dshHealth('ready')
  try {
    assert.deepEqual(await armAndCount(armLocalDshRestartCompletion), ['reloaded', 1])
  } finally {
    if (originalFetch === undefined) delete holder.fetch
    else holder.fetch = originalFetch
  }
})

test('the gateway arm budget outlives the readiness poll it wraps', () => {
  // pollGatewayReady's inner ceiling is 120s; the page net must not fire first.
  assert.ok(RESTART_RELOAD_BUDGET_MS > 120_000, 'the gateway page net must outlive the 120s readiness poll')
})

test('reloadWindow is a safe no-op outside a browser host', () => {
  assert.equal(typeof window, 'undefined')
  assert.doesNotThrow(() => { reloadWindow() })
})
