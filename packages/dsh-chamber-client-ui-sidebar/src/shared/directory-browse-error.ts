/**
 * Local copy of the vendor `dsh-client-ui-workspace` `DirectoryBrowseError`
 * (ui-workspace/src/client/navigation.ts).
 *
 * WHY a local copy (migration D5 fallback, docs/tmp-dsh-v012-migration-plan.md
 * M4): the original deep-source import pulled vendor ui-workspace sources into
 * chamber typecheck programs, and those sources do not compile under chamber
 * tsconfigs (parameter properties violate `erasableSyntaxOnly`, subpath
 * imports like `@deepseek-ai/dsh-session/types` do not resolve without vendor
 * path tables). The class is tiny and stable; the vendor file also carries a
 * `constructor(readonly rpcError)` parameter property, which is written here
 * as an explicit field assignment to stay erasable-syntax-only clean.
 */

/** Host directory business failure (wire shape of a rejected Typert Remote). */
export interface RemoteFailure {
  readonly code: string
  readonly message: string
  readonly details: unknown
}

export class DirectoryBrowseError extends Error {
  override readonly name = 'DirectoryBrowseError'

  /** Host-reported directory business failure. */
  readonly rpcError: RemoteFailure

  /** @param rpcError - Host directory business failure. */
  constructor(rpcError: RemoteFailure) {
    super(`directory browse failed: ${rpcError.code}: ${rpcError.message}`)
    this.rpcError = rpcError
  }
}
