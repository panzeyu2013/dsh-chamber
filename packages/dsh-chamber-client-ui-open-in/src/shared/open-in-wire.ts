/**
 * Client-side mirror of the `openInApp` wire (design 20 §4.1/§4.2).
 *
 * WHY A MIRROR: this is a browser package, while the host domain lives in the
 * Node-side seed package `@dsh-chamber/dsh-chamber-seed-open-in` — seeded INTO
 * the managed instance, never linked into the composite bundle. The two sides
 * are pinned to each other by `test/open-in-wire-lockstep.test.ts`, which reads
 * the seed's `src/shared.ts` and `src/index.ts` and fails on any drift of the
 * namespace, a method name, the error-code set or the `@Remote` surface. This
 * replaces the retired route/byte mirror (`shared/open-in-app-protocol.ts`,
 * design 20 §8): the protocol is now chamber-owned on both halves.
 *
 * The transport is the instance's own generic RPC channel — `ctx.connection.
 * rpc.call('/api', <method>, { args }, signal)` — so the per-entry base path,
 * the browser-auth cookie and the trust fence all come from the existing
 * connection carrier (design 20 §4.2); this package never builds a URL.
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
 * Media types this client will turn into a `data:` URL. The host answers
 * `image/png` today (its extractor emits PNG) and `image/svg+xml` for themed
 * Linux icons; a hostile or drifted host can therefore never hand the page an
 * arbitrary document type to render.
 */
export const OPEN_IN_APP_ICON_MIME_ALLOWLIST: readonly string[] = ['image/png', 'image/svg+xml']
