/**
 * Cross-store registry/password commit planning for desktop main.
 *
 * The transport manager validates and normalizes the complete replacement
 * registry before calling this function. We only decide which existing,
 * write-through password-store operation must run at the manager's commit
 * barrier; no credential is cached here.
 */

import { computePasswordRetirementIds } from './transport-manager.ts'
import type { TransportInstanceSpec } from './transport-provider.ts'

export interface RegistryPasswordSubmission {
  id: string
  password: string
}

export interface RegistryPasswordActions {
  update(
    clearIds: readonly string[],
    replacement?: { owner: TransportInstanceSpec; password: string },
  ): void
}

/**
 * Validate a password submission against the normalized next registry and
 * return the ONE password-store write that belongs at the registry commit
 * barrier. Retirements plus an optional replacement are passed to the
 * password store as one map update, including multi-host replacement sets.
 */
export function prepareRegistryPasswordCommit(
  before: readonly TransportInstanceSpec[],
  after: readonly TransportInstanceSpec[],
  submission: RegistryPasswordSubmission | undefined,
  actions: RegistryPasswordActions,
): (() => void) | undefined {
  const retiredIds = computePasswordRetirementIds(before, after)
  if (submission === undefined) {
    return retiredIds.length === 0 ? undefined : () => actions.update(retiredIds)
  }

  const owner = after.find(instance => instance.id === submission.id)
  if (owner === undefined) {
    throw new Error('password submission does not match an instance in the proposed registry')
  }
  return () => actions.update(retiredIds, { owner, password: submission.password })
}
