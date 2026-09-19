/**
 * Fixtures shared by this package's suites: the page-origin stub and fetch
 * fake for the per-instance REST clients, the wire-shaped plugin row, and the
 * shared read/write 409 fence body (design 21 §6.2).
 */
import type { PluginRowShape } from '../../src/client/plugin-model.ts'

/** One wire-shaped plugin row with third-party/unprotected defaults. */
export function pluginRow(partial: Partial<PluginRowShape> & { name: string }): PluginRowShape {
  return { spec: '^1.0.0', version: null, role: 'third-party', protected: false, ...partial }
}

/** The gateway's fence refusal (routes.ts) on the plugin read/write face. */
export const FENCE_BODY = {
  error: 'managed profile write in flight (plugin mutation); the installed projection is fenced — retry after the task settles',
  code: 'runtime_busy',
}

export interface FetchCall { url: string; init: RequestInit }

/** Define the page origin the shared clients read: `window.location.origin`
 *  for control-plane.ts, `location.origin` for the inventory API. */
export function withPageOrigin(origin: string, scope: 'window' | 'location' = 'window'): () => void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, scope)
  Object.defineProperty(globalThis, scope, {
    configurable: true,
    value: scope === 'window' ? { location: { origin } } : { origin },
  })
  return () => {
    if (previous === undefined) delete (globalThis as Record<string, unknown>)[scope]
    else Object.defineProperty(globalThis, scope, previous)
  }
}

/** A fetch stub answering one status/body; `reject` makes it a network failure. */
export function stubFetch(status: number, body: unknown, reject = false): { calls: FetchCall[]; restore(): void } {
  const calls: FetchCall[] = []
  const original = globalThis.fetch
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} })
    if (reject) return Promise.reject(new TypeError('fetch failed'))
    return Promise.resolve(new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }))
  }) as typeof fetch
  return { calls, restore(): void { globalThis.fetch = original } }
}
