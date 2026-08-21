/**
 * Browser wire client. The plugin selects fixture or HTTP transport, provides
 * the shared API client, and lets the runtime object layer start the stream
 * controller with its sinks.
 *
 * ## chamber patch (dsh-chamber connection manager, design 05 §3.6)
 *
 * The plugin apply accepts an optional `ConnectionConfig` (the entry-level
 * twin of the controller config in ./connection.ts): its `basePath` option
 * (default `/api` = stock) is resolved at carrier construction and handed to
 * both the HTTP/WS carrier and the generic RPC caller, so every api path
 * lands under the control-plane per-instance proxy prefix (`/api/i/<id>`).
 * When no config is passed, `window.__DSH_BASE_PATH__` (set by the chamber
 * shell before each sequential instance boot) is the fallback knob.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { HostDescription, IApiClient } from './api.ts'
import { ConnectionController, type ConnectionConfig, type ConnectionSinks, type ConnectionState } from './connection.ts'
import { attachLivenessTriggers } from './liveness-triggers.ts'
import { FixtureApiClient } from './fixture.ts'
import { WebApiClient } from './web-api-client.ts'
import { createWebConnectionRpc } from './rpc.ts'
import { isLoopbackHostname } from '../loopback-hostname.ts'
import { resolveInstanceBasePath } from '../api-path.ts'
import type { ClientConnectionRpc } from '../rpc.ts'

// ---- Contract re-exports (browser-safe apiproxy channels + core types) ----
export type {
  ApiProxy, SessionsApi, SessionSearchItem, SessionSummary, PromptContentPart, HostApi, EventsApi, MuxFrame, HostFrame,
  ApprovalResponsePayload, QuestionResponsePayload, HistoryEntry, ToolEventView,
  DirectoryEntry, DirectoryListing,
  ToolCallView, ToolResultView, WorkspaceApi, WorkspaceId, WorkspaceView,
  SkillsApi, SkillEntry,
  ModelCatalogFailure, ModelCatalogModel, ModelProviderGroup, ModelReasoning,
  MessageId, ModelReasoningEffort, ModelSelection, QueueAction, QueuedInboxItem, SessionModels,
  SubagentsApi, SubagentAddress, SubagentCatalog, SubagentListEntry, SubagentPromptReceipt,
  JobView,
  RpcRequest, RpcResponse, RpcResult, RpcError, RpcErrorCode,
  ClientRequest, ServerResponse, ServerRequest, ClientResponse, RpcMessage, RpcReceipt,
  HostDescription, IApiClient, SessionId, SessionEvent, ContentBlock, StreamChunk,
  GoalsApi, GoalRef,
  SettingsApi, SettingsNamespaceView, SettingsPathOpView, SettingsSecretView,
  CredentialsApi, CredentialView, ConfigurableProviderView, DiscoveredModelView, LlmApi,
} from './api.ts'
export {
  RpcId,
  AbstractApiClient,
  transportError,
  SESSION_SEARCH_RESULT_LIMIT,
} from './api.ts'

// Connection loop types are public through ConnectionHandle.start; the
// controller remains package-internal.
export type { ConnectionConfig, ConnectionSinks, ConnectionState }
export type { ClientConnectionRpc } from '../rpc.ts'

/** Observable Host description published by each completed connection handshake. */
export interface HostDescriptionSource {
  /** Latest connected-generation description; absent before connect and while reconnecting. */
  getSnapshot(): HostDescription | undefined
  /** Subscribe to description replacement and connection loss. */
  subscribe(listener: () => void): () => void
}

/**
 * chamber patch (design 14 D4): the window event the chamber shell dispatches
 * on OS wake-from-sleep (the App layer re-broadcasts the main-process
 * `system-resume` IPC push as this window event). SINGLE canonical definition —
 * the renderer App layer imports it from here so the two sides can never
 * drift apart (a drift would silently break the immediate-reconnect chain).
 */
export const SYSTEM_RESUME_EVENT = 'dsh-chamber:system-resume'

/** Required services (none — this is the wire root). */
export const inject: string[] = []

/**
 * The ctx.connection service API: the API client plus a one-shot
 * controller starter (the runtime plugin supplies sinks when its object layer
 * is ready — connection stays consumer-agnostic).
 */
export interface ConnectionHandle {
  /** Shared api client (fixture or real, decided at boot from the page URL). */
  readonly api: IApiClient
  /** Whether the current page authority is loopback; non-browser contexts default to true. */
  readonly isLoopback: boolean
  /** chamber patch: resolved per-instance api base path (`/api` stock, `/api/i/<id>` chamber). */
  readonly basePath: string
  /** Generation-scoped Host facts, including the account home and native path-open capability. */
  readonly hostDescription: HostDescriptionSource
  /** Generic logical RPC channels over the same Connection transport. */
  readonly rpc: ClientConnectionRpc
  /**
   * Start the connect/pump/reconnect loop with the consumer's frame sinks.
   * One consumer owns the streams (the runtime object layer); a second call
   * throws.
   * @param sinks - frame/state callbacks.
   * @param config - reconnect/backoff tunables.
   * @returns stop handle for the loop.
   */
  start(sinks: ConnectionSinks, config?: ConnectionConfig): { stop(): void }
}

/**
 * Client plugin body: pick the api by page mode and provide ctx.connection.
 * @param ctx - client cordis context.
 * @param config - optional chamber patch: per-instance base path config (defaults stock).
 */
export function apply(ctx: Context, config?: ConnectionConfig): void {
  const pageLocation = typeof location === 'undefined' ? undefined : location
  const fixture = pageLocation !== undefined && new URLSearchParams(pageLocation.search).has('fixture')
  // chamber patch: resolve the per-instance base path once, at construction
  // (explicit config wins, then window.__DSH_BASE_PATH__ — deterministic under
  // the chamber shell's sequential instance boots).
  const basePath = resolveInstanceBasePath(config?.basePath)
  const fixtureClient = fixture ? new FixtureApiClient() : undefined
  const api: IApiClient = fixtureClient ?? new WebApiClient({ basePath })
  // Published by the readiness handshake (host.describe) once the connection
  // is established; observable through handle.hostDescription.
  let description: HostDescription | undefined
  const rpc = fixtureClient?.rpc ?? createWebConnectionRpc({ basePath })
  let started = false
  const descriptionListeners = new Set<() => void>()
  const publishDescription = (next: HostDescription | undefined): void => {
    if (Object.is(description, next)) return
    description = next
    for (const listener of [...descriptionListeners]) {
      try {
        listener()
      } catch (error) {
        console.error('[web-runtime] host-description listener threw:', error)
      }
    }
  }
  const handle: ConnectionHandle = {
    api,
    isLoopback: pageLocation === undefined || isLoopbackHostname(pageLocation.hostname),
    basePath,
    hostDescription: {
      getSnapshot: () => description,
      subscribe: (listener) => {
        descriptionListeners.add(listener)
        return () => { descriptionListeners.delete(listener) }
      },
    },
    rpc,
    start(sinks, config) {
      if (started) throw new Error('connection: the stream loop is already owned by another consumer')
      started = true
      const controller = new ConnectionController(api, {
        ...sinks,
        onConnected: (next) => {
          publishDescription(next)
          // A description subscriber may synchronously stop the loop. In that
          // case publishDescription(undefined) has already retracted this
          // generation, so do not leak its stale connected notification to
          // the consumer sink afterward.
          if (!Object.is(description, next)) return
          sinks.onConnected?.(next)
        },
        onStateChange: (state) => {
          if (state === 'reconnecting') publishDescription(undefined)
          sinks.onStateChange?.(state)
        },
      }, config ?? {})
      // chamber patch (design 14 D4 + sleep/wake liveness extension): restart
      // the loop immediately on OS wake (system-resume), network restore
      // (online) or the window becoming visible again after a long hidden
      // span (hide-to-tray / backgrounded sleep) — instead of waiting for a
      // close/error that a silently-dead half-open WebSocket never fires.
      // stop()+start() is the controller's own public restart semantics
      // (made atomic-safe by the loop-epoch guard in connection.ts). The
      // listeners are registered here (loop owned) and removed by the
      // returned stop handle — once stopped, the triggers are never observed.
      const detachTriggers = attachLivenessTriggers(
        typeof window === 'undefined' ? undefined : window,
        typeof document === 'undefined' ? undefined : document,
        {
          restart: () => {
            try {
              controller.stop()
              controller.start()
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
          controller.stop()
          publishDescription(undefined)
        },
      }
    },
  }
  ctx.provide('connection', handle)
}
