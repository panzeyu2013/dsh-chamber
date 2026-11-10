/**
 * FORK DIFF — the SSH reverse proxy (the carrier's ONLY behavior difference).
 *
 * Upstream resolved a navigation target to the URL an iframe loaded. In v3 the
 * guest is a top-level document owned by main, and main composes every URL, so
 * the renderer only decides the TARGET SHAPE (design 28 §2.10/§3):
 *
 *   - local source / non-loopback host → direct URL (passed through verbatim);
 *   - ssh source + host `127.0.0.1`/`localhost` → attach the per-source SSH
 *     forward lease and answer `{ kind: 'forward', recordId, path }`; main loads
 *     the alias itself and the address bar/history keep the LOGICAL URL;
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
      return FORWARD_TARGET_HOSTS.has(new URL(target.url).hostname)
    } catch {
      return false
    }
  }

  /** Extract the validated remote port/scheme/path from a logical target. */
  private forwardRequest(target: BrowserTarget): { port: number; scheme: 'http' | 'https'; path: string } | undefined {
    let url: URL
    try { url = new URL(target.url) } catch { return undefined }
    const scheme = target.kind === 'https' ? 'https' : 'http'
    const port = url.port === '' ? (scheme === 'https' ? 443 : 80) : Number(url.port)
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) return undefined
    return { port, scheme, path: (url.pathname === '' ? '/' : url.pathname) + url.search }
  }
}

/** Build the per-tab resolver (one consumer lease per tab occurrence). */
export function createForwardFrameResolver(options: ForwardFrameResolverOptions): ForwardFrameResolver {
  return new ForwardFrameResolver(options)
}
