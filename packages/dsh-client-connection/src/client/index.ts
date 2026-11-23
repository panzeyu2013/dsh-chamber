/**
 * Browser wire client: provides the shared RPC client; API Gateway owns the
 * connection loop.
 *
 * chamber patch: the per-entry Context's `chamberBasePath` (never a page global)
 * is read here and reaches the generic RPC carrier as its `/api/i/<id>` prefix;
 * liveness triggers drive native `reconnect()`. `SYSTEM_RESUME_EVENT` is the
 * canonical wake-event value (the renderer spells the literal; both sides
 * drift-check it). The per-entry carrier class is a Context fact too: a `local`
 * carrier does not consume the browser network state, so its loop makes the
 * first attempt while `navigator.onLine` is false (design 14 §D4). The upstream
 * `?fixture` page mode is retired (rc.2 upstream deleted `src/client/fixture.ts`;
 * the fork keeps it dropped).
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
import { createWebConnectionRpc, type RpcFetch, type RpcStreamOpen } from './rpc.ts'
import { assembleConnectionCarriers } from './carrier-assembly.ts'
import { resolveInstanceBasePath } from '../api-path.ts'
import { attachLivenessTriggers } from './liveness-triggers.ts'
import { isLoopbackHostname } from '../loopback-hostname.ts'
import type { ClientConnectionRpc } from '../rpc.ts'
import { resolveConnectionConfig } from '../recovery-config.ts'
import type { SyncedConfig } from '@deepseek-ai/dsh-client-config/types'
import type { ConnectionConfig } from '../types.ts'
import type { ConnectionInteractions } from '../connect-protocol.ts'
import { openConnectionWebSocket, type ConnectionWebSocket, type ConnectionWebSocketFactory } from './socket.ts'

export type { ConnectionInteractions } from '../connect-protocol.ts'
export type { ConnectionWebSocket, ConnectionWebSocketFactory } from './socket.ts'

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
/** chamber patch: per-source recovery-timing policy, exported through the `/client` barrel. */
export {
  recoveryOverridesForTransport,
  REMOTE_GENERATION_READY_TIMEOUT_MS,
  REMOTE_GENERATION_READY_WARN_MS,
  type ConnectionRecoveryOverrides,
} from './recovery-policy.ts'

/** chamber patch: window event dispatched on OS wake-from-sleep; the canonical
 *  VALUE, which the renderer spells as a literal (both sides drift-checked). */
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
 * Physical carrier selected when the Connection service is installed. The
 * served web app omits it and gets HTTP + WebSocket; a shell that owns a
 * different transport (the worker preview's postMessage tunnel) provides both
 * halves instead of forking this plugin.
 */
export interface ClientTransportHooks {
  /**
   * Already decoded logical RPC carrier. When present it replaces the HTTP
   * caller outright: no envelopes, no `fetch`, no `openStream` (an in-process
   * Host such as a test mock plugs in here).
   */
  rpc?: ClientConnectionRpc
  /** Transport for generic unary RPC channels (the Typert gateway); unused when `rpc` is present. */
  fetch?: RpcFetch
  /** Worker-local Gateway stream carrier; absent when the page uses the Gateway WebSocket or `rpc` is present. */
  openStream?: RpcStreamOpen
  /**
   * Bundle transport for the module system, present when the carrier also owns
   * bundle bytes (the worker tunnel). Absent in the served web app, whose
   * bundles load over HTTP.
   */
  loadBundle?(url: string): Promise<void>
  /**
   * Package-asset resolver for the module system, present when the page cannot
   * request `plugins/<package>/assets/<path>` itself (the worker tunnel): it
   * maps each reference to a URL the page can load. The web boot seam forwards it
   * to the module system (`__DSH_TRANSPORT__` → `ClientModuleCreateOptions.resolveAsset`);
   * absent in the served web app, where the identity default is correct.
   */
  resolveAsset?(reference: string): string
  /**
   * The transport owner declares the page owns the Host outright: the Host
   * runs inside a worker this page spawned, so no other party can reach it and
   * the loopback stand-in for "the owner's own machine" is vacuous.
   * `ctx.connection.isLoopback` then reports the privileged surface reachable
   * regardless of the page authority. Only a shell that assembles its own
   * transport can set this; served pages never carry the global at all.
   */
  ownsHost?: boolean
  /** Authenticated WebSocket factory; omission uses the browser API and its cookie jar. */
  createWebSocket?: ConnectionWebSocketFactory
  /** Host base URL for desktop or Node sockets; omission uses the document base. */
  streamBaseUrl?: string
}

/** Page global carrying {@link ClientTransportHooks}; absent in the served web app. */
interface ClientTransportGlobal {
  __DSH_TRANSPORT__?: ClientTransportHooks
}

/** Browser location fields used to classify loopback authority. */
export interface ConnectionLocation {
  readonly hostname: string
}

/** Instance-local inputs for installing a Connection service. */
export interface ConnectionInstallOptions {
  /** Forwarded-event participation; omission selects answer for a page and none otherwise. */
  readonly interactions?: ConnectionInteractions
  /** Explicit physical carrier; omit for the browser HTTP + WebSocket carrier. */
  readonly transport?: ClientTransportHooks
  /** Reconnect timing overrides; omitted fields use controller defaults. */
  readonly recovery?: ConnectionRecoveryConfig
  /** Page location; omit for a non-browser composition. */
  readonly location?: ConnectionLocation
  /** chamber patch: per-entry api base path from the entry Context (`/api/i/<id>`). */
  readonly basePath?: string
  /**
   * chamber patch: which side of the wire this page's carrier serves — `'local'`
   * when the Host is this machine (the managed local instance), `'remote'` for a
   * source reached through a network carrier. This is a per-entry CARRIER fact,
   * never a page-origin fact: the chamber shell serves every entry from the same
   * control-plane loopback origin, so origin-based locality would classify a
   * remote source as local.
   * A local carrier must not gate its loop on the browser network state: loopback
   * traffic keeps working while `navigator.onLine` is false, so the first attempt
   * must run offline and the loop must never park on an `offline` event.
   * Omitted = `'remote'` (stock browser-gated behaviour unchanged).
   */
  readonly carrier?: 'local' | 'remote'
}

/**
 * The ctx.connection service API. API Gateway supplies generation readiness
 * and reset callbacks; Connection stays independent of downstream domain state.
 */
export interface ConnectionHandle {
  /** Forwarded-event participation selected at installation. */
  readonly interactions: ConnectionInteractions
  /**
   * Whether the privileged surface is reachable: the page authority is
   * loopback, the transport declares the page owns the Host
   * ({@link ClientTransportHooks.ownsHost}), or the context is not a browser.
   * chamber patch: this is a PRIVILEGED-SURFACE verdict, not a carrier-locality
   * verdict — the chamber shell serves every entry from the control-plane
   * loopback origin, so it is true for local and remote sources alike. The
   * carrier class is {@link ConnectionInstallOptions.carrier}.
   */
  readonly isLoopback: boolean
  /** Current Remote event generation and the Host facts carried by its opening frame. */
  readonly generation: ConnectionGenerationState
  /** Current recovery lifecycle for connection-specific consumers. */
  readonly state: ConnectionStateSource
  /** Generic logical RPC channels over the same Connection transport. */
  readonly rpc: ClientConnectionRpc
  /**
   * Create a socket on the selected carrier; the channel owns framing and closing.
   * @param path - absolute logical channel path, resolved beneath the Host mount.
   * @returns a newly connecting socket using the installed authentication factory.
   */
  openWebSocket(path: string): ConnectionWebSocket
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
   * @param config - explicit timing overrides; omitted fields use Host bootstrap timing.
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

/** chamber patch: read the per-entry base path bound on the entry Context. */
function chamberBasePathOf(ctx: Context): string | undefined {
  return (ctx as { readonly chamberBasePath?: string }).chamberBasePath
}

/**
 * chamber patch: classify this page's carrier from the per-entry Context fact.
 * The shell provides `chamberTransport` before plugin materialization; a real
 * Cordis context rejects an uninjected property read, so the provided-service
 * accessor (`ctx.get`) is the production read face and the property read stays
 * as the fake-context/legacy fallback only. An absent or unknown fact keeps the
 * stock network-gated (`'remote'`) behaviour — the entry path is a routing fact,
 * not a carrier fact, so it is deliberately not used as a second derivation.
 */
function chamberCarrierOf(ctx: Context): 'local' | 'remote' | undefined {
  const transport = typeof ctx.get === 'function'
    ? ctx.get('chamberTransport')
    : (ctx as { readonly chamberTransport?: unknown }).chamberTransport
  if (transport === 'local') return 'local'
  if (transport === 'ssh' || transport === 'http') return 'remote'
  return undefined
}

/**
 * Install one Context-owned Connection service from explicit composition inputs.
 * @param ctx - client Cordis context.
 * @param options - interaction participation, physical carrier, reconnect timing, and page location.
 */
export function installConnection(ctx: Context, options: ConnectionInstallOptions = {}): void {
  const pageLocation = options.location
  const transport = options.transport
  const recovery = options.recovery ?? {}
  const interactions = options.interactions ?? (pageLocation === undefined ? 'none' : 'answer')
  // chamber patch: the carrier class decides whether the browser network gate is
  // installed at start(); omission keeps upstream's browser-gated loop.
  const carrier = options.carrier ?? 'remote'
  // chamber patch: the per-entry prefix fans into the generic RPC carrier; an
  // explicit decoded carrier keeps upstream's precedence.
  const rpc = transport?.rpc ?? assembleConnectionCarriers(
    options.basePath,
    transport,
    { createRpc: options => createWebConnectionRpc(options) },
  ).rpc
  // chamber/alpha.3: the same resolved per-entry prefix must reach the WebSocket
  // carrier — the mux opens its socket through openWebSocket, so a streamBaseUrl-less
  // transport would otherwise land on the control-plane root instead of /api/i/<id>.
  const socketBasePath = resolveInstanceBasePath(options.basePath)
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
    interactions,
    openWebSocket: path => openConnectionWebSocket(
      transport?.streamBaseUrl === undefined ? socketBasePath + path : path,
      transport?.createWebSocket,
      transport?.streamBaseUrl,
    ),
    isLoopback: transport?.ownsHost === true || pageLocation === undefined || isLoopbackHostname(pageLocation.hostname),
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
      // chamber patch: the browser network gate belongs to a network carrier only.
      // A local loopback carrier makes its first attempt while the browser reports
      // offline and must never park on `offline`; with no watcher there is no
      // setNetworkAvailable(false), so the stock parking branch stays unreachable.
      const current = {
        token,
        source,
        controller,
        stopNetworkWatch: carrier === 'local' ? () => {} : watchBrowserNetwork(controller),
      }
      owner = current
      // chamber patch: reconnect immediately on OS wake, network restore or a
      // long-hidden window returning. The native reconnect() aborts the generation
      // in place (no second pump loop); stop() detaches the triggers.
      const detachTriggers = attachLivenessTriggers(
        typeof window === 'undefined' ? undefined : window,
        typeof document === 'undefined' ? undefined : document,
        {
          restart: () => {
            // A stopped loop must not be resurrected by a stale trigger (the source disposer releases the owner).
            if (!ownsGeneration()) return
            try {
              controller.reconnect()
            } catch (error) {
              console.warn('[web-runtime] liveness reconnect failed:', error)
            }
          },
          windowEvents: [SYSTEM_RESUME_EVENT, 'online'],
          // An OS wake bypasses the offline gate: a frozen page can miss `online`
          // while the link is back; reconnect() forces one bounded attempt.
          alwaysFireEvents: [SYSTEM_RESUME_EVENT],
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

/**
 * Client plugin body: read the page composition and install its Connection service.
 * @param ctx - client Cordis context.
 * @param config - Host-synced recovery timing, read once here; an absent value uses the recovery defaults.
 */
export function apply(ctx: Context, config: SyncedConfig<ConnectionConfig>): void {
  const globals = globalThis as ClientTransportGlobal
  const pageLocation = typeof location === 'undefined' ? undefined : location
  const transport = globals.__DSH_TRANSPORT__
  // chamber patch: the per-entry prefix and carrier class come from the Context,
  // never a page global. The recovery timing is the alpha.1 synced-config face
  // (the retired `__DSH_CONNECTION_RECOVERY__` page global is gone upstream).
  const basePath = chamberBasePathOf(ctx)
  const carrier = chamberCarrierOf(ctx)
  installConnection(ctx, {
    ...(transport === undefined ? {} : { transport }),
    recovery: resolveConnectionConfig(config.recovery.get()),
    ...(pageLocation === undefined ? {} : { location: pageLocation }),
    ...(basePath === undefined ? {} : { basePath }),
    ...(carrier === undefined ? {} : { carrier }),
  })
}
