/**
 * Metadata-health projection — the derived facts both Node hosts publish
 * (2026-12 single-sourcing pass).
 *
 * The gateway's status projection and the desktop startup host each turned a
 * detectRuntimeMetadataHealth() fact into the same two things: the set of
 * named components the wire vocabulary carries, and whether a recovery escape
 * is needed. The five predicates and the needsRecovery rule were identical;
 * only the element TYPE differed (`Set<string>` in the gateway, a desktop
 * `Set<RuntimeMetadataComponent>`), and the corrupt-marker rescue stays a seam
 * each host computes because it touches its own base directory.
 *
 * The marker rescue is passed in rather than computed here: this module stays a
 * pure projection with no filesystem access.
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
 * The boot gate's decision on one metadata-health fact (2026-12 audit 3.1):
 * whether the recover-metadata escape stays eligible, and whether the managed
 * host must not start until recovery has run.
 */
export interface MetadataRecoveryGateDecision {
  /** The facts projection's recovery need (rescue-seam aware). */
  needsRecovery: boolean
  /** The boot gate. Status-only and UNCONDITIONAL: an in-progress transaction
   *  or a corrupt recovery marker blocks startup whatever the rescue seam
   *  says. The three component predicates (and selection-corrupt) deliberately
   *  do NOT block the boot — they are the recoverable selection states. */
  startupMustBlock: boolean
}

/**
 * Project one metadata-health fact into the wire facts.
 * @param health - detectRuntimeMetadataHealth() output.
 * @param options.markerRescueAvailable - whether the corrupt recovery marker is
 *   rescuable (the host inspects its own base directory for this).
 * @returns the named components and the recovery need.
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
  // The rescue flag is honored only for the marker-corrupt status. Both hosts
  // compute it as exactly that conjunction today, so this guard is redundant for
  // them — but it keeps the shared leaf from depending on a caller's discipline.
  // An unreadable (EACCES/EIO) selection leaf is exactly as unrecoverable
  // without the escape as a corrupt one: detectRuntimeMetadataHealth already
  // reports it as selection-corrupt, and this explicit disjunct keeps the
  // shared leaf honest for hosts that feed a partially-populated fact set.
  const selectionUnreadable = health.current.kind === 'unknown' || health.override.kind === 'unknown'
  const needsRecovery = health.status === 'selection-corrupt'
    || selectionUnreadable
    || health.status === 'recovery-in-progress'
    || (health.status === 'recovery-marker-corrupt' && markerRescueAvailable)
  return { components: [...components], needsRecovery }
}

/**
 * The pre-start gate the two hosts consult before serving DSH_HOME (2026-12
 * audit 3.1, gateway runtime-manager.metadataRecoveryPending): a boot path may
 * not use {@link projectMetadataHealthFacts}.needsRecovery as its gate — that
 * predicate adds `selection-corrupt` (recoverable, does not require a restart)
 * and subtracts the marker-corrupt-without-rescue case via the seam. The boot
 * block is the raw status conjunction: an unfinished recovery transaction
 * (status `recovery-in-progress` covers the valid-unfinalized record too) or a
 * corrupt recovery marker must stop the managed dsh regardless of what the
 * rescue seam reports.
 *
 * @param health - detectRuntimeMetadataHealth() output.
 * @param options.markerRescueAvailable - forwarded unchanged to the facts
 *   projection for {@link MetadataRecoveryGateDecision.needsRecovery}.
 * @returns the recovery need plus the boot block.
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
