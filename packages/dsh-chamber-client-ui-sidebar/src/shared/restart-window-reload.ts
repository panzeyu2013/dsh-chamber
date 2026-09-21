/**
 * Window reload completing a user-initiated dsh restart (2026-12).
 *
 * SHARED FACE (sidebar `shared`, design 21 §5.2 precedent): the completion is
 * consumed by two client plugins that must not value-import each other — the
 * settings bridge's 「dsh 运行时」 section (local + gateway restart) and the
 * connections package (gateway card restart/start, ssh card restart, plugin
 * dialog restart-to-apply). Page-level state lives here so both surfaces arm the
 * SAME completion per key.
 *
 * WHY THIS EXISTS: the chamber window's client-plugin set is fixed at each
 * instance shell boot — the host boot graph is fetched once per boot and the
 * `dsh.client` bundles it carries are executed then
 * (`packages/renderer/src/host-graph.ts`). Restarting the dsh process refreshes
 * the HOST side only (loader rows, tools, MCP connections). A newly installed or
 * rebuilt `dsh.client` contribution — a settings section, for example — cannot
 * appear until the window boots again, so the user-facing "restart dsh to
 * refresh mounted plugins" action (design 18 §3.6 item 8) is not complete
 * without one page reload. A window reload is the honest scope: the page-level
 * module table is first-load-wins per plugin id, so only a fresh page can also
 * switch an ALREADY-LOADED plugin's implementation (design 09 §3.2/§3.5).
 *
 * PAGE-OWNED, NOT COMPONENT-OWNED: the restart itself is a host-side fact that
 * proceeds whether or not the button that started it is still on screen, so the
 * reload is armed on the PAGE (one entry per key) instead of living in the
 * caller's promise chain. Unmounting the settings panel mid-restart therefore
 * cannot cancel the completion (2026-12 review F6 — the panel's own abort
 * controller stays authoritative only for the POST it issued).
 *
 * POLICY:
 * - the waiter owns its own readiness protocol and budget; the arm's
 *   `budgetMs` is only the page-level safety net (it aborts the waiter's
 *   signal, whose contract is to resolve false promptly);
 * - 'not-served' never reloads — reloading onto an instance that is not serving
 *   would hide the failure behind a fresh boot, so the caller keeps its error
 *   surface;
 * - a waiter that rejects is "not serving yet"; this module never throws;
 * - the same key re-armed while pending shares one promise (no double polls, and
 *   shutting/reopening the panel cannot arm a second reload).
 */

import { assertSingletonModule } from './singleton.ts'

// The armed map is page-wide state: a duplicated module copy would arm a second
// completion (two reloads). Same drift diagnostic the other shared singletons use.
assertSingletonModule('restart-window-reload')

/** GET /health → {ok, dsh:{status, port, error?}} (design 04 §3.1; the same row
 *  the connections card renders). Serving = 'ready' | 'degraded' — the card's own
 *  `healthy` definition: a probe-failing instance can still serve the root
 *  document / boot graph, and refusing to reload it would report a stalled
 *  restart for a restart that actually worked.
 *
 *  KNOWN TRADE-OFF (2026-12 review F7): this wire shape is re-declared here
 *  rather than imported from the sidebar shared REST client, because this module
 *  is imported by plain-node tests and the shared face is a barrel that pulls the
 *  page-global stores in with it. The shape is two fields and stays pinned to
 *  design 04 §3.1. */
interface HealthWire {
  ok?: boolean
  dsh?: { status?: unknown }
}

/** Local wait poll cadence + page-level arm budgets. A local restart settles in
 *  a few seconds ({@link SERVING_RELOAD_BUDGET_MS}); every other source's arm
 *  runs under {@link RESTART_RELOAD_BUDGET_MS}, whose waiter owns its own inner
 *  budget (the gateway readiness poll's 120s; the ssh serving gate's 120s). */
export const SERVING_RELOAD_POLL_MS = 250
export const SERVING_RELOAD_BUDGET_MS = 30_000
export const RESTART_RELOAD_BUDGET_MS = 180_000

/** The page-level key of the local instance's completion. */
const LOCAL_RELOAD_KEY = 'local'

/** Outcome of {@link armWindowReloadWhenServed}. */
export type ServingReloadOutcome =
  /** The waiter reported serving and the window reload was issued. */
  | 'reloaded'
  /** The budget ran out (or the waiter gave up) first: nothing was reloaded. */
  | 'not-served'

/**
 * A blocking readiness waiter: resolves true once the restarted instance
 * serves, false when it gives up or its signal aborts. The waiter owns its own
 * protocol/ceiling; the arm's budget is the outer safety net.
 */
export type ServingWaiter = (signal: AbortSignal) => Promise<boolean>

/** Options of {@link armWindowReloadWhenServed}. */
export interface ArmWindowReloadOptions {
  /** Page-level safety net; defaults to {@link SERVING_RELOAD_BUDGET_MS}. */
  budgetMs?: number
}

const armedReloads = new Map<string, Promise<ServingReloadOutcome>>()

/** Sleep that resolves early on abort (the caller re-checks its own deadline). */
function abortableSleep(signal: AbortSignal, ms: number): Promise<void> {
  return new Promise<void>(resolve => {
    const finish = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    signal.addEventListener('abort', finish, { once: true })
  })
}

/**
 * Arm the page-level completion: wait for the instance to serve, then reload the
 * window once. Single-flight per key: an identical key already pending returns
 * that same promise (a second click, or reopening the panel, must not poll or
 * reload twice). The entry clears on settle, so a later retry can re-arm.
 *
 * @param key - page-level identity of the completion ('local' | 'gateway-<id>' | ...).
 * @param waiter - the source's readiness waiter (owns its own protocol).
 * @param options - page-level safety net.
 * @returns 'reloaded' once the reload was issued, 'not-served' otherwise.
 */
export function armWindowReloadWhenServed(
  key: string,
  waiter: ServingWaiter,
  options: ArmWindowReloadOptions = {},
): Promise<ServingReloadOutcome> {
  const existing = armedReloads.get(key)
  if (existing !== undefined) return existing
  const budgetMs = options.budgetMs ?? SERVING_RELOAD_BUDGET_MS
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, budgetMs)
  // The wrapper object keeps the self-reference inside the settle handler free
  // of a use-before-declaration dance.
  const entry: { promise: Promise<ServingReloadOutcome> } = {
    promise: Promise.resolve<ServingReloadOutcome>('not-served'),
  }
  const run = (async (): Promise<ServingReloadOutcome> => {
    let served = false
    try {
      served = await waiter(controller.signal)
    } catch {
      // Fail closed: a waiter that cannot answer is "not serving yet".
      served = false
    }
    if (!served) return 'not-served'
    reloadWindow()
    return 'reloaded'
  })()
  entry.promise = run.finally(() => {
    clearTimeout(timer)
    controller.abort()
    if (armedReloads.get(key) === entry.promise) armedReloads.delete(key)
  })
  armedReloads.set(key, entry.promise)
  return entry.promise
}

/**
 * Reload the page. Guarded for non-browser hosts (this module is imported by
 * plain-node tests); a failed navigation cannot be detected and is swallowed —
 * the reload is a best-effort completion of the restart, never a way to fail the
 * action (design 18 §3.6 item 8).
 */
export function reloadWindow(): void {
  if (typeof window === 'undefined') return
  try {
    window.location.reload()
  } catch {
    // Non-navigable host (tests / non-browser renderer): nothing to do.
  }
}

/** Injected seams of {@link waitForLocalDshServing}. */
export interface LocalServingDeps {
  /** Fetch seam (tests). */
  fetchImpl?: typeof fetch
  /** Poll cadence; defaults to {@link SERVING_RELOAD_POLL_MS}. */
  pollMs?: number
  /** Internal budget; defaults to {@link SERVING_RELOAD_BUDGET_MS}. */
  budgetMs?: number
}

/**
 * Wait for the LOCAL instance to serve again: poll the control plane's /health
 * until `dsh.status` is 'ready' or 'degraded' (the connections card's own
 * `healthy` definition), bounded by `budgetMs` and by the signal.
 * @param signal - the arm's page-level signal; abort resolves false promptly.
 * @param deps - fetch/poll/budget seams.
 * @returns true once the instance serves, false on abort/budget exhaustion.
 */
export async function waitForLocalDshServing(
  signal: AbortSignal,
  deps: LocalServingDeps = {},
): Promise<boolean> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const pollMs = deps.pollMs ?? SERVING_RELOAD_POLL_MS
  const budgetMs = deps.budgetMs ?? SERVING_RELOAD_BUDGET_MS
  const deadline = Date.now() + budgetMs
  for (;;) {
    if (signal.aborted) return false
    try {
      const response = await fetchImpl('/health', {
        headers: { accept: 'application/json' },
        credentials: 'same-origin',
        signal,
      })
      if (response.ok) {
        const body = await response.json() as HealthWire
        const status = body?.dsh?.status
        if (status === 'ready' || status === 'degraded') return true
      }
    } catch {
      // Channel failure / non-JSON body / abort: the checks below own the exit.
    }
    if (signal.aborted || Date.now() >= deadline) return false
    await abortableSleep(signal, pollMs)
  }
}

/**
 * The production entry for the local 「重启 dsh」/「启动」: wait for the restarted
 * instance to serve, then reload the window. Page-owned (see the module header):
 * closing the settings panel does not cancel it.
 * @param options - page-level safety net override (tests).
 * @returns the {@link ServingReloadOutcome}; 'not-served' means the caller must
 *   report the stalled restart instead of reloading.
 */
export function armLocalDshRestartCompletion(
  options: ArmWindowReloadOptions = {},
): Promise<ServingReloadOutcome> {
  return armWindowReloadWhenServed(LOCAL_RELOAD_KEY, signal => waitForLocalDshServing(signal), options)
}
