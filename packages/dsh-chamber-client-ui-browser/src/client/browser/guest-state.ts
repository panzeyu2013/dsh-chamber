/**
 * Native guest state machine — the pure rules behind the lease, the pushed state
 * adoption and the failure projection (design 28 v3 §4; FW2 review fixes).
 *
 * Kept free of DOM/bridge calls so every race is testable under node:test: an
 * acquire that settles after dispose must release (never leak a main lease), a
 * pushed state is only adopted for the CURRENT lease, a forwarded page drops its
 * alias projection when the guest really navigated away, and an ack refusal must
 * surface as the failure bar instead of a silent no-op.
 */
import type { BrowserLoadError } from './BrowserFrame.ts'

/** One acquire answer as the bridge projects it. */
export type LeaseAck = { readonly ok: true; readonly lease: string } | { readonly ok: false; readonly code: string }

/** Decision after an acquire settles. */
export interface LeaseSettlePlan {
  /** Lease to adopt (undefined = refuse it). */
  readonly adopt?: string
  /** Lease main already minted although this occurrence is gone: release it now. */
  readonly release?: string
  /** Failure description for the failure bar (undefined = no error). */
  readonly failure?: string
}

/**
 * Decide what to do with an acquire answer.
 *
 * @param disposed - the occurrence was disposed while the acquire was in flight.
 * @param ack - the bridge answer.
 * @returns the adoption/release plan; a disposed occurrence NEVER adopts and
 *   releases an already-minted lease immediately (main must not keep a listener
 *   whose only consumer is gone).
 */
export function planLeaseSettle(disposed: boolean, ack: LeaseAck): LeaseSettlePlan {
  if (!ack.ok) return disposed ? {} : { failure: ack.code }
  if (disposed) return { release: ack.lease }
  return { adopt: ack.lease }
}

/** Whether one pushed state belongs to this occurrence's current lease. */
export function acceptsStatePush(
  disposed: boolean,
  expectedTabId: string,
  pushed: { readonly tabId: string; readonly lease: string },
  lease: string | undefined,
): boolean {
  if (disposed) return false
  if (pushed.tabId !== expectedTabId) return false
  // A push that arrives before (or after) the lease is not provably ours: drop it.
  return lease !== undefined && pushed.lease === lease
}

/** Project one refused invoke into the failure bar (clears loading). */
export function projectAckFailure(ack: { readonly ok: boolean; readonly code?: string }): BrowserLoadError | undefined {
  if (ack.ok) return undefined
  return { code: undefined, description: typeof ack.code === 'string' && ack.code !== '' ? ack.code : 'unknown' }
}

/** Forwarded-alias bookkeeping derived from a pushed URL. */
export interface ForwardedTransition {
  /** Still displaying a forwarded page (the alias origin won the push). */
  readonly forwarded: boolean
  /** Alias origin to keep (undefined = not forwarded). */
  readonly origin?: string
  /** True when the guest moved to a different page: adopt the pushed URL. */
  readonly adopt: boolean
}

/**
 * Reconcile the forwarded projection with a pushed URL.
 *
 * A forwarded page keeps the LOGICAL address while the guest stays on this
 * record's alias origin. Any other pushed URL means the guest really navigated
 * away: the alias projection is dropped and the pushed URL becomes the address.
 *
 * @param forwarded - whether this occurrence currently displays a forwarded page.
 * @param aliasOrigin - canonical origin of the forwarded alias, if any.
 * @param url - the pushed guest URL.
 * @returns the next forwarded state and whether to adopt the URL into history.
 */
export function transitionForwarded(forwarded: boolean, aliasOrigin: string | undefined, url: string): ForwardedTransition {
  const origin = canonicalOrigin(url)
  if (forwarded && aliasOrigin !== undefined && origin === aliasOrigin) {
    return { forwarded: true, origin: aliasOrigin, adopt: false }
  }
  return { forwarded: false, adopt: true }
}

/**
 * Gate a late forward-needed negotiation answer (RT-03, R4-01).
 *
 * Main suspends a guest navigation to a loopback target B and asks the renderer to
 * attach a forward lease. The answer may arrive after the tab disposed, after a
 * newer navigation started, or after the lease changed -- any of those must drop
 * the negotiation instead of overriding the new navigation.
 *
 * The pushed URL is B, the SUSPENDED target, never the address currently on screen
 * (A != B for an in-page link). Comparing it with the current address would drop
 * every such negotiation, so the URL is checked by class only
 * (see isLoopbackNegotiationTarget).
 *
 * @param gates - the snapshots captured before the negotiation started.
 * @returns true only when every gate still holds.
 */
export function acceptsForwardNegotiation(gates: {
  readonly disposed: boolean
  readonly generationMatches: boolean
  readonly leaseMatches: boolean
}): boolean {
  return !gates.disposed && gates.generationMatches && gates.leaseMatches
}

/**
 * Host comparison form (single source; mirrors the pre-IPv4/IPv6 steps of Swift
 * `BrowserGuestPolicy.canonicalHost`): trim, lowercase and strip every trailing
 * dot, so the FQDN root spelling `localhost.` compares equal to `localhost`
 * (D6 tail-dot ruling). URL-parsed hosts are already lowercase; the normalization
 * still keeps untrusted pushed spellings and hand-built hosts on one rule.
 *
 * @param host - a URL hostname (an IPv6 literal keeps its brackets).
 * @returns the comparison form.
 */
export function normalizeForwardHost(host: string): string {
  let value = host.trim().toLowerCase()
  while (value.endsWith('.')) value = value.slice(0, -1)
  return value
}

/**
 * Loopback hostnames main may negotiate a forward lease for (design 28 §2.10).
 *
 * Swift's canonicalHost normalizes the mapped IPv6 spellings to 127.0.0.1 before
 * it decides to push forward-needed, so the renderer's class gate must accept
 * them too (m1); the resolver then answers the failure bar (the forward target
 * set is only 127.0.0.1/localhost). `[::ffff:127.0.0.1]` parses to
 * `[::ffff:7f00:1]`, and both spellings are listed so the contract reads whole.
 */
const NEGOTIATION_HOSTS: ReadonlySet<string> = new Set([
  '127.0.0.1',
  'localhost',
  '[::1]',
  '[::ffff:7f00:1]',
  '[::ffff:127.0.0.1]',
])

/**
 * Whether a pushed forward-needed URL is a loopback navigation target.
 *
 * Main only pushes loopback targets; the renderer refuses to act on anything else
 * rather than trusting the push blindly. Non-http(s) and unparsable input is not a
 * negotiation target. Hosts are compared in {@link normalizeForwardHost} form, so
 * `localhost.` (the FQDN root spelling) is the same target as `localhost`.
 *
 * @param url - the URL main pushed in the forward-needed push.
 * @returns true when it is an http(s) URL on a loopback host.
 */
export function isLoopbackNegotiationTarget(url: string): boolean {
  let parsed: URL
  try { parsed = new URL(url) } catch { return false }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  return NEGOTIATION_HOSTS.has(normalizeForwardHost(parsed.hostname))
}

/** Application-history cursor action for one adopted guest URL. */
export type HistoryAdoptAction<T> =
  | { readonly kind: 'reuse'; readonly index: number }
  | { readonly kind: 'append'; readonly entries: readonly T[]; readonly index: number }

/**
 * Decide what an adopted guest URL does to the application history (R2-B).
 *
 * Back/forward moves the guest to an EXISTING entry: the cursor moves, nothing is
 * appended (otherwise every back/forward would pollute history). A genuinely new
 * URL appends after the cursor and drops the forward branch.
 *
 * @param urls - current application history URLs in order.
 * @param index - current cursor (-1 = empty).
 * @param nextUrl - the guest-reported URL.
 * @param same - equality on a normalized target (defaults to strict URL string).
 * @returns the cursor action.
 */
export function historyAdoptAction<T extends string>(
  urls: readonly T[],
  index: number,
  nextUrl: string,
): HistoryAdoptAction<T> {
  const existing = urls.findIndex(url => url === nextUrl)
  if (existing >= 0) return { kind: 'reuse', index: existing }
  const entries = urls.slice(0, index + 1)
  return { kind: 'append', entries, index: entries.length }
}

/** Canonical origin of an http(s) URL, or undefined when unparsable. */
export function canonicalOrigin(url: string): string | undefined {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
    return parsed.origin
  } catch {
    return undefined
  }
}