/**
 * Managed-dsh state projection for gateway sources (design 17 §2, problem B).
 *
 * A gateway source's desktop `ready` only proves the GATEWAY PROCESS is alive:
 * the readiness probe reads `/chamber/runtime/status` (the endpoint exists
 * precisely because the managed dsh is a separate process). The sidebar
 * consumes the tunnel phase, so a stopped/crashed managed dsh used to leave the
 * source fully interactive — its `+`/new-session entry clickable, its rows
 * frozen on the last pushed aggregate — with no degraded projection. This
 * module reads the connectionState the status route already carries and
 * classifies it; the App folds the result into the source's `phase` (the
 * sidebar's existing status dot already renders these states with localized
 * labels) and into `connected` (so actions are disabled instead of failing).
 */
import { fetchRemoteRuntimeStatus } from './gateway-runtime.ts'

/** Managed-dsh states that make the source unusable until it comes back. */
export const MANAGED_RUNTIME_DOWN_STATES = ['stopped', 'error', 'restart-exhausted'] as const

/**
 * Transient managed states that are also NOT usable for a background mount: the
 * shell would boot against a dsh that is not serving yet (gateway 503). Only
 * meaningful once the transport itself is usable — the caller gates that.
 */
export const MANAGED_RUNTIME_TRANSIENT_STATES = ['starting', 'restarting'] as const

/**
 * Whether a managed-dsh state can never serve a boot right now: terminal-down
 * OR transiently starting/restarting (2026-12 review MINOR — harvesting a
 * starting gateway burns one of only two attempts against 503s).
 * @param state - Probed managed runtime state (null = probe missing/failed).
 * @returns True when a background mount must not be attempted.
 */
export function managedRuntimeUnusable(state: string | null | undefined): boolean {
  if (managedRuntimeDown(state)) return true
  return state !== null && state !== undefined
    && (MANAGED_RUNTIME_TRANSIENT_STATES as readonly string[]).includes(state)
}

/**
 * Whether a gateway's managed dsh is in a terminal-down state. Absent or
 * unknown states FAIL OPEN — a missing probe (older gateway, proxy failure,
 * transport down) must never hide a healthy source.
 * @param state - `connectionState` from `/chamber/runtime/status`, or null/undefined when unavailable.
 * @returns True only for an explicit terminal-down state.
 */
export function managedRuntimeDown(state: string | null | undefined): boolean {
  return typeof state === 'string' && (MANAGED_RUNTIME_DOWN_STATES as readonly string[]).includes(state)
}

export interface ManagedRuntimeDeps {
  /** Fetch implementation (tests inject a fake). */
  fetchImpl?: typeof fetch
  /** Abort signal owned by the caller's effect. */
  signal?: AbortSignal
}

/**
 * Read one gateway source's managed-dsh connectionState through the
 * per-instance proxy. Delegates to the canonical runtime-status reader
 * (`gateway-runtime.ts`, which owns the `/chamber/runtime/status` route shape
 * and the `gateway-<id>` id validation) and never throws: a transport failure,
 * abort, invalid id, a non-200 (e.g. the control plane's explicit 503 for a
 * dead tunnel), or a malformed body all resolve to null, which the caller
 * treats as "unknown, fail open".
 * @param instanceId - Source id (`/api/i/<id>` proxy key).
 * @param deps - Injectable fetch and abort signal.
 * @returns The reported connectionState, or null when it cannot be read.
 */
export async function fetchManagedRuntimeState(
  instanceId: string,
  deps: ManagedRuntimeDeps = {},
): Promise<string | null> {
  try {
    const status = await fetchRemoteRuntimeStatus(instanceId, deps)
    return status.connectionState
  } catch {
    // Transport failure, abort, invalid instance id, or a non-200 status:
    // unknown, never a fabricated state.
    return null
  }
}
