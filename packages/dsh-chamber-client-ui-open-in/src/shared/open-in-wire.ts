/**
 * Client-side mirror of the `openInApp` wire.
 *
 * WHY A MIRROR: this is a browser package while the host domain lives in the
 * Node-side seed package seeded INTO the managed instance and never linked into
 * the composite bundle. A lockstep test pins namespace, method names, error-code
 * set and `@Remote` surface against the seed’s sources.
 *
 * The transport is the instance’s own generic RPC channel, so the per-entry base
 * path, browser-auth cookie and trust fence all come from the existing
 * connection carrier; this package never builds a URL.
 */

/** Typert Remote namespace the host domain occupies. */
export const OPEN_IN_APP_REMOTE_NAMESPACE = 'openInApp'

/** The domain's methods, in probe/read/launch order. */
export const OPEN_IN_APP_METHODS = ['probe', 'apps', 'icon', 'open'] as const

/** One method name of {@link OPEN_IN_APP_METHODS}. */
export type OpenInAppMethod = (typeof OPEN_IN_APP_METHODS)[number]

/** Fully qualified method names (the endpoint string handed to the RPC carrier). */
export const OPEN_IN_APP_PROBE_METHOD = `${OPEN_IN_APP_REMOTE_NAMESPACE}/probe`
export const OPEN_IN_APP_APPS_METHOD = `${OPEN_IN_APP_REMOTE_NAMESPACE}/apps`
export const OPEN_IN_APP_ICON_METHOD = `${OPEN_IN_APP_REMOTE_NAMESPACE}/icon`
export const OPEN_IN_APP_OPEN_METHOD = `${OPEN_IN_APP_REMOTE_NAMESPACE}/open`

/** Stable domain error codes (mirror of the host's closed set). */
export const OPEN_IN_APP_ERROR_CODES = [
  'unknown-app',
  'unavailable-app',
  'invalid-path',
  'directory-missing',
  'launch-failed',
  'icon-unavailable',
] as const

/** One code of {@link OPEN_IN_APP_ERROR_CODES}. */
export type OpenInAppErrorCode = (typeof OPEN_IN_APP_ERROR_CODES)[number]

/** One domain failure as it crossed the wire. */
export interface OpenInAppDomainError {
  readonly code: OpenInAppErrorCode
  readonly message: string
  readonly retryable?: boolean
}

/** The explicit carrier every host method answers with. */
export type OpenInAppDomainResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: OpenInAppDomainError }

/** `apps()` value: installed catalog ids in menu order. */
export interface OpenInAppAppsValue {
  readonly apps: readonly string[]
}

/** `icon()` value: the icon bytes and their media type. */
export interface OpenInAppIconValue {
  readonly mime: string
  readonly dataBase64: string
}

/**
 * Media types this client turns into a `data:` URL; a drifted or hostile host
 * can never hand the page an arbitrary document type to render.
 */
export const OPEN_IN_APP_ICON_MIME_ALLOWLIST: readonly string[] = ['image/png', 'image/svg+xml']
