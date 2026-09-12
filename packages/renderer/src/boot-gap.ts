/**
 * Settled-boot gap facts and their presentation policy (2026-12, design 05 §4
 * 「降级呈现」/ design 09 §3.2).
 *
 * A shell can settle SUCCESSFULLY while a whole surface is missing. Three
 * producers know such a gap, and all three reach the App through the shell's
 * post-settle seam (`chamberReportBootDegraded`):
 *
 *  - `graph-unavailable`: the source never served its client plugin graph
 *    inside the boot window, so this entry runs without the profile's client
 *    plugins;
 *  - `required-services-missing`: the graph arrived but a service the
 *    composite's first screen injects never materialized (the classic one is
 *    `ui-chat` pending on `sidebarRight`, which leaves the conversation view
 *    unregistered while the boot still reports success);
 *  - `deferred-registration-failed`: a deferred plugin family's chunk never
 *    loaded or registered, so the slots/services it declares stay absent.
 *
 * Until 2026-12 those facts had NO user surface: `ShellState.degraded` reached
 * `console` and the once-per-ready-epoch self-heal only, and the OTHER visible
 * channel (the connections page's `pluginDiagnostic`) legitimately reported
 * `ok` in the motivating case — the graph channel itself answered fine, it was
 * the service that never materialized. The user therefore saw a session title
 * next to an empty conversation body with no error anywhere.
 *
 * Why this module is a LEAF (no runtime imports): `shell.ts` (fact carrier),
 * `chamber-entry.ts` (producers) and `App.tsx` (renderer) all need the fact
 * shape, and `shell.ts` already imports `host-graph.ts` — putting the type in
 * either would create a cycle. The TYPE-only import below is erased by the
 * type stripper, so plain-node tests still load this module standalone.
 *
 * Two disciplines live here:
 *
 *  - **Copy boundary** (STATUS「跨边界诊断文案」): the frame renders the
 *    sentence from its own typed dictionary (`locales.ts`); the producer's raw
 *    `message` is a DIAGNOSTIC line shown as detail, never the copy. The
 *    structured fields (`services`/`injectedBy`/`failedIds`) are the producer's
 *    facts; the frame never parses the message to recover them.
 *  - **Per-kind verdict table**: {@link BOOT_GAP_POLICY} is a `Record` over the
 *    kind union, so a new kind that does not declare its copy key AND its retry
 *    verdict fails the build instead of silently inheriting a wrong sentence or
 *    burning a futile cold re-mount (`planDegradedRetries` reads
 *    {@link isRetryableBootGap}).
 *
 * The kind union itself is OWNED by the sidebar's shared bridge contract
 * (`ServerBootGapKind`, next to `PluginGraphDiagnostic`): the same vocabulary
 * crosses to the sidebar package and to the connections page, which render
 * their own copy — one definition, aliased here.
 */

import type {
  ServerBootGap,
  ServerBootGapKind,
} from '../../dsh-chamber-client-ui-sidebar/src/shared/aggregate-store.ts'

/** Why a settled boot is known to be incomplete. */
export type ShellDegradedKind = ServerBootGapKind
/**
 * One settled-boot gap. Only the kind is semantic; the rest is structured
 * evidence, and every optional field belongs to exactly one kind.
 */
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
  | 'bootGap.body.requiredServicesMissing'
  | 'bootGap.body.deferredRegistrationFailed'

/** One kind's presentation + retry verdict. A new kind MUST add an entry. */
export interface BootGapKindPolicy {
  /** Frame dictionary key of the body sentence for this kind. */
  bodyKey: BootGapBodyKey
  /**
   * Whether one cold re-mount per ready epoch can plausibly change the outcome.
   * All three current kinds re-fetch the graph and re-apply the rows, so all
   * three are worth exactly one attempt. A future kind whose cause a re-boot
   * cannot touch (e.g. a hard graph-channel rejection) MUST declare `false`
   * here: `planDegradedRetries` then leaves it alone instead of paying a cold
   * re-mount per ready epoch for a guaranteed no-op.
   */
  retryable: boolean
}

/** Per-kind verdict table (see the module header for why it is a `Record`). */
export const BOOT_GAP_POLICY: Record<ShellDegradedKind, BootGapKindPolicy> = {
  'graph-unavailable': { bodyKey: 'bootGap.body.graphUnavailable', retryable: true },
  'required-services-missing': { bodyKey: 'bootGap.body.requiredServicesMissing', retryable: true },
  'deferred-registration-failed': { bodyKey: 'bootGap.body.deferredRegistrationFailed', retryable: true },
}

/**
 * Whether a cold re-mount is worth attempting for this kind.
 *
 * The policy table is indexed WITHOUT a fallback on purpose: the kind is a typed
 * union produced in this same bundle (never parsed from a wire payload), so an
 * unknown kind cannot occur — and if it somehow did, a loud boundary error beats
 * inventing a cause sentence. The two cross-package readers DO have generic
 * fallbacks (`source.bootGap.generic`, `bootGapGeneric`), because a bridge payload
 * from a differently-versioned build is a real possibility there.
 */
export function isRetryableBootGap(kind: ShellDegradedKind): boolean {
  return BOOT_GAP_POLICY[kind].retryable
}

/**
 * Identity of one fact: same kind AND same payload = the same fact. `shell.ts`
 * uses this instead of a kind-only comparison — two producers used to share one
 * kind, and the probe's re-armed pass can name a LARGER missing set, so kind-only
 * dedup silently dropped the richer verdict.
 *
 * Field-GENERIC on purpose: every payload field takes part, so a field added to
 * the fact later can neither freeze a subscription nor be mistaken for an equal
 * fact. Fields are order-normalized; ARRAY order is preserved because the roster
 * order is the producer's and meaningful (the first named service is the first
 * blocker). "No payload" is one thing — an absent field, an empty array, `null`
 * and an empty string all encode to nothing — so a producer that omits vs
 * materializes an empty field cannot churn the gate.
 *
 * `message` is deliberately NOT part of the identity: both producers derive it
 * deterministically from the same payload (the probe from `missing` + instance,
 * the deferred cluster from the failed id set + instance), so an identical
 * payload cannot carry a different sentence — and the producers already dedup
 * their own repeats (the probe keeps a `reportedSignature`, the deferred cluster
 * reports once per boot). Non-deterministic host/network text belongs to the
 * diagnostic channel (`pluginDiagnostic`), never here.
 * @param fact - the reported fact.
 * @returns a stable signature string.
 */
export function bootGapSignature(fact: ShellDegradedFact): string {
    const encode = (value: unknown): string | null => {
    if (value === undefined || value === null || value === '') return null
    if (Array.isArray(value)) return value.length === 0 ? null : `[${value.map(item => String(item)).join('\u0000')}]`
    return JSON.stringify(value)
  }
  return Object.entries(fact)
    // The producer's sentence is NOT part of the identity (see the doc above).
    .filter(([key]) => key !== 'message')
    .flatMap(([key, value]) => {
      const encoded = encode(value)
      return encoded === null ? [] : [`${key}=${encoded}`]
    })
    .sort()
    .join('\u0001')
}

/** One source's readiness + self-heal marks, as the App knows them at render time. */
export interface BootGapNoticeContext {
  /** The source's current phase (`'ready' | 'starting' | 'error' | …`). */
  phase: string | undefined
  /** The self-heal already re-mounted this source for the CURRENT ready epoch. */
  retried: boolean
}

/** Everything the frame needs to render one gap, all of it decided here. */
export interface BootGapNotice {
  bodyKey: BootGapBodyKey
  /** The producer's diagnostic text, rendered verbatim as the detail line. */
  detail: string
  services: readonly string[]
  injectedBy: readonly string[]
  failedIds: readonly string[]
  /** A retry affordance is worth offering (see {@link BootGapKindPolicy.retryable}). */
  retryable: boolean
  /**
   * The self-heal WILL re-mount this mount, so the copy may promise it. True
   * only while the source is `ready` and the epoch has not retried yet —
   * `planDegradedRetries` never touches a source that is not ready, so
   * promising an automatic re-mount there would be a lie (2026-12 review).
   */
  autoRetryArmed: boolean
}

/**
 * Build the render decision for one fact.
 *
 * Pure: the caller passes the two facts the App already holds (the source phase
 * and the self-heal mark for the current ready epoch). No copy is produced here
 * — only dictionary keys and structured facts — because the frame renders its
 * own sentences (see the module header).
 * @param fact - the settled-boot gap.
 * @param context - the source's phase and this epoch's self-heal mark.
 * @returns the render decision.
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
  }
}

/**
 * Project one shell fact onto the cross-package bridge contract.
 *
 * Drops the producer's diagnostic sentence: the sidebar row and the connections
 * card write their own copy from the KIND and the ids, and the sentence is
 * frame-below text (STATUS「跨边界诊断文案」). Fields are always present as
 * arrays so a consumer never has to distinguish "absent" from "empty"; the
 * projection signature encodes fields in sorted FIELD order but keeps every
 * ARRAY's order (roster order is meaningful: the first service is the first
 * blocker), and treats "no payload" (absent / empty array / null) as one thing.
 * @param fact - the shell's settled-boot gap.
 * @returns the projected gap carried by `ChamberServerAggregate.bootGap`.
 */
export function toServerBootGap(fact: ShellDegradedFact): ServerBootGap {
  return {
    kind: fact.kind,
    services: [...(fact.services ?? [])],
    injectedBy: [...(fact.injectedBy ?? [])],
    failedIds: [...(fact.failedIds ?? [])],
  }
}
