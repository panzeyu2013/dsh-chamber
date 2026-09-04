/**
 * Gateway wire-protocol credential/session constants — THE single source for
 * the gateway session protocol facts shared by every owner of the gateway
 * transport chain (design 17 §7.1 / §13.5, S23):
 *
 *   - packages/gateway/src/auth.ts + config.ts — the SERVER (cookie issuer /
 *     token & password gates);
 *   - packages/control-plane/src/instance-proxy.ts — the PROXY credential
 *     injection gate (Bearer/Cookie bounds, enforced at register time);
 *   - packages/desktop gateway-session.ts / gateway-provider.ts — the CLIENT
 *     (login exchange, cached-cookie expiry, form validation mirrors).
 *
 * Before this module each owner hard-coded the same facts (cookie name, 12h
 * TTL, 32–4096 visible-ASCII bearer, 12–1024-character password, 4096-char
 * cookie value) with zero cross-side tests: any single-site change passed CI
 * while silently breaking the chain (clock-skewed cookies, rejected tokens).
 * The gateway server and the desktop client both import this module (the
 * desktop through control-plane-module.ts, the dual-path facade), so the
 * facts can no longer drift between the shapes. Unit choice: the wire
 * contract is the SERVER's — seconds for the TTL, characters for the
 * bounds. Owners derive their own clock units locally (e.g. the desktop
 * multiplies TTL by 1000 for Date.now arithmetic and subtracts its own
 * 5-minute re-login skew).
 */

/** The 12h session cookie name (design 17 §7.1). */
export const GATEWAY_SESSION_COOKIE_NAME = 'dsh_gateway_session'
/** Server-side session TTL, in seconds (design 17 §7.1: 12 hours). */
export const GATEWAY_SESSION_TTL_SECONDS = 12 * 60 * 60
/** Maximum cookie VALUE characters the proxy injection gate and the desktop
 *  login cache accept (design 17 §9.3: `Cookie` bounded to the name + 4096). */
export const GATEWAY_SESSION_COOKIE_VALUE_MAX_CHARS = 4096
/** Shared bearer token: minimum characters (design 17 §5.2). */
export const GATEWAY_TOKEN_MIN_CHARS = 32
/** Shared bearer token: maximum characters (design 17 §5.2). */
export const GATEWAY_TOKEN_MAX_CHARS = 4096
/** Token character set: visible ASCII only (never control bytes — header
 *  injection is impossible on the wire). */
export const GATEWAY_TOKEN_VISIBLE_ASCII_PATTERN = /^[\x20-\x7e]+$/
/** Login password: minimum JavaScript characters (JSON body data; Unicode is
 *  allowed, unlike bearer tokens). */
export const GATEWAY_PASSWORD_MIN_CHARS = 12
/** Login password: maximum JavaScript characters. */
export const GATEWAY_PASSWORD_MAX_CHARS = 1024
