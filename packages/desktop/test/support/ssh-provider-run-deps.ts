/**
 * Shared ssh-provider TransportExecDeps fake used by the password-store/
 * askpass tests (ssh-provider.test.ts) and the run-channel tests
 * (ssh-provider-exec.test.ts). Bare helper file, not a test.
 */

import type { TransportExecDeps, TransportStatusProjection } from '../../transport-provider.ts'

export function runDeps(spawnFn: TransportExecDeps['spawnFn']): TransportExecDeps {
  const projection: TransportStatusProjection = {
    kind: 'dsh', transport: 'ssh', insecureHttp: false, phase: 'idle', localPort: null, sshPort: null, remotePort: 3080,
    retryAttempt: 0, requiresUserAction: false, userActionKind: null, serviceActive: null, remoteDshHome: null,
    logSummary: '',
  }
  return {
    spawnFn,
    execTimeoutMs: 5_000,
    runTimeoutMs: 5_000,
    disconnectGraceMs: 100,
    log: () => {},
    setProjection: () => {},
    projection: () => projection,
  }
}
