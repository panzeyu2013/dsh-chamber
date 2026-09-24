/**
 * Managed-dsh state projection for gateway sources: a gateway source's desktop
 * `ready` only proves the GATEWAY PROCESS is alive (the readiness probe reads
 * `/chamber/runtime/status`, which exists precisely because the managed dsh is
 * a separate process). Without this, a stopped/crashed managed dsh leaves the
 * source fully interactive with no degraded projection. This module classifies
 * the `connectionState` the status route carries; the App folds the result into
 * the source's `phase` (status dot) and `connected` (so actions are disabled
 * instead of failing).
 */
import { fetchRemoteRuntimeStatus } from './gateway-runtime.ts'

/** Managed-dsh states that make the source unusable until it comes back. */
export const MANAGED_RUNTIME_DOWN_STATES = ['stopped', 'error', 'restart-exhausted'] as const

/**
 * Transient managed states also unusable for a background mount: the shell would
 * boot against a dsh that is not serving yet (gateway 503); the caller gates on
 * transport usability.
 */
export const MANAGED_RUNTIME_TRANSIENT_STATES = ['starting', 'restarting'] as const

/**
 * Whether a managed-dsh state can never serve a boot right now: terminal-down OR
 * transiently starting/restarting (a starting gateway burns one of only two
 * attempts against 503s).
 */
export function managedRuntimeUnusable(state: string | null | undefined): boolean {
  if (managedRuntimeDown(state)) return true
  return state !== null && state !== undefined
    && (MANAGED_RUNTIME_TRANSIENT_STATES as readonly string[]).includes(state)
}

/**
 * Whether a gateway's managed dsh is terminal-down. Absent or unknown states FAIL
 * OPEN — a missing probe (older gateway, proxy failure, transport down) must never
 * hide a healthy source.
 */
export function managedRuntimeDown(state: string | null | undefined): boolean {
  return typeof state === 'string' && (MANAGED_RUNTIME_DOWN_STATES as readonly string[]).includes(state)
}

export interface ManagedRuntimeDeps {
  fetchImpl?: typeof fetch
  signal?: AbortSignal
}

/**
 * Read one gateway source's managed-dsh connectionState through the per-instance proxy.
 * Delegates to `gateway-runtime.ts` (route shape + id validation) and never throws:
 * transport failure, abort, invalid id, non-200, or malformed body resolve to null = "unknown, fail open".
 */
export async function fetchManagedRuntimeState(
  instanceId: string,
  deps: ManagedRuntimeDeps = {},
): Promise<string | null> {
  try {
    const status = await fetchRemoteRuntimeStatus(instanceId, deps)
    return status.connectionState
  } catch {
    // Unknown, never a fabricated state.
    return null
  }
}
