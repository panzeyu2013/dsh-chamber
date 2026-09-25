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

/**
 * Lossless-JSON boundary check, moved upstream into
 * @deepseek-ai/dsh-typert-protocol (rc.2): stream-protocol.ts imports it, so the
 * stub exposes the vendor's own module instead of a copy that could drift from
 * the wire boundary it guards.
 */
export { isRemoteJsonValue } from '../../../../../vendor/harness-packages/@deepseek-ai/dsh-typert-protocol/src/json-value.ts'

/** Owned-value marker (rc.2); remote-events.ts imports it at runtime. */
export { isTypertOwnedValue } from '../../../../../vendor/harness-packages/@deepseek-ai/dsh-typert-protocol/src/owned-value.ts'
