/**
 * The archiveCleanup host-domain wire contract (design 24) — THE single source
 * for the domain name, the Remote method names and the purge argument key order.
 * Both sides import THIS package by specifier and esbuild inlines this
 * zero-dependency module (the seed build keeps only `@deepseek-ai/*` external).
 * The one fact TypeScript cannot derive is the host method's parameter
 * identifiers (the generic gateway derives accepted names from source text), so
 * {@link ARCHIVE_CLEANUP_PURGE_ARGS} is pinned in order by the seed's
 * wire-lockstep test — a rename fails the suite instead of silently dropping
 * an argument.
 */

/** Wire namespace (camel, two-segment endpoints — design 24 §3). */
export const ARCHIVE_CLEANUP_DOMAIN = 'archiveCleanup'

/**
 * The purge method's `@Remote` export name — ONE segment, all the pinned
 * `dsh-typert-protocol` accepts on a host decorator. The client ENVELOPE path
 * is the different string `archiveCleanup/purge`.
 */
export const ARCHIVE_CLEANUP_PURGE_METHOD = 'purge'

/**
 * `archiveCleanup/purge` argument names, IN DECLARATION ORDER: `sessionIds`
 * narrows the candidate set, `force` authorizes deleting merely-loaded subtrees,
 * `protectSessionIds` names ids the caller may be displaying. The client always
 * sends all three; {@link archiveCleanupPurgeArgs} preserves this order.
 */
const ARCHIVE_CLEANUP_PURGE_ARGS = ['sessionIds', 'force', 'protectSessionIds'] as const

/** The zero-argument activation probe's `@Remote` export name — one segment; envelope path `archiveCleanup/probe`. */
export const ARCHIVE_CLEANUP_PROBE_METHOD = 'probe'

/**
 * The two-segment ENVELOPE path the generic RPC client spells — CLIENT call
 * sites only; a host `@Remote` export name must stay a single segment.
 */
export function archiveCleanupEndpoint(method: string): string {
  return `${ARCHIVE_CLEANUP_DOMAIN}/${method}`
}

/** Purge payload the client sends: one shape, always `force: true` (the force path IS the manager's feature). */
export interface ArchiveCleanupPurgeArgs {
  readonly sessionIds: readonly string[]
  readonly force: boolean
  readonly protectSessionIds: readonly string[]
}

/**
 * Build the purge `args` object: the keys ARE the descriptor's entries, so a
 * host-side rename surfaces as a lockstep-test failure, never a dropped argument.
 */
export function archiveCleanupPurgeArgs(input: ArchiveCleanupPurgeArgs): Record<string, unknown> {
  return {
    [ARCHIVE_CLEANUP_PURGE_ARGS[0]]: input.sessionIds,
    [ARCHIVE_CLEANUP_PURGE_ARGS[1]]: input.force,
    [ARCHIVE_CLEANUP_PURGE_ARGS[2]]: input.protectSessionIds,
  }
}
