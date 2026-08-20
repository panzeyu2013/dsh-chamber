/** Structured business or fail-closed response error from one instance unary method. */
export class InstanceRpcError extends Error {
  readonly code: string
  readonly details: unknown

  constructor(code: string, message: string, details?: unknown) {
    super(`${code}: ${message}`)
    this.name = 'InstanceRpcError'
    this.code = code
    this.details = details
  }
}
