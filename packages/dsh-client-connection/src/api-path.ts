/**
 * The `/api` URL prefix — single source for both halves of the web transport; the
 * node half registers it. Chamber owns the browser-side per-instance base path:
 * every path lands under the control-plane proxy prefix (`/api/i/<id>`), which
 * strips it and forwards to the instance's own `/api` tree. The value is an
 * explicit option threaded from the entry's own Context; no page global is read.
 */

/** Route prefix owning every api request (`/api` and `/api/<anything>`). */
export const API_PATH = '/api'

/** Resolve the per-instance base path from the explicit argument: absent means the
 *  stock same-origin `/api`; trailing slashes normalize away; `/api` or empty
 *  collapses to "no prefix injection". */
export function resolveInstanceBasePath(explicit?: string): string {
  const base = (explicit ?? '').replace(/\/+$/, '')
  return base === '' || base === API_PATH ? '' : base
}
