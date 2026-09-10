/**
 * Wait-for-serving gate for a source's client plugin graph (2026-09-10,
 * design 09 §3.2).
 *
 * A cold-started instance answers `clientGraph/graph` with
 * `503 instance_unavailable` (the reverse proxy refuses to forward while the
 * managed dsh is not serving yet). The shell's boot fetch waits for the source
 * instead of losing the profile's whole client-plugin set (renderer
 * host-graph `waitForServing`); the settings bridge reads the SAME graph for
 * its contributions and used to publish `unavailable` on the first cold
 * answer, which told the user the graph was unreachable when the instance was
 * merely still starting.
 *
 * The wait is bounded, and it never waits for a source that is terminally
 * down (`error`/`stopped`/`restart-exhausted`) or absent: those must fail fast
 * with the real reason instead of holding the panel for a minute.
 */

import { chamberBridge } from './aggregate-store.ts'

/** The projection slice this gate needs (structurally satisfied by the store). */
export interface ServingGateSource {
  id: string
  phase: string
  connected: boolean
}

/** Phases that mean "no amount of waiting will make this source serve". */
const TERMINAL_PHASES = new Set(['error', 'stopped', 'restart-exhausted'])

export interface ServingGateOptions {
  /** Bounded wait; defaults to the shell's 60s boot budget. */
  timeoutMs?: number
  /** Poll interval (default 250ms). */
  pollMs?: number
  /** Projection read seam (defaults to the page-level chamberBridge store). */
  getSources?: () => readonly ServingGateSource[]
  /** Sleep seam (tests). */
  sleep?: (ms: number) => Promise<void>
}

const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_POLL_MS = 250
const realSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

function readSources(options: ServingGateOptions): readonly ServingGateSource[] {
  if (options.getSources !== undefined) return options.getSources()
  return chamberBridge.getServers()
}

/**
 * Resolve true as soon as the source is serving (connected), false when the
 * deadline passes, the source is absent, or it is terminally down.
 * @param sourceId - the projection id ('local' | '<kind>-<id>').
 * @param options - bounded-wait + seam overrides.
 */
export async function waitForSourceServing(
  sourceId: string,
  options: ServingGateOptions = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS
  const sleep = options.sleep ?? realSleep
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const source = readSources(options).find(candidate => candidate.id === sourceId)
    if (source === undefined) return false
    if (source.connected) return true
    if (TERMINAL_PHASES.has(source.phase)) return false
    if (Date.now() >= deadline) return false
    await sleep(pollMs)
  }
}

/**
 * Whether a client-graph read failure is the cold-start window rather than a
 * real failure (2026-09-10, design 09 §3.2): the reverse proxy answers
 * `instance_unavailable` / `dsh_not_ready` while the managed dsh is still
 * coming up, and ONLY that class is worth waiting for. Anything else — a
 * missing method, an auth gate, a version conflict — must surface unchanged.
 */
export function isServingWindowFailure(error: { code?: string; message?: string }): boolean {
  const text = `${error.code ?? ''} ${error.message ?? ''}`
  return /instance_unavailable|dsh_not_ready|instance not ready|503/i.test(text)
}
