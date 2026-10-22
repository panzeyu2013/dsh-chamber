/**
 * The ONE reading of a transport link projection (design 27 §3.1), shared by the
 * renderer's page-channel link selector and any other page consumer.
 *
 * Why it is a module and not an inline closure: the page channel only knows the
 * `PageChannelLink` interface — the "is this source ready, which generation is
 * it" semantics live with the page that owns the status projection. Keeping that
 * reading here means the desktop-side projection (old shims: no `link` field)
 * and the page-side selector cannot drift, and the "down is not ready, suspect
 * is" rule has exactly one owner.
 */

/** The structural slice of a transport status projection this module reads. */
export interface LinkProjectionShape {
  readonly phase?: unknown
  readonly link?: {
    readonly state?: unknown
    readonly linkEpoch?: unknown
  }
}

/**
 * May page-channel traffic for this source flow right now?
 * - `ready` only: connecting/degraded/idle/error have nothing to subscribe to;
 * - `down` parks (the proxy fast-fails new requests and new subscriptions);
 * - `suspect` still forwards (design 27 I3);
 * - a projection without `link` (old shim/renderer) is healthy by contract.
 */
export function linkReady(projection: LinkProjectionShape | undefined): boolean {
  if (projection?.phase !== 'ready') return false
  return (projection.link?.state ?? 'healthy') !== 'down'
}

/** The page reset key. Absent/non-numeric (old shim) reads as generation 0. */
export function linkEpochOf(projection: LinkProjectionShape | undefined): number {
  const epoch = projection?.link?.linkEpoch
  return typeof epoch === 'number' && Number.isFinite(epoch) ? epoch : 0
}
