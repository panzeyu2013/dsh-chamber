/**
 * OS-resume immediate re-probe (design 14 D4), shared by the Electron main
 * process and the Swift sidecar assembly (each caller binds only its own
 * facts to one implementation).
 *
 * Judgement (05 §7.6 discipline): touch ONLY transient failures —
 * phase error/degraded AND not terminal (requiresUserAction === true means a
 * deterministic auth/verifyUp failure that must never auto-retry); NEVER idle
 * (manual disconnect semantics); connect() is idempotent for connecting/ready.
 * Early gates: a quit in flight must not spawn new transports (an orphan ssh
 * child could outlive dispose), and a missing manager (before assembly) is a
 * no-op. A per-instance connect throw is loud and never breaks the resume
 * frame; the caller supplies the flavor's log label so its exact wording is
 * preserved.
 */
import type { TransportManager } from './transport-manager.ts'

export function reconnectStaleTransports(
  sm: Pick<TransportManager, 'listInstances' | 'status' | 'connect'> | null,
  isQuitting: () => boolean,
  warn: (message: string, error: unknown) => void,
  label: string,
): void {
  if (isQuitting()) return
  if (sm === null) return
  for (const instance of sm.listInstances()) {
    const status = sm.status(instance.id)
    if (status === null) continue
    if (status.phase !== 'error' && status.phase !== 'degraded') continue
    if (status.requiresUserAction === true) continue
    try {
      sm.connect(instance.id)
    } catch (error) {
      warn(label + ' 唤醒重探 ' + instance.id + ' 失败：', error)
    }
  }
}
