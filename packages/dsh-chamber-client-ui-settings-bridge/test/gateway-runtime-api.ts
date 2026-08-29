/**
 * Gateway runtime API tests (design 18 §3.6/§9.3): the status view three-state
 * mapping, action error classification (409/400 pass-through vs classified
 * 401/403/5xx/network), the post-202 settle poll, and the versions/status
 * parsers. Pure node:test with injected fake fetch — no DOM.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  RemoteRuntimeApiError,
  fetchRemoteRuntimeStatus,
  fetchRemoteRuntimeVersions,
  parseRemoteRuntimeStatus,
  parseRemoteVersions,
  pollRemoteRuntimeUntilSettled,
  remoteRuntimeAction,
  remoteRuntimeActionGates,
  remoteRuntimeSetRegistry,
  remoteRuntimeStatusView,
  type RemoteRuntimeStatus,
} from '../src/client/gateway-runtime-api.ts'

function status(overrides: Partial<RemoteRuntimeStatus> = {}): RemoteRuntimeStatus {
  return {
    kind: 'dsh-chamber-gateway-runtime',
    activeVersion: '1.0.0',
    builtinVersion: '0.9.0',
    currentVersion: '1.0.0',
    selectedVersion: '1.0.0',
    hasOverride: true,
    source: 'builtin-anchor',
    phase: 'idle',
    startupBlockedReason: null,
    pending: null,
    connectionState: 'ready',
    registry: 'https://registry.npmjs.org',
    registryError: null,
    platform: 'darwin',
    mutationsAllowed: true,
    operationError: null,
    restart: null,
    restoreOutcome: null,
    snapshotCount: 0,
    latestSnapshotAt: null,
    snapshotError: null,
    restoreInProgress: false,
    preRollbackCount: 0,
    preRollbackLatestName: null,
    failure: null,
    diskUsage: null,
    diskError: null,
    diskLimitBytes: 10 * 1024 ** 3,
    diskLimitExceeded: false,
    progress: null,
    ...overrides,
  }
}

function statusResponse(payload: unknown, httpStatus = 200): Response {
  return { status: httpStatus, json: async () => payload } as unknown as Response
}

/** Fake fetch returning the given responses in order (last one repeats). */
function fetchSequence(responses: Array<{ payload: unknown; status?: number }>) {
  let calls = 0
  const fetchImpl = (async () => {
    const next = responses[Math.min(calls, responses.length - 1)]!
    calls += 1
    return statusResponse(next.payload, next.status)
  }) as unknown as typeof fetch
  return { fetchImpl, calls: () => calls }
}

test('remoteRuntimeStatusView maps the remote status to the four render kinds without inventing fields', () => {
  // busy: in-flight apply (pending is the version param; the applying window
  // uses the immediate-restart copy shared with the local branch) / restart
  // running / installing.
  assert.deepEqual(remoteRuntimeStatusView(status({ phase: 'applying', pending: '1.1.0' })), {
    kind: 'busy', titleKey: 'dshRuntimeStatusApplyingNow', params: { version: '1.1.0' }, detail: null,
  })
  assert.deepEqual(remoteRuntimeStatusView(status({ phase: 'applying', pending: null })), {
    kind: 'busy', titleKey: 'dshRuntimeStatusApplyingNow', params: { version: '—' }, detail: null,
  })
  assert.deepEqual(remoteRuntimeStatusView(status({ phase: 'installing' })), {
    kind: 'busy', titleKey: 'dshRuntimeProgressInstalling', params: undefined, detail: null,
  })
  assert.deepEqual(remoteRuntimeStatusView(status({ phase: 'pending', pending: '1.1.0' })), {
    kind: 'idle', titleKey: 'dshRuntimeStatusPending', params: { version: '1.1.0' }, detail: null,
  })
  assert.deepEqual(remoteRuntimeStatusView(status({ restart: 'running' })), {
    kind: 'busy', titleKey: 'dshRuntimeRemoteStatusRestarting', params: undefined, detail: null,
  })
  // failed: operationError (failed async job) / terminal restart failure —
  // only when no blocked phase/reason is present.
  assert.deepEqual(remoteRuntimeStatusView(status({ operationError: 'install failed: ENOSPC' })), {
    kind: 'failed', titleKey: 'dshRuntimeRemoteStatusFailed', params: { error: 'install failed: ENOSPC' }, detail: null,
  })
  assert.deepEqual(remoteRuntimeStatusView(status({ restart: 'failed', operationError: 'dsh restart did not reach ready (stopped)' })), {
    kind: 'failed', titleKey: 'dshRuntimeRemoteStatusFailed', params: { error: 'dsh restart did not reach ready (stopped)' }, detail: null,
  })
  // blocked: each blocked phase names its resume route; the raw reason is the detail.
  assert.deepEqual(remoteRuntimeStatusView(status({ phase: 'swap-attempted', startupBlockedReason: 'swap-attempted' })), {
    kind: 'blocked', titleKey: 'dshRuntimeRemoteStatusSwapAttempted', params: undefined, detail: 'swap-attempted',
  })
  assert.deepEqual(remoteRuntimeStatusView(status({ phase: 'snapshot-failed', startupBlockedReason: 'snapshot-failed' })), {
    kind: 'blocked', titleKey: 'dshRuntimeRemoteStatusSnapshotFailed', params: undefined, detail: 'snapshot-failed',
  })
  assert.deepEqual(remoteRuntimeStatusView(status({ phase: 'restore-blocked', startupBlockedReason: 'restore-incomplete' })), {
    kind: 'blocked', titleKey: 'dshRuntimeRemoteStatusRestoreBlocked', params: undefined, detail: 'restore-incomplete',
  })
  // FATAL metadata blocks keep the surface alive but project phase idle — the
  // blocked kind must come from startupBlockedReason alone in that case.
  assert.deepEqual(remoteRuntimeStatusView(status({ phase: 'idle', startupBlockedReason: 'journal-corrupt' })), {
    kind: 'blocked', titleKey: 'dshRuntimeRemoteStatusBlocked', params: undefined, detail: 'journal-corrupt',
  })
  assert.deepEqual(remoteRuntimeStatusView(status()), {
    kind: 'idle', titleKey: 'dshRuntimeRemoteStatusIdle', params: undefined, detail: null,
  })
  // Precedence: an in-flight apply outranks a stale failure record.
  assert.deepEqual(remoteRuntimeStatusView(status({ phase: 'applying', operationError: 'stale failure' })), {
    kind: 'busy', titleKey: 'dshRuntimeStatusApplyingNow', params: { version: '—' }, detail: null,
  })
  // P2-C: a durable recovery phase outranks operationError (an F3 apply-now
  // failure leaves BOTH startupBlockedReason and operationError set — the
  // phase names the resume route, so the blocked copy wins, never 'failed').
  assert.deepEqual(remoteRuntimeStatusView(status({
    phase: 'swap-attempted', startupBlockedReason: 'swap-attempted', operationError: 'swap-attempted',
  })), {
    kind: 'blocked', titleKey: 'dshRuntimeRemoteStatusSwapAttempted', params: undefined, detail: 'swap-attempted',
  })
  assert.deepEqual(remoteRuntimeStatusView(status({
    phase: 'snapshot-failed', startupBlockedReason: 'snapshot-failed', operationError: 'snapshot failed: ENOSPC',
  })), {
    kind: 'blocked', titleKey: 'dshRuntimeRemoteStatusSnapshotFailed', params: undefined, detail: 'snapshot-failed',
  })
})

test('remote action gates lock pending/installing in step with the server and preserve the sole pending escape', () => {
  assert.deepEqual(remoteRuntimeActionGates(status({ phase: 'pending', pending: '1.1.0' })), {
    mutationDisabled: true,
    restoreBuiltinDisabled: false,
    retryApplyDisabled: true,
    retryRestoreDisabled: true,
    restartDisabled: true,
    applyNowDisabled: false,
  })
  assert.deepEqual(remoteRuntimeActionGates(status({ phase: 'installing' })), {
    mutationDisabled: true,
    restoreBuiltinDisabled: true,
    retryApplyDisabled: true,
    retryRestoreDisabled: true,
    restartDisabled: true,
    applyNowDisabled: true,
  })
  assert.deepEqual(remoteRuntimeActionGates(status({ source: 'env' })), {
    mutationDisabled: true,
    restoreBuiltinDisabled: true,
    retryApplyDisabled: true,
    retryRestoreDisabled: true,
    restartDisabled: false,
    applyNowDisabled: true,
  }, 'env pins version management but still permits the source-independent dsh restart')
  assert.deepEqual(remoteRuntimeActionGates(status(), true), {
    mutationDisabled: true,
    restoreBuiltinDisabled: true,
    retryApplyDisabled: true,
    retryRestoreDisabled: true,
    restartDisabled: true,
    applyNowDisabled: true,
  })
  assert.deepEqual(remoteRuntimeActionGates(status({ phase: 'swap-attempted', pending: '1.1.0' })), {
    mutationDisabled: true,
    restoreBuiltinDisabled: false,
    retryApplyDisabled: false,
    retryRestoreDisabled: true,
    restartDisabled: true,
    applyNowDisabled: true,
  })
  assert.deepEqual(remoteRuntimeActionGates(status({ phase: 'restore-blocked', pending: '1.1.0' })), {
    mutationDisabled: true,
    restoreBuiltinDisabled: false,
    retryApplyDisabled: true,
    retryRestoreDisabled: false,
    restartDisabled: true,
    applyNowDisabled: true,
  })
})

test('applyNowDisabled mirrors the apply-now refusal gates (design 18 addendum §5.1)', () => {
  // Plain pending with the managed dsh live → enabled.
  assert.equal(remoteRuntimeActionGates(status({ phase: 'pending', pending: '1.1.0' })).applyNowDisabled, false)
  // Busy tasks (installing/applying/restart running) → disabled.
  assert.equal(remoteRuntimeActionGates(status({ phase: 'installing' })).applyNowDisabled, true)
  assert.equal(remoteRuntimeActionGates(status({ phase: 'applying', pending: '1.1.0' })).applyNowDisabled, true)
  assert.equal(remoteRuntimeActionGates(status({ restart: 'running' })).applyNowDisabled, true)
  // Recovery phases → disabled (the durable recovery routes own those states).
  assert.equal(remoteRuntimeActionGates(status({ phase: 'snapshot-failed', pending: '1.1.0' })).applyNowDisabled, true)
  assert.equal(remoteRuntimeActionGates(status({ phase: 'swap-attempted', pending: '1.1.0' })).applyNowDisabled, true)
  assert.equal(remoteRuntimeActionGates(status({ phase: 'restore-blocked', pending: '1.1.0' })).applyNowDisabled, true)
  // env source → disabled (version mutation, design 18 addendum D5).
  assert.equal(remoteRuntimeActionGates(status({ phase: 'pending', pending: '1.1.0', source: 'env' })).applyNowDisabled, true)
  // mutationsAllowed=false (read-only platform) → disabled.
  assert.equal(remoteRuntimeActionGates(status({ phase: 'pending', pending: '1.1.0', mutationsAllowed: false })).applyNowDisabled, true)
  // connectionState outside ready/degraded → disabled (409 runtime_busy mirror;
  // degraded stays enabled like the server's connectionState gate).
  for (const connectionState of ['starting', 'stopped', 'restart-exhausted', null] as const) {
    assert.equal(
      remoteRuntimeActionGates(status({ phase: 'pending', pending: '1.1.0', connectionState })).applyNowDisabled,
      true,
      `connectionState ${String(connectionState)} disables apply-now`,
    )
  }
  assert.equal(
    remoteRuntimeActionGates(status({ phase: 'pending', pending: '1.1.0', connectionState: 'degraded' })).applyNowDisabled,
    false,
    'degraded stays apply-now enabled (server connectionState gate accepts degraded)',
  )
  // clientBusy (any in-flight renderer action) → disabled.
  assert.equal(remoteRuntimeActionGates(status({ phase: 'pending', pending: '1.1.0' }), true).applyNowDisabled, true)
  // Null status → every gate disabled.
  assert.equal(remoteRuntimeActionGates(null).applyNowDisabled, true)
})

test('remoteRuntimeAction classifies refusals: 409/400 pass the server error through, 401/403/5xx are classified', async () => {
  // 409 business rejection: error + code pass through verbatim (actionable).
  await assert.rejects(
    remoteRuntimeAction('gateway-x', { kind: 'select', version: '1.1.0' },
      { fetchImpl: fetchSequence([{ status: 409, payload: { error: 'runtime activation in progress', code: 'runtime_busy' } }]).fetchImpl }),
    (error: unknown) => {
      if (!(error instanceof RemoteRuntimeApiError)) return false
      assert.equal(error.message, 'runtime activation in progress')
      assert.equal(error.code, 'runtime_busy')
      assert.equal(error.status, 409)
      return true
    },
  )
  // 400 validation refusal, same pass-through.
  await assert.rejects(
    remoteRuntimeAction('gateway-x', { kind: 'rollback', version: '9.9.9' },
      { fetchImpl: fetchSequence([{ status: 400, payload: { error: 'version is required', code: 'bad_request' } }]).fetchImpl }),
    (error: unknown) => {
      if (!(error instanceof RemoteRuntimeApiError)) return false
      assert.equal(error.message, 'version is required')
      assert.equal(error.code, 'bad_request')
      assert.equal(error.status, 400)
      return true
    },
  )
  // 401: classified copy (no secret-bearing body echo).
  await assert.rejects(
    remoteRuntimeAction('gateway-x', { kind: 'apply' },
      { fetchImpl: fetchSequence([{ status: 401, payload: {} }]).fetchImpl }),
    /runtime action apply unauthorized \(401\) — check the gateway connection/,
  )
  // 403: classified prefix, but the server's non-secret reason is retained.
  await assert.rejects(
    remoteRuntimeAction('gateway-x', { kind: 'restore-builtin' },
      { fetchImpl: fetchSequence([{ status: 403, payload: { error: 'runtime mutations are read-only on this platform', code: 'platform_read_only' } }]).fetchImpl }),
    /runtime action restore-builtin refused \(403\): runtime mutations are read-only on this platform/,
  )
  // 5xx: classified service error.
  await assert.rejects(
    remoteRuntimeAction('gateway-x', { kind: 'retry-apply' },
      { fetchImpl: fetchSequence([{ status: 500, payload: {} }]).fetchImpl }),
    /runtime action retry-apply service error \(500\)/,
  )
  // Network: classified reachability copy.
  const network = (async () => { throw new Error('boom') }) as unknown as typeof fetch
  await assert.rejects(
    remoteRuntimeAction('gateway-x', { kind: 'apply' }, { fetchImpl: network }),
    /cannot reach the gateway runtime surface: boom/,
  )
})

test('remoteRuntimeAction: 200/202 are accepted and the request body carries the version only where required', async () => {
  let bodySeen: string | null = null
  const ok = (async (input: RequestInfo | URL, init?: RequestInit) => {
    bodySeen = typeof init?.body === 'string' ? init.body : null
    return statusResponse({ accepted: true, version: '1.1.0' }, 202)
  }) as unknown as typeof fetch
  const result = await remoteRuntimeAction('gateway-x', { kind: 'select', version: '1.1.0' }, { fetchImpl: ok })
  assert.deepEqual(result, { accepted: true, status: 202 })
  assert.equal(bodySeen, JSON.stringify({ version: '1.1.0' }))

  const noBody = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(init?.body, undefined, 'apply/restore-builtin carry no body')
    return statusResponse({ pending: true }, 200)
  }) as unknown as typeof fetch
  await remoteRuntimeAction('gateway-x', { kind: 'apply' }, { fetchImpl: noBody })
})

test('remoteRuntimeAction apply-now POSTs /chamber/runtime/apply-now and accepts 202', async () => {
  // Container object: TS7 narrows closure-assigned `let` bindings aggressively,
  // so capture the request through a stable property container.
  const seen: { url: string | null; method: string | null; body: unknown } = {
    url: null, method: null, body: undefined,
  }
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.url = String(input)
    seen.method = init?.method ?? null
    seen.body = init?.body
    return statusResponse({ accepted: true }, 202)
  }) as unknown as typeof fetch
  const result = await remoteRuntimeAction('gateway-x', { kind: 'apply-now' }, { fetchImpl })
  assert.deepEqual(result, { accepted: true, status: 202 })
  assert.equal(seen.url, '/api/i/gateway-x/chamber/runtime/apply-now')
  assert.equal(seen.method, 'POST')
  assert.equal(seen.body, undefined, 'apply-now carries no body')

  // The 202 async job is polled to settlement by the caller; a synchronous
  // 409 refusal still passes the server copy through verbatim.
  const refused = fetchSequence([{
    status: 409,
    payload: { error: 'managed dsh is not running (stopped)', code: 'runtime_busy' },
  }])
  await assert.rejects(
    remoteRuntimeAction('gateway-x', { kind: 'apply-now' }, { fetchImpl: refused.fetchImpl }),
    (error: unknown) => {
      if (!(error instanceof RemoteRuntimeApiError)) return false
      assert.equal(error.message, 'managed dsh is not running (stopped)')
      assert.equal(error.code, 'runtime_busy')
      assert.equal(error.status, 409)
      return true
    },
  )
})

test('the canonical gateway chamber id is validated before any request leaves the client', async () => {
  await assert.rejects(
    remoteRuntimeAction('local', { kind: 'apply' }),
    /Invalid gateway chamber instance id/,
  )
  await assert.rejects(
    fetchRemoteRuntimeStatus('ssh-1', { fetchImpl: fetchSequence([{ payload: {} }]).fetchImpl }),
    /Invalid gateway chamber instance id/,
  )
})

test('fetchRemoteRuntimeStatus/fetchRemoteRuntimeVersions consume the documented contract and classify non-200s', async () => {
  const ok = fetchSequence([{ payload: status({ activeVersion: '1.0.0' }) }])
  const got = await fetchRemoteRuntimeStatus('gateway-x', { fetchImpl: ok.fetchImpl })
  assert.equal(got.activeVersion, '1.0.0')
  assert.equal(ok.calls(), 1)

  await assert.rejects(
    fetchRemoteRuntimeStatus('gateway-x',
      { fetchImpl: fetchSequence([{ status: 401, payload: {} }]).fetchImpl }),
    /runtime status unauthorized \(401\) — check the gateway connection/,
  )
  await assert.rejects(
    fetchRemoteRuntimeStatus('gateway-x',
      { fetchImpl: fetchSequence([{ status: 404, payload: {} }]).fetchImpl }),
    /runtime status unavailable \(404\) — the gateway does not expose \/chamber\/runtime/,
  )

  const versionsOk = fetchSequence([{ payload: { registryOrigin: 'https://registry.npmjs.org', versions: [] } }])
  const versions = await fetchRemoteRuntimeVersions('gateway-x', { fetchImpl: versionsOk.fetchImpl })
  assert.deepEqual(versions, { registryOrigin: 'https://registry.npmjs.org', versions: [] })
})

test('remoteRuntimeSetRegistry PUTs the origin and passes bad-registry rejections through', async () => {
  const ok = fetchSequence([{ payload: { origin: 'https://registry.npmmirror.com' } }])
  const got = await remoteRuntimeSetRegistry('gateway-x', 'https://registry.npmmirror.com', { fetchImpl: ok.fetchImpl })
  assert.deepEqual(got, { origin: 'https://registry.npmmirror.com' })

  await assert.rejects(
    remoteRuntimeSetRegistry('gateway-x', 'ftp://nope',
      { fetchImpl: fetchSequence([{ status: 400, payload: { error: 'invalid registry origin', code: 'bad_registry_origin' } }]).fetchImpl }),
    (error: unknown) => {
      if (!(error instanceof RemoteRuntimeApiError)) return false
      assert.equal(error.message, 'invalid registry origin')
      assert.equal(error.code, 'bad_registry_origin')
      assert.equal(error.status, 400)
      return true
    },
  )
})

test('pollRemoteRuntimeUntilSettled resolves when install/apply phase or restart settles', async () => {
  // applying → idle.
  let calls = 0
  const settling = (async () => {
    calls += 1
    return statusResponse(status({ phase: calls === 1 ? 'applying' : 'idle', pending: '1.1.0' }))
  }) as unknown as typeof fetch
  const settled = await pollRemoteRuntimeUntilSettled('gateway-x', { fetchImpl: settling, pollIntervalMs: 0, timeoutMs: 5_000 })
  assert.equal(settled.phase, 'idle')
  assert.equal(calls, 2, 'polls until settled')

  let installCalls = 0
  const installSettling = (async () => {
    installCalls += 1
    return statusResponse(status({ phase: installCalls === 1 ? 'installing' : 'idle' }))
  }) as unknown as typeof fetch
  await pollRemoteRuntimeUntilSettled('gateway-x', { fetchImpl: installSettling, pollIntervalMs: 0, timeoutMs: 5_000 })
  assert.equal(installCalls, 2, 'the async select poll does not settle while phase is installing')

  // restart running → ok.
  let restartCalls = 0
  const restartSettling = (async () => {
    restartCalls += 1
    return statusResponse(status({ restart: restartCalls === 1 ? 'running' : 'ok' }))
  }) as unknown as typeof fetch
  await pollRemoteRuntimeUntilSettled('gateway-x', { fetchImpl: restartSettling, pollIntervalMs: 0, timeoutMs: 5_000 })
  assert.equal(restartCalls, 2)

  // interval is a parameter: two polls spaced by the injected sleep.
  let intervalCalls = 0
  const intervalSettling = (async () => {
    intervalCalls += 1
    return statusResponse(status({ phase: intervalCalls === 1 ? 'applying' : 'idle' }))
  }) as unknown as typeof fetch
  const sleeps: number[] = []
  await pollRemoteRuntimeUntilSettled('gateway-x', {
    fetchImpl: intervalSettling,
    sleepMs: async (ms) => { sleeps.push(ms) },
    pollIntervalMs: 250,
    timeoutMs: 5_000,
  })
  assert.equal(intervalCalls, 2)
  assert.deepEqual(sleeps, [250], 'sleep honours the interval parameter')
})

test('pollRemoteRuntimeUntilSettled reports terminal failure and timeout honestly', async () => {
  // never settles → honest timeout (no fake success).
  const stuck = (async () => statusResponse(status({ phase: 'applying' }))) as unknown as typeof fetch
  await assert.rejects(
    pollRemoteRuntimeUntilSettled('gateway-x', { fetchImpl: stuck, pollIntervalMs: 0, timeoutMs: 10 }),
    /did not settle in time/,
  )

  // restart failed → terminal failure with the server's copy.
  const failed = (async () => statusResponse(status({ restart: 'failed', operationError: 'restart-exhausted' }))) as unknown as typeof fetch
  await assert.rejects(
    pollRemoteRuntimeUntilSettled('gateway-x', { fetchImpl: failed, pollIntervalMs: 0, timeoutMs: 5_000 }),
    /runtime action failed: restart-exhausted/,
  )

  // select failure: a settled phase with operationError set is a failure, not success.
  const selectFailed = (async () => statusResponse(status({ operationError: 'install failed: ENOSPC' }))) as unknown as typeof fetch
  await assert.rejects(
    pollRemoteRuntimeUntilSettled('gateway-x', { fetchImpl: selectFailed, pollIntervalMs: 0, timeoutMs: 5_000 }),
    /runtime action failed: install failed: ENOSPC/,
  )
})

test('status parsing: documented contract, version-skew defaults, unknown enums pass through, malformed fails loud', () => {
  const parsed = parseRemoteRuntimeStatus({
    kind: 'dsh-chamber-gateway-runtime',
    activeVersion: '1.0.0',
    builtinVersion: '0.9.0',
    currentVersion: '1.0.0',
    selectedVersion: '1.0.0',
    hasOverride: true,
    source: 'user-selected',
    phase: 'future-phase', // a newer gateway's phase must not take the section down
    startupBlockedReason: null,
    pending: '1.1.0',
    connectionState: 'starting',
    registry: 'https://registry.npmjs.org',
    registryError: null,
    platform: 'linux',
    mutationsAllowed: false,
    operationError: null,
    restart: 'ok',
    restoreOutcome: 'complete',
    snapshotCount: 2,
    latestSnapshotAt: '2026-08-28T00:00:00.000Z',
    snapshotError: null,
    restoreInProgress: false,
    preRollbackCount: 1,
    preRollbackLatestName: '1735344000000',
    failure: { version: '0.8.0', at: '2026-08-27T00:00:00.000Z', reason: 'probe failed' },
    diskUsage: {
      versionTrees: 2, versionTreeBytes: 100, storeBytes: 200, cacheBytes: 30,
      installHomeBytes: 4, xdgCacheBytes: 5, workBytes: 6, failureBytes: 7,
      snapshotBytes: 8, preRollbackBytes: 9, restoreBackupBytes: 10,
      totalBytes: 379, storePruneNeeded: false,
    },
    diskError: null,
    diskLimitBytes: 10 * 1024 ** 3,
    diskLimitExceeded: false,
    progress: { stage: 'download', received: 50, total: 100 },
  })
  assert.equal(parsed.phase, 'future-phase')
  assert.equal(parsed.source, 'user-selected')
  assert.equal(parsed.mutationsAllowed, false)
  assert.equal(parsed.restart, 'ok')
  assert.equal(parsed.kind, 'dsh-chamber-gateway-runtime')
  assert.equal(parsed.builtinVersion, '0.9.0')
  assert.equal(parsed.snapshotCount, 2)
  assert.equal(parsed.preRollbackCount, 1)
  assert.equal(parsed.preRollbackLatestName, '1735344000000')
  assert.equal(parsed.failure?.reason, 'probe failed')
  assert.equal(parsed.diskUsage?.totalBytes, 379)
  assert.deepEqual(parsed.progress, { stage: 'download', received: 50, total: 100 })

  // Older gateways: absent restart → null, absent mutationsAllowed → true
  // (mutations were allowed before the win32 read-only gate).
  const legacy = parseRemoteRuntimeStatus({
    kind: 'dsh-chamber-gateway-runtime', activeVersion: '1.0.0', source: 'builtin-anchor', phase: 'idle',
    startupBlockedReason: null, pending: null, connectionState: 'ready',
    registry: 'r', platform: 'darwin', operationError: null,
  })
  assert.equal(legacy.restart, null)
  assert.equal(legacy.mutationsAllowed, true)

  assert.throws(() => parseRemoteRuntimeStatus({ kind: 'dsh-chamber-gateway-runtime', activeVersion: 1 }), /malformed runtime status\.activeVersion/)
  assert.throws(() => parseRemoteRuntimeStatus({ activeVersion: '1.0.0' }), /malformed runtime status\.kind/)
  assert.throws(() => parseRemoteRuntimeStatus([]), /malformed runtime status/)
})

test('versions parsing: whitelist projection, error field preserved, malformed entries fail loud', () => {
  assert.deepEqual(parseRemoteVersions({
    registryOrigin: 'https://registry.npmjs.org',
    versions: [
      { version: '1.2.0', latest: true, cached: false, belowBaseline: false },
      { version: '1.0.0', latest: false, cached: true, belowBaseline: true },
    ],
  }), {
    registryOrigin: 'https://registry.npmjs.org',
    versions: [
      { version: '1.2.0', latest: true, cached: false, belowBaseline: false },
      { version: '1.0.0', latest: false, cached: true, belowBaseline: true },
    ],
  })
  assert.deepEqual(parseRemoteVersions({
    registryOrigin: 'https://registry.npmmirror.com',
    versions: [],
    error: 'registry unreachable',
  }), { registryOrigin: 'https://registry.npmmirror.com', versions: [], error: 'registry unreachable' })
  assert.throws(
    () => parseRemoteVersions({ registryOrigin: 'x', versions: [{ version: 1 }] }),
    /malformed runtime version entry\.version/,
  )
  assert.throws(
    () => parseRemoteVersions({ registryOrigin: 'x', versions: 'nope' }),
    /malformed runtime versions\.versions/,
  )
})
