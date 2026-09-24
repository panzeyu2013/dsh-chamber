/**
 * Gateway session pre-expiry refresh: a gateway session lives 12h and the cached cookie already dies
 * 5min before the server-side TTL, yet the proxy rides the OLD cookie until the transport reconnects —
 * without a refresh, proxied requests answer 401 for the residual window. Re-login ~60s BEFORE expiry
 * for every password-authenticated gateway target (ssh tunnel and http direct alike) and RE-REGISTER.
 *
 * Armed on ready keyed per instance id (re-arm replaces the timer), disarmed when ready is left, and
 * the fired refresh re-checks live facts so a stale timer cannot clobber a newer registration. A
 * failed pre-expiry re-login keeps the old registration and retries at expiry; one that fails AFTER
 * the old cookie died triggers ONE controlled reconnect (verifyUp re-authenticates with the stored
 * password), only while still ready on the SAME origin, with no further timer armed.
 */

import { buildGatewaySessionOrigin } from './gateway-session.ts'
import type { GatewaySessionManager, GatewaySessionOrigin } from './gateway-session.ts'

/** Lead time before the cached session's expiry at which the refresh fires (~60s): the login has
 *  time to complete and the fresh cookie registers well before the server rejects the old one
 *  (the cached cookie dies at TTL − 5min, so the refresh lands at TTL − 6min). */
export const GATEWAY_SESSION_REFRESH_LEAD_MS = 60_000

/** Host authority presented through an SSH local-forward to a gateway: the SSH destination
 *  (`spec.host`) may be a ~/.ssh/config alias or arbitrary DNS name and is NOT the HTTP authority
 *  seen by the remote gateway, while the forward always terminates at remote 127.0.0.1:<remotePort>.
 *  Use that literal loopback authority for login, identity probe, proxying and the session cache key. */
export function gatewayTunnelAuthority(remotePort: number): string {
  if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) {
    throw new TypeError('gateway tunnel remote port must be an integer in 1..65535')
  }
  return `127.0.0.1:${remotePort}`
}

/** Build the session origin for a ready transport URL: an ssh tunnel endpoint is a loopback http
 *  origin, a direct http(s) endpoint is the configured origin — the SAME derivation verifyUp and the
 *  ready registration use, so the cached session key matches. `insecureHttp` is the scheme selector
 *  the session manager's origin gate requires (for a tunnel a scheme fact, not an "insecure"
 *  judgement). `spkiPin` rides the origin, so the refresh login is pinned exactly like verifyUp.
 *  Returns null for a structurally invalid URL (programmer-error guard). */
export function gatewaySessionOriginForUrl(
  url: string,
  spkiPin?: string,
  authority?: string,
  scope?: string,
): GatewaySessionOrigin | null {
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
  if (scope === undefined) return null
  return buildGatewaySessionOrigin({
    baseUrl: url,
    insecureHttp: parsed.protocol === 'http:',
    scope,
    spkiPin,
    authority,
  })
}

/** Dependency seams (main.ts wires the real surfaces; tests inject fakes). */
export interface GatewaySessionRefreshDeps {
  /** The wired session manager (gateway-session.ts). */
  sessionManager: Pick<GatewaySessionManager, 'ensureSession' | 'expiresAt'>
  /** The stored gateway login password for an instance, or null. */
  passwordFor(id: string): string | null
  /** The stored gateway token, or null. Token and password are independent OR-principals: when both
   *  exist the fresh registration carries Authorization AND Cookie, so refresh preserves the bearer. */
  tokenFor(id: string): string | null
  /** The instance's current ready transport URL, or null when not ready. */
  readyUrlFor(id: string): string | null
  /** The configured SPKI certificate pin, or null — rides the re-registration AND the refresh login
   *  origin exactly like the ready registration, so a pinned internal-CA gateway never fails the
   *  refresh as an untrusted-chain network failure. */
  tlsPinFor(id: string): string | null
  /** The upstream Host override for an ssh-tunneled gateway target (the remote loopback authority,
   *  e.g. `127.0.0.1:30801`), or undefined for direct endpoints — rides the refresh login origin AND
   *  the re-registration so the session key and proxy Host stay consistent with the verifyUp session. */
  authorityFor(id: string): string | undefined
  /** Stable connection/target session scope; required for every shipped gateway target so local
   *  tunnel-port reuse can never cross connections. */
  scopeFor(id: string): string | undefined
  /** Re-register the instance transport — REPLACES the previous baseUrl/headers (control-plane
   *  registerInstanceTransport semantics), so the proxy's injected Cookie becomes the fresh session. */
  register(id: string, url: string, headers: Record<string, string> | undefined, tls: { tls: { spkiPin: string } } | undefined, authority: string | undefined): void
  /**
   * Controlled reconnect of one instance's transport — the bounded recovery for a re-login that
   * failed AFTER the old cookie died, without which a healthy transport would ride the dead cookie
   * and the proxy would answer 401 indefinitely. Wired to the transport runtime's EXISTING public
   * API: disconnect (emits idle → the control plane unregisters and this refresh disarms) then
   * connect (a fresh transport whose verifyUp re-authenticates with the stored password). Called AT
   * MOST once per refresh fire and only while still ready on the same origin; must never throw into
   * the refresh controller.
   */
  reconnect(id: string): void
  /** Non-secret warning logger (residual-window reports never carry a credential or cookie value). */
  warn(message: string): void
  /** Epoch-ms clock (defaults to Date.now; must match the session manager's clock). */
  now?(): number
  /** Timer scheduling (defaults to global unref'd setTimeout; tests capture callbacks). */
  schedule?(fn: () => void, delayMs: number): unknown
  cancel?(timer: unknown): void
}

/** The refresh controller surface. */
export interface GatewaySessionRefresh {
  /** Arm (or re-arm) the pre-expiry refresh. No-op for a non-password / not-ready / no-session
   *  target; a simultaneous bearer token does not shadow the independent password session. */
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
  const timers = new Map<string, { handle: unknown; epoch: number }>()
  /** Per-id connection generation: arm AND disarm advance it, so an old in-flight login cannot
   *  affect a deleted/recreated connection even when every visible fact is identical. */
  const epochs = new Map<string, number>()

  function bumpEpoch(id: string): number {
    const next = (epochs.get(id) ?? 0) + 1
    epochs.set(id, next)
    return next
  }

  function epochIsCurrent(id: string, epoch: number): boolean {
    return epochs.get(id) === epoch
  }

  function clearTimer(id: string): void {
    const timer = timers.get(id)
    if (timer !== undefined) {
      cancel(timer.handle)
      timers.delete(id)
    }
  }

  function scheduleRefresh(id: string, epoch: number, delayMs: number): void {
    if (!epochIsCurrent(id, epoch)) return
    const handle = schedule(() => { void refresh(id, epoch) }, delayMs)
    // A custom scheduler may synchronously trigger a generation change.
    if (!epochIsCurrent(id, epoch)) {
      cancel(handle)
      return
    }
    timers.set(id, { handle, epoch })
  }

  interface RefreshFacts {
    password: string
    token: string | null
    url: string
    pin: string | null
    authority: string | undefined
    scope: string
    origin: GatewaySessionOrigin
  }

  function liveFacts(id: string): RefreshFacts | null {
    const password = deps.passwordFor(id)
    const url = deps.readyUrlFor(id)
    if (password === null || url === null) return null
    const pin = deps.tlsPinFor(id)
    const authority = deps.authorityFor(id)
    const scope = deps.scopeFor(id)
    if (scope === undefined) return null
    const origin = gatewaySessionOriginForUrl(url, pin ?? undefined, authority, scope)
    if (origin === null) return null
    return { password, token: deps.tokenFor(id), url, pin, authority, scope, origin }
  }

  function factsAreCurrent(id: string, epoch: number, facts: RefreshFacts): boolean {
    return epochIsCurrent(id, epoch)
      && deps.passwordFor(id) === facts.password
      && deps.tokenFor(id) === facts.token
      && deps.readyUrlFor(id) === facts.url
      && deps.tlsPinFor(id) === facts.pin
      && deps.authorityFor(id) === facts.authority
      && deps.scopeFor(id) === facts.scope
  }

  /** The refresh fire: re-check live facts, re-login, re-register with the fresh cookie, re-arm. */
  async function refresh(id: string, epoch: number): Promise<void> {
    const scheduled = timers.get(id)
    if (scheduled?.epoch === epoch) timers.delete(id)
    if (!epochIsCurrent(id, epoch)) return
    // In-flight guard: the transport may have left ready / the password may have been cleared
    // since arming (disarm covers the status path; this is the race guard).
    const facts = liveFacts(id)
    if (facts === null) return
    // The refresh login carries the SPKI pin and tunnel Host override exactly like verifyUp, so an
    // internal-CA gateway re-authenticates pre-expiry and the session key matches the verifyUp one.
    const login = await deps.sessionManager.ensureSession(facts.origin, facts.password)
    // The await is the ownership boundary: a disarm/re-arm (including a delete→same-id/same-origin
    // recreate) or any credential/TLS/authority change makes this result stale even if the ready URL
    // compares equal.
    if (!factsAreCurrent(id, epoch, facts)) return
    if (!login.ok) {
      // Pre-expiry re-login failed (network / rate-limited / auth-busy): the OLD cookie stays
      // registered and valid until its expiry — retry AT that instant. If it is already past (or the
      // cache entry is gone) the proxy rides a dead cookie: warn honestly and trigger ONE controlled
      // reconnect so verifyUp re-authenticates with the stored password.
      const expiresAt = deps.sessionManager.expiresAt(facts.origin)
      if (expiresAt !== null && expiresAt > now()) {
        if (factsAreCurrent(id, epoch, facts)) scheduleRefresh(id, epoch, expiresAt - now())
        return
      }
      // The old cookie is dead (expired or evicted). Guarded recovery: only while STILL ready on the
      // SAME origin — a mid-login reconnect already re-authenticated under the new origin (the ready
      // handler owns it), and a transport that left ready has nothing to recover. Exactly once per
      // fire: this path arms no new timer and a fresh ready re-arms instead.
      if (!factsAreCurrent(id, epoch, facts)) return
      deps.warn(
        `gateway session refresh failed for ${id} (${login.error}) and the registered session has expired — the proxy was answering 401 on the dead cookie; triggering one controlled reconnect so verifyUp re-authenticates with the stored password`,
      )
      // A logger is an injected boundary too: re-check before the externally visible reconnect.
      if (factsAreCurrent(id, epoch, facts)) deps.reconnect(id)
      return
    }
    // The tunnel may have reconnected mid-login (new local port → new origin): the ready handler
    // already re-registered under it — never clobber that with a stale URL.
    if (!factsAreCurrent(id, epoch, facts)) return
    deps.register(
      id,
      facts.url,
      {
        ...(facts.token === null ? {} : { authorization: `Bearer ${facts.token}` }),
        cookie: login.cookie,
      },
      facts.pin === null ? undefined : { tls: { spkiPin: facts.pin } },
      facts.authority,
    )
    // The fresh session has a new 12h window — re-arm for its expiry.
    arm(id)
  }

  function arm(id: string): void {
    clearTimer(id)
    const epoch = bumpEpoch(id)
    // Only targets with a password session have anything to refresh; a coexisting bearer is
    // preserved in the replacement registration and never suppresses the independent session.
    const facts = liveFacts(id)
    if (facts === null) return
    // The armed login (and cached-session key) rides the pin and tunnel Host override — same key as verifyUp.
    const expiresAt = deps.sessionManager.expiresAt(facts.origin)
    if (expiresAt === null) return
    scheduleRefresh(id, epoch, Math.max(0, expiresAt - now() - GATEWAY_SESSION_REFRESH_LEAD_MS))
  }

  return {
    arm,
    disarm: id => {
      clearTimer(id)
      bumpEpoch(id)
    },
    dispose() {
      for (const id of new Set([...epochs.keys(), ...timers.keys()])) {
        clearTimer(id)
        bumpEpoch(id)
      }
    },
  }
}
