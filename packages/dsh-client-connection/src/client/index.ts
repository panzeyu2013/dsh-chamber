/**
 * Browser wire client: provides the shared RPC client; API Gateway owns the
 * connection loop.
 *
 * chamber patch: `basePath` comes from the per-entry Context
 * (`ctx.chamberBasePath`, never a page global) and reaches the generic RPC
 * carrier under the per-instance proxy prefix; liveness triggers drive native
 * `reconnect()`. `SYSTEM_RESUME_EVENT` is the canonical wake-event value (the
 * renderer spells the literal; both sides drift-check it). The `?fixture` page
 * mode is dropped.
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
import { attachLivenessTriggers } from './liveness-triggers.ts'
import { isLoopbackHostname } from '../loopback-hostname.ts'
import { resolveConnectionConfig } from '../recovery-config.ts'
import type { ClientConnectionRpc } from '../rpc.ts'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** A generation was established: wire-derived caches must repull; streams
     *  own their own resume/baseline lifecycle. @mode emit */
    'connection/reset'(): void
  }
}

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

// Connection loop types are public through ConnectionHandle.start; the controller stays internal.
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

/** Observable identity/Host facts for the active generation (snapshot undefined
 *  before readiness and while reconnecting). */
export interface ConnectionGenerationState {
  getSnapshot(): ConnectionGeneration | undefined
  subscribe(listener: () => void): () => void
}

/** Observable recovery lifecycle of the owned loop (snapshot undefined before
 *  the first outcome). */
export interface ConnectionStateSource {
  getSnapshot(): ConnectionState | undefined
  subscribe(listener: () => void): () => void
}

export const inject: string[] = []

/**
 * Carrier override installed on the page global before plugin boot: the served
 * web app leaves it unset (HTTP + WebSocket); a shell owning a different physical
 * transport provides both halves here instead of forking this plugin.
 */
export interface ClientTransportHooks {
  fetch: RpcFetch
  /** Worker-local Gateway stream carrier; absent when the page uses the Gateway WebSocket. */
  openStream?: RpcStreamOpen
  /** Bundle transport for the module system; absent when bundles load over HTTP. */
  loadBundle?(url: string): Promise<void>
  /**
   * Declares that the page owns the Host outright (it runs inside a worker this
   * page spawned): `isLoopback` then reports the privileged surface reachable
   * regardless of page authority. Served pages never carry the global.
   */
  ownsHost?: boolean
}

/** Page global carrying {@link ClientTransportHooks}; absent in the served web app. */
interface ClientTransportGlobal {
  __DSH_TRANSPORT__?: ClientTransportHooks
  /** Host-injected recovery bootstrap (webserver index-inject). */
  __DSH_CONNECTION_RECOVERY__?: unknown
}

/** The ctx.connection service API: the RPC client plus a one-shot loop starter. */
export interface ConnectionHandle {
  /** Whether the privileged surface is reachable (loopback authority, page-owned transport, or no browser). */
  readonly isLoopback: boolean
  /** Current Remote event generation with its opening-frame Host facts. */
  readonly generation: ConnectionGenerationState
  readonly state: ConnectionStateSource
  readonly rpc: ClientConnectionRpc
  /** Reset retry progression and replace the current attempt immediately. */
  reconnect(): void
  /** Register the sole Host-generation source; it reports ready only after attaching listeners. Returns a disposer. */
  registerGenerationSource(source: ConnectionGenerationSource): () => void
  /** Start the connect/reconnect loop (a second call throws); `config` overrides the resolved recovery timing. */
  start(sinks: ConnectionSinks, config?: ConnectionRecoveryConfig): ConnectionLoop
}

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

/** chamber patch: read the per-entry base path provided on the entry Context. */
function chamberBasePathOf(ctx: Context): string | undefined {
  return (ctx as { readonly chamberBasePath?: string }).chamberBasePath
}

/** Client plugin body: provide ctx.connection (the RPC client + loop starter). */
export function apply(ctx: Context): void {
  const pageLocation = typeof location === 'undefined' ? undefined : location
  const transport = (globalThis as ClientTransportGlobal).__DSH_TRANSPORT__
  const recovery = resolveConnectionConfig((globalThis as ClientTransportGlobal).__DSH_CONNECTION_RECOVERY__)
  // chamber patch: resolve the per-entry path once and fan it into the RPC carrier plus transport hooks.
  const { rpc } = assembleConnectionCarriers(
    chamberBasePathOf(ctx),
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
