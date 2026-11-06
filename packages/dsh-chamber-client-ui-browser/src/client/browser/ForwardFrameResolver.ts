/**
 * FORK DIFF — the SSH reverse proxy (the ONLY behavior difference from the
 * upstream iframe browser): the exact URL one iframe loads, and the external
 * exit of a forwarded page (which must use the alias, never the remote loopback).
 *
 * Upstream resolves a navigation target to `target.url` and hands it straight
 * to the iframe. In the chamber N-ctx shell an SSH source's remote loopback
 * (`127.0.0.1` target) is not reachable from the page, so it must ride the
 * existing SSH forward lease:
 *
 *   - local source            → `target.url` (this machine, no forward);
 *   - ssh + host 127.0.0.1    → `BrowserForwardController.attach` (consumer
 *                               lease) and main's composed `frameUrl`;
 *   - ssh + any other host    → `target.url` (upstream direct URL).
 *
 * The DISPLAYED target never changes: `BrowserBody`'s address bar and the
 * persisted history keep the logical target; only `IframePresentation.src`
 * uses the resolved URL. Leaving a forwarded target (or closing the tab)
 * releases the consumer through the same controller; an attach failure yields
 * `undefined`, which surfaces as the upstream `BrowserFrameState.error` bar.
 *
 * Everything else (address parsing, history, persistence, sandbox, shortcut,
 * multi-tab behavior, DOM/className/copy) stays upstream verbatim.
 */
import { BrowserForwardController } from '../../shared/browser-controller.ts'
import type { BrowserForwardBridge } from '../../shared/forward-bridge.ts'
import type { BrowserSource } from '../../shared/source.ts'
import type { BrowserFrameSrcResolver } from './IframeImpl.ts'
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

/** The one address-bar host that means "the REMOTE machine's loopback". */
const FORWARD_TARGET_HOST = '127.0.0.1'

/**
 * Resolve logical Browser targets to iframe URLs through the existing
 * per-tab forward lease (one resolver per tab occurrence).
 */
export class ForwardFrameResolver implements BrowserFrameSrcResolver {
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
      // The controller parses every answer; a missing carrier disables the leg.
      transport: options.bridge,
    })
  }

  /** @param target - logical navigation target. @returns whether this load attaches a forward lease. */
  forwards(target: BrowserTarget): boolean {
    return this.mustForward(target)
  }

  /** @param target - logical navigation target. @returns exact iframe src, or undefined on failure. */
  resolve(target: BrowserTarget): Promise<string | undefined> {
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

  private async resolveSerial(target: BrowserTarget): Promise<string | undefined> {
    if (this.disposed) return undefined
    if (!this.mustForward(target)) {
      // A direct target ends any forwarded page in this pane: release its
      // consumer BEFORE the iframe leaves the forwarded URL.
      if (this.controller.currentRecordId !== null) await this.controller.detachCurrent()
      return target.url
    }
    if (this.options.bridge === null) return undefined
    const request = this.forwardRequest(target)
    if (request === undefined) return undefined
    const outcome = await this.controller.attach(request)
    return outcome.ok ? outcome.frameUrl : undefined
  }

  /** Whether this target must ride the source's SSH forward. */
  private mustForward(target: BrowserTarget): boolean {
    if (!this.options.source.mayForward) return false
    try {
      return new URL(target.url).hostname === FORWARD_TARGET_HOST
    } catch {
      return false
    }
  }

  /** Extract the validated remote port/scheme/path from a logical target. */
  private forwardRequest(target: BrowserTarget): { port: number; scheme: 'http' | 'https'; path: string } | undefined {
    let url: URL
    try {
      url = new URL(target.url)
    } catch {
      return undefined
    }
    const scheme = target.kind === 'https' ? 'https' : 'http'
    const port = url.port === '' ? (scheme === 'https' ? 443 : 80) : Number(url.port)
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) return undefined
    return {
      port,
      scheme,
      path: (url.pathname === '' ? '/' : url.pathname) + url.search,
    }
  }
}

/** Build the per-tab forward resolver (one consumer lease per tab occurrence). */
export function createForwardFrameResolver(options: ForwardFrameResolverOptions): ForwardFrameResolver {
  return new ForwardFrameResolver(options)
}
