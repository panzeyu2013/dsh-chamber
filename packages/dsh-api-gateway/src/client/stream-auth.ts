/**
 * P1-3 auth-close vocabulary, kept dependency-free so the classification suite
 * can run without the vendor client graph.
 *
 * The proxy completes a local WebSocket handshake and closes 4401/4403 when the
 * upstream rejected authentication (ProxyForwardDeps upgrade path). The browser
 * WebSocket API exposes no HTTP status on a failed upgrade, so the close code is
 * the only machine-readable auth signal.
 */

export const REMOTE_STREAM_AUTH_CLOSE_CODES: readonly number[] = [4401, 4403]

export function isRemoteStreamAuthCloseCode(code: number): boolean {
  return code === 4401 || code === 4403
}
