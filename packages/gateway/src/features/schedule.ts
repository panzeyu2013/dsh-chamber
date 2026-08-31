/** Gateway cross-session scheduler, distinct from dsh's session-local schedule. */

import { randomUUID } from 'node:crypto'
import { RpcBusinessError, call, type Logger } from '@dsh-chamber/control-plane'

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
  /** Add a definition without arming it. The persistence owner must durably
   * commit the returned identity before calling commit(). */
  admit(job: Omit<ScheduledJob, 'id'>): ScheduledJob
  /** Arm one admitted identity after its durable commit. */
  commit(job: ScheduledJob): boolean
  /** Convenience for in-process callers that do not need a durable admission
   * transaction: admit and arm immediately. */
  schedule(job: Omit<ScheduledJob, 'id'>): ScheduledJob
  /** Restore an exact persisted identity without minting a replacement id. */
  restore(job: ScheduledJob): ScheduledJob
  cancel(id: string): boolean
  list(): ScheduledJob[]
  /** Stop timers but retain definitions so a dsh reconnect can re-arm them. */
  stop(): void
}

export interface ScheduleRemovalIntent {
  /** Exact in-memory identity being removed. An id reused by a newer job must
   * survive this mutation. */
  readonly job: ScheduledJob
  /** Successful one-shots require a durable deletion; deterministic dsh
   * rejections are terminal and commit memory removal even if persistence is
   * unavailable. */
  readonly persistence: 'required' | 'best-effort'
  /** Commit the in-memory removal. The persistence owner calls this inside
   * its serialization critical section, after the durable mutation (or in a
   * best-effort finally block), so a queued writer cannot snapshot stale
   * state between persistence and the memory commit. */
  commit(): boolean
}

export function createScheduler(deps: {
  getDshBaseUrl(): string | null
  logger: Logger
  callDsh?: typeof call
  /** Used for automatic one-shot removal. The owner applies this mutation
   * intent against its current list inside the persistence serializer. */
  onJobRemoval?: (intent: ScheduleRemovalIntent) => Promise<void>
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

  function commitRemoval(job: ScheduledJob): boolean {
    if (jobs.get(job.id) !== job) return false
    const timer = timers.get(job.id)
    if (timer !== undefined) clearTimeout(timer)
    timers.delete(job.id)
    oneShotFailures.delete(job.id)
    return jobs.delete(job.id)
  }

  async function removeJob(job: ScheduledJob, persistence: ScheduleRemovalIntent['persistence']): Promise<void> {
    if (deps.onJobRemoval === undefined) {
      commitRemoval(job)
      return
    }
    const intent: ScheduleRemovalIntent = {
      job,
      persistence,
      commit: () => commitRemoval(job),
    }
    await deps.onJobRemoval(intent)
    // A required persistence callback must also commit the matching memory
    // identity before releasing its serialization lock. Otherwise retry
    // rather than falsely consuming a still-live one-shot.
    if (persistence === 'required' && jobs.get(job.id) === job) {
      throw new Error(`scheduler: persistence callback did not commit removal of ${job.id}`)
    }
  }

  /** A deterministic dsh business rejection (`result.ok === false` — target
   * session deleted, payload refused, …) can never succeed on retry. Remove
   * the job, persisting the removal best-effort, and clear its failure state.
   * Distinct from transient carrier failures, which keep the retry backoff. */
  async function terminateJob(job: ScheduledJob, error: RpcBusinessError): Promise<void> {
    oneShotFailures.delete(job.id)
    deps.logger.error(
      `scheduler: job ${job.id} terminated after a deterministic dsh rejection (${error.code}: ${error.message})`,
    )
    try {
      await removeJob(job, 'best-effort')
    } catch (persistError) {
      deps.logger.warn(`scheduler: failed to persist termination of ${job.id}: ${String(persistError)}`)
    } finally {
      // Production persistence commits this in its serialized finally block;
      // retain the terminal behavior if a custom callback failed before doing
      // so. Identity fencing protects a newer replacement.
      commitRemoval(job)
    }
  }

  async function fire(job: ScheduledJob): Promise<boolean> {
    const baseUrl = deps.getDshBaseUrl()
    if (baseUrl === null) {
      deps.logger.warn(`scheduler: job ${job.id} skipped (dsh not ready)`)
      return false
    }
    try {
      // dsh 0.1.2-alpha.1 wire: session/prompt payload = {requestId,
      // sessionId, mode: 'queue'|'steer', content: MessagePart[]} — the old
      // 0.1.1-rc.2 {sessionId, mode, content} shape (without requestId) was
      // rejected with "invalid payload for session/prompt" and every scheduled
      // prompt failed validation (live finding, Linux + macOS, verified
      // against the real wire; unchanged through 0.1.2-alpha.2). requestId is
      // client-minted, persisted in the
      // user message and echoed back on SessionQueuedItem.rpcId; the response
      // `command?` slot was removed (the chamber scheduler never consumed it).
      await callDsh(baseUrl, 'session/prompt', {
        args: { request: {
          requestId: randomUUID(),
          sessionId: job.targetSessionId,
          mode: 'queue',
          content: [{ type: 'text', text: job.prompt }],
        } },
      })
      return true
    } catch (error) {
      if (error instanceof RpcBusinessError) {
        // Deterministic rejection: the caller terminates the job. Only this
        // error type escapes fire(); everything else is transient.
        throw error
      }
      deps.logger.warn(`scheduler: job ${job.id} failed transiently: ${String(error)}`)
      return false
    }
  }

  async function completeOneShot(job: ScheduledJob, fireGeneration: number): Promise<void> {
    if (!running || runGeneration !== fireGeneration || jobs.get(job.id) !== job
      || oneShotInFlight.has(job.id)) return
    oneShotInFlight.add(job.id)
    let retryMs: number | undefined
    try {
      let fired: boolean
      try {
        fired = await fire(job)
      } catch (error) {
        if (error instanceof RpcBusinessError) {
          // stop()/detach or an identity replacement while session.prompt was
          // in flight owns the late verdict. It must not delete/persist a job
          // from the stopped generation.
          if (!running || runGeneration !== fireGeneration || jobs.get(job.id) !== job) return
          await terminateJob(job, error)
          return
        }
        // Defensive: fire() only rethrows RpcBusinessError. Treat anything
        // else as transient and keep the bounded backoff.
        deps.logger.warn(`scheduler: job ${job.id} failed transiently: ${String(error)}`)
        retryMs = nextOneShotRetryDelay(job.id)
        return
      }
      // A cancel, replacement, or detach while the RPC was in flight owns the
      // outcome. It must never persist or resurrect this run generation.
      if (!running || runGeneration !== fireGeneration || jobs.get(job.id) !== job) return
      if (!fired) {
        // A readiness gap or transient RPC error must not consume a persisted
        // one-shot. Use a dedicated bounded backoff: reusing delayMs would make
        // a delayMs=0 job spin session/prompt at timer speed forever.
        retryMs = nextOneShotRetryDelay(job.id)
        return
      }
      oneShotFailures.delete(job.id)
      try {
        await removeJob(job, 'required')
      } catch (error) {
        deps.logger.warn(`scheduler: failed to persist completion of ${job.id}: ${String(error)}`)
        if (running && runGeneration === fireGeneration && jobs.get(job.id) === job) {
          retryMs = nextOneShotRetryDelay(job.id)
        }
        return
      }
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
      try {
        await fire(job)
      } catch (error) {
        if (error instanceof RpcBusinessError) {
          // The business error belongs to the generation that issued the RPC.
          // A stop/restart or replacement during the await keeps the retained
          // definition and must not persist a late terminal removal.
          if (!running || runGeneration !== fireGeneration || jobs.get(job.id) !== job) return
          // A deterministic rejection stops the interval: retrying the same
          // prompt at the fixed cadence can never succeed.
          await terminateJob(job, error)
          return
        }
        // Defensive: fire() only rethrows RpcBusinessError. A transient
        // failure keeps the interval cadence.
        deps.logger.warn(`scheduler: interval job ${job.id} failed transiently: ${String(error)}`)
      }
    } finally {
      intervalInFlight.delete(job.id)
      const current = jobs.get(job.id)
      if (!running || current === undefined || timers.has(job.id)) return
      if (current !== job || runGeneration !== fireGeneration || current.intervalMs === null) {
        arm(current)
        return
      }
      // Fixed-delay recursion, rather than setInterval, guarantees that a
      // slow session/prompt cannot overlap the next invocation.
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

  function put(job: ScheduledJob, shouldArm = true): ScheduledJob {
    if (jobs.has(job.id)) throw new Error(`scheduler: duplicate job id ${job.id}`)
    if (!isTimerDelay(job.delayMs)
      || (job.intervalMs !== null && (!isTimerDelay(job.intervalMs) || job.intervalMs < 1_000))) {
      throw new RangeError(`scheduler: timer delay must be between 0 and ${MAX_TIMER_DELAY_MS}ms`)
    }
    jobs.set(job.id, job)
    if (shouldArm) arm(job)
    return job
  }

  function createJob(input: Omit<ScheduledJob, 'id'>): ScheduledJob {
    return { id: `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, ...input }
  }

  return {
    start(): void {
      if (running) return
      runGeneration += 1
      running = true
      for (const job of jobs.values()) arm(job)
    },
    admit(input: Omit<ScheduledJob, 'id'>): ScheduledJob {
      return put(createJob(input), false)
    },
    commit(job: ScheduledJob): boolean {
      if (jobs.get(job.id) !== job) return false
      arm(job)
      return true
    },
    schedule(input: Omit<ScheduledJob, 'id'>): ScheduledJob {
      return put(createJob(input))
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
