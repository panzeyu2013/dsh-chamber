/**
 * Gateway runtime STATUS VIEW mapping tests (design 18 §3.6/§9.3): the render
 * three-state mapping `remoteRuntimeStatusView` → `RemoteRuntimeStatusView`
 * (the settings-bridge half of the design 21 §5.2 split, carrying
 * SettingsBridgeKey dictionary keys). Pure node:test — no DOM.
 *
 * The moved pure core kept its cases where the core now lives: parsers /
 * fetchers / action gates / error classification / the settle poll are
 * covered by the sidebar shared test (gateway-runtime.test.ts,
 * `@dsh-chamber/dsh-client-ui-sidebar/shared`), and the restart poll by the
 * sidebar shared poll test (gateway-runtime-poll.test.ts).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { remoteRuntimeStatusView } from '../src/client/gateway-runtime-api.ts'
import type { RemoteRuntimeStatus } from '@dsh-chamber/dsh-client-ui-sidebar/shared'

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
  assert.deepEqual(remoteRuntimeStatusView(status({ phase: 'future-phase' as never })), {
    kind: 'blocked',
    titleKey: 'dshRuntimeRemoteStatusBlocked',
    params: undefined,
    detail: 'Gateway returned an unsupported runtime status; refresh or update this client before changing runtime state.',
  }, 'a direct caller cannot silently render an unknown future phase as idle')
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
