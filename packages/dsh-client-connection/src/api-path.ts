/**
 * The `/api` URL prefix — single source for both halves of the web transport; the
 * node half registers it. Chamber owns the browser-side per-instance base path:
 * every path lands under the control-plane proxy prefix (`/api/i/<id>`), which
 * strips it and forwards to the instance's own `/api` tree. Explicit argument wins;
 * `window.__DSH_BASE_PATH__` stays a compatibility fallback.
 */

/** Route prefix owning every api request (`/api` and `/api/<anything>`). */
export const API_PATH = '/api'

declare global {
  interface Window {
    /** Compatibility fallback for legacy embedders; undefined = stock same-origin `/api`. */
    __DSH_BASE_PATH__?: string
  }
}

/** Resolve the per-instance base path: explicit argument, then the
 *  `window.__DSH_BASE_PATH__` knob, then stock; trailing slash normalized;
 *  `/api` or empty means "no prefix injection". */
export function resolveInstanceBasePath(explicit?: string): string {
  const knob = typeof window === 'undefined' ? undefined : window.__DSH_BASE_PATH__
  const base = (explicit ?? knob ?? '').replace(/\/+$/, '')
  return base === '' || base === API_PATH ? '' : base
}
