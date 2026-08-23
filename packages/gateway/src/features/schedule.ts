/**
 * Cron scheduler (design 16 §8.4): the gateway's cross-session recurring
 * trigger, distinct from dsh's own `ctx.schedule` (which is a session-local
 * follow-up). A fired job runs `session.prompt` on a target session through
 * dsh `/api`. MVP uses Node timers; a cron-expression parser is post-MVP.
 */

import { call, type Logger } from '@dsh-chamber/control-plane'

export interface ScheduledJob {
  id: string
  /** Delay before the first run (ms). */
  delayMs: number
  /** Repeat interval (ms); null = one-shot. */
  intervalMs: number | null
  targetSessionId: string
  prompt: string
}

export interface Scheduler {
  schedule(job: Omit<ScheduledJob, 'id'>): ScheduledJob
  cancel(id: string): boolean
  list(): ScheduledJob[]
  /** Dispose all timers (gateway stop). */
  stop(): void
}

export function createScheduler(deps: {
  getDshBaseUrl(): string | null
  logger: Logger
}): Scheduler {
  const jobs = new Map<string, ScheduledJob>()
  const timers = new Map<string, ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>>()

  async function fire(job: ScheduledJob): Promise<void> {
    const baseUrl = deps.getDshBaseUrl()
    if (baseUrl === null) {
      deps.logger.warn(`scheduler: job ${job.id} skipped (dsh not ready)`)
      return
    }
    try {
      await call(baseUrl, 'session.prompt', { sessionId: job.targetSessionId, prompt: job.prompt })
    } catch (error) {
      deps.logger.warn(`scheduler: job ${job.id} failed: ${String(error)}`)
    }
  }

  function arm(job: ScheduledJob): void {
    if (job.intervalMs === null) {
      const t = setTimeout(() => {
        void fire(job)
        jobs.delete(job.id)
        timers.delete(job.id)
      }, job.delayMs)
      timers.set(job.id, t)
    } else {
      const t = setTimeout(() => {
        void fire(job)
        const interval = setInterval(() => void fire(job), job.intervalMs as number)
        timers.set(job.id, interval)
      }, job.delayMs)
      timers.set(job.id, t)
    }
  }

  return {
    schedule(input: Omit<ScheduledJob, 'id'>): ScheduledJob {
      const job: ScheduledJob = { id: `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, ...input }
      jobs.set(job.id, job)
      arm(job)
      return job
    },
    cancel(id: string): boolean {
      const timer = timers.get(id)
      if (timer !== undefined) clearTimeout(timer as ReturnType<typeof setTimeout>)
      timers.delete(id)
      return jobs.delete(id)
    },
    list(): ScheduledJob[] {
      return [...jobs.values()]
    },
    stop(): void {
      for (const timer of timers.values()) clearTimeout(timer as ReturnType<typeof setTimeout>)
      timers.clear()
      jobs.clear()
    },
  }
}
