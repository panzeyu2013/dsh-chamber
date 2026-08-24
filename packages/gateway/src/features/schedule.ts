/** Gateway cross-session scheduler, distinct from dsh's session-local schedule. */

import { call, type Logger } from '@dsh-chamber/control-plane'

/** Node clamps larger delays to 1ms, which would turn a far-future job into
 * an immediate prompt. Keep every persisted/runtime timer within libuv's
 * signed 32-bit millisecond range. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647
const ONE_SHOT_RETRY_MIN_MS = 1_000
const ONE_SHOT_RETRY_MAX_MS = 60_000

export interface ScheduledJob {
  id: string
  delayMs: number
  intervalMs: number | null
  targetSessionId: string
  prompt: string
}

export interface Scheduler {
  /** Arm all retained jobs (idempotent). */
  start(): void
  schedule(job: Omit<ScheduledJob, 'id'>): ScheduledJob
  /** Restore an exact persisted identity without minting a replacement id. */
  restore(job: ScheduledJob): ScheduledJob
  cancel(id: string): boolean
  list(): ScheduledJob[]
  /** Stop timers but retain definitions so a dsh reconnect can re-arm them. */
  stop(): void
}

export function createScheduler(deps: {
  getDshBaseUrl(): string | null
  logger: Logger
  callDsh?: typeof call
  /** Used for automatic one-shot removal. Failures are loud in the logger. */
  onJobsChanged?: (jobs: ScheduledJob[]) => Promise<void>
}): Scheduler {
  const jobs = new Map<string, ScheduledJob>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const intervalInFlight = new Set<string>()
  const oneShotInFlight = new Set<string>()
  const oneShotFailures = new Map<string, number>()
  const callDsh = deps.callDsh ?? call
  let running = false
  let runGeneration = 0

  function nextOneShotRetryDelay(id: string): number {
    const attempt = (oneShotFailures.get(id) ?? 0) + 1
    oneShotFailures.set(id, attempt)
    return retryDelay(attempt)
  }

  async function fire(job: ScheduledJob): Promise<boolean> {
    const baseUrl = deps.getDshBaseUrl()
    if (baseUrl === null) {
      deps.logger.warn(`scheduler: job ${job.id} skipped (dsh not ready)`)
      return false
    }
    try {
      await callDsh(baseUrl, 'session.prompt', { sessionId: job.targetSessionId, prompt: job.prompt })
      return true
    } catch (error) {
      deps.logger.warn(`scheduler: job ${job.id} failed: ${String(error)}`)
      return false
    }
  }

  async function completeOneShot(job: ScheduledJob, fireGeneration: number): Promise<void> {
    if (!running || runGeneration !== fireGeneration || jobs.get(job.id) !== job
      || oneShotInFlight.has(job.id)) return
    oneShotInFlight.add(job.id)
    let retryMs: number | undefined
    try {
      const fired = await fire(job)
      // A cancel, replacement, or detach while the RPC was in flight owns the
      // outcome. It must never persist or resurrect this run generation.
      if (!running || runGeneration !== fireGeneration || jobs.get(job.id) !== job) return
      if (!fired) {
        // A readiness gap or transient RPC error must not consume a persisted
        // one-shot. Use a dedicated bounded backoff: reusing delayMs would make
        // a delayMs=0 job spin session.prompt at timer speed forever.
        retryMs = nextOneShotRetryDelay(job.id)
        return
      }
      oneShotFailures.delete(job.id)
      try {
        await deps.onJobsChanged?.([...jobs.values()].filter(current => current !== job))
      } catch (error) {
        deps.logger.warn(`scheduler: failed to persist completion of ${job.id}: ${String(error)}`)
        if (running && runGeneration === fireGeneration && jobs.get(job.id) === job) {
          retryMs = nextOneShotRetryDelay(job.id)
        }
        return
      }
      // cancel() may have won while persistence was in flight. delete(key,
      // identity) is emulated explicitly so an id reused by a newer generation
      // is never consumed by this callback.
      if (jobs.get(job.id) === job) jobs.delete(job.id)
    } finally {
      oneShotInFlight.delete(job.id)
      const current = jobs.get(job.id)
      if (!running || current === undefined || timers.has(job.id)) return
      if (current !== job || runGeneration !== fireGeneration) {
        arm(current)
      } else if (retryMs !== undefined) {
        arm(current, retryMs)
      }
    }
  }

  function scheduleTimer(job: ScheduledJob, delayMs: number, callback: (generation: number) => void): void {
    if (!running || jobs.get(job.id) !== job || timers.has(job.id)) return
    const timerGeneration = runGeneration
    const timer = setTimeout(() => {
      if (timers.get(job.id) !== timer) return
      timers.delete(job.id)
      if (!running || runGeneration !== timerGeneration || jobs.get(job.id) !== job) return
      callback(timerGeneration)
    }, delayMs)
    timers.set(job.id, timer)
  }

  async function fireInterval(job: ScheduledJob, fireGeneration: number): Promise<void> {
    if (!running || runGeneration !== fireGeneration || jobs.get(job.id) !== job
      || intervalInFlight.has(job.id)) return
    intervalInFlight.add(job.id)
    try {
      await fire(job)
    } finally {
      intervalInFlight.delete(job.id)
      const current = jobs.get(job.id)
      if (!running || current === undefined || timers.has(job.id)) return
      if (current !== job || runGeneration !== fireGeneration || current.intervalMs === null) {
        arm(current)
        return
      }
      // Fixed-delay recursion, rather than setInterval, guarantees that a
      // slow session.prompt cannot overlap the next invocation.
      scheduleTimer(current, current.intervalMs, generation => { void fireInterval(current, generation) })
    }
  }

  function arm(job: ScheduledJob, initialDelayMs = job.delayMs): void {
    if (!running || jobs.get(job.id) !== job || timers.has(job.id)) return
    if (job.intervalMs === null) {
      if (oneShotInFlight.has(job.id)) return
      scheduleTimer(job, initialDelayMs, generation => { void completeOneShot(job, generation) })
      return
    }
    // A prompt that began before a detach may still be settling. Its finally
    // path re-arms the retained definition after reattach.
    if (intervalInFlight.has(job.id)) return
    scheduleTimer(job, job.delayMs, generation => { void fireInterval(job, generation) })
  }

  function put(job: ScheduledJob): ScheduledJob {
    if (jobs.has(job.id)) throw new Error(`scheduler: duplicate job id ${job.id}`)
    if (!isTimerDelay(job.delayMs)
      || (job.intervalMs !== null && (!isTimerDelay(job.intervalMs) || job.intervalMs < 1_000))) {
      throw new RangeError(`scheduler: timer delay must be between 0 and ${MAX_TIMER_DELAY_MS}ms`)
    }
    jobs.set(job.id, job)
    arm(job)
    return job
  }

  return {
    start(): void {
      if (running) return
      runGeneration += 1
      running = true
      for (const job of jobs.values()) arm(job)
    },
    schedule(input: Omit<ScheduledJob, 'id'>): ScheduledJob {
      return put({ id: `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, ...input })
    },
    restore(job: ScheduledJob): ScheduledJob {
      // A corrupted/duplicated persisted schedule (hand-edited schedule.json
      // with repeated ids) must not veto gateway startup — one bad job is
      // not a corrupt store document. Keep the first definition, warn and
      // skip the duplicate.
      if (jobs.has(job.id)) {
        deps.logger.warn(`scheduler: duplicate persisted job id ${job.id}; keeping the first definition`)
        return job
      }
      return put({ ...job })
    },
    cancel(id: string): boolean {
      const timer = timers.get(id)
      if (timer !== undefined) clearTimeout(timer)
      timers.delete(id)
      oneShotFailures.delete(id)
      return jobs.delete(id)
    },
    list(): ScheduledJob[] {
      return [...jobs.values()]
    },
    stop(): void {
      if (!running && timers.size === 0) return
      running = false
      runGeneration += 1
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
    },
  }
}

function isTimerDelay(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= MAX_TIMER_DELAY_MS
}

function retryDelay(attempt: number): number {
  return Math.min(ONE_SHOT_RETRY_MAX_MS, ONE_SHOT_RETRY_MIN_MS * (2 ** Math.min(attempt - 1, 16)))
}
