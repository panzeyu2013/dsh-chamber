/**
 * Facts authority — the ONE owner of "which plane may speak for a source's
 * session-facts capability" (design 19 §3.5).
 *
 * While a mounted shell's runtime producer owns a source's runtime facts
 * (factsStore.runtime[id] present and not stale), the no-shell observer's
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

/** True when the mounted shell's runtime producer currently owns this source's
 *  live facts. `stale` means the residual row is read-only history, so the
 *  no-shell observer is authoritative again. */
export function producerOwnsSessionFacts(runtime: InstanceRuntimeReport | undefined): boolean {
  return runtime !== undefined && runtime.stale !== true
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
