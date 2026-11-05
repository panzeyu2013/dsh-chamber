/**
 * OS-resume immediate re-probe, shared by the Electron main process and the
 * Swift sidecar assembly.
 *
 * Only transient failures are touched: phase error/degraded AND not terminal
 * (requiresUserAction === true means "do not retry the RESUME wave"; a
 * provider-declared terminalRetryable verdict has its own bounded cadence in
 * armTerminalRetry and must not be shortcut here); never idle (manual
 * disconnect semantics); connect()
 * is idempotent for connecting/ready. A quit in flight must not spawn new
 * transports (an orphan ssh child could outlive dispose); a missing manager is
 * a no-op. A per-instance throw stays loud without breaking the resume frame;
 * the caller supplies its flavor's log label.
 *
 * P2-6: a resume can leave many stale instances at once (laptops wake with N
 * remotes). Production passes a small per-instance stagger so N ssh handshakes
 * + verify probes do not fire in one tick; the default stays 0 for callers and
 * tests that want the historical synchronous loop.
 */
import type { TransportManager } from './transport-manager.ts'

export interface ReconnectStaleOptions {
  /** Delay between instances; 0 keeps the historical synchronous loop. */
  readonly staggerMs?: number
}

export function reconnectStaleTransports(
  sm: Pick<TransportManager, 'listInstances' | 'status' | 'connect'> | null,
  isQuitting: () => boolean,
  warn: (message: string, error: unknown) => void,
  label: string,
  options: ReconnectStaleOptions = {},
): void {
  if (isQuitting()) return
  if (sm === null) return
  const staggerMs = Math.max(0, options.staggerMs ?? 0)
  let index = 0
  for (const instance of sm.listInstances()) {
    const status = sm.status(instance.id)
    if (status === null) continue
    if (status.phase !== 'error' && status.phase !== 'degraded') continue
    if (status.requiresUserAction === true) continue
    const attempt = (): void => {
      if (isQuitting()) return
      try {
        sm.connect(instance.id)
      } catch (error) {
        warn(label + ' 唤醒重探 ' + instance.id + ' 失败：', error)
      }
    }
    if (staggerMs === 0 || index === 0) {
      attempt()
    } else {
      const timer = setTimeout(attempt, index * staggerMs)
      timer.unref?.()
    }
    index += 1
  }
}
