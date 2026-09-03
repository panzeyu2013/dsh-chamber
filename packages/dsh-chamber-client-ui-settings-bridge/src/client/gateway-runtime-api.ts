/**
 * Gateway dsh-runtime STATUS VIEW mapping for the per-server settings section
 * (design 18 §3.6/§9.3, design 17 §3): `remoteRuntimeStatusView` renders the
 * gateway `/chamber/runtime/status` projection into the four render kinds
 * (`RemoteRuntimeStatusView`) that carry settings-bridge dictionary keys.
 *
 * VIEW MAPPING ONLY — the pure core lives in the sidebar package shared face
 * (design 21 §5.2 split): the parsers / fetchers / action gates / error
 * classification / the settle poll are exported by
 * `@dsh-chamber/dsh-client-ui-sidebar/shared` (gateway-runtime.ts), and the
 * restart-readiness poll by the same shared face (gateway-runtime-poll.ts).
 * This file keeps only the view mapping because it carries the bridge's UI
 * dictionary keys (SettingsBridgeKey); the shared known-enum arrays
 * REMOTE_PHASES / REMOTE_SOURCES / REMOTE_RESTART are re-imported from shared
 * for the fail-closed known-phase/source/restart guards below.
 *
 * `remoteRuntimeStatusView` derives ONLY from fields the server actually
 * projects (status contract, design 18 §9.3): phase / restart / operationError
 * / startupBlockedReason / pending. Nothing is invented.
 */
import type { SettingsBridgeKey } from '../locales.ts'
import type { RuntimeBadgeView } from '../../../../packages/renderer/src/runtime-management.ts'
import {
  REMOTE_PHASES,
  REMOTE_SOURCES,
  REMOTE_RESTART,
  type RemoteRestartOutcome,
  type RemoteRuntimePhase,
  type RemoteRuntimeSource,
  type RemoteRuntimeStatus,
} from '@dsh-chamber/dsh-client-ui-sidebar/shared'

/** Render three-state projection of the remote status (design 18 §3.6
 *  status/文案口径 via the §9.3 status contract):
 *   - busy    = phase installing/applying or restart running;
 *   - blocked = startupBlockedReason / restore-blocked / swap-attempted /
 *               snapshot-failed (blocked startup keeps the surface alive) —
 *               OUTRANKS operationError so a durable recovery phase names its
 *               resume route instead of a stale failure line;
 *   - failed  = operationError (failed async job) or terminal restart failed,
 *               only when no blocked phase/reason is present;
 *   - idle    = otherwise.
 * `titleKey` is a settings-bridge dictionary key; `params` feeds `t()`; a
 *  non-null `detail` is the server's verbatim copy to append. */
export interface RemoteRuntimeStatusView {
  kind: 'idle' | 'busy' | 'failed' | 'blocked'
  titleKey: SettingsBridgeKey
  params: Record<string, unknown> | undefined
  detail: string | null
}

/** Durable recovery phases whose copy names the resume route (private to the
 *  view logic; the same precedence lives in the shared core's gates). */
const BLOCKED_PHASES: ReadonlySet<RemoteRuntimePhase> = new Set([
  'snapshot-failed', 'swap-attempted', 'restore-blocked',
])

export function remoteRuntimeStatusView(status: RemoteRuntimeStatus): RemoteRuntimeStatusView {
  const knownPhase = (REMOTE_PHASES as readonly RemoteRuntimePhase[]).includes(status.phase)
  const knownSource = status.source === null || (REMOTE_SOURCES as readonly RemoteRuntimeSource[]).includes(status.source)
  const knownRestart = status.restart === null || (REMOTE_RESTART as readonly RemoteRestartOutcome[]).includes(status.restart)
  if (!knownPhase || !knownSource || !knownRestart) {
    return {
      kind: 'blocked',
      titleKey: 'dshRuntimeRemoteStatusBlocked',
      params: undefined,
      detail: 'Gateway returned an unsupported runtime status; refresh or update this client before changing runtime state.',
    }
  }
  // Busy outranks everything: an in-flight apply/restart is the live state even
  // when a stale failure record lingers.
  if (status.phase === 'installing' || status.phase === 'applying' || status.restart === 'running') {
    return status.restart === 'running'
      ? { kind: 'busy', titleKey: 'dshRuntimeRemoteStatusRestarting', params: undefined, detail: null }
      : status.phase === 'installing'
        ? { kind: 'busy', titleKey: 'dshRuntimeProgressInstalling', params: undefined, detail: null }
        // The gateway applying window uses the same immediate-restart copy as
        // the local apply-now window (and the /chamber/ browser page), not the
        // next-launch applying wording.
        : { kind: 'busy', titleKey: 'dshRuntimeStatusApplyingNow', params: { version: status.pending ?? '—' }, detail: null }
  }
  // Blocked startup (design 18 §9.3: the runtime surface stays pollable while
  // the managed dsh is down) OUTRANKS operationError (P2-C): an F3 failure
  // leaves both startupBlockedReason and operationError set — the phase names
  // the resume route, so the blocked copy wins and the raw reason
  // (swap-attempted / restore-half / restore-incomplete / snapshot-failed /
  // journal-corrupt / journal-mismatch) is appended verbatim as the detail.
  if (BLOCKED_PHASES.has(status.phase) || (status.startupBlockedReason !== null && status.startupBlockedReason !== '')) {
    const titleKey = status.phase === 'swap-attempted'
      ? 'dshRuntimeRemoteStatusSwapAttempted'
      : status.phase === 'snapshot-failed'
        ? 'dshRuntimeRemoteStatusSnapshotFailed'
        : status.phase === 'restore-blocked'
          ? 'dshRuntimeRemoteStatusRestoreBlocked'
          : 'dshRuntimeRemoteStatusBlocked'
    return { kind: 'blocked', titleKey, params: undefined, detail: status.startupBlockedReason }
  }
  // Terminal restart failure or a failed async job surfaces with the server's
  // operationError copy (a restart that never reached ready must never render
  // as success) — only when no blocked phase/reason is present.
  if (status.restart === 'failed' || (status.operationError !== null && status.operationError !== '')) {
    return {
      kind: 'failed',
      titleKey: 'dshRuntimeRemoteStatusFailed',
      params: { error: status.operationError ?? '—' },
      detail: null,
    }
  }
  if (status.phase === 'pending') {
    return { kind: 'idle', titleKey: 'dshRuntimeStatusPending', params: { version: status.pending ?? '—' }, detail: null }
  }
  return { kind: 'idle', titleKey: 'dshRuntimeRemoteStatusIdle', params: undefined, detail: null }
}

/** Gateway status → unified badge (same vocabulary as the local branch's
 *  projectRuntimeBadge — both settings sections render one shared pill).
 *  Idle = 运行时正常, never an "up to date" claim; recovery/blocked/failed
 *  states suppress the ok badge. */
export function projectRemoteRuntimeBadge(status: RemoteRuntimeStatus | null): RuntimeBadgeView | null {
  if (status === null) return null
  if (status.restart === 'running') return { label: 'restarting', tone: 'busy' }
  switch (status.phase) {
    case 'installing': return { label: 'installing', tone: 'busy' }
    case 'applying': return { label: 'applying', tone: 'busy' }
    case 'pending': return { label: 'pending', tone: 'warn' }
    case 'swap-attempted': return { label: 'swap-attempted', tone: 'danger' }
    case 'snapshot-failed': return { label: 'snapshot-failed', tone: 'danger' }
    case 'restore-blocked': return { label: 'restore-blocked', tone: 'danger' }
    case 'idle': break
  }
  // Corrupt metadata (recover-metadata parity, 2026-12) names its own danger
  // badge and outranks the generic startup-blocked label.
  if (status.metadataHealth === 'selection-corrupt'
    || status.metadataHealth === 'recovery-in-progress'
    || status.metadataHealth === 'recovery-marker-corrupt') {
    return { label: 'metadata', tone: 'danger' }
  }
  if (status.startupBlockedReason !== null && status.startupBlockedReason !== '') {
    return { label: status.phase === 'idle' ? 'blocked' : 'restore-blocked', tone: 'danger' }
  }
  if (status.restart === 'failed'
    || (status.operationError !== null && status.operationError !== '')) {
    return { label: 'failed', tone: 'danger' }
  }
  return { label: 'ok', tone: 'ok' }
}
