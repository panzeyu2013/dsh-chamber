/**
 * React-free decision rules behind the version-tolerance seams: the boot kernel's
 * extra-row degrade. Zero runtime imports, so the policy — the load-bearing contract,
 * including the failure-report strings — is testable under plain node.
 */

/** One entry's projected fiber label, or undefined when fiberless (import failed). */
export type SweepFiberLabel =
  | 'pending'
  | 'loading'
  | 'active'
  | 'failed'
  | 'disposed'
  | 'unloading'
  | undefined

/**
 * Verdict for ONE loader entry in the post-await sweep. `ok`: usable (manifest rows
 * and the app-shell assembly must be ACTIVE; a tolerated extra row is OK whenever it
 * RAN). `degraded`: a tolerated extra row did not activate — version skew, not
 * corruption; marked 'failed', boot continues. `fatal`: a manifest row or the assembly
 * failed — fail loud with the reason (the sweep compensates for cordis inject waiting
 * having no timeout).
 */
export type SweepVerdict =
  | { kind: 'ok' }
  | { kind: 'degraded' }
  | { kind: 'fatal'; reason: string }

export function classifySweepEntry(
  name: string,
  fiberLabel: SweepFiberLabel,
  toleratedIds: ReadonlySet<string>,
  pendingMissing: readonly string[],
): SweepVerdict {
  if (toleratedIds.has(name)) {
    return fiberLabel === 'active' ? { kind: 'ok' } : { kind: 'degraded' }
  }
  if (fiberLabel === undefined) {
    return { kind: 'fatal', reason: `${name}: import failed (see console for the import error)` }
  }
  if (fiberLabel === 'active') return { kind: 'ok' }
  if (fiberLabel === 'pending') {
    // A required service never arrived; inject waiting has no timeout, hence this sweep.
    return {
      kind: 'fatal',
      reason: `${name}: pending (waiting for service${pendingMissing.length === 1 ? '' : 's'}: ${pendingMissing.join(', ') || 'unknown'})`,
    }
  }
  return { kind: 'fatal', reason: `${name}: ${fiberLabel}` }
}
