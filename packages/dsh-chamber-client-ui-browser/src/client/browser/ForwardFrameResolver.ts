/**
 * FORK DIFF — the SSH reverse proxy (the carrier's ONLY behavior difference).
 *
 * Upstream resolved a navigation target to the URL an iframe loaded. In v3 the
 * guest is a top-level document owned by main, and main composes every URL, so
 * the renderer only decides the TARGET SHAPE (design 28 §2.10/§3):
 *
 *   - local source / non-loopback host → direct URL (passed through verbatim);
 *   - ssh source + host `127.0.0.1`/`localhost` (FQDN root spellings like
 *     `localhost.` compare equal, D6) → attach the per-source SSH forward lease and
 *     answer `{ kind: 'forward', recordId, path }`; main loads the alias itself and
 *     the address bar/history keep the LOGICAL URL;
 *   - ssh source + an IPv6 loopback spelling (`[::1]`, the mapped
 *     127.0.0.1 form) → `undefined`: the forward target set above does not cover
 *     it and a DIRECT load would read THIS machine's loopback (design 28 §2.4/D6);
 *   - a refused attach → `undefined`, rendered as the upstream failure bar.
 *
 * `externalUrl` is display-only: the forwarded page's system-browser exit goes
 * to main's composed alias URL (never the remote loopback on this machine).
 *
 * Everything else (address parsing, persistence, multi-tab, copy) is upstream.
 */
import { BrowserForwardController } from '../../shared/browser-controller.ts'
import type { BrowserForwardBridge } from '../../shared/forward-bridge.ts'
import type { BrowserSource } from '../../shared/source.ts'
import { normalizeForwardHost } from './guest-state.ts'
import type { BrowserTarget } from './url.ts'

/** Construction inputs: the per-entry source proof and the trusted forward bridge. */
export interface ForwardFrameResolverOptions {
  /** The boot-bound source (local instance or an SSH-reached dsh/gateway source). */
  readonly source: BrowserSource
  /** Immutable boot proof every `forward.request` must carry. */
  readonly sourceFingerprint: string
  /** The trusted `chamberForward` bridge, or null on a page without the carrier. */
  readonly bridge: BrowserForwardBridge | null
}

/** The exact guest target one logical navigation resolves to (design 28 §3). */
export type BrowserTargetRef =
  | { readonly kind: 'direct'; readonly url: string }
  | {
    readonly kind: 'forward'
    readonly recordId: string
    readonly path: string
    /** Main-composed alias URL for the system-browser exit (display only). */
    readonly externalUrl: string
  }

/** The seam `NativeGuestImpl` consumes: logical target → guest target. */
export interface BrowserTargetRefResolver {
  /** @returns the guest target, or undefined when the forward attach failed. */
  resolve(target: BrowserTarget): Promise<BrowserTargetRef | undefined>
  /** Release every forward consumer this tab held; repeated calls are safe. */
  dispose(): Promise<void>
}

/** The two host spellings that mean "the REMOTE machine's loopback". */
const FORWARD_TARGET_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost'])

/**
 * Characters the Swift forward target accepts in a path component (single source
 * of truth: `BrowserGuestPolicy.isValidPercentEncodedComponent`, D3): RFC 3986
 * unreserved + sub-delims + ":" + "@" + "/". Every other ASCII character ([, ], |,
 * {, }, ^, backtick, quote, ...) is rejected there, so the renderer must encode it
 * before sending the forward target — the address bar keeps the LOGICAL URL.
 */
const FORWARD_PATH_ALLOWED: ReadonlySet<string> = new Set(
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~!$&\'()*+,;=:@/',
)
/** Query components share the path set and additionally allow a literal "?" (D3). */
const FORWARD_QUERY_ALLOWED: ReadonlySet<string> = new Set([...FORWARD_PATH_ALLOWED, '?'])

/** One strict %HH escape's two hex digits (Swift isASCIIHexDigit accepts both cases). */
function isHexDigit(value: string | undefined): boolean {
  return value !== undefined && /^[0-9A-Fa-f]$/u.test(value)
}

/**
 * Percent-encode one forward path/query component into the Swift-accepted set.
 *
 * Valid `%HH` escapes are preserved byte for byte (main feeds the result to
 * Foundation's `percentEncodedPath`/`percentEncodedQuery` setters, which take
 * ENCODED text — re-encoding would double-encode). A stray "%" becomes "%25".
 * Disallowed characters become UTF-8 %XX, so the server decodes the original
 * logical path.
 *
 * @param raw - one WHATWG URL component (pathname or query without its "?").
 * @param allowed - the component's accepted ASCII character set.
 * @returns the component with every byte accepted by Swift's normalizePath.
 */
function encodeForwardComponent(raw: string, allowed: ReadonlySet<string>): string {
  let out = ''
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index] as string
    if (char === '%') {
      if (isHexDigit(raw[index + 1]) && isHexDigit(raw[index + 2])) out += '%'
      else out += '%25'
      continue
    }
    if (allowed.has(char)) { out += char; continue }
    const codePoint = raw.codePointAt(index) as number
    if (codePoint > 0xffff) {
      // Astral code point: keep its surrogate pair together.
      out += encodeURIComponent(raw.slice(index, index + 2))
      index += 1
      continue
    }
    try {
      out += encodeURIComponent(char)
    } catch {
      // A lone surrogate cannot be UTF-8 encoded; substitute the WHATWG parser's
      // replacement character so one hostile byte sequence stays deterministic.
      out += '%EF%BF%BD'
    }
  }
  return out
}

/**
 * IPv6 loopback spellings are NOT forward targets (design 28 §2.4: the forward
 * target set is exactly `127.0.0.1` / `localhost`). The WHATWG URL parser
 * normalizes every expanded ::1 spelling to `[::1]`; the mapped form of
 * 127.0.0.1 is `[::ffff:7f00:1]`. A may-forward source must resolve these to the
 * failure bar (`undefined`), never to a DIRECT target: a direct guest load would
 * read THIS machine's loopback, and main's navigationOutcome refuses it anyway
 * (D6: the [::1] failure bar).
 */
const UNFORWARDABLE_LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['[::1]', '[::ffff:7f00:1]'])

/** One resolver per tab occurrence. */
export class ForwardFrameResolver implements BrowserTargetRefResolver {
  private readonly options: ForwardFrameResolverOptions
  private readonly controller: BrowserForwardController
  private disposed = false
  /** Serializes resolutions so attach-first ordering and releases stay deterministic. */
  private chain: Promise<void> = Promise.resolve()

  constructor(options: ForwardFrameResolverOptions) {
    this.options = options
    this.controller = new BrowserForwardController({
      source: options.source,
      sourceFingerprint: options.sourceFingerprint,
      transport: options.bridge,
    })
  }

  /** @param target - logical navigation target. @returns the exact guest target. */
  resolve(target: BrowserTarget): Promise<BrowserTargetRef | undefined> {
    const next = this.chain.then(async () => this.resolveSerial(target))
    this.chain = next.then(() => undefined, () => undefined)
    return next
  }

  /** Release every forward consumer this tab held (tab close / page disposal). */
  async dispose(): Promise<void> {
    this.disposed = true
    await this.chain
    await this.controller.dispose()
  }

  private async resolveSerial(target: BrowserTarget): Promise<BrowserTargetRef | undefined> {
    if (this.disposed) return undefined
    if (!this.mustForward(target)) {
      // D6: an IPv6-loopback target on a may-forward source is neither a forward
      // target nor a safe direct load — answer the failure bar, never `direct`.
      if (this.refusesDirect(target)) return undefined
      // A direct target ends any forwarded page in this pane: release its
      // consumer BEFORE the guest leaves the forwarded URL.
      if (this.controller.currentRecordId !== null) await this.controller.detachCurrent()
      return { kind: 'direct', url: target.url }
    }
    if (this.options.bridge === null) return undefined
    const request = this.forwardRequest(target)
    if (request === undefined) return undefined
    const outcome = await this.controller.attach(request)
    if (!outcome.ok) return undefined
    const record = outcome.record
    return {
      kind: 'forward',
      recordId: record.id,
      path: request.path,
      externalUrl: record.scheme + '://' + record.aliasHost + ':' + String(record.localPort) + request.path,
    }
  }

  /** Whether this target must ride the source's SSH reverse proxy. */
  private mustForward(target: BrowserTarget): boolean {
    if (!this.options.source.mayForward) return false
    try {
      // D6 tail-dot: the FQDN root spelling `localhost.` is the same remote
      // loopback target; the comparison form mirrors Swift canonicalHost.
      return FORWARD_TARGET_HOSTS.has(normalizeForwardHost(new URL(target.url).hostname))
    } catch {
      return false
    }
  }

  /**
   * Whether a may-forward source must refuse this non-forwardable loopback
   * DIRECTLY (D6). A local source keeps loading its own loopback.
   */
  private refusesDirect(target: BrowserTarget): boolean {
    if (!this.options.source.mayForward) return false
    try {
      return UNFORWARDABLE_LOOPBACK_HOSTS.has(normalizeForwardHost(new URL(target.url).hostname))
    } catch {
      return false
    }
  }

  /**
   * Extract the validated remote port/scheme/path from a logical target.
   *
   * MA1: the path/query are re-encoded into `BrowserGuestPolicy.normalizePath`'s
   * accepted character set. The WHATWG URL parser leaves `[ ] | ^ { } \`` and
   * friends literal in pathname/search, while Swift rejects them (invalidPayload),
   * so an unencoded forward target would silently fail for such links.
   */
  private forwardRequest(target: BrowserTarget): { port: number; scheme: 'http' | 'https'; path: string } | undefined {
    let url: URL
    try { url = new URL(target.url) } catch { return undefined }
    const scheme = target.kind === 'https' ? 'https' : 'http'
    const port = url.port === '' ? (scheme === 'https' ? 443 : 80) : Number(url.port)
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) return undefined
    const component = url.pathname === '' ? '/' : url.pathname
    const query = url.search.startsWith('?') ? url.search.slice(1) : ''
    const encoded = encodeForwardComponent(component, FORWARD_PATH_ALLOWED)
    return {
      port,
      scheme,
      path: query === '' ? encoded : encoded + '?' + encodeForwardComponent(query, FORWARD_QUERY_ALLOWED),
    }
  }
}

/** Build the per-tab resolver (one consumer lease per tab occurrence). */
export function createForwardFrameResolver(options: ForwardFrameResolverOptions): ForwardFrameResolver {
  return new ForwardFrameResolver(options)
}
