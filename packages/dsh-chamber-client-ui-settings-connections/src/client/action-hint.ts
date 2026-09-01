/**
 * User-action hint selection for a terminal connection failure (design 05 §5
 * remote host cards).
 *
 * The desktop projects `userActionKind` alongside `requiresUserAction` to
 * discriminate the terminal failure class (transport/credential-level vs
 * instance-level probe failure — see transport-provider.ts
 * TransportStatusProjection). The card must never tell the user to fix SSH
 * credentials when the SSH tunnel itself was fine and the remote dsh
 * instance is the problem (e.g. a breaking change / version mismatch on the
 * remote — 2026-08 UI misdirection fix).
 *
 * Selection order (per spec.kind / spec.transport):
 * - kind 'gateway'      → gatewayAuthActionHint (gateway URL/credentials are
 *   the repair surface — covers instance-level 401/403 too);
 * - transport 'http'    → directActionHint (URL / reachability / dsh web
 *   profile — already endpoint-flavored);
 * - transport 'ssh'     → userActionKind === 'endpoint'
 *   ? endpointActionHint (SSH is fine — check/upgrade the remote dsh)
 *   : authActionHint    ('auth' class or unknown: SSH credentials/host key).
 *
 * Returns null when no hint applies (requiresUserAction false, or the phase
 * is not a terminal one).
 */

import type { SshInstanceSpec, SshStatusProjection, SshPhase } from '../global.d.ts'
import type { SettingsConnectionsKey } from '../locales.ts'

/** The card phases on which a terminal user-action hint is shown. */
export function isUserActionPhase(phase: SshPhase | undefined): boolean {
  return phase === 'error' || phase === 'degraded'
}

/**
 * The locale key of the repair-direction hint for one remote host card, or
 * null when no hint should render. Pure — unit-tested independently of the
 * React card (action-hint.test.ts).
 */
export function actionHintKey(
  spec: Pick<SshInstanceSpec, 'kind' | 'transport'>,
  status: SshStatusProjection | undefined,
  phase: SshPhase | undefined,
): SettingsConnectionsKey | null {
  if (status?.requiresUserAction !== true) return null
  if (!isUserActionPhase(phase)) return null
  if (spec.kind === 'gateway') return 'gatewayAuthActionHint'
  if (spec.transport === 'http') return 'directActionHint'
  // dsh over SSH: the class discriminator decides the repair surface. An
  // endpoint-class failure means the tunnel worked — never an SSH auth hint.
  return status.userActionKind === 'endpoint' ? 'endpointActionHint' : 'authActionHint'
}
