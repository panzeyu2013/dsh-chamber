/**
 * restart-window-reload.ts tests (2026-12): the PAGE-OWNED "wait for the
 * restarted dsh to serve, then reload the window once" completion behind
 * 「重启 dsh」 and the other restart-to-apply entry points (design 18 §3.6 item 8).
 * Waiters/fetch/clock are injected and the page reload is spied through a
 * stubbed \`window\`, so the whole policy runs in plain node.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  RESTART_RELOAD_BUDGET_MS,
  armLocalDshRestartCompletion,
  armWindowReloadWhenServed,
  reloadWindow,
  resetArmedWindowReloads,
  waitForLocalDshServing,
} from '../../src/shared/restart-window-reload.ts'

/** Run \`body\` with a countable page-reload spy installed as globalThis.window. */
async function withReloadSpy<T>(body: (reloads: () => number) => Promise<T>): Promise<T> {
  let count = 0
  const holder = globalThis as { window?: unknown }
  const original = holder.window
  holder.window = { location: { reload: () => { count += 1 } } }
  try {
    return await body(() => count)
  } finally {
    if (original === undefined) delete holder.window
    else holder.window = original
  }
}

/** One JSON response stub for the /health waits. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

test('a serving waiter reloads the window once and reports reloaded', async () => {
  resetArmedWindowReloads()
  const count = await withReloadSpy(async reloads => {
    const outcome = await armWindowReloadWhenServed('served', async () => true)
    assert.equal(outcome, 'reloaded')
    return reloads()
  })
  assert.equal(count, 1)
})

test('a waiter that gives up never reloads', async () => {
  resetArmedWindowReloads()
  const count = await withReloadSpy(async reloads => {
    assert.equal(await armWindowReloadWhenServed('gave-up', async () => false), 'not-served')
    return reloads()
  })
  assert.equal(count, 0)
})

test('a rejecting waiter counts as not-serving and never throws', async () => {
  resetArmedWindowReloads()
  const count = await withReloadSpy(async reloads => {
    const outcome = await armWindowReloadWhenServed('rejects', async () => { throw new Error('channel down') })
    assert.equal(outcome, 'not-served')
    return reloads()
  })
  assert.equal(count, 0)
})

test('the same key shares one pending completion (no second poll, no second reload)', async () => {
  resetArmedWindowReloads()
  let calls = 0
  const waiter = async (): Promise<boolean> => {
    calls += 1
    await new Promise(resolve => setTimeout(resolve, 10))
    return true
  }
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
  resetArmedWindowReloads()
  const count = await withReloadSpy(async reloads => {
    assert.equal(await armWindowReloadWhenServed('retry', async () => false), 'not-served')
    assert.equal(await armWindowReloadWhenServed('retry', async () => true), 'reloaded')
    return reloads()
  })
  assert.equal(count, 1)
})

test('distinct keys complete independently', async () => {
  resetArmedWindowReloads()
  const count = await withReloadSpy(async reloads => {
    const outcomes = await Promise.all([
      armWindowReloadWhenServed('source-a', async () => true),
      armWindowReloadWhenServed('source-b', async () => true),
    ])
    assert.deepEqual(outcomes, ['reloaded', 'reloaded'])
    return reloads()
  })
  assert.equal(count, 2)
})

test('the page-level budget aborts the waiter signal and reports not-served', async () => {
  resetArmedWindowReloads()
  let sawAbort = false
  const outcome = await armWindowReloadWhenServed('budget', signal => new Promise<boolean>(resolve => {
    signal.addEventListener('abort', () => {
      sawAbort = true
      resolve(false)
    }, { once: true })
  }), { budgetMs: 20 })
  assert.equal(outcome, 'not-served')
  assert.equal(sawAbort, true)
})

test('resetArmedWindowReloads lets the same key arm a fresh completion', async () => {
  resetArmedWindowReloads()
  void armWindowReloadWhenServed('reset', async () => false)
  resetArmedWindowReloads()
  const count = await withReloadSpy(async reloads => {
    assert.equal(await armWindowReloadWhenServed('reset', async () => true), 'reloaded')
    return reloads()
  })
  assert.equal(count, 1)
})

test('waitForLocalDshServing accepts ready and degraded, polls through starting', async () => {
  assert.equal(await waitForLocalDshServing(new AbortController().signal, {
    fetchImpl: async () => jsonResponse({ ok: true, dsh: { status: 'ready' } }),
  }), true)
  assert.equal(await waitForLocalDshServing(new AbortController().signal, {
    fetchImpl: async () => jsonResponse({ ok: true, dsh: { status: 'degraded' } }),
  }), true)
  let calls = 0
  const served = await waitForLocalDshServing(new AbortController().signal, {
    pollMs: 5,
    fetchImpl: async () => {
      calls += 1
      return jsonResponse({ ok: true, dsh: { status: calls >= 2 ? 'ready' : 'starting' } })
    },
  })
  assert.equal(served, true)
  assert.equal(calls, 2)
})

test('waitForLocalDshServing gives up on a non-serving channel within its budget', async () => {
  let calls = 0
  const served = await waitForLocalDshServing(new AbortController().signal, {
    budgetMs: 0,
    fetchImpl: async () => { calls += 1; return jsonResponse({ error: 'unavailable' }, 503) },
  })
  assert.equal(served, false)
  assert.equal(calls, 1)
})

test('waitForLocalDshServing resolves false immediately on an aborted signal', async () => {
  const controller = new AbortController()
  controller.abort()
  let calls = 0
  assert.equal(await waitForLocalDshServing(controller.signal, {
    fetchImpl: async () => { calls += 1; return jsonResponse({ ok: true, dsh: { status: 'ready' } }) },
  }), false)
  assert.equal(calls, 0)
})

test('armLocalDshRestartCompletion wires the local /health waiter', async () => {
  resetArmedWindowReloads()
  const holder = globalThis as { fetch?: typeof fetch }
  const originalFetch = holder.fetch
  holder.fetch = (async () => jsonResponse({ ok: true, dsh: { status: 'ready' } })) as typeof fetch
  try {
    const count = await withReloadSpy(async reloads => {
      const outcome = await armLocalDshRestartCompletion()
      assert.equal(outcome, 'reloaded')
      return reloads()
    })
    assert.equal(count, 1)
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
