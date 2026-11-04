/**
 * Host-key trust (P0-3) — the browser half, framework-free and unit-tested.
 *
 * The desktop projects userActionKind 'hostkey' + a non-secret hostKey {state, fingerprints,
 * changed?}. This module turns that projection into what the trust panel must say and drives the
 * probe -> trust sequence: the renderer never invents key material — probe returns the (type, blob)
 * the ssh self-proof recorded, and trust accepts only that server-side (5-minute TTL).
 */
import type { SshHostKeyProbe, SshStatusProjection } from '../global.d.ts'

/** What the trust panel shows for one card, or null when the card has no host-key failure. */
export interface HostKeyTrustView {
  /** Fingerprints of the key the host currently presents (empty = not probed yet). */
  fingerprints: string[]
  /** Trusted fingerprints the server's key differs from (changed state only). */
  previousFingerprints: string[]
  /** The presented key differs from the stored one → the copy must warn, not just offer trust. */
  changed: boolean
  /** The last probe could not observe a key (ssh unavailable / unreachable). */
  unavailable: boolean
}

/** The trust-panel projection for one status, or null when no host-key action applies. */
export function hostKeyTrustView(status: SshStatusProjection | undefined): HostKeyTrustView | null {
  if (status === undefined || status.requiresUserAction !== true) return null
  if (status.userActionKind !== 'hostkey') return null
  const hostKey = status.hostKey
  if (hostKey === undefined) {
    // A host-key class without a probe projection is still actionable (probe on click), but the
    // panel must not pretend it has a fingerprint yet.
    return { fingerprints: [], previousFingerprints: [], changed: false, unavailable: false }
  }
  return {
    fingerprints: [...hostKey.fingerprints],
    previousFingerprints: [...(hostKey.previousFingerprints ?? [])],
    changed: hostKey.changed === true || hostKey.state === 'changed',
    unavailable: hostKey.state === 'unavailable',
  }
}

/** The two bridge calls the trust flow needs (structural subset of DesktopSshSurface). */
export interface HostKeyTrustBridge {
  host_key_probe(id: string): Promise<{ ok: true; hostKey: SshHostKeyProbe } | { ok: false; error: string }>
  host_key_trust(id: string, type: string, blob: string): Promise<
    { ok: true; replaced: boolean } | { ok: false; error: string }
  >
}

export type ProbeAndTrustResult =
  | { ok: true; replaced: boolean; fingerprints: string[] }
  | { ok: false; error: string }

/**
 * One user click: probe (fresh server-side record, inside the TTL) then trust that exact key.
 * Never trusts anything the probe did not just observe; a probe that saw no key refuses loudly.
 */
export async function probeAndTrustHostKey(
  bridge: HostKeyTrustBridge,
  id: string,
): Promise<ProbeAndTrustResult> {
  const probed = await bridge.host_key_probe(id)
  if (!probed.ok) return { ok: false, error: probed.error }
  const key = probed.hostKey
  if (key.type === null || key.blob === null) {
    return { ok: false, error: 'the host-key probe did not observe a key' }
  }
  const trusted = await bridge.host_key_trust(id, key.type, key.blob)
  if (!trusted.ok) return { ok: false, error: trusted.error }
  return { ok: true, replaced: trusted.replaced, fingerprints: [...key.fingerprints] }
}

/** Whether the trust button is actionable right now (a probe may take ConnectTimeout seconds). */
export function hostKeyTrustActionable(view: HostKeyTrustView | null, busy: boolean, trusting: boolean): boolean {
  return view !== null && !view.unavailable && !busy && !trusting
}
