/**
 * Settled-boot gap facts and their presentation policy
 * 「降级呈现」/ design 09.
 * A shell can settle SUCCESSFULLY while a whole surface is missing. Three
 * producers know such a gap, and all three reach the App through the shell's
 * post-settle seam (`chamberReportBootDegraded`):
 *  - `graph-unavailable`: the source never served its client plugin graph
 *    inside the boot window, so this entry runs without the profile's client
 *    plugins;
 *  - `local-graph-not-injected`: the LOCAL instance's graph channel answered
 *    404 / method-missing. The chamber-managed local host always injects its
 *    graph (the seed row), so this is a chamber-side installation/seed fact —
 *    unlike a gateway/mobile shape, whose missing endpoint is legitimate and
 *    keeps producing no fact at all;
 *  - `required-services-missing`: the graph arrived but a service the
 *    composite's first screen injects never materialized (the classic one is
 *    `ui-chat` pending on `sidebarRight`, which leaves the conversation view
 *    unregistered while the boot still reports success);
 *  - `deferred-registration-failed`: a deferred plugin family's chunk never
 *    loaded or registered, so the slots/services it declares stay absent.
 * The gap reached `console` and the once-per-ready-epoch self-heal only, and the OTHER visible
 * channel (the connections page's `pluginDiagnostic`) legitimately reported
 * `ok` in the motivating case — the graph channel itself answered fine, it was
 * the service that never materialized. The user therefore saw a session title
 * next to an empty conversation body with no error anywhere.
 * Why this module is a LEAF (no runtime imports): `shell.ts` (fact carrier),
 * `chamber-entry.ts` (producers) and `App.tsx` (renderer) all need the fact
 * shape, and `shell.ts` already imports `host-graph.ts` — putting the type in
 * either would create a cycle. The TYPE-only import below is erased by the
 * type stripper, so plain-node tests still load this module standalone.
 * Two disciplines live here:
 *  - **Copy boundary** (STATUS「跨边界诊断文案」): the frame renders the
 *    sentence from its own typed dictionary (`locales.ts`); the producer's raw
 *    `message` is a DIAGNOSTIC line shown as detail, never the copy. The
 *    structured fields (`services`/`injectedBy`/`failedIds`) are the producer's
 *    facts; the frame never parses the message to recover them.
 *  - **Per-kind verdict table**: {@link BOOT_GAP_POLICY} is a `Record` over the
 *    kind union, so a new kind that does not declare its copy key AND its retry
 *    verdict fails the build instead of silently inheriting a wrong sentence or
 *    burning a futile cold re-mount (the self-heal container feeds
 *    {@link isRetryableBootGap} to the reducer as its retryability table).
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
   * All four current kinds re-fetch the graph and re-apply the rows, so all
   * four are worth exactly one attempt. A future kind whose cause a re-boot
   * cannot touch (e.g. a hard graph-channel rejection) MUST declare `false`
   * here: the self-heal container then leaves it alone instead of paying a cold
   * re-mount per ready epoch for a guaranteed no-op.
   */
  retryable: boolean
}

/** Per-kind verdict table (see the module header for why it is a `Record`). */
export const BOOT_GAP_POLICY: Record<ShellDegradedKind, BootGapKindPolicy> = {
  'graph-unavailable': { bodyKey: 'bootGap.body.graphUnavailable', retryable: true },
  // installation/seed fact. A re-mount re-runs the same graph fetch and journal
  // state, which is the one cheap attempt that can clear a stale endpoint after
  // a restart — worth the same single attempt as the channel-failure kind.
  'local-graph-not-injected': { bodyKey: 'bootGap.body.localGraphNotInjected', retryable: true },
  'required-services-missing': { bodyKey: 'bootGap.body.requiredServicesMissing', retryable: true },
  'deferred-registration-failed': { bodyKey: 'bootGap.body.deferredRegistrationFailed', retryable: true },
}

/**
 * Whether a cold re-mount is worth attempting for this kind.
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
 * Relative CAUSE strength of one kind. The probe's
 * `required-services-missing` is the CONSEQUENCE of a missing provider; the
 * three other kinds name a CAUSE the user can act on (the local graph endpoint
 * was never injected, the channel never answered, a deferred family never
 * registered). When both are known, the single banner slot must show the cause —
 * otherwise the actionable fact is replaced ~5s later by its own symptom — a
 * bare "缺少 sidebarRight" with no
 * hint that the local instance had no graph channel at all.
 * Distinct by construction (the shell compares with `>`/`>=`, never equality),
 * and exhaustive over the union so a new kind must declare its rank here.
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
 * Whether an incoming (non-clear) fact may replace the recorded one.
 * Same kind always replaces (its payload may have grown — the probe can name a
 * LARGER missing set). A strictly LOWER-priority kind never overwrites a
 * higher-priority one that is still current; an equal-or-higher kind replaces.
 * Retraction is unaffected: a clear must still match kind AND payload exactly
 * ({@link bootGapClearMatchesFact}), so the suppressed consequence cannot erase
 * the cause's fact either.
 * @param current - the fact currently recorded on the holder, or null.
 * @param incoming - the new non-clear fact.
 * @returns whether the holder should replace its recorded fact.
 */
export function shouldReplaceBootGap(current: ShellDegradedFact | null, incoming: ShellDegradedFact): boolean {
  if (current === null) return true
  if (current.kind === incoming.kind) return true
  return bootGapPriority(incoming.kind) >= bootGapPriority(current.kind)
}

/**
 * Identity of one fact: same kind AND same payload = the same fact. `shell.ts`
 * uses this instead of a kind-only comparison — the probe's re-armed pass can
 * name a LARGER missing set, so kind-only
 * dedup would silently drop the richer verdict.
 * Field-GENERIC on purpose: every payload field takes part, so a field added to
 * the fact later can neither freeze a subscription nor be mistaken for an equal
 * fact. Fields are order-normalized; ARRAY order is preserved because the roster
 * order is the producer's and meaningful (the first named service is the first
 * blocker). "No payload" is one thing — an absent field, an empty array, `null`
 * and an empty string all encode to nothing — so a producer that omits vs
 * materializes an empty field cannot churn the gate.
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

/**
 * A producer's RETRACTION of a previously reported gap:
 * the condition the fact named no longer holds — the motivating producer is the
 * required-service probe, whose missing set can become empty when a provider
 * finally materializes after the 5s verdict. The shell must REMOVE the fact
 * instead of keeping a false banner for the rest of the mount.
 * It rides the SAME seam as the fact (`chamberReportBootDegraded`): one channel,
 * one boot-generation fence, one stash/replay path. The retraction names the
 * EXACT fact it removes (kind + {@link bootGapSignature}), so a newer/richer
 * verdict is never dropped by an older producer's late retraction.
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
 * Whether `clear` retracts exactly `current` — the shell's whole retraction gate.
 * Both halves are load-bearing: the KIND stops one producer from clearing
 * another producer's fact (the slot is single, so a kind-blind clear would erase
 * an unrelated verdict), and the SIGNATURE stops a stale retraction from wiping
 * a newer verdict of the same kind (the probe's re-armed pass can name a larger
 * missing set, which is a different fact).
 * @param current - the fact currently recorded on the shell, if any.
 * @param clear - the retraction a producer reported.
 * @returns whether the recorded fact must be removed.
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
   * The source id the fact belongs to (`'local'` = the app-managed local
   * instance). The manual next-step copy branches on this STRUCTURED fact, never
   * on the diagnostic sentence: on Windows the local runtime is a READ-ONLY
   * projection, so the local copy must not send the user to "upgrade the dsh
   * runtime".
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
   * The self-heal WILL re-mount this mount, so the copy may promise it. True
   * only while the source is `ready` and the epoch has not retried yet —
   * the self-heal container never fires for a source that is not ready, so
   * promising an automatic re-mount there would be a lie.
   */
  autoRetryArmed: boolean
}

/**
 * Build the render decision for one fact.
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
    // projection on Windows (`runtimeManagementSupported=false`), so the local
    // advice is restart/re-mount/report-diagnostics. Remote sources keep the
    // runtime-alignment wording: their runtime is managed on that host.
    manualKey: context.instanceId === 'local' ? 'bootGap.action.manualLocal' : 'bootGap.action.manual',
  }
}

/**
 * Project one shell fact onto the cross-package bridge contract.
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
