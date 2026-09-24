/**
 * Local copy of the vendor `dsh-client-ui-workspace` `DirectoryBrowseError`: importing vendor
 * sources directly pulls them into chamber typecheck programs that do not compile under chamber
 * tsconfigs (`erasableSyntaxOnly` forbids parameter properties; vendor subpath imports do not
 * resolve). The vendor's `constructor(readonly rpcError)` is written here as an explicit field
 * assignment to stay erasable-syntax-only clean.
 */

/** Host directory business failure (wire shape of a rejected Typert Remote). */
export interface RemoteFailure {
  readonly code: string
  readonly message: string
  readonly details: unknown
}

export class DirectoryBrowseError extends Error {
  override readonly name = 'DirectoryBrowseError'

  readonly rpcError: RemoteFailure

  constructor(rpcError: RemoteFailure) {
    super(`directory browse failed: ${rpcError.code}: ${rpcError.message}`)
    this.rpcError = rpcError
  }
}
