/**
 * The /api URL prefix — single source for both halves of the web transport.
 * The node half registers this prefix on the web server; both halves share the
 * event paths below for the browser WebSocket downlinks.
 *
 * ## chamber patch (dsh-chamber connection manager, design 05 §3.6)
 *
 * This is one of the only dsh source files modified by chamber: the browser
 * half learns a per-instance base path so every RPC/WS path lands under the
 * control-plane's same-origin per-instance proxy prefix (`/api/i/<id>`), which
 * strips the prefix and forwards the remainder to the instance's own `/api`
 * tree (design 03 §3.1). The default is empty (stock behaviour: paths carry
 * `/api` as authored below). An explicit argument (used by chamber's private
 * per-entry Context) is authoritative; `window.__DSH_BASE_PATH__` remains a
 * compatibility fallback for other embedders.
 */

/** Route prefix owning every api request (`/api` and `/api/<anything>`). */
export const API_PATH = '/api'

/** Browser mux-frame WebSocket pathname. */
export const MUX_EVENTS_PATH = `${API_PATH}/events.mux`

/** Browser host-frame WebSocket pathname. */
export const HOST_EVENTS_PATH = `${API_PATH}/events.host`

declare global {
  interface Window {
    /**
     * chamber patch compatibility fallback for legacy embedders
     * (`/api/i/<id>`); undefined = stock same-origin /api.
     */
    __DSH_BASE_PATH__?: string
  }
}

/**
 * Resolve the per-instance base path: explicit argument wins, then the
 * `window.__DSH_BASE_PATH__` deployment knob, then the stock value `/api`
 * (which means "no prefix injection" — the paths below already carry `/api`).
 * A trailing slash is normalized away so concatenations stay clean.
 */
export function resolveInstanceBasePath(explicit?: string): string {
  const knob = typeof window === 'undefined' ? undefined : window.__DSH_BASE_PATH__
  const base = (explicit ?? knob ?? '').replace(/\/+$/, '')
  return base === '' || base === API_PATH ? '' : base
}
