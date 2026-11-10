/** Assemble native guest navigation and presentation without platform branches in consumers. */
import type { BrowserPage, BrowserPageOptions } from './browser/BrowserPage.ts'
import type { BrowserTargetRefResolver } from './browser/ForwardFrameResolver.ts'
import type { BrowserFrameReport, NativeGuestCarrier } from './browser/BrowserBridge.ts'
import { hiddenGuestFrame } from './browser/guest-geometry.ts'
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
  /** Last reported placement: a hidden report keeps it while zeroing the rect. */
  let lastReport: BrowserFrameReport | undefined
  const presentation = new NativeGuestPresentation({
    report: (next) => { lastReport = next; frame?.reportFrame(next) },
    // D16: hide with the hiddenGuestFrame semantics — keep the last placement and
    // zero the rect (a 0,0 report would move the native layer to the origin).
    hidden: () => { frame?.reportFrame(hiddenGuestFrame(lastReport)) },
  }, options.tabId)
  frame = new NativeGuestImpl(options, carrier, presentation, resolver)
  return { frame, presentation: presentation }
}