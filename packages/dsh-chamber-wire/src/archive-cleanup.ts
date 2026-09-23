/**
 * The archiveCleanup host-domain wire contract (design 24 §3) — THE single
 * source for the domain name, the Remote method names and the purge argument
 * key order.
 *
 * Both sides import THIS package by specifier: the seed host gateway
 * (`packages/dsh-chamber-seed-archive-cleanup/src/index.ts`) and the sidebar
 * client accessor
 * (`packages/dsh-chamber-client-core/src/instance-api.ts`). The
 * seed build keeps only `@deepseek-ai/*` external, so esbuild inlines this
 * zero-dependency module into the seed's standalone `dist/index.js`, and the
 * client build inlines it too — no runtime resolution through node_modules is
 * required on either side.
 *
 * The ONE fact TypeScript cannot derive from this table is the host method's
 * parameter identifiers (the generic gateway derives accepted argument names
 * from the method's source text). `packages/dsh-chamber-seed-archive-cleanup/
 * test/wire-lockstep.test.ts` pins those identifiers to
 * {@link ARCHIVE_CLEANUP_PURGE_ARGS} in order, pins both call sites to this
 * package, and pins the control-plane host-package registry's probe row to
 * {@link ARCHIVE_CLEANUP_PROBE_METHOD}, so a rename on any side fails the
 * suite instead of silently dropping an argument.
 */

/** Wire namespace (camel, two-segment endpoints — design 24 §3). */
export const ARCHIVE_CLEANUP_DOMAIN = 'archiveCleanup'

/** `archiveCleanup/purge` export name. */
export const ARCHIVE_CLEANUP_PURGE_METHOD = 'purge'

/**
 * `archiveCleanup/purge` argument names, IN THE ORDER the host method
 * declares them: `sessionIds` narrows the candidate set, `force` authorizes
 * deleting merely-loaded subtrees, `protectSessionIds` names the ids the
 * calling client may be displaying. The client always sends all three.
 * Module-internal: callers use {@link archiveCleanupPurgeArgs}, whose key order
 * IS this table; the seed wire-lockstep test pins the host signature to that
 * builder's real output rather than to a re-exported table.
 */
const ARCHIVE_CLEANUP_PURGE_ARGS = ['sessionIds', 'force', 'protectSessionIds'] as const

/** The zero-argument activation probe (design 18 §3.4). */
export const ARCHIVE_CLEANUP_PROBE_METHOD = 'probe'

/** The two-segment endpoint string as the generic RPC envelope spells it. */
export function archiveCleanupEndpoint(method: string): string {
  return `${ARCHIVE_CLEANUP_DOMAIN}/${method}`
}

/** The purge argument payload the client sends (design 24 §5: one shape,
 *  always `force: true` — the force path IS the manager's feature). */
export interface ArchiveCleanupPurgeArgs {
  readonly sessionIds: readonly string[]
  readonly force: boolean
  readonly protectSessionIds: readonly string[]
}

/**
 * Build the purge `args` object from {@link ARCHIVE_CLEANUP_PURGE_ARGS}: the
 * keys ARE the descriptor's entries, so a host-side rename can only surface as
 * a lockstep-test failure, never as a silently dropped argument.
 */
export function archiveCleanupPurgeArgs(input: ArchiveCleanupPurgeArgs): Record<string, unknown> {
  return {
    [ARCHIVE_CLEANUP_PURGE_ARGS[0]]: input.sessionIds,
    [ARCHIVE_CLEANUP_PURGE_ARGS[1]]: input.force,
    [ARCHIVE_CLEANUP_PURGE_ARGS[2]]: input.protectSessionIds,
  }
}
