/**
 * Action equivalence normalizer (refactor plan section 4.1, review finding A-1).
 *
 * The differential oracle compares an old wiring against a new one. Their
 * DIAGNOSTIC strings are expected to differ - the new reducer names things
 * differently on purpose - so comparing raw effects would go red for cosmetic
 * reasons and pressure the refactor into keeping legacy wording. This module
 * projects an effect onto a canonical form: (effect kind, target id, semantic
 * reason class), deliberately dropping wording.
 *
 * The normalizer is itself pure and dependency-free because the oracle
 * (scripts/refactor/equivalence.mjs) must be able to load it without a build.
 */
import type { RecoveryEffect } from './state.ts'

/** Canonical shape every effect must collapse to for comparison. */
export interface NormalizedEffect {
  readonly kind: string
  readonly target: string
  readonly reasonClass: string
}

/** Reason classes collapse the wording variants that mean the same thing.
 * Deliberately conservative: only synonyms are folded; distinct causes stay
 * distinct so a real semantic difference can never hide behind this map. */
const REASON_CLASSES: Readonly<Record<string, string>> = {
  socketNoFrame: 'silent',
  'silent socket replaced': 'silent',
  'silent socket replaced on teardown': 'silent',
  teardownNoFrame: 'silent',
  openingStall: 'stall',
  'opening stall': 'stall',
  laneReconnect: 'lane',
  'lane reconnect': 'lane',
  'opening-timeout': 'stall',
  handshakeTimeout: 'handshake',
  throttled: 'throttled',
}

/** Fold a free-text reason into its class. Unknown text maps to itself so a new
 * cause shows up as a difference instead of silently matching anything. */
export function reasonClassOf(reason: string): string {
  return REASON_CLASSES[reason] ?? reason
}

/**
 * Project one effect. `target` is the identity the effect acts on - a stream id
 * where one exists, else the effect's own name - so reordering unrelated
 * effects cannot masquerade as a match.
 */
export function normalizeEffect(effect: RecoveryEffect): NormalizedEffect {
  switch (effect.e) {
    case 'rebuildCarrier':
      return { kind: 'rebuildCarrier', target: 'carrier', reasonClass: reasonClassOf(effect.reason) }
    case 'reopenLogicalStream':
      return { kind: 'reopenLogicalStream', target: effect.streamId, reasonClass: reasonClassOf(effect.reason) }
    case 'reconcileFacts':
      return { kind: 'reconcileFacts', target: effect.scope, reasonClass: 'n/a' }
    case 'throttled':
      return { kind: 'throttled', target: 'carrier', reasonClass: reasonClassOf(effect.reason) }
    case 'forensic':
      return { kind: 'forensic', target: effect.name, reasonClass: 'n/a' }
    default:
      return { kind: 'unknown', target: 'unknown', reasonClass: 'n/a' }
  }
}

/**
 * Compare two effect sequences under three allowed divergence classes
 * (refactor plan section 4.1): wording, intra-tick ordering, and added
 * observability. Concretely: `forensic` effects are compared as a set (their
 * order and count are diagnostic), while every other effect is compared as an
 * ordered multiset per target.
 */
export function equivalents(a: readonly RecoveryEffect[], b: readonly RecoveryEffect[]): boolean {
  const key = (e: RecoveryEffect): string => {
    const n = normalizeEffect(e)
    return `${n.kind}:${n.target}:${n.reasonClass}`
  }
  const behavioral = (list: readonly RecoveryEffect[]): string[] =>
    list.filter((e) => e.e !== 'forensic').map(key).sort()
  const forensic = (list: readonly RecoveryEffect[]): string[] =>
    list.filter((e) => e.e === 'forensic').map(key).sort()
  const bBehavioral = behavioral(b)
  const aBehavioral = behavioral(a)
  if (aBehavioral.length !== bBehavioral.length) return false
  for (let i = 0; i < aBehavioral.length; i += 1) if (aBehavioral[i] !== bBehavioral[i]) return false
  const aForensic = forensic(a)
  const bForensic = forensic(b)
  // Observability is allowed to be ADDED, never to remove an existing fact.
  for (const fact of aForensic) if (!bForensic.includes(fact)) return false
  return true
}
