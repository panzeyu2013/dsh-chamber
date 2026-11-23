/**
 * The alpha.1 `completionFailed` bit on the runtime-facts channel.
 *
 * The PRODUCER feeds the official `sessionStatus.completionFailed` set as the
 * seventh argument of `projectRuntimeFacts`, so client-core owns the row field
 * (`InstanceRuntimeReport['sessions'][id].failed?: boolean`) and this module is
 * presentation-only: a sparse, typed read of that field.
 *
 * The field is SPARSE (`failed: true` only; absent = no such fact) and never
 * comes from the App's N-ctx correction arm: a facts-only source has no failure
 * fact, and the arm's `completed` is a UI reminder, not a Host-observed
 * execution error.
 *
 * Only the row PRESENTATION consumes it (`server-section-session-state.tsx`):
 * the notification edge must never read `failed` (design 14 §D4 red line —
 * `completion-observation.ts` reads turn/end kinds, never completed/failed).
 */
import type { InstanceRuntimeReport } from '@dsh-chamber/dsh-chamber-client-core/aggregate-store'

type RuntimeFactRow = InstanceRuntimeReport['sessions'][string]

/** True when the row carries the Host-observed failure fact (sparse typed read). */
export function failedFactOf(row: RuntimeFactRow | undefined): boolean {
  return row?.failed === true
}
