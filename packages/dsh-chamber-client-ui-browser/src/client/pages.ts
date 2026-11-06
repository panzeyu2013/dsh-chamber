/** Assemble iframe navigation and presentation without platform branches in consumers. */
import type { BrowserPage, BrowserPageOptions } from './browser/BrowserPage.ts'
import type { BrowserFrameSrcResolver } from './browser/IframeImpl.ts'
import { IframeImpl } from './browser/IframeImpl.ts'
import { IframePresentation } from './view/IframePresentation.ts'

/**
 * Assemble an idle iframe provider and its DOM presentation.
 *
 * FORK DIFF: `resolver` is the chamber seam that maps one logical target onto
 * the exact iframe URL (local direct; remote 127.0.0.1 through the SSH forward
 * lease). Everything else is upstream's assembly verbatim.
 *
 * @param options - saved navigation and callbacks.
 * @param resolver - logical target → iframe src (owns the forward lease).
 * @returns the Web page's navigation and presentation objects.
 */
export function createIframePage(
  options: BrowserPageOptions,
  resolver: BrowserFrameSrcResolver,
): BrowserPage {
  const presentation = new IframePresentation({
    loaded: (revision) => { frame.handleLoaded(revision) },
    failed: (revision) => { frame.handleLoadFailed(revision) },
    remounted: () => { frame.reload() },
  })
  const frame = new IframeImpl(options, presentation, resolver)
  return { frame, presentation }
}
