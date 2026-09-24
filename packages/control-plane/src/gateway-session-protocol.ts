/**
 * Gateway wire-protocol credential/session constants — THE single source for
 * the facts shared by every owner of the gateway transport chain: the gateway
 * server (cookie issuer, token & password gates), instance-proxy.ts (proxy
 * credential injection gate: Bearer/Cookie bounds at register time) and the
 * desktop client (login exchange, cached-cookie expiry, form mirrors).
 *
 * Hard-coding these per owner (cookie name, 12h TTL, 32–4096 visible-ASCII
 * bearer, 12–1024-character password, 4096-char cookie value) would let a
 * single-site change pass CI while silently breaking the chain. Units are the
 * wire contract's: seconds for the TTL, characters for the bounds.
 */

/** The 12h session cookie name. */
export const GATEWAY_SESSION_COOKIE_NAME = 'dsh_gateway_session'
/** Server-side session TTL, in seconds (12 hours). */
export const GATEWAY_SESSION_TTL_SECONDS = 12 * 60 * 60
/** Max cookie VALUE characters accepted by the proxy injection gate and the desktop login cache. */
export const GATEWAY_SESSION_COOKIE_VALUE_MAX_CHARS = 4096
/** Shared bearer token: minimum characters. */
export const GATEWAY_TOKEN_MIN_CHARS = 32
/** Shared bearer token: maximum characters. */
export const GATEWAY_TOKEN_MAX_CHARS = 4096
/** Token character set: visible ASCII only — control bytes would allow header injection. */
export const GATEWAY_TOKEN_VISIBLE_ASCII_PATTERN = /^[\x20-\x7e]+$/
/** Login password: minimum JavaScript characters (JSON body; Unicode allowed, unlike bearer tokens). */
export const GATEWAY_PASSWORD_MIN_CHARS = 12
/** Login password: maximum JavaScript characters. */
export const GATEWAY_PASSWORD_MAX_CHARS = 1024
