/**
 * Metadata-health projection — the derived facts both Node hosts publish: the named
 * components the wire vocabulary carries and whether a recovery escape is needed. The five
 * predicates and the needsRecovery rule are identical; only the element type differs
 * (`Set<string>` in the gateway, `Set<RuntimeMetadataComponent>` on desktop), and the
 * corrupt-marker rescue stays a per-host seam because it touches its own base directory.
 * The rescue is passed in, keeping this a pure projection with no filesystem access.
 */
import type { RuntimeMetadataHealth } from './runtime-metadata-recovery.ts'

/** The metadata components the wire vocabulary names. */
export type RuntimeMetadataComponent =
  | 'current'
  | 'override'
  | 'activation-journal'
  | 'recovery-marker'
  | 'retained-evidence'

/** The facts both hosts publish for one metadata-health reading. */
export interface MetadataHealthProjectionFacts {
  /** Named components, in the wire order (fixed by the predicate order below). */
  components: RuntimeMetadataComponent[]
  /** Whether the recover-metadata escape must stay eligible. */
  needsRecovery: boolean
}

/**
 * The boot gate's decision on one metadata-health fact: whether the recover-metadata escape
 * stays eligible, and whether the managed host must not start until recovery has run.
 */
export interface MetadataRecoveryGateDecision {
  /** The facts projection's recovery need (rescue-seam aware). */
  needsRecovery: boolean
  /** The boot gate. Status-only and UNCONDITIONAL: an in-progress transaction or a corrupt
   *  recovery marker blocks startup whatever the rescue seam says; the three component
   *  predicates (and selection-corrupt) deliberately do NOT block — they are recoverable. */
  startupMustBlock: boolean
}

/**
 * Project one metadata-health fact into the wire facts. `markerRescueAvailable` says whether
 * the corrupt recovery marker is rescuable (the host inspects its own base directory);
 * returns the named components and the recovery need.
 */
export function projectMetadataHealthFacts(
  health: RuntimeMetadataHealth,
  { markerRescueAvailable }: { markerRescueAvailable: boolean },
): MetadataHealthProjectionFacts {
  const components = new Set<RuntimeMetadataComponent>()
  if (health.current.kind === 'corrupt' || health.current.kind === 'unknown'
    || health.corruptEvidence.some(name => name.startsWith('current.'))) components.add('current')
  if (health.override.kind === 'corrupt' || health.override.kind === 'unknown'
    || health.corruptEvidence.some(name => name.startsWith('override.json.'))) components.add('override')
  if (health.activationJournal.kind === 'corrupt'
    || health.corruptEvidence.some(name => name.startsWith('activation-journal.json.'))) components.add('activation-journal')
  if (health.recovery.kind === 'corrupt'
    || (health.recovery.kind === 'valid' && health.recovery.record.phase !== 'finalized')) {
    components.add('recovery-marker')
  }
  if (health.corruptEvidence.length > 0) components.add('retained-evidence')
  // The rescue flag is honored only for marker-corrupt; the explicit disjunct keeps the
  // shared leaf honest for hosts feeding a partially-populated fact set (an unreadable
  // selection leaf is as unrecoverable as a corrupt one).
  const selectionUnreadable = health.current.kind === 'unknown' || health.override.kind === 'unknown'
  const needsRecovery = health.status === 'selection-corrupt'
    || selectionUnreadable
    || health.status === 'recovery-in-progress'
    || (health.status === 'recovery-marker-corrupt' && markerRescueAvailable)
  return { components: [...components], needsRecovery }
}

/**
 * The pre-start gate both hosts consult before serving DSH_HOME: a boot path may not use
 * {@link projectMetadataHealthFacts}.needsRecovery as its gate — that predicate adds
 * `selection-corrupt` (recoverable, no restart required) and subtracts the
 * marker-corrupt-without-rescue case via the seam. The boot block is the raw status
 * conjunction: an unfinished recovery transaction (status `recovery-in-progress` covers the
 * valid-unfinalized record too) or a corrupt recovery marker must stop the managed dsh
 * regardless of what the rescue seam reports. `markerRescueAvailable` is forwarded unchanged.
 */
export function projectMetadataRecoveryGate(
  health: RuntimeMetadataHealth,
  options: { markerRescueAvailable: boolean },
): MetadataRecoveryGateDecision {
  return {
    needsRecovery: projectMetadataHealthFacts(health, options).needsRecovery,
    startupMustBlock: health.status === 'recovery-in-progress'
      || health.status === 'recovery-marker-corrupt',
  }
}
