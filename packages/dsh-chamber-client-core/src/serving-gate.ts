/**
 * Wait-for-serving gate for a source's client plugin graph: a cold-started
 * instance answers `clientGraph/graph` with `503 instance_unavailable` (the
 * proxy refuses to forward until the managed dsh serves), so callers wait
 * instead of losing the profile's plugin set. The wait is bounded and gives up
 * fast for a terminally down (`error`/`stopped`/`restart-exhausted`) or absent
 * source — those must surface the real reason.
 */

import { chamberBridge } from './aggregate-store.ts'
import { pollUntil, sleepMs } from './poll.ts'

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
  pollMs?: number
  /** Projection read seam (defaults to the page-level chamberBridge store). */
  getSources?: () => readonly ServingGateSource[]
  sleep?: (ms: number) => Promise<void>
}

const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_POLL_MS = 250
function readSources(options: ServingGateOptions): readonly ServingGateSource[] {
  if (options.getSources !== undefined) return options.getSources()
  return chamberBridge.getServers()
}

/** Resolve true as soon as the source is serving (connected); false when the deadline passes or
 *  it is absent/terminally down. @param sourceId - the projection id. */
export async function waitForSourceServing(
  sourceId: string,
  options: ServingGateOptions = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS
  const sleep = options.sleep ?? sleepMs
  const deadline = Date.now() + timeoutMs
  // The deadline is tested AFTER the connect/terminal decision, so even a zero
  // remaining budget still probes once.
  const verdict = await pollUntil<boolean | undefined, boolean>({
    intervalMs: pollMs,
    sleep,
    probe: () => {
      const source = readSources(options).find(candidate => candidate.id === sourceId)
      if (source === undefined) return false
      if (source.connected) return true
      return TERMINAL_PHASES.has(source.phase) ? false : undefined
    },
    classify: (state) => state !== undefined
      ? { kind: 'done', value: state }
      : Date.now() >= deadline
        ? { kind: 'done', value: false }
        : { kind: 'retry' },
  })
  return verdict === true
}
