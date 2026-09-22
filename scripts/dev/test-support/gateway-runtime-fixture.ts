/**
 * The shared gateway-runtime status fixture (design 18 §9.3): one idle/ready
 * snapshot the status-view, confirm-guard and action-gate suites override per
 * case (2026-12 single-sourcing pass: the sidebar suite carried the same
 * fixture inline as `status()` and the settings-bridge suite as `remoteStatus`).
 */
import type { RemoteRuntimeStatus } from '@dsh-chamber/dsh-chamber-client-ui-sidebar/shared'

/** One gateway runtime status with every field at a healthy default. */
export function remoteStatus(overrides: Partial<RemoteRuntimeStatus> = {}): RemoteRuntimeStatus {
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
