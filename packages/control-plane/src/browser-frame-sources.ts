/**
 * v2 embedded-browser CSP source resolution (design 28 §16.3).
 *
 * The control plane only formats/validates the list; the source of truth for
 * WHICH loopback/alias hosts may be framed is
 * `@dsh-chamber/dsh-chamber-wire/forward` (`forwardFrameSources()` +
 * `isForwardFrameSource()`), generated from the per-source alias range + local
 * loopback hosts. gateway/cli/standalone pass nothing and keep the v1
 * `frame-src blob:` claim byte-for-byte.
 *
 * The desktop main/sidecar additionally append the two bare scheme sources
 * `http:` / `https:`: the embedded browser now follows upstream
 * ui-sidebar-browser behavior and may frame ANY http(s) page, so main must not
 * be narrower than the browser surface it hosts. The scheme list is the ONE
 * supported widening; `'self'`, `*`, credential-bearing URLs and arbitrary host
 * sources are still rejected at construction — the app origin fence
 * (frame-ancestors 'none' + XFO DENY) is untouched.
 */
import { isForwardFrameSource } from '@dsh-chamber/dsh-chamber-wire/forward'

/** Default frame-src claim (v1 behavior): document previews' blob: iframes only. */
const DEFAULT_BROWSER_FRAME_SOURCES: readonly string[] = Object.freeze(['blob:'])

/**
 * The two bare scheme sources the DESKTOP caller appends to the generated list:
 * upstream ui-sidebar-browser frames arbitrary http(s) pages, and the desktop CSP
 * must not block what its own browser renders. Everything else stays as before
 * (no 'self', no wildcard host, no credential URL).
 */
const ANY_HTTP_SCHEME_FRAME_SOURCES: ReadonlySet<string> = new Set(['http:', 'https:'])

const MAX_FRAME_SOURCES = 512

/** One allowed frame-source spelling: wire loopback/alias host, blob:, or the bare scheme widening. */
function isAllowedBrowserFrameSource(value: unknown): value is string {
  if (typeof value !== 'string') return false
  if (ANY_HTTP_SCHEME_FRAME_SOURCES.has(value)) return true
  return isForwardFrameSource(value)
}

/**
 * Validate one caller-supplied frame-source list and return the canonical
 * (de-duplicated, first-seen order) array.
 *
 * @param value - the untrusted `ControlPlaneOptions.frameSources` value.
 * @returns the frozen canonical list; the default list when absent/null.
 * @throws TypeError when the value is not an array of allowed sources, misses
 *   `blob:` (document-preview contract), is empty or exceeds the cap.
 */
export function resolveBrowserFrameSources(value: unknown): readonly string[] {
  if (value === undefined || value === null) return DEFAULT_BROWSER_FRAME_SOURCES
  if (!Array.isArray(value)) throw new TypeError('frameSources must be an array of frame-src sources')
  const seen = new Set<string>()
  for (const item of value) {
    if (!isAllowedBrowserFrameSource(item)) {
      throw new TypeError('frameSources entry is not an allowed browser frame source: ' + JSON.stringify(item))
    }
    seen.add(item)
  }
  if (seen.size === 0) throw new TypeError('frameSources must not be empty')
  if (seen.size > MAX_FRAME_SOURCES) throw new TypeError('frameSources has too many entries')
  if (!seen.has('blob:')) throw new TypeError("frameSources must include 'blob:' for document previews")
  return Object.freeze([...seen])
}

/** Render the `frame-src` directive for one resolved list. */
export function frameSrcDirective(sources: readonly string[]): string {
  return 'frame-src ' + sources.join(' ')
}