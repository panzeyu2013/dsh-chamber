/**
 * Metadata-health projection — the derived facts both Node hosts publish.
 *
 * The gateway's status projection and the desktop startup host both turn a
 * detectRuntimeMetadataHealth() fact into the same two things: the set of
 * named components the wire vocabulary carries, and whether a recovery escape
 * is needed. The five predicates and the needsRecovery rule are identical;
 * only the element TYPE differs (`Set<string>` in the gateway, a desktop
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
  if (health.current.kind === 'corrupt'
    || health.corruptEvidence.some(name => name.startsWith('current.'))) components.add('current')
  if (health.override.kind === 'corrupt'
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
  const needsRecovery = health.status === 'selection-corrupt'
    || health.status === 'recovery-in-progress'
    || (health.status === 'recovery-marker-corrupt' && markerRescueAvailable)
  return { components: [...components], needsRecovery }
}
