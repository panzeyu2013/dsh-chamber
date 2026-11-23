/**
 * Per-instance client-plugin events over the authenticated Remote stream (0.2.3-alpha.1
 * decision C / PLAN §12.3.3, M1 retirement).
 *
 * Upstream alpha.1 replaced the Host's document-relative `EventSource('plugins/events')`
 * with an authenticated Typert Remote stream: the `@deepseek-ai/dsh-client-hmr` client face
 * mounts its own `pluginEvents` namespace and follows it as a baseline-and-increment stream
 * (`vendor/harness-checkout/packages/client/hmr/src/client/index.ts`). The chamber composite
 * always SKIPS that official row (`chamber-covered.ts` - its page-level `modules.entries`
 * controller cannot run per instance), so the shell mounts the same generated contribution
 * and stream PER INSTANCE here, gated by the `remoteAccess` policy for
 * `pluginEvents/follow` exactly as upstream does.
 *
 * The reconciler in `live-graph.ts` is transport-agnostic by construction: it consumes the
 * SAME JSON frame texts the retired page-channel `pluginGraph` topic used to deliver
 * (`parsePluginEventFrame`: `{type:'graph',graph}` / `{type:'rebuilt',id,rev}`). This
 * module therefore only translates one wire shape into the other, which keeps the whole
 * id-set/rev-conflict/remount machinery unchanged and still unit-testable with a fake ctx.
 */

import type { LivePluginGraphHandlers, LivePluginGraphSubscription } from './live-graph.ts'

/** One frame of the `pluginEvents/follow` stream (upstream `client/hmr/src/types.ts`). */
type PluginEventsFrame =
  | { readonly type: 'baseline'; readonly graph: unknown }
  | { readonly type: 'graph'; readonly graph: unknown }
  | { readonly type: 'rebuilt'; readonly id: string; readonly rev: string }

const RELOADING = new Set(['gateway/invocation-unavailable', 'gateway/service-unavailable'])

/**
 * Open one generation; an endpoint the Host withdrew while it reloads is a carrier loss so
 * the api-gateway `$stream` reconnects instead of ending the logical stream (upstream
 * `client/hmr/src/client/index.ts` `reconnectWhileReloading`).
 * @param open - opens the generation's frames.
 * @yields the generation's frames.
 */
async function *reconnectWhileReloading(open: () => AsyncIterable<PluginEventsFrame>): AsyncIterable<PluginEventsFrame> {
  try {
    yield * open()
  } catch (error) {
    if (error instanceof Error && 'code' in error && RELOADING.has(String(error.code))) {
      throw Object.assign(new Error('Plugin events are unavailable while the Host reloads', { cause: error }), { code: 'gateway/carrier-lost' })
    }
    throw error
  }
}

/** The one Host namespace this bridge consumes (mounted by `ctx.remote.$mount`). */
interface PluginEventsNamespaceFace {
  follow(signal: AbortSignal): AsyncIterable<PluginEventsFrame>
}

/** The generated Remote contribution the HMR package ships (`./remote` export). */
type PluginEventsContribution = unknown

/** The decrypted transport faces the bridge drives (structural: no cross-package edge). */
export interface HmrEventsContext {
  readonly remote?: {
    $mount(contribution: PluginEventsContribution): Promise<() => Promise<void> | void>
    $stream<Item>(options: {
      name: string
      open(signal: AbortSignal): AsyncIterable<Item>
      ended?(): unknown
      carrierFailed?(error: unknown): void
    }): {
      [Symbol.asyncIterator](): AsyncIterator<Item>
      restart(): void
    }
  }
  readonly remoteAccess?: {
    whenAccess(action: string, callback: () => () => void): () => void
  }
  get?(name: string): unknown
}

/** The destructive Teardown face `RemoteSnapshotStream` needs (`dispose()` returns a promise). */
interface SnapshotStreamFace {
  start(): void
  dispose(): Promise<void>
  restart(): void
}

/** Construction seams: the contribution loader is injectable so node tests never resolve the
 *  generated artifact (which only the renderer build writes). */
export interface HmrEventsSeams {
  /** Load the HMR client's generated `./remote` contribution; defaults to the real import. */
  loadContribution?(): Promise<PluginEventsContribution>
  /** Build the baseline-and-delta consumer over the physical stream (defaults to the
   *  api-gateway fork's `RemoteSnapshotStream`, loaded lazily so node tests can stub it).
   *  May be async: the production path awaits a dynamic import, and a close landing inside
   *  that window must dispose the local consumer instead of leaking it. */
  createSnapshotStream?(stream: unknown, options: SnapshotStreamOptions): SnapshotStreamFace | Promise<SnapshotStreamFace>
}

/** The snapshot-stream callbacks `RemoteSnapshotStream` consumes. */
export interface SnapshotStreamOptions {
  name: string
  isSnapshot(value: unknown): boolean
  replace(value: unknown): void
  update(value: unknown): void
  failed(error: unknown): void
}

/** The real contribution import: the renderer aliases `/remote` to the generated artifact. */
const loadGeneratedContribution = async (): Promise<PluginEventsContribution> => {
  const module = await import('@deepseek-ai/dsh-client-hmr/remote')
  return (module as { default?: PluginEventsContribution }).default ?? module
}

/**
 * Translate one upstream frame into the retired page-channel topic's JSON text, so the
 * live reconciler keeps ONE frame parser and one diff/remount path.
 * @param frame - a `pluginEvents/follow` frame.
 * @returns the JSON text `parsePluginEventFrame` accepts, or null for a forward-compatible
 *   unknown frame type (a newer Host must never fail the page).
 */
export function hmrFrameToPluginEventText(frame: PluginEventsFrame): string | null {
  if (frame === null || typeof frame !== 'object') return null
  switch (frame.type) {
    case 'baseline':
    case 'graph':
      return JSON.stringify({ type: 'graph', graph: frame.graph })
    case 'rebuilt':
      return JSON.stringify({ type: 'rebuilt', id: frame.id, rev: frame.rev })
    default:
      return null
  }
}

/**
 * Open one instance's `pluginEvents` stream and feed the live reconciler.
 *
 * Sync-return contract: `startLiveGraphSync` subscribes synchronously, so the returned
 * handle exists before the async mount/stream settles; `close()` before/while arming is
 * honoured (the arm tears itself down at every await boundary).
 *
 * Access gate: the arm is installed through `remoteAccess.whenAccess('pluginEvents/follow')'`
 * (upstream's own gate). No access service (an older/host-less shape) or no remote face means
 * this holder keeps boot as its row-set authority - live sync simply stays off.
 * @param ctx - the instance's runtime Context (already booted by the shell).
 * @param handlers - the reconciler's frame callbacks.
 * @param seams - test seams for the generated contribution and the snapshot stream.
 * @returns the closeable subscription; `closed` becomes true once teardown ran.
 */
export function subscribeHmrPluginEvents(
  ctx: HmrEventsContext | undefined,
  handlers: LivePluginGraphHandlers,
  seams: HmrEventsSeams = {},
): LivePluginGraphSubscription {
  let closed = false
  let stopping = false
  /** Bumped on every access revocation; an in-flight arm from an older grant must not mount. */
  let accessEpoch = 0
  let control: SnapshotStreamFace | undefined
  let unmount: (() => Promise<void> | void) | undefined
  let releaseAccess: (() => void) | undefined
  const disposeArm = (): void => {
    try { releaseAccess?.() } catch { /* best effort */ }
    releaseAccess = undefined
    try { control?.dispose() } catch { /* best effort */ }
    control = undefined
    try { void unmount?.() } catch { /* best effort */ }
    unmount = undefined
  }

  const forward = (frame: PluginEventsFrame): void => {
    if (closed) return
    const text = hmrFrameToPluginEventText(frame)
    if (text === null) return
    try { handlers.onItem(text) } catch (error) { handlers.onError?.('frame-handler-failed', String(error)) }
  }

  const arm = async (): Promise<void> => {
    const remote = ctx?.remote
    const remoteAccess = ctx?.remoteAccess
    if (closed || stopping || remote === undefined || remoteAccess === undefined) return
    const epoch = accessEpoch
    const contribution = await (seams.loadContribution ?? loadGeneratedContribution)()
    if (closed || stopping || epoch !== accessEpoch) return
    unmount = await remote.$mount(contribution)
    if (closed || stopping || epoch !== accessEpoch) { disposeArm(); return }
    const namespace = ctx?.get?.('remote.pluginEvents') as PluginEventsNamespaceFace | undefined
    if (namespace === undefined || typeof namespace.follow !== 'function') {
      handlers.onError?.('namespace-missing', 'the mounted pluginEvents namespace is not registered')
      disposeArm()
      return
    }
    const stream = remote.$stream<PluginEventsFrame>({
      name: 'Plugin events',
      open: signal => reconnectWhileReloading(() => namespace.follow(signal)),
      // A Host-side end (the service restarting) reconnects rather than ending the stream.
      ended: () => Object.assign(new Error('Plugin events stream ended'), { code: 'gateway/carrier-lost' }),
    })
    const options: SnapshotStreamOptions = {
      name: 'Plugin events',
      isSnapshot: frame => (frame as { type?: unknown })?.type === 'baseline',
      replace: frame => { forward(frame as PluginEventsFrame) },
      update: frame => { forward(frame as PluginEventsFrame) },
      failed: error => { handlers.onError?.('stream-failed', String(error)) },
    }
    let consumer: SnapshotStreamFace
    if (seams.createSnapshotStream !== undefined) {
      consumer = await seams.createSnapshotStream(stream, options)
    } else {
      const { RemoteSnapshotStream } = await import('@deepseek-ai/dsh-api-gateway/client')
      consumer = new RemoteSnapshotStream(stream as never, options as never) as unknown as SnapshotStreamFace
    }
    // A close (or a revoked grant) during the consumer factory's await -- in production the
    // dynamic import -- must dispose the local consumer: disposeArm() already ran with
    // `control` unset, so assigning afterwards would leak an arm the page believes closed.
    if (closed || stopping || epoch !== accessEpoch) {
      try { consumer.dispose() } catch { /* best effort */ }
      return
    }
    control = consumer
    consumer.start()
    handlers.onOpen?.()
  }

  const remote = ctx?.remote
  const remoteAccess = ctx?.remoteAccess
  if (remote !== undefined && remoteAccess !== undefined) {
    try {
      // Upstream's own gate: effects live exactly while this Peer may follow the stream.
      releaseAccess = remoteAccess.whenAccess('pluginEvents/follow', () => {
        void arm().catch((error: unknown) => {
          handlers.onError?.('arm-failed', String(error))
        })
        return () => {
          // A revoked grant is not a close: the same Peer may be granted again later;
          // whenAllowed reruns the callback on regrant. Bump the epoch so an in-flight
          // arm from the revoked grant cannot mount, and tear down the current one.
          accessEpoch += 1
          disposeArm()
        }
      })
      if (typeof releaseAccess !== 'function') releaseAccess = undefined
    } catch (error) {
      handlers.onError?.('arm-failed', String(error))
    }
  }

  return {
    close(): void {
      if (closed) return
      closed = true
      stopping = true
      disposeArm()
    },
  }
}
