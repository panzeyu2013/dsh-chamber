/**
 * Gateway runtime STATUS VIEW mapping tests (design 18 §3.6/§9.3): the render
 * three-state mapping `remoteRuntimeStatusView` → `RemoteRuntimeStatusView`
 * (the settings-bridge half of the design 21 §5.2 split, carrying
 * SettingsBridgeKey dictionary keys). Pure node:test — no DOM.
 *
 * The pure core's cases live where the core lives: parsers / fetchers /
 * action gates / error classification / the settle poll are covered by the
 * client-core test (gateway-runtime.test.ts,
 * `@dsh-chamber/dsh-chamber-client-core`), and the restart poll by the
 * client-core poll test (gateway-runtime-poll.test.ts).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { projectRemoteRuntimeBadge, remoteRuntimeStatusView } from '../../src/client/gateway-runtime-api.ts'
import { remoteStatus as status } from '../support/runtime-fixtures.ts'

test('projectRemoteRuntimeBadge maps remote states onto the unified badge vocabulary', () => {
  assert.equal(projectRemoteRuntimeBadge(null), null)
  assert.deepEqual(projectRemoteRuntimeBadge(status()), { label: 'ok', tone: 'ok' })
  assert.deepEqual(
    projectRemoteRuntimeBadge(status({ phase: 'installing' })),
    { label: 'installing', tone: 'busy' },
  )
  assert.deepEqual(
    projectRemoteRuntimeBadge(status({ phase: 'applying' })),
    { label: 'applying', tone: 'busy' },
  )
  assert.deepEqual(
    projectRemoteRuntimeBadge(status({ phase: 'pending', pending: '1.1.0' })),
    { label: 'pending', tone: 'warn' },
  )
  assert.deepEqual(
    projectRemoteRuntimeBadge(status({ phase: 'swap-attempted', startupBlockedReason: 'swap-attempted' })),
    { label: 'swap-attempted', tone: 'danger' },
  )
  assert.deepEqual(
    projectRemoteRuntimeBadge(status({ phase: 'snapshot-failed', startupBlockedReason: 'snapshot-failed' })),
    { label: 'snapshot-failed', tone: 'danger' },
  )
  assert.deepEqual(
    projectRemoteRuntimeBadge(status({ phase: 'restore-blocked', startupBlockedReason: 'restore-half' })),
    { label: 'restore-blocked', tone: 'danger' },
  )
  assert.deepEqual(
    projectRemoteRuntimeBadge(status({ restart: 'running' })),
    { label: 'restarting', tone: 'busy' },
  )
  assert.deepEqual(
    projectRemoteRuntimeBadge(status({ phase: 'idle', startupBlockedReason: 'journal corrupt' })),
    { label: 'blocked', tone: 'danger' },
    'a blocked idle projection never renders next to the ok pill',
  )
  assert.deepEqual(
    projectRemoteRuntimeBadge(status({ operationError: 'install failed: x' })),
    { label: 'failed', tone: 'danger' },
  )
  assert.deepEqual(
    projectRemoteRuntimeBadge(status({ restart: 'failed', operationError: 'did not reach ready' })),
    { label: 'failed', tone: 'danger' },
  )
})

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
  // A durable recovery phase outranks operationError (a failure can leave
  // BOTH startupBlockedReason and operationError set — the
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

test('projectRemoteRuntimeBadge: corrupt metadata outranks the generic startup-blocked label', () => {
  assert.deepEqual(
    projectRemoteRuntimeBadge(status({ metadataHealth: 'selection-corrupt', startupBlockedReason: 'journal-corrupt' })),
    { label: 'metadata', tone: 'danger' },
  )
  assert.deepEqual(
    projectRemoteRuntimeBadge(status({ metadataHealth: 'recovery-in-progress' })),
    { label: 'metadata', tone: 'danger' },
  )
  assert.deepEqual(
    projectRemoteRuntimeBadge(status({ metadataHealth: 'recovery-marker-corrupt' })),
    { label: 'metadata', tone: 'danger' },
  )
})
