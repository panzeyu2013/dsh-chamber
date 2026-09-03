/**
 * Gateway restart readiness polling tests (design 18 §9.3: restart is 202 +
 * status polling) — moved with pollGatewayReady into the sidebar shared face
 * (design 21 §5.2; the English inline strings travel with the module).
 * Pure node:test with inline fake fetch — no DOM.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pollGatewayReady } from '../src/shared/gateway-runtime-poll.ts'

test('pollGatewayReady resolves on ready, times out honestly, and honours abort', async () => {
  let calls = 0
  const readyFetch = (async () => {
    calls += 1
    return { status: 200, json: async () => ({ connectionState: calls >= 2 ? 'ready' : 'starting' }) }
  }) as unknown as typeof fetch
  await pollGatewayReady('gateway-x', undefined, { fetchImpl: readyFetch, pollIntervalMs: 0, timeoutMs: 5_000 })
  assert.equal(calls, 2, 'polls until ready')

  const stuckFetch = (async () => ({ status: 500, json: async () => ({}) })) as unknown as typeof fetch
  await assert.rejects(
    pollGatewayReady('gateway-x', undefined, { fetchImpl: stuckFetch, pollIntervalMs: 0, timeoutMs: 10 }),
    /did not reach ready/,
  )

  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    pollGatewayReady('gateway-x', controller.signal, { fetchImpl: readyFetch, pollIntervalMs: 0, timeoutMs: 5_000 }),
    /cancelled/,
  )

  // R7: a failed restart must be distinguishable from a slow one — the poll
  // surfaces terminal failure states with the gateway's operationError.
  const failedFetch = (async () => ({
    status: 200,
    json: async () => ({ connectionState: 'restart-exhausted', operationError: 'spawn denied' }),
  })) as unknown as typeof fetch
  await assert.rejects(
    pollGatewayReady('gateway-x', undefined, { fetchImpl: failedFetch, pollIntervalMs: 0, timeoutMs: 5_000 }),
    /restart failed: spawn denied/,
  )
})

test('pollGatewayReady fails fast on auth/support config errors instead of blind-polling', async () => {
  // 401: gateway token invalid/missing through the desktop gateway transport.
  const unauthorized = (async () => ({ status: 401, json: async () => ({}) })) as unknown as typeof fetch
  await assert.rejects(
    pollGatewayReady('gateway-x', undefined, { fetchImpl: unauthorized, pollIntervalMs: 0, timeoutMs: 90_000 }),
    /restart failed: unauthorized \(401\)/,
  )
  // 404: the gateway predates the /chamber/runtime surface.
  const unsupported = (async () => ({ status: 404, json: async () => ({}) })) as unknown as typeof fetch
  await assert.rejects(
    pollGatewayReady('gateway-x', undefined, { fetchImpl: unsupported, pollIntervalMs: 0, timeoutMs: 90_000 }),
    /restart failed: gateway does not expose \/chamber\/runtime \(404\)/,
  )
  // Transient 5xx during the down-window still keeps polling.
  let calls = 0
  const transient = (async () => {
    calls += 1
    if (calls < 3) return { status: 502, json: async () => ({}) }
    return { status: 200, json: async () => ({ connectionState: 'ready', restart: 'ok' }) }
  }) as unknown as typeof fetch
  await pollGatewayReady('gateway-x', undefined, { fetchImpl: transient, pollIntervalMs: 0, timeoutMs: 5_000 })
  assert.equal(calls, 3, '5xx tolerated until ready')
})

test('pollGatewayReady: a post-202 entry rejection (restart:failed + ready connectionState) is a failure, not success', async () => {
  // The gateway manager records restart:'failed' + operationError when
  // plane.restartLocal() rejects at its entry checks after the route already
  // answered 202; connectionState can still read 'ready' at that point.
  const entryRejected = (async () => ({
    status: 200,
    json: async () => ({ connectionState: 'ready', operationError: 'restart-exhausted: recover with start()', restart: 'failed' }),
  })) as unknown as typeof fetch
  await assert.rejects(
    pollGatewayReady('gateway-x', undefined, { fetchImpl: entryRejected, pollIntervalMs: 0, timeoutMs: 5_000 }),
    /restart failed: restart-exhausted: recover with start\(\)/,
  )
  // And restart:'ok' resolves even when the connectionState projection lags.
  const okFetch = (async () => ({
    status: 200,
    json: async () => ({ connectionState: 'starting', restart: 'ok' }),
  })) as unknown as typeof fetch
  await pollGatewayReady('gateway-x', undefined, { fetchImpl: okFetch, pollIntervalMs: 0, timeoutMs: 5_000 })
})

test('pollGatewayReady: terminal connection states OUTRANK a stale/misreported restart:ok', async () => {
  // Round-3 ordering regression: the terminal-state check must run BEFORE the
  // restart:'ok' resolve — resolve ≠ success (restartLocal also resolves from
  // restart-exhausted/error/stopped). A future reordering would fail here.
  for (const terminal of ['restart-exhausted', 'error', 'stopped'] as const) {
    const fetchImpl = (async () => ({
      status: 200,
      json: async () => ({ connectionState: terminal, operationError: `landed ${terminal}`, restart: 'ok' }),
    })) as unknown as typeof fetch
    await assert.rejects(
      pollGatewayReady('gateway-x', undefined, { fetchImpl, pollIntervalMs: 0, timeoutMs: 5_000 }),
      new RegExp(`restart failed: landed ${terminal}`),
      `${terminal} must outrank restart:ok`,
    )
  }
})
