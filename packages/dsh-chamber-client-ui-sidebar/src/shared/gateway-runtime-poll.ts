/**
 * Gateway restart readiness polling (design 18 §9.3: restart is 202 + status
 * polling). Pure module (no JSX) with injectable fetch/sleep so the node test
 * harness can cover success, timeout and abort paths.
 */
export interface GatewayPollDeps {
  fetchImpl?: typeof fetch
  sleepMs?: (ms: number) => Promise<void>
  timeoutMs?: number
  pollIntervalMs?: number
}

export async function pollGatewayReady(chamberInstanceId: string, signal?: AbortSignal, deps: GatewayPollDeps = {}): Promise<void> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const sleep = deps.sleepMs ?? ((ms: number) => new Promise(resolve => setTimeout(resolve, ms)))
  const timeoutMs = deps.timeoutMs ?? 120_000
  const intervalMs = deps.pollIntervalMs ?? 1_000
  const deadline = Date.now() + timeoutMs
  const throwIfAborted = (): void => {
    if (signal?.aborted) throw new Error('restart polling cancelled')
  }
  const sleepAbortable = (ms: number): Promise<void> => {
    if (signal === undefined || deps.sleepMs !== undefined) return sleep(ms)
    // The default sleep is also abort-sensitive: an unmount mid-pause must
    // not linger for the full interval (V2 review M5).
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms)
      signal.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(new Error('restart polling cancelled'))
      }, { once: true })
    })
  }
  while (Date.now() < deadline) {
    throwIfAborted()
    try {
      const response = await fetchImpl(`/api/i/${chamberInstanceId}/chamber/runtime/status`, { credentials: 'same-origin', signal })
      if (response.status === 200) {
        const payload = await response.json() as { connectionState?: unknown; operationError?: unknown; restart?: unknown }
        // Review fix: a restart rejected AFTER the 202 (e.g. a canStartLocal
        // gate that closed between the route pre-checks and the transaction)
        // sets restart:'failed' + operationError while connectionState is
        // still 'ready' — that must surface as a failure, never as success.
        if (payload.restart === 'failed') {
          const reason = typeof payload.operationError === 'string' && payload.operationError !== ''
            ? payload.operationError : 'unknown restart failure'
          throw new Error(`restart failed: ${reason}`)
        }
        // Terminal connection states outrank a (stale/misreported) 'ok':
        // restartLocal() also resolves from restart-exhausted/error/stopped
        // (resolve ≠ success, design 18 §9.3) — defense-in-depth for older
        // gateways without the restart-outcome field. 'stopped' is included:
        // both the desktop IPC handler and the gateway manager treat it as a
        // restart failure (round-3 tightening; a legit restart never passes
        // through 'stopped' — control-plane resolves it only when stop() won
        // the epoch race).
        if (payload.connectionState === 'error' || payload.connectionState === 'restart-exhausted' || payload.connectionState === 'stopped') {
          const reason = typeof payload.operationError === 'string' && payload.operationError !== '' ? payload.operationError : 'unknown restart failure'
          throw new Error(`restart failed: ${reason}`)
        }
        if (payload.restart === 'ok') return
        // Backward-compatible fallback for gateways without the restart
        // outcome field (version skew): keep the connectionState contract.
        // 'degraded' counts as success too — the process is alive and the
        // next probe returns to ready (round-4 note).
        if ((payload.connectionState === 'ready' || payload.connectionState === 'degraded') && payload.restart !== 'running') return
      } else if (response.status === 401 || response.status === 403 || response.status === 404) {
        // Review fix: config errors must fail fast, not blind-poll for 90 s
        // into a misattributed readiness timeout.
        const detail = response.status === 401
          ? 'unauthorized (401) — check the gateway token'
          : response.status === 404
            ? 'gateway does not expose /chamber/runtime (404)'
            : 'forbidden (403)'
        throw new Error(`restart failed: ${detail}`)
      }
    } catch (error) {
      throwIfAborted()
      if (error instanceof Error && error.message.startsWith('restart failed')) throw error
      // transient proxy failure while dsh is down — keep polling
    }
    await sleepAbortable(intervalMs)
  }
  throw new Error('restart accepted but the gateway did not reach ready in time')
}
