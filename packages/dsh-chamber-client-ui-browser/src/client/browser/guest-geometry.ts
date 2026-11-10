/**
 * Placeholder geometry for the native guest layer (design 28 §4.1 / §3:85).
 *
 * The shell `BrowserGuestLayerView` sits above the shell webView; the renderer
 * owns the placeholder `div` and reports its rect in CSS pixels relative to the
 * shell webView bounds. Travel shape = top-level `frame:{x,y,w,h}` + `visible`
 * + `occluded` (never flags nested inside the geometry).
 *
 * The merge is pure so the coalescing rule (≥1px change or visibility flip only)
 * is testable without a DOM.
 */
import type { BrowserFrameReport, BrowserGuestFrame } from './BrowserBridge.ts'

/** One raw measurement; normalization keeps the flags top-level. */
export interface GuestFrameMeasurement {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly visible: boolean
  readonly occluded: boolean
}

/** Round to whole CSS pixels and refuse non-finite input (geometry only). */
export function normalizeGuestFrame(value: GuestFrameMeasurement): BrowserGuestFrame {
  const finite = (input: number): number => (Number.isFinite(input) ? Math.round(input) : 0)
  return {
    x: finite(value.x),
    y: finite(value.y),
    width: Math.max(0, finite(value.width)),
    height: Math.max(0, finite(value.height)),
  }
}

/** Normalize one measurement into the travel report (geometry + top-level flags). */
export function normalizeGuestReport(value: GuestFrameMeasurement): BrowserFrameReport {
  return { frame: normalizeGuestFrame(value), visible: value.visible, occluded: value.occluded }
}

/**
 * Compare two reports for the "only report on change" rule.
 *
 * @param previous - last reported report (undefined before the first report).
 * @param next - normalized candidate.
 * @returns true when the candidate must be sent (≥1px on any edge or a
 *   visibility/occlusion flip).
 */
export function shouldReportGuestFrame(previous: BrowserFrameReport | undefined, next: BrowserFrameReport): boolean {
  if (previous === undefined) return true
  if (previous.visible !== next.visible || previous.occluded !== next.occluded) return true
  return Math.abs(previous.frame.x - next.frame.x) >= 1
    || Math.abs(previous.frame.y - next.frame.y) >= 1
    || Math.abs(previous.frame.width - next.frame.width) >= 1
    || Math.abs(previous.frame.height - next.frame.height) >= 1
}

/**
 * Occlusion verdict for the DOM hit test.
 *
 * The native guest layer sits ABOVE the shell webView, so any DOM overlay (dialog,
 * command palette, toast, menu, drag mask) must hide it. The renderer has no
 * overlay service to count, so the v2 heuristic hit-tests several points (centre,
 * four corners and the four edge midpoints): the guest is covered as soon as ONE
 * sampled point is won by a foreign layer.
 *
 * @param topmostIsPlaceholder - hit-test result is the placeholder element.
 * @param topmostIsInsidePlaceholder - the element is a placeholder descendant.
 * @param topmostContainsPlaceholder - the element is an ancestor of the placeholder.
 * @returns true when a DOM layer covers the guest.
 */
export function isGuestOccludedByTopmost(
  topmostIsPlaceholder: boolean,
  topmostIsInsidePlaceholder: boolean,
  topmostContainsPlaceholder: boolean,
): boolean {
  return !(topmostIsPlaceholder || topmostIsInsidePlaceholder || topmostContainsPlaceholder)
}

/**
 * Sample points for the multi-point occlusion hit test (relative fractions).
 * Centre first, then corners inset by 25%, then edge midpoints: a dialog or a
 * palette edge that only covers one corner still hides the guest.
 */
export const OCCLUSION_SAMPLE_POINTS: ReadonlyArray<readonly [number, number]> = [
  [0.5, 0.5],
  [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75],
  [0.5, 0.25], [0.5, 0.75], [0.25, 0.5], [0.75, 0.5],
]

/** Compute the sample coordinates inside one rect. */
export function occlusionSampleCoordinates(rect: { readonly left: number; readonly top: number; readonly width: number; readonly height: number }): ReadonlyArray<readonly [number, number]> {
  return OCCLUSION_SAMPLE_POINTS.map(([fx, fy]) => [rect.left + rect.width * (fx as number), rect.top + rect.height * (fy as number)] as const)
}

/** Overlay candidates whose rect hides the native guest (RT-04). */
export const OVERLAY_SELECTOR = [
  '[data-chamber-overlay]',
  '[role="dialog"]',
  '[role="menu"]',
  '[role="alertdialog"]',
  'dialog[open]',
  '[data-chamber-toast]',
].join(', ')

/** Whether two rects overlap (touching edges do not count). */
export function rectsIntersect(
  left: { readonly left: number; readonly top: number; readonly width: number; readonly height: number },
  right: { readonly left: number; readonly top: number; readonly width: number; readonly height: number },
): boolean {
  return left.left < right.left + right.width
    && right.left < left.left + left.width
    && left.top < right.top + right.height
    && right.top < left.top + left.height
}

/**
 * Whether any overlay candidate rect overlaps the placeholder.
 *
 * This catches `pointer-events:none` scrims/toasts that never win the hit test,
 * which is why RT-04 runs BOTH the point hit test and this rect intersection.
 */
export function overlayCandidatesCover(
  placeholder: { readonly left: number; readonly top: number; readonly width: number; readonly height: number },
  candidates: readonly { readonly left: number; readonly top: number; readonly width: number; readonly height: number }[],
): boolean {
  return candidates.some(candidate => rectsIntersect(placeholder, candidate))
}

/** A report that hides the guest (dock collapsed / offscreen / zero rect). */
export function hiddenGuestFrame(previous: BrowserFrameReport | undefined): BrowserFrameReport {
  const base = previous?.frame ?? { x: 0, y: 0, width: 0, height: 0 }
  return { frame: { ...base, width: 0, height: 0 }, visible: false, occluded: true }
}
