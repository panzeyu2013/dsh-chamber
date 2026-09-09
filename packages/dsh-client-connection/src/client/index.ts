/**
 * Browser wire client. The plugin selects fixture or HTTP transport, provides
 * the shared RPC client, and lets API Gateway own the connection loop.
 *
 * ## chamber patch (dsh-chamber connection manager, design 05 §3.6; re-anchored
 * on upstream dsh-v0.1.3-alpha.2, 2026-09 Batch 2)
 *
 * Three chamber deltas only:
 *  - `basePath` is read from the per-entry Context (`ctx.chamberBasePath`, the
 *    same seam the chamber api-gateway fork uses — never a page-global knob)
 *    and handed to the generic RPC carrier, so every api path lands under the
 *    control-plane per-instance proxy prefix (`/api/i/<id>`). The resolved
 *    value is also exposed as `handle.basePath`.
 *  - the carrier assembly (`carrier-assembly.ts`) owns the RPC carrier
 *    construction; the liveness triggers (`liveness-triggers.ts`, design 14 D4)
 *    drive the controller's native `reconnect()` on OS wake / network return /
 *    long-hidden recovery.
 *  - `SYSTEM_RESUME_EVENT` is exported as the single canonical wake-event name
 *    the chamber shell dispatches.
 *
 * Everything else is verbatim upstream: the page-global
 * `__DSH_CONNECTION_RECOVERY__` bootstrap, the `{...recovery, ...config}`
 * merge in `start`, the browser online/offline watch (`watchBrowserNetwork` →
 * `setNetworkAvailable`), and the `{ rpc, generation, state, reconnect,
 * registerGenerationSource, start }` handle surface.
 */
import type { Context } from '@deepseek-ai/cordis'
import {
  ConnectionController,
  type ConnectionRecoveryConfig,
  type ConnectionGeneration,
  type ConnectionGenerationSource,
  type ConnectionSinks,
  type ConnectionState,
} from './connection.ts'
import { createFixtureConnectionRpc } from './fixture.ts'
import { createWebConnectionRpc, type RpcFetch, type RpcStreamOpen } from './rpc.ts'
import { assembleConnectionCarriers } from './carrier-assembly.ts'
import { attachLivenessTriggers } from './liveness-triggers.ts'
import { isLoopbackHostname } from '../loopback-hostname.ts'
import { resolveConnectionConfig } from '../recovery-config.ts'
import type { ClientConnectionRpc } from '../rpc.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * A connection generation was established. Wire-derived caches must
     * repull; long-lived streams own their own resume and baseline lifecycle.
     * @mode emit
     */
    'connection/reset'(): void
  }
}

// ---- Browser-safe protocol and shared value re-exports ----
export type {
  MessageId,
  RpcRequest, RpcResponse, RpcResult,
  ClientRequest, ServerResponse, RpcMessage,
  SessionId, SessionEvent, ContentBlock, StreamChunk,
} from './api.ts'
export {
  RpcId,
  transportError,
} from './api.ts'

// Connection loop types are public through ConnectionHandle.start; the
// controller remains package-internal.
export type {
  ConnectionRecoveryConfig,
  ConnectionGeneration,
  ConnectionGenerationSource,
  ConnectionHostInfo,
  ConnectionSinks,
  ConnectionState,
} from './connection.ts'

export type {
  ClientConnectionRpc, ConnectionRpcFailure, ConnectionRpcResult,
} from '../rpc.ts'
export type { RpcFetch } from './rpc.ts'

/**
 * chamber patch (design 14 D4): the window event the chamber shell dispatches
 * on OS wake-from-sleep (the App layer re-broadcasts the main-process
 * `system-resume` IPC push as this window event). SINGLE canonical definition —
 * the renderer App layer imports it from here so the two sides can never
 * drift apart (a drift would silently break the immediate-reconnect chain).
 */
export const SYSTEM_RESUME_EVENT = 'dsh-chamber:system-resume'

/** Observable identity and Host facts for the active connection generation. */
export interface ConnectionGenerationState {
  /** Active generation, or undefined before readiness and while reconnecting. */
  getSnapshot(): ConnectionGeneration | undefined
  /** Subscribe to generation establishment, replacement, and loss. */
  subscribe(listener: () => void): () => void
}

/** Observable recovery lifecycle of the owned Connection loop. */
export interface ConnectionStateSource {
  /** Current state, or undefined before the first connection outcome. */
  getSnapshot(): ConnectionState | undefined
  /** Subscribe to state changes. */
  subscribe(listener: () => void): () => void
}

/** Required services (none — this is the wire root). */
export const inject: string[] = []

/**
 * Carrier override installed on the page global before plugin boot. The served
 * web app leaves it unset and gets HTTP + WebSocket; a shell that owns a
 * different physical transport (the worker preview's postMessage tunnel)
 * provides both halves here instead of forking this plugin.
 */
export interface ClientTransportHooks {
  /** Transport for generic unary RPC channels (the Typert gateway). */
  fetch: RpcFetch
  /** Worker-local Gateway stream carrier; absent when the page uses the Gateway WebSocket. */
  openStream?: RpcStreamOpen
  /**
   * Bundle transport for the module system, present when the carrier also owns
   * bundle bytes (the worker tunnel). Absent in the served web app, whose
   * bundles load over HTTP.
   */
  loadBundle?(url: string): Promise<void>
  /**
   * The transport owner declares the page owns the Host outright: the Host
   * runs inside a worker this page spawned, so no other party can reach it and
   * the loopback stand-in for "the operator's own machine" is vacuous.
   * `ctx.connection.isLoopback` then reports the privileged surface reachable
   * regardless of the page authority. Only a shell that assembles its own
   * transport can set this; served pages never carry the global at all.
   */
  ownsHost?: boolean
}

/** Page global carrying {@link ClientTransportHooks}; absent in the served web app. */
interface ClientTransportGlobal {
  __DSH_TRANSPORT__?: ClientTransportHooks
  /** Host-injected recovery bootstrap (v0.1.3-alpha.2 webserver index-inject). */
  __DSH_CONNECTION_RECOVERY__?: unknown
}

/**
 * The ctx.connection service API: the RPC client plus a one-shot controller
 * starter. API Gateway supplies generation readiness and reset callbacks;
 * Connection stays independent of downstream domain state.
 */
export interface ConnectionHandle {
  /**
   * Whether the privileged surface is reachable: the page authority is
   * loopback, the transport declares the page owns the Host
   * ({@link ClientTransportHooks.ownsHost}), or the context is not a browser.
   */
  readonly isLoopback: boolean
  /** chamber patch: resolved per-instance api base path (`/api` stock, `/api/i/<id>` chamber). */
  readonly basePath: string
  /** Current Remote event generation and the Host facts carried by its opening frame. */
  readonly generation: ConnectionGenerationState
  /** Current recovery lifecycle for connection-specific consumers. */
  readonly state: ConnectionStateSource
  /** Generic logical RPC channels over the same Connection transport. */
  readonly rpc: ClientConnectionRpc
  /** Reset retry progression and replace the current attempt immediately. */
  reconnect(): void
  /**
   * Register the sole source defining Host generations. The source reports
   * ready only after its incremental listeners are attached.
   * @param source - long-lived generation source owned by the push carrier.
   * @returns disposer withdrawing the source and stopping an active loop.
   */
  registerGenerationSource(source: ConnectionGenerationSource): () => void
  /**
   * Start the connect/reconnect loop with the consumer's state callbacks.
   * API Gateway owns the loop; a second call throws.
   * @param sinks - connection-state callbacks.
   * @param config - explicit timing overrides; omitted fields use the resolved
   *   recovery timing (Host page-global bootstrap + explicit overrides).
   * @returns lifecycle controls for the loop.
   */
  start(sinks: ConnectionSinks, config?: ConnectionRecoveryConfig): ConnectionLoop
}

/** Controls retained by the sole owner of a running connection loop. */
export interface ConnectionLoop {
  /** Stop the loop and withdraw its active generation. */
  stop(): void
}

interface ConnectionOwner {
  readonly token: object
  readonly source: ConnectionGenerationSource
  readonly controller: ConnectionController
  readonly stopNetworkWatch: () => void
}

interface BrowserNetworkTarget {
  readonly navigator?: { readonly onLine?: boolean }
  addEventListener(type: 'online' | 'offline', listener: () => void): void
  removeEventListener(type: 'online' | 'offline', listener: () => void): void
}

function watchBrowserNetwork(controller: ConnectionController): () => void {
  const browser = (globalThis as { readonly window?: BrowserNetworkTarget }).window
  const initiallyAvailable = browser?.navigator?.onLine
  if (browser === undefined || initiallyAvailable === undefined) return () => {}
  const online = (): void => { controller.setNetworkAvailable(true) }
  const offline = (): void => { controller.setNetworkAvailable(false) }
  controller.setNetworkAvailable(initiallyAvailable)
  browser.addEventListener('online', online)
  browser.addEventListener('offline', offline)
  return () => {
    browser.removeEventListener('online', online)
    browser.removeEventListener('offline', offline)
  }
}

/** chamber patch: read the per-entry base path bound by the shell before plugin
 *  materialization (`shell.ts` ctx.provide('chamberBasePath'); design 05 §4 —
 *  the same seam the chamber api-gateway fork reads). */
function chamberBasePathOf(ctx: Context): string | undefined {
  return (ctx as { readonly chamberBasePath?: string }).chamberBasePath
}

/**
 * Client plugin body: pick the api by page mode and provide ctx.connection.
 * @param ctx - client cordis context (carries the per-entry `chamberBasePath`).
 */
export function apply(ctx: Context): void {
  const pageLocation = typeof location === 'undefined' ? undefined : location
  const fixture = pageLocation !== undefined && new URLSearchParams(pageLocation.search).has('fixture')
  const transport = (globalThis as ClientTransportGlobal).__DSH_TRANSPORT__
  const recovery = resolveConnectionConfig((globalThis as ClientTransportGlobal).__DSH_CONNECTION_RECOVERY__)
  const fixtureRpc = fixture ? createFixtureConnectionRpc() : undefined
  // chamber patch: resolve the per-entry path once (from the entry Context) and
  // fan the same immutable value into the generic RPC carrier (plus the
  // transport's fetch/stream hooks when a page-owned transport is present). The
  // pure assembly policy is behavior-tested without loading the source-only
  // vendor graph; production supplies the real constructor here.
  const { basePath, rpc } = assembleConnectionCarriers(
    chamberBasePathOf(ctx),
    fixtureRpc,
    transport,
    {
      createRpc: options => createWebConnectionRpc(options),
    },
  )
  let generationSource: ConnectionGenerationSource | undefined
  let owner: ConnectionOwner | undefined
  let generationId = 0
  let generation: ConnectionGeneration | undefined
  let state: ConnectionState | undefined
  const generationListeners = new Set<() => void>()
  const stateListeners = new Set<() => void>()
  const publishGeneration = (next: ConnectionGeneration | undefined): void => {
    if (Object.is(generation, next)) return
    generation = next
    for (const listener of [...generationListeners]) {
      try {
        listener()
      } catch (error) {
        console.error('[connection] generation listener threw:', error)
      }
    }
  }
  const publishState = (next: ConnectionState | undefined): void => {
    if (state === next) return
    state = next
    for (const listener of [...stateListeners]) {
      try {
        listener()
      } catch (error) {
        console.error('[connection] state listener threw:', error)
      }
    }
  }
  const releaseOwner = (current: ConnectionOwner): void => {
    if (owner !== current) return
    owner = undefined
    current.stopNetworkWatch()
    current.controller.stop()
    publishGeneration(undefined)
    publishState(undefined)
  }
  const handle: ConnectionHandle = {
    isLoopback: transport?.ownsHost === true || pageLocation === undefined || isLoopbackHostname(pageLocation.hostname),
    basePath,
    generation: {
      getSnapshot: () => generation,
      subscribe: (listener) => {
        generationListeners.add(listener)
        return () => { generationListeners.delete(listener) }
      },
    },
    state: {
      getSnapshot: () => state,
      subscribe: (listener) => {
        stateListeners.add(listener)
        return () => { stateListeners.delete(listener) }
      },
    },
    rpc,
    reconnect() {
      owner?.controller.reconnect()
    },
    registerGenerationSource(source) {
      if (generationSource !== undefined) {
        throw new Error('connection: a generation source is already registered')
      }
      generationSource = source
      return () => {
        if (generationSource !== source) return
        generationSource = undefined
        const current = owner
        if (current?.source === source) releaseOwner(current)
      }
    },
    start(sinks, config) {
      if (owner !== undefined) throw new Error('connection: the stream loop is already owned by another consumer')
      const source = generationSource
      if (source === undefined) throw new Error('connection: no generation source is registered')
      const token = {}
      const ownsGeneration = (): boolean => owner?.token === token
      const controller = new ConnectionController(source, {
        ...sinks,
        onConnected: (host) => {
          const nextGeneration = { id: ++generationId, host }
          publishGeneration(nextGeneration)
          if (!ownsGeneration() || !Object.is(generation, nextGeneration)) return
          sinks.onConnected?.(host)
        },
        onStateChange: (state) => {
          if (state !== 'connected') {
            publishGeneration(undefined)
          }
          if (!ownsGeneration()) return
          publishState(state)
          sinks.onStateChange?.(state)
        },
      }, { ...recovery, ...config })
      const current = { token, source, controller, stopNetworkWatch: watchBrowserNetwork(controller) }
      owner = current
      // chamber patch (design 14 D4 + sleep/wake liveness extension): reconnect
      // immediately on OS wake (system-resume), network restore (online) or the
      // window becoming visible again after a long hidden span (hide-to-tray /
      // backgrounded sleep) — instead of waiting for a close/error that a
      // silently-dead half-open stream never fires. The controller's native
      // reconnect() aborts the in-flight generation in place (no second pump
      // loop, no stop()+start() race), and the triggers are offline-gated
      // because upstream's own watchBrowserNetwork already suspends retries
      // while the browser reports no network. Listeners are registered here
      // (loop owned) and removed by the returned stop handle — once stopped,
      // the triggers are never observed.
      const detachTriggers = attachLivenessTriggers(
        typeof window === 'undefined' ? undefined : window,
        typeof document === 'undefined' ? undefined : document,
        {
          restart: () => {
            // A withdrawn/stopped loop must not be resurrected by a stale
            // trigger (registerGenerationSource's disposer releases the owner
            // without running this detach).
            if (!ownsGeneration()) return
            try {
              controller.reconnect()
            } catch (error) {
              console.warn('[web-runtime] liveness reconnect failed:', error)
            }
          },
          windowEvents: [SYSTEM_RESUME_EVENT, 'online'],
        },
      )
      controller.start()
      return {
        stop: () => {
          detachTriggers()
          releaseOwner(current)
        },
      }
    },
  }
  ctx.provide('connection', handle)
}
