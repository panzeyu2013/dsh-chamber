/** Assemble native guest navigation and presentation without platform branches in consumers. */
import type { BrowserPage, BrowserPageOptions } from './browser/BrowserPage.ts'
import type { BrowserTargetRefResolver } from './browser/ForwardFrameResolver.ts'
import type { NativeGuestCarrier } from './browser/BrowserBridge.ts'
import { NativeGuestImpl } from './browser/NativeGuestImpl.ts'
import { NativeGuestPresentation } from './view/NativeGuestPresentation.ts'

/**
 * Assemble one native guest page (design 28 §4, ADR-0004).
 *
 * The iframe carrier is retired: the presentation only measures the placeholder
 * and the provider drives main's child WKWebView through the `browser` bridge.
 *
 * @param options - saved navigation and callbacks.
 * @param carrier - the bridge plus the boot-bound lease identity.
 * @param resolver - logical target → guest target (owns the forward lease).
 * @returns the tab's navigation and placeholder presentation.
 */
export function createNativeGuestPage(
  options: BrowserPageOptions,
  carrier: NativeGuestCarrier,
  resolver: BrowserTargetRefResolver,
): BrowserPage {
  let frame: NativeGuestImpl | undefined
  const presentation = new NativeGuestPresentation({
    report: (next) => { frame?.reportFrame(next) },
    hidden: () => { frame?.reportFrame({ frame: { x: 0, y: 0, width: 0, height: 0 }, visible: false, occluded: true }) },
  }, options.tabId)
  frame = new NativeGuestImpl(options, carrier, presentation, resolver)
  return { frame, presentation: presentation }
}