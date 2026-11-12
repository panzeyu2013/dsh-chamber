/**
 * React-free decision rules behind the version-tolerance seams: the boot kernel's
 * post-await audit (the rc.2 required-entry policy, re-derived for the chamber page)
 * and the extra-row degrade. Zero runtime imports, so the policy — the load-bearing
 * contract, including the failure-report strings — is testable under plain node.
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
 * The two id sets the post-await audit reasons with.
 *
 * `required` is the page's minimum fatal set: those entries must ACTIVE or the boot
 * rejects. The upstream roster the policy came from (packages/client/web/src/
 * boot-client.ts) is composite-covered here, so of its ids only the kernel-adopted
 * rows can ever exist as loader entries (boot-rows.ts); the page's build-time manifest
 * rows (the chamber composite bundle) are added to the fatal set by the boot kernel
 * when the audit runs (every manifest row is corruption if inactive, never version skew).
 *
 * `tolerated` is the per-instance extra-row set: a newer/older backend can ship rows
 * this shell cannot run, which is version skew rather than corruption. A tolerated id
 * never fails the boot even if it is also listed as required.
 */
export interface SweepPolicy {
  /** Ids whose inactive state rejects the boot (the report marks them `(required)`). */
  readonly required: ReadonlySet<string>
  /** Version-skew rows (the per-instance extra rows) that degrade instead. */
  readonly tolerated: ReadonlySet<string>
}

/**
 * Verdict for ONE loader entry in the post-await sweep. `ok`: usable. `degraded`:
 * the row did not activate but the boot continues (a per-instance extra row — rc.2
 * writes one warning and leaves active siblings running; that is the version-skew
 * reading). `fatal`: a required entry is inactive — fail loud with the reason (the
 * sweep compensates for cordis inject waiting having no timeout).
 */
export type SweepVerdict =
  | { kind: 'ok' }
  | { kind: 'degraded'; reason: string }
  | { kind: 'fatal'; reason: string }

/** One non-active entry's audit line, without the name prefix or report header. */
export interface SweepFailure {
  /** The loader entry name (manifest row id or extra-row id). */
  readonly name: string
  /** Why it is not active; already operator-facing (see {@link classifySweepEntry}). */
  readonly reason: string
}

/**
 * Decide one entry. A fiberless entry is an import failure; `pending` lists the
 * services that never arrived; `failed` carries the fiber's recorded activation error
 * (`activationFailure` awaits only settled fibers, so the caller passes it in).
 * @param name - loader entry name.
 * @param fiberLabel - projected fiber state, undefined when the entry has no fiber.
 * @param policy - required and tolerated id sets.
 * @param pendingMissing - services a pending fiber waits on (only meaningful for `pending`).
 * @param importErrorMessage - module system's recorded import failure, when it has one.
 * @param activationError - `failed` fiber's activation error text from {@link activationFailure}.
 * @returns the verdict; `degraded`/`fatal` carry the reason line already derived.
 */
export function classifySweepEntry(
  name: string,
  fiberLabel: SweepFiberLabel,
  policy: SweepPolicy,
  pendingMissing: readonly string[],
  importErrorMessage?: string,
  activationError?: string,
): SweepVerdict {
  if (fiberLabel === 'active') return { kind: 'ok' }
  const reason = inactiveReason(fiberLabel, pendingMissing, importErrorMessage, activationError)
  // A tolerated id is version skew by construction: it degrades even when a
  // (mis)configuration also lists it as required.
  if (policy.tolerated.has(name)) return { kind: 'degraded', reason }
  return policy.required.has(name) ? { kind: 'fatal', reason } : { kind: 'degraded', reason }
}

/** The reason text for a non-active entry, in the upstream audit's wording. */
function inactiveReason(
  fiberLabel: SweepFiberLabel,
  pendingMissing: readonly string[],
  importErrorMessage?: string,
  activationError?: string,
): string {
  if (fiberLabel === undefined) {
    // 上游 boot audit 口径（packages/client/web/src/boot-client.ts）：import 失败的真实
    // 原因由 module system 的 importError(id) 记录；只有它没记录时才回落「看 console」。
    return importErrorMessage === undefined
      ? 'import failed (see console for the import error)'
      : `import failed: ${importErrorMessage}`
  }
  if (fiberLabel === 'pending') {
    // A required service never arrived; inject waiting has no timeout, hence this sweep.
    return `pending (waiting for service${pendingMissing.length === 1 ? '' : 's'}: ${pendingMissing.join(', ') || 'unknown'})`
  }
  if (fiberLabel === 'failed') return activationError ?? 'failed'
  return fiberLabel
}

/**
 * The fatal report for required failures, or undefined when no required entry failed.
 * Every failure is listed (rc.2 lists non-required rows too) with required ids marked.
 * @param failures - every non-active entry collected by the sweep.
 * @param requiredIds - the policy's required set.
 */
export function sweepFatalReport(
  failures: readonly SweepFailure[],
  requiredIds: ReadonlySet<string>,
): string | undefined {
  const required = failures.filter(failure => requiredIds.has(failure.name)).length
  if (required === 0) return undefined
  const lines = failures.map(({ name, reason }) =>
    `${name}${requiredIds.has(name) ? ' (required)' : ''}: ${reason}`)
  return `web boot: ${String(required)} required ${entryNoun(required)} did not activate\n${lines.join('\n')}`
}

/**
 * The single warning for optional failures, or undefined when none. A required
 * failure rejects the boot instead, so the warning never accompanies it (rc.2
 * writes no warning in that case) and it lists only the non-required rows.
 * @param failures - every non-active entry collected by the sweep.
 * @param requiredIds - the policy's required set.
 */
export function sweepWarningReport(
  failures: readonly SweepFailure[],
  requiredIds: ReadonlySet<string>,
): string | undefined {
  const optional = failures.filter(failure => !requiredIds.has(failure.name))
  if (optional.length === 0) return undefined
  const lines = optional.map(({ name, reason }) => `${name}: ${reason}`)
  return `web boot: warning: ${String(optional.length)} ${entryNoun(optional.length)} did not activate\n${lines.join('\n')}`
}

/** A failed fiber's recorded activation error; cordis exposes it only through `await()`, which rethrows it. */
export async function activationFailure(fiber: { await(): Promise<unknown> }): Promise<string> {
  try {
    await fiber.await()
  } catch (error) {
    return `failed: ${String(error)}`
  }
  return 'failed'
}

/** Singular or plural noun for an entry count in audit reports. */
function entryNoun(count: number): string {
  return count === 1 ? 'entry' : 'entries'
}
