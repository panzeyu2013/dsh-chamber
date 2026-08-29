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
 * - the fired refresh re-checks the live facts (independent bearer token,
 *   stored password, current ready URL) so a stale timer can never clobber a newer
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

/** Host authority presented through an SSH local-forward to a gateway. The
 * SSH destination (`spec.host`) may be a ~/.ssh/config alias or arbitrary DNS
 * name and is NOT the HTTP authority seen by the remote gateway. The forward
 * always terminates at remote 127.0.0.1:<remotePort>, so use that literal
 * loopback authority consistently for login, identity probe, proxying and the
 * session cache key (design 17 §9.2/§9.3). */
export function gatewayTunnelAuthority(remotePort: number): string {
  if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) {
    throw new TypeError('gateway tunnel remote port must be an integer in 1..65535')
  }
  return `127.0.0.1:${remotePort}`
}

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
  return {
    baseUrl: url,
    insecureHttp: parsed.protocol === 'http:',
    ...(spkiPin === undefined ? {} : { spkiPin }),
    ...(authority === undefined ? {} : { authority }),
    scope,
  }
}

/** Dependency seams (main.ts wires the real surfaces; tests inject fakes). */
export interface GatewaySessionRefreshDeps {
  /** The wired session manager (gateway-session.ts). */
  sessionManager: Pick<GatewaySessionManager, 'ensureSession' | 'expiresAt'>
  /** The stored gateway login password for an instance, or null. */
  passwordFor(id: string): string | null
  /** The stored gateway token for an instance, or null. Token and password
   * are independent OR-principals (design 17 §2.3): when both exist the fresh
   * registration carries Authorization AND Cookie, so refresh must preserve
   * the bearer while rotating the session. */
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
   * target (design 17 §9.3 隧道 Host 覆盖: the remote loopback destination
   * authority, e.g. `127.0.0.1:30801`), or undefined for direct endpoints — rides
   * the refresh login origin AND the re-registration so the session key and
   * the proxy Host stay consistent with the verifyUp-minted session. */
  authorityFor(id: string): string | undefined
  /** Stable connection/target session scope. Required for every shipped
   * gateway target so local tunnel-port reuse can never cross connections. */
  scopeFor(id: string): string | undefined
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
   * non-password / not-ready / no-session target. A simultaneous bearer token
   * does not shadow the independent password session. */
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
  /** Per-id connection generation. arm AND disarm advance it, so an old
   * in-flight login cannot affect a deleted/recreated connection even when
   * the id, direct URL, password and every other visible fact are identical. */
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

  /** The refresh fire: re-check the live facts, re-login, re-register with
   * the fresh cookie, and re-arm for the new session's expiry. */
  async function refresh(id: string, epoch: number): Promise<void> {
    const scheduled = timers.get(id)
    if (scheduled?.epoch === epoch) timers.delete(id)
    if (!epochIsCurrent(id, epoch)) return
    // In-flight guard: the transport may have left ready / the password may
    // have been cleared since the timer was armed
    // (disarm covers the status path; this is the race guard).
    const facts = liveFacts(id)
    if (facts === null) return
    // P1-2: the refresh login carries the configured SPKI pin (S23) exactly
    // like the verifyUp login — an internal-CA gateway re-authenticates
    // pre-expiry instead of failing as an unpinned untrusted-chain 'network'.
    // The tunnel Host override (design 17 §9.3 隧道 Host 覆盖) rides the same
    // origin so the refresh session key matches the verifyUp-minted one.
    const login = await deps.sessionManager.ensureSession(facts.origin, facts.password)
    // The await is the ownership boundary. A disarm/re-arm (including a
    // delete→same-id/same-origin recreate) or any credential/TLS/authority
    // change makes this result stale even if the ready URL compares equal.
    if (!factsAreCurrent(id, epoch, facts)) return
    if (!login.ok) {
      // Pre-expiry re-login failed (network / rate-limited / auth-busy). The
      // OLD cookie stays registered and remains valid until its expiry
      // instant — retry AT that instant. If it is already past (or the cache
      // entry is gone), the proxy rides a dead cookie: warn honestly and
      // trigger ONE controlled reconnect so verifyUp re-authenticates with
      // the stored password — a healthy transport must never answer 401
      // indefinitely (P2-1 bounded recovery, design 17 §9.3).
      const expiresAt = deps.sessionManager.expiresAt(facts.origin)
      if (expiresAt !== null && expiresAt > now()) {
        if (factsAreCurrent(id, epoch, facts)) scheduleRefresh(id, epoch, expiresAt - now())
        return
      }
      // The old cookie is dead (expired or evicted). Guarded recovery: only
      // while the transport is STILL ready on the SAME origin — a mid-login
      // reconnect already re-authenticated under the new origin (the ready
      // handler owns it, never clobber it with a duplicate reconnect), and a
      // transport that left ready has nothing to recover. Exactly once per
      // refresh fire: the failure path arms no new timer, and a fresh ready
      // re-arms with the new session — no reconnect storm, no re-entry.
      if (!factsAreCurrent(id, epoch, facts)) return
      deps.warn(
        `gateway session refresh failed for ${id} (${login.error}) and the registered session has expired — the proxy was answering 401 on the dead cookie; triggering one controlled reconnect so verifyUp re-authenticates with the stored password`,
      )
      // A logger is an injected boundary too. Re-check after it before the
      // externally visible reconnect side effect.
      if (factsAreCurrent(id, epoch, facts)) deps.reconnect(id)
      return
    }
    // The tunnel may have reconnected while the login was in flight (a new
    // local port → a new origin): the ready handler already re-logged in and
    // re-registered under the new origin — never clobber it with a stale URL.
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
    // Only targets with a password session have anything to refresh. A bearer
    // may coexist and is preserved in the replacement registration; it must
    // never suppress the independently configured session.
    const facts = liveFacts(id)
    if (facts === null) return
    // P1-2: the armed login (and the cached-session key) rides the pin and
    // the tunnel Host override (design 17 §9.3) — same key as verifyUp.
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
