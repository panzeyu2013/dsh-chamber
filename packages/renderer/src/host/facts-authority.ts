/**
 * Facts authority — the ONE owner of "which plane may speak for a source's
 * session-facts capability" (design 19 §3.5).
 *
 * While a mounted shell's runtime producer owns a source's runtime facts
 * (factsStore.runtime[id] present, the source's own transport connected, the
 * report not stale, and the report FRESH — its receipt age bounds producer
 * authority; design 19 §3.5 "producer 在位无年龄上界"), the no-shell observer's
 * transient `degraded` capability mode must not be projected as the source's
 * capability. The observer's failure can be a page-local artefact — its 5s
 * baseline can expire while queued in chamber's dispatch budget or behind
 * connection-pool pressure — and the mounted producer is the authority.
 *
 * `full` / `legacy` / `disabled` are capability/version facts orthogonal to
 * producer liveness and pass through unchanged; a producer-owned source's unknown
 * mode is never filled in as `full` on the observer's behalf.
 *
 * Pure, framework-free leaf: no store reads, no timers, no React.
 */
import type { InstanceRuntimeReport } from '@dsh-chamber/dsh-chamber-client-core'
import type { SourceSessionFactsMode } from '../session-facts-mode.ts'

/**
 * Producer authority upper bound (wall clock ms). The mounted producer re-reports on
 * every sessions/workspaces store change and on each authority-tick settle; a report
 * older than this bound means the producer stopped reporting WITHOUT a teardown (a
 * hung shell whose runtime row was never cleared), so its row is last-known state and
 * must not suppress the observer forever. Calibration item: the real restoration
 * delay is measured long-run (STATUS §1.1); the bound is deliberately loose (5 × the
 * 60s boot budget order) so a quiet-but-alive producer keeps authority.
 */
const PRODUCER_AUTHORITY_MAX_AGE_MS = 5 * 60_000

/** True when the mounted shell's runtime producer currently owns this source's
 *  live facts. Three decay conditions hand authority back to the no-shell observer:
 *  the report's own `stale` bit (a residual row is read-only history), a
 *  disconnected source (the producer cannot be delivering facts through a dead
 *  transport — its row is last-known state, not live evidence), and an aged report
 *  (the producer stopped reporting without a teardown; absent/non-finite receipt time
 *  = age unknown, which never counts as fresh authority). */
export function producerOwnsSessionFacts(
  runtime: InstanceRuntimeReport | undefined,
  sourceConnected: boolean,
  now: number = Date.now(),
): boolean {
  if (runtime === undefined || !sourceConnected || runtime.stale === true) return false
  const reportedAt = runtime.reportedAt
  if (typeof reportedAt !== 'number' || !Number.isFinite(reportedAt) || reportedAt <= 0) return false
  return now - reportedAt <= PRODUCER_AUTHORITY_MAX_AGE_MS
}

/** Apply the authority gate to a projected capability mode. Only the STALE carrier
 *  shape is suppressed (mapped to `undefined` = unknown), never replaced by `full`.
 *  A fresh degraded snapshot (e.g. 2xx with serviceable=false) is a source fact. */
export function presentedSessionFactsMode(
  mode: SourceSessionFactsMode | undefined,
  snapshot: { readonly stale?: boolean; readonly degradation?: string | null } | undefined,
  producerOwns: boolean,
): SourceSessionFactsMode | undefined {
  if (mode !== 'degraded' || !producerOwns) return mode
  // Unknown snapshot: keep the old conservative suppression.
  if (snapshot === undefined) return undefined
  // Only the stale carrier shape (page queue, silence, 5xx) is transient. Version
  // facts (unversioned / forward-skew / watcher-disabled) pass regardless.
  if (snapshot.stale === true
    && (snapshot.degradation === undefined || snapshot.degradation === null || snapshot.degradation === 'unavailable')) {
    return undefined
  }
  return mode
}
