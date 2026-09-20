/** Minimal RemoteError identity for behavioural suites (matches the vendor shape). */
export class RemoteError extends Error {
  constructor(code, message, details, options) {
    super(message, options)
    this.name = 'RemoteError'
    this.code = code
    this.details = details ?? {}
  }
}

export function remoteErrorOf(error) {
  return error instanceof RemoteError ? error : undefined
}
