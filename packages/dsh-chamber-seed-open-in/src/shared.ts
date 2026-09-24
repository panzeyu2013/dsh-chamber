/**
 * openInApp wire contract — SINGLE SOURCE of truth for the typert Remote namespace,
 * method names, payload/result shapes and the domain carrier. The fork replaces
 * upstream's three `webServer` route paths with the instance's own generic RPC channel
 * behind its connection/gateway fence, so these constants name METHODS, not paths (there
 * is no route to register). The chamber client plugin mirrors the names — it is a
 * browser package and cannot import this Node-side module — and a lockstep test reads
 * THIS file to catch drift.
 */

/** Typert Remote namespace this host domain occupies. */
export const OPEN_IN_APP_REMOTE_NAMESPACE = 'openInApp'

export const OPEN_IN_APP_METHODS = ['probe', 'apps', 'icon', 'open'] as const

export type OpenInAppMethod = (typeof OPEN_IN_APP_METHODS)[number]

/** The cheap activation-probe method (`namespace/method` form). Presence plus
 *  protocol only: no catalog detection, no spawn, no filesystem walk. */
export const OPEN_IN_APP_PROBE_METHOD = `${OPEN_IN_APP_REMOTE_NAMESPACE}/probe`

/** Availability read: catalog ids probed as installed, in menu order. */
export const OPEN_IN_APP_APPS_METHOD = `${OPEN_IN_APP_REMOTE_NAMESPACE}/apps`

/** One application's real bundle icon, base64-encoded. */
export const OPEN_IN_APP_ICON_METHOD = `${OPEN_IN_APP_REMOTE_NAMESPACE}/icon`

/** Launch one resolved application on one absolute directory. */
export const OPEN_IN_APP_OPEN_METHOD = `${OPEN_IN_APP_REMOTE_NAMESPACE}/open`

/** `probe()` result: the host platform this catalog was resolved on. */
export interface OpenInAppProbeValue {
  readonly platform: string
}

/** `apps()` result. */
export interface OpenInAppAppsValue {
  readonly apps: readonly string[]
}

/** `icon()` result: `mime` mirrors upstream's contentType union, `dataBase64` is the
 *  raw bytes so the browser can build a `data:` URL without a second route. */
export interface OpenInAppIconValue {
  readonly mime: string
  readonly dataBase64: string
}

/** Stable domain error codes (serialized over the wire, never localized here). */
export const OPEN_IN_APP_ERROR_CODES = [
  /** The id is not a catalog member (or not a non-empty string). */
  'unknown-app',
  /** The id is a catalog member that does not resolve as installed on this host. */
  'unavailable-app',
  /** The path is missing, empty or not absolute. */
  'invalid-path',
  /** The path names something that is not an existing directory. */
  'directory-missing',
  /** The launcher ran but the application did not come up. */
  'launch-failed',
  /** No icon could be extracted for this application. */
  'icon-unavailable',
] as const

export type OpenInAppErrorCode = (typeof OPEN_IN_APP_ERROR_CODES)[number]

/** One domain failure as it crosses the wire. */
export interface OpenInAppDomainError {
  readonly code: OpenInAppErrorCode
  readonly message: string
  /** True when the same request may succeed later (transient host state). */
  readonly retryable?: boolean
}

/** Explicit business carrier: the generic gateway does not preserve thrown error
 *  fields, so every method answers this shape and only unexpected internal failures
 *  escape as throws. */
export type OpenInAppDomainResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: OpenInAppDomainError }
