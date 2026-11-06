/** Carrier-neutral page navigation and observable state. */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { BrowserTarget } from './url.ts'

/** A loading failure, optionally carrying the underlying browser's diagnostic. */
export interface BrowserLoadError {
  readonly code: number | undefined
  readonly description: string | undefined
}

/** State consumed by common browser chrome, without DOM or carrier identifiers. */
export interface BrowserFrameState {
  readonly target: BrowserTarget | undefined
  readonly address: 'empty' | 'requested' | 'observed' | 'unknown'
  readonly loading: boolean
  readonly canGoBack: boolean
  readonly canGoForward: boolean
  readonly error: BrowserLoadError | undefined
  /** Undefined when this provider does not expose a sandbox control. */
  readonly sandboxEnabled: boolean | undefined
  /**
   * FORK DIFF (the SSH reverse proxy only): the exact URL the system-browser
   * exit must open when it differs from `target.url` (a remote `127.0.0.1`
   * target loads through the per-source alias, so the upstream external action
   * must not open the unforwarded loopback URL). Undefined keeps upstream's
   * `target.url` behavior; null disables the exit (a forwarded target whose
   * lease is still resolving, or whose attach failed: the logical remote loopback
   * must NOT be opened on this machine); filled with the alias only by a
   * successfully forwarded iframe page.
   */
  readonly externalUrl?: string | null
}

/** Optional iframe policy control, not an Electron process-sandbox switch. */
export interface BrowserSandboxControl {
  /** @param enabled - whether the provider's embedding sandbox is enforced. */
  setEnabled(enabled: boolean): void
}

/** Navigation owns page lifetime; mounting and hiding belong to BrowserPresentation. */
export interface BrowserFrame extends HostObservable<BrowserFrameState> {
  readonly sandbox?: BrowserSandboxControl
  /** @param target - validated HTTP(S) address; loading failures are published in state. */
  loadUrl(target: BrowserTarget): void
  /** Move backward when the provider reports an available entry. */
  goBack(): void
  /** Move forward when the provider reports an available entry. */
  goForward(): void
  /** Reload the current address without creating a new history entry. */
  reload(): void
  /** @returns after the page, listeners and pending initialization have been released; repeated calls join disposal. */
  dispose(): Promise<void>
}

/**
 * Create idle navigation state without a page target.
 * @returns state before any page has been requested.
 */
export function emptyBrowserFrame(): BrowserFrameState {
  return { target: undefined, address: 'empty', loading: false, canGoBack: false, canGoForward: false,
    error: undefined, sandboxEnabled: undefined }
}
