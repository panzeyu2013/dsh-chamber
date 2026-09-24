/**
 * Gateway runtime-action readiness polling (restart is 202 + status polling; the
 * start primitive has the same 202 contract). Pure module with injectable fetch/sleep.
 *
 * `action` selects WHICH outcome field and decision table this poll follows:
 * restart reads `restart`, start reads `start`. The two are not interchangeable —
 * a start BEGINS from connectionState 'stopped', which the restart table treats
 * as terminal, and a start failure must never be reported as "restart failed".
 */
import { pollUntil, sleepMs } from './poll.ts'

export type GatewayRuntimeAction = 'restart' | 'start'

export interface GatewayPollDeps {
  fetchImpl?: typeof fetch
  sleepMs?: (ms: number) => Promise<void>
  timeoutMs?: number
  pollIntervalMs?: number
  /** The runtime action being polled (default 'restart'). */
  action?: GatewayRuntimeAction
}

/** Connection states terminal for a RESTART (resolve ≠ success). 'stopped' is deliberately NOT terminal for a START — that is the state a start starts from. */
const TERMINAL_CONNECTION_STATES = new Set(['error', 'restart-exhausted'])

export async function pollGatewayReady(chamberInstanceId: string, signal?: AbortSignal, deps: GatewayPollDeps = {}): Promise<void> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const sleep = deps.sleepMs ?? sleepMs
  const timeoutMs = deps.timeoutMs ?? 120_000
  const intervalMs = deps.pollIntervalMs ?? 1_000
  const action: GatewayRuntimeAction = deps.action === 'start' ? 'start' : 'restart'
  /** Wording anchor: every failure names the action it followed. */
  const failure = (reason: string): Error =>
    new Error(`${action} failed: ${reason === '' ? `unknown ${action} failure` : reason}`)
  const deadline = Date.now() + timeoutMs
  const throwIfAborted = (): void => {
    if (signal?.aborted) throw new Error(`${action} polling cancelled`)
  }
  const sleepAbortable = (ms: number): Promise<void> => {
    if (signal === undefined || deps.sleepMs !== undefined) return sleep(ms)
    // The default sleep is abort-sensitive: an unmount mid-pause must not linger for the full interval.
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms)
      signal.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(new Error(`${action} polling cancelled`))
      }, { once: true })
    })
  }
  /** One status round, already reduced to this poll's own vocabulary. */
  type Round =
    | { kind: 'status'; connectionState: string | null; operationError: string; outcome: unknown }
    | { kind: 'config-error'; status: number }
    | { kind: 'transient' }
  const settled = await pollUntil<Round, true>({
    intervalMs,
    deadline,
    sleep: sleepAbortable,
    onProbeError: (error) => {
      throwIfAborted()
      // A failure raised by this poll must surface; a transient proxy failure while dsh is down keeps polling.
      if (error instanceof Error && error.message.startsWith(`${action} failed`)) return { kind: 'fail', error }
      return { kind: 'retry' }
    },
    probe: async (): Promise<Round> => {
      throwIfAborted()
      const response = await fetchImpl(`/api/i/${chamberInstanceId}/chamber/runtime/status`, { credentials: 'same-origin', signal })
      if (response.status !== 200) {
        return response.status === 401 || response.status === 403 || response.status === 404
          ? { kind: 'config-error', status: response.status }
          : { kind: 'transient' }
      }
      const payload = await response.json() as { connectionState?: unknown; operationError?: unknown; restart?: unknown; start?: unknown }
      return {
        kind: 'status',
        connectionState: typeof payload.connectionState === 'string' ? payload.connectionState : null,
        operationError: typeof payload.operationError === 'string' && payload.operationError !== ''
          ? payload.operationError
          : '',
        outcome: payload[action],
      }
    },
    classify: (round) => {
      if (round.kind === 'transient') return { kind: 'retry' }
      if (round.kind === 'config-error') {
        const detail = round.status === 401
          ? 'unauthorized (401) — check the gateway token'
          : round.status === 404
            ? 'gateway does not expose /chamber/runtime (404)'
            : 'forbidden (403)'
        return { kind: 'fail', error: failure(detail) }
      }
      const { connectionState, operationError, outcome } = round
      // A runtime action rejected AFTER the 202 (e.g. a canStartLocal gate closed between the
      // route pre-checks and the transaction) sets <action>:'failed' with connectionState still
      // 'ready' — that must surface as a failure, never as success.
      if (outcome === 'failed') return { kind: 'fail', error: failure(operationError) }
      // Terminal connection states outrank a (stale/misreported) 'ok' — resolve ≠ success,
      // defense-in-depth for older gateways without the outcome field. 'stopped' fails a
      // RESTART only (a legit restart never passes through it; control-plane resolves it only
      // when stop() won the epoch race); a START begins from exactly that state and a genuine
      // start failure is caught by start:'failed' above.
      if (connectionState !== null && TERMINAL_CONNECTION_STATES.has(connectionState)) {
        return { kind: 'fail', error: failure(operationError) }
      }
      if (action === 'restart' && connectionState === 'stopped') return { kind: 'fail', error: failure(operationError) }
      if (outcome === 'ok') return { kind: 'done', value: true }
      // Fallback for gateways without the outcome field (version skew): keep the connectionState
      // contract. 'degraded' counts as success — the next probe returns to ready.
      if ((connectionState === 'ready' || connectionState === 'degraded') && outcome !== 'running') {
        return { kind: 'done', value: true }
      }
      return { kind: 'retry' }
    },
  })
  if (settled === undefined) throw new Error(`${action} accepted but the gateway did not reach ready in time`)
}
