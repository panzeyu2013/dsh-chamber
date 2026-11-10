/** Carrier-neutral page navigation and observable state (design 28 v3 §4). */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { BrowserTarget } from './url.ts'

/** A loading failure carrying the guest's NSURLErrorDomain diagnostic. */
export interface BrowserLoadError {
  readonly code: number | undefined
  readonly description: string | undefined
}

/**
 * State consumed by the common browser chrome, without carrier identifiers.
 *
 * The native guest carrier PROJECTS this state from its application history and
 * cursor (D14): a controlled load shows its requested entry before the guest
 * navigate invoke, and a pushed guest URL becomes the observed address.
 *
 * `address` has no `unknown` member: the carrier always knows whether the
 * address is requested or observed (design 28 §4.3), so the chrome can always
 * show it.
 */
export interface BrowserFrameState {
  readonly target: BrowserTarget | undefined
  readonly address: 'empty' | 'requested' | 'observed'
  readonly loading: boolean
  readonly canGoBack: boolean
  readonly canGoForward: boolean
  readonly error: BrowserLoadError | undefined
  /**
   * Fork diff (the SSH reverse proxy only): the URL the system-browser exit must
   * open when it differs from `target.url` — the alias main composed for a
   * forwarded page. Undefined keeps the logical target; null disables the exit
   * while a forward lease resolves or after an attach failure.
   */
  readonly externalUrl?: string | null
}

/** Navigation owns page lifetime; the presentation owns placeholder geometry. */
export interface BrowserFrame extends HostObservable<BrowserFrameState> {
  /** @param target - validated HTTP(S) address; loading failures are published in state. */
  loadUrl(target: BrowserTarget): void
  /** Move backward through the guest's native history. */
  goBack(): void
  /** Move forward through the guest's native history. */
  goForward(): void
  /** Reload the current address without creating a new history entry. */
  reload(): void
  /** @returns after the page, listeners and the guest lease have been released; repeated calls join disposal. */
  dispose(): Promise<void>
}

/**
 * Create idle navigation state without a page target.
 * @returns state before any page has been requested.
 */
export function emptyBrowserFrame(): BrowserFrameState {
  return { target: undefined, address: 'empty', loading: false, canGoBack: false, canGoForward: false,
    error: undefined, externalUrl: undefined }
}
