/**
 * Gateway session pre-expiry refresh (design 17 §9.3 live-proxy self-healing).
 *
 * The ready registration captures the session Cookie in the control plane's
 * proxy headers at register time. A gateway session lives 12h; the manager's
 * cached cookie already dies 5min before the server-side TTL
 * (GATEWAY_SESSION_EXPIRY_SKEW_MS, gateway-session.ts), and the proxy keeps
 * riding the OLD cookie value until the transport reconnects — without a
 * refresh, the proxied requests answer 401 for up to the full residual
 * window. This module schedules a re-login ~60s BEFORE the cached session's
 * expiry instant for every registered password-authenticated gateway target
 * (ssh tunnel and http direct alike) and RE-REGISTERS the transport with the
 * fresh cookie, so a healthy transport never rides an expired cookie.
 *
 * Scheduling discipline:
 * - armed on ready (main.ts onStatusChanged), keyed per instance id — re-arm
 *   replaces the pending timer (a reconnect re-arms under the new tunnel
 *   origin);
 * - disarmed the moment the instance leaves ready (disconnect / error /
 *   removal / app quit);
 * - the fired refresh re-checks the live facts (token priority, stored
 *   password, current ready URL) so a stale timer can never clobber a newer
 *   registration;
 * - a FAILED pre-expiry re-login (network / rate-limited / auth-busy) keeps
 *   the old registration — the old cookie is still valid until its expiry —
 *   and retries at the expiry instant; a re-login that fails AFTER the old
 *   cookie died triggers ONE controlled reconnect of the instance (the
 *   `reconnect` seam, wired to transport-manager's existing disconnect →
 *   connect public API): verifyUp re-authenticates with the stored password
 *   (the single re-login → terminal path, design 17 §9.3), so a healthy
 *   transport never rides a dead cookie answering 401 indefinitely (P2-1).
 *   The recovery is bounded — at most one reconnect per refresh fire, only
 *   while the transport is still ready on the SAME origin, and the failure
 *   path arms no further timer, so a fresh ready re-arms with the new
 *   session instead of storming.
 *
 * Pure main-process logic with injectable deps (clock, timer scheduling,
 * session manager, credential/URL lookups, the re-registration callback), so
 * the whole orchestration is unit-testable with node:test (see the refresh
 * cases in gateway-session.test.ts).
 */

import type { GatewaySessionManager, GatewaySessionOrigin } from './gateway-session.ts'

/** Lead time before the cached session's expiry instant at which the refresh
 * fires (~60s): the login has time to complete and the fresh cookie is
 * registered well before the server rejects the old one (the cached cookie
 * dies at TTL − 5min, so the refresh lands at TTL − 6min — over 5 minutes of
 * slack over the server-side 12h TTL). */
export const GATEWAY_SESSION_REFRESH_LEAD_MS = 60_000

/** Build the session origin for a ready transport URL (design 17 §9.3): the
 * ssh tunnel endpoint is a loopback http origin, a direct http(s) endpoint is
 * the configured origin — the SAME derivation the ssh provider's verifyUp and
 * the ready registration use, so the cached session key always matches.
 * `insecureHttp` is the scheme selector the session manager's origin gate
 * requires (http → true; for a tunnel this is a scheme fact, not an
 * "insecure" judgement — the ssh encryption protects the loopback hop).
 * `spkiPin` (S23, P1-2) rides the origin when provided, so the REFRESH login
 * is pinned exactly like the verifyUp login — a pinned internal-CA gateway
 * re-authenticates pre-expiry instead of failing as an untrusted-chain
 * network failure. Returns null for a structurally invalid URL (programmer-
 * error guard, mirrors instance-proxy's baseUrl gate). */
export function gatewaySessionOriginForUrl(url: string, spkiPin?: string, authority?: string): GatewaySessionOrigin | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  if (parsed.username !== '' || parsed.password !== ''
    || (parsed.pathname !== '/' && parsed.pathname !== '')
    || parsed.search !== '' || parsed.hash !== '') {
    return null
  }
  return {
    baseUrl: url,
    insecureHttp: parsed.protocol === 'http:',
    ...(spkiPin === undefined ? {} : { spkiPin }),
    ...(authority === undefined ? {} : { authority }),
  }
}

/** Dependency seams (main.ts wires the real surfaces; tests inject fakes). */
export interface GatewaySessionRefreshDeps {
  /** The wired session manager (gateway-session.ts). */
  sessionManager: Pick<GatewaySessionManager, 'ensureSession' | 'expiresAt'>
  /** The stored gateway login password for an instance, or null. */
  passwordFor(id: string): string | null
  /** The stored gateway token for an instance, or null. Token priority
   * (design 17 §2.3): a token-authenticated target has no session to
   * refresh, so arm() is a no-op while a token exists. */
  tokenFor(id: string): string | null
  /** The instance's current ready transport URL, or null when not ready. */
  readyUrlFor(id: string): string | null
  /** The instance's configured SPKI certificate pin (S23), or null — rides
   * the re-registration exactly like the ready registration AND the refresh
   * login origin (P1-2: the pre-expiry re-login is pinned like verifyUp's),
   * so a pinned internal-CA gateway never fails the refresh as an
   * untrusted-chain network failure. */
  tlsPinFor(id: string): string | null
  /** The instance's upstream Host override for an ssh-tunneled gateway
   * target (design 17 §9.3 隧道 Host 覆盖: the REMOTE gateway authority,
   * e.g. `192.168.110.172:30801`), or undefined for direct endpoints — rides
   * the refresh login origin AND the re-registration so the session key and
   * the proxy Host stay consistent with the verifyUp-minted session. */
  authorityFor(id: string): string | undefined
  /** Re-register the instance transport — REPLACES the previous
   * baseUrl/headers (control-plane registerInstanceTransport semantics), so
   * the proxy's injected Cookie becomes the fresh session. */
  register(id: string, url: string, headers: Record<string, string> | undefined, tls: { tls: { spkiPin: string } } | undefined, authority: string | undefined): void
  /**
   * Controlled reconnect of one instance's transport — the bounded recovery
   * for a re-login that failed AFTER the old cookie died (P2-1): without it
   * a healthy transport would ride the dead cookie and the proxy would
   * answer 401 indefinitely. Wired in main.ts to the transport runtime's
   * EXISTING public API (transport-manager has no single reconnect entry):
   * disconnect (emits idle → the control plane unregisters and this refresh
   * disarms) then connect (a fresh transport whose verifyUp re-authenticates
   * with the stored password — the single re-login → terminal path, design
   * 17 §9.3). The controller calls this AT MOST once per refresh fire and
   * only while the transport is still ready on the same origin, so no
   * reconnect storm and no re-entry into a refresh the transport already
   * left. Must never throw into the refresh controller (main.ts catches).
   */
  reconnect(id: string): void
  /** Non-secret warning logger (residual-window reports never carry a
   * credential or cookie value). */
  warn(message: string): void
  /** Epoch-ms clock (defaults to Date.now; must match the session manager's
   * clock — main.ts uses the default for both, tests inject one clock). */
  now?(): number
  /** Timer scheduling (defaults to global setTimeout — unref'd so app quit
   * is never held; tests capture callbacks instead of waiting real hours). */
  schedule?(fn: () => void, delayMs: number): unknown
  cancel?(timer: unknown): void
}

/** The refresh controller surface. */
export interface GatewaySessionRefresh {
  /** Arm (or re-arm) the pre-expiry refresh for one instance. No-op for a
   * non-password / token-authenticated / not-ready / no-session target. */
  arm(id: string): void
  /** Cancel the instance's pending refresh (leaving ready / removal / quit). */
  disarm(id: string): void
  /** Cancel every pending refresh (app quit). */
  dispose(): void
}

export function createGatewaySessionRefresh(deps: GatewaySessionRefreshDeps): GatewaySessionRefresh {
  const now = deps.now ?? (() => Date.now())
  const schedule = deps.schedule ?? ((fn: () => void, ms: number) => {
    const timer = setTimeout(fn, ms)
    // Never hold the app open for a refresh (quit / disconnect disarm).
    timer.unref?.()
    return timer
  })
  const cancel = deps.cancel ?? ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>))
  const timers = new Map<string, unknown>()

  function clearTimer(id: string): void {
    const timer = timers.get(id)
    if (timer !== undefined) {
      cancel(timer)
      timers.delete(id)
    }
  }

  /** The refresh fire: re-check the live facts, re-login, re-register with
   * the fresh cookie, and re-arm for the new session's expiry. */
  async function refresh(id: string): Promise<void> {
    timers.delete(id)
    // In-flight guard: the transport may have left ready / a token may have
    // been configured / the password cleared since the timer was armed
    // (disarm covers the status path; this is the race guard).
    if (deps.tokenFor(id) !== null) return
    const password = deps.passwordFor(id)
    if (password === null) return
    const url = deps.readyUrlFor(id)
    if (url === null) return
    // P1-2: the refresh login carries the configured SPKI pin (S23) exactly
    // like the verifyUp login — an internal-CA gateway re-authenticates
    // pre-expiry instead of failing as an unpinned untrusted-chain 'network'.
    // The tunnel Host override (design 17 §9.3 隧道 Host 覆盖) rides the same
    // origin so the refresh session key matches the verifyUp-minted one.
    const origin = gatewaySessionOriginForUrl(url, deps.tlsPinFor(id) ?? undefined, deps.authorityFor(id))
    if (origin === null) return
    const login = await deps.sessionManager.ensureSession(origin, password)
    if (!login.ok) {
      // Pre-expiry re-login failed (network / rate-limited / auth-busy). The
      // OLD cookie stays registered and remains valid until its expiry
      // instant — retry AT that instant. If it is already past (or the cache
      // entry is gone), the proxy rides a dead cookie: warn honestly and
      // trigger ONE controlled reconnect so verifyUp re-authenticates with
      // the stored password — a healthy transport must never answer 401
      // indefinitely (P2-1 bounded recovery, design 17 §9.3).
      const expiresAt = deps.sessionManager.expiresAt(origin)
      if (expiresAt !== null && expiresAt > now()) {
        timers.set(id, schedule(() => { void refresh(id) }, expiresAt - now()))
        return
      }
      // The old cookie is dead (expired or evicted). Guarded recovery: only
      // while the transport is STILL ready on the SAME origin — a mid-login
      // reconnect already re-authenticated under the new origin (the ready
      // handler owns it, never clobber it with a duplicate reconnect), and a
      // transport that left ready has nothing to recover. Exactly once per
      // refresh fire: the failure path arms no new timer, and a fresh ready
      // re-arms with the new session — no reconnect storm, no re-entry.
      if (deps.readyUrlFor(id) === url) {
        deps.warn(
          `gateway session refresh failed for ${id} (${login.error}) and the registered session has expired — the proxy was answering 401 on the dead cookie; triggering one controlled reconnect so verifyUp re-authenticates with the stored password`,
        )
        deps.reconnect(id)
      } else {
        deps.warn(
          `gateway session refresh failed for ${id} (${login.error}) and the registered session has expired — the transport already left the old origin (reconnected or disconnected), so its fresh ready re-authenticates with the stored password`,
        )
      }
      return
    }
    // The tunnel may have reconnected while the login was in flight (a new
    // local port → a new origin): the ready handler already re-logged in and
    // re-registered under the new origin — never clobber it with a stale URL.
    const currentUrl = deps.readyUrlFor(id)
    if (currentUrl === null || currentUrl !== url) {
      arm(id)
      return
    }
    const pin = deps.tlsPinFor(id)
    deps.register(id, url, { cookie: login.cookie }, pin === null ? undefined : { tls: { spkiPin: pin } }, deps.authorityFor(id))
    // The fresh session has a new 12h window — re-arm for its expiry.
    arm(id)
  }

  function arm(id: string): void {
    clearTimer(id)
    // Only password-authenticated gateway targets hold a session to refresh:
    // token auth never expires, a target without a stored password has
    // nothing to re-exchange, and a not-ready transport has no registered
    // cookie to replace (the ready handler arms when it comes ready).
    if (deps.tokenFor(id) !== null) return
    if (deps.passwordFor(id) === null) return
    const url = deps.readyUrlFor(id)
    if (url === null) return
    // P1-2: the armed login (and the cached-session key) rides the pin and
    // the tunnel Host override (design 17 §9.3) — same key as verifyUp.
    const origin = gatewaySessionOriginForUrl(url, deps.tlsPinFor(id) ?? undefined, deps.authorityFor(id))
    if (origin === null) return
    const expiresAt = deps.sessionManager.expiresAt(origin)
    if (expiresAt === null) return
    timers.set(id, schedule(() => { void refresh(id) }, Math.max(0, expiresAt - now() - GATEWAY_SESSION_REFRESH_LEAD_MS)))
  }

  return {
    arm,
    disarm: id => clearTimer(id),
    dispose() {
      for (const id of [...timers.keys()]) clearTimer(id)
    },
  }
}
