/**
 * Writer-quiescence notice model for the local connection card (2026-09-10,
 * design 02 §3.4 / 04 §3.2).
 *
 * The control plane answers 409 connection_busy when a managed-host record it
 * cannot clear keeps the local instance from starting; before this revision
 * the page showed the bare reason ("…writer quiescence is not proven…") whose
 * only advice was to restart the app, and a record that merely BECAME stale
 * (its orphan exited) blocked every start for the whole session.
 *
 * This module owns the DISPLAY decision as a pure function so the React card
 * stays a thin renderer: whether the notice appears at all, which blockers are
 * worth naming, whether the explicit 清理并接管 action is offered, and which
 * locale hint explains the state. `sticky` (a failed termination nobody can
 * re-prove) never offers the action — it needs an app restart.
 */

import type { LocalWriterDiagnosisWire } from '@dsh-chamber/dsh-chamber-client-ui-sidebar/shared'
import type { SettingsConnectionsKey } from '../locales.ts'

/** Ready-to-render state of the writer notice under the local card. */
export interface WriterNotice {
  /** Blocking records worth naming (kept entries, pid + machine reason). */
  blockers: Array<{ pid: number | null; reason: string; takeOverAvailable: boolean }>
  /** Probe/scan errors reported alongside the verdict. */
  errors: string[]
  /** Whether the explicit takeover action should be offered. */
  canTakeOver: boolean
  /** Whether the state can only be cleared by restarting the app. */
  restartRequired: boolean
}

/**
 * Decide what the card shows for one diagnosis.
 * @param diagnosis - the control plane's verdict (null when the surface has none).
 * @returns null when there is nothing to show (quiescent, or no diagnosis).
 */
export function writerNotice(diagnosis: LocalWriterDiagnosisWire | null): WriterNotice | null {
  if (diagnosis === null || diagnosis.quiescent) return null
  const blockers = diagnosis.writers
    .filter(entry => entry.status === 'kept')
    .map(entry => ({
      pid: entry.pid,
      reason: entry.reason,
      takeOverAvailable: entry.takeOverAvailable,
    }))
  // A sticky verdict (write-time termination failure) reports no blockers: the
  // evidence is gone, which is exactly why only a restart re-proves it.
  const restartRequired = blockers.length === 0
    && diagnosis.errors.some(line => /restart the app/i.test(line))
  return {
    blockers,
    errors: diagnosis.errors,
    canTakeOver: !restartRequired && blockers.some(blocker => blocker.takeOverAvailable),
    restartRequired,
  }
}

/**
 * Locale key for one machine reason token: the card renders the gloss and
 * keeps the raw token visible beside it, so a report stays copy-pasteable.
 */
export function writerReasonKey(reason: string): SettingsConnectionsKey {
  switch (reason) {
    case 'identity-unverified': return 'writerReasonIdentityUnverified'
    case 'identity-mismatch':
    case 'takeover-stale-removed': return 'writerReasonIdentityMismatch'
    case 'live-foreign-writer': return 'writerReasonLiveForeignWriter'
    case 'port-unverified': return 'writerReasonPortUnverified'
    case 'residual-group': return 'writerReasonResidualGroup'
    case 'invalid-record': return 'writerReasonInvalidRecord'
    case 'claim-owner-alive': return 'writerReasonClaim'
    default: return 'writerReasonIdentityUnverified'
  }
}
