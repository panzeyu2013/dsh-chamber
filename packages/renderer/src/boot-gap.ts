/**
 * Settled-boot gap facts and their presentation policy 「降级呈现」。
 * Producers report through the shell's post-settle seam (`chamberReportBootDegraded`):
 * `graph-unavailable` (graph never served in the boot window), `local-graph-not-injected`
 * (LOCAL graph channel 404/method-missing — a chamber installation/seed fact, unlike a
 * gateway/mobile shape whose missing endpoint is legitimate), `required-services-missing`
 * (graph arrived but a first-screen injected service never materialized), and
 * `deferred-registration-failed` (a deferred family never loaded/registered).
 * LEAF (no runtime imports): the fact shape is needed by `shell.ts`, `chamber-entry.ts` and
 * `App.tsx`, and `shell.ts` already imports `host-graph.ts`, so the type cannot live there (cycle).
 * Copy boundary: the frame renders its own sentence from `locales.ts`; the producer's `message`
 * is diagnostic detail, never copy, and the frame never parses it — structured fields are the facts.
 * `BOOT_GAP_POLICY` is a `Record` over the kind union (a missing copy key or retry verdict fails
 * the build); the union itself is owned by `ServerBootGapKind` in client-core, aliased here.
 */

import type {
  ServerBootGap,
  ServerBootGapKind,
} from '@dsh-chamber/dsh-chamber-client-core/aggregate-store'
import { factRecordSignature } from '@dsh-chamber/dsh-chamber-client-core/derive'

/** Why a settled boot is known to be incomplete. */
export type ShellDegradedKind = ServerBootGapKind
/** One settled-boot gap. Only the kind is semantic; every optional field belongs to one kind. */
export interface ShellDegradedFact {
  kind: ShellDegradedKind
  /** The producer's diagnostic line (below the frame): detail, never copy. */
  message: string
  /** `required-services-missing`: the unprovided services, roster order. */
  services?: readonly string[]
  /** `required-services-missing`: registered plugins injecting them, roster order. */
  injectedBy?: readonly string[]
  /** `deferred-registration-failed`: the row ids that never registered. */
  failedIds?: readonly string[]
}

/** The frame dictionary keys this module selects (narrowed so a typo fails here). */
export type BootGapBodyKey =
  | 'bootGap.body.graphUnavailable'
  | 'bootGap.body.localGraphNotInjected'
  | 'bootGap.body.requiredServicesMissing'
  | 'bootGap.body.deferredRegistrationFailed'

/** The frame's manual next-step keys (local vs remote advice, see bootGapNotice). */
export type BootGapManualKey = 'bootGap.action.manual' | 'bootGap.action.manualLocal'

/** One kind's presentation + retry verdict. A new kind MUST add an entry. */
export interface BootGapKindPolicy {
  /** Frame dictionary key of the body sentence for this kind. */
  bodyKey: BootGapBodyKey
  /**
   * Whether one cold re-mount per ready epoch can plausibly change the outcome.
   * All current kinds re-fetch the graph and re-apply the rows (exactly one attempt is worth it);
   * a future kind whose cause a re-boot cannot touch MUST declare `false` here.
   */
  retryable: boolean
}

/** Per-kind verdict table (see the module header for why it is a `Record`). */
export const BOOT_GAP_POLICY: Record<ShellDegradedKind, BootGapKindPolicy> = {
  'graph-unavailable': { bodyKey: 'bootGap.body.graphUnavailable', retryable: true },
  // installation/seed fact: a re-mount re-runs the same graph fetch + journal state — the one cheap attempt that can clear a stale endpoint after a restart.
  'local-graph-not-injected': { bodyKey: 'bootGap.body.localGraphNotInjected', retryable: true },
  'required-services-missing': { bodyKey: 'bootGap.body.requiredServicesMissing', retryable: true },
  'deferred-registration-failed': { bodyKey: 'bootGap.body.deferredRegistrationFailed', retryable: true },
}

/**
 * Whether a cold re-mount is worth attempting for this kind.
 * Indexed WITHOUT a fallback on purpose: the kind is a typed union produced in this same bundle
 * (never parsed from a wire payload), so an unknown kind cannot occur — a loud boundary error beats
 * inventing a cause sentence. Cross-package readers do have generic fallbacks.
 */
export function isRetryableBootGap(kind: ShellDegradedKind): boolean {
  return BOOT_GAP_POLICY[kind].retryable
}

/**
 * Relative CAUSE strength of one kind: `required-services-missing` is the CONSEQUENCE of a missing
 * provider, while the other three name a cause the user can act on. When both are known the single
 * banner slot must show the cause. Distinct by construction and exhaustive over the union.
 */
export function bootGapPriority(kind: ShellDegradedKind): number {
  switch (kind) {
    case 'local-graph-not-injected': return 3
    case 'graph-unavailable': return 2
    case 'deferred-registration-failed': return 1
    case 'required-services-missing': return 0
  }
}

/**
 * Whether an incoming (non-clear) fact may replace the recorded one: same kind always replaces
 * (its payload may have grown), a strictly lower-priority kind never overwrites a still-current
 * higher-priority one. Retraction is unaffected: a clear must match kind AND payload exactly.
 */
export function shouldReplaceBootGap(current: ShellDegradedFact | null, incoming: ShellDegradedFact): boolean {
  if (current === null) return true
  if (current.kind === incoming.kind) return true
  return bootGapPriority(incoming.kind) >= bootGapPriority(current.kind)
}

/**
 * Identity of one fact: same kind AND same payload. `shell.ts` uses this instead of a kind-only
 * comparison, so a richer re-armed verdict is not silently dropped. Field-generic: every payload
 * field takes part and "no payload" (absent / empty array / null / empty string) encodes to nothing.
 * Array order is preserved (roster order is meaningful). `message` is deliberately excluded:
 * both producers derive it deterministically from the same payload, so an identical payload cannot
 * carry a different sentence; non-deterministic host/network text belongs to `pluginDiagnostic`.
 */
export function bootGapSignature(fact: ShellDegradedFact): string {
  return factRecordSignature(fact, ['message'])
}

/**
 * A producer's RETRACTION of a previously reported gap: the named condition no longer holds and the
 * shell must REMOVE the fact instead of keeping a false banner. It rides the SAME seam as the fact
 * (`chamberReportBootDegraded`) and names the EXACT fact it removes (kind + signature), so a
 * richer verdict is never dropped by an older producer's late retraction.
 */
export interface ShellDegradedClear {
  /** Discriminant: a retraction is not a fact (see {@link ShellDegradedReport}). */
  cleared: true
  /** The kind of the fact being retracted. */
  kind: ShellDegradedKind
  /** Signature of the exact fact being retracted ({@link bootGapSignature}). */
  signature: string
}

/** What the shell's degrade seam may carry: a gap fact, or one retraction. */
export type ShellDegradedReport = ShellDegradedFact | ShellDegradedClear

/** Whether the report is a retraction, never a fact (typed, not a field sniff). */
export function isShellDegradedClear(report: ShellDegradedReport): report is ShellDegradedClear {
  return (report as ShellDegradedClear).cleared === true
}

/**
 * Whether `clear` retracts exactly `current`: the KIND stops one producer from clearing another
 * producer's fact (single slot), the SIGNATURE stops a stale retraction from wiping a newer verdict
 * of the same kind.
 */
export function bootGapClearMatchesFact(
  current: ShellDegradedFact | null,
  clear: ShellDegradedClear,
): boolean {
  return current !== null && current.kind === clear.kind && bootGapSignature(current) === clear.signature
}

/** One source's readiness + self-heal marks, as the App knows them at render time. */
export interface BootGapNoticeContext {
  /** The source's current phase (`'ready' | 'starting' | 'error' | …`). */
  phase: string | undefined
  /** The self-heal already re-mounted this source for the CURRENT ready epoch. */
  retried: boolean
  /**
   * The source id the fact belongs to (`'local'` = app-managed instance). The manual next-step copy
   * branches on this STRUCTURED fact, never on the sentence: on Windows the local runtime is a
   * READ-ONLY projection, so local copy must not send the user to "upgrade the dsh runtime".
   */
  instanceId?: string
}

/** Everything the frame needs to render one gap, all of it decided here. */
export interface BootGapNotice {
  bodyKey: BootGapBodyKey
  /** The producer's diagnostic text, rendered verbatim as the detail line. */
  detail: string
  services: readonly string[]
  injectedBy: readonly string[]
  failedIds: readonly string[]
  /** The manual next-step dictionary key for this source (local vs remote advice). */
  manualKey: BootGapManualKey
  /** A retry affordance is worth offering (see {@link BootGapKindPolicy.retryable}). */
  retryable: boolean
  /**
   * The self-heal WILL re-mount this mount, so the copy may promise it: true only while the source
   * is `ready` and the epoch has not retried (the container never fires for a non-ready source).
   */
  autoRetryArmed: boolean
}

/**
 * Build the render decision for one fact. Pure: no copy is produced here — only dictionary keys and
 * structured facts — because the frame renders its own sentences.
 */
export function bootGapNotice(fact: ShellDegradedFact, context: BootGapNoticeContext): BootGapNotice {
  return {
    bodyKey: BOOT_GAP_POLICY[fact.kind].bodyKey,
    detail: fact.message,
    services: fact.services ?? [],
    injectedBy: fact.injectedBy ?? [],
    failedIds: fact.failedIds ?? [],
    retryable: isRetryableBootGap(fact.kind),
    autoRetryArmed: context.phase === 'ready' && !context.retried && isRetryableBootGap(fact.kind),
    // Windows local runtime is a read-only projection (`runtimeManagementSupported=false`): local advice is restart/re-mount/report-diagnostics; remote keeps runtime-alignment wording.
    manualKey: context.instanceId === 'local' ? 'bootGap.action.manualLocal' : 'bootGap.action.manual',
  }
}

/**
 * Project one shell fact onto the cross-package bridge contract, dropping the diagnostic sentence.
 * Fields are always arrays so a consumer never distinguishes absent from empty; the projection
 * signature sorts FIELD order while each ARRAY keeps its meaningful roster order.
 */
export function toServerBootGap(fact: ShellDegradedFact): ServerBootGap {
  return {
    kind: fact.kind,
    services: [...(fact.services ?? [])],
    injectedBy: [...(fact.injectedBy ?? [])],
    failedIds: [...(fact.failedIds ?? [])],
  }
}
