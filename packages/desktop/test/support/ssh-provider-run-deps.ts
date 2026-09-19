/**
 * Shared ssh-provider TransportExecDeps fake used by the password-store/
 * askpass tests (ssh-provider.test.ts) and the run-channel tests
 * (ssh-provider-exec.test.ts). Bare helper file, not a test.
 */

import type { TransportExecDeps, TransportInstanceSpec, TransportStatusProjection } from '../../transport-provider.ts'

/** A minimal valid ssh spec for provider-surface tests (v2: kind = target type
 *  'dsh', transport = mechanism 'ssh' — design 17 §2). */
export function spec(id: string): TransportInstanceSpec {
  return { id, label: 'h', kind: 'dsh', transport: 'ssh', host: 'h.example.com', user: 'u', sshPort: null, remotePort: 3080, serviceName: null, remoteDshHome: null, insecureHttp: false }
}

/** The same minimal spec with a remote DSH_HOME. */
export function specWithHome(id: string, remoteDshHome: string): TransportInstanceSpec {
  return { ...spec(id), remoteDshHome }
}

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
