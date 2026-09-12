/**
 * openInApp wire contract — the SINGLE SOURCE of truth for the typert Remote
 * namespace, its method names, the payload/result shapes and the domain
 * carrier every method answers with.
 *
 * ## chamber fork divergence (design 20 §6.1, fork & supersede 2026-09-11)
 *
 * Upstream (`@deepseek-ai/dsh-host-open-in-app`, pin fb2c4b9e = dsh-v0.1.5-rc.2)
 * publishes three `webServer` route paths and their HTTP payloads here, and the
 * official browser half imports them over the `./shared` subpath. The chamber
 * fork replaces that transport: the catalog, icons and launches are served over
 * the instance's own generic RPC channel (`/api/<endpoint>`) as a typert Remote
 * in the `openInApp` namespace, guarded by the instance's own connection /
 * gateway fence instead of a second, self-built route fence. These constants
 * therefore name METHODS, not paths, and there is no route to register.
 *
 * The chamber client plugin (`@dsh-chamber/dsh-chamber-client-ui-open-in`)
 * keeps its own mirror of the names below because it is a browser package and
 * cannot import this Node-side module; `test/…/open-in-wire-lockstep.test.ts`
 * reads THIS file and fails when the two sides drift.
 */

/** Typert Remote namespace this host domain occupies. */
export const OPEN_IN_APP_REMOTE_NAMESPACE = 'openInApp'

/** The domain's methods, in probe/read/launch order. */
export const OPEN_IN_APP_METHODS = ['probe', 'apps', 'icon', 'open'] as const

/** One method name of {@link OPEN_IN_APP_METHODS}. */
export type OpenInAppMethod = (typeof OPEN_IN_APP_METHODS)[number]

/**
 * The cheap activation-probe method (`namespace/method` form — the shape
 * `HOST_DOMAIN_PROBE_NAMES` / the gateway probe map expect). Presence plus
 * protocol only: no catalog detection, no process spawn, no filesystem walk.
 */
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

/**
 * `icon()` result. `mime` mirrors the upstream `OpenInAppIcon.contentType`
 * union; `dataBase64` is the raw icon bytes so the browser can build a `data:`
 * URL without a second same-origin route (design 20 §4.1/§10).
 */
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

/** One code of {@link OPEN_IN_APP_ERROR_CODES}. */
export type OpenInAppErrorCode = (typeof OPEN_IN_APP_ERROR_CODES)[number]

/** One domain failure as it crosses the wire. */
export interface OpenInAppDomainError {
  readonly code: OpenInAppErrorCode
  readonly message: string
  /** True when the same request may succeed later (transient host state). */
  readonly retryable?: boolean
}

/**
 * Explicit business carrier: the generic dsh gateway does not preserve thrown
 * error fields, so every method answers with this shape (git-worktree /
 * archive-cleanup parity) and only unexpected internal failures escape as
 * throws.
 */
export type OpenInAppDomainResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: OpenInAppDomainError }
