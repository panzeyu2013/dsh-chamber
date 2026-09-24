/**
 * OS-resume immediate re-probe, shared by the Electron main process and the
 * Swift sidecar assembly.
 *
 * Only transient failures are touched: phase error/degraded AND not terminal
 * (requiresUserAction === true is a deterministic auth/verifyUp failure that
 * must never auto-retry); never idle (manual disconnect semantics); connect()
 * is idempotent for connecting/ready. A quit in flight must not spawn new
 * transports (an orphan ssh child could outlive dispose); a missing manager is
 * a no-op. A per-instance throw stays loud without breaking the resume frame;
 * the caller supplies its flavor's log label.
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
