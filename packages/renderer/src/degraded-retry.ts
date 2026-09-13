/**
 * Degraded-boot self-heal (2026-09-10, sidebarRight 彻底修复).
 *
 * A boot that settled with `ShellState.degraded` set is a mount whose known
 * gap cannot fix itself: the entry was constructed without the profile's
 * client plugins (or without a service the composite's first screen injects),
 * and cordis fibers that pend on a missing service have no timeout. The ONLY
 * remedy is a fresh boot once the source actually serves — the same thing a
 * manual page reload did, which used to be the only recovery.
 *
 * This module owns the decision, kept pure so the App's effect stays a thin
 * adapter: retry a degraded mount when its source is `ready`, at most ONCE per
 * ready epoch. Marks are dropped while the source is not ready, so a later
 * ready transition (a restart) earns a fresh attempt — and a mount that stays
 * degraded across a successful retry is left alone instead of looping.
 *
 * Retryability is the FACT'S call, not this module's (2026-12 review): each
 * kind declares its verdict in `boot-gap.ts` (`BOOT_GAP_POLICY[kind].retryable`),
 * so a future kind whose cause a cold re-mount cannot touch is skipped here
 * instead of paying one futile re-mount per ready epoch. Kinds are carried in,
 * never inferred from the instance id.
 */

import { isRetryableBootGap, type ShellDegradedKind } from './boot-gap.ts'

/** One degraded mount: which instance, and WHY it is degraded. */
export interface DegradedMountFact {
  /** Instance id whose settled state carries a gap fact. */
  instanceId: string
  /** The gap's kind (selects the retryability verdict). */
  kind: ShellDegradedKind
}

/** One instance's degrade + readiness facts. */
export interface DegradedRetryFacts {
  /** Mounts whose settled state carries a gap fact. */
  degraded: readonly DegradedMountFact[]
  /** Instance id → current source phase (App projection: 'ready' | 'starting' | …). */
  phaseOf: (instanceId: string) => string | undefined
  /** Instance id → already auto-retried for the CURRENT ready epoch. */
  retried: Readonly<Record<string, boolean>>
}

/** What the App should do now, plus the marks to carry into the next pass. */
export interface DegradedRetryPlan {
  /** Instance ids to re-boot (sorted, stable for tests). */
  retry: string[]
  /** Marks for the next pass (ids that are degraded + ready + already retried). */
  retried: Record<string, boolean>
}

/**
 * Plan the auto-retries for one App pass.
 * @param facts - the degraded mounts, the live phase projection and the marks.
 * @returns the instances to re-boot and the marks to keep.
 */
export function planDegradedRetries(facts: DegradedRetryFacts): DegradedRetryPlan {
  const retry: string[] = []
  const retried: Record<string, boolean> = {}
  // The mark belongs to the READY EPOCH, not to the degrade fact: a re-boot
  // resets the mount to idle (degraded: null) for a moment, and dropping the
  // mark there would let a mount that degrades AGAIN re-trigger — an endless
  // re-boot loop against a source that answers ready but never serves its
  // graph. Keep the mark while the source still serves; drop it the moment the
  // source leaves ready (that transition is what earns a fresh attempt).
  for (const instanceId of Object.keys(facts.retried)) {
    if (facts.phaseOf(instanceId) === 'ready') retried[instanceId] = true
  }
  for (const fact of facts.degraded) {
    // A kind a re-boot cannot plausibly fix never earns a re-mount, and it
    // never earns a MARK either: the next pass may see a different kind on the
    // same instance and must judge that one on its own.
    if (!isRetryableBootGap(fact.kind)) continue
    if (facts.phaseOf(fact.instanceId) !== 'ready') continue
    if (retried[fact.instanceId] === true) continue
    retry.push(fact.instanceId)
    retried[fact.instanceId] = true
  }
  return { retry: retry.sort(), retried }
}
