/**
 * Gateway restart readiness polling tests (design 18 §9.3: restart is 202 + status polling) — pollGatewayReady
 * lives in the sidebar shared face (design 21 §5.2; the English inline strings travel with the module).
 * Pure node:test with inline fake fetch — no DOM.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pollGatewayReady } from '../../src/shared/gateway-runtime-poll.ts'
import { pollUntil } from '../../src/shared/poll.ts'

/** One status-route fetch stub: HTTP `status` and a canned JSON body. */
const stubFetch = (status: number, body: unknown): typeof fetch => (async () => ({ status, json: async () => body })) as unknown as typeof fetch
const fast = { pollIntervalMs: 0, timeoutMs: 5_000 }

test('pollGatewayReady resolves on ready, times out honestly, and honours abort', async () => {
  let calls = 0
  const readyFetch = (async () => {
    calls += 1
    return { status: 200, json: async () => ({ connectionState: calls >= 2 ? 'ready' : 'starting' }) }
  }) as unknown as typeof fetch
  await pollGatewayReady('gateway-x', undefined, { fetchImpl: readyFetch, ...fast })
  assert.equal(calls, 2, 'polls until ready')

  const stuckFetch = stubFetch(500, {})
  await assert.rejects(pollGatewayReady('gateway-x', undefined, { fetchImpl: stuckFetch, pollIntervalMs: 0, timeoutMs: 10 }), /did not reach ready/)

  const controller = new AbortController()
  controller.abort()
  await assert.rejects(pollGatewayReady('gateway-x', controller.signal, { fetchImpl: readyFetch, ...fast }), /cancelled/)

  // A failed restart must be distinguishable from a slow one — the poll surfaces terminal failure states
  // with the gateway's operationError.
  const failedFetch = stubFetch(200, { connectionState: 'restart-exhausted', operationError: 'spawn denied' })
  await assert.rejects(pollGatewayReady('gateway-x', undefined, { fetchImpl: failedFetch, ...fast }), /restart failed: spawn denied/)
})

test('pollGatewayReady fails fast on auth/support config errors instead of blind-polling', async () => {
  // 401: gateway token invalid/missing through the desktop gateway transport.
  const unauthorized = stubFetch(401, {})
  await assert.rejects(pollGatewayReady('gateway-x', undefined, { fetchImpl: unauthorized, ...fast, timeoutMs: 90_000 }),
    /restart failed: unauthorized \(401\)/)
  // 404: the gateway predates the /chamber/runtime surface.
  const unsupported = stubFetch(404, {})
  await assert.rejects(pollGatewayReady('gateway-x', undefined, { fetchImpl: unsupported, ...fast, timeoutMs: 90_000 }),
    /restart failed: gateway does not expose \/chamber\/runtime \(404\)/)
  // Transient 5xx during the down-window still keeps polling.
  let calls = 0
  const transient = (async () => {
    calls += 1
    return { status: calls < 3 ? 502 : 200, json: async () => (calls < 3 ? {} : { connectionState: 'ready', restart: 'ok' }) }
  }) as unknown as typeof fetch
  await pollGatewayReady('gateway-x', undefined, { fetchImpl: transient, ...fast })
  assert.equal(calls, 3, '5xx tolerated until ready')
})

test('pollGatewayReady: a post-202 entry rejection (restart:failed + ready connectionState) is a failure, not success', async () => {
  // The gateway manager records restart:'failed' + operationError when plane.restartLocal() rejects at its entry
  // checks after the route already answered 202; connectionState can still read 'ready' at that point.
  const entryRejected = stubFetch(200, {
    connectionState: 'ready', operationError: 'restart-exhausted: recover with start()', restart: 'failed',
  })
  await assert.rejects(pollGatewayReady('gateway-x', undefined, { fetchImpl: entryRejected, ...fast }),
    /restart failed: restart-exhausted: recover with start\(\)/)
  // And restart:'ok' resolves even when the connectionState projection lags.
  const okFetch = stubFetch(200, { connectionState: 'starting', restart: 'ok' })
  await pollGatewayReady('gateway-x', undefined, { fetchImpl: okFetch, ...fast })
})

test('pollGatewayReady: terminal connection states OUTRANK a stale/misreported restart:ok', async () => {
  // The terminal-state check must run BEFORE the restart:'ok' resolve — resolve ≠ success
  // (restartLocal also resolves from restart-exhausted/error/stopped). A future reordering would fail here.
  for (const terminal of ['restart-exhausted', 'error', 'stopped'] as const) {
    const fetchImpl = stubFetch(200, { connectionState: terminal, operationError: 'landed ' + terminal, restart: 'ok' })
    await assert.rejects(pollGatewayReady('gateway-x', undefined, { fetchImpl, ...fast }),
      new RegExp('restart failed: landed ' + terminal), terminal + ' must outrank restart:ok')
  }
})

test('the poll kernel stops at the attempts budget and on a stop verdict (no extra rounds)', async () => {
  // attempts mode: exactly N probes, then undefined — the caller owns the timeout wording.
  let probes = 0
  const exhausted = await pollUntil<number>({
    attempts: 3,
    intervalMs: 0,
    waitFirst: true,
    probe: async () => { probes += 1; return probes },
    classify: () => ({ kind: 'retry' }),
  })
  assert.equal(exhausted, undefined)
  assert.equal(probes, 3)

  // A rejected probe mapped to 'stop' ends the loop immediately (the purge
  // settle wait must keep the last observed running set, not fabricate one).
  let failedProbes = 0
  const stopped = await pollUntil<number>({
    attempts: 5,
    intervalMs: 0,
    waitFirst: true,
    probe: async () => { failedProbes += 1; throw new Error('running read failed') },
    classify: () => ({ kind: 'retry' }),
    onProbeError: () => ({ kind: 'stop' }),
  })
  assert.equal(stopped, undefined)
  assert.equal(failedProbes, 1)
})
