/**
 * Action equivalence normalizer: projects an effect onto (kind, target id, semantic
 * reason class), dropping wording so cosmetic diagnostic differences cannot decide a
 * differential verdict. Unknown text maps to itself - a new cause shows up as a
 * difference instead of silently matching anything. Pure and dependency-free.
 */
import type { RecoveryEffect } from './state.ts'

/** Canonical shape every effect must collapse to for comparison. */
export interface NormalizedEffect {
  readonly kind: string
  readonly target: string
  readonly reasonClass: string
}

/** Reason classes fold wording variants that mean the same thing; only synonyms are
 * folded, so distinct causes stay distinct and cannot hide behind this map. */
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

/** Fold a free-text reason into its class; unknown text maps to itself. */
export function reasonClassOf(reason: string): string {
  return REASON_CLASSES[reason] ?? reason
}

/**
 * Project one effect. `target` is the identity it acts on (a stream id, else the
 * effect's own name), so reordering unrelated effects cannot masquerade as a match.
 */
export function normalizeEffect(effect: RecoveryEffect): NormalizedEffect {
  switch (effect.e) {
    case 'rebuildCarrier':
      return { kind: 'rebuildCarrier', target: 'carrier', reasonClass: reasonClassOf(effect.reason) }
    case 'reopenLogicalStream':
      return { kind: 'reopenLogicalStream', target: effect.streamId, reasonClass: reasonClassOf(effect.reason) }
    case 'armOpeningDeadline':
      return { kind: 'armOpeningDeadline', target: effect.streamId, reasonClass: 'n/a' }
    case 'throttled':
      return { kind: 'throttled', target: 'carrier', reasonClass: reasonClassOf(effect.reason) }
    case 'forensic':
      return { kind: 'forensic', target: effect.name, reasonClass: 'n/a' }
    default:
      return { kind: 'unknown', target: 'unknown', reasonClass: 'n/a' }
  }
}

/**
 * Compare two effect sequences tolerating wording and intra-tick ordering differences.
 * `forensic` effects are compared as a set (observability may be ADDED, never removed),
 * every other effect as an ordered multiset per target.
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
